import { defineStore } from 'pinia';
import { getSettings, setSettings } from '../api/settingsApi';
import { debounce } from '../utils/common';
import { DEFAULT_SETTINGS, type AppSettings } from '../api/types';
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

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    settings: { ...DEFAULT_SETTINGS } as AppSettings,
    loaded: false,
  }),
  getters: {
    isDark: (s) => s.settings.theme === 'dark',
    fontSize: (s) => s.settings.fontSize,
    editorMode: (s) => s.settings.editorMode,
  },
  actions: {
    async load() {
      try {
        const s = await getSettings();
        this.settings = { ...DEFAULT_SETTINGS, ...s };
      } catch {
        this.settings = { ...DEFAULT_SETTINGS };
      }
      this.loaded = true;
      this.applyTheme();
    },
    async update(patch: Partial<AppSettings>) {
      this.settings = { ...this.settings, ...patch };
      /* ★ 只有真的改到这两项才写 <html>：applyTheme 动的是 documentElement 的
         data-theme 与 --mk-font-size，哪怕值没变，属性一写整棵树的主题/字号样式就全部
         失效重算——预览类设置（浮块落位、显隐档、行号……）每改一次都白付一次全页面重排，
         拖动松手那一下还能把预览 iframe 的盒尺寸顶动，表现出来就是闪一下 */
      if ('theme' in patch || 'fontSize' in patch) this.applyTheme();
      persist(this.settings);
    },
    applyTheme() {
      document.documentElement.dataset.theme = this.settings.theme;
      document.documentElement.style.setProperty(
        '--mk-font-size',
        `${this.settings.fontSize}px`,
      );
    },
  },
});
