import { defineStore } from 'pinia';
import { searchInFiles } from '../api/searchApi';
import type { SearchHit, SearchQuery } from '../api/types';
import { useWorkspaceStore } from './workspaceStore';

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
      this.hits = [];
      this.searching = true;
      this.lastQuery = this.query;
      const q: SearchQuery = {
        root: ws.root,
        query: this.query,
        caseSensitive: this.caseSensitive,
        isRegex: this.isRegex,
        includeGlob: this.includeGlob,
        maxResults: 2000,
      };
      try {
        this.total = await searchInFiles(q, (hit) => {
          this.hits.push(hit);
          // 防止超大结果把渲染打爆：前端最多展示 500 条
          if (this.hits.length >= 500) {
            this.searching = false;
          }
        });
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.searching = false;
      }
    },
    clear() {
      this.hits = [];
      this.total = 0;
      this.error = '';
    },
  },
});
