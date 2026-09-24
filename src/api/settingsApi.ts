import { call } from './ipc';
import type { AppSettings } from './types';

export const getSettings = () => call<AppSettings>('get_settings');

export const setSettings = (settings: AppSettings) => call<void>('set_settings', { settings });
