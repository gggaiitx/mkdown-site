<script setup lang="ts">
/**
 * xlsx/xlsm 预览：SheetJS（xlsx 包）解析 + sheet_to_html 只读渲染。
 * 多工作表用页签切换；选 sheet_to_html 而非 Univer 网格的理由：
 * 只读场景无需公式栏/选区/编辑能力，HTML 表零额外依赖且不受大表虚拟化复杂度拖累。
 */
import { onMounted, ref, watch } from 'vue';
import * as XLSX from 'xlsx';

import { readPreviewBytes } from './PreviewAssets';
import OpenSystemBtn from './OpenSystemBtn.vue';

const props = defineProps<{ path: string }>();

const state = ref<'loading' | 'ok' | 'error'>('loading');
const errMsg = ref('');
const names = ref<string[]>([]);
const active = ref('');
const tableHtml = ref('');

/** WorkBook 不放进响应式（几 MB 的对象没必要被深度代理） */
let wb: XLSX.WorkBook | null = null;

function renderActive() {
  if (!wb || !active.value) return;
  const ws = wb.Sheets[active.value];
  if (!ws) return;
  tableHtml.value = XLSX.utils.sheet_to_html(ws, { editable: false });
}

async function load() {
  state.value = 'loading';
  wb = null;
  try {
    const buf = await readPreviewBytes(props.path);
    wb = XLSX.read(buf, { type: 'array' });
    names.value = wb.SheetNames;
    active.value = wb.SheetNames[0] ?? '';
    renderActive();
    state.value = 'ok';
  } catch (err) {
    errMsg.value = err instanceof Error ? err.message : String(err);
    state.value = 'error';
  }
}

watch(active, renderActive);
onMounted(load);
watch(() => props.path, load);
</script>

<template>
  <div class="sheet-pane">
    <OpenSystemBtn :path="path" />
    <div v-if="names.length > 1" class="sheet-tabs">
      <button
        v-for="n in names"
        :key="n"
        class="sheet-tab"
        :class="{ active: n === active }"
        @click="active = n"
      >
        {{ n }}
      </button>
    </div>
    <div v-if="state === 'loading'" class="pv-hint">正在解析表格…</div>
    <div v-else-if="state === 'error'" class="pv-error">
      <p>预览失败：{{ errMsg }}</p>
      <p class="pv-error-sub">可在文件树中右键用系统默认程序打开</p>
    </div>
    <!-- eslint-disable-next-line vue/no-v-html —— 内容由 sheet_to_html 生成，单元格文本已转义 -->
    <div v-else class="sheet-scroll" v-html="tableHtml"></div>
  </div>
</template>

<style scoped>
.sheet-pane {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--mk-bg);
}
.sheet-tabs {
  display: flex;
  gap: 2px;
  padding: 6px 10px 0;
  border-bottom: 1px solid var(--mk-border, #e0e0e0);
  overflow-x: auto;
  flex: none;
}
.sheet-tab {
  appearance: none;
  border: 1px solid transparent;
  border-bottom: none;
  background: transparent;
  color: var(--mk-fg-soft, #666);
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  white-space: nowrap;
}
.sheet-tab.active {
  background: var(--mk-panel, #fff);
  border-color: var(--mk-border, #e0e0e0);
  color: var(--mk-fg, #24292f);
  font-weight: 600;
}
.sheet-scroll {
  flex: 1;
  overflow: auto;
  padding: 12px;
}
.sheet-scroll :deep(table) {
  border-collapse: collapse;
  font-size: 13px;
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
}
.sheet-scroll :deep(td) {
  border: 1px solid var(--mk-border, #d0d7de);
  padding: 4px 10px;
  min-width: 48px;
  white-space: nowrap;
  color: var(--mk-fg, #24292f);
}
.sheet-scroll :deep(tr:first-child td) {
  background: var(--mk-panel-soft, #f6f8fa);
  font-weight: 600;
  position: sticky;
  top: 0;
}
.pv-hint,
.pv-error {
  padding: 48px 24px;
  text-align: center;
  color: var(--mk-fg-soft, #666);
  font-size: 14px;
}
.pv-error {
  color: var(--mk-danger, #d9534f);
}
.pv-error-sub {
  margin-top: 8px;
  color: var(--mk-fg-soft, #888);
  font-size: 12px;
}
</style>
