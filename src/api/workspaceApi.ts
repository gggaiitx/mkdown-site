import { call } from './ipc';
import type { NodeKind, WorkspaceNode } from './types';

export const listWorkspaceTree = (root: string, maxDepth?: number) =>
  call<WorkspaceNode>('list_workspace_tree', { root, maxDepth });

export const createEntry = (parent: string, name: string, kind: NodeKind) =>
  call<WorkspaceNode>('create_entry', { parent, name, kind });

/** 新建工作区目录（弹窗里确认的位置视同授权），返回新目录路径 */
export const createWorkspaceDir = (parent: string, name: string) =>
  call<string>('create_workspace', { parent, name });

/** 「新建工作区」弹窗的默认存放位置（文档目录 → 用户主目录） */
export const getDefaultWorkspaceParent = () => call<string | null>('default_workspace_parent');

export const renameEntry = (path: string, newName: string) =>
  call<WorkspaceNode>('rename_entry', { path, newName });

/** 移动条目到目标目录（文件树拖拽）：同卷 rename，跨卷后端会复制后删源 */
export const moveEntry = (path: string, targetDir: string) =>
  call<WorkspaceNode>('move_entry', { path, targetDir });

export const deleteEntry = (path: string) => call<void>('delete_entry', { path });
