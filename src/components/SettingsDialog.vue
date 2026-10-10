<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { Download, ExternalLink, Info, Keyboard, Palette, RefreshCw, SlidersHorizontal } from '@lucide/vue';
import pkg from '../../package.json';
import { useSettingsStore } from '../stores/settingsStore';
import { useI18n } from '../i18n';
import { useUpdateCheck } from '../composables/useUpdateCheck';
import { openUrl } from '../api/fileApi';
import { flushSessionSnapshot } from '../utils/sessionSnapshot';
import type { AppSettings } from '../api/types';

const settings = useSettingsStore();
const { t } = useI18n();

const emit = defineEmits<{ (e: 'close'): void }>();

/** 顶栏 GitHub 入口同款仓库地址 */
const GITHUB_URL = 'https://github.com/gggaiitx/mkdown-site';
function openGithub() {
  void openUrl(GITHUB_URL).catch(() => undefined);
}
/** 官网 */
const SITE_URL = 'https://mkdown.shenco.wang';
function openSite() {
  void openUrl(SITE_URL).catch(() => undefined);
}

// ---- 更新检测（与顶栏更新按钮共用同一 composable；状态为模块级单例，
//      此处的下载/安装与顶栏是同一条链路：进度实时反映在顶栏进度环上，
//      下载完成顶栏自动弹重启确认，避免出现两个入口状态失同步） ----
const {
  state: updateState,
  currentVersion,
  latestVersion,
  releaseUrl,
  downloadState,
  check,
  startDownload,
  applyUpdate,
} = useUpdateCheck();
const checking = ref(false);
async function recheckUpdate() {
  if (checking.value) return;
  checking.value = true;
  try {
    await check(true); // force：绕过会话缓存重新请求
  } finally {
    checking.value = false;
  }
}
const updateStatusText = () => {
  switch (updateState.value) {
    case 'checking':
      return t('settings.updateChecking');
    case 'uptodate':
      return t('settings.updateUpToDate', { v: currentVersion.value });
    case 'available':
      return t('settings.updateAvailable', { latest: latestVersion.value });
    case 'error':
      return t('settings.updateError');
    default:
      return t('settings.updateNotChecked');
  }
};

/** 「下载更新」按钮文案：随下载状态流转（下载中禁用 → 已下载转安装） */
const settingsUpdateBtnText = computed(() => {
  if (downloadState.value === 'downloading') return t('settings.downloading');
  if (downloadState.value === 'downloaded') return t('settings.restartInstall');
  return t('settings.downloadUpdate');
});

/** 与顶栏更新按钮同一条链路：available → 后台下载（顶栏进度环实时显示）；
 *  已下载 → 固化会话并静默安装重启（与顶栏「立即更新」确认等价） */
async function onSettingsUpdateClick() {
  if (updateState.value !== 'available') return;
  if (downloadState.value === 'downloading') return;
  if (downloadState.value === 'downloaded') {
    // 退出前固化会话（含未保存草稿），重启后由会话恢复流程还原
    await flushSessionSnapshot();
    await applyUpdate(); // 进程将在此退出并重启
    return;
  }
  void startDownload();
}

/**
 * 快捷键说明：与 Workbench.onKeydown / 内核 keymap 的实际绑定严格同步，勿凭记忆增删。
 * - 文件/视图/查找类：应用层 window 捕获统一处理；
 * - 格式类（编辑/分栏视图生效）：编辑器有焦点时内核 keymap 处理，焦点在外由应用层接管；
 * - Ctrl+K 是应用层绑定（内核链接键实为 Ctrl+L，对外统一为 Ctrl+K）。
 */
const SHORTCUT_GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'settings.scGroupFile',
    items: [
      ['Ctrl + S', 'settings.scSave'],
      ['Ctrl + N', 'settings.scNewDoc'],
      ['Ctrl + O', 'settings.scOpenFile'],
      ['Ctrl + W', 'settings.scCloseTab'],
      ['Ctrl + Shift + W', 'settings.scCloseAllTabs'],
      ['F2', 'settings.scRename'],
      ['Alt + E', 'settings.scEditorOnly'],
      ['Alt + W', 'settings.scSplit'],
      ['Alt + R', 'settings.scReader'],
      ['F11', 'settings.scEditorFullscreen'],
      ['F1', 'settings.scTogglePanel'],
    ],
  },
  {
    title: 'settings.scGroupFind',
    items: [
      ['Ctrl + F', 'settings.scFindInFile'],
      ['Ctrl + P', 'settings.scSearchAll'],
      ['Shift + F', 'settings.scFilterTree'],
    ],
  },
  {
    title: 'settings.scGroupFormat',
    items: [
      ['Ctrl + B', 'settings.scBold'],
      ['Ctrl + I', 'settings.scItalic'],
      ['Ctrl + K', 'settings.scLink'],
      ['Ctrl + 1~6', 'settings.scHeadings'],
      ['Ctrl + Shift + C', 'settings.scCodeBlock'],
      ['Ctrl + Shift + I', 'settings.scImagePlaceholder'],
      ['Ctrl + Shift + F', 'settings.scBeautify'],
    ],
  },
];

function patch(p: Partial<AppSettings>) {
  void settings.update(p);
}

/**
 * 预览主题可选项。内置 6 项来自 @vavt/markdown-theme；
 * win 为本项目自建 Windows 11 Fluent 风主题（样式见 src/styles/win-theme.css）。
 */
const previewThemes: Array<{ value: string; label: string }> = [
  { value: 'default', label: 'settings.ptDefault' },
  { value: 'github', label: 'settings.ptGithub' },
  { value: 'vuepress', label: 'settings.ptVuepress' },
  { value: 'mk-cute', label: 'settings.ptMkCute' },
  { value: 'smart-blue', label: 'settings.ptSmartBlue' },
  { value: 'cyanosis', label: 'settings.ptCyanosis' },
  { value: 'win', label: 'settings.ptWin' },
];

// ---- 左右分栏分类导航（对齐 WorkBuddy 设置面板形态） ----
type SectionId = 'appearance' | 'editor' | 'shortcuts' | 'about';
const SECTIONS: Array<{ id: SectionId; label: string; icon: typeof Palette }> = [
  { id: 'appearance', label: 'settings.sectionAppearance', icon: Palette },
  { id: 'editor', label: 'settings.sectionEditor', icon: SlidersHorizontal },
  { id: 'shortcuts', label: 'settings.sectionShortcuts', icon: Keyboard },
  { id: 'about', label: 'settings.sectionAbout', icon: Info },
];
const active = ref<SectionId>('appearance');

// ---- 面板拖拽（标题栏 pointer 事件；clamp 在视口内，标题栏至少留 48px 可抓回） ----
const dialogRef = ref<HTMLElement | null>(null);
/** null = 未拖过，走 CSS 居中；拖过即固定定位 */
const pos = ref<{ x: number; y: number } | null>(null);
let dragOffset = { x: 0, y: 0 };

function onDragStart(e: PointerEvent) {
  if ((e.target as HTMLElement).closest('button')) return;
  const el = dialogRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  pos.value = { x: rect.left, y: rect.top }; // 从当前位置无缝接管，视觉无跳变
  dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  document.body.style.userSelect = 'none';
}

function onDragMove(e: PointerEvent) {
  if (!pos.value) return;
  const w = dialogRef.value?.offsetWidth ?? 560;
  pos.value = {
    x: Math.min(window.innerWidth - 120, Math.max(-(w - 120), e.clientX - dragOffset.x)),
    y: Math.min(window.innerHeight - 48, Math.max(0, e.clientY - dragOffset.y)),
  };
}

function onDragEnd() {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  document.body.style.userSelect = '';
}

onBeforeUnmount(onDragEnd);
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div ref="dialogRef" class="dialog" :style="pos ? { position: 'fixed', left: `${pos.x}px`, top: `${pos.y}px` } : undefined">
      <div class="head" :title="t('settings.dragHint')" @pointerdown="onDragStart">
        <span class="head-title">{{ t('settings.title') }}</span>
        <button class="close" :title="t('settings.close')" @click="emit('close')">×</button>
      </div>
      <div class="layout">
        <!-- 左侧分类导航 -->
        <nav class="nav">
          <button
            v-for="s in SECTIONS"
            :key="s.id"
            class="nav-item"
            :class="{ on: active === s.id }"
            @click="active = s.id"
          >
            <component :is="s.icon" class="nav-ic" :size="15" />
            <span>{{ t(s.label) }}</span>
          </button>
        </nav>
        <!-- 右侧内容区 -->
        <div class="body">
          <!-- 外观 -->
          <template v-if="active === 'appearance'">
            <div class="sec-title">{{ t('settings.sectionAppearance') }}</div>
            <div class="row">
              <label>{{ t('settings.theme') }}</label>
              <select :value="settings.settings.theme" @change="patch({ theme: ($event.target as HTMLSelectElement).value as AppSettings['theme'] })">
                <option value="light">{{ t('settings.themeLight') }}</option>
                <option value="dark">{{ t('settings.themeDark') }}</option>
              </select>
            </div>
            <div class="row">
              <label>{{ t('settings.previewTheme') }}</label>
              <select :value="settings.settings.previewTheme" @change="patch({ previewTheme: ($event.target as HTMLSelectElement).value })">
                <option v-for="pt in previewThemes" :key="pt.value" :value="pt.value">{{ t(pt.label) }}</option>
              </select>
            </div>
            <div class="row">
              <label>{{ t('settings.layout') }}</label>
              <select :value="settings.settings.readLayout" @change="patch({ readLayout: ($event.target as HTMLSelectElement).value as AppSettings['readLayout'] })">
                <option value="narrow">{{ t('settings.layoutNarrow') }}</option>
                <option value="medium">{{ t('settings.layoutMedium') }}</option>
                <option value="wide">{{ t('settings.layoutWide') }}</option>
              </select>
            </div>
            <div class="row">
              <label>{{ t('settings.fontSize', { n: settings.settings.fontSize }) }}</label>
              <input
                type="range" min="12" max="24" step="1"
                :value="settings.settings.fontSize"
                @change="patch({ fontSize: Number(($event.target as HTMLInputElement).value) })"
              />
            </div>
            <div class="row">
              <label>{{ t('settings.language') }}</label>
              <select :value="settings.settings.language" @change="patch({ language: ($event.target as HTMLSelectElement).value })">
                <option value="zh-CN">{{ t('settings.langZh') }}</option>
                <option value="en-US">{{ t('settings.langEn') }}</option>
              </select>
            </div>
          </template>

          <!-- 编辑器 -->
          <template v-else-if="active === 'editor'">
            <div class="sec-title">{{ t('settings.sectionEditor') }}</div>
            <div class="row">
              <label>{{ t('settings.editorEngine') }}</label>
              <select
                :title="t('settings.editorEngineHint')"
                :value="settings.settings.editorEngine"
                @change="patch({ editorEngine: ($event.target as HTMLSelectElement).value as AppSettings['editorEngine'] })"
              >
                <option value="markdown">{{ t('settings.engineMarkdown') }}</option>
                <option value="wangeditor">{{ t('settings.engineWangeditor') }}</option>
              </select>
            </div>
            <div class="row">
              <label>{{ t('settings.autoSave') }}</label>
              <label class="switch" :title="t('settings.autoSaveHint')">
                <input
                  type="checkbox"
                  :checked="settings.settings.autoSave"
                  @change="patch({ autoSave: ($event.target as HTMLInputElement).checked })"
                />
                <span class="track" />
              </label>
            </div>
            <div class="row" v-if="settings.settings.autoSave">
              <label>{{ t('settings.autoSaveDelay', { n: settings.settings.autoSaveDelayMs }) }}</label>
              <input
                type="range" min="300" max="3000" step="100"
                :value="settings.settings.autoSaveDelayMs"
                @change="patch({ autoSaveDelayMs: Number(($event.target as HTMLInputElement).value) })"
              />
            </div>
            <div class="row">
              <label>{{ t('settings.scrollSync') }}</label>
              <label class="switch" :title="t('settings.scrollSyncHint')">
                <input
                  type="checkbox"
                  :checked="settings.settings.scrollSync"
                  @change="patch({ scrollSync: ($event.target as HTMLInputElement).checked })"
                />
                <span class="track" />
              </label>
            </div>
            <div class="row">
              <label>{{ t('settings.showToolbar') }}</label>
              <label class="switch" :title="t('settings.showToolbarHint')">
                <input
                  type="checkbox"
                  :checked="settings.settings.showToolbar"
                  @change="patch({ showToolbar: ($event.target as HTMLInputElement).checked })"
                />
                <span class="track" />
              </label>
            </div>
          </template>

          <!-- 快捷键 -->
          <template v-else-if="active === 'shortcuts'">
            <div class="sec-title">{{ t('settings.sectionShortcuts') }}</div>
            <!-- 单卡分组：组头条（muted 底）+ 行式条目（动作名左 / 键帽右），与关于页信息组同语言 -->
            <div class="sc-card">
              <template v-for="g in SHORTCUT_GROUPS" :key="g.title">
                <div class="sc-head">{{ t(g.title) }}</div>
                <div class="sc-row" v-for="[k, v] in g.items" :key="k">
                  <span>{{ t(v) }}</span>
                  <kbd>{{ k }}</kbd>
                </div>
              </template>
            </div>
            <div class="sc-note">{{ t('settings.shortcutsNote') }}</div>
          </template>

          <!-- 关于 -->
          <template v-else>
            <div class="sec-title">{{ t('settings.sectionAbout') }}</div>
            <!-- 品牌卡：logo 与 Welcome 同源 SVG（M+光标），名称/版本/定位语横排 -->
            <div class="about-card">
              <svg class="about-logo" viewBox="0 0 102 102" aria-hidden="true">
                <rect width="102" height="102" rx="24" fill="#E6F1FB" />
                <path
                  d="M27 72 L27 32 L42 50 L57 32 L57 72"
                  fill="none" stroke="#0C447C" stroke-width="7"
                  stroke-linecap="round" stroke-linejoin="round"
                />
                <rect x="63" y="60" width="11" height="14" rx="2.5" fill="#378ADD" />
              </svg>
              <div class="about-meta">
                <div class="about-name">{{ t('settings.brandName') }} <span class="ver">v{{ pkg.version }}</span></div>
                <div class="about-line">{{ t('settings.brandTagline') }}</div>
              </div>
            </div>

            <!-- 信息组：行式布局 + 发丝分隔线，与其他设置页的行式语言对齐 -->
            <div class="about-group">
              <div class="grow">
                <span class="grow-label">{{ t('settings.githubRepo') }}</span>
                <button class="link-btn" :title="t('settings.openInBrowser')" @click="openGithub">
                  <span>github.com/gggaiitx/mkdown-site</span>
                  <ExternalLink :size="12" class="ext" />
                </button>
              </div>
              <div class="grow">
                <span class="grow-label">{{ t('settings.website') }}</span>
                <button class="link-btn" :title="t('settings.openInBrowser')" @click="openSite">
                  <span>mkdown.shenco.wang</span>
                  <ExternalLink :size="12" class="ext" />
                </button>
              </div>
              <div class="grow">
                <div class="grow-left">
                  <span class="grow-label">{{ t('settings.updateCheck') }}</span>
                  <!-- 结果内联在标签后：未检测/检测中不显示（按钮文案已表达检测中） -->
                  <span
                    v-if="updateState === 'uptodate' || updateState === 'available' || updateState === 'error'"
                    class="update-status"
                    :class="updateState"
                  >{{ updateStatusText() }}</span>
                </div>
                <div class="grow-actions">
                  <button class="link-btn" :disabled="checking || updateState === 'checking'" @click="recheckUpdate">
                    <RefreshCw :size="13" :class="{ spin: checking || updateState === 'checking' }" />
                    <span>{{ checking || updateState === 'checking' ? t('settings.checking') : t('settings.checkUpdate') }}</span>
                  </button>
                  <!-- 检测失败：兜底跳发布页手动查看 -->
                  <button
                    v-if="updateState === 'error'"
                    class="link-btn"
                    @click="openUrl(releaseUrl).catch(() => undefined)"
                  >
                    <ExternalLink :size="12" />
                    <span>{{ t('settings.goRelease') }}</span>
                  </button>
                  <!-- 有新版：直接触发顶栏同款下载逻辑（状态单例共享，进度实时反映在顶栏进度环上） -->
                  <button
                    v-if="updateState === 'available'"
                    class="link-btn"
                    :disabled="downloadState === 'downloading'"
                    @click="onSettingsUpdateClick"
                  >
                    <Download :size="13" />
                    <span>{{ settingsUpdateBtnText }}</span>
                  </button>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 30000;
  background: rgba(0, 0, 0, 0.4);
  display: flex; align-items: center; justify-content: center;
}
.dialog {
  width: 620px; max-width: 92vw; height: 480px; max-height: 82vh;
  display: flex; flex-direction: column;
  background: var(--mk-panel); color: var(--mk-fg);
  border: 1px solid var(--mk-border); border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}
.head {
  flex: none;
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 16px; font-size: 14px; font-weight: 600;
  border-bottom: 1px solid var(--mk-border);
  cursor: grab; user-select: none; touch-action: none;
}
.head:active { cursor: grabbing; }
.close { border: none; background: transparent; color: var(--mk-fg-muted); font-size: 18px; cursor: pointer; }

/* ---- 左右分栏：左分类导航 + 右内容区（WorkBuddy 设置面板形态） ---- */
.layout {
  flex: 1; display: flex; min-height: 0;
}
.nav {
  flex: none; width: 132px;
  padding: 10px 8px;
  border-right: 1px solid var(--mk-border);
  background: var(--mk-panel-muted);
  display: flex; flex-direction: column; gap: 2px;
}
.nav-item {
  display: flex; align-items: center; gap: 8px;
  border: none; background: transparent; color: var(--mk-fg-muted);
  font-size: 13px; text-align: left;
  height: 32px; padding: 0 10px;
  border-radius: var(--mk-radius);
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
.nav-item:hover { background: var(--mk-hover); color: var(--mk-fg); }
.nav-item.on {
  background: var(--mk-hover); color: var(--mk-fg);
  font-weight: 600;
}
.nav-ic { flex: none; }

.body {
  flex: 1; min-width: 0;
  overflow-y: auto;
  padding: 14px 20px 16px;
}
.sec-title {
  margin: 0 0 6px; font-size: 13px; font-weight: 600;
  color: var(--mk-fg);
}
.row {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 13px; padding: 7px 0; gap: 12px;
}
.row label { color: var(--mk-fg); }
.row select, .row input[type='range'] { accent-color: var(--mk-accent); }
.row select {
  border: 1px solid var(--mk-border); border-radius: 6px;
  background: var(--mk-bg); color: var(--mk-fg); padding: 4px 8px;
}

/* ---- 开关（替代 checkbox）：滑块式，选中走 accent 色 ---- */
.switch {
  position: relative; display: inline-block;
  width: 36px; height: 20px; flex: none;
  cursor: pointer;
}
.switch input {
  opacity: 0; width: 0; height: 0;
  position: absolute;
}
.switch .track {
  position: absolute; inset: 0;
  background: var(--mk-border-strong);
  border-radius: 999px;
  transition: background-color 150ms ease;
}
.switch .track::after {
  content: '';
  position: absolute; top: 2px; left: 2px;
  width: 16px; height: 16px;
  border-radius: 50%;
  background: var(--mk-accent-fg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: transform 150ms ease;
}
.switch input:checked + .track { background: var(--mk-accent); }
.switch input:checked + .track::after { transform: translateX(16px); }
.switch input:focus-visible + .track { outline: 2px solid var(--mk-fg-muted); outline-offset: 1px; }

/* ---- 链接 / 动作按钮（关于页）：ghost 风格，hover 提亮 ---- */
.link-btn {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--mk-border);
  background: var(--mk-bg); color: var(--mk-fg);
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.link-btn:hover:not(:disabled) {
  background: var(--mk-hover);
  border-color: var(--mk-border-strong);
}
.link-btn:disabled { opacity: 0.55; cursor: default; }
.link-btn .ext { color: var(--mk-fg-muted); }
.spin { animation: mk-spin 0.9s linear infinite; }
@keyframes mk-spin {
  to { transform: rotate(360deg); }
}

/* 快捷键：单卡分组（组头条 + 行式条目 + 发丝分隔），与关于页信息组同语言 */
.sc-card {
  margin-top: 10px;
  border: 1px solid var(--mk-border);
  border-radius: 8px;
  background: var(--mk-bg);
  overflow: hidden;
}
.sc-head {
  padding: 7px 14px 6px;
  font-size: 11px; font-weight: 600; color: var(--mk-fg-muted);
  letter-spacing: 1px;
  background: var(--mk-panel-muted);
  border-bottom: 1px solid var(--mk-border);
}
.sc-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 7px 14px;
  font-size: 13px; color: var(--mk-fg);
}
/* 相邻行之间画发丝线；行跟在组头条后不画（头条自带 border-bottom） */
.sc-row + .sc-row { border-top: 1px solid var(--mk-border); }
kbd {
  background: var(--mk-panel); border: 1px solid var(--mk-border); border-bottom-width: 2px;
  border-radius: 4px; padding: 1px 8px; font-size: 11px; color: var(--mk-fg-muted);
  min-width: 84px; text-align: center; flex: none;
}
.sc-note { margin-top: 8px; font-size: 11px; color: var(--mk-fg-muted); line-height: 1.6; }

/* 关于：品牌卡（logo 与 Welcome 同源 SVG）+ 信息组行式布局 */
.about-card {
  margin-top: 10px;
  display: flex; align-items: center; gap: 14px;
  border: 1px solid var(--mk-border);
  border-radius: 8px;
  background: var(--mk-bg);
  padding: 16px;
}
.about-logo { flex: none; width: 52px; height: 52px; border-radius: 12px; }
.about-meta { min-width: 0; }
.about-name { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.ver {
  font-size: 11px; font-weight: 500; color: var(--mk-fg-muted);
  border: 1px solid var(--mk-border); border-radius: 999px;
  padding: 0 8px; line-height: 1.7;
}
.about-line { margin-top: 5px; font-size: 12px; color: var(--mk-fg-muted); line-height: 1.6; }

/* 信息组：设置行 + 发丝分隔线；状态行作为组脚注（有发现/失败时着色） */
.about-group {
  margin-top: 10px;
  border: 1px solid var(--mk-border);
  border-radius: 8px;
  background: var(--mk-bg);
  overflow: hidden;
}
.grow {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 9px 14px;
  font-size: 13px;
}
.grow + .grow { border-top: 1px solid var(--mk-border); }
/* 左组：标签 + 内联状态文字（更新检测结果），长文字在组内换行不挤右侧按钮 */
.grow-left { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1; }
.grow-label { color: var(--mk-fg); flex: none; }
.grow-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
/* 更新结果：内联在「检查更新」按钮后的小字（未检测/检测中不渲染） */
.update-status {
  font-size: 12px;
  color: var(--mk-fg-muted);
  line-height: 1.5;
  min-width: 0;
}
.update-status.available { color: var(--mk-ok); }
.update-status.error { color: var(--mk-warn); }
</style>
