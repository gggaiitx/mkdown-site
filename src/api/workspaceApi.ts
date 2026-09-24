import { call } from './ipc';
import type { NodeKind, WorkspaceNode } from './types';

export const listWorkspaceTree = (root: string, maxDepth?: number) =>
  call<WorkspaceNode>('list_workspace_tree', { root, maxDepth });

export const createEntry = (parent: string, name: string, kind: NodeKind) =>
  call<WorkspaceNode>('create_entry', { parent, name, kind });

export const renameEntry = (path: string, newName: string) =>
  call<WorkspaceNode>('rename_entry', { path, newName });

export const deleteEntry = (path: string) => call<void>('delete_entry', { path });
