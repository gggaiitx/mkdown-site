import { ref, onMounted, onBeforeUnmount } from 'vue';
import { getVersion } from '@tauri-apps/api/app';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { call } from '../api/ipc';

export type UpdateState = 'idle' | 'checking' | 'available' | 'uptodate' | 'error';
export type DownloadState = 'idle' | 'downloading' | 'downloaded' | 'error';

const RELEASES_PAGE = 'https://github.com/gggaiitx/mkdown-site/releases';
const CACHE_KEY = 'mk_update_cache';
// 6h 冷却：未鉴权 GitHub API 仅 60 次/小时，避免每次启动都打接口
const COOLDOWN_MS = 6 * 60 * 60 * 1000;

interface Cache {
  ts: number;
  latest: string;
  url: string;
  downloadUrl: string | null;
  current: string;
}

interface UpdateApiResult {
  latest: string;
  url: string;
  downloadUrl: string | null;
}

interface ProgressPayload {
  downloaded: number;
  total: number;
}

/** 去掉前导 v/V，便于纯数字段比较 */
function normalize(v: string): string {
  return v.replace(/^v/i, '').trim();
}

/** 语义化版本比较：a > b 返回 1，相等 0，a < b 返回 -1 */
function compareVersion(a: string, b: string): number {
  const pa = normalize(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = normalize(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return Math.sign(x - y);
  }
  return 0;
}

export function useUpdateCheck() {
  const state = ref<UpdateState>('idle');
  const currentVersion = ref('');
  const latestVersion = ref('');
  const releaseUrl = ref(RELEASES_PAGE);
  const downloadUrl = ref<string | null>(null);

  // 下载相关状态
  const downloadState = ref<DownloadState>('idle');
  const progress = ref<ProgressPayload | null>(null);
  const downloadedPath = ref<string | null>(null);
  const downloadError = ref('');

  let unlistenProgress: UnlistenFn | null = null;

  function loadCache(): Cache | null {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? (JSON.parse(raw) as Cache) : null;
    } catch {
      return null;
    }
  }

  function saveCache(c: Cache) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(c));
    } catch {
      /* 缓存仅为优化，写入失败不影响功能 */
    }
  }

  async function check(force = false) {
    // 冷却期内直接用缓存结果，不再请求网络；但本地版本必须实时读取——
    // 否则升级重启后，缓存里的旧 current 会让"有更新"红点错亮最多一个冷却周期
    const cache = loadCache();
    if (!force && cache && Date.now() - cache.ts < COOLDOWN_MS && cache.latest) {
      currentVersion.value = await getVersion();
      latestVersion.value = cache.latest;
      releaseUrl.value = cache.url || RELEASES_PAGE;
      downloadUrl.value = cache.downloadUrl ?? null;
      state.value = compareVersion(cache.latest, currentVersion.value) > 0 ? 'available' : 'uptodate';
      return;
    }

    state.value = 'checking';
    try {
      currentVersion.value = await getVersion();
      const info = await call<UpdateApiResult>('check_update', {});
      latestVersion.value = normalize(info.latest);
      releaseUrl.value = info.url || RELEASES_PAGE;
      downloadUrl.value = info.downloadUrl ?? null;
      const isNewer = compareVersion(info.latest, currentVersion.value) > 0;
      state.value = isNewer ? 'available' : 'uptodate';
      saveCache({
        ts: Date.now(),
        latest: latestVersion.value,
        url: releaseUrl.value,
        downloadUrl: downloadUrl.value,
        current: currentVersion.value,
      });
    } catch {
      // 网络/鉴权失败时降级：保持可点击跳转发布页，不阻塞用户
      state.value = 'error';
    }
  }

  /** 后台下载安装包（带进度），完成时下载状态转为 downloaded */
  async function startDownload() {
    if (!downloadUrl.value || downloadState.value === 'downloading') return;
    downloadState.value = 'downloading';
    progress.value = { downloaded: 0, total: 0 };
    downloadError.value = '';
    try {
      const path = await call<string>('download_update', { downloadUrl: downloadUrl.value });
      downloadedPath.value = path;
      downloadState.value = 'downloaded';
      progress.value = null;
    } catch (e) {
      downloadState.value = 'error';
      progress.value = null;
      downloadError.value = e instanceof Error ? e.message : String(e);
    }
  }

  /** 应用更新：调用 Rust 端静默安装并重启；进程会在此调用后退出 */
  async function applyUpdate() {
    if (!downloadedPath.value) return;
    try {
      await call('apply_update', { installerPath: downloadedPath.value });
      // 进程已被 Rust 端退出，正常情况下不会执行到这里
    } catch (e) {
      downloadState.value = 'error';
      downloadError.value = e instanceof Error ? e.message : String(e);
    }
  }

  onMounted(async () => {
    void check();
    // 监听 Rust 端下发的下载进度事件
    try {
      unlistenProgress = await listen<ProgressPayload>('update-progress', (e) => {
        progress.value = e.payload;
      });
    } catch {
      /* 事件监听失败仅影响进度刷新，不影响功能 */
    }
  });

  onBeforeUnmount(() => {
    unlistenProgress?.();
    unlistenProgress = null;
  });

  return {
    state,
    currentVersion,
    latestVersion,
    releaseUrl,
    downloadUrl,
    downloadState,
    progress,
    downloadedPath,
    downloadError,
    check,
    startDownload,
    applyUpdate,
  };
}
