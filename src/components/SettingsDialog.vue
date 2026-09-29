<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import pkg from '../../package.json';
import { useSettingsStore } from '../stores/settingsStore';
import type { AppSettings } from '../api/types';

const settings = useSettingsStore();

const emit = defineEmits<{ (e: 'close'): void }>();

/**
 * 快捷键说明：与 Workbench.onKeydown / 内核 keymap 的实际绑定严格同步，勿凭记忆增删。
 * - 文件/视图/查找类：应用层 window 捕获统一处理；
 * - 格式类（编辑/分栏视图生效）：编辑器有焦点时内核 keymap 处理，焦点在外由应用层接管；
 * - Ctrl+K 是应用层绑定（内核链接键实为 Ctrl+L，对外统一为 Ctrl+K）。
 */
const SHORTCUT_GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: '文件与视图',
    items: [
      ['Ctrl + S', '保存'],
      ['Ctrl + N', '新建文档'],
      ['Ctrl + O', '打开文件'],
      ['Alt + E', '仅编辑视图'],
      ['Alt + W', '分栏视图'],
      ['Alt + R', '阅读视图'],
      ['F11', '编辑器全屏'],
      ['F1', '打开 / 关闭本面板'],
    ],
  },
  {
    title: '查找',
    items: [
      ['Ctrl + F', '文件内查找'],
      ['Ctrl + P', '全局搜索'],
    ],
  },
  {
    title: '格式（编辑 / 分栏视图生效）',
    items: [
      ['Ctrl + B', '加粗'],
      ['Ctrl + I', '斜体'],
      ['Ctrl + K', '插入链接'],
      ['Ctrl + 1~6', '一 ~ 六级标题'],
      ['Ctrl + Shift + C', '代码块'],
      ['Ctrl + Shift + I', '插入图片占位'],
      ['Ctrl + Shift + F', '美化 Markdown'],
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
  { value: 'default', label: 'default · 默认' },
  { value: 'github', label: 'github · GitHub' },
  { value: 'vuepress', label: 'vuepress · Vue 文档' },
  { value: 'mk-cute', label: 'mk-cute · 可爱' },
  { value: 'smart-blue', label: 'smart-blue · 蓝调' },
  { value: 'cyanosis', label: 'cyanosis · 掘金深蓝' },
  { value: 'win', label: 'win · Windows 风' },
];

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
  const w = dialogRef.value?.offsetWidth ?? 520;
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
      <div class="head" title="按住标题栏可拖动" @pointerdown="onDragStart">
        <span class="head-title">设置</span>
        <button class="close" title="关闭" @click="emit('close')">×</button>
      </div>
      <div class="body">
        <div class="section-title">外观</div>
        <div class="row">
          <label>主题</label>
          <select :value="settings.settings.theme" @change="patch({ theme: ($event.target as HTMLSelectElement).value as AppSettings['theme'] })">
            <option value="light">亮色</option>
            <option value="dark">暗色</option>
          </select>
        </div>
        <div class="row">
          <label>预览主题</label>
          <select :value="settings.settings.previewTheme" @change="patch({ previewTheme: ($event.target as HTMLSelectElement).value })">
            <option v-for="t in previewThemes" :key="t.value" :value="t.value">{{ t.label }}</option>
          </select>
        </div>
        <div class="row">
          <label>内容版式（编辑 / 阅读）</label>
          <select :value="settings.settings.readLayout" @change="patch({ readLayout: ($event.target as HTMLSelectElement).value as AppSettings['readLayout'] })">
            <option value="narrow">窄（760px）</option>
            <option value="medium">中（1020px，默认）</option>
            <option value="wide">宽（1320px）</option>
          </select>
        </div>
        <div class="row">
          <label>字号（{{ settings.settings.fontSize }}px）</label>
          <input
            type="range" min="12" max="24" step="1"
            :value="settings.settings.fontSize"
            @change="patch({ fontSize: Number(($event.target as HTMLInputElement).value) })"
          />
        </div>

        <div class="section-title">编辑器</div>
        <div class="row">
          <label>自动保存</label>
          <input
            type="checkbox"
            :checked="settings.settings.autoSave"
            @change="patch({ autoSave: ($event.target as HTMLInputElement).checked })"
          />
        </div>
        <div class="row" v-if="settings.settings.autoSave">
          <label>自动保存延迟（{{ settings.settings.autoSaveDelayMs }}ms）</label>
          <input
            type="range" min="300" max="3000" step="100"
            :value="settings.settings.autoSaveDelayMs"
            @change="patch({ autoSaveDelayMs: Number(($event.target as HTMLInputElement).value) })"
          />
        </div>
        <div class="row">
          <label>滚动同步</label>
          <input
            type="checkbox"
            :checked="settings.settings.scrollSync"
            @change="patch({ scrollSync: ($event.target as HTMLInputElement).checked })"
          />
        </div>

        <div class="section-title">快捷键</div>
        <div v-for="g in SHORTCUT_GROUPS" :key="g.title" class="sc-group">
          <div class="sc-group-title">{{ g.title }}</div>
          <div class="shortcuts">
            <div class="sc" v-for="[k, v] in g.items" :key="k">
              <kbd>{{ k }}</kbd><span>{{ v }}</span>
            </div>
          </div>
        </div>
        <div class="sc-note">格式类快捷键在编辑器获得焦点时由内核处理，焦点在外（如侧栏、预览）时同样响应。</div>

        <div class="about">
          码克 v{{ pkg.version }} · 本地离线 · 数据不出本机
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
  width: 520px; max-width: 92vw; max-height: 82vh;
  display: flex; flex-direction: column;
  background: var(--mk-panel); color: var(--mk-fg);
  border: 1px solid var(--mk-border); border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}
.head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 16px; font-size: 14px; font-weight: 600;
  border-bottom: 1px solid var(--mk-border);
  cursor: grab; user-select: none; touch-action: none;
}
.head:active { cursor: grabbing; }
.close { border: none; background: transparent; color: var(--mk-fg-muted); font-size: 18px; cursor: pointer; }
.body { overflow-y: auto; padding: 12px 16px 14px; }
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
.section-title {
  margin: 12px 0 4px; font-size: 12px; font-weight: 600;
  color: var(--mk-accent); letter-spacing: 1px;
}
.sc-group { margin-bottom: 6px; }
.sc-group-title { font-size: 11px; color: var(--mk-fg-muted); margin: 6px 0 3px; }
.shortcuts { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; }
.sc { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--mk-fg); padding: 2px 0; }
kbd {
  background: var(--mk-bg); border: 1px solid var(--mk-border); border-bottom-width: 2px;
  border-radius: 4px; padding: 1px 6px; font-size: 11px; color: var(--mk-fg-muted);
  min-width: 96px; text-align: center;
}
.sc-note { margin-top: 8px; font-size: 11px; color: var(--mk-fg-muted); line-height: 1.6; }
.about { margin-top: 14px; font-size: 11px; color: var(--mk-fg-muted); text-align: center; }
</style>
