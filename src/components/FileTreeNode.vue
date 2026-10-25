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
import { computed } from 'vue';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { WorkspaceNode } from '../api/types';
import { fileKind, type FileKind } from '../utils/fileKind';
import { formatFileMetaFull, formatFileMtime, formatFileSize } from '../utils/fileMeta';
import { beginRowDrag, treeDnd } from '../utils/treeDnd';

const props = defineProps<{ node: WorkspaceNode; depth: number }>();

const emit = defineEmits<{
  (e: 'open-file', path: string): void;
  /** 双击：系统默认程序类文件由此打开（单击不动作，防误触外部程序） */
  (e: 'open-file-dbl', path: string): void;
  (e: 'ctx', ev: MouseEvent, node: WorkspaceNode): void;
}>();

const ws = useWorkspaceStore();
const settings = useSettingsStore();

/** 每层缩进：12px（原 16）。层级靠 caret + 图标已经能分清，缩进收紧后多出来的宽度留给文件名 */
const STEP_INDENT = 12;

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

// ---- 行末元信息（大小 / 修改时间）：两个独立开关，只对文件生效 ----
/** 目录不显示：目录 size/mtime 后端本来就没取，硬算要逐层 stat，打开大工作区会卡 */
const showSize = computed(() => !isDir && settings.settings.fileTreeShowSize);
const showMtime = computed(() => !isDir && settings.settings.fileTreeShowMtime);
const sizeText = computed(() => (showSize.value ? formatFileSize(props.node.size) : ''));
const mtimeText = computed(() => (showMtime.value ? formatFileMtime(props.node.mtimeMs) : ''));
/** 悬停提示：文件名 + 完整时间与精确大小。
 *  不再带「在编辑器中打开 / Word 文档」这类操作或类型描述——悬停一个文件名却提示
 *  "在编辑器中打开"是废话，还把真正有用的时间/大小挤到后面 */
const tip = computed(() => {
  const full = formatFileMetaFull(props.node.size, props.node.mtimeMs);
  return full ? `${props.node.name} · ${full}` : props.node.name;
});

// ---- 拖拽移动（pointer 自绘；Tauri 在 Windows 上拦掉了 HTML5 drag，见 utils/treeDnd.ts）----
/** 按下即进入待定态：位移超过阈值由 treeDnd 内部转为拖拽，松手落在目录行上才移动 */
function onRowPointerDown(e: PointerEvent): void {
  beginRowDrag(e, props.node);
}

/** 落点高亮 / 拖起自身变淡：模块级 ref 在模板里不会自动解包，统一在这里收成 computed */
const isDropTarget = computed(() => isDir && treeDnd.over.value === props.node.path);
const isDragging = computed(() => treeDnd.src.value === props.node.path);
</script>

<template>
  <!-- .node / .row 用 display:contents 抹平盒子：递归出来的三列 cell 直接成为 .tree-table 的 grid 项，
       同列共用列宽，跨层级才能对齐 -->
  <div class="node">
    <div
      v-if="isDir"
      class="row row--dir"
      :class="{ selected: ws.selectedPath === node.path, 'drop-target': isDropTarget, dragging: isDragging }"
      :data-path="node.path"
      @pointerdown="onRowPointerDown"
      @click="ws.toggleExpand(node.path)"
      @contextmenu="emit('ctx', $event, node)"
    >
      <div class="cell cell-name" :style="{ paddingLeft: `${depth * STEP_INDENT + 6}px` }">
        <span class="line">
          <ChevronRight v-if="!expanded()" class="caret" />
          <ChevronDown v-else class="caret" />
          <FolderOpen v-if="expanded()" class="f-icon f-icon--dir" />
          <Folder v-else class="f-icon f-icon--dir" />
          <span class="name">{{ node.name }}</span>
        </span>
      </div>
      <!-- 目录不显示元信息，但空 cell 必须占位，列结构才一致 -->
      <div class="cell cell-mtime" />
      <div class="cell cell-size" />
    </div>

    <div v-else
      class="row"
      :class="{ selected: ws.selectedPath === node.path, dragging: isDragging }"
      :data-path="node.path"
      @pointerdown="onRowPointerDown"
      v-tip="tip"
      @click="ws.select(node.path); emit('open-file', node.path)"
      @dblclick="emit('open-file-dbl', node.path)"
      @contextmenu="emit('ctx', $event, node)"
    >
      <div class="cell cell-name" :style="{ paddingLeft: `${depth * STEP_INDENT + 25}px` }">
        <span class="line">
          <component
            :is="kind === 'media' ? mediaIcon : icon"
            class="f-icon"
            :class="{ 'f-icon--md': kind === 'md' }"
          />
          <span class="name">{{ node.name }}</span>
        </span>
      </div>
      <div class="cell cell-mtime">{{ mtimeText }}</div>
      <div class="cell cell-size">{{ sizeText }}</div>
    </div>

    <template v-if="isDir && expanded()">
      <FileTreeNode
        v-for="child in node.children ?? []"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        @open-file="(p: string) => emit('open-file', p)"
        @open-file-dbl="(p: string) => emit('open-file-dbl', p)"
        @ctx="(ev, n) => emit('ctx', ev, n)"
      />
    </template>
  </div>
</template>

<script lang="ts">
export default { name: 'FileTreeNode' };
</script>

<style scoped>
/* ---- grid 行：三列（名字 / 时间 / 大小）共用列宽，元信息天然对齐 ---- */
/* display:contents 让递归容器不生成盒子，行里的三个 cell 直接成为 .tree-table 的 grid 项。
   行本身没有盒子，背景/透明度这类要盒子的样式统一落到 .cell 上 */
.node { display: contents; }
.row {
  display: contents;
  font-size: 12.5px;
  color: var(--mk-fg);
  cursor: pointer;
  user-select: none;
}
.row:hover .cell { background: var(--mk-hover); }
.row.selected .cell { background: var(--mk-accent-weak); }
/* 拖拽：源整行变淡表示"正在被搬走"；落点目录整行浅底 + 名字加重 */
.row.dragging .cell { opacity: 0.45; }
.row.drop-target .cell { background: var(--mk-accent-weak); }
.row.drop-target .name { font-weight: 600; }
.row.selected .name { color: var(--mk-fg); font-weight: 500; }

.cell {
  display: flex;
  align-items: center;
  height: 27px;
  white-space: nowrap;
  min-width: 0;
  padding: 0;
}
/* 缩进写在名字 cell 的 padding-left 上：名字列宽度由 grid 的 1fr 决定，
   缩进越深名字可用宽度越小，浅层行名字右侧留白——资源管理器的对齐方式 */
.line { display: flex; flex: 1 1 auto; align-items: center; gap: 6px; min-width: 0; }
/* 名字吃掉整列剩余宽度，超出就在紧贴元信息的位置省略（不设上限：宽侧栏下也贴着时间） */
.name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.caret { width: 13px; height: 13px; flex: none; color: var(--mk-fg-muted); }
.f-icon { width: 15px; height: 15px; flex: none; color: var(--mk-fg-muted); }
.f-icon--dir { color: var(--mk-warn); }
.f-icon--md { color: var(--mk-accent); opacity: 0.9; }
/* 元信息两列：宽度由本列最宽内容决定，右缘天然对齐（换字体也不会溢出） */
.cell-mtime {
  padding: 0 6px 0 0;
  justify-content: flex-end;
  color: var(--mk-fg-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}
.cell-size {
  padding: 0 10px 0 0;
  justify-content: flex-end;
  color: var(--mk-fg-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}
/* 只给有内容的时间留 12px 左距（空占位列不为目录行/关列时制造假间隔）；
   整列都空时连内距一起收掉，列宽才能塌成 0，名字直接顶到右缘 */
.cell-mtime:not(:empty) { padding-left: 12px; }
/* 时间列塌成 0 后，大小列要自己撑起与名字的间距（否则灰字贴死在名字后面） */
.cell-mtime:empty + .cell-size:not(:empty) { padding-left: 12px; }
.cell-mtime:empty,
.cell-size:empty { padding: 0; }
/* 悬停时整行提亮，元信息跟着起来，否则灰字在浅底上看着发虚 */
.row:hover .cell-mtime,
.row:hover .cell-size { opacity: 0.9; }
.row.selected .cell-mtime,
.row.selected .cell-size { opacity: 1; }
</style>
