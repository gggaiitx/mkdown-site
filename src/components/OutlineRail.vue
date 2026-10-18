<script setup lang="ts">
/**
 * 阅读态页面全屏专用大纲浮标。
 *
 * 全屏层（.engine-root.page-full / .wang-engine-root.page-full，z 9600）把应用右侧的
 * OutlinePanel 整个盖住了，全屏阅读时就没有目录可用。这里补一个贴在视口右缘的浮标：
 * 平时只露一列短横线（一条横线 = 一个标题，长度与深浅即层级），鼠标掠过整列横向放大展开成
 * 条目列表——横线列本身就是列表的行，展开只是把每行左侧的文字让出来，不是另开一块面板。
 * 点一条走和大纲面板完全相同的 gotoOutline 通路（不另起一套定位逻辑）。
 *
 * 组件自带 Teleport 到 body + 10105 层级带：必须浮在全屏层之上，
 * 又要在右键菜单（10110）与轻提示（10120）之下。
 */
import { ref, watch } from 'vue';
import { useI18n } from '../i18n';
import { useEditorStore, type OutlineItem } from '../stores/editorStore';

defineProps<{ items: OutlineItem[] }>();
const emit = defineEmits<{ (e: 'goto', item: OutlineItem): void }>();

const { t } = useI18n();
const editor = useEditorStore();
/** 层级压到 1~4 档（与 OutlinePanel 同一口径：H4 及更深归最弱一档） */
const lv = (n: number) => Math.min(Math.max(n, 1), 4);

/* 滚动联动：正文滚到哪儿，对应那条就选中（序号由 Workbench 统一量测写入 editor.activeHeading）。
   列表比视口长时还要把选中那条滚进视野——只动卡片自己的 scrollTop，
   不用 scrollIntoView（它会连带滚动所有可滚动祖先） */
const cardRef = ref<HTMLElement | null>(null);
watch(
  () => editor.activeHeading,
  (i) => {
    const card = cardRef.value;
    const row = i >= 0 ? (card?.children[i] as HTMLElement | undefined) : undefined;
    if (!card || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < card.scrollTop) card.scrollTop = top - 4;
    else if (bottom > card.scrollTop + card.clientHeight) card.scrollTop = bottom - card.clientHeight + 4;
  },
);

/** 点过一条之后主动缩回去（指针往往还停在浮标上，光靠 :hover 收不拢）；
 *  指针离开浮标即解除，下次掠过照常展开。
 *  顺手 blur 掉被点的按钮：否则 :focus-within 会在 tucked 解除后把浮标重新撑开 */
const tucked = ref(false);
function pick(item: OutlineItem, e: MouseEvent) {
  emit('goto', item);
  tucked.value = true;
  (e.currentTarget as HTMLElement | null)?.blur();
}
</script>

<template>
  <Teleport to="body">
    <nav
      v-if="items.length"
      class="mk-rail"
      :class="{ tucked }"
      :aria-label="t('outline.title')"
      @mouseleave="tucked = false"
    >
      <div ref="cardRef" class="rail-card">
        <button
          v-for="it in items"
          :key="it.index"
          class="rail-row"
          :class="[`lv${lv(it.level)}`, { on: editor.activeHeading === it.index }]"
          :title="t('outline.lineTip', { line: it.line })"
          @click="pick(it, $event)"
        >
          <span class="rail-text">{{ it.text }}</span>
          <i class="rail-tick" aria-hidden="true" />
        </button>
      </div>
    </nav>
  </Teleport>
</template>

<style scoped>
.mk-rail {
  position: fixed;
  /* 横向：贴在内容区内部的右缘。正文自己的竖向滚动条占最右 10px（全局规格），
     让开它再留 2px 缝——浮标在滚动条左侧，滚动条仍贴着窗口边 */
  right: 12px;
  /* 纵向：以视口垂直中心为锚，掠过展开时上下对称生长（从中间向两头撑开）。
     整列高度另有上限，见 .rail-card 的 max-height */
  top: 50%;
  transform: translateY(-50%);
  z-index: var(--mk-z-rail);
  --rail-row-h: 29px; /* 展开态一行的高（12.5×1.5 行高 + 上下内距 10px + 余量） */
  --rail-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  /* 收起态横线压到 45% 浓度（只是让位给正文，别抢阅读视线）；
     掠过展开时整条带 --rail-ink 拉到 100%，层级深浅才重新有意义 */
  --rail-ink: 45%;
}
.mk-rail:hover,
.mk-rail:focus-within {
  --rail-ink: 100%;
}
/* 收起态只有横线宽，展开态整卡横向放大：宽度、底色、边线、投影同一条过渡，
   所以看起来是「那一排横线长出了文字」而不是弹出一个新面板 */
.rail-card {
  display: flex;
  flex-direction: column;
  width: 28px;
  /* 上限 = 窗口高 − 顶部 chrome 170px − 底部 4 行：整列再长也不碰功能栏、不压状态栏 */
  max-height: calc(100vh - 170px - var(--rail-row-h) * 4);
  /* 溢出时仍可滚轮滚，但不给滚动条：阅读区自己就有一条，两条并排很难看。
     与标签栏同一手法（::-webkit-scrollbar + scrollbar-width 双清） */
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
  padding: 2px 2px;
  border: 1px solid transparent;
  border-inline-end: none;
  border-radius: var(--mk-radius) 0 0 var(--mk-radius);
  background: transparent;
  /* 宽度、行高、底色、边线、投影全部同一条曲线同一个时长同步收放。
     之前宽度 220ms、底色/边线 180ms、卡片内距也在变，三条错开就是「晃动」的来源 */
  transition: width 200ms var(--rail-ease), background-color 200ms ease, border-color 200ms ease,
    box-shadow 200ms ease;
}
.rail-card::-webkit-scrollbar {
  display: none;
}
.mk-rail:hover .rail-card,
.mk-rail:focus-within .rail-card {
  width: 268px;
  background: var(--mk-panel);
  border-color: var(--mk-border);
  box-shadow: var(--mk-shadow-pop);
}
.rail-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex: none;
  width: 100%;
  /* 收起态行距压到 1px（一列短横线要紧挨着才像「一条目录带」），
     掠过展开时再撑到 5px——与卡片宽度同时长同曲线，一起呼吸，不分先后 */
  padding: 1px 4px;
  border: none;
  background: transparent;
  border-radius: var(--mk-radius-sm);
  cursor: pointer;
  text-align: right;
  transition: padding 200ms var(--rail-ease), background-color 200ms ease;
}
.mk-rail:hover .rail-row,
.mk-rail:focus-within .rail-row {
  padding-block: 5px;
}
.rail-row:hover { background: var(--mk-hover); }
.rail-row:focus-visible { outline: var(--mk-focus-ring); outline-offset: -2px; }
/* 文字平时零宽不占位（横线仍钉在右缘），展开时逐行错开 16ms 淡入 */
.rail-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--mk-fg-muted);
  opacity: 0;
  /* 固定 60ms 后整批淡入：之前按行号递增 delay，看起来像内容从上往下加载 */
  transition: opacity 140ms ease 60ms;
}
.mk-rail:hover .rail-text,
.mk-rail:focus-within .rail-text {
  opacity: 1;
}
.rail-tick {
  width: 8px;
  height: 2px;
  flex: none;
  border-radius: 1px;
  background: color-mix(in srgb, var(--mk-ol-3) var(--rail-ink), transparent);
  transition: width 140ms ease, background-color 140ms ease;
}
/* 层级语言：收起态只看横线长短/深浅就能读出层级（一级最长最深 → 四级最短最弱），
   展开态再由文字粗细与明度接力，与 OutlinePanel 同一套表达。
   长度按最窄一档排：lv1 12px 正好等于卡片的内容宽（28 − 边框 2 − 卡片内距 4 − 行内距 8），
   再长就会被 overflow-x:hidden 裁掉 */
.rail-row.lv1 .rail-tick { width: 12px; background: color-mix(in srgb, var(--mk-ol-1) var(--rail-ink), transparent); }
.rail-row.lv2 .rail-tick { width: 10px; background: color-mix(in srgb, var(--mk-ol-2) var(--rail-ink), transparent); }
.rail-row.lv3 .rail-tick { width: 8px; }
.rail-row.lv4 .rail-tick { width: 6px; background: color-mix(in srgb, var(--mk-ol-4) var(--rail-ink), transparent); }
.rail-row.lv1 .rail-text { font-weight: 600; color: var(--mk-fg); }
.rail-row.lv2 .rail-text { font-weight: 500; color: var(--mk-fg); }
.rail-row.lv4 .rail-text { color: var(--mk-fg-muted); }
/* 当前阅读位置那条：收起态也认得出来（横线加长并拉满浓度），展开态文字提亮加粗。
   放在 :hover 之前——手悬到别的行时以悬停反馈优先 */
.rail-row.on .rail-tick { width: 18px; background: var(--mk-accent); }
.rail-row.on .rail-text { color: var(--mk-fg); font-weight: 600; }
/* 悬停行：文字提亮加粗 + 横线拉长到强调色（此刻整条已是 100% 浓度） */
.rail-row:hover .rail-text { color: var(--mk-fg); font-weight: 600; }
.rail-row:hover .rail-tick { width: 18px; background: var(--mk-accent); }

/* ---- 点过一条之后自己缩回去：放在 hover 之后（同特异性，后者胜出），
       且收得比展开慢一档，看着像「用完自己收起来」而不是被抽走 ---- */
.mk-rail.tucked .rail-card {
  width: 28px;
  padding: 2px 2px;
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  transition-duration: 460ms;
}
.mk-rail.tucked .rail-row {
  padding-block: 1px;
  transition-duration: 460ms;
}
.mk-rail.tucked .rail-text {
  opacity: 0;
  transition-delay: 0s;
}
</style>
