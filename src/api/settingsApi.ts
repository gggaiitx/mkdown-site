import { call } from './ipc';
import type { AppSettings } from './types';

export const getSettings = () => call<AppSettings>('get_settings');

export const setSettings = (settings: AppSettings) => call<void>('set_settings', { settings });

/** 系统已安装字体家族（去重排序）；失败时返回空数组，前端仍有默认/系统/自定义三项 */
export const listSystemFonts = () => call<string[]>('list_system_fonts');
