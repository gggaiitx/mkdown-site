import { Channel } from '@tauri-apps/api/core';
import { call } from './ipc';
import type { SearchHit, SearchQuery } from './types';

/** 全文搜索：命中经 Channel 流式回调，Promise 返回命中总数 */
export function searchInFiles(query: SearchQuery, onHit: (hit: SearchHit) => void): Promise<number> {
  const channel = new Channel<SearchHit>();
  channel.onmessage = onHit;
  return call<number>('search_in_files', { query, onHit: channel });
}

/** 后台建索引（预热 Office 正文缓存），返回已缓存文档数 */
export function warmSearchCache(root: string): Promise<number> {
  return call<number>('warm_search_cache', { root });
}
