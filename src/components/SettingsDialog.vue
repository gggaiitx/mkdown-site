<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Download, ExternalLink, SquareArrowOutUpRight, Info, Keyboard, Palette, RefreshCw, SlidersHorizontal } from '@lucide/vue';
import pkg from '../../package.json';
import { useSettingsStore } from '../stores/settingsStore';
import { useI18n } from '../i18n';
import { useUpdateCheck } from '../composables/useUpdateCheck';
import { openUrl } from '../api/fileApi';
import { flushSessionSnapshot } from '../utils/sessionSnapshot';
import { BRAND_NAME } from '../utils/brand';
import { altKey, modKey, shiftKey } from '../utils/keyHint';
import { PREVIEW_THEMES } from '../utils/previewTheme';
import type { AppSettings } from '../api/types';
import { FONT_MAX, FONT_MIN } from '../api/types';
import SettingsHintIcon from './SettingsHintIcon.vue';
import FontFamilyPicker from './FontFamilyPicker.vue';
import SettingsSelect from './SettingsSelect.vue';

const settings = useSettingsStore();
const { t } = useI18n();

const emit = defineEmits<{ (e: 'close'): void }>();

/* Esc 关闭设置面板：此前没有任何 Esc 通路（F1 打开后只能再按 F1 或点 ×） */
function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}
document.addEventListener('keydown', onEsc);
onBeforeUnmount(() => document.removeEventListener('keydown', onEsc));

/** 点弹窗外是否关闭由设置决定（默认关）：× / Esc 始终可关 */
function onMaskClick() {
  if (settings.settings.dialogCloseOnMask) emit('close');
}

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
/** 更新日志：GitHub Releases */
const CHANGELOG_URL = 'https://github.com/gggaiitx/mkdown-site/releases';
function openChangelog() {
  void openUrl(CHANGELOG_URL).catch(() => undefined);
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
 * 修饰键文案走 keyHint 平台感知工具（P2-21）：Mac 显示 ⌘/⌥/⇧，Windows/Linux 显示 Ctrl/Alt/Shift。
 */
const sc = (...parts: string[]): string => parts.join(' + ');
const SHORTCUT_GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'settings.scGroupFile',
    items: [
      [sc(modKey(), 'S'), 'settings.scSave'],
      [sc(modKey(), 'N'), 'settings.scNewDoc'],
      [sc(modKey(), 'O'), 'settings.scOpenFile'],
      [sc(modKey(), shiftKey(), 'N'), 'settings.scNewWorkspace'],
      [sc(modKey(), shiftKey(), 'O'), 'settings.scOpenWorkspace'],
      [sc(modKey(), 'W'), 'settings.scCloseTab'],
      [sc(modKey(), shiftKey(), 'W'), 'settings.scCloseAllTabs'],
      ['F2', 'settings.scRename'],
      [sc(altKey(), 'E'), 'settings.scEditorOnly'],
      [sc(altKey(), 'W'), 'settings.scSplit'],
      [sc(altKey(), 'R'), 'settings.scReader'],
      ['F11', 'settings.scEditorFullscreen'],
      ['F1', 'settings.scTogglePanel'],
      [sc(modKey(), 'Tab'), 'settings.scToggleWorkspace'],
      [sc(modKey(), '= / -'), 'settings.scFontStep'],
      [sc(modKey(), '0'), 'settings.scFontReset'],
    ],
  },
  {
    title: 'settings.scGroupFind',
    items: [
      [sc(modKey(), 'F'), 'settings.scFindInFile'],
      [sc(modKey(), 'P'), 'settings.scSearchAll'],
      [sc(shiftKey(), 'F'), 'settings.scFilterTree'],
    ],
  },
  {
    title: 'settings.scGroupFormat',
    items: [
      [sc(modKey(), 'B'), 'settings.scBold'],
      [sc(modKey(), 'I'), 'settings.scItalic'],
      [sc(modKey(), 'K'), 'settings.scLink'],
      [sc(modKey(), '1~6'), 'settings.scHeadings'],
      [sc(modKey(), shiftKey(), 'C'), 'settings.scCodeBlock'],
      [sc(modKey(), shiftKey(), 'I'), 'settings.scImagePlaceholder'],
      [sc(modKey(), shiftKey(), 'F'), 'settings.scBeautify'],
    ],
  },
  {
    title: 'settings.scGroupConvert',
    items: [
      [sc(modKey(), shiftKey(), 'M'), 'settings.scWordToMd'],
      [sc(modKey(), shiftKey(), 'H'), 'settings.scWordToMh'],
    ],
  },
];

function patch(p: Partial<AppSettings>) {
  void settings.update(p);
}

/**
 * 配色可选项：只列当前解析模式（明/暗）下的四套。
 * 明暗各存一个字段（themePaletteLight / themePaletteDark），所以「跟随系统」时
 * 白天与夜里各自保留上一次选中的配色，不会来回被覆盖。
 */
const paletteOptions = computed<Array<{ value: string; label: string }>>(() =>
  settings.isDark
    ? [
        { value: 'graphite', label: 'settings.palGraphite' },
        { value: 'midnight', label: 'settings.palMidnight' },
        { value: 'ember', label: 'settings.palEmber' },
        { value: 'nebula', label: 'settings.palNebula' },
      ]
    : [
        { value: 'paper', label: 'settings.palPaper' },
        { value: 'fog', label: 'settings.palFog' },
        { value: 'sepia', label: 'settings.palSepia' },
        { value: 'azure', label: 'settings.palAzure' },
      ],
);

/** 按当前模式写入对应那一路配色字段 */
function patchPalette(v: string) {
  if (settings.isDark) patch({ themePaletteDark: v as AppSettings['themePaletteDark'] });
  else patch({ themePaletteLight: v as AppSettings['themePaletteLight'] });
}

// ---- 下拉选项：label 存 i18n key，渲染时经 tr() 现取当前语言（面板内切语言立即生效） ----
type SelectItem = { value: string; label: string };
const tr = (items: SelectItem[]): SelectItem[] =>
  items.map((it) => ({ value: it.value, label: t(it.label) }));

const THEME_MODES: SelectItem[] = [
  { value: 'system', label: 'settings.themeSystem' },
  { value: 'light', label: 'settings.themeLight' },
  { value: 'dark', label: 'settings.themeDark' },
];
const MODE_BAR_POSITIONS: SelectItem[] = [
  { value: 'center', label: 'settings.posCenter' },
  { value: 'left', label: 'settings.posLeft' },
];
const READ_LAYOUTS: SelectItem[] = [
  { value: 'narrow', label: 'settings.layoutNarrow' },
  { value: 'medium', label: 'settings.layoutMedium' },
  { value: 'wide', label: 'settings.layoutWide' },
  { value: 'full', label: 'settings.layoutFull' },
];
const OUTLINE_STYLES: SelectItem[] = [
  { value: 'classic', label: 'settings.outlineClassic' },
  { value: 'fresh', label: 'settings.outlineFresh' },
];
/** 欢迎页版式：auto=自适应 / desk=书桌 / classic=经典 */
const WELCOME_LAYOUTS: SelectItem[] = [
  { value: 'auto', label: 'settings.welcomeAuto' },
  { value: 'desk', label: 'settings.welcomeDesk' },
  { value: 'classic', label: 'settings.welcomeClassic' },
];
const LANGUAGES: SelectItem[] = [
  { value: 'zh-CN', label: 'settings.langZh' },
  { value: 'en-US', label: 'settings.langEn' },
];
const EDITOR_ENGINES: SelectItem[] = [
  { value: 'markdown', label: 'settings.engineMarkdown' },
  { value: 'wangeditor', label: 'settings.engineWangeditor' },
];
const WORD_FONTS_ZH: SelectItem[] = [
  { value: '等线', label: 'settings.fontDengxian' },
  { value: '宋体', label: 'settings.fontSimSun' },
  { value: '微软雅黑', label: 'settings.fontMsYaHei' },
];
/** 西文字体名不翻译，直接按字面展示 */
const WORD_FONTS_EN: SelectItem[] = [
  { value: 'Calibri', label: 'Calibri' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Arial', label: 'Arial' },
  { value: 'Consolas', label: 'Consolas' },
];
const WORD_EXPORT_ENGINES: SelectItem[] = [
  { value: 'builtin', label: 'settings.wordEngineBuiltin' },
  { value: 'community', label: 'settings.wordEngineCommunity' },
];
const WORD_IMPORT_FIDELITIES: SelectItem[] = [
  { value: 'semantic', label: 'settings.wordImportSemantic' },
  { value: 'fidelity', label: 'settings.wordImportFidelityOpt' },
];
const BACK_TOP_MODES: SelectItem[] = [
  { value: 'auto', label: 'settings.backTopAuto' },
  { value: 'always', label: 'settings.backTopAlways' },
];

// ---- 左右分栏分类导航（对齐 WorkBuddy 设置面板形态） ----
type SectionId = 'appearance' | 'editor' | 'actions' | 'export' | 'about';
const SECTIONS: Array<{ id: SectionId; label: string; icon: typeof Palette }> = [
  { id: 'appearance', label: 'settings.sectionAppearance', icon: Palette },
  { id: 'editor', label: 'settings.sectionEditor', icon: SlidersHorizontal },
  { id: 'actions', label: 'settings.sectionActions', icon: Keyboard },
  { id: 'export', label: 'settings.sectionExport', icon: SquareArrowOutUpRight },
  { id: 'about', label: 'settings.sectionAbout', icon: Info },
];
const active = ref<SectionId>('appearance');

/** 设置页副描述默认收起：点标题旁的信息图标展开，再点收起（全局同时只开一条） */
type HintKey =
  | 'switch' | 'dialog' | 'shortcuts' | 'back-top'
  | 'engine' | 'auto-save' | 'scroll-sync' | 'toolbar' | 'focus' | 'line-numbers'
  | 'font-family' | 'font-size' | 'export-font' | 'export-image'
  | 'theme-palette' | 'preview-theme' | 'read-layout' | 'outline' | 'welcome'
  | 'file-tree-meta' | 'tree-width'
  | 'word-engine' | 'word-import';
const openHint = ref<HintKey | null>(null);
function toggleHint(key: HintKey) {
  openHint.value = openHint.value === key ? null : key;
}
// 换页即收起，回到该页时从清爽列表开始
watch(active, () => { openHint.value = null; });

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
  <div class="mask" @click.self="onMaskClick">
    <div
      ref="dialogRef"
      class="dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="t('settings.title')"
      :style="pos ? { position: 'fixed', left: `${pos.x}px`, top: `${pos.y}px` } : undefined"
    >
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
        <div class="body" :class="{ 'body-editor': active === 'editor' }">
          <!-- 外观 -->
          <template v-if="active === 'appearance'">
            <div class="sec-title">{{ t('settings.sectionAppearance') }}</div>
            <div class="row">
              <label>{{ t('settings.themeMode') }}</label>
              <SettingsSelect
                :model-value="settings.settings.themeMode"
                :options="tr(THEME_MODES)"
                :aria-label="t('settings.themeMode')"
                @update:model-value="patch({ themeMode: $event as AppSettings['themeMode'] })"
              />
            </div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.themePalette') }}
                <SettingsHintIcon target="theme-palette" :open="openHint === 'theme-palette'" @toggle="toggleHint('theme-palette')" />
              </span>
              <SettingsSelect
                :model-value="settings.palette"
                :options="tr(paletteOptions)"
                :aria-label="t('settings.themePalette')"
                @update:model-value="patchPalette"
              />
            </div>
            <div v-if="openHint === 'theme-palette'" id="hint-theme-palette" class="sec-note">{{ t('settings.themePaletteHint') }}</div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.previewTheme') }}
                <SettingsHintIcon target="preview-theme" :open="openHint === 'preview-theme'" @toggle="toggleHint('preview-theme')" />
              </span>
              <SettingsSelect
                :model-value="settings.settings.previewTheme"
                :options="tr(PREVIEW_THEMES)"
                :aria-label="t('settings.previewTheme')"
                @update:model-value="patch({ previewTheme: $event })"
              />
            </div>
            <div v-if="openHint === 'preview-theme'" id="hint-preview-theme" class="sec-note">{{ t('settings.previewThemeHint') }}</div>
            <div class="row">
              <label>{{ t('settings.modeBarPos') }}</label>
              <SettingsSelect
                :model-value="settings.settings.modeBarPosition"
                :options="tr(MODE_BAR_POSITIONS)"
                :aria-label="t('settings.modeBarPos')"
                @update:model-value="patch({ modeBarPosition: $event as AppSettings['modeBarPosition'] })"
              />
            </div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.layout') }}
                <SettingsHintIcon target="read-layout" :open="openHint === 'read-layout'" @toggle="toggleHint('read-layout')" />
              </span>
              <SettingsSelect
                :model-value="settings.settings.readLayout"
                :options="tr(READ_LAYOUTS)"
                :aria-label="t('settings.layout')"
                @update:model-value="patch({ readLayout: $event as AppSettings['readLayout'] })"
              />
            </div>
            <div v-if="openHint === 'read-layout'" id="hint-read-layout" class="sec-note">{{ t('settings.readLayoutHint') }}</div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.fontFamily') }}
                <SettingsHintIcon target="font-family" :open="openHint === 'font-family'" @toggle="toggleHint('font-family')" />
              </span>
              <FontFamilyPicker
                :model-value="settings.settings.fontFamily"
                @update:model-value="patch({ fontFamily: $event })"
              />
            </div>
            <div v-if="openHint === 'font-family'" id="hint-font-family" class="sec-note">{{ t('settings.fontFamilyHint') }}</div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.fontSize', { n: settings.settings.fontSize }) }}
                <SettingsHintIcon target="font-size" :open="openHint === 'font-size'" @toggle="toggleHint('font-size')" />
              </span>
              <input
                type="range" :min="FONT_MIN" :max="FONT_MAX" step="0.5"
                :value="settings.settings.fontSize"
                @change="patch({ fontSize: Number(($event.target as HTMLInputElement).value) })"
              />
            </div>
            <div v-if="openHint === 'font-size'" id="hint-font-size" class="sec-note">{{ t('settings.fontSizeHint') }}</div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.outlineStyle') }}
                <SettingsHintIcon target="outline" :open="openHint === 'outline'" @toggle="toggleHint('outline')" />
              </span>
              <SettingsSelect
                :model-value="settings.settings.outlineStyle"
                :options="tr(OUTLINE_STYLES)"
                :aria-label="t('settings.outlineStyle')"
                @update:model-value="patch({ outlineStyle: $event as AppSettings['outlineStyle'] })"
              />
            </div>
            <div v-if="openHint === 'outline'" id="hint-outline" class="sec-note">{{ t('settings.outlineStyleHint') }}</div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.welcomeLayout') }}
                <SettingsHintIcon target="welcome" :open="openHint === 'welcome'" @toggle="toggleHint('welcome')" />
              </span>
              <SettingsSelect
                :model-value="settings.settings.welcomeLayout"
                :options="tr(WELCOME_LAYOUTS)"
                :aria-label="t('settings.welcomeLayout')"
                @update:model-value="patch({ welcomeLayout: $event as AppSettings['welcomeLayout'] })"
              />
            </div>
            <div v-if="openHint === 'welcome'" id="hint-welcome" class="sec-note">{{ t('settings.welcomeLayoutHint') }}</div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.fileTreeShowMtime') }}
                <SettingsHintIcon target="file-tree-meta" :open="openHint === 'file-tree-meta'" @toggle="toggleHint('file-tree-meta')" />
              </span>
              <label class="switch">
                <input
                  type="checkbox"
                  :checked="settings.settings.fileTreeShowMtime"
                  @change="patch({ fileTreeShowMtime: ($event.target as HTMLInputElement).checked })"
                />
                <span class="track" />
              </label>
            </div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.fileTreeShowSize') }}
                <SettingsHintIcon target="file-tree-meta" :open="openHint === 'file-tree-meta'" @toggle="toggleHint('file-tree-meta')" />
              </span>
              <label class="switch">
                <input
                  type="checkbox"
                  :checked="settings.settings.fileTreeShowSize"
                  @change="patch({ fileTreeShowSize: ($event.target as HTMLInputElement).checked })"
                />
                <span class="track" />
              </label>
            </div>
            <div v-if="openHint === 'file-tree-meta'" id="hint-file-tree-meta" class="sec-note">{{ t('settings.fileTreeMetaHint') }}</div>
            <div class="row">
              <label>{{ t('settings.language') }}</label>
              <SettingsSelect
                :model-value="settings.settings.language"
                :options="tr(LANGUAGES)"
                :aria-label="t('settings.language')"
                @update:model-value="patch({ language: $event })"
              />
            </div>
          </template>

          <!-- 编辑器 -->
          <template v-else-if="active === 'editor'">
            <div class="sec-title">{{ t('settings.sectionEditor') }}</div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.editorEngine') }}
                <SettingsHintIcon target="engine" :open="openHint === 'engine'" @toggle="toggleHint('engine')" />
              </span>
              <SettingsSelect
                :model-value="settings.settings.editorEngine"
                :options="tr(EDITOR_ENGINES)"
                :aria-label="t('settings.editorEngine')"
                @update:model-value="patch({ editorEngine: $event as AppSettings['editorEngine'] })"
              />
            </div>
            <div v-if="openHint === 'engine'" id="hint-engine" class="sec-note">{{ t('settings.editorEngineHint') }}</div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.autoSave') }}
                <SettingsHintIcon target="auto-save" :open="openHint === 'auto-save'" @toggle="toggleHint('auto-save')" />
              </span>
              <label class="switch">
                <input
                  type="checkbox"
                  :checked="settings.settings.autoSave"
                  @change="patch({ autoSave: ($event.target as HTMLInputElement).checked })"
                />
                <span class="track" />
              </label>
            </div>
            <div v-if="openHint === 'auto-save'" id="hint-auto-save" class="sec-note">{{ t('settings.autoSaveHint') }}</div>
            <div class="row" v-if="settings.settings.autoSave">
              <label>{{ t('settings.autoSaveDelay', { n: settings.settings.autoSaveDelayMs }) }}</label>
              <input
                type="range" min="300" max="3000" step="100"
                :value="settings.settings.autoSaveDelayMs"
                @change="patch({ autoSaveDelayMs: Number(($event.target as HTMLInputElement).value) })"
              />
            </div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.scrollSync') }}
                <SettingsHintIcon target="scroll-sync" :open="openHint === 'scroll-sync'" @toggle="toggleHint('scroll-sync')" />
              </span>
              <label class="switch">
                <input
                  type="checkbox"
                  :checked="settings.settings.scrollSync"
                  @change="patch({ scrollSync: ($event.target as HTMLInputElement).checked })"
                />
                <span class="track" />
              </label>
            </div>
            <div v-if="openHint === 'scroll-sync'" id="hint-scroll-sync" class="sec-note">{{ t('settings.scrollSyncHint') }}</div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.showToolbar') }}
                <SettingsHintIcon target="toolbar" :open="openHint === 'toolbar'" @toggle="toggleHint('toolbar')" />
              </span>
              <label class="switch">
                <input
                  type="checkbox"
                  :checked="settings.settings.showToolbar"
                  @change="patch({ showToolbar: ($event.target as HTMLInputElement).checked })"
                />
                <span class="track" />
              </label>
            </div>
            <div v-if="openHint === 'toolbar'" id="hint-toolbar" class="sec-note">{{ t('settings.showToolbarHint') }}</div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.focusMode') }}
                <SettingsHintIcon target="focus" :open="openHint === 'focus'" @toggle="toggleHint('focus')" />
              </span>
              <label class="switch">
                <input
                  type="checkbox"
                  :checked="settings.settings.focusMode"
                  @change="patch({ focusMode: ($event.target as HTMLInputElement).checked })"
                />
                <span class="track" />
              </label>
            </div>
            <div v-if="openHint === 'focus'" id="hint-focus" class="sec-note">{{ t('settings.focusModeHint') }}</div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.showLineNumbers') }}
                <SettingsHintIcon target="line-numbers" :open="openHint === 'line-numbers'" @toggle="toggleHint('line-numbers')" />
              </span>
              <label class="switch">
                <input
                  type="checkbox"
                  :checked="settings.settings.showLineNumbers"
                  @change="patch({ showLineNumbers: ($event.target as HTMLInputElement).checked })"
                />
                <span class="track" />
              </label>
            </div>
            <div v-if="openHint === 'line-numbers'" id="hint-line-numbers" class="sec-note">{{ t('settings.showLineNumbersHint') }}</div>
          </template>

          <!-- 导出（D2：Word 正文字体基线） -->
          <template v-else-if="active === 'export'">
            <div class="sec-title">
              <span>{{ t('settings.sectionExport') }}</span>
              <SettingsHintIcon target="export-font" :open="openHint === 'export-font'" @toggle="toggleHint('export-font')" />
            </div>
            <div v-if="openHint === 'export-font'" id="hint-export-font" class="sec-note">{{ t('settings.exportFontHint') }}</div>
            <div class="row">
              <label>{{ t('settings.wordFontZh') }}</label>
              <SettingsSelect
                :model-value="settings.settings.wordFontZh"
                :options="tr(WORD_FONTS_ZH)"
                :aria-label="t('settings.wordFontZh')"
                @update:model-value="patch({ wordFontZh: $event })"
              />
            </div>
            <div class="row">
              <label>{{ t('settings.wordFontEn') }}</label>
              <SettingsSelect
                :model-value="settings.settings.wordFontEn"
                :options="WORD_FONTS_EN"
                :aria-label="t('settings.wordFontEn')"
                @update:model-value="patch({ wordFontEn: $event })"
              />
            </div>
            <div class="row">
              <label>{{ t('settings.wordFontSize', { n: settings.settings.wordFontSize }) }}</label>
              <input
                type="range" min="9" max="14" step="1"
                :value="settings.settings.wordFontSize"
                @change="patch({ wordFontSize: Number(($event.target as HTMLInputElement).value) })"
              />
            </div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.wordExportEngine') }}
                <SettingsHintIcon target="word-engine" :open="openHint === 'word-engine'" @toggle="toggleHint('word-engine')" />
              </span>
              <SettingsSelect
                :model-value="settings.settings.wordExportEngine"
                :options="tr(WORD_EXPORT_ENGINES)"
                :aria-label="t('settings.wordExportEngine')"
                @update:model-value="patch({ wordExportEngine: $event as 'builtin' | 'community' })"
              />
            </div>
            <div v-if="openHint === 'word-engine'" id="hint-word-engine" class="sec-note">{{ t('settings.wordExportEngineHint') }}</div>
            <div class="row">
              <span class="row-label">
                {{ t('settings.wordImportFidelity') }}
                <SettingsHintIcon target="word-import" :open="openHint === 'word-import'" @toggle="toggleHint('word-import')" />
              </span>
              <SettingsSelect
                :model-value="settings.settings.wordImportFidelity"
                :options="tr(WORD_IMPORT_FIDELITIES)"
                :aria-label="t('settings.wordImportFidelity')"
                @update:model-value="patch({ wordImportFidelity: $event as 'semantic' | 'fidelity' })"
              />
            </div>
            <div v-if="openHint === 'word-import'" id="hint-word-import" class="sec-note">{{ t('settings.wordImportFidelityHint') }}</div>
            <!-- 图片导出与 Word 导出指向不是一回事（一个管文档字体基线，一个管预览栅格化），
                 所以这里另起一栏，别混在上面那组下面 -->
            <div class="sec-sub">
              <span>{{ t('settings.sectionExportImage') }}</span>
              <SettingsHintIcon target="export-image" :open="openHint === 'export-image'" @toggle="toggleHint('export-image')" />
            </div>
            <div v-if="openHint === 'export-image'" id="hint-export-image" class="sec-note">{{ t('settings.exportImageHint') }}</div>
            <div class="row">
              <label>{{ t('settings.exportPadding', { n: settings.settings.exportPadding }) }}</label>
              <input
                type="range" min="0" max="40" step="1"
                :value="settings.settings.exportPadding"
                @change="patch({ exportPadding: Number(($event.target as HTMLInputElement).value) })"
              />
            </div>
          </template>

          <!-- 操作：左右键切换（上栏）+ 快捷键（下栏） -->
          <template v-else-if="active === 'actions'">
            <div class="sec-title">{{ t('settings.sectionActions') }}</div>

            <div class="sec-sub first">
              <span>{{ t('settings.actionGroupSwitch') }}</span>
              <SettingsHintIcon target="switch" :open="openHint === 'switch'" @toggle="toggleHint('switch')" />
            </div>
            <div class="row">
              <label>{{ t('settings.actionSwitch') }}</label>
              <label class="switch">
                <input
                  type="checkbox"
                  :checked="settings.settings.siblingNav"
                  @change="patch({ siblingNav: ($event.target as HTMLInputElement).checked })"
                />
                <span class="track" />
              </label>
            </div>
            <div v-if="openHint === 'switch'" id="hint-switch" class="sec-note">{{ t('settings.actionSwitchHint') }}</div>

            <div class="sec-sub">
              <span>{{ t('settings.actionGroupDialog') }}</span>
              <SettingsHintIcon target="dialog" :open="openHint === 'dialog'" @toggle="toggleHint('dialog')" />
            </div>
            <div class="row">
              <label>{{ t('settings.dialogMaskClose') }}</label>
              <label class="switch">
                <input
                  type="checkbox"
                  :checked="settings.settings.dialogCloseOnMask"
                  @change="patch({ dialogCloseOnMask: ($event.target as HTMLInputElement).checked })"
                />
                <span class="track" />
              </label>
            </div>
            <div v-if="openHint === 'dialog'" id="hint-dialog" class="sec-note">{{ t('settings.dialogMaskCloseHint') }}</div>

            <!-- 回到顶部：开关 + 显现方式。两个字段分开存——关掉再打开能记住上次选的方式 -->
            <div class="sec-sub">
              <span>{{ t('settings.actionGroupBackTop') }}</span>
              <SettingsHintIcon target="back-top" :open="openHint === 'back-top'" @toggle="toggleHint('back-top')" />
            </div>
            <div class="row">
              <label>{{ t('settings.backTop') }}</label>
              <label class="switch">
                <input
                  type="checkbox"
                  :checked="settings.settings.backTopEnabled"
                  @change="patch({ backTopEnabled: ($event.target as HTMLInputElement).checked })"
                />
                <span class="track" />
              </label>
            </div>
            <div v-if="openHint === 'back-top'" id="hint-back-top" class="sec-note">{{ t('settings.backTopHint') }}</div>
            <div class="row" v-if="settings.settings.backTopEnabled">
              <label>{{ t('settings.backTopMode') }}</label>
              <SettingsSelect
                :model-value="settings.settings.backTopMode"
                :options="tr(BACK_TOP_MODES)"
                :aria-label="t('settings.backTopMode')"
                @update:model-value="patch({ backTopMode: $event as AppSettings['backTopMode'] })"
              />
            </div>

            <!-- 资源管理器：拖宽的侧栏宽度是否记住 -->
            <div class="sec-sub">
              <span>{{ t('settings.actionGroupExplorer') }}</span>
              <SettingsHintIcon target="tree-width" :open="openHint === 'tree-width'" @toggle="toggleHint('tree-width')" />
            </div>
            <div class="row">
              <label>{{ t('settings.rememberTreeWidth') }}</label>
              <label class="switch">
                <input
                  type="checkbox"
                  :checked="settings.settings.fileTreeRememberWidth"
                  @change="patch({ fileTreeRememberWidth: ($event.target as HTMLInputElement).checked })"
                />
                <span class="track" />
              </label>
            </div>
            <div v-if="openHint === 'tree-width'" id="hint-tree-width" class="sec-note">{{ t('settings.rememberTreeWidthHint') }}</div>

            <div class="sec-sub">
              <span>{{ t('settings.actionGroupShortcuts') }}</span>
              <SettingsHintIcon target="shortcuts" :open="openHint === 'shortcuts'" @toggle="toggleHint('shortcuts')" />
            </div>
            <!-- 说明紧跟分组标题（标题栏下），作为整组的前置说明；勿再挪回卡片底部当脚注 -->
            <div v-if="openHint === 'shortcuts'" id="hint-shortcuts" class="sec-note">{{ t('settings.shortcutsNote') }}</div>
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
                <div class="about-name">{{ BRAND_NAME }} <span class="ver">v{{ pkg.version }}</span></div>
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
                <span class="grow-label">{{ t('settings.changelog') }}</span>
                <button class="link-btn" :title="t('settings.openInBrowser')" @click="openChangelog">
                  <span>github.com/gggaiitx/mkdown-site/releases</span>
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
  position: fixed; inset: 0; z-index: var(--mk-z-settings);
  background: var(--mk-mask);
  display: flex; align-items: center; justify-content: center;
}
.dialog {
  width: 620px; max-width: 92vw; height: 480px; max-height: 82vh;
  display: flex; flex-direction: column;
  background: var(--mk-panel); color: var(--mk-fg);
  border: 1px solid var(--mk-border); border-radius: 10px;
  box-shadow: var(--mk-shadow-dialog);
  overflow: hidden;
}
/* 标题栏压薄一档：12px 上下内距在 14px 字号下会撑出约 48px，比正文行高一倍还多 */
.head {
  flex: none;
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 14px; font-size: 13.5px; font-weight: 600; line-height: 1.25;
  border-bottom: 1px solid var(--mk-border);
  cursor: grab; user-select: none; touch-action: none;
}
.head:active { cursor: grabbing; }
.close { border: none; background: transparent; color: var(--mk-fg-muted); font-size: 17px; line-height: 1; cursor: pointer; }

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
  display: flex; align-items: center; gap: 6px;
  margin: 0 0 6px; font-size: 13px; font-weight: 600;
  color: var(--mk-fg);
}
/* 组内说明收起开关：标题旁的小信息图标，点开才显示说明（默认收起，同时只开一组） */
.sec-note {
  margin: -2px 0 8px; font-size: 11px; line-height: 1.6;
  color: var(--mk-fg-muted);
}
/* 行级副描述开关挂在左侧标题上；与组标题用同一枚图标 */
.row-label {
  display: inline-flex; align-items: center; gap: 6px;
  color: var(--mk-fg);
}
/* 同页里的第二组：一条分隔线 + 小标题，指向不同的一组设置不混在一起 */
.sec-sub {
  display: flex; align-items: center; gap: 6px;
  margin: 14px 0 2px; padding-top: 12px;
  border-top: 1px solid var(--mk-border);
  font-size: 12px; font-weight: 600; color: var(--mk-fg-muted);
}
/* 组内说明收起开关由 SettingsHintIcon 统一提供（图标 + tooltip + aria） */
/* 紧跟页标题的第一组不画顶部分隔线 */
.sec-sub.first {
  margin-top: 2px; padding-top: 0;
  border-top: none;
}
/* 编辑器页多为开关行（仅 20px 高），按首行下拉的 42px 统一行距，避免上疏下密 */
.body-editor .row { min-height: 42px; }
.row {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 13px; padding: 7px 0; gap: 12px;
}
.row label { color: var(--mk-fg); }
.row input[type='range'] {
  width: var(--mk-control-w); margin: 0;
  accent-color: var(--mk-accent);
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
/* 说明紧跟组标题时，卡片不再额外让位（说明自带 8px 下间距） */
.sec-note + .sc-card { margin-top: 2px; }
kbd {
  background: var(--mk-panel); border: 1px solid var(--mk-border); border-bottom-width: 2px;
  border-radius: 4px; padding: 1px 8px; font-size: 11px; color: var(--mk-fg-muted);
  min-width: 84px; text-align: center; flex: none;
}

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
