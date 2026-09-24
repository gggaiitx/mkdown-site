import { call } from './ipc';
import type { SavedImage } from './types';

export const savePastedImage = (docPath: string, dataBase64: string, ext: string) =>
  call<SavedImage>('save_pasted_image', { docPath, data: dataBase64, ext });

export const allowAssetDir = (dir: string) => call<void>('allow_asset_dir', { dir });
