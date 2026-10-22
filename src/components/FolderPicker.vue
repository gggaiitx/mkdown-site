<script setup lang="ts">
/**
 * 应用内文件选择器：替代系统资源管理器对话框。
 * - open：选一个已有文件夹打开为工作区；
 * - create：新建工作区，名称与存放位置在同一界面填写，确认即在该位置下建目录；
 * - file：选一个已有文件（单击选中、双击直接打开）；
 * - save：选目录 + 填写文件名，确认后由调用方写入（覆盖前有明确提示）。
 */
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { ArrowUp, File as FileIcon, Folder } from '@lucide/vue';
import { browseDirs } from '../api/fileApi';
import type { DirBrowse, DirEntry } from '../api/types';
import { useI18n } from '../i18n';
import { useDialogClose } from '../composables/useDialogClose';
import { joinPath } from '../utils/pathJoin';

const { t } = useI18n();
const { maskCloses } = useDialogClose();

const props = withDefaults(
  defineProps<{
    visible: boolean;
    title: string;
    mode?: 'open' | 'create' | 'file' | 'save';
    /** 首次定位目录（也可传文件路径，后端落到父目录并预选）；为空时由后端给默认落点 */
    initialPath?: string;
    /** create 模式的初始名称；save 模式的默认文件名 */
    defaultName?: string;
    /** save 模式缺扩展名时补上的扩展名（不含点） */
    ext?: string;
    /** file 模式只列出这些扩展名（不含点）；为空则全部列出 */
    exts?: string[];
    /** 创建/保存请求进行中：主按钮禁用，避免重复提交 */
    busy?: boolean;
  }>(),
  { mode: 'open', initialPath: '', defaultName: '', ext: '', exts: () => [], busy: false },
);

const emit = defineEmits<{
  (e: 'select', path: string): void;
  (e: 'create', parent: string, name: string): void;
  (e: 'save', path: string): void;
  (e: 'cancel'): void;
}>();

const isCreate = computed(() => props.mode === 'create');
const isSave = computed(() => props.mode === 'save');
const isFile = computed(() => props.mode === 'file');
/** 文件/保存模式需要后端同时列出当前目录文件 */
const listsFiles = computed(() => isFile.value || isSave.value);

const current = ref('');
const parent = ref<string | null>(null);
const dirs = ref<DirEntry[]>([]);
const files = ref<DirEntry[]>([]);
const places = ref<DirEntry[]>([]);
const roots = ref<DirEntry[]>([]);
const truncated = ref(false);
const loading = ref(false);
const error = ref('');
const pathInput = ref('');
const name = ref('');
/** file 模式当前选中的文件 */
const selected = ref('');
/** 「显示隐藏项」开关；会话内保留上次选择，不写设置 */
const showHidden = ref(false);
/** 快速连点/反复改路径时只认最后一次请求：慢目录的旧响应不能覆盖新位置 */
let reqSeq = 0;

const titleId = useId();
const dialogRef = ref<HTMLElement | null>(null);
const pathRef = ref<HTMLInputElement | null>(null);
const nameRef = ref<HTMLInputElement | null>(null);
let restoreFocusTo: HTMLElement | null = null;

/* ---- 标题栏拖动 ----
   用窗口级监听而不是 pointer capture：指针掠过遮罩、离开对话框也能继续跟手。
   拖动结束后补发的那次 click 会落在遮罩上，需临时吞掉，否则一松手就把弹窗关了。 */
const dragOffset = ref({ x: 0, y: 0 });
const dragging = ref(false);
let drag: {
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  moved: boolean;
} | null = null;
let suppressMaskClick = false;

function onHeadPointerDown(e: PointerEvent) {
  const el = dialogRef.value;
  if (!el || e.button !== 0) return;
  if ((e.target as HTMLElement).closest('button')) return;
  const rect = el.getBoundingClientRect();
  const pad = 8;
  const baseX = dragOffset.value.x;
  const baseY = dragOffset.value.y;
  drag = {
    startX: e.clientX,
    startY: e.clientY,
    baseX,
    baseY,
    minX: pad - rect.left + baseX,
    maxX: window.innerWidth - pad - rect.right + baseX,
    minY: pad - rect.top + baseY,
    maxY: window.innerHeight - pad - rect.bottom + baseY,
    moved: false,
  };
  dragging.value = true;
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
  e.preventDefault();
}
function onDragMove(e: PointerEvent) {
  if (!drag) return;
  if (Math.abs(e.clientX - drag.startX) > 2 || Math.abs(e.clientY - drag.startY) > 2) {
    drag.moved = true;
  }
  const nx = drag.baseX + e.clientX - drag.startX;
  const ny = drag.baseY + e.clientY - drag.startY;
  dragOffset.value = {
    x: Math.min(Math.max(nx, drag.minX), drag.maxX),
    y: Math.min(Math.max(ny, drag.minY), drag.maxY),
  };
}
function stopDrag() {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  drag = null;
  dragging.value = false;
}
function onDragEnd() {
  if (!drag) return;
  const moved = drag.moved;
  stopDrag();
  if (moved) {
    suppressMaskClick = true;
    window.setTimeout(() => {
      suppressMaskClick = false;
    }, 0);
  }
}
function onMaskClick() {
  if (suppressMaskClick) {
    suppressMaskClick = false;
    return;
  }
  if (maskCloses()) emit('cancel');
}
const dialogStyle = computed(() => ({
  transform: `translate(${dragOffset.value.x}px, ${dragOffset.value.y}px)`,
}));

const trimmedName = computed(() => name.value.trim());
/** 保存模式：缺扩展名时补默认扩展名（已带扩展名的保持用户输入） */
const saveFileName = computed(() => {
  const n = trimmedName.value;
  if (!isSave.value || !n) return n;
  const ext = props.ext.replace(/^\./, '');
  if (!ext || /\.[^\\/]+$/.test(n)) return n;
  return `${n}.${ext}`;
});
/** 目标路径：create 补出待建目录；save 补出待写文件，让落点一眼可见。
 *  分隔符交由 joinPath 按基准目录形态决定——写死 `\` 在 mac/Linux 会把整个名字
 *  拼成「一个文件名」，另存为 / 导出会静默写错位置（见 utils/pathJoin.ts） */
const targetPath = computed(() => {
  const dir = current.value;
  if (!dir) return '';
  const leaf = isSave.value ? saveFileName.value : trimmedName.value;
  if (!leaf) return dir;
  return joinPath(dir, leaf);
});
const nameInvalid = computed(
  () => isSave.value && !!trimmedName.value && /[\\/:*?"<>|]/.test(trimmedName.value),
);
const nameIsDir = computed(() => {
  if (!isSave.value || !saveFileName.value) return false;
  const n = saveFileName.value.toLowerCase();
  return dirs.value.some((d) => d.name.toLowerCase() === n);
});
const overwrite = computed(() => {
  if (!isSave.value || !saveFileName.value || nameIsDir.value) return false;
  const n = saveFileName.value.toLowerCase();
  return files.value.some((f) => f.name.toLowerCase() === n);
});
const canSubmit = computed(() => {
  if (!current.value || loading.value || props.busy) return false;
  if (isCreate.value) return !!trimmedName.value;
  if (isSave.value) return !!saveFileName.value && !nameInvalid.value && !nameIsDir.value;
  if (isFile.value) return !!selected.value;
  return true;
});
const footText = computed(() => {
  if (!current.value) return '';
  if (isCreate.value) return t('workbench.wsCreate.willCreate', { path: targetPath.value });
  if (isSave.value) return t('workbench.folderPicker.willSave', { path: targetPath.value });
  if (isFile.value) {
    return selected.value
      ? t('workbench.folderPicker.willOpen', { path: selected.value })
      : t('workbench.folderPicker.pickFileHint');
  }
  return t('workbench.folderPicker.willSelect', { path: current.value });
});
const primaryText = computed(() => {
  if (isCreate.value) return t('workbench.wsCreate.confirm');
  if (isSave.value) return overwrite.value ? t('workbench.folderPicker.replace') : t('workbench.folderPicker.save');
  if (isFile.value) return t('workbench.folderPicker.open');
  return t('workbench.folderPicker.select');
});
/** 扩展名过滤（file 模式）：比较扩展名而非整名，避免把目录名误判成文件 */
function matchesExt(name: string): boolean {
  const wanted = props.exts.map((e) => e.replace(/^\./, '').toLowerCase());
  if (!wanted.length) return true;
  const m = /\.([^\\/.]+)$/.exec(name);
  return !!m && wanted.includes(m[1].toLowerCase());
}
const hiddenCount = computed(
  () =>
    dirs.value.filter((d) => d.hidden).length +
    files.value.filter((f) => f.hidden && matchesExt(f.name)).length,
);
const visibleDirs = computed(() =>
  showHidden.value ? dirs.value : dirs.value.filter((d) => !d.hidden),
);
const visibleFiles = computed(() =>
  files.value.filter((f) => (showHidden.value || !f.hidden) && matchesExt(f.name)),
);
const nothingToList = computed(
  () => !visibleDirs.value.length && (!listsFiles.value || !visibleFiles.value.length),
);
const emptyText = computed(() => {
  if (!showHidden.value && hiddenCount.value) {
    return t(
      listsFiles.value
        ? 'workbench.folderPicker.emptyHiddenItems'
        : 'workbench.folderPicker.emptyHidden',
      { n: hiddenCount.value },
    );
  }
  if (listsFiles.value) return t('workbench.folderPicker.emptyFiles');
  return t('workbench.folderPicker.empty');
});
const showHiddenText = computed(() =>
  listsFiles.value
    ? t('workbench.folderPicker.showHiddenFiles')
    : t('workbench.folderPicker.showHidden'),
);
const truncatedText = computed(() =>
  t(
    listsFiles.value
      ? 'workbench.folderPicker.truncatedItems'
      : 'workbench.folderPicker.truncated',
    { n: dirs.value.length + files.value.length },
  ),
);
const nameError = computed(() => {
  if (nameInvalid.value) return t('workbench.folderPicker.invalidName');
  if (nameIsDir.value) return t('workbench.folderPicker.nameIsDir');
  return '';
});

const placeLabels = computed<Record<string, string>>(() => ({
  home: t('workbench.folderPicker.placeHome'),
  documents: t('workbench.folderPicker.placeDocuments'),
  desktop: t('workbench.folderPicker.placeDesktop'),
  downloads: t('workbench.folderPicker.placeDownloads'),
}));
const placeLabel = (p: DirEntry) => placeLabels.value[p.kind ?? ''] ?? p.name;

function apply(res: DirBrowse) {
  current.value = res.path;
  parent.value = res.parent;
  dirs.value = res.dirs;
  files.value = res.files;
  selected.value = res.selected ?? '';
  places.value = res.places;
  roots.value = res.roots;
  truncated.value = res.truncated;
  pathInput.value = res.path;
  if (isSave.value && res.selected) {
    name.value = res.selected.split(/[\\/]/).pop() ?? name.value;
  }
  error.value = '';
}

async function load(path?: string) {
  const seq = ++reqSeq;
  loading.value = true;
  error.value = '';
  try {
    const res = await browseDirs(path, listsFiles.value, isSave.value);
    if (seq !== reqSeq) return;
    apply(res);
  } catch (err) {
    if (seq !== reqSeq) return;
    const msg = err instanceof Error ? err.message : String(err);
    // 带上目标路径：IPC 层把 NOT_FOUND 之类收敛成了通用文案，
    // 不说明「哪个目录」的话用户只看到一句「路径不存在」
    error.value = path
      ? t('workbench.folderPicker.openFailed', { path, msg })
      : msg;
    pathInput.value = current.value; // 无效输入退回当前目录，别让路径栏与列出的内容对不上
  } finally {
    if (seq === reqSeq) loading.value = false;
  }
}

/** 首次定位：给定目录打不开（上次工作区被删/无权限）时静默退回默认落点 */
async function loadInitial() {
  const from = props.initialPath.trim();
  if (from) {
    const seq = ++reqSeq;
    loading.value = true;
    error.value = '';
    try {
      const res = await browseDirs(from, listsFiles.value, isSave.value);
      if (seq !== reqSeq) return;
      apply(res);
      loading.value = false;
      return;
    } catch {
      if (seq !== reqSeq) return;
    }
  }
  await load();
}

/** 单击进入子目录：220ms 内的后续点击忽略——用户习惯性双击时，
 *  第二下会落到刷新后的新列表同一坐标，容易连跳两层 */
let rowClickLock = 0;
function goRow(path: string) {
  const now = performance.now();
  if (now < rowClickLock) return;
  rowClickLock = now + 220;
  void load(path);
}
function go(path: string) {
  void load(path);
}
/** 文件行：单击选中（保存模式下是填进文件名框，便于覆盖已有文件） */
function pickFile(entry: DirEntry) {
  if (isSave.value) name.value = entry.name;
  else selected.value = entry.path;
}
/** 双击文件行：直接打开 / 直接保存 */
function openFile(entry: DirEntry) {
  pickFile(entry);
  submit();
}
/** 文件行高亮：保存模式跟文件名框联动，文件模式跟选中项联动（Windows 路径忽略大小写） */
function isFileOn(entry: DirEntry): boolean {
  if (isSave.value) return !!saveFileName.value && saveFileName.value.toLowerCase() === entry.name.toLowerCase();
  const norm = (p: string) => p.replaceAll('/', '\\').toLowerCase();
  return !!selected.value && norm(selected.value) === norm(entry.path);
}
function goUp() {
  if (parent.value) void load(parent.value);
}
function submitPath() {
  const p = pathInput.value.trim();
  if (!p) return;
  // 只输盘符（C:）时补根分隔符，否则后端按相对路径拒绝
  void load(/^[a-zA-Z]:$/.test(p) ? `${p}\\` : p);
}
function onPathEnter(e: KeyboardEvent) {
  if (e.isComposing) return; // 中文输入法回车是上屏，不是提交
  e.preventDefault();
  submitPath();
}

/** 快捷位置高亮：忽略尾部分隔符与大小写（Windows 盘符） */
function isHere(path: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  return !!current.value && norm(path) === norm(current.value);
}

function onNameEnter(e: KeyboardEvent) {
  if (e.isComposing) return; // 输入法回车是上屏，不是提交
  e.preventDefault();
  submit();
}

function submit() {
  if (!canSubmit.value) return;
  if (isCreate.value) emit('create', current.value, trimmedName.value);
  else if (isSave.value) emit('save', targetPath.value);
  else if (isFile.value) emit('select', selected.value);
  else emit('select', current.value);
}

/* ---- 键盘：Esc 关闭、Tab 在框内循环（与 AppDialog 同一套口径） ---- */
function onKey(e: KeyboardEvent) {
  if (e.isComposing) return;
  if (e.key === 'Escape') {
    e.stopPropagation();
    emit('cancel');
  } else if (e.key === 'Tab') {
    trapTab(e);
  }
}
function trapTab(e: KeyboardEvent) {
  const items = dialogRef.value?.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
  );
  if (!items?.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === dialogRef.value)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true));

watch(
  () => props.visible,
  async (v) => {
    if (v) {
      restoreFocusTo = document.activeElement as HTMLElement | null;
      stopDrag();
      dragOffset.value = { x: 0, y: 0 };
      current.value = '';
      parent.value = null;
      dirs.value = [];
      files.value = [];
      selected.value = '';
      places.value = [];
      roots.value = [];
      truncated.value = false;
      error.value = '';
      loading.value = true;
      pathInput.value = props.initialPath;
      name.value = props.defaultName;
      document.addEventListener('keydown', onKey, true);
      void loadInitial();
      await nextTick();
      if (isCreate.value || isSave.value) {
        nameRef.value?.focus();
        nameRef.value?.select();
      } else {
        pathRef.value?.focus();
        pathRef.value?.select();
      }
    } else {
      reqSeq++;
      stopDrag();
      document.removeEventListener('keydown', onKey, true);
      restoreFocusTo?.focus?.();
      restoreFocusTo = null;
    }
  },
);
</script>

<template>
  <div v-if="visible" class="mask fp-mask" @click.self="onMaskClick">
    <div
      ref="dialogRef"
      class="fp"
      :class="{ create: isCreate, dragging }"
      :style="dialogStyle"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      tabindex="-1"
    >
      <div class="fp-head" @pointerdown="onHeadPointerDown">
        <div :id="titleId" class="fp-title">{{ title }}</div>
        <button
          type="button"
          class="fp-close"
          :title="t('dialog.close')"
          :aria-label="t('dialog.close')"
          @click="emit('cancel')"
        >
          ×
        </button>
      </div>

      <div v-if="isCreate || isSave" class="fp-name">
        <span class="fp-name-label">
          {{ isSave ? t('workbench.folderPicker.fileName') : t('workbench.wsCreate.nameLabel') }}
        </span>
        <input
          ref="nameRef"
          v-model="name"
          class="fp-name-ipt"
          :placeholder="isSave
            ? t('workbench.folderPicker.fileNamePlaceholder')
            : t('workbench.wsCreate.placeholder')"
          spellcheck="false"
          @keydown.enter="onNameEnter"
        />
      </div>
      <div v-if="nameError" class="fp-name-err">{{ nameError }}</div>
      <div v-else-if="overwrite" class="fp-name-warn">
        {{ t('workbench.folderPicker.overwriteHint') }}
      </div>

      <div class="fp-nav">
        <button
          type="button"
          class="fp-icon-btn"
          :disabled="!parent"
          :title="t('workbench.folderPicker.up')"
          :aria-label="t('workbench.folderPicker.up')"
          @click="goUp"
        >
          <ArrowUp />
        </button>
        <input
          ref="pathRef"
          v-model="pathInput"
          class="fp-path"
          :placeholder="t('workbench.folderPicker.pathPlaceholder')"
          spellcheck="false"
          @keydown.enter="onPathEnter"
        />
      </div>

      <div v-if="error" class="fp-error">{{ error }}</div>

      <div class="fp-main">
        <div class="fp-side">
          <div class="fp-side-scroll">
            <template v-if="places.length">
              <div class="fp-side-title">{{ t('workbench.folderPicker.places') }}</div>
              <button
                v-for="p in places"
                :key="p.path"
                type="button"
                class="fp-side-btn"
                :class="{ on: isHere(p.path) }"
                :title="p.path"
                @click="go(p.path)"
              >
                {{ placeLabel(p) }}
              </button>
            </template>
            <div class="fp-side-title">{{ t('workbench.folderPicker.roots') }}</div>
            <button
              v-for="r in roots"
              :key="r.path"
              type="button"
              class="fp-side-btn"
              :class="{ on: isHere(r.path) }"
              :title="r.path"
              @click="go(r.path)"
            >
              {{ r.name }}
            </button>
          </div>
          <label class="fp-hidden">
            <span class="fp-hidden-txt">{{ showHiddenText }}</span>
            <input v-model="showHidden" type="checkbox" class="fp-hidden-ipt" />
            <span class="fp-switch" aria-hidden="true"></span>
          </label>
        </div>

        <div class="fp-list">
          <div v-if="loading && !current" class="fp-state">{{ t('workbench.folderPicker.loading') }}</div>
          <div v-else-if="nothingToList" class="fp-state">{{ emptyText }}</div>
          <template v-else>
            <button
              v-for="d in visibleDirs"
              :key="d.path"
              type="button"
              class="fp-row"
              :class="{ dim: d.hidden }"
              :title="d.path"
              @click="goRow(d.path)"
            >
              <Folder class="fp-ic" />
              <span class="fp-name">{{ d.name }}</span>
            </button>
            <button
              v-for="f in visibleFiles"
              :key="f.path"
              type="button"
              class="fp-row fp-file"
              :class="{ dim: f.hidden, on: isFileOn(f) }"
              :title="f.path"
              @click="pickFile(f)"
              @dblclick="openFile(f)"
            >
              <FileIcon class="fp-ic" />
              <span class="fp-name">{{ f.name }}</span>
            </button>
            <div v-if="truncated" class="fp-state">{{ truncatedText }}</div>
          </template>
        </div>
      </div>

      <div class="fp-foot">
        <div class="fp-current" :title="targetPath">{{ footText }}</div>
        <button type="button" class="fp-btn" @click="emit('cancel')">{{ t('dialog.cancel') }}</button>
        <button type="button" class="fp-btn primary" :disabled="!canSubmit" @click="submit">
          {{ primaryText }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: var(--mk-z-dialog);
  background: var(--mk-mask);
  display: flex;
  align-items: center;
  justify-content: center;
}
.fp {
  width: 640px;
  max-width: 92vw;
  height: min(480px, 82vh);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  background: var(--mk-panel);
  color: var(--mk-fg);
  border: 1px solid var(--mk-border);
  border-radius: 10px;
  box-shadow: var(--mk-shadow-dialog);
  padding: 16px;
}
.fp.create {
  height: min(540px, 86vh);
}
.fp:focus {
  outline: none;
}
.fp-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin: -6px -6px 4px;
  padding: 6px;
  border-radius: 8px 8px 0 0;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.fp.dragging .fp-head {
  cursor: grabbing;
}
.fp.dragging {
  user-select: none;
}
.fp-title {
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
}
.fp-close {
  flex: none;
  margin: -2px -2px 0 0;
  padding: 0 2px;
  border: none;
  background: transparent;
  color: var(--mk-fg-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.fp-close:hover {
  color: var(--mk-fg);
}
.fp-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.fp-name-label {
  flex: none;
  font-size: 13px;
  color: var(--mk-fg-muted);
}
.fp-name-ipt {
  flex: 1;
  min-width: 0;
  height: 32px;
  box-sizing: border-box;
  border: 1px solid var(--mk-border);
  border-radius: 7px;
  background: var(--mk-bg);
  color: var(--mk-fg);
  padding: 0 10px;
  font-size: 13px;
  outline: none;
}
.fp-nav {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}
.fp-icon-btn {
  width: 32px;
  height: 32px;
  flex: none;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--mk-border);
  border-radius: 7px;
  background: var(--mk-bg);
  color: var(--mk-fg);
  cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease;
}
.fp-icon-btn svg {
  width: 16px;
  height: 16px;
}
.fp-icon-btn:hover:not(:disabled) {
  background: var(--mk-hover);
  border-color: var(--mk-border-strong);
}
.fp-icon-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.fp-path {
  flex: 1;
  min-width: 0;
  height: 32px;
  box-sizing: border-box;
  border: 1px solid var(--mk-border);
  border-radius: 7px;
  background: var(--mk-bg);
  color: var(--mk-fg);
  padding: 0 10px;
  font-size: 13px;
  outline: none;
}
/* 名称框与路径框共用同一套悬停/聚焦态：边框提亮 + 一圈弱墨色光环，避免两处各写一份走样 */
.fp-name-ipt,
.fp-path {
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.fp-name-ipt:hover,
.fp-path:hover {
  border-color: var(--mk-border-strong);
}
.fp-name-ipt:focus,
.fp-path:focus {
  border-color: var(--mk-accent);
  box-shadow: 0 0 0 3px var(--mk-accent-weak);
}
.fp-error {
  margin: -2px 0 8px;
  font-size: 12px;
  color: var(--mk-danger);
  overflow-wrap: anywhere;
}
.fp-name-err {
  margin: -4px 0 8px;
  font-size: 12px;
  color: var(--mk-danger);
}
.fp-name-warn {
  margin: -4px 0 8px;
  font-size: 12px;
  color: var(--mk-fg-muted);
}
.fp-main {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 10px;
}
.fp-side {
  width: 148px;
  flex: none;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--mk-bg);
  border: 1px solid var(--mk-border);
  border-radius: 6px;
  padding: 4px;
}
.fp-side-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.fp-side-title {
  padding: 8px 8px 4px;
  font-size: 11px;
  color: var(--mk-fg-muted);
}
.fp-side-btn {
  display: block;
  width: 100%;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--mk-fg);
  padding: 6px 8px;
  font-size: 13px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.fp-side-btn:hover {
  background: var(--mk-hover);
}
.fp-side-btn.on {
  background: var(--mk-active);
  font-weight: 600;
}
/* 「显示隐藏文件夹」：钉在左栏底部，不随位置列表滚动 */
.fp-hidden {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
  padding: 8px 6px 4px;
  border-top: 1px solid var(--mk-border);
  color: var(--mk-fg-muted);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.fp-hidden-txt {
  white-space: nowrap;
}
.fp-hidden-ipt {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  opacity: 0;
  pointer-events: none;
}
.fp-switch {
  position: relative;
  flex: none;
  width: 28px;
  height: 16px;
  border-radius: 999px;
  background: var(--mk-border-strong);
  transition: background-color 160ms ease;
}
.fp-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--mk-panel);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.18);
  transition: transform 160ms ease;
}
.fp-hidden-ipt:checked + .fp-switch {
  background: var(--mk-accent);
}
.fp-hidden-ipt:checked + .fp-switch::after {
  transform: translateX(12px);
}
.fp-hidden-ipt:focus-visible + .fp-switch {
  outline: var(--mk-focus-ring);
  outline-offset: 2px;
}
.fp-list {
  flex: 1;
  min-width: 0;
  overflow: auto;
  background: var(--mk-bg);
  border: 1px solid var(--mk-border);
  border-radius: 6px;
  padding: 4px;
}
.fp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--mk-fg);
  padding: 6px 8px;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.fp-row:hover {
  background: var(--mk-hover);
}
.fp-row.on {
  background: var(--mk-active);
}
/* 开关打开后隐藏目录仍可辨认：压暗一档，悬停回亮 */
.fp-row.dim {
  opacity: 0.55;
}
.fp-row.dim:hover {
  opacity: 0.85;
}
.fp-ic {
  width: 15px;
  height: 15px;
  flex: none;
  color: var(--mk-fg-muted);
}
.fp-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fp-state {
  padding: 16px 8px;
  font-size: 13px;
  color: var(--mk-fg-muted);
  text-align: center;
}
.fp-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.fp-current {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--mk-fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fp-btn {
  min-width: 72px;
  border: 1px solid var(--mk-border);
  border-radius: 6px;
  background: var(--mk-bg);
  color: var(--mk-fg);
  padding: 6px 16px;
  font-size: 13px;
  cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease;
}
.fp-btn:hover:not(:disabled) {
  background: var(--mk-hover);
  border-color: var(--mk-border-strong);
}
.fp-btn:active:not(:disabled) {
  background: var(--mk-active);
}
.fp-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.fp-btn.primary {
  background: var(--mk-accent);
  border-color: var(--mk-accent);
  color: var(--mk-accent-fg);
  font-weight: 600;
}
.fp-btn.primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--mk-accent) 86%, var(--mk-accent-fg));
}
.fp-btn.primary:active:not(:disabled) {
  background: color-mix(in srgb, var(--mk-accent) 76%, var(--mk-accent-fg));
}
.fp-icon-btn:focus-visible,
.fp-side-btn:focus-visible,
.fp-row:focus-visible,
.fp-btn:focus-visible {
  outline: var(--mk-focus-ring);
  outline-offset: 1px;
}
.fp-row:focus-visible {
  outline-offset: -2px;
}
</style>
