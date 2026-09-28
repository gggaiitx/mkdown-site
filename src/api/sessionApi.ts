import { call } from './ipc';

/**
 * 会话快照（session.json，结构由前端定义、Rust 侧 Value 透传）。
 * 用途：更新重启 / 应用崩溃 / 异常退出后恢复上次打开的标签页与未保存草稿。
 */
export interface SessionTabSnapshot {
  /** null = 未命名的新建文档（草稿内容必须随快照保存） */
  path: string | null;
  title: string;
  /** 'md' | 'text' | 'html' | 'docx' | 'xlsx' | 'image' */
  kind: string;
  mode: string;
  cursorLine: number;
  /** 脏标签的 content/savedContent 随快照保存；干净标签省略（恢复时读盘） */
  isDirty: boolean;
  content?: string;
  savedContent?: string;
}

export interface SessionSnapshot {
  version: 1;
  tabs: SessionTabSnapshot[];
  /** 活动标签在 tabs 数组中的下标；null = 无活动标签 */
  activeIndex: number | null;
}

export const getSession = () => call<SessionSnapshot | null>('get_session', {});

export const setSession = (snapshot: SessionSnapshot | null) =>
  call<void>('set_session', { snapshot });
