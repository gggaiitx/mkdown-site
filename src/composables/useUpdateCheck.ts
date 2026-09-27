import { ref, onMounted, onBeforeUnmount } from 'vue';
import { getVersion } from '@tauri-apps/api/app';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { call } from '../api/ipc';

export type UpdateState = 'idle' | 'checking' | 'available' | 'uptodate' | 'error';
export type DownloadState = 'idle' | 'downloading' | 'downloaded' | 'error';

const RELEASES_PAGE = 'https://github.com/gggaiitx/mkdown-site/releases';

/**
 * 会话内检测结果备忘：仅在同一次运行中避免组件重挂载（如 HMR）重复请求，
 * 不做跨会话持久化——长效缓存会让新发布的版本在冷却期内不可见（2026-09-27 实测踩坑）。
 * 未鉴权 GitHub API 限额 60 次/小时，每次启动实时检测一次完全可以承受。
 */
interface SessionResult {
  latest: string;
  url: string;
  downloadUrl: string | null;
}
let sessionResult: SessionResult | null = null;

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

  /**
   * 检测更新：每次应用启动实时请求一次 GitHub latest release。
   * 同一会话内已有结果时直接复用（组件重挂载不重复请求）。
   */
  async function check() {
    if (sessionResult) {
      currentVersion.value = await getVersion();
      applyResult(sessionResult, currentVersion.value);
      return;
    }

    state.value = 'checking';
    try {
      currentVersion.value = await getVersion();
      const info = await call<UpdateApiResult>('check_update', {});
      sessionResult = {
        latest: normalize(info.latest),
        url: info.url || RELEASES_PAGE,
        downloadUrl: info.downloadUrl ?? null,
      };
      applyResult(sessionResult, currentVersion.value);
    } catch {
      // 网络/鉴权失败时降级：保持可点击跳转发布页，不阻塞用户
      state.value = 'error';
    }
  }

  /** 用检测结果刷新各状态 ref */
  function applyResult(r: SessionResult, current: string) {
    latestVersion.value = r.latest;
    releaseUrl.value = r.url;
    downloadUrl.value = r.downloadUrl;
    state.value = compareVersion(r.latest, current) > 0 ? 'available' : 'uptodate';
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
