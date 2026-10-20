<script setup lang="ts">
/**
 * Word 反转「转换操作页面」（R3/R4，docs/plan-word-convert.md §9.2；2026-10-13 交互升级）。
 * 模态，复用 AppDialog 视觉规范。状态机：idle（拖入/选择文件）→ converting（进度条）
 * → done（摘要 + 预览 + 操作）/ error（失败原因 + 重新选择）。
 * - idle 态拖拽：Tauri v2 拦截原生 HTML5 DnD，必须走 onDragDropEvent（Workbench 全局
 *   处理器在弹窗打开时让位，见 Workbench.onDragDrop 守卫）；监听随 visible 生命周期挂摘。
 * - 文件授权：选/拖入的 docx 目录经 allowAssetDir 双授权（asset:// 读字节 + fs 白名单
 *   图片落盘），工作区外文件整链可用；落盘失败仍走 data: URL 内联降级（D4）。
 * - 完成态给摘要（字符数/图片落盘与内联计数/耗时/零提取警示 V11）+ 前 2000 字符
 *   纯文本预览（D7）+ 两操作：直接保存（V5 初始目录=docx 同目录）/ 转换后打开
 *   （draftPath 意向路径 + 标题冠来源 V6）。
 * 并发语义（V3）：转换中关闭 = 放弃本次转换；转换中重复选择文件忽略。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { FileUp } from '@lucide/vue';
import { useI18n } from '../i18n';
import { saveAs as saveAsApi, pickOpenFile } from '../api/fileApi';
import { allowAssetDir } from '../api/imageApi';
import { useTabsStore } from '../stores/tabsStore';
import { useEditorStore } from '../stores/editorStore';
import { useSettingsStore } from '../stores/settingsStore';
import { docxToMd } from '../convert/docxToMd';
import { docxToMh } from '../convert/docxToMh';
import { docxToMhFidelity } from '../convert/docxPreviewToMh';
import type { ImageSaveStats } from '../convert/mammothImages';

const props = defineProps<{
  visible: boolean;
  /** 预设源 docx 路径（激活标签为 docx 预览时直转；空 = 从拖拽/选择开始） */
  sourcePath: string;
  /** 转换目标 */
  target: 'md' | 'mh';
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const { t } = useI18n();
const tabs = useTabsStore();
const editor = useEditorStore();
const settings = useSettingsStore();

type Phase = 'idle' | 'converting' | 'done' | 'error';
const phase = ref<Phase>('idle');
/** 本次转换的源 docx 路径（选/拖入或预设） */
const srcPath = ref('');
const content = ref('');
const textLength = ref(0);
const images = ref<ImageSaveStats>({ saved: 0, inline: 0 });
const warnings = ref<string[]>([]);
const errMsg = ref('');
const durationMs = ref(0);
/** 拖拽悬停高亮（仅 idle 态消费） */
const dragActive = ref(false);

const sourceName = computed(() => srcPath.value.split(/[\\/]/).pop() ?? srcPath.value);
const sourceDir = computed(() => srcPath.value.replace(/[\\/][^\\/]*$/, ''));
const stem = computed(() => sourceName.value.replace(/\.[^.]*$/, ''));
const ext = computed(() => (props.target === 'mh' ? 'mh' : 'md'));
/** 意向路径（§6.5）：docx 同目录的 xxx.md/xxx.mh，文件尚未创建 */
const draftPath = computed(() =>
  sourceDir.value ? `${sourceDir.value}\\${stem.value}.${ext.value}` : null,
);
const title = computed(() => `${sourceName.value} → ${props.target}`);
const previewText = computed(() => content.value.slice(0, 2000));
const zeroExtraction = computed(() => phase.value === 'done' && textLength.value === 0);
const titleText = computed(() =>
  props.target === 'mh' ? t('workbench.wordConvert.titleMh') : t('workbench.wordConvert.titleMd'),
);

function resetResult() {
  phase.value = 'idle';
  srcPath.value = '';
  content.value = '';
  textLength.value = 0;
  images.value = { saved: 0, inline: 0 };
  warnings.value = [];
  errMsg.value = '';
  durationMs.value = 0;
}

/** 选定文件（预设 / 点击选择 / 拖入共用）：授权目录 → 开始转换 */
async function useFile(p: string) {
  if (phase.value === 'converting') return; // 转换中忽略重复选择
  srcPath.value = p;
  const dir = p.replace(/[\\/][^\\/]*$/, '');
  if (dir) void allowAssetDir(dir).catch(() => undefined);
  await startConvert();
}

/** 转换主流程：md = word-to-markdown-js；mh = 语义(mammoth)/高保真(docx-preview) 按设置分流 */
async function startConvert() {
  if (!srcPath.value || phase.value === 'converting') return;
  phase.value = 'converting';
  content.value = '';
  textLength.value = 0;
  images.value = { saved: 0, inline: 0 };
  warnings.value = [];
  errMsg.value = '';
  const started = performance.now();
  try {
    if (props.target === 'mh') {
      const r =
        settings.settings.wordImportFidelity === 'fidelity'
          ? await docxToMhFidelity(srcPath.value)
          : await docxToMh(srcPath.value);
      content.value = r.mh;
      textLength.value = r.textLength;
      images.value = r.images;
      warnings.value = r.warnings;
    } else {
      const r = await docxToMd(srcPath.value);
      content.value = r.md;
      textLength.value = r.textLength;
      images.value = r.images;
      warnings.value = r.warnings;
    }
    durationMs.value = Math.round(performance.now() - started);
    phase.value = 'done';
  } catch (err) {
    errMsg.value = err instanceof Error ? err.message : String(err);
    phase.value = 'error';
  }
}

// ---- 文件拖入（Tauri 原生事件；随弹窗 visible 挂摘） ----
let unlistenDrop: (() => void) | null = null;

async function bindDrop() {
  if (unlistenDrop) return;
  try {
    unlistenDrop = await getCurrentWebviewWindow().onDragDropEvent(onDragEvent);
  } catch {
    /* 非 Tauri 环境（浏览器/无头验证）无此事件，忽略 */
  }
}

function unbindDrop() {
  unlistenDrop?.();
  unlistenDrop = null;
  dragActive.value = false;
}

function onDragEvent(ev: { payload: { type: string; paths?: string[] | null } }) {
  if (phase.value !== 'idle') return; // 转换中/完成后不再响应拖拽
  const type = ev.payload.type;
  if (type === 'enter' || type === 'over') {
    dragActive.value = true;
    return;
  }
  if (type === 'leave') {
    dragActive.value = false;
    return;
  }
  if (type === 'drop') {
    dragActive.value = false;
    const paths = (ev.payload.paths ?? []).filter((p) => /\.docx$/i.test(p));
    if (!paths.length) {
      editor.showToast(t('workbench.wordConvert.notDocx'), 'error');
      return;
    }
    void useFile(paths[0]);
  }
}

/** 点击拖拽区 / 选择按钮：系统对话框（.docx 过滤） */
async function onPickClick() {
  try {
    const p = await pickOpenFile(['docx'], 'Word');
    if (p) void useFile(p);
  } catch (err) {
    editor.showToast(err instanceof Error ? err.message : String(err), 'error');
  }
}

/** 失败/完成后重选：回到拖拽区 */
function backToPick() {
  resetResult();
  void bindDrop();
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      // Esc 走 document：@keydown 挂在不可聚焦的 .mask 上时，焦点还留在调用处，
      // 按键冒泡不经过遮罩 → 键盘关不掉（与 AppDialog 同修）
      document.addEventListener('keydown', onKey, true);
      resetResult();
      // 预设路径：仅当确为 .docx（防误把其它标签路径当源）；否则进拖拽/选择态
      if (props.sourcePath && /\.docx$/i.test(props.sourcePath)) {
        void useFile(props.sourcePath);
      } else {
        void bindDrop();
      }
    } else {
      document.removeEventListener('keydown', onKey, true);
      unbindDrop();
    }
  },
);

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey, true);
  unbindDrop();
});

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    emit('close');
  }
}

/** 直接保存：系统对话框（初始目录 = docx 同目录，V5）。
 *  用户取消对话框 ≠ 取消转换（V10）：模态保持打开，两操作仍可用，无错误 toast */
async function onSaveDirect() {
  try {
    const res = await saveAsApi(
      `${stem.value}.${ext.value}`,
      content.value,
      ext.value,
      sourceDir.value || undefined,
    );
    if (res) {
      editor.showToast(t('workbench.toast.exported', { path: res.path }), 'success');
      emit('close');
    }
  } catch (err) {
    editor.showToast(err instanceof Error ? err.message : String(err), 'error');
  }
}

/** 转换后打开：未保存标签 + draftPath 意向路径（V1/V6） */
function onOpenAfter() {
  const kind = props.target;
  tabs.newUntitled(
    kind === 'md' ? content.value : '',
    'read',
    kind,
    kind === 'mh' ? content.value : '',
    { draftPath: draftPath.value ?? undefined, title: title.value },
  );
  emit('close');
  if (images.value.saved > 0) {
    editor.showToast(
      t('workbench.wordConvert.imgSavedHint', { dir: `${sourceDir.value}\\assets` }),
      'success',
    );
  } else if (images.value.inline > 0) {
    editor.showToast(t('workbench.wordConvert.imgInlineHint'), 'info');
  } else {
    editor.showToast(t('workbench.wordConvert.opened'), 'success');
  }
}
</script>

<template>
  <div v-if="visible" class="mask" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true">
      <div class="title">
        {{ titleText }}
        <span v-if="srcPath" class="src" :title="srcPath">{{ sourceName }}</span>
      </div>

      <!-- 闲置：拖入 / 选择文件 -->
      <div
        v-if="phase === 'idle'"
        class="dropzone"
        :class="{ active: dragActive }"
        @click="onPickClick"
      >
        <FileUp class="dz-ic" />
        <p class="dz-main">{{ dragActive ? t('workbench.wordConvert.dropActive') : t('workbench.wordConvert.dropTitle') }}</p>
        <p class="dz-hint">{{ t('workbench.wordConvert.dropHint') }}</p>
        <button class="btn primary dz-btn" @click.stop="onPickClick">
          {{ t('workbench.wordConvert.chooseFile') }}
        </button>
      </div>

      <!-- 进行中：不确定进度条 + 状态文案 -->
      <div v-else-if="phase === 'converting'" class="body">
        <div class="progress"><div class="progress-bar" /></div>
        <p class="msg conv-msg"><span class="spin" />{{ t('workbench.wordConvert.converting') }}</p>
      </div>

      <!-- 失败 -->
      <div v-else-if="phase === 'error'" class="body">
        <p class="msg err">{{ t('workbench.wordConvert.failed') }}：{{ errMsg }}</p>
        <p class="sub">{{ t('workbench.wordConvert.failedHint') }}</p>
      </div>

      <!-- 完成 -->
      <template v-else>
        <div class="body">
          <p v-if="zeroExtraction" class="warn-bar">{{ t('workbench.wordConvert.zeroExtraction') }}</p>
          <div class="summary">
            <span>{{ t('workbench.wordConvert.chars') }}：{{ textLength }}</span>
            <span>
              {{ t('workbench.wordConvert.images') }}：{{ t('workbench.wordConvert.imagesDetail', {
                saved: images.saved,
                inline: images.inline,
              }) }}
            </span>
            <span>{{ t('workbench.wordConvert.duration') }}：{{ durationMs }}ms</span>
          </div>
          <div v-if="warnings.length" class="warnings">
            <div class="warn-title">{{ t('workbench.wordConvert.warnings') }}</div>
            <ul>
              <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
            </ul>
          </div>
          <div class="preview-label">
            {{ t('workbench.wordConvert.preview') }}
            <span v-if="content.length > 2000" class="preview-note">
              {{ t('workbench.wordConvert.previewTruncated') }}
            </span>
          </div>
          <pre class="preview">{{ previewText }}</pre>
        </div>
        <div class="actions">
          <button class="btn" @click="backToPick">{{ t('workbench.wordConvert.rePick') }}</button>
          <button class="btn" @click="emit('close')">{{ t('workbench.wordConvert.close') }}</button>
          <button class="btn" @click="onOpenAfter">{{ t('workbench.wordConvert.openAfter') }}</button>
          <button class="btn primary" @click="onSaveDirect">{{ t('workbench.wordConvert.saveDirect') }}</button>
        </div>
      </template>

      <!-- 失败态：重新选择 / 关闭 -->
      <div v-if="phase === 'error'" class="actions">
        <button class="btn" @click="backToPick">{{ t('workbench.wordConvert.rePick') }}</button>
        <button class="btn" @click="emit('close')">{{ t('workbench.wordConvert.close') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: var(--mk-z-dialog);
  background: var(--mk-mask);
  display: flex; align-items: center; justify-content: center;
}
.dialog {
  width: 560px; max-width: 92vw; max-height: 86vh;
  display: flex; flex-direction: column;
  background: var(--mk-panel); color: var(--mk-fg);
  border: 1px solid var(--mk-border); border-radius: 10px;
  box-shadow: var(--mk-shadow-dialog);
  padding: 16px;
  box-sizing: border-box;
}
.title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.title .src {
  font-weight: 400; font-size: 12px; color: var(--mk-fg-muted);
  margin-left: 8px; max-width: 300px;
  display: inline-block; overflow: hidden; text-overflow: ellipsis;
  vertical-align: bottom; white-space: nowrap;
}
.body { font-size: 13px; line-height: 1.6; overflow: auto; min-height: 0; }
.msg { margin: 0 0 8px; }
.msg.err { color: var(--mk-danger); }
.sub { margin: 0; font-size: 12px; color: var(--mk-fg-muted); }
.body .spin {
  display: inline-block; width: 14px; height: 14px;
  border: 2px solid var(--mk-border); border-top-color: var(--mk-accent);
  border-radius: 50%; animation: spin 0.7s linear infinite;
  margin-right: 8px; vertical-align: -2px;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* 转换进度：不确定进度条（mammoth 无分度回调，滑动条表达"进行中"） */
.progress {
  height: 4px; border-radius: 999px;
  background: var(--mk-border); overflow: hidden;
  margin: 6px 0 12px;
}
.progress-bar {
  height: 100%; width: 40%;
  background: var(--mk-accent); border-radius: 999px;
  animation: progress-slide 1.1s ease-in-out infinite;
}
@keyframes progress-slide {
  from { transform: translateX(-100%); }
  to { transform: translateX(350%); }
}
.conv-msg { margin: 0; color: var(--mk-fg-muted); }

/* 拖拽 / 选择区（idle 态） */
.dropzone {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; padding: 34px 16px 28px;
  border: 1.5px dashed var(--mk-border); border-radius: 8px;
  background: var(--mk-bg);
  cursor: pointer; user-select: none; text-align: center;
  transition: border-color 140ms ease, background-color 140ms ease;
}
.dropzone:hover { border-color: var(--mk-accent); }
.dropzone.active {
  border-color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 8%, var(--mk-bg));
}
.dz-ic { width: 30px; height: 30px; color: var(--mk-fg-muted); margin-bottom: 2px; }
.dropzone.active .dz-ic { color: var(--mk-accent); }
.dz-main { margin: 0; font-size: 13px; }
.dz-hint { margin: 0 0 8px; font-size: 12px; color: var(--mk-fg-muted); }
.dz-btn { min-width: 96px; }

.warn-bar {
  margin: 0 0 10px; padding: 8px 10px;
  background: color-mix(in srgb, var(--mk-danger) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--mk-danger) 35%, transparent);
  border-radius: 6px; font-size: 12px;
}
.summary {
  display: flex; flex-wrap: wrap; gap: 4px 16px;
  font-size: 12px; color: var(--mk-fg-muted); margin-bottom: 8px;
}
.warnings { font-size: 12px; color: var(--mk-fg-muted); margin-bottom: 8px; }
.warnings .warn-title { font-weight: 600; }
.warnings ul { margin: 2px 0 0; padding-left: 18px; }
.preview-label { font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.preview-note { font-weight: 400; color: var(--mk-fg-muted); }
.preview {
  margin: 0; padding: 10px;
  background: var(--mk-bg); border: 1px solid var(--mk-border); border-radius: 6px;
  font-size: 12px; line-height: 1.5;
  max-height: 220px; overflow: auto;
  white-space: pre-wrap; word-break: break-all;
  font-family: Consolas, "Courier New", monospace;
}
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; flex: none; }
.btn {
  min-width: 72px;
  border: 1px solid var(--mk-border); background: var(--mk-bg); color: var(--mk-fg);
  border-radius: 6px; padding: 6px 16px; font-size: 13px; cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease;
}
.btn:hover { background: var(--mk-hover); border-color: var(--mk-border-strong); }
.btn:active { background: var(--mk-active); }
.btn:focus-visible { outline: 2px solid var(--mk-accent); outline-offset: 1px; }
.btn.primary {
  background: var(--mk-accent); border-color: var(--mk-accent); color: var(--mk-accent-fg);
  font-weight: 600;
}
.btn.primary:hover { background: color-mix(in srgb, var(--mk-accent) 86%, var(--mk-accent-fg)); }
.btn.primary:active { background: color-mix(in srgb, var(--mk-accent) 76%, var(--mk-accent-fg)); }
</style>
