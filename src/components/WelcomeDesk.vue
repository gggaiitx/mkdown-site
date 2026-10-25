<script setup lang="ts">
/**
 * 欢迎页「书桌」版（Bento 布局）—— 参考 repro/welcome-desk-premium.html 落码。
 *
 * 设计约束（与参考稿的差异，均为有意为之）：
 * 1. 配色只用应用 token（--mk-*）+ 局部 --desk-*，因此亮/暗与八套配色自动跟随；
 * 2. 去掉了参考稿的极光漂移动画与 SVG 噪点：常驻动画会让 WebView 一直做合成，
 *    欢迎页长时间停留时不值得；静态径向渐变保留氛围；
 * 3. 五张卡片的数据全部来自真实后端能力，无记录/无工作区时走空态，不留假数字：
 *    - 继续写作 = settings.recentFiles[0] + get_file_meta + read_file（≤256KB 文本）取摘要
 *    - 新建 = tabsStore.newUntitled / 模板库（props.templates）
 *    - 最近打开 = settings.recentFiles（上限 20）
 *    - 工作区 / 近 7 天 = 遍历 workspaceStore.tree（size / mtimeMs，最多 6 万节点）
 * 4. 尺寸自适应由 ResizeObserver 量自身盒子（不是媒体查询）：欢迎区的可用宽度会被
 *    侧栏与窗口共同决定，媒体查询的 viewport 宽度在这里不准。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  ExternalLink, FileCode2, FilePlus2, FileText, FolderOpen, FolderPlus, PanelLeftOpen, PenLine, Search,
} from '@lucide/vue';
import pkg from '../../package.json';
import { getFileMeta, openUrl, readFile, revealInExplorer } from '../api/fileApi';
import type { WorkspaceNode } from '../api/types';
import { useUpdateCheck } from '../composables/useUpdateCheck';
import { useI18n } from '../i18n';
import { useSettingsStore } from '../stores/settingsStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { BRAND_NAME } from '../utils/brand';
import FileTree from './FileTree.vue';
import { fileKind, type FileKind } from '../utils/fileKind';
import { isMac, modKey } from '../utils/keyHint';
import type { MdTemplate } from '../utils/markdownTemplate';

const props = defineProps<{
  templates: MdTemplate[];
  /** 是否显示左侧目录栏：由 WelcomeHost 按窗口宽度统一判定（那边同时负责让全局侧栏让位） */
  rail?: boolean;
}>();

const emit = defineEmits<{
  (e: 'open-workspace'): void;
  (e: 'create-workspace'): void;
  (e: 'open-file'): void;
  (e: 'new-template', tpl: MdTemplate): void;
  (e: 'new-kernel', kind: 'md' | 'mh' | 'code'): void;
  (e: 'open-recent', path: string): void;
  (e: 'open-recent-preview', path: string): void;
  /** 「继续写作」与水波纸卡：落位一律编辑态，不跟用户的默认视图偏好 */
  (e: 'continue-edit', path: string): void;
  (e: 'switch-workspace', dir: string): void;
  (e: 'remove-all-workspaces'): void;
  (e: 'search'): void;
  (e: 'open-tree-file', path: string): void;
  (e: 'open-tree-file-dbl', path: string): void;
  (e: 'open-tree-file-edit', path: string): void;
}>();

const { t } = useI18n();
const settings = useSettingsStore();
const ws = useWorkspaceStore();
const { state: updateState, currentVersion, latestVersion } = useUpdateCheck();

// ---------------- 尺寸自适应（量自身盒子） ----------------
const rootRef = ref<HTMLElement | null>(null);
const boxW = ref(1280);
const boxH = ref(800);
let ro: ResizeObserver | null = null;

onMounted(() => {
  const el = rootRef.value;
  if (!el || typeof ResizeObserver === 'undefined') return;
  ro = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect;
    if (!rect) return;
    /* 取整：亚像素抖动会白跑一轮布局 */
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w !== boxW.value) boxW.value = w;
    if (h !== boxH.value) boxH.value = h;
  });
  ro.observe(el);
});
onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
});

/** xl=满幅书桌（两行五卡，不滚动）/ lg=两列可滚 / sm=单列可滚。
 *  高度门槛 640：再矮时一张卡装不下「标题+摘要+元信息+操作」，宁可退回两列滚动版 */
const sizeClass = computed(() => {
  if (boxW.value < 760) return 'size-sm';
  if (boxW.value < 1040 || boxH.value < 640) return 'size-lg';
  return 'size-xl';
});
/** 矮窗口：压缩内距、隐藏次要信息（参考稿 max-height:700 那档的等价物） */
const compact = computed(() => boxH.value < 660);
const wide = computed(() => sizeClass.value === 'size-xl');

/* 书桌版左侧目录栏：是否显示由 WelcomeHost 传入（它同时负责让全局侧栏让位），这里只做渲染 */
const RAIL_W = 208;
/** 用户把栏拖到最左隐藏后置 true；恢复按钮把它放回来（仅本次会话） */
const railClosed = ref(false);
/** 隐藏前记住的宽度：拖隐过程中 railW 会一路缩到 0，恢复时不能用它 */
const railLastW = ref(RAIL_W);
const showRail = computed(() => props.rail === true && !!ws.root && !railClosed.value);
/** 只有「外层允许显示 + 有工作区 + 是用户自己收起」时才给恢复入口 */
const canRestoreRail = computed(() => props.rail === true && !!ws.root && railClosed.value);
/* 目录栏可拖宽（书桌版 2026-10-24）：宽度跟着栅格一起算边界。
   下限沿用目录树自己的 200；上限按「栅格不低于 918px」反推——
   918 是现网左栏最小态（窗口回差阈值 1200 − 左右内距 56 − 间隙 16 − 栏宽 210），
   再给栏宽封顶 360；超宽屏的内容带被 .desk-cols 封在 1440，算边界前先夹进去。
   窗口变窄时上限跟着收：只夹「渲染宽度」，空间恢复后回到用户宽度 */
const RAIL_MIN = 200;
const RAIL_MAX = 360;
const BENTO_FLOOR = 918;
/** 栏宽持久化：与工作台侧栏分开存（书桌留空间给卡片，两处宽度不该互相干扰），
 *  但共用「记住侧栏宽度」这一个开关；读盘是异步的，兜底靠下面的 watch */
const railSaved = () =>
  settings.settings.fileTreeRememberWidth
    ? Math.round(Math.min(RAIL_MAX, Math.max(RAIL_MIN, settings.settings.welcomeRailWidth)))
    : RAIL_W;
/** 用户拖出来的目标宽度（持久化对象）。★ 不能拿「当前渲染宽度」代替它：
 *  从编辑器回书桌时全局侧栏可能还占着一帧，宿主量出来更窄、railMax 掉到下限；
 *  若把那一刻的渲染宽度反写进目标值，记住的栏宽就被永久压小（2026-10-25 反馈） */
const railPref = ref(railSaved());
/** 实际渲染宽度：按当前栅格边界夹取，空间恢复后自动回到 railPref */
const railW = ref(railPref.value);
/** 隐藏后恢复用的初值：也跟随存储宽度，否则拖隐一次就把宽度丢回 208 */
railLastW.value = railPref.value;
let railSaveTimer: number | undefined;
const railMax = computed(() => {
  const band = Math.min(boxW.value - 56, 1440);
  return Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(band - 16 - BENTO_FLOOR - 2)));
});
/** 边界变化只影响渲染宽度（立即执行一次，把首帧 boxW=1280 的兜底也夹进去）。
 *  目标宽度原样保留，所以窄一帧不会吃掉用户存下的宽度 */
watch(
  railMax,
  () => {
    const next = Math.round(Math.min(railMax.value, Math.max(RAIL_MIN, railPref.value)));
    if (next !== railW.value) railW.value = next;
  },
  { immediate: true },
);
/** 设置是异步读盘的：读到后纠正目标宽度。这里只用静态边界夹——
 *  railMax 依赖 boxW（ResizeObserver 量出来），设置读盘可能先于首次量宽落地 */
watch(
  () => [settings.settings.fileTreeRememberWidth, settings.settings.welcomeRailWidth] as const,
  ([remember]) => {
    if (!remember) return;
    const next = Math.round(Math.min(RAIL_MAX, Math.max(RAIL_MIN, settings.settings.welcomeRailWidth)));
    if (next === railPref.value) return;
    railPref.value = next;
    railW.value = Math.round(Math.min(railMax.value, Math.max(RAIL_MIN, next)));
  },
);
/** 记一次目标宽度（拖拽 / 恢复共用）：渲染宽度永远跟着 railMax 夹 */
function setRailPref(next: number): void {
  const v = Math.round(Math.min(RAIL_MAX, Math.max(RAIL_MIN, next)));
  railPref.value = v;
  railLastW.value = v;
  railW.value = Math.round(Math.min(railMax.value, Math.max(RAIL_MIN, v)));
}
/** 拖宽：本地立刻生效，落盘走 400ms 防抖（拖拽中每帧都会来一次 resize）。
 *  低于下限时只是在拖向「收起」，只跟手缩窄，不覆盖目标宽度 */
function onRailResize(w: number): void {
  if (w >= RAIL_MIN) setRailPref(w);
  else railW.value = w;
  if (!settings.settings.fileTreeRememberWidth) return;
  window.clearTimeout(railSaveTimer);
  railSaveTimer = window.setTimeout(() => {
    void settings.update({ welcomeRailWidth: railPref.value });
  }, 400);
}
/** 偏窄的 xl（侧栏展开时常见）：继续写作卡里「纸卡 + 三个按钮 + 保存状态」排不下一行，
 *  这一档把纸卡收窄、隐藏保存状态，避免按钮折行（飞总 2026-10-23 第 4 条）。
 *  有左栏时内容带被吃掉约 146px，同一判据要换算到窗口宽：实测 1283 起折行，取 1300 留余量。
 *  栏可拖宽后按实际宽度平移同一判据（栏每宽 1px，折行点就右移 1px） */
const tight = computed(() =>
  boxW.value < (showRail.value ? 1300 + (Math.max(railW.value, RAIL_MIN) - RAIL_W) : 1240),
);

function onRailHide(w: number) {
  // 收起途中不落盘：目标宽度归还到「开始拖隐前」的宽度，恢复入口与下次进入都回到原位
  window.clearTimeout(railSaveTimer);
  railSaveTimer = undefined;
  setRailPref(w);
  railClosed.value = true;
  if (settings.settings.fileTreeRememberWidth) {
    void settings.update({ welcomeRailWidth: railPref.value });
  }
}
function restoreRail() {
  setRailPref(railLastW.value);
  railClosed.value = false;
}

/* 目录栏入场：横排档由 CSS 过渡宽度（把五张卡推开），竖排档里栏在栅格上方、宽度推不动卡位，
   只能用高度把下面的卡让下来——高度是内容撑出来的，交给过渡钩子量一次再补间 */
const RAIL_ANIM = 'height 0.3s cubic-bezier(0.22, 0.61, 0.36, 1), opacity 0.3s ease';
function railAnimTarget(el: Element): HTMLElement | null {
  if (sizeClass.value === 'size-xl') return null;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null;
  return el as HTMLElement;
}
function railEnter(el: Element) {
  const h = railAnimTarget(el);
  if (!h) return;
  h.style.transition = '';
  h.style.height = '';
  h.style.overflow = 'hidden';
  const target = h.getBoundingClientRect().height;
  h.style.transition = RAIL_ANIM;
  h.style.height = '0px';
  void h.offsetHeight; // 先落到 0 并强制回流，再写目标高才有补间
  h.style.height = `${target}px`;
}
function railLeave(el: Element) {
  const h = railAnimTarget(el);
  if (!h) return;
  h.style.transition = RAIL_ANIM;
  h.style.height = `${h.getBoundingClientRect().height}px`;
  void h.offsetHeight;
  h.style.height = '0px';
}
function railSettled(el: Element) {
  const h = el as HTMLElement;
  h.style.transition = '';
  h.style.height = '';
  h.style.overflow = '';
}
/* 入场途中若整块从竖排切到横排（全局侧栏让位后窗口够宽），内联高度会卡住 stretch，及时清掉 */
watch(sizeClass, (v) => {
  if (v !== 'size-xl') return;
  const el = rootRef.value?.querySelector<HTMLElement>('.rail');
  if (el) railSettled(el);
});

// ---------------- 文案与格式化 ----------------
const isEn = computed(() => settings.settings.language === 'en-US');
/** macOS 的系统措辞是「访达」，Windows/Linux 才叫「文件夹」 */
const revealLabel = computed(() => t(isMac ? 'welcome.desk.revealMac' : 'welcome.desk.reveal'));

/** 一分钟一跳的时钟：日期与问候都从它取，跨零点/跨时段不用重开窗口 */
const nowTick = ref(Date.now());
let clockTimer: number | undefined;
onMounted(() => {
  clockTimer = window.setInterval(() => {
    nowTick.value = Date.now();
  }, 60_000);
});
onBeforeUnmount(() => {
  if (clockTimer !== undefined) window.clearInterval(clockTimer);
  clockTimer = undefined;
  // 栏宽的防抖落盘：卸载前把待写的值直接刷掉，别丢最后一次拖动
  if (railSaveTimer !== undefined) {
    window.clearTimeout(railSaveTimer);
    railSaveTimer = undefined;
    if (settings.settings.fileTreeRememberWidth) {
      // 存目标宽度，不存被窗口临时夹小的渲染宽度
      void settings.update({ welcomeRailWidth: railPref.value });
    }
  }
});

const dateParts = computed(() => {
  const d = new Date(nowTick.value);
  const locale = isEn.value ? 'en-US' : 'zh-CN';
  const md = d.toLocaleDateString(locale, { month: 'long', day: 'numeric' });
  const wd = d.toLocaleDateString(locale, { weekday: 'long' });
  // 中文「10月23日 星期五」拆成两段排版，段间距与后面的问候语统一；
  // 英文仍按「Friday, October 23」整段
  return isEn.value ? [`${wd}, ${md}`] : [md, wd];
});

/** 问候语按系统时间分档：早上 5–11 / 中午 11–13 / 下午 13–18 / 晚上 18–23 / 其余夜深了 */
const greeting = computed(() => {
  const h = new Date(nowTick.value).getHours();
  if (h >= 5 && h < 11) return t('welcome.desk.greetMorning');
  if (h >= 11 && h < 13) return t('welcome.desk.greetNoon');
  if (h >= 13 && h < 18) return t('welcome.desk.greetAfternoon');
  if (h >= 18 && h < 23) return t('welcome.desk.greetEvening');
  return t('welcome.desk.greetLate');
});

const pad2 = (n: number) => String(n).padStart(2, '0');
/** 千分位：1842 → 1,842 */
const fmtCount = (n: number) => n.toLocaleString('zh-CN');
const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/** 按日历日平移，而不是 ±86_400_000：夏令时切换那天只有 23/25 小时，
 *  固定毫秒数会让「昨天」「6 天前」落到前天或明天 */
const shiftDays = (ms: number, days: number) => {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const hm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 HH:mm / MM-DD / YYYY-MM-DD */
function relTime(ms: number): string {
  const now = Date.now();
  const d = new Date(ms);
  const diff = now - ms;
  if (diff < 60_000) return t('welcome.desk.tJustNow');
  if (diff < 3_600_000) return t('welcome.desk.tMinutes', { n: Math.floor(diff / 60_000) });
  const day = startOfDay(ms);
  const today = startOfDay(now);
  if (day === today) return t('welcome.desk.tHours', { n: Math.floor(diff / 3_600_000) });
  if (day === shiftDays(today, -1)) return t('welcome.desk.tYesterday', { t: hm(d) });
  if (d.getFullYear() === new Date(now).getFullYear()) {
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
/** 面包屑：取路径末两段目录（工作区 / 子目录），避免整条绝对路径挤爆行宽 */
function crumbOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  parts.pop();
  return parts.slice(-2).join(' / ');
}

const extOf = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

/** 徽章文字：.mh 与 .md 必须分开（fileKind 把两者都归 md） */
function badgeOf(name: string): string {
  const ext = extOf(name);
  if (ext === 'mh') return 'MH';
  switch (fileKind(name)) {
    case 'md': return 'MD';
    case 'code':
    case 'text': return (ext || 'txt').slice(0, 4).toUpperCase();
    case 'doc': return 'DOC';
    case 'sheet': return 'XLS';
    case 'slide': return 'PPT';
    case 'pdf': return 'PDF';
    case 'image': return 'IMG';
    case 'media': return 'MED';
    case 'archive': return 'ZIP';
    default: return 'FILE';
  }
}

/** 徽章色调（对应 CSS 的 .tone-*） */
function toneOf(name: string): string {
  const ext = extOf(name);
  if (ext === 'mh') return 'mh';
  switch (fileKind(name)) {
    case 'md': return 'md';
    case 'code':
    case 'text': return 'code';
    case 'doc': return 'doc';
    case 'pdf': return 'pdf';
    case 'image': return 'img';
    case 'sheet': return 'sheet';
    default: return 'other';
  }
}

function kindLabel(kind: FileKind): string {
  const map: Record<FileKind, string> = {
    md: 'welcome.desk.kindMd',
    text: 'welcome.desk.kindText',
    code: 'welcome.desk.kindCode',
    doc: 'welcome.desk.kindDoc',
    sheet: 'welcome.desk.kindSheet',
    slide: 'welcome.desk.kindSlide',
    pdf: 'welcome.desk.kindPdf',
    image: 'welcome.desk.kindImage',
    media: 'welcome.desk.kindMedia',
    archive: 'welcome.desk.kindArchive',
    other: 'welcome.desk.kindOther',
  };
  return t(map[kind]);
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

// ---------------- 最近打开 ----------------
const recent = computed(() =>
  [...settings.settings.recentFiles].sort((a, b) => b.openedAtMs - a.openedAtMs),
);

const recentRows = computed(() =>
  recent.value.map((r) => ({
    ...r,
    name: baseName(r.path),
    crumb: crumbOf(r.path),
    badge: badgeOf(r.path),
    tone: toneOf(r.path),
  })),
);

// ---------------- 继续写作 ----------------
const continueItem = computed(() => recent.value[0] ?? null);
/** 拆成标量 computed：模板里就不必对 continueItem 做非空收窄 */
const continuePath = computed(() => continueItem.value?.path ?? '');
/** 路径只有文件名时面包屑为空，此时连分隔圆点一起省掉 */
const continueCrumb = computed(() => (continuePath.value ? crumbOf(continuePath.value) : ''));
const continueOpenedMs = computed(() => continueItem.value?.openedAtMs ?? 0);
const continueName = computed(() => (continueItem.value ? baseName(continueItem.value.path) : ''));
const continueStem = computed(() => {
  const n = continueName.value;
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(0, i) : n;
});
const continueExt = computed(() => {
  const n = continueName.value;
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(i) : '';
});
const continueBadge = computed(() => (continueName.value ? badgeOf(continueName.value) : 'MD'));
const continueTone = computed(() => (continueName.value ? toneOf(continueName.value) : 'md'));
/** .mh 在 fileKind 里归 md（视觉同图标），但这里要报准「Markhtml」 */
const continueKindLabel = computed(() => {
  const n = continueName.value;
  if (!n) return '';
  return extOf(n) === 'mh' ? t('welcome.desk.kindMh') : kindLabel(fileKind(n));
});
/** 按钮动作跟文件类型走：md/.mh/纯文本=写作，代码=编码，其余（图片/文档/PDF…）=查阅 */
const continueActionLabel = computed(() => {
  const kind = fileKind(continueName.value);
  if (kind === 'code') return t('welcome.desk.continueBtnCode');
  if (kind === 'md' || kind === 'text') return t('welcome.desk.continueBtn');
  return t('welcome.desk.continueBtnRead');
});

const excerpt = ref('');
/** 文档一级标题（右栏「纸上预览」用）：md 取首个 # 行，.mh 取首个 <h1> */
const docHeading = ref('');
const lastModifiedMs = ref<number | null>(null);
const charCount = ref(0);
const wordCount = ref(0);
/** 纸卡里的文件属性：字节数 / 行数 / 编码，全部来自 read_file + get_file_meta */
const fileSize = ref(0);
const lineCount = ref(0);
const fileEncoding = ref('');
let excerptSeq = 0;

/** 摘要只对文本类读、且 ≤256KB：欢迎页不该为了两行字去解一个几十兆的文件 */
watch(
  () => continueItem.value?.path ?? '',
  async (path) => {
    const seq = ++excerptSeq;
    excerpt.value = '';
    docHeading.value = '';
    lastModifiedMs.value = null;
    charCount.value = 0;
    wordCount.value = 0;
    fileSize.value = 0;
    lineCount.value = 0;
    fileEncoding.value = '';
    if (!path) return;
    const kind = fileKind(path);
    if (kind !== 'md' && kind !== 'text' && kind !== 'code') return;
    try {
      const meta = await getFileMeta(path);
      if (seq !== excerptSeq) return;
      lastModifiedMs.value = meta.mtimeMs;
      fileSize.value = meta.size;
      if (meta.size > 262_144) return;
      const file = await readFile(path);
      if (seq !== excerptSeq) return;
      const plain = toPlain(file.content);
      // 纸卡要放足够多的真实正文给打字机滚动（左侧摘要仍由 CSS 钳到四行）
      excerpt.value = plain.slice(0, PAPER_CHARS);
      docHeading.value = headingOf(file.content);
      charCount.value = plain.replace(/\s/g, '').length;
      wordCount.value = plain.split(/\s+/).filter(Boolean).length;
      lineCount.value = file.content.split(/\r\n|\r|\n/).length;
      fileEncoding.value = (file.encoding || '').toUpperCase();
    } catch {
      /* 文件可能已删除/无权限：摘要与修改时间留空即可，不影响「继续编辑」按钮 */
    }
  },
  { immediate: true },
);

/** 字数口径：中文按字、英文按词；阅读速度取 400 字/分钟（中文技术文档的常见估值） */
const readUnits = computed(() => (isEn.value ? wordCount.value : charCount.value));
const readMinutes = computed(() => Math.max(1, Math.round(readUnits.value / 400)));

/** 纸卡正文素材上限：再多不会多显示信息，只会把一次循环拖得过长（1600 字约 29 秒） */
const PAPER_CHARS = 1600;

/** 缩略卡里只放正文：留足素材给打字机滚动，超长文档在句读处收尾 */
const paperText = computed(() => {
  const s = excerpt.value;
  if (s.length < PAPER_CHARS) return s;
  const stop = Math.max(
    s.lastIndexOf('。'),
    s.lastIndexOf('；'),
    s.lastIndexOf('. '),
    s.lastIndexOf(' '),
  );
  return stop > PAPER_CHARS - 200 ? s.slice(0, stop + 1) : s;
});

/**
 * 纸卡正文的打字机：内容超过纸面时随打字整体上滚，最新一行始终贴着纸面底部；
 * 读完停一下，淡出后从开头循环。内容本来就不满一屏时打完即停，不做无意义的循环。
 * prefers-reduced-motion 下直接给全文：不逐字、不滚动。
 */
const paperTextRef = ref<HTMLElement | null>(null);
const typedText = ref('');
const typing = ref(false);
/** 正文上移的距离（px）：只有内容超出纸面时才有值 */
const paperShift = ref(0);
const paperFade = ref(false);
/** 循环回到开头时暂时关掉位移动画，避免正文从底部「倒卷」回顶部 */
const paperRewind = ref(false);
/** 静态展示（reduced-motion / compact）：不滚动，固定显示正文开头 */
const paperStatic = ref(false);
let typeTimer: number | undefined;
let loopTimer: number | undefined;
let fitTimer: number | undefined;

/**
 * 打字节奏（滚动时长在 .paper-text 的 CSS 里，与「一行约 20 字」的节奏对齐）。
 * 每次落 2 个字而不是 1 个：字数推进速度不变（55 字/s），但每秒少一半的排版/重绘——
 * 10px 字号下肉眼看不出成对出现，长正文的滚动开销却能降下来。
 */
const TYPE_MS = 36;
const TYPE_STEP = 2;
const HOLD_MS = 1800;
const FADE_MS = 240;

function clearTypeTimer() {
  if (typeTimer !== undefined) window.clearInterval(typeTimer);
  typeTimer = undefined;
  typing.value = false;
}
function clearLoopTimer() {
  if (loopTimer !== undefined) window.clearTimeout(loopTimer);
  loopTimer = undefined;
}
function clearTimers() {
  clearTypeTimer();
  clearLoopTimer();
  if (fitTimer !== undefined) window.clearTimeout(fitTimer);
  fitTimer = undefined;
}

function syncShift() {
  if (paperStatic.value) return;
  const el = paperTextRef.value;
  if (!el) return;
  paperShift.value = Math.max(0, el.scrollHeight - el.clientHeight);
}

function typeFrom(start: number) {
  const full = paperText.value;
  if (!paperTextRef.value || start >= full.length) return;
  paperStatic.value = false;
  typing.value = true;
  typeTimer = window.setInterval(() => {
    const el = paperTextRef.value;
    // 纸卡收起（compact）或已卸载：直接落全文
    if (!el || el.clientHeight === 0) {
      clearTypeTimer();
      typedText.value = full;
      paperShift.value = 0;
      paperStatic.value = true;
      return;
    }
    // 窗口不可见时不做布局测量，回到前台接着打
    if (document.hidden) return;
    const n = Math.min(full.length, typedText.value.length + TYPE_STEP);
    typedText.value = full.slice(0, n);
    syncShift();
    if (n >= full.length) finishTyping();
  }, TYPE_MS);
}

function finishTyping() {
  clearTypeTimer();
  if (paperShift.value <= 0) return;
  loopTimer = window.setTimeout(() => {
    loopTimer = undefined;
    if (paperShift.value <= 0) return;
    paperFade.value = true;
    loopTimer = window.setTimeout(() => {
      loopTimer = undefined;
      paperRewind.value = true;
      typedText.value = '';
      paperShift.value = 0;
      void nextTick().then(() => {
        paperRewind.value = false;
        startTypewriter(false);
      });
    }, FADE_MS);
  }, HOLD_MS);
}

function startTypewriter(reset = true) {
  clearTimers();
  paperFade.value = false;
  paperRewind.value = false;
  paperStatic.value = false;
  if (reset) {
    typedText.value = '';
    paperShift.value = 0;
  }
  if (!paperText.value) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    typedText.value = paperText.value;
    paperStatic.value = true;
    return;
  }
  void nextTick().then(() => {
    // 当前档位不显示正文（compact）：直接落全文，别空转计时器
    if (!paperTextRef.value || paperTextRef.value.clientHeight === 0) {
      typedText.value = paperText.value;
      paperStatic.value = true;
      return;
    }
    typeFrom(typedText.value.length);
  });
}

watch(paperText, () => startTypewriter(), { immediate: true });

/** 窗口尺寸变化：打字中每帧会自己重算，停顿/静止时补算一次（拖动尺寸防抖） */
watch(boxH, () => {
  if (fitTimer !== undefined) window.clearTimeout(fitTimer);
  fitTimer = window.setTimeout(() => {
    fitTimer = undefined;
    if (!typing.value) syncShift();
  }, 300);
});
onBeforeUnmount(clearTimers);

/** Markdown / HTML 混排正文 → 单段纯文本（摘要、字数共用一个口径，不追求完整语法解析） */
function toPlain(raw: string): string {
  let s = raw;
  if (/^\s*</.test(s)) s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}(#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/^[ \t]*\|.*\|[ \t]*$/gm, ' ')
    .replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, ' ')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function headingOf(raw: string): string {
  const md = /^[ \t]{0,3}#[ \t]+(.+)$/m.exec(raw);
  if (md) return md[1].trim().replace(/[*_`]/g, '').slice(0, 40);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(raw);
  if (h1) return h1[1].replace(/<[^>]+>/g, '').trim().slice(0, 40);
  return '';
}

function previewContinue() {
  if (continuePath.value) emit('open-recent-preview', continuePath.value);
}

async function revealContinue() {
  const p = continuePath.value;
  if (!p) return;
  try {
    await revealInExplorer(p);
  } catch {
    /* 文件已不在原处：静默，用户可从「最近打开」重新确认 */
  }
}

// ---------------- 新建（模板弹层） ----------------
const templateList = computed(() => props.templates.filter((tpl) => tpl.id !== 'blank'));
const tplOpen = ref(false);
const tplWrapRef = ref<HTMLElement | null>(null);

function onDocPointerDown(e: PointerEvent) {
  const target = e.target as Node;
  if (tplOpen.value && !tplWrapRef.value?.contains(target)) tplOpen.value = false;
  if (wsMenuOpen.value && !wsSwitchRef.value?.contains(target)) wsMenuOpen.value = false;
}
function onDocKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  tplOpen.value = false;
  wsMenuOpen.value = false;
}
/** role=menu 只描述语义，方向键得自己接：否则 Tab 进得来、却只能用鼠标往下点 */
function onMenuKey(e: KeyboardEvent) {
  const items = Array.from(
    (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'),
  );
  if (items.length === 0) return;
  const cur = items.indexOf(document.activeElement as HTMLElement);
  let next = -1;
  if (e.key === 'ArrowDown') next = cur < 0 ? 0 : (cur + 1) % items.length;
  else if (e.key === 'ArrowUp') next = cur < 0 ? items.length - 1 : (cur - 1 + items.length) % items.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else return;
  e.preventDefault();
  items[next]?.focus();
}
/* 两个下拉共用同一对监听：常驻成本只是一次 contains 判断，比按开合反复挂摘更不容易漏 */
onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('keydown', onDocKeyDown, true);
});

function pickTemplate(tpl: MdTemplate) {
  tplOpen.value = false;
  emit('new-template', tpl);
}

// ---------------- 工作区切换 ----------------
const wsMenuOpen = ref(false);
const wsSwitchRef = ref<HTMLElement | null>(null);
/** 路径分隔符按数据本身判断（Windows 反斜杠 / macOS·Linux 斜杠），不做平台嗅探 */
const sepOf = (p: string): string => (p.includes('\\') ? '\\' : '/');
/** 其它工作区：排除当前，最多 8 条（recentWorkspaces 本身上限 10）。
 *  路径只给「盘符/…/上一层」，完整路径在 title 里——菜单里塞整条路径会挤成一团 */
function parentHint(dir: string): string {
  const sep = sepOf(dir);
  const parts = dir.split(/[\\/]/).filter(Boolean);
  parts.pop();
  if (parts.length === 0) return dir;
  if (parts.length <= 2) return parts.join(sep);
  return `${parts[0]}${sep}…${sep}${parts[parts.length - 1]}`;
}
const otherWorkspaces = computed(() =>
  settings.settings.recentWorkspaces
    .filter((dir) => dir !== ws.root)
    .slice(0, 8)
    .map((dir) => ({
      dir,
      name: dir.split(/[\\/]/).filter(Boolean).pop() ?? dir,
      hint: parentHint(dir),
    })),
);

function pickWorkspace(dir: string) {
  wsMenuOpen.value = false;
  emit('switch-workspace', dir);
}

// ---------------- 书桌版左侧目录栏 ----------------
/** 「最近改动」行数按剩余高度自适应：19px 一行，扣掉小标题，1~8 行 */
const wsRecentRef = ref<HTMLElement | null>(null);
const wsRecentRows = ref(3);
let wsRecentRo: ResizeObserver | null = null;

function measureWsRecent() {
  const el = wsRecentRef.value;
  if (!el) return;
  const usable = el.clientHeight - 20;
  const n = Math.max(1, Math.min(8, Math.floor(usable / 19)));
  if (n !== wsRecentRows.value) wsRecentRows.value = n;
}

watch(wsRecentRef, (el) => {
  wsRecentRo?.disconnect();
  wsRecentRo = null;
  if (!el || typeof ResizeObserver === 'undefined') return;
  wsRecentRo = new ResizeObserver(() => measureWsRecent());
  wsRecentRo.observe(el);
  measureWsRecent();
});

// ---------------- 工作区统计（一次遍历出全部数字） ----------------
interface DeskStats {
  files: number;
  bytes: number;
  md: number;
  mh: number;
  code: number;
  other: number;
  /** 近 7 天，索引 0 = 6 天前 … 6 = 今天 */
  days: number[];
  weekTotal: number;
  streak: number;
  recent: Array<{ name: string; path: string; mtimeMs: number }>;
  truncated: boolean;
}

const EMPTY_STATS: DeskStats = {
  files: 0, bytes: 0, md: 0, mh: 0, code: 0, other: 0,
  days: [0, 0, 0, 0, 0, 0, 0], weekTotal: 0, streak: 0, recent: [], truncated: false,
};

/** 大工作区兜底：超过这个节点数就停（剩余部分不计，footer 不承诺精确） */
const MAX_NODES = 60_000;
const DAY_MS = 86_400_000;
/** 日历日的零点：stats 依赖它，跨零点自动重算一次（每天一次，而不是每分钟重扫整棵树） */
const dayStamp = computed(() => startOfDay(nowTick.value));

const stats = computed<DeskStats>(() => {
  const tree: WorkspaceNode | null = ws.tree;
  if (!tree) return EMPTY_STATS;

  const days = [0, 0, 0, 0, 0, 0, 0];
  const today = dayStamp.value;
  const windowStart = shiftDays(today, -6);
  const top: Array<{ name: string; path: string; mtimeMs: number }> = [];
  let files = 0;
  let bytes = 0;
  let md = 0;
  let mh = 0;
  let code = 0;
  let other = 0;
  let visited = 0;
  let truncated = false;

  const stack: WorkspaceNode[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop() as WorkspaceNode;
    if (++visited > MAX_NODES) {
      truncated = true;
      break;
    }
    if (node.kind === 'dir') {
      if (node.children) for (const child of node.children) stack.push(child);
      continue;
    }
    files += 1;
    bytes += node.size ?? 0;
    const ext = extOf(node.name);
    if (ext === 'mh') mh += 1;
    else {
      const kind = fileKind(node.name);
      if (kind === 'md') md += 1;
      else if (kind === 'code' || kind === 'text') code += 1;
      else other += 1;
    }
    const mtime = node.mtimeMs ?? 0;
    if (mtime >= windowStart) {
      // 用 round 而不是 floor：跨夏令时的两天相差 47/49 小时，四舍五入仍落在正确的那一格
      const idx = Math.round((startOfDay(mtime) - windowStart) / DAY_MS);
      if (idx >= 0 && idx < 7) days[idx] += 1;
    }
    if (top.length < 8 || mtime > top[top.length - 1].mtimeMs) {
      top.push({ name: node.name, path: node.path, mtimeMs: mtime });
      top.sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (top.length > 8) top.pop();
    }
  }

  const weekTotal = days.reduce((a, b) => a + b, 0);
  let streak = 0;
  for (let i = 6; i >= 0; i -= 1) {
    if (days[i] === 0) break;
    streak += 1;
  }

  return { files, bytes, md, mh, code, other, days, weekTotal, streak, recent: top, truncated };
});

const sizeText = computed(() => fmtSize(stats.value.bytes));

/** 文件构成：只保留有量的四类，宽度按占比 */
const composition = computed(() => {
  const total = stats.value.files || 1;
  return [
    { key: 'md', count: stats.value.md, color: 'var(--desk-c-md)' },
    { key: 'mh', count: stats.value.mh, color: 'var(--desk-c-mh)' },
    { key: 'code', count: stats.value.code, color: 'var(--desk-c-code)' },
    { key: 'other', count: stats.value.other, color: 'var(--desk-c-other)' },
  ]
    .filter((s) => s.count > 0)
    .map((s) => ({ ...s, pct: (s.count / total) * 100 }));
});

/** 每段要扣掉的宽度：flex gap 总共 (n-1)*2px，按段数均摊。
 *  固定扣 1.5px 只在 4 段时刚好，2/3 段会缩出空隙、5 段会溢出轨道 */
const compSegInset = computed(() =>
  composition.value.length > 1 ? ((composition.value.length - 1) * 2) / composition.value.length : 0,
);

/** 悬停的构成段：横条与下方图例双向共用同一个 key，两边才能联动高亮 */
const hoverComp = ref<string | null>(null);

const legendLabel: Record<string, string> = {
  md: 'welcome.desk.legendMd',
  mh: 'welcome.desk.legendMh',
  code: 'welcome.desk.legendCode',
  other: 'welcome.desk.legendOther',
};

/** 星期标签必须跟着「滚动 7 天」的真实日期算：
 *  写死 一…日 时，今天是周五也会把今天的柱子标成「日」（飞总 2026-10-23 反馈）。
 *  narrow 在 zh 下就是「五」、en 下是「F」，不用自己拼表 */
const dayLabels = computed(() => {
  const locale = isEn.value ? 'en-US' : 'zh-CN';
  const today = dayStamp.value;
  return Array.from({ length: 7 }, (_, i) =>
    new Date(shiftDays(today, i - 6)).toLocaleDateString(locale, { weekday: 'narrow' }),
  );
});

const maxDay = computed(() => Math.max(1, ...stats.value.days));
/** 柱子高度百分比：有改动的最小 12%，免得 1 个文件的柱子看不见 */
const barPct = (n: number) => (n === 0 ? 4 : 12 + (n / maxDay.value) * 88);

// ---------------- 页脚版本 ----------------
const version = computed(() => currentVersion.value || pkg.version);
const SHENCO_URL = 'https://shenco.wang';
const openShenco = () => void openUrl(SHENCO_URL).catch(() => undefined);
const versionNote = computed(() => {
  switch (updateState.value) {
    case 'uptodate': return t('welcome.desk.upToDate');
    case 'available': return t('welcome.desk.newVersion', { v: latestVersion.value });
    case 'checking': return t('welcome.desk.checking');
    default: return '';
  }
});
</script>

<template>
  <div ref="rootRef" class="desk" :class="[sizeClass, { compact, tight, 'has-rail': showRail }]">
    <div class="desk-body">
      <header class="head">
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
          <div class="brand-txt">
            <div class="brand-name">{{ BRAND_NAME }}</div>
            <div class="brand-sub">
              <span v-for="(part, i) in dateParts" :key="i" :class="{ 'brand-gap': i > 0 }">{{ part }}</span>
              <span class="brand-greet">{{ greeting }}</span>
            </div>
          </div>
        </div>
        <button type="button" class="search-pill" v-tip="t('welcome.desk.searchHint')" @click="emit('search')">
          <Search :size="15" class="search-ic" />
          <span class="search-txt">{{ t('welcome.desk.searchPlaceholder') }}</span>
          <kbd>{{ modKey() }} P</kbd>
        </button>
      </header>
      <div class="desk-cols">
        <!-- 书桌版左栏：直接用经典目录树（同一份组件、同一套交互），默认 208、可拖宽；
             栏要等工作区树就绪才出现，用过渡把它推开而不是让五张卡瞬移 -->
        <Transition
          name="desk-rail"
          @enter="railEnter"
          @after-enter="railSettled"
          @leave="railLeave"
          @leave-cancelled="railSettled"
        >
          <aside v-if="showRail" class="rail" :style="{ '--rail-w': `${railW + 2}px` }">
            <FileTree
              :fixed-width="railW"
              resizable
              :min-width="RAIL_MIN"
              :max-width="railMax"
              @resize="onRailResize"
              @hide="onRailHide"
              @open-file="(p: string) => emit('open-tree-file', p)"
              @open-file-dbl="(p: string) => emit('open-tree-file-dbl', p)"
              @open-file-edit="(p: string) => emit('open-tree-file-edit', p)"
              @switch-workspace="(d: string) => emit('switch-workspace', d)"
              @open-workspace="emit('open-workspace')"
              @create-workspace="emit('create-workspace')"
              @remove-all-workspaces="emit('remove-all-workspaces')"
            />
          </aside>
        </Transition>

        <main class="bento">
          <!-- 继续写作 -->
          <section class="card c-continue">
            <div class="eyebrow">
              <svg class="eyebrow-ic" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
              {{ t('welcome.desk.continue') }}
              <span v-if="continuePath" class="eyebrow-right">{{ relTime(continueOpenedMs) }}</span>
            </div>

            <template v-if="continuePath">
              <div class="cont-grid">
                <div class="cont-main">
                  <div class="doc">
                    <span class="badge" :class="`tone-${continueTone}`">{{ continueBadge }}</span>
                    <div class="doc-main">
                      <h2 class="doc-title" v-tip="continueName">{{ continueStem }}<span class="ext">{{ continueExt }}</span></h2>
                      <div class="doc-meta">
                        <template v-if="continueCrumb">
                          <span class="crumb">{{ continueCrumb }}</span>
                          <i class="dot" />
                        </template>
                        <span>{{ continueKindLabel }}</span>
                      </div>
                    </div>
                  </div>
                  <p v-if="excerpt" class="excerpt">{{ excerpt }}</p>
                  <p v-else class="excerpt excerpt-empty">{{ t('welcome.desk.noExcerpt') }}</p>
                  <div class="cont-meta">
                    <span v-if="readUnits > 0">{{ t('welcome.desk.metaWords', { n: fmtCount(readUnits) }) }}</span>
                    <i v-if="readUnits > 0" class="dot" />
                    <span v-if="readUnits > 0">{{ t('welcome.desk.metaRead', { n: readMinutes }) }}</span>
                    <i v-if="lastModifiedMs" class="dot" />
                    <span v-if="lastModifiedMs">{{ t('welcome.desk.metaEdited', { t: relTime(lastModifiedMs) }) }}</span>
                  </div>
                  <div class="actions">
                    <button type="button" class="btn primary" @click="emit('continue-edit', continuePath)">
                      {{ continueActionLabel }}
                      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
                    </button>
                    <button type="button" class="btn outline" @click="previewContinue">
                      {{ t('welcome.desk.previewBtn') }}
                    </button>
                    <button
                      type="button"
                      class="btn icon-only"
                      v-tip="revealLabel"
                      :aria-label="revealLabel"
                      @click="revealContinue"
                    >
                      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                      </svg>
                    </button>
                    <span class="save-state">
                      <i class="ok-dot" />
                      {{ t('welcome.desk.savedLocal') }}
                    </span>
                  </div>
                </div>

                <!-- 右栏：文档纸卡。整卡可点（等同「继续写作」，落位编辑态），悬停微微抬起 -->
                <div
                  class="paper"
                  role="button"
                  tabindex="0"
                  :aria-label="`${continueActionLabel} · ${continueName}`"
                  @click="emit('continue-edit', continuePath)"
                  @keydown.enter.prevent="emit('continue-edit', continuePath)"
                  @keydown.space.prevent="emit('continue-edit', continuePath)"
                >
                  <!-- 卡针：跨在纸卡上边缘，把纸「别」在卡面上。
                       晴蓝 / 星蓝换成一枚印着码克 logo 的圆形徽章（见下方 palette 规则），
                       其余配色仍是金属长尾夹 -->
                  <span class="paper-pin" aria-hidden="true">
                    <svg viewBox="0 0 32 26">
                      <defs>
                        <linearGradient id="deskPinMetal" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0" stop-color="#fdfeff" />
                          <stop offset="0.26" stop-color="#dfe6ee" />
                          <stop offset="0.56" stop-color="#a3aeba" />
                          <stop offset="0.72" stop-color="#cfd8e2" />
                          <stop offset="1" stop-color="#7c8795" />
                        </linearGradient>
                        <linearGradient id="deskPinBadge" x1="0" y1="0" x2="0.42" y2="1">
                          <stop offset="0" stop-color="#a9d8fb" />
                          <stop offset="0.44" stop-color="#4f9be0" />
                          <stop offset="1" stop-color="#0c447c" />
                        </linearGradient>
                      </defs>
                      <g class="pin-clip">
                        <!-- 两根提手钢丝：从金属体顶边向外张开抬起 -->
                        <path d="M13 9.6C11.2 6.2 10.4 4.2 9 2.4" fill="none" stroke="#b9c4d0" stroke-width="1.9" stroke-linecap="round" />
                        <path d="M19 9.6C20.8 6.2 21.6 4.2 23 2.4" fill="none" stroke="#b9c4d0" stroke-width="1.9" stroke-linecap="round" />
                        <path d="M13.1 9.6C11.4 6.3 10.6 4.4 9.2 2.7" fill="none" stroke="#ffffff" stroke-width="0.65" stroke-linecap="round" opacity="0.7" />
                        <path d="M18.9 9.6C20.6 6.3 21.4 4.4 22.8 2.7" fill="none" stroke="#ffffff" stroke-width="0.65" stroke-linecap="round" opacity="0.7" />
                        <!-- 金属夹体：上窄下宽的折板，纸从下沿夹进去 -->
                        <path
                          d="M9.4 9h13.2l1.5 9.3a2.5 2.5 0 0 1-2.5 2.2H10.4a2.5 2.5 0 0 1-2.5-2.2Z"
                          fill="url(#deskPinMetal)"
                          stroke="#ffffff"
                          stroke-opacity="0.5"
                          stroke-width="0.8"
                          stroke-linejoin="round"
                        />
                        <path d="M9.9 9.9h12.2" stroke="#ffffff" stroke-width="0.8" opacity="0.85" />
                        <!-- 夹口：纸从下沿进去 -->
                        <path d="M10.8 20.1h10.4" stroke="#414b58" stroke-width="2.4" stroke-linecap="round" opacity="0.9" />
                        <path d="M10.8 20.1h10.4" stroke="#2a323c" stroke-width="1" stroke-linecap="round" opacity="0.55" />
                      </g>
                      <g class="pin-badge">
                        <circle cx="16" cy="13" r="12.6" fill="url(#deskPinBadge)" stroke="#ffffff" stroke-opacity="0.5" stroke-width="0.9" />
                        <ellipse cx="12.2" cy="7.2" rx="6.4" ry="2.8" fill="#ffffff" opacity="0.18" transform="rotate(-18 12.2 7.2)" />
                        <!-- 码克 logo：M + 光标，按 102 画布等比缩到这个 13px 的印面 -->
                        <g transform="translate(2.32 -1.04) scale(0.27)" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M27 72 L27 32 L42 50 L57 32 L57 72" />
                        </g>
                        <rect x="19.33" y="15.16" width="2.97" height="3.78" rx="0.68" fill="#cfe9ff" />
                      </g>
                    </svg>
                  </span>
                  <div class="paper-head">
                    <span class="badge xs" :class="`tone-${continueTone}`">{{ continueBadge }}</span>
                    <span class="paper-name">{{ continueName }}</span>
                  </div>
                  <div class="paper-rule"><span>{{ t('welcome.desk.paperTag') }}</span></div>
                  <div class="paper-body" aria-hidden="true">
                    <h3 class="paper-title">{{ docHeading || continueStem }}</h3>
                    <div
                      ref="paperTextRef"
                      class="paper-text-wrap"
                      :class="{ 'is-scrolled': paperShift > 0 }"
                    >
                      <p
                        class="paper-text"
                        :class="{ 'is-faded': paperFade, 'is-rewind': paperRewind }"
                        :style="{ transform: `translateY(-${paperShift}px)` }"
                      >
                        {{ paperText ? typedText : t('welcome.desk.noExcerpt') }}<span v-if="typing" class="paper-caret" />
                      </p>
                    </div>
                  </div>
                  <div class="paper-props" aria-hidden="true">
                    <div v-if="fileSize > 0"><span>{{ t('welcome.desk.propSize') }}</span><b>{{ fmtSize(fileSize) }}</b></div>
                    <div v-if="lineCount > 0"><span>{{ t('welcome.desk.propLines') }}</span><b>{{ fmtCount(lineCount) }}</b></div>
                    <div v-if="fileEncoding"><span>{{ t('welcome.desk.propEncoding') }}</span><b>{{ fileEncoding }}</b></div>
                  </div>
                  <div class="paper-foot" aria-hidden="true">
                    <span>{{ continueKindLabel }}</span>
                    <span v-if="readUnits > 0">{{ t('welcome.desk.metaWords', { n: fmtCount(readUnits) }) }}</span>
                  </div>
                </div>
              </div>
            </template>

            <div v-else class="empty">
              <p class="empty-title">{{ t('welcome.desk.continueEmpty') }}</p>
              <p class="empty-hint">{{ t('welcome.desk.continueEmptyHint') }}</p>
              <div class="actions">
                <button type="button" class="btn primary" @click="emit('open-file')">
                  {{ t('welcome.openFile') }}
                </button>
                <button type="button" class="btn ghost" @click="emit('open-workspace')">
                  {{ t('welcome.openWorkspace') }}
                </button>
              </div>
            </div>
          </section>

          <!-- 新建 -->
          <section class="card c-new" :class="{ 'menu-open': tplOpen }">
            <div class="eyebrow">
              <svg class="eyebrow-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              {{ t('welcome.desk.new') }}
              <button type="button" class="linkish" @click="emit('open-file')">
                <ExternalLink :size="12" />
                {{ t('welcome.openFile') }}
              </button>
            </div>
            <div class="new-grid">
              <button type="button" class="new-tile tone-md" @click="emit('new-kernel', 'md')">
                <span class="new-ico tone-md"><FileText :size="16" /></span>
                <span class="new-txt">
                  <span class="new-label">Markdown</span>
                  <span class="new-sub">{{ t('welcome.desk.tileMdSub') }}</span>
                </span>
                <span class="new-mark" aria-hidden="true">MD</span>
              </button>
              <button type="button" class="new-tile tone-mh" @click="emit('new-kernel', 'mh')">
                <span class="new-ico tone-mh"><PenLine :size="16" /></span>
                <span class="new-txt">
                  <span class="new-label">Markhtml</span>
                  <span class="new-sub">{{ t('welcome.desk.tileMhSub') }}</span>
                </span>
                <span class="new-mark" aria-hidden="true">MH</span>
              </button>
              <button type="button" class="new-tile tone-code" @click="emit('new-kernel', 'code')">
                <span class="new-ico tone-code"><FileCode2 :size="16" /></span>
                <span class="new-txt">
                  <span class="new-label">{{ t('welcome.desk.tileCode') }}</span>
                  <span class="new-sub">{{ t('welcome.desk.tileCodeSub') }}</span>
                </span>
                <span class="new-mark" aria-hidden="true">TXT</span>
              </button>
              <div ref="tplWrapRef" class="tpl-wrap">
                <button
                  type="button"
                  class="new-tile tone-tpl"
                  :aria-expanded="tplOpen"
                  @click="tplOpen = !tplOpen"
                >
                  <span class="new-ico tone-tpl"><FilePlus2 :size="16" /></span>
                  <span class="new-txt">
                    <span class="new-label">{{ t('welcome.desk.tileTpl') }}</span>
                    <span class="new-sub">{{ templateList.map((x) => x.name).join(' · ') || t('welcome.desk.tileTplSub') }}</span>
                  </span>
                  <span class="new-mark" aria-hidden="true">TPL</span>
                </button>
                <div v-if="tplOpen" class="tpl-menu" role="menu" @keydown="onMenuKey">
                  <button
                    v-for="tpl in templateList"
                    :key="tpl.id"
                    type="button"
                    role="menuitem"
                    class="tpl-item"
                    @click="pickTemplate(tpl)"
                  >{{ tpl.name }}</button>
                  <p v-if="templateList.length === 0" class="tpl-none">{{ t('welcome.desk.tileTplSub') }}</p>
                </div>
              </div>
              <button type="button" class="new-tile tone-ws" @click="emit('open-workspace')">
                <span class="new-ico tone-ws"><FolderOpen :size="16" /></span>
                <span class="new-txt">
                  <span class="new-label">{{ t('welcome.openWorkspace') }}</span>
                  <span class="new-sub">{{ t('welcome.desk.tileOpenWsSub') }}</span>
                </span>
                <span class="new-mark" aria-hidden="true">DIR</span>
              </button>
              <button type="button" class="new-tile tone-ws" @click="emit('create-workspace')">
                <span class="new-ico tone-ws"><FolderPlus :size="16" /></span>
                <span class="new-txt">
                  <span class="new-label">{{ t('welcome.createWorkspace') }}</span>
                  <span class="new-sub">{{ t('welcome.desk.tileNewWsSub') }}</span>
                </span>
                <span class="new-mark" aria-hidden="true">NEW</span>
              </button>
            </div>
          </section>

          <!-- 最近打开 -->
          <section class="card c-recent">
            <div class="eyebrow">
              <svg class="eyebrow-ic" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" />
              </svg>
              {{ t('welcome.recent') }}
              <span class="eyebrow-right">{{ t('welcome.desk.recentCount', { n: recent.length }) }}</span>
            </div>
            <div v-if="recentRows.length > 0" class="recent-list">
              <button
                v-for="row in recentRows"
                :key="row.path"
                type="button"
                class="recent-row"
                v-tip="row.path"
                @click="emit('open-recent', row.path)"
              >
                <span class="badge sm" :class="`tone-${row.tone}`" data-tip-anchor>{{ row.badge }}</span>
                <span class="row-main">
                  <span class="row-name">{{ row.name }}</span>
                  <span class="row-path">{{ row.crumb }}</span>
                </span>
                <span class="row-time">{{ relTime(row.openedAtMs) }}</span>
              </button>
            </div>
            <div v-else class="empty">
              <p class="empty-title">{{ t('welcome.noRecent') }}</p>
              <p class="empty-hint">{{ t('welcome.desk.recentEmptyHint') }}</p>
            </div>
          </section>
          <!-- 工作区 -->
          <section class="card c-ws" :class="{ 'menu-open': wsMenuOpen }">
            <div class="eyebrow">
              <svg class="eyebrow-ic" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
              </svg>
              {{ t('welcome.desk.workspace') }}
              <div v-if="ws.root" ref="wsSwitchRef" class="ws-switch-wrap">
                <button
                  type="button"
                  class="ws-switch"
                  :aria-expanded="wsMenuOpen"
                  v-tip="t('welcome.desk.switchWs')"
                  @click="wsMenuOpen = !wsMenuOpen"
                >
                  {{ t('welcome.desk.switchWs') }}
                  <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                </button>
                <div v-if="wsMenuOpen" class="ws-menu" role="menu" @keydown="onMenuKey">
                  <div class="ws-menu-label">{{ t('welcome.desk.currentWs') }}</div>
                  <div class="ws-menu-cur" v-tip="ws.root">{{ ws.rootName }}</div>
                  <template v-if="otherWorkspaces.length > 0">
                    <div class="ws-menu-label">{{ t('welcome.desk.otherWs') }}</div>
                    <button
                      v-for="w in otherWorkspaces"
                      :key="w.dir"
                      type="button"
                      role="menuitem"
                      class="ws-menu-item"
                      v-tip="w.dir"
                      @click="pickWorkspace(w.dir)"
                    >
                      <span class="ws-mi-name">{{ w.name }}</span>
                      <span class="ws-mi-path">{{ w.hint }}</span>
                    </button>
                  </template>
                  <div class="ws-menu-sep" />
                  <button type="button" role="menuitem" class="ws-menu-item plain" @click="wsMenuOpen = false; emit('open-workspace')">
                    {{ t('welcome.desk.openOtherWs') }}
                  </button>
                </div>
              </div>
            </div>

            <template v-if="ws.root">
              <div class="ws-name" v-tip="ws.rootName">{{ ws.rootName }}</div>
              <div class="ws-path" v-tip="ws.root">{{ ws.root }}</div>
              <div class="ws-stats" v-tip="stats.truncated ? t('welcome.desk.statsTruncated') : undefined">
                <strong>{{ stats.truncated ? '≥' : '' }}{{ fmtCount(stats.files) }}</strong><span>{{ t('welcome.desk.files') }}</span>
                <i class="dot gap" />
                <strong>{{ sizeText }}</strong>
              </div>
              <div v-if="composition.length > 0" class="comp-bar" @mouseleave="hoverComp = null">
                <i
                  v-for="seg in composition"
                  :key="seg.key"
                  :class="{ on: hoverComp === seg.key }"
                  :style="{ width: `calc(${seg.pct}% - ${compSegInset}px)`, background: seg.color }"
                  @mouseenter="hoverComp = seg.key"
                />
              </div>
              <div v-if="composition.length > 0" class="comp-legend">
                <span v-for="seg in composition" :key="seg.key" :class="{ on: hoverComp === seg.key }">
                  <i :style="{ background: seg.color }" />{{ t(legendLabel[seg.key], { n: seg.count }) }}
                </span>
              </div>
              <div v-if="stats.recent.length > 0 && sizeClass !== 'size-sm'" ref="wsRecentRef" class="ws-recent">
                <div class="mini-label">{{ t('welcome.desk.recentChanges') }}</div>
                <div v-for="f in stats.recent.slice(0, wsRecentRows)" :key="f.path" class="mini-row">
                  <span>{{ f.name }}</span>
                  <span>{{ relTime(f.mtimeMs) }}</span>
                </div>
              </div>
            </template>

            <div v-else class="empty">
              <p class="empty-title">{{ t('welcome.desk.wsEmpty') }}</p>
              <p class="empty-hint">{{ t('welcome.desk.wsEmptyHint') }}</p>
              <div class="actions">
                <button type="button" class="btn outline" @click="emit('open-workspace')">
                  {{ t('welcome.openWorkspace') }}
                </button>
              </div>
            </div>
          </section>

          <!-- 近 7 天 -->
          <section class="card c-week">
            <div class="eyebrow">
              <svg class="eyebrow-ic" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 12h4l3-8 4 16 3-8h4" />
              </svg>
              {{ t('welcome.desk.week') }}
              <span v-if="wide" class="eyebrow-right">{{ t('welcome.desk.byMtime') }}</span>
            </div>

            <template v-if="ws.root">
              <div class="week-num">
                <strong>{{ stats.weekTotal }}</strong>
                <span>{{ t('welcome.desk.weekUnit') }}</span>
              </div>
              <div class="week-chart" :aria-label="t('welcome.desk.week')">
                <div
                  v-for="(n, i) in stats.days"
                  :key="i"
                  class="bar-col"
                  :class="{ today: i === 6 }"
                  v-tip="`${n} ${t('welcome.desk.weekUnit')}`"
                >
                  <div class="bar-track" :style="{ '--h': `${barPct(n)}%` }">
                    <span class="bar-val" aria-hidden="true">{{ n }}</span>
                    <i class="bar-fill" :style="{ height: `${barPct(n)}%` }" />
                  </div>
                  <span class="bar-day">{{ dayLabels[i] }}</span>
                </div>
              </div>
              <div class="week-foot">
                <i class="pulse" />
                {{ stats.streak > 0 ? t('welcome.desk.streak', { n: stats.streak }) : t('welcome.desk.noStreak') }}
              </div>
            </template>

            <div v-else class="empty">
              <p class="empty-title">{{ t('welcome.desk.weekEmpty') }}</p>
              <p class="empty-hint">{{ t('welcome.desk.wsEmptyHint') }}</p>
            </div>
          </section>
          </main>
      </div>
      <footer class="foot">
        <a
          class="foot-design"
          :href="SHENCO_URL"
          @click.prevent="openShenco"
        >
          <svg class="foot-design-ic" viewBox="0 0 16 16" aria-hidden="true">
            <defs>
              <linearGradient id="footShencoStar" x1="2" y1="1" x2="15" y2="15" gradientUnits="userSpaceOnUse">
                <stop class="st-a" offset="0" />
                <stop class="st-b" offset="1" />
              </linearGradient>
            </defs>
            <path
              d="M8 1.2c.5 3.1 1.9 4.5 5 5-3.1.5-4.5 1.9-5 5-.5-3.1-1.9-4.5-5-5 3.1-.5 4.5-1.9 5-5Z"
              fill="url(#footShencoStar)"
            />
            <path
              d="M13.2 10.9c.2 1.25.75 1.8 2 2-1.25.2-1.8.75-2 2-.2-1.25-.75-1.8-2-2 1.25-.2 1.8-.75 2-2Z"
              class="st-mini"
              fill="url(#footShencoStar)"
            />
          </svg>
          <span class="foot-design-txt">Design by Shenco</span>
        </a>
        <span class="foot-status">
          <i class="ok-dot" />
          <span class="foot-ver">v{{ version }}<template v-if="versionNote"> · {{ versionNote }}</template></span>
        </span>
        <span class="foot-right">{{ t('welcome.desk.enginesShort') }}</span>
      </footer>
    </div>
    <!-- 拖到最左收起后的恢复入口：贴左缘的窄把手，位置就是栏原来的垂直范围中部 -->
    <button
      v-if="canRestoreRail"
      type="button"
      class="rail-restore"
      :aria-label="t('welcome.desk.railRestore')"
      v-tip="t('welcome.desk.railRestore')"
      @click="restoreRail"
    >
      <PanelLeftOpen :size="14" />
    </button>
  </div>
</template>

<style scoped>
.desk {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--mk-bg);
  /* 品牌色与类型色：--desk-brand / --desk-brand-deep 定义在 global.css :root，
     目录树在书桌态下共用同一份；这里只放本组件专用的派生色 */
  --desk-brand-soft: rgb(47 127 208 / 0.12);
  --desk-violet: rgb(120 104 230 / 0.1);
  --desk-c-md: #1f5f8f;
  --desk-c-mh: #6b4fb3;
  --desk-c-code: #8a540c;
  --desk-c-doc: #2b579a;
  --desk-c-pdf: #b3261e;
  --desk-c-img: #0f766e;
  --desk-c-sheet: #1d6b45;
  --desk-c-other: #5b616b;
}
:root[data-theme='dark'] .desk {
  --desk-brand-soft: rgb(76 155 232 / 0.16);
  --desk-violet: rgb(139 122 255 / 0.16);
  --desk-c-md: #8cc5f0;
  --desk-c-mh: #c3aef7;
  --desk-c-code: #e7b76a;
  --desk-c-doc: #9ec1f2;
  --desk-c-pdf: #f3a59d;
  --desk-c-img: #7fd1c8;
  --desk-c-sheet: #8fd3ae;
  --desk-c-other: #9aa3b1;
}
/* logo 渐变配色：两处环境光收成同一条蓝（亮蓝 → 深海军蓝），不再掺紫，
   让书桌底色与主按钮/柱状图的 logo 渐变连成一片 */
:root[data-theme='light'][data-palette='azure'] .desk {
  --desk-brand-soft: rgb(55 138 221 / 0.16);
  --desk-violet: rgb(12 68 124 / 0.09);
}
:root[data-theme='dark'][data-palette='nebula'] .desk {
  --desk-brand-soft: rgb(90 168 240 / 0.22);
  --desk-violet: rgb(27 109 193 / 0.14);
}
.desk::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(900px 520px at 2% -16%, var(--desk-brand-soft), transparent 62%),
    radial-gradient(760px 520px at 102% 116%, var(--desk-violet), transparent 60%);
}
.size-lg,
.size-sm {
  overflow-y: auto;
}

.desk-body {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* 四周留白：卡片不贴窗边，视线自然收到中间（飞总 2026-10-23 第 4 条：再加一档） */
  padding: 40px 68px 22px;
  /* 目录栏到位时内距会从 40/68 收到 24/28，和栏宽一起补过渡，整页才不会瞬移 */
  transition: padding 0.3s cubic-bezier(0.22, 0.61, 0.36, 1);
}
/* 超宽屏把内容收在一条阅读带里，否则 2560 宽会把五张卡拉成面条。
   ★ 品牌行 / 栅格 / 页脚必须共用同一条带宽与居中规则：
     否则宽窗下栅格被 max-width 收窄居中、品牌行仍是通栏，logo 与搜索框就会比卡片各突出一截 */
.head,
.desk-cols,
.foot {
  width: 100%;
  max-width: 1440px;
  margin-left: auto;
  margin-right: auto;
}
/* 行顺序：品牌行（通栏） → [目录栏 | 五卡栅格] → 页脚。
   目录栏与栅格同高：栏是这一行的 stretch 子项，顶边底边自然与五张卡对齐 */
.desk-cols {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 16px;
}
/* 带目录栏时左内距让给栏本身：栏是卡片，再叠 68px 会把正文推得太远 */
.desk.has-rail .desk-body {
  padding: 24px 28px 18px;
}
/* 栅格在 .desk-cols 里，宽度由那一行决定（带宽已被上面的规则约束） */
.bento {
  width: 100%;
}
.size-xl .desk-body {
  overflow: hidden;
}
.compact .desk-body {
  padding: 22px 34px 10px;
}

/* ---------- 页头 ---------- */
.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}
.compact .head {
  margin-bottom: 10px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
}
.logo {
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  box-shadow: 0 6px 18px -8px rgb(12 68 124 / 0.5), 0 1px 0 rgb(255 255 255 / 0.5) inset;
}
.compact .logo {
  width: 30px;
  height: 30px;
  border-radius: 9px;
}
.brand-txt {
  min-width: 0;
}
.brand-name {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.16em;
  line-height: 1.15;
  color: var(--mk-fg);
  margin-right: -0.16em;
}
/* 亮色模式：品牌字取 logo 的深海军蓝，和左上角 logo 同一蓝色系 */
:root[data-theme='light'] .brand-name {
  color: var(--desk-brand-deep);
}
/* 问候语接在日期行末尾：同一号的弱化色，只靠间距分隔（不加「·」，飞总 2026-10-23） */
.brand-gap,
.brand-greet {
  margin-left: 6px;
}
.brand-greet {
  white-space: nowrap;
}
.compact .brand-name {
  font-size: 15px;
}
.brand-sub {
  margin-top: 3px;
  font-size: 11px;
  color: var(--mk-fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.search-pill {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  min-width: 210px;
  padding: 0 9px 0 11px;
  border: 1px solid var(--mk-border);
  border-radius: 10px;
  background: var(--mk-panel);
  background: color-mix(in srgb, var(--mk-panel) 78%, transparent);
  color: var(--mk-fg-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease, color 0.16s ease;
}
.search-pill:hover {
  border-color: var(--mk-border-strong);
  background: var(--mk-panel);
  color: var(--mk-fg);
}
.search-pill:focus-visible {
  outline: var(--mk-focus-ring);
  outline-offset: 2px;
}
.search-ic {
  flex: none;
}
.search-txt {
  flex: 1;
  text-align: left;
  white-space: nowrap;
}
kbd {
  flex: none;
  font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 9.5px;
  color: var(--mk-fg-muted);
  background: var(--mk-panel-muted);
  border: 1px solid var(--mk-border);
  border-bottom-color: var(--mk-border-strong);
  border-radius: 5px;
  padding: 2px 5px;
  line-height: 1.2;
}

/* ---------- 栅格 ---------- */
.bento {
  flex: 1;
  min-height: 0;
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
}
.compact .bento {
  gap: 12px;
}
.c-continue { grid-column: span 7; }
.c-new { grid-column: span 5; }
.c-recent { grid-column: span 5; }
.c-ws { grid-column: span 4; }
.c-week { grid-column: span 3; }

/* 两列 / 单列：整页滚动，卡片高度交给内容 + 最小高度。
   ⚠ 这层必须摘掉 .desk-body / .bento 的 flex:1（basis 0）：容器不定高时
   会把卡片内的列表算成 0 高，卡片互相压叠（2026-10-23 探针实测） */
.size-lg .desk-body,
.size-sm .desk-body {
  flex: none;
  overflow: visible;
}
/* 单列/两列：竖向排（这条同时避免 flex:1 在不定高容器里塌成 0） */
.size-lg .desk-cols,
.size-sm .desk-cols {
  flex: none;
  flex-direction: column;
}
.size-lg .bento {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: none;
  align-content: start;
  flex: none;
}
.size-lg .c-continue {
  grid-column: span 2;
  min-height: 208px;
}
.size-lg .c-new,
.size-lg .c-recent,
.size-lg .c-ws,
.size-lg .c-week {
  grid-column: span 1;
  min-height: 236px;
}
.size-lg .c-ws { min-height: 210px; }
.size-lg .c-week { min-height: 210px; }
/* 两列档卡片是内容高度：最近列表必须封顶，否则 20 条会把整行拉到 800+，
   同行的「新建」跟着被拉伸成两张巨型磁贴 */
.size-lg .recent-list { max-height: 264px; }

.size-sm .bento {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: none;
  gap: 11px;
  flex: none;
}
.size-sm .c-continue,
.size-sm .c-new,
.size-sm .c-recent,
.size-sm .c-ws,
.size-sm .c-week {
  grid-column: span 1;
  min-height: 0;
}
.size-sm .c-continue { min-height: 200px; }

/* 单列：卡片内一切「可伸缩」容器改为按内容排，否则 basis 0 塌陷 */
.size-sm .card { overflow: visible; }
.size-sm .new-grid { flex: none; grid-auto-rows: auto; }
.size-sm .new-tile { min-height: 54px; }
.size-sm .recent-list { flex: none; gap: 2px; max-height: 270px; }
.size-sm .recent-row { flex: none; height: 44px; }
.size-sm .week-chart { flex: none; height: 118px; }
.size-sm .ws-recent { margin-top: 12px; }
.size-sm .excerpt { max-width: 100%; -webkit-line-clamp: 3; }

/* ---------- 卡片 ---------- */
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 16px 18px;
  border-radius: 14px;
  border: 1px solid var(--mk-border);
  background: var(--mk-panel);
  /* 玻璃面：color-mix 不被支持时上面的纯色兜底 */
  background: color-mix(in srgb, var(--mk-panel) 82%, transparent);
  box-shadow: 0 1px 2px rgb(16 24 40 / 0.04), 0 16px 36px -28px rgb(16 24 40 / 0.3);
  overflow: hidden;
  transition: border-color 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease;
}
:root[data-theme='dark'] .card {
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.35), 0 18px 40px -30px rgb(0 0 0 / 0.9);
}
.card:hover {
  border-color: var(--mk-border-strong);
  transform: translateY(-1px);
}
.size-xl .card:hover {
  box-shadow: 0 1px 2px rgb(16 24 40 / 0.05), 0 22px 44px -28px rgb(16 24 40 / 0.34);
}
.c-continue {
  padding: 18px 22px 14px;
  border-color: color-mix(in srgb, var(--desk-brand) 30%, var(--mk-border));
  background: linear-gradient(
    150deg,
    color-mix(in srgb, var(--mk-panel) 94%, transparent),
    color-mix(in srgb, var(--mk-panel) 72%, transparent)
  );
  /* 纸卡悬停时会抬起并投影，卡片不能裁掉这层阴影 */
  overflow: visible;
}
/* 新建卡：模板弹层要能溢出卡片（其它卡靠 overflow:hidden 裁列表），
   弹层打开时抬 z-index，免得被后面排到的卡片盖住 */
.c-new { overflow: visible; }
.c-new.menu-open { z-index: 5; }
/* 工作区卡同理：切换菜单要从卡片右上角向上展开 */
.c-ws { overflow: visible; }
.c-ws.menu-open { z-index: 5; }

/* ---------- 书桌版左栏（内嵌经典目录树） ---------- */
/* 宽度 = 树的宽度 + 两侧边框，由模板内联给出（可拖宽；入场过渡从 0 推到该目标）。
   .explorer 自带 --mk-panel 底色与右缘 1px 竖线，嵌进卡片要去掉，否则像贴了两层皮 */
.rail {
  /* 相对定位只为了让悬停的 1px 抬升用 top 实现：
     用 transform 会把 .rail 变成 fixed 后代的包含块，工作区菜单会被重新裁进面板里 */
  position: relative;
  top: 0;
  flex: none;
  /* 宽度走 CSS 变量而不是内联 width：入场/退场的 width 过渡类才压得过它 */
  width: var(--rail-w);
  display: flex;
  min-height: 0;
  border-radius: 14px;
  border: 1px solid var(--mk-border);
  background: var(--mk-panel);
  background: color-mix(in srgb, var(--mk-panel) 82%, transparent);
  box-shadow: 0 1px 2px rgb(16 24 40 / 0.04), 0 16px 36px -28px rgb(16 24 40 / 0.3);
  overflow: hidden;
  transition: border-color 0.18s ease, top 0.18s ease, box-shadow 0.18s ease;
}
/* 悬停手感对齐五张卡：描边转强 + 抬 1px（xl 档阴影一并加深） */
.rail:hover {
  top: -1px;
  border-color: var(--mk-border-strong);
}
.size-xl .rail:hover {
  box-shadow: 0 1px 2px rgb(16 24 40 / 0.05), 0 22px 44px -28px rgb(16 24 40 / 0.34);
}
/* 目录栏入场：横向档靠宽度把五张卡「推开」+ 淡入；竖排档只淡入（栏在栅格上方，宽度推不动） */
.desk-rail-enter-active,
.desk-rail-leave-active {
  transition:
    width 0.3s cubic-bezier(0.22, 0.61, 0.36, 1),
    margin-right 0.3s cubic-bezier(0.22, 0.61, 0.36, 1),
    opacity 0.3s ease;
  overflow: hidden;
}
.desk-rail-enter-from,
.desk-rail-leave-to { opacity: 0; }
/* 负外边距抵消 .desk-cols 的 16px gap：首帧不先跳 16px 再慢慢推 */
.desk.size-xl .desk-rail-enter-from,
.desk.size-xl .desk-rail-leave-to {
  width: 0;
  margin-right: -16px;
}
@media (prefers-reduced-motion: reduce) {
  .rail { transition: none; }
  .rail:hover { top: 0; }
  .desk-body { transition: none; }
  .desk-rail-enter-active,
  .desk-rail-leave-active { transition: none; }
}
:root[data-theme='dark'] .rail {
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.35), 0 18px 40px -30px rgb(0 0 0 / 0.9);
}
/* 暗色下上面这条会盖掉悬停阴影（选择器权重相同、位置在后），这里补一条同权重的悬停态 */
:root[data-theme='dark'] .size-xl .rail:hover {
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.4), 0 24px 48px -30px rgb(0 0 0 / 0.95);
}
.desk .rail :deep(.explorer) {
  background: transparent;
  height: 100%;
  min-width: 0;
}
/* 栏自身已有一圈 1px 卡片边框，树手柄再画一条会在内侧多出一道平行线：
   书桌版不画手柄线（热区与 col-resize 光标仍在），边缘反馈交给栏的边框本身 */
.desk .rail :deep(.resizer::after) { display: none; }
.desk .rail :deep(.panel-head) { padding-left: 10px; }
.desk .rail :deep(.tree) { padding: 2px 6px 10px; }

/* 拖到最左收起后的恢复把手：贴左缘、低对比常驻，悬停提亮（松手瞬间就在光标附近） */
.rail-restore {
  position: absolute;
  left: 0;
  top: 50%;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 54px;
  padding: 0;
  border: 1px solid var(--mk-border);
  border-left: 0;
  border-radius: 0 9px 9px 0;
  background: var(--mk-panel);
  color: var(--mk-fg-muted);
  box-shadow: 0 1px 2px rgb(16 24 40 / 0.06), 0 8px 20px -14px rgb(16 24 40 / 0.28);
  transform: translateY(-50%);
  opacity: 0.7;
  cursor: pointer;
  transition: opacity 0.15s ease, color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
  animation: rail-restore-in 0.18s ease-out;
}
.rail-restore:hover {
  opacity: 1;
  color: var(--mk-fg);
  border-color: var(--mk-border-strong);
  background: var(--mk-panel-soft);
}
.rail-restore:focus-visible {
  outline: var(--mk-focus-ring);
  outline-offset: 2px;
}
@keyframes rail-restore-in {
  from { opacity: 0; transform: translate(-6px, -50%); }
}
:root[data-theme='dark'] .rail-restore {
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.4), 0 10px 24px -16px rgb(0 0 0 / 0.85);
}
@media (prefers-reduced-motion: reduce) {
  .rail-restore { animation: none; }
}

/* ---------- 卡头 ---------- */
.eyebrow {
  position: relative;
  z-index: 2;
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--mk-fg-muted);
  letter-spacing: 0.03em;
  line-height: 1.1;
}
.eyebrow-ic {
  width: 14px;
  height: 14px;
  flex: none;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--desk-brand);
}
.eyebrow-right {
  margin-left: auto;
  font-weight: 500;
  font-size: 10.5px;
  color: var(--mk-fg-muted);
  opacity: 0.9;
  white-space: nowrap;
}
.linkish {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--mk-fg-muted);
  font: inherit;
  font-size: 10.5px;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.12s ease;
}
.linkish:hover { color: var(--mk-fg); }
.linkish:focus-visible { outline: var(--mk-focus-ring); outline-offset: 2px; border-radius: 4px; }

/* ---------- 徽章 ---------- */
.badge {
  --c: var(--desk-c-other);
  flex: none;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 11px;
  border: 1px solid color-mix(in srgb, var(--c) 32%, transparent);
  background: color-mix(in srgb, var(--c) 13%, transparent);
  color: var(--c);
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
  line-height: 1;
}
.badge.sm {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  font-size: 8px;
}
.badge.xs {
  width: 21px;
  height: 21px;
  border-radius: 6px;
  font-size: 7px;
}
.tone-md { --c: var(--desk-c-md); }
.tone-mh { --c: var(--desk-c-mh); }
.tone-code { --c: var(--desk-c-code); }
.tone-tpl { --c: var(--desk-c-mh); }
.tone-ws { --c: var(--desk-brand); }
.tone-doc { --c: var(--desk-c-doc); }
.tone-pdf { --c: var(--desk-c-pdf); }
.tone-img { --c: var(--desk-c-img); }
.tone-sheet { --c: var(--desk-c-sheet); }
.tone-other { --c: var(--desk-c-other); }

/* ---------- 继续写作 ---------- */
/* 左：正文信息；右：文档缩略。两栏共用卡内剩余高度，中间留 22px 呼吸 */
.cont-grid {
  position: relative;
  z-index: 2;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  gap: 22px;
  margin-top: 14px;
}
.cont-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  /* 左栏整体垂直居中：卡片比内容高时，余量上下均分，
     不再出现「摘要下面一大片空」或「按钮孤零零贴底」 */
  justify-content: center;
}
.doc {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.compact .doc { gap: 10px; }
.doc-main { min-width: 0; }
.doc-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.015em;
  line-height: 1.25;
  color: var(--mk-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.compact .doc-title { font-size: 18px; }
.ext {
  font-weight: 500;
  font-size: 14px;
  color: var(--mk-fg-muted);
}
.doc-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--mk-fg-muted);
  min-width: 0;
}
.crumb {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dot {
  flex: none;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.55;
}
.excerpt {
  position: relative;
  z-index: 2;
  margin: 13px 0 0;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--mk-fg-muted);
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-clamp: 4;
}
.excerpt-empty { opacity: 0.75; font-style: italic; }
/* 字数 / 阅读时长 / 最后编辑：紧贴摘要，把原文的空白填成有效信息 */
.cont-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 13px;
  font-size: 10.5px;
  color: var(--mk-fg-muted);
  font-variant-numeric: tabular-nums;
}
.compact .excerpt { -webkit-line-clamp: 2; }

/* 右栏文档纸卡：整卡可点（等同「继续写作」），悬停抬起 + 品牌描边。
   底色用 --mk-bg 而不是 panel，看起来才像「一张纸」压在卡片上 */
.paper {
  position: relative;
  flex: none;
  width: 238px;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 11px 12px 9px;
  border-radius: 11px;
  border: 1px solid var(--mk-border);
  background: var(--mk-bg);
  box-shadow: 0 12px 26px -16px rgb(16 24 40 / 0.5), 0 1px 2px rgb(16 24 40 / 0.06);
  /* 卡针要越过上边缘，不能被自身圆角裁掉；正文上滚由 .paper-text-wrap 自己裁 */
  overflow: visible;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
  transition: transform 0.24s cubic-bezier(0.2, 0.7, 0.2, 1), box-shadow 0.24s ease, border-color 0.2s ease;
}
.paper:hover {
  transform: translateY(-5px) rotate(-0.7deg);
  border-color: color-mix(in srgb, var(--desk-brand) 42%, var(--mk-border));
  box-shadow: 0 22px 40px -18px rgb(16 24 40 / 0.5), 0 6px 14px -9px rgb(16 24 40 / 0.22);
}
.paper:active { transform: translateY(-2px) rotate(-0.3deg); }
.paper:focus-visible { outline: var(--mk-focus-ring); outline-offset: 3px; }
:root[data-theme='dark'] .paper {
  box-shadow: 0 16px 32px -18px rgb(0 0 0 / 0.9), 0 1px 2px rgb(0 0 0 / 0.5);
}
:root[data-theme='dark'] .paper:hover {
  box-shadow: 0 26px 46px -20px rgb(0 0 0 / 0.95), 0 8px 18px -10px rgb(0 0 0 / 0.7);
}
.tight .paper { width: 202px; }
.compact .paper { width: 190px; }
/* 两列/单列档的卡片高度由内容决定，纸卡若不给上限，打字机打满 1600 字时
   正文的固有高度（~1600px）会把整张「继续写作」卡撑爆、页面被迫滚动。
   xl 档有栅格行高兜底，不需要这条。 */
.size-lg .paper,
.size-sm .paper { max-height: 300px; }
/* 同样两档里纸卡只剩一段窄窗格，打字机正文窗口压到两行高 */
.size-lg .paper-text-wrap,
.size-sm .paper-text-wrap { max-height: 40px; }
/* 卡针：金属夹体跨在上边缘，提手露在纸外，投影压在纸面上 */
.paper-pin {
  position: absolute;
  z-index: 3;
  top: -14px;
  left: 50%;
  width: 32px;
  height: 26px;
  transform: translateX(-50%) rotate(-3deg);
  filter: drop-shadow(0 3px 4px rgb(16 24 40 / 0.45));
  pointer-events: none;
}
.paper-pin svg {
  display: block;
  width: 100%;
  height: 100%;
}
/* 晴蓝 / 星蓝：别针换成印着码克 logo 的圆形徽章——长尾夹与徽章各画一组，
   只在两套蓝配色下切换显隐，其余配色仍是原来的金属长尾夹 */
.pin-badge { display: none; }
:root[data-palette='azure'] .paper-pin .pin-clip,
:root[data-palette='nebula'] .paper-pin .pin-clip { display: none; }
:root[data-palette='azure'] .paper-pin .pin-badge,
:root[data-palette='nebula'] .paper-pin .pin-badge { display: inline; }
:root[data-palette='azure'] .paper-pin,
:root[data-palette='nebula'] .paper-pin {
  filter: drop-shadow(0 3px 5px rgb(9 41 74 / 0.5));
}
.paper-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.paper-name {
  font-size: 10.5px;
  color: var(--mk-fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.paper-rule {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 9px;
  font-size: 8.5px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--mk-fg-muted);
  opacity: 0.8;
}
.paper-rule::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--mk-border);
}
.paper-body {
  flex: 1 1 auto;
  min-height: 0;
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.paper-title {
  flex: none;
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: -0.01em;
  color: var(--mk-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 正文窗口：高度随纸卡自适应，内容超出后由打字机整体上移 */
.paper-text-wrap {
  flex: 1 1 auto;
  min-height: 0;
  margin-top: 7px;
  overflow: hidden;
}
/* 上滚时顶边淡出，避免整行被硬切在窗口边缘 */
.paper-text-wrap.is-scrolled {
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14px);
  mask-image: linear-gradient(to bottom, transparent 0, #000 14px);
}
.paper-text {
  margin: 0;
  font-size: 10px;
  line-height: 1.7;
  color: var(--mk-fg-muted);
  /* 位移时长与打字节奏对齐（一行约 20 字 × 18ms），滚起来才连贯；淡入淡出与脚本 FADE_MS 一致 */
  transition: transform 360ms linear, opacity 240ms ease;
}
.paper-text.is-faded {
  opacity: 0;
}
.paper-text.is-rewind {
  transition: none;
}
/* 打字机光标：只在逐字输入时出现，打完自动消失 */
.paper-caret {
  display: inline-block;
  width: 5px;
  height: 11px;
  margin-left: 1px;
  border-radius: 1px;
  vertical-align: -1px;
  background: var(--desk-brand);
  animation: paper-caret-blink 1.05s steps(1, end) infinite;
}
@keyframes paper-caret-blink {
  0%,
  55% {
    opacity: 1;
  }
  56%,
  100% {
    opacity: 0;
  }
}
.compact .paper-text-wrap { display: none; }
/* 文件属性：两列（标签 / 值），值右对齐等宽数字，像文档信息栏 */
.paper-props {
  flex: none;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 2px 10px;
  margin-top: 8px;
  font-size: 9.5px;
  line-height: 15px;
}
.paper-props > div { display: contents; }
.paper-props span {
  color: var(--mk-fg-muted);
  opacity: 0.85;
  white-space: nowrap;
}
.paper-props b {
  font-weight: 500;
  color: var(--mk-fg);
  text-align: right;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.paper-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid var(--mk-border);
  font-size: 9.5px;
  color: var(--mk-fg-muted);
  font-variant-numeric: tabular-nums;
}
.actions {
  position: relative;
  z-index: 2;
  margin-top: 0;
  padding-top: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.compact .actions { padding-top: 10px; }

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 13px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--mk-fg);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, transform 0.14s ease, color 0.14s ease;
}
.btn .ico {
  width: 14px;
  height: 14px;
  flex: none;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.btn:focus-visible {
  outline: var(--mk-focus-ring);
  outline-offset: 2px;
}
.btn.primary {
  background: linear-gradient(180deg, var(--desk-brand), color-mix(in srgb, var(--desk-brand) 72%, var(--desk-brand-deep)));
  /* 星蓝配色的顶色更亮，白字会掉到 3:1 以下——由 palette 提供 --desk-brand-fg 换深墨字 */
  color: var(--desk-brand-fg, #fff);
  box-shadow: 0 8px 18px -10px var(--desk-brand);
}
.btn.primary:hover { transform: translateY(-1px); }
/* 「继续 XX」按钮：一道水波似的柔光从左扫到右，扫完停一会儿再重来 */
.c-continue .actions .btn.primary {
  position: relative;
  overflow: hidden;
}
.c-continue .actions .btn.primary::after {
  content: '';
  position: absolute;
  top: -40%;
  bottom: -40%;
  left: 0;
  width: 46%;
  background: linear-gradient(
    100deg,
    transparent 0%,
    rgb(255 255 255 / 0.3) 40%,
    rgb(255 255 255 / 0.08) 56%,
    transparent 100%
  );
  transform: translateX(-130%) skewX(-12deg);
  animation: desk-btn-wave 3.2s cubic-bezier(0.4, 0, 0.25, 1) infinite;
  pointer-events: none;
}
@keyframes desk-btn-wave {
  0% {
    transform: translateX(-130%) skewX(-12deg);
  }
  38% {
    transform: translateX(300%) skewX(-12deg);
  }
  100% {
    transform: translateX(300%) skewX(-12deg);
  }
}
.btn.ghost { color: var(--mk-fg-muted); }
.btn.ghost:hover { background: var(--mk-hover); color: var(--mk-fg); }
.btn.outline { border-color: var(--mk-border); }
.btn.outline:hover { border-color: var(--mk-border-strong); background: var(--mk-hover); }
.btn.icon-only {
  width: 32px;
  padding: 0;
  border-color: var(--mk-border);
  color: var(--mk-fg-muted);
}
.btn.icon-only:hover { color: var(--mk-fg); border-color: var(--mk-border-strong); background: var(--mk-hover); }
.save-state {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--mk-fg-muted);
  white-space: nowrap;
}
.compact .save-state { display: none; }
/* 偏窄的 xl（侧栏展开后最常见）：操作行必须保持单行，保存状态让位 */
.tight .save-state { display: none; }
.tight .cont-grid { gap: 16px; }

.empty {
  position: relative;
  z-index: 2;
  /* flex:1 1 auto（不是 flex:1）：单列档卡片高度不定，basis 0 会塌成 0 */
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 6px 0 8px;
}
.empty-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--mk-fg);
}
.empty-hint {
  margin: 5px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--mk-fg-muted);
}.empty .actions { padding-top: 12px; margin-top: 0; }

/* ---------- 新建 ---------- */
/* 工作区两件并入同一栅格：6 张磁贴（2 列 × 3 行），高度够就一直带描述，
   不再退化成文字链——实测 1080×667 也有富余（飞总 2026-10-23 第 1 条） */
.new-grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: minmax(0, 1fr);
  gap: 9px;
  margin-top: 12px;
}
.compact .new-grid { gap: 7px; margin-top: 9px; }
.new-tile {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  min-height: 0;
  padding: 9px 11px;
  border: 1px solid var(--mk-border);
  border-radius: 10px;
  background: var(--mk-bg);
  background: color-mix(in srgb, var(--mk-bg) 55%, transparent);
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease, transform 0.16s ease;
}
.new-tile:hover {
  border-color: color-mix(in srgb, var(--desk-brand) 45%, var(--mk-border));
  background: var(--mk-panel);
  transform: translateY(-1px);
}
.new-tile:focus-visible { outline: var(--mk-focus-ring); outline-offset: 2px; }
.new-ico {
  --c: var(--desk-c-md);
  position: relative;
  z-index: 1;
  flex: none;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--c) 14%, transparent);
  color: var(--c);
}
/* 磁贴图标色调：模板=紫、工作区=品牌蓝，与文件类型色区分开 */
.new-ico.tone-tpl { --c: var(--desk-c-mh); }
.new-ico.tone-ws { --c: var(--desk-brand); }
.new-txt {
  position: relative;
  z-index: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.new-label {
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--mk-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.new-sub {
  font-size: 10.5px;
  line-height: 1.25;
  color: var(--mk-fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 悬停水印：右下角的类型缩写。墨色由左上向右下淡开，像压进纸面的暗纹，
   平时完全隐形，不占位也不挡点击 */
.new-mark {
  position: absolute;
  right: 10px;
  bottom: 4px;
  z-index: 0;
  font-size: 23px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.02em;
  color: color-mix(in srgb, var(--c, var(--desk-brand)) 26%, transparent);
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 0.22s ease, transform 0.28s cubic-bezier(0.22, 0.8, 0.3, 1);
  pointer-events: none;
  user-select: none;
}
@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .new-mark {
    background-image: linear-gradient(
      155deg,
      color-mix(in srgb, var(--c, var(--desk-brand)) 44%, transparent),
      color-mix(in srgb, var(--c, var(--desk-brand)) 8%, transparent)
    );
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
}
.new-tile:hover .new-mark,
.new-tile:focus-visible .new-mark {
  opacity: 1;
  transform: translateY(0);
}
.compact .new-mark { right: 8px; bottom: 3px; font-size: 18px; }
.compact .new-label { font-size: 12px; }
.compact .new-sub { font-size: 10px; }
.compact .new-ico { width: 26px; height: 26px; border-radius: 8px; }
.compact .new-tile { padding: 6px 9px; gap: 8px; }
.tpl-wrap { position: relative; display: flex; min-height: 0; }
.tpl-wrap .new-tile { flex: 1; }
.tpl-menu {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 6;
  padding: 5px;
  border: 1px solid var(--mk-border-strong);
  border-radius: 9px;
  background: var(--mk-panel);
  box-shadow: var(--mk-shadow-pop);
}
@keyframes tpl-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
.tpl-item {
  display: block;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--mk-fg);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.tpl-item:hover { background: var(--mk-hover); }
.tpl-item:focus-visible { outline: var(--mk-focus-ring); outline-offset: -2px; }
.tpl-none {
  margin: 0;
  padding: 7px 9px;
  font-size: 11px;
  color: var(--mk-fg-muted);
}

/* ---------- 最近打开 ---------- */
/* 20 条全量渲染、超出滚动，但不显示滚动条（飞总 2026-10-23）：
   滚轮/触控板照常滚，视觉上仍是一张干净的卡片 */
.recent-list {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-top: 8px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.recent-list::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}
.recent-row {
  flex: 0 0 auto;
  height: 42px;
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 4px 7px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: background 0.12s ease;
}
.recent-row:hover { background: var(--mk-hover); }
.recent-row:focus-visible { outline: var(--mk-focus-ring); outline-offset: -2px; }
.row-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row-name {
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.15;
  color: var(--mk-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-path {
  font-size: 10px;
  line-height: 1.1;
  color: var(--mk-fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-time {
  font-size: 10px;
  color: var(--mk-fg-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.compact .row-path { display: none; }
.compact .recent-row { max-height: none; padding: 2px 7px; }

/* ---------- 工作区 ---------- */
.ws-switch-wrap { position: relative; margin-left: auto; }
.ws-switch {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 7px;
  border: 1px solid var(--mk-border);
  border-radius: 6px;
  background: transparent;
  color: var(--mk-fg-muted);
  font: inherit;
  font-size: 10px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}
.ws-switch:hover { background: var(--mk-hover); color: var(--mk-fg); border-color: var(--mk-border-strong); }
.ws-switch:focus-visible { outline: var(--mk-focus-ring); outline-offset: 2px; }
.chev {
  width: 11px;
  height: 11px;
  flex: none;
  stroke: currentColor;
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 0.15s ease;
}
.ws-switch[aria-expanded='true'] .chev { transform: rotate(180deg); }
/* 向上开：工作区卡在底行，向下展开会被 .desk-body 的 overflow:hidden 裁掉
   （飞总反馈「切换没效果」，实际是菜单被裁、只剩「当前工作区」露在外面） */
.ws-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 5px);
  z-index: 6;
  width: 258px;
  max-height: 264px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
  -ms-overflow-style: none;
  padding: 6px;
  border: 1px solid var(--mk-border-strong);
  border-radius: 9px;
  background: var(--mk-panel);
  box-shadow: var(--mk-shadow-pop);
}
.ws-menu::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}
.ws-menu-label {
  padding: 4px 7px 3px;
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--mk-fg-muted);
  opacity: 0.85;
}
.ws-menu-cur {
  padding: 0 7px 4px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--mk-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-menu-item {
  display: block;
  width: 100%;
  padding: 5px 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.ws-menu-item:hover { background: var(--mk-hover); }
.ws-menu-item:focus-visible { outline: var(--mk-focus-ring); outline-offset: -2px; }
.ws-menu-item.plain {
  font-size: 11.5px;
  color: var(--mk-fg);
  padding: 6px 7px;
}
.ws-mi-name {
  display: block;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--mk-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-mi-path {
  display: block;
  margin-top: 1px;
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 9px;
  color: var(--mk-fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-menu-sep {
  height: 1px;
  margin: 5px 0;
  background: var(--mk-border);
}
.ws-name {
  margin-top: 13px;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.2;
  color: var(--mk-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-path {
  margin-top: 4px;
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 9.5px;
  line-height: 1.3;
  color: var(--mk-fg-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-stats {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin-top: 11px;
  font-size: 10.5px;
  color: var(--mk-fg-muted);
  white-space: nowrap;
}
.ws-stats strong {
  font-size: 14px;
  font-weight: 700;
  color: var(--mk-fg);
  letter-spacing: -0.01em;
}
.ws-stats .gap { margin: 0 4px; }
.comp-bar {
  display: flex;
  gap: 2px;
  height: 7px;
  margin-top: 9px;
  border-radius: 99px;
  background: var(--mk-panel-muted);
}
/* 段宽由脚本按段数均摊扣掉 gap 份额（见 compSegInset）：总宽恰好等于轨道，
   不溢出不缩缝；悬停只做竖向放大，宽度不受影响 */
.comp-bar i {
  position: relative;
  display: block;
  flex: 0 0 auto;
  height: 100%;
  border-radius: 99px;
  min-width: 2px;
  transform-origin: center;
  transition: transform 0.18s ease, filter 0.18s ease;
}
/* 7px 高的段太细，用伪元素把命中区上下各撑 5px，不用瞄准 */
.comp-bar i::before {
  content: '';
  position: absolute;
  inset: -5px 0;
}
.comp-bar i.on {
  transform: scaleY(1.55);
  filter: saturate(1.18) brightness(1.06);
  animation: comp-seg-bump 0.36s cubic-bezier(0.22, 0.9, 0.28, 1.15);
}
@keyframes comp-seg-bump {
  0% { transform: scaleY(1); }
  45% { transform: scaleY(1.95); }
  100% { transform: scaleY(1.55); }
}
.comp-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 9px;
  margin-top: 7px;
  font-size: 9.5px;
  line-height: 1.2;
  color: var(--mk-fg-muted);
}
.comp-legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  transition: color 0.18s ease;
}
.comp-legend span.on { color: var(--mk-fg); }
.comp-legend i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  flex: none;
  transition: transform 0.2s cubic-bezier(0.22, 0.9, 0.28, 1.15), box-shadow 0.2s ease;
}
.comp-legend span.on i {
  transform: scale(1.7);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--mk-fg) 12%, transparent);
}
.ws-recent {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid var(--mk-border);
  overflow: hidden;
}
.mini-label {
  flex: none;
  font-size: 9px;
  letter-spacing: 0.05em;
  color: var(--mk-fg-muted);
  margin-bottom: 5px;
  opacity: 0.9;
}
.mini-row {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 19px;
  font-size: 10px;
  color: var(--mk-fg-muted);
}
.mini-row span:first-child {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--mk-fg);
  opacity: 0.85;
}
.mini-row span:last-child { flex: none; font-variant-numeric: tabular-nums; }

/* ---------- 近 7 天 ---------- */
.week-num {
  display: flex;
  align-items: baseline;
  gap: 5px;
  margin-top: 14px;
}
.week-num strong {
  font-size: 34px;
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1;
  color: var(--mk-fg);
  font-variant-numeric: tabular-nums;
}
.week-num span {
  font-size: 10.5px;
  color: var(--mk-fg-muted);
  white-space: nowrap;
}
.compact .week-num { margin-top: 9px; }
.compact .week-num strong { font-size: 26px; }
.week-chart {
  flex: 1;
  min-height: 72px;
  display: flex;
  align-items: flex-end;
  gap: 6px;
  margin-top: 12px;
}
.compact .week-chart { min-height: 46px; margin-top: 9px; }
.bar-col {
  flex: 1;
  height: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
}
.bar-track {
  position: relative;
  width: 100%;
  max-width: 20px;
  flex: 1;
  display: flex;
  align-items: flex-end;
  border-radius: 5px;
  background: var(--mk-panel-muted);
  transition: background-color 0.18s ease;
}
.bar-fill {
  width: 100%;
  border-radius: 5px;
  background: color-mix(in srgb, var(--desk-brand) 45%, transparent);
  transform-origin: bottom;
  transition: filter 0.18s ease;
}
.bar-col.today .bar-fill {
  background: linear-gradient(180deg, var(--desk-brand), color-mix(in srgb, var(--desk-brand) 68%, var(--desk-brand-deep)));
}
/* 悬停：整轨淡染 + 柱体提亮回弹，柱顶浮出当日改动数 */
.bar-col:hover .bar-track {
  background: color-mix(in srgb, var(--desk-brand) 10%, var(--mk-panel-muted));
}
.bar-col:hover .bar-fill {
  filter: saturate(1.2) brightness(1.08);
  animation: bar-bump 0.36s cubic-bezier(0.22, 0.9, 0.28, 1.15);
}
.bar-val {
  position: absolute;
  left: 50%;
  /* 贴着柱顶内侧；空柱夹到轨道底部，满柱夹在轨内，避免溢出到上方数字区 */
  bottom: clamp(0px, calc(var(--h, 0%) - 16px), calc(100% - 16px));
  padding: 1px 4px;
  border-radius: 5px;
  background: var(--mk-panel);
  border: 1px solid var(--mk-border);
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--mk-fg);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transform: translate(-50%, 2px) scale(0.9);
  transition: opacity 0.16s ease, transform 0.2s cubic-bezier(0.22, 0.8, 0.3, 1);
}
.bar-col:hover .bar-val {
  opacity: 1;
  transform: translate(-50%, 0) scale(1);
}
.bar-day {
  font-size: 9.5px;
  line-height: 1;
  color: var(--mk-fg-muted);
  transition: color 0.16s ease;
}
.bar-col:hover .bar-day { color: var(--mk-fg); }
.bar-col.today .bar-day { color: var(--mk-fg); font-weight: 600; }
@keyframes bar-bump {
  0% { transform: scaleY(1); }
  38% { transform: scaleY(0.9); }
  100% { transform: scaleY(1); }
}
@media (prefers-reduced-motion: reduce) {
  .bar-col:hover .bar-fill { animation: none; }
  .c-continue .actions .btn.primary::after { animation: none; opacity: 0; }
  .comp-bar i.on { animation: none; }
  .bar-fill,
  .bar-val,
  .bar-day,
  .bar-track,
  .new-mark,
  .comp-bar i,
  .comp-legend span,
  .comp-legend i { transition: none; }
}
.week-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 11px;
  font-size: 10px;
  color: var(--mk-fg-muted);
}
.pulse {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--mk-ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--mk-ok) 16%, transparent);
}

/* ---------- 页脚 ---------- */
/* 左：署名 / 中：版本与更新状态 / 右：引擎说明。
   三栏用 1fr auto 1fr，版本才能真正落在整条带宽的中线，而不是被左右两端拽偏 */
.foot {
  flex: none;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  column-gap: 10px;
  margin-top: 10px;
  font-size: 10px;
  color: var(--mk-fg-muted);
}
.compact .foot { margin-top: 7px; }
.foot-design {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  color: inherit;
  text-decoration: none;
  border-radius: 4px;
  opacity: 0.82;
  transition: color 0.18s ease, opacity 0.18s ease;
}
.foot-design:hover { color: var(--desk-brand); opacity: 1; }
.foot-design:focus-visible {
  /* 先给实色兜底：macOS 12.x 的 WKWebView 有 :focus-visible 但还没 color-mix */
  outline: 2px solid var(--desk-brand);
  outline-offset: 2px;
  outline: 2px solid color-mix(in srgb, var(--desk-brand) 55%, transparent);
}
.foot-design-txt {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 小星标：双星叠出层次，渐变跟主题品牌色走（老 WebKit 不认 color-mix 时退回纯品牌色） */
.foot-design-ic {
  flex: none;
  width: 11px;
  height: 11px;
  transition: transform 0.25s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.foot-design-ic .st-a { stop-color: var(--desk-brand); }
.foot-design-ic .st-b { stop-color: var(--desk-brand); }
.foot-design-ic .st-b { stop-color: color-mix(in srgb, var(--desk-brand) 52%, #86d3ff); }
.foot-design:hover .foot-design-ic { transform: rotate(-14deg) scale(1.08); }
/* 双星各闪各的：主星先暗一下再亮回来，小星错开半拍，像真的在眨眼 */
.foot-design-ic path {
  transform-box: fill-box;
  transform-origin: 50% 50%;
  animation: foot-star-twinkle 3.6s cubic-bezier(0.45, 0, 0.55, 1) infinite;
}
.foot-design-ic .st-mini {
  --foot-star-peak: 0.62;
  --foot-star-low: 0.18;
  opacity: 0.62;
  animation-delay: 0.55s;
}
@keyframes foot-star-twinkle {
  0%, 100% { opacity: var(--foot-star-peak, 1); transform: scale(1); }
  8% { opacity: var(--foot-star-low, 0.3); transform: scale(0.72); }
  18% { opacity: var(--foot-star-peak, 1); transform: scale(1.06); }
  28% { opacity: calc(var(--foot-star-peak, 1) * 0.62); transform: scale(0.94); }
  38% { opacity: var(--foot-star-peak, 1); transform: scale(1.02); }
  55% { opacity: calc(var(--foot-star-peak, 1) * 0.92); transform: scale(1); }
}
/* 静止偏好要把动效关干净；这条必须写在动画规则之后，否则同权重会被上面的 animation 盖回去 */
@media (prefers-reduced-motion: reduce) {
  .foot-design-ic { transition: none; }
  .foot-design:hover .foot-design-ic { transform: none; }
  .foot-design-ic path { animation: none; }
}
.foot-status {
  justify-self: center;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}
.ok-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--mk-ok);
  box-shadow: 0 0 7px -1px var(--mk-ok);
}
.foot-ver { white-space: nowrap; }
.foot-right {
  justify-self: end;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
}
.size-sm .foot-right { display: none; }
.size-sm .brand-sub { display: none; }
.size-sm .search-pill { min-width: 0; }

/* 老 WebKit（Safari 16.2 以前）不认 color-mix：主按钮的渐变与柱状图会整条声明失效，
   前者留下白字透明底、后者留下看不见的柱子。这里只兜关键三处，其余淡色描边丢了无碍 */
@supports not (background: color-mix(in srgb, red 50%, transparent)) {
  .btn.primary { background: var(--desk-brand); }
  .bar-fill { background: var(--desk-brand); opacity: 0.45; }
  .bar-col.today .bar-fill { opacity: 1; }
}
.size-sm .search-txt { display: none; }
</style>
