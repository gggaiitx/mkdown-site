/**
 * ★ 轻量 i18n：语言包按模块拆分（packs/*.ts，每文件同时含 zh/en 两份），
 * import.meta.glob 自动聚合——新增模块包零注册。
 *
 * 用法（组件 setup 内）：
 *   const { t } = useI18n();
 *   t('tab.close')                    // 基础用法
 *   t('app.docCount', { n: 3 })       // 插值：语言包里写 {n}
 *
 * 语言来源：settingsStore.settings.language（'zh-CN' | 'en-US'），
 * 渲染期读取（响应式），设置切换后所有用到 t 的模板自动重渲。
 * 回退链：当前语言 → zh-CN → key 本身（漏翻不至于显示空白，也便于发现漏项）。
 */
import { useSettingsStore } from '../stores/settingsStore';

type Dict = Record<string, unknown>;

const zh: Dict = {};
const en: Dict = {};

function deepMerge(target: Dict, src: Dict): void {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      deepMerge(target[k] as Dict, v as Dict);
    } else {
      target[k] = v;
    }
  }
}

// 聚合 packs/ 下全部模块包（eager：构建期内联，无运行时异步）
const mods = import.meta.glob('./packs/*.ts', { eager: true }) as Record<
  string,
  { default: { zh: Dict; en: Dict } }
>;
for (const path of Object.keys(mods).sort()) {
  const mod = mods[path]?.default;
  if (mod?.zh) deepMerge(zh, mod.zh);
  if (mod?.en) deepMerge(en, mod.en);
}

function lookup(dict: Dict, key: string): string | undefined {
  let cur: unknown = dict;
  for (const seg of key.split('.')) {
    if (cur && typeof cur === 'object' && seg in (cur as Dict)) {
      cur = (cur as Dict)[seg];
    } else {
      return undefined;
    }
  }
  return typeof cur === 'string' ? cur : undefined;
}

export function useI18n() {
  const settings = useSettingsStore();
  const t = (key: string, params?: Record<string, string | number>): string => {
    const dict = settings.settings.language === 'en-US' ? en : zh;
    let s = lookup(dict, key) ?? lookup(zh, key) ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        s = s.replaceAll(`{${k}}`, String(v));
      }
    }
    return s;
  };
  return { t };
}
