<script setup lang="ts">
import { useSettingsStore } from '../stores/settingsStore';
import type { AppSettings } from '../api/types';

const settings = useSettingsStore();

const emit = defineEmits<{ (e: 'close'): void }>();

const SHORTCUTS: [string, string][] = [
  ['Ctrl + S', '保存'],
  ['Ctrl + N', '新建文档'],
  ['Ctrl + O', '打开文件'],
  ['Alt + E', '仅编辑模式'],
  ['Alt + W', '分栏模式'],
  ['Alt + R', '阅读模式'],
  ['Ctrl + P', '全局搜索'],
  ['Ctrl + F', '文件内查找'],
  ['Ctrl + B', '加粗'],
  ['Ctrl + I', '斜体'],
  ['Ctrl + 1~6', '一~六级标题'],
  ['Ctrl + K', '插入链接'],
  ['Ctrl + Shift + C', '代码块'],
  ['Ctrl + Shift + I', '图片'],
  ['Ctrl + Shift + F', '美化 Markdown'],
  ['F11', '编辑器全屏'],
];

function patch(p: Partial<AppSettings>) {
  void settings.update(p);
}

const previewThemes = ['default', 'github', 'vuepress', 'mk-cute', 'smart-blue', 'cyanosis'];
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <div class="head">
        <span>设置</span>
        <button class="close" @click="emit('close')">×</button>
      </div>
      <div class="body">
        <div class="row">
          <label>主题</label>
          <select :value="settings.settings.theme" @change="patch({ theme: ($event.target as HTMLSelectElement).value as AppSettings['theme'] })">
            <option value="light">亮色</option>
            <option value="dark">暗色</option>
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
        <div class="row">
          <label>预览主题</label>
          <select :value="settings.settings.previewTheme" @change="patch({ previewTheme: ($event.target as HTMLSelectElement).value })">
            <option v-for="t in previewThemes" :key="t" :value="t">{{ t }}</option>
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

        <div class="section-title">快捷键（F1 也可打开本面板）</div>
        <div class="shortcuts">
          <div class="sc" v-for="[k, v] in SHORTCUTS" :key="k">
            <kbd>{{ k }}</kbd><span>{{ v }}</span>
          </div>
        </div>

        <div class="about">
          码克 v0.1.0 · 本地离线 · 数据不出本机
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
  width: 480px; max-width: 92vw; max-height: 82vh;
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
}
.close { border: none; background: transparent; color: var(--mk-fg-muted); font-size: 18px; cursor: pointer; }
.body { overflow-y: auto; padding: 14px 16px; }
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
  margin: 14px 0 6px; font-size: 12px; font-weight: 600;
  color: var(--mk-fg-muted); letter-spacing: 1px;
}
.shortcuts { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; }
.sc { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--mk-fg); padding: 2px 0; }
kbd {
  background: var(--mk-bg); border: 1px solid var(--mk-border); border-bottom-width: 2px;
  border-radius: 4px; padding: 1px 6px; font-size: 11px; color: var(--mk-fg-muted);
  min-width: 70px; text-align: center;
}
.about { margin-top: 14px; font-size: 11px; color: var(--mk-fg-muted); text-align: center; }
</style>
