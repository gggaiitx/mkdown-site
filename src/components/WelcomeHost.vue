<script setup lang="ts">
/**
 * 欢迎页派发壳：按设置 + 可用空间在「书桌（Bento）」与「经典」两版之间切换。
 *
 * 为什么由这一层量尺寸而不是各版自己判断：
 * 欢迎区的可用宽度 = 窗口宽度 − 侧栏宽度（工作区打开时左侧目录树占位），
 * 用媒体查询的 viewport 宽度会偏乐观；这里量的是宿主盒子的真实内容尺寸。
 *
 * auto 的判据（宽 ≥1000 且高 ≥520）取两版都成立的交集：
 * 更窄时书桌会退化成单列长列表（要滚动、密度反而低于经典版），索性交回经典版。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useSettingsStore } from '../stores/settingsStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import type { MdTemplate } from '../utils/markdownTemplate';
import Welcome from './Welcome.vue';
import WelcomeDesk from './WelcomeDesk.vue';

const props = defineProps<{ templates: MdTemplate[] }>();

const emit = defineEmits<{
  (e: 'open-workspace'): void;
  (e: 'create-workspace'): void;
  (e: 'open-file'): void;
  (e: 'new-template', tpl: MdTemplate): void;
  (e: 'new-kernel', kind: 'md' | 'mh' | 'code'): void;
  (e: 'open-recent', path: string): void;
  (e: 'open-recent-preview', path: string): void;
  (e: 'continue-edit', path: string): void;
  /** 书桌左栏目录树的单击 / 双击 / 新建后打开：与全局侧栏同一套动作，不跟「最近打开」共用 */
  (e: 'open-tree-file', path: string): void;
  (e: 'open-tree-file-dbl', path: string): void;
  (e: 'open-tree-file-edit', path: string): void;
  (e: 'switch-workspace', dir: string): void;
  (e: 'remove-all-workspaces'): void;
  (e: 'search'): void;
  /** 书桌版是否自带左侧目录栏：外层据此把全局侧栏让位（避免同一棵树出现两次） */
  (e: 'update:rail', rail: boolean): void;
}>();

const settings = useSettingsStore();

const hostRef = ref<HTMLElement | null>(null);
/* 初值取 0（而非「一个像样的窗口宽」）：auto 档首帧先落经典版，量到真实尺寸再决定要不要升级成书桌——
   反过来会让窄窗用户在首帧看到一次书桌→经典的跳变 */
const boxW = ref(0);
const boxH = ref(0);
let ro: ResizeObserver | null = null;

onMounted(() => {
  winW.value = window.innerWidth;
  window.addEventListener('resize', onWinResize);
  const el = hostRef.value;
  if (!el || typeof ResizeObserver === 'undefined') return;
  ro = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect;
    if (!rect) return;
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w !== boxW.value) boxW.value = w;
    if (h !== boxH.value) boxH.value = h;
  });
  ro.observe(el);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onWinResize);
  ro?.disconnect();
  ro = null;
});

/* auto 档进入与回落的阈值分开（回差）：只用一个阈值时，把窗口拖在边界上会反复挂载/卸载书桌，
   每次重挂都会重建内嵌目录树、并重新 read_file 取「继续写作」摘要（IPC 抖动 + 视觉跳变） */
const DESK_ENTER_W = 1000;
const DESK_ENTER_H = 520;
const DESK_EXIT_W = 960;
const DESK_EXIT_H = 480;

const deskOn = ref(false);
watch([boxW, boxH], ([w, h]) => {
  if (w === 0 || h === 0) return; // 尚未量到真实尺寸：保持首帧的经典版
  if (deskOn.value) {
    if (w < DESK_EXIT_W || h < DESK_EXIT_H) deskOn.value = false;
  } else if (w >= DESK_ENTER_W && h >= DESK_ENTER_H) {
    deskOn.value = true;
  }
});

const useDesk = computed(() => {
  const mode = settings.settings.welcomeLayout;
  if (mode === 'desk') return true;
  if (mode === 'classic') return false;
  return deskOn.value;
});

/* 书桌版自带目录栏的判定：看**窗口宽度**而不是宿主宽度——栏出现时全局侧栏会让位，
   宿主会立刻变宽，用宿主宽度判会自锁（全局树在时永远到不了阈值）。
   1240 = 目录栏 210 + 间距 16 + 内容带 ~960 + 左右内距；1200 是收起阈值（回差同上）。 */
const RAIL_MIN_WIN = 1240;
const RAIL_KEEP_WIN = 1200;
/* 高度门槛与书桌 xl 档（boxH ≥ 640）对齐：矮窗下 .desk-cols 会转成纵向，
   左栏拿不到行高，整棵目录树会按内容高度把五张卡顶下去 */
const RAIL_MIN_H = 640;
const winW = ref(0);
function onWinResize() {
  winW.value = window.innerWidth;
}
const ws = useWorkspaceStore();
const railOn = ref(false);
watch([useDesk, winW, () => ws.root], () => {
  if (!useDesk.value || !ws.root) {
    railOn.value = false;
    return;
  }
  railOn.value = railOn.value ? winW.value >= RAIL_KEEP_WIN : winW.value >= RAIL_MIN_WIN;
}, { immediate: true });
const showRail = computed(
  () => useDesk.value && !!ws.root && railOn.value && boxH.value >= RAIL_MIN_H,
);
watch(showRail, (v) => emit('update:rail', v), { immediate: true });
</script>

<template>
  <div ref="hostRef" class="welcome-host">
    <WelcomeDesk
      v-if="useDesk"
      :templates="props.templates"
      :rail="showRail"
      @open-workspace="emit('open-workspace')"
      @create-workspace="emit('create-workspace')"
      @open-file="emit('open-file')"
      @new-template="(tpl: MdTemplate) => emit('new-template', tpl)"
      @new-kernel="(k: 'md' | 'mh' | 'code') => emit('new-kernel', k)"
      @open-recent="(p: string) => emit('open-recent', p)"
      @open-recent-preview="(p: string) => emit('open-recent-preview', p)"
      @continue-edit="(p: string) => emit('continue-edit', p)"
      @open-tree-file="(p: string) => emit('open-tree-file', p)"
      @open-tree-file-dbl="(p: string) => emit('open-tree-file-dbl', p)"
      @open-tree-file-edit="(p: string) => emit('open-tree-file-edit', p)"
      @switch-workspace="(d: string) => emit('switch-workspace', d)"
      @remove-all-workspaces="emit('remove-all-workspaces')"
      @search="emit('search')"
    />
    <Welcome
      v-else
      :templates="props.templates"
      @open-workspace="emit('open-workspace')"
      @create-workspace="emit('create-workspace')"
      @open-file="emit('open-file')"
      @new-template="(tpl: MdTemplate) => emit('new-template', tpl)"
      @open-recent="(p: string) => emit('open-recent', p)"
    />
  </div>
</template>

<style scoped>
.welcome-host {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
