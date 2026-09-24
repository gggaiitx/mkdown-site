import { defineStore } from 'pinia';
import { getSettings, setSettings } from '../api/settingsApi';
import { debounce } from '../utils/common';
import { DEFAULT_SETTINGS, type AppSettings } from '../api/types';

const persist = debounce((s: AppSettings) => {
  void setSettings(s).catch(() => {
    /* 回写失败不阻塞 UI，下次变更会重试 */
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
      this.applyTheme();
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
