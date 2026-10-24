<script setup lang="ts">
import { computed } from 'vue';
import { FolderOpen, FolderPlus, FileText, FilePlus2, History } from '@lucide/vue';
import { useSettingsStore } from '../stores/settingsStore';
import { useI18n } from '../i18n';
import { BRAND_NAME } from '../utils/brand';
import type { MdTemplate } from '../utils/markdownTemplate';

const props = defineProps<{
  templates: MdTemplate[];
}>();

const { t } = useI18n();
const settings = useSettingsStore();

const emit = defineEmits<{
  (e: 'open-workspace'): void;
  (e: 'create-workspace'): void;
  (e: 'open-file'): void;
  (e: 'new-template', tpl: MdTemplate): void;
  (e: 'open-recent', path: string): void;
}>();

const recent = computed(() =>
  [...settings.settings.recentFiles].sort((a, b) => b.openedAtMs - a.openedAtMs).slice(0, 8),
);

function fmtTime(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  // 非当年补年份，避免跨年记录歧义；当年用短格式省宽度
  if (d.getFullYear() === new Date().getFullYear()) {
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  }
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
</script>

<template>
  <div class="welcome">
    <div class="hero">
      <div class="brand">
        <svg class="logo" viewBox="0 0 102 102" aria-hidden="true">
          <rect width="102" height="102" rx="24" fill="#E6F1FB" />
          <path
            d="M27 72 L27 32 L42 50 L57 32 L57 72"
            fill="none" stroke="#0C447C" stroke-width="7"
            stroke-linecap="round" stroke-linejoin="round"
          />
          <rect x="63" y="60" width="11" height="14" rx="2.5" fill="#378ADD" />
        </svg>
        <h1>{{ BRAND_NAME }}</h1>
      </div>
      <p class="sub">{{ t('welcome.subtitle') }}</p>
      <p class="engines">{{ t('welcome.enginesLine') }}</p>
    </div>

    <div class="cols">
      <section class="col">
        <h2>{{ t('welcome.start') }}</h2>
        <button class="big" @click="emit('open-workspace')"><FolderOpen class="b-icon" />{{ t('welcome.openWorkspace') }}</button>
        <button class="big" @click="emit('create-workspace')"><FolderPlus class="b-icon" />{{ t('welcome.createWorkspace') }}</button>
        <button class="big" @click="emit('open-file')"><FileText class="b-icon" />{{ t('welcome.openFile') }}</button>
        <h2>{{ t('welcome.fromTemplate') }}</h2>
        <button v-for="tpl in props.templates" :key="tpl.id" class="big" @click="emit('new-template', tpl)">
          <FilePlus2 class="b-icon" />{{ tpl.name }}
        </button>
      </section>
      <section class="col recent-col">
        <h2><History class="h-icon" /> {{ t('welcome.recent') }}</h2>
        <div v-if="recent.length > 0" class="recent-list">
          <button
            v-for="r in recent"
            :key="r.path"
            class="recent"
            v-tip="r.path"
            @click="emit('open-recent', r.path)"
          >
            <span class="r-name">{{ r.path.split(/[\\/]/).pop() }}</span>
            <span class="r-time">{{ fmtTime(r.openedAtMs) }}</span>
          </button>
        </div>
        <p v-else class="none">{{ t('welcome.noRecent') }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  height: 100%;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 34px;
  background: var(--mk-bg);
  overflow-y: auto;
}
.hero { text-align: center; }
/* 品牌行：logo 与「码克」横向并排、垂直居中（2026-10-11 飞总指定）。
   logo 36px ≈ h1 28px 字号的 1.3 倍——与标题 cap 高度同量级，不再头重脚轻 */
.brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
.logo {
  flex: none;
  width: 36px; height: 36px;
  border-radius: 9px;
  /* 品牌色相柔和投影：亮暗两态均成立（暗底下近不可见，徽章本身仍是亮色块） */
  box-shadow: 0 2px 10px rgba(12, 68, 124, 0.20), 0 1px 2px rgba(12, 68, 124, 0.16);
}
h1 {
  margin: 0; font-size: 28px; font-weight: 700;
  color: var(--mk-fg); letter-spacing: 4px;
  /* letter-spacing 会在末字右侧多出一份字距，负 margin 视觉回正（否则标题相对 logo/整行偏右） */
  margin-right: -4px;
}
.sub { margin: 14px 0 0; font-size: 13px; color: var(--mk-fg-muted); }
.engines { margin: 6px 0 0; font-size: 12px; color: var(--mk-fg-muted); opacity: 0.85; letter-spacing: 0.5px; }
/* 窄窗两列自动换行（宽屏仍并排；recent-col 自带 max-width 42vw 防撑宽）
   align-items: stretch —— 两列等高：右列高度跟随左列（2026-10-22 飞总指定） */
.cols { display: flex; flex-wrap: wrap; justify-content: center; gap: 24px 48px; align-items: stretch; }
.col { min-width: 220px; }
/* 最近打开列：限宽防止超长文件名把整列撑开（截断由 .r-name 省略号负责）；
   flex column + recent-list 撑满 —— 条目按可用高度均分，末条底边与左列末按钮底边齐平 */
.recent-col { width: 560px; max-width: 42vw; display: flex; flex-direction: column; }
.recent-list { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
/* 末按钮去掉尾部 6px 间距，否则左列视觉底边比右列高 6px，等高后看起来仍不齐 */
.col > .big:last-child { margin-bottom: 0; }
h2 { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--mk-fg-muted); letter-spacing: 2px; margin: 18px 0 8px; font-weight: 600; }
.h-icon { width: 12px; height: 12px; }
.big {
  display: flex; align-items: center; gap: 9px;
  width: 100%; text-align: left;
  border: 1px solid var(--mk-border); background: var(--mk-bg); color: var(--mk-fg);
  border-radius: var(--mk-radius); padding: 9px 14px; font-size: 13.5px;
  cursor: pointer; margin-bottom: 6px;
  transition: border-color 120ms ease, color 120ms ease, background-color 120ms ease;
}
.big:hover { border-color: var(--mk-fg-muted); background: var(--mk-hover); }
.b-icon { width: 15px; height: 15px; color: var(--mk-fg-muted); flex: none; }
.big:hover .b-icon { color: var(--mk-fg); }
.recent {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  width: 100%; text-align: left;
  /* flex:1 —— 条目在等高列内均分剩余高度；max-height 兜底，记录很少时不出现超高行 */
  flex: 1 1 auto; max-height: 44px;
  border: none; background: transparent; color: var(--mk-fg);
  padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 13px;
}
.recent:hover { background: var(--mk-hover); }
.r-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.r-time { font-size: 11px; color: var(--mk-fg-muted); flex: none; }
.none { font-size: 12px; color: var(--mk-fg-muted); }
</style>
