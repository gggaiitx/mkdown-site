import { defineStore } from 'pinia';
import { getSettings, setSettings } from '../api/settingsApi';
import { debounce } from '../utils/common';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ThemeKind,
  type ThemePalette,
} from '../api/types';
import { useI18n } from '../i18n';
import { useEditorStore } from './editorStore';

const persist = debounce((s: AppSettings) => {
  void setSettings(s).catch(() => {
    /* 回写失败不阻塞 UI，下次变更会重试；但必须 toast 让用户感知（P2-12），
       否则无后续变更时设置静默丢失。提示走 editorStore 全局轻提示通道 */
    try {
      useEditorStore().showToast(useI18n().t('settings.persistFailed'), 'error');
    } catch {
      /* 启动期 store 未就绪：跳过提示，不阻塞 */
    }
  });
}, 500);

/* 系统亮暗监听（模块级单例，与 store 实例解耦）：
   只有 themeMode='system' 时才真正影响外观，切到手动模式后监听仍在，
   只是 applyTheme 不再被它触发 */
let mq: MediaQueryList | null = null;

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    settings: { ...DEFAULT_SETTINGS } as AppSettings,
    loaded: false,
    /** 系统是否为暗色（matchMedia 实时值；system 模式的解析依据） */
    osDark: false,
  }),
  getters: {
    /** 解析后的模式：全应用「是否暗色」的唯一判据（驱动 data-theme） */
    themeMode(state): ThemeKind {
      const pref = state.settings.themeMode;
      if (pref === 'light' || pref === 'dark') return pref;
      return state.osDark ? 'dark' : 'light';
    },
    isDark(): boolean {
      return this.themeMode === 'dark';
    },
    /** 当前模式对应的配色 id（驱动 data-palette）：明暗各记各的，互不覆盖 */
    palette(state): ThemePalette {
      return this.themeMode === 'dark'
        ? state.settings.themePaletteDark || 'graphite'
        : state.settings.themePaletteLight || 'paper';
    },
    fontSize: (s) => s.settings.fontSize,
    editorMode: (s) => s.settings.editorMode,
  },
  actions: {
    async load() {
      this.initSystemTheme();
      try {
        const s = await getSettings();
        const merged = { ...DEFAULT_SETTINGS, ...s } as AppSettings;
        /* 旧配置迁移：本版之前只有 theme: 'light' | 'dark'，themeMode 为空字符串
           （Rust 侧 Default 给 ""）→ 按旧的 theme 落成手动模式，行为与升级前一致 */
        if (!merged.themeMode) merged.themeMode = merged.theme === 'dark' ? 'dark' : 'light';
        if (!merged.themePaletteLight) merged.themePaletteLight = 'paper';
        if (!merged.themePaletteDark) merged.themePaletteDark = 'graphite';
        this.settings = merged;
      } catch {
        this.settings = { ...DEFAULT_SETTINGS };
      }
      this.loaded = true;
      this.applyTheme();
    },
    async update(patch: Partial<AppSettings>) {
      this.settings = { ...this.settings, ...patch };
      /* ★ 只有真的改到这几项才写 <html>：applyTheme 动的是 documentElement 的
         data-theme / data-palette 与 --mk-font-size，哪怕值没变，属性一写整棵树的
         主题/字号样式就全部失效重算——预览类设置（浮块落位、显隐档、行号……）每改一次
         都白付一次全页面重排，拖动松手那一下还能把预览 iframe 的盒尺寸顶动，看起来就是闪一下 */
      const themePatch =
        'theme' in patch ||
        'themeMode' in patch ||
        'themePaletteLight' in patch ||
        'themePaletteDark' in patch;
      if (themePatch || 'fontSize' in patch) this.applyTheme();
      persist(this.settings);
    },
    /** 监听系统亮暗：仅在 system 模式下属「真变更」，需要重刷 <html> */
    initSystemTheme() {
      if (mq) return;
      try {
        mq = window.matchMedia('(prefers-color-scheme: dark)');
      } catch {
        mq = null;
        return;
      }
      this.osDark = mq.matches;
      const onChange = (e: MediaQueryListEvent) => {
        this.osDark = e.matches;
        if (this.settings.themeMode === 'system') this.applyTheme();
      };
      /* WebView2（Chromium 109+）走 addEventListener；旧内核回退 addListener */
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
      else (mq as MediaQueryList & { addListener(cb: (e: MediaQueryListEvent) => void): void }).addListener(onChange);
    },
    applyTheme() {
      const root = document.documentElement;
      /* 双属性：data-theme 只表达「明/暗」，data-palette 只表达「配色」。
         这样 codeTheme / CM 选区 / WangEditor 等 8 处 `theme === 'dark'` 硬判定、
         以及 md 内核的 :root[data-theme='dark'] 选择器全部不用改 */
      root.dataset.theme = this.themeMode;
      root.dataset.palette = this.palette;
      root.style.setProperty('--mk-font-size', `${this.settings.fontSize}px`);
      /* 旧字段跟随解析结果回写：回滚到旧版本时仍能读到一个正确的 light/dark */
      if (this.settings.theme !== this.themeMode) this.settings.theme = this.themeMode;
    },
  },
});
