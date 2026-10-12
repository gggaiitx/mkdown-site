import { defineStore } from 'pinia';
import { searchInFiles } from '../api/searchApi';
import type { SearchHit, SearchQuery } from '../api/types';
import { useWorkspaceStore } from './workspaceStore';

/**
 * 搜索请求序号（P1-9）：Tauri Channel 不支持中止，连发搜索时旧搜索的流式回调
 * 必须凭序号判定过期并整体丢弃，否则旧结果继续 push 交错污染新 hits。
 */
let searchSeq = 0;

export const useSearchStore = defineStore('search', {
  state: () => ({
    visible: false,
    query: '',
    caseSensitive: false,
    isRegex: false,
    /** null = 全部可检索类型（Markdown / 文本 / Word / Excel / PPT）；'*.md' = 仅 Markdown */
    includeGlob: null as string | null,
    hits: [] as SearchHit[],
    searching: false,
    total: 0,
    error: '' as string,
    /** 去重后的文件分组视图用 */
    lastQuery: '',
  }),
  actions: {
    open() {
      this.visible = true;
    },
    close() {
      this.visible = false;
    },
    async run() {
      const ws = useWorkspaceStore();
      if (!ws.root) {
        this.error = '请先打开工作区';
        return;
      }
      if (!this.query.trim()) {
        this.error = '请输入搜索词';
        return;
      }
      this.error = '';
      const mySeq = ++searchSeq; // 先使旧搜索过期，再重置结果态
      this.hits = [];
      this.searching = true;
      this.lastQuery = this.query;
      // 攒批缓冲（P2-18）：Channel 回调不逐条 push（每次触发 Pinia 响应式更新，
      // 大结果时渲染抖动），暂存 pending 经 requestAnimationFrame 合并后一次性写入
      let pending: SearchHit[] = [];
      let flushRaf = 0;
      const flush = (): void => {
        flushRaf = 0;
        if (mySeq !== searchSeq) {
          pending = []; // 已过期：整批丢弃
          return;
        }
        if (pending.length > 0) {
          this.hits.push(...pending);
          pending = [];
        }
        // 防止超大结果把渲染打爆：前端最多展示 500 条
        if (this.hits.length >= 500) this.searching = false;
      };
      const q: SearchQuery = {
        root: ws.root,
        query: this.query,
        caseSensitive: this.caseSensitive,
        isRegex: this.isRegex,
        includeGlob: this.includeGlob,
        maxResults: 2000,
      };
      try {
        const total = await searchInFiles(q, (hit) => {
          if (mySeq !== searchSeq) return; // 过期搜索的回调：丢弃，不污染新结果
          if (this.hits.length + pending.length >= 500) {
            // 达到 500 上限后回调直接返回（Channel 无法中止，只能不再入队）；
            // 原实现仅置 searching=false、回调仍继续 push，hits 实际可涨到 2000
            this.searching = false;
            return;
          }
          pending.push(hit);
          if (!flushRaf) flushRaf = requestAnimationFrame(flush);
        });
        if (mySeq === searchSeq) this.total = total;
      } catch (e) {
        if (mySeq === searchSeq) {
          this.error = e instanceof Error ? e.message : String(e);
        }
      } finally {
        if (flushRaf) {
          cancelAnimationFrame(flushRaf);
          flushRaf = 0;
        }
        flush(); // 攒批收尾：未过期则写入剩余，过期则丢弃
        if (mySeq === searchSeq) this.searching = false;
      }
    },
    clear() {
      this.hits = [];
      this.total = 0;
      this.error = '';
    },
  },
});
