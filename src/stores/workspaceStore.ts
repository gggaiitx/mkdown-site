import { defineStore } from 'pinia';
import { allowAssetDir } from '../api/imageApi';
import { createEntry, deleteEntry, listWorkspaceTree, renameEntry } from '../api/workspaceApi';
import { warmSearchCache } from '../api/searchApi';
import type { NodeKind, WorkspaceNode } from '../api/types';
import { useSettingsStore } from './settingsStore';
import { useTabsStore } from './tabsStore';

export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    root: null as string | null,
    tree: null as WorkspaceNode | null,
    expanded: new Set<string>(),
    selectedPath: null as string | null,
    loading: false,
  }),
  getters: {
    rootName: (s) => s.root?.split(/[\\/]/).pop() ?? '',
  },
  actions: {
    async openWorkspace(dir: string) {
      this.loading = true;
      try {
        await allowAssetDir(dir); // asset:// 运行时放行（ADR-05）
        this.tree = await listWorkspaceTree(dir);
        this.root = dir;
        this.expanded = new Set([dir]);
        const settings = useSettingsStore();
        // 历史工作区：最近在前、去重、上限 10（供树根目录名点击切换）
        const recents = [dir, ...settings.settings.recentWorkspaces.filter((d) => d !== dir)].slice(0, 10);
        await settings.update({ lastWorkspace: dir, recentWorkspaces: recents });
        // 后台建全文索引（预热 Office 正文缓存）：不 await，失败也不影响使用。
        // 冷缓存首次检索要解压全库 docx（实测 62s），提前跑一遍可把成本消化在打开阶段。
        void warmSearchCache(dir).catch(() => {});
      } finally {
        this.loading = false;
      }
    },
    /** 关闭当前工作区并清空历史列表（全部移除用）：回到欢迎页状态 */
    closeWorkspace() {
      this.root = null;
      this.tree = null;
      this.expanded = new Set();
      this.selectedPath = null;
      const settings = useSettingsStore();
      void settings.update({ lastWorkspace: null, recentWorkspaces: [] });
    },
    async refresh() {
      if (!this.root) return;
      this.tree = await listWorkspaceTree(this.root);
    },
    toggleExpand(path: string) {
      const next = new Set(this.expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      this.expanded = next;
    },
    /** 确保展开（不折叠已展开目录）：新建/联动定位用 */
    expandDir(path: string) {
      if (this.expanded.has(path)) return;
      const next = new Set(this.expanded);
      next.add(path);
      this.expanded = next;
    },
    /** 一键折叠：收起全部已展开目录（保留根，否则树区整体消失） */
    collapseAll() {
      this.expanded = new Set(this.root ? [this.root] : []);
    },
    expandTo(path: string) {
      const next = new Set(this.expanded);
      let dir = path.replace(/[\\/][^\\/]*$/, '');
      while (this.root && (dir.startsWith(this.root) || dir === this.root)) {
        next.add(dir);
        if (dir === this.root) break;
        dir = dir.replace(/[\\/][^\\/]*$/, '');
      }
      this.expanded = next;
    },
    select(path: string) {
      this.selectedPath = path;
    },
    async createEntry(parent: string, name: string, kind: NodeKind) {
      const node = await createEntry(parent, name, kind);
      await this.refresh();
      this.expandDir(parent); // 展开父目录露出新条目（不能 toggle，否则已展开的会被折叠）
      return node;
    },
    async renameEntry(path: string, newName: string) {
      await renameEntry(path, newName);
      await this.refresh();
      const newPath = path.replace(/[^\\/]+$/, newName);
      // 打开的标签跟随新路径（重命名目录时子文件按前缀一并跟随）
      useTabsStore().retabPath(path, newPath);
      // 树选中态与展开态跟随（避免重命名后引用旧路径失效）
      const sep = path.includes('\\') ? '\\' : '/';
      const remap = (p: string): string => {
        if (p === path) return newPath;
        if (p.startsWith(path + sep)) return newPath + p.slice(path.length);
        return p;
      };
      if (this.selectedPath) this.selectedPath = remap(this.selectedPath);
      const nextExpanded = new Set<string>();
      for (const p of this.expanded) nextExpanded.add(remap(p));
      this.expanded = nextExpanded;
    },
    async deleteEntry(path: string) {
      await deleteEntry(path);
      await this.refresh();
    },
  },
});
