import { defineStore } from 'pinia';
import { allowAssetDir } from '../api/imageApi';
import { createEntry, deleteEntry, listWorkspaceTree, moveEntry, renameEntry } from '../api/workspaceApi';
import { warmSearchCache } from '../api/searchApi';
import type { NodeKind, WorkspaceNode } from '../api/types';
import { useI18n } from '../i18n';
import { useEditorStore } from './editorStore';
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
        // 启动恢复走的就是这条路径，而 lastWorkspace/recents 本就是上一次写进去的值——
        // 值没变就不必再触发一次回写（省掉启动后 500ms 那次无意义落盘与全站重渲染）
        if (settings.settings.lastWorkspace !== dir || settings.settings.recentWorkspaces.join() !== recents.join()) {
          await settings.update({ lastWorkspace: dir, recentWorkspaces: recents });
        }
        // 后台建全文索引（预热 Office 正文缓存）：不 await，失败也不影响使用。
        // 冷缓存首次检索要解压全库 docx（实测 62s），提前跑一遍可把成本消化在打开阶段。
        // 但起跑时机挪到空闲：它在 Rust 侧按整库并行解压，正撞在窗口刚出来、
        // WebView 还在解析首屏 JS 的最敏感窗口期，等于自己跟自己抢 CPU。
        const warm = () => void warmSearchCache(dir).catch(() => {});
        if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 10000 });
        else setTimeout(warm, 4000);
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
    /** 一键展开：递归展开全部目录（折叠全部的反向操作，按钮循环切换用） */
    expandAll() {
      const next = new Set<string>();
      const walk = (node: WorkspaceNode | null): void => {
        if (!node || node.kind !== 'dir') return;
        next.add(node.path);
        for (const c of node.children ?? []) walk(c);
      };
      walk(this.tree);
      this.expanded = next;
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
      const newPath = path.replace(/[^\\/]+$/, newName);
      // 打开的标签跟随新路径（重命名目录时子文件按前缀一并跟随）；
      // 扩展名被改掉时内部会重算 kind，让引擎跟着换（md ⇄ txt ⇄ mh）
      await useTabsStore().retabPath(path, newPath);
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
      // 与移动同理：路径跟随先落定，刷新失败只报视图过期，不回滚标签路径
      try {
        await this.refresh();
      } catch (err) {
        const { t } = useI18n();
        const msg = err instanceof Error ? err.message : String(err);
        useEditorStore().showToast(t('filetree.renamedRefreshFailed', { msg }), 'error');
      }
    },
    async deleteEntry(path: string) {
      await deleteEntry(path);
      await this.refresh();
    },
    /** 拖拽移动：写盘成功后让已打开的标签、选中态、展开态一起跟着换路径。
     *  不跟随的话标签还指着旧路径，下一次保存会新建出一个同名文件（P0 级体验坑）。
     *  跟随必须排在刷新之前：刷新只是重画树，它失败（权限/目录被删）也不能
     *  把标签留在旧路径上——磁盘已经搬完了，视图过期远比路径错配安全。 */
    async moveEntry(path: string, targetDir: string) {
      const node = await moveEntry(path, targetDir);
      const sep = path.includes('\\') ? '\\' : '/';
      const newPath = node.path;
      // 与重命名同一条链路：目录被移动时，其下所有打开的文件按前缀一并跟随
      await useTabsStore().retabPath(path, newPath);
      this.expandDir(targetDir); // 展开目标目录，让用户看见移过去的条目
      const remap = (p: string): string => {
        if (p === path) return newPath;
        if (p.startsWith(path + sep)) return newPath + p.slice(path.length);
        return p;
      };
      if (this.selectedPath) this.selectedPath = remap(this.selectedPath);
      const nextExpanded = new Set<string>();
      for (const p of this.expanded) nextExpanded.add(remap(p));
      this.expanded = nextExpanded;
      try {
        await this.refresh();
      } catch (err) {
        const { t } = useI18n();
        const msg = err instanceof Error ? err.message : String(err);
        useEditorStore().showToast(t('filetree.movedRefreshFailed', { msg }), 'error');
      }
      return node;
    },
  },
});
