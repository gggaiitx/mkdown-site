<script setup lang="ts">
/** 文件树节点（递归组件）：lucide 图标 + 展开态文件夹高亮 */
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FileText,
  FileCode2,
  FileType2,
  FileSpreadsheet,
  Presentation,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  File,
} from '@lucide/vue';
import { useWorkspaceStore } from '../stores/workspaceStore';
import type { WorkspaceNode } from '../api/types';
import { fileKind, KIND_HINT, type FileKind } from '../utils/fileKind';

const props = defineProps<{ node: WorkspaceNode; depth: number }>();

const emit = defineEmits<{
  (e: 'open-file', path: string): void;
  (e: 'ctx', ev: MouseEvent, node: WorkspaceNode): void;
}>();

const ws = useWorkspaceStore();

const isDir = props.node.kind === 'dir';
const expanded = () => ws.expanded.has(props.node.path);
const kind: FileKind = isDir ? 'other' : fileKind(props.node.name);
/** 图标按类型分流：md 强调，其余沿用单色系 muted（设计 token 要求低饱和） */
const icon = {
  md: FileText,
  text: FileText,
  code: FileCode2,
  doc: FileType2,
  sheet: FileSpreadsheet,
  slide: Presentation,
  pdf: FileType2,
  image: FileImage,
  media: FileVideo,
  archive: FileArchive,
  other: File,
}[kind];
/** 音频单独用喇叭图标，其余媒体沿用播放器图标 */
const mediaIcon = /^(mp3|wav|ogg|flac)$/i.test(props.node.name.split('.').pop() ?? '')
  ? FileAudio
  : FileVideo;
const hint = isDir ? '' : KIND_HINT[kind];
</script>

<template>
  <div class="node">
    <div
      v-if="isDir"
      class="row row--dir"
      :class="{ selected: ws.selectedPath === node.path }"
      :style="{ paddingLeft: `${depth * 16 + 6}px` }"
      :data-path="node.path"
      @click="ws.toggleExpand(node.path)"
      @contextmenu="emit('ctx', $event, node)"
    >
      <ChevronRight v-if="!expanded()" class="caret" />
      <ChevronDown v-else class="caret" />
      <FolderOpen v-if="expanded()" class="f-icon f-icon--dir" />
      <Folder v-else class="f-icon f-icon--dir" />
      <span class="name">{{ node.name }}</span>
    </div>

    <div v-else
      class="row"
      :class="{ selected: ws.selectedPath === node.path }"
      :style="{ paddingLeft: `${depth * 16 + 25}px` }"
      :data-path="node.path"
      :data-tip="`${node.name} · ${hint}`"
      @click="ws.select(node.path); emit('open-file', node.path)"
      @contextmenu="emit('ctx', $event, node)"
    >
      <component
        :is="kind === 'media' ? mediaIcon : icon"
        class="f-icon"
        :class="{ 'f-icon--md': kind === 'md' }"
      />
      <span class="name">{{ node.name }}</span>
    </div>

    <template v-if="isDir && expanded()">
      <FileTreeNode
        v-for="child in node.children ?? []"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        @open-file="(p: string) => emit('open-file', p)"
        @ctx="(ev, n) => emit('ctx', ev, n)"
      />
    </template>
  </div>
</template>

<script lang="ts">
export default { name: 'FileTreeNode' };
</script>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 27px;
  padding-right: 10px;
  border-radius: var(--mk-radius-sm);
  font-size: 12.5px;
  color: var(--mk-fg);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.row:hover { background: var(--mk-hover); }
.row.selected { background: var(--mk-accent-weak); }
.row.selected .name { color: var(--mk-fg); font-weight: 500; }
.caret { width: 13px; height: 13px; flex: none; color: var(--mk-fg-muted); }
.f-icon { width: 15px; height: 15px; flex: none; color: var(--mk-fg-muted); }
.f-icon--dir { color: var(--mk-warn); }
.f-icon--md { color: var(--mk-accent); opacity: 0.9; }
.name { overflow: hidden; text-overflow: ellipsis; }
</style>
