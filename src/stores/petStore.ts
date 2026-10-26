import { defineStore } from 'pinia';
import type { EditorMode, PetTipsLevel } from '../api/types';
import { useI18n } from '../i18n';
import { useSettingsStore } from './settingsStore';

export type { PetTipsLevel };

/**
 * 码猫的共享状态：书桌位与编辑器浮层位各有自己的 DOM，但表情、气泡、计时、
 * 提醒与提示限流只有这一份——两个实例同时挂载时也不会双响。
 */
export type PetMood = 'idle' | 'happy' | 'greet' | 'sleepy' | 'focus' | 'think' | 'read' | 'alert';

export interface PetContext {
  /** 标签 id：两篇「未命名」名字相同、路径同为空，只靠 id 才能分清换没换文档 */
  tabId: string;
  hasDoc: boolean;
  name: string;
  path: string;
  mode: EditorMode;
  dirty: boolean;
  autoSave: boolean;
  hasPath: boolean;
  wordCount: number;
  heading: string;
  progress: number;
}

export interface PetTip {
  key: string;
  params?: Record<string, string | number>;
  /** 1 = 功能小贴士，2 = 常规陪读/保存提醒，3 = 保存失败这类高优先级 */
  priority?: 1 | 2 | 3;
  cooldownMs?: number;
  onceKey?: string;
  kind?: 'info' | 'warn' | 'ok';
  mood?: PetMood;
  ms?: number;
  minGapMs?: number;
}

const NAP_AFTER = 30_000;
const THINK_TO_SLEEP = 4.5 * 60_000;
const FOCUS_BACK = 6_000;
const READ_BACK = 8_000;
const READ_REST = 8 * 60_000;
const TIP_GAP: Record<PetTipsLevel, number> = { quiet: 180_000, normal: 60_000, chatty: 45_000 };
const FEATURE_GAP = 10 * 60_000;

let saySeq = 0;
let sayTimer = 0;
let backTimer = 0;
let napTimer = 0;
let deepNapTimer = 0;
let stuckTimer = 0;
let readIdleTimer = 0;
let readTipTimer = 0;
let readBarTimer = 0;
let focusTimer = 0;
let flushTimer = 0;
let leanTimer = 0;
let quietTimer = 0;
let writeTimer = 0;
let dirtyTimer = 0;
let remindTimer = 0;
let lastFireAt = 0;
let writeSessionStart = 0;
let readIntroDone = false;
let hosts = 0;
let listenersOn = false;
let clickTimes: number[] = [];
let lastHoverAt = 0;
const lastPoolIdx: Record<string, number> = {};

const HALF_ANCHORS = [1, 31];

function short(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export const usePetStore = defineStore('pet', {
  state: () => ({
    mood: 'idle' as PetMood,
    bubble: '',
    bubbleKind: 'info' as 'info' | 'warn' | 'ok',
    hopSeq: 0,
    /** 阅读滚动方向：-1 上 / 1 下，用来让身体轻轻跟着倾一下 */
    lean: 0,
    quietUntil: 0,
    quietActive: false,
    hostVisible: false,
    blocked: false,
    context: {
      tabId: '',
      hasDoc: false,
      name: '',
      path: '',
      mode: 'edit',
      dirty: false,
      autoSave: false,
      hasPath: false,
      wordCount: 0,
      heading: '',
      progress: 0,
    } as PetContext,
    docKey: '',
    readFlags: { half: false, end: false },
    /** 写作里程桶：每 500 字一档，跨档才提示一次 */
    wordBucket: 0,
    manualSaves: 0,
    lastInputAt: 0,
    lastReadingAt: 0,
    lastTipAt: 0,
    lastFeatureAt: 0,
    moodLockUntil: 0,
    cooldowns: {} as Record<string, number>,
    seen: [] as string[],
    pending: [] as PetTip[],
  }),
  actions: {
    // ------------------------------------------------------------ 宿主生命周期
    attachHost() {
      hosts += 1;
      if (hosts > 1) return;
      this.hostVisible = true;
      this.syncSeen();
      document.documentElement.classList.add('pet-docked');
      this.bindGlobalListeners();
      /* 静音是跨实例的（欢迎页设的 30 分钟，进编辑器后仍算数）：卸载时计时器被清掉，
         这里按剩余时间续上，顺便把已经过期的那一档复位 */
      if (this.quietUntil > Date.now()) {
        this.quietActive = true;
        quietTimer = window.setTimeout(() => {
          quietTimer = 0;
          this.quietActive = false;
        }, this.quietUntil - Date.now());
      } else {
        this.quietActive = false;
      }
      this.resetNap();
      this.scheduleRemind();
      this.scheduleFlush(900);
    },
    detachHost() {
      hosts = Math.max(0, hosts - 1);
      if (hosts > 0) return;
      this.hostVisible = false;
      document.documentElement.classList.remove('pet-docked');
      this.unbindGlobalListeners();
      this.clearTimers();
      this.bubble = '';
    },
    syncSeen() {
      const list = useSettingsStore().settings.petTipsSeen;
      if (Array.isArray(list)) this.seen = [...list];
    },
    bindGlobalListeners() {
      if (listenersOn) return;
      listenersOn = true;
      window.addEventListener('pointerdown', onPresence, true);
      window.addEventListener('wheel', onPresence, { capture: true, passive: true });
      window.addEventListener('keydown', onPresence, true);
      document.addEventListener('visibilitychange', onVisibility);
    },
    unbindGlobalListeners() {
      if (!listenersOn) return;
      listenersOn = false;
      window.removeEventListener('pointerdown', onPresence, true);
      window.removeEventListener('wheel', onPresence, true);
      window.removeEventListener('keydown', onPresence, true);
      document.removeEventListener('visibilitychange', onVisibility);
    },
    clearTimers() {
      for (const id of [
        sayTimer, backTimer, napTimer, deepNapTimer, stuckTimer, readIdleTimer, readTipTimer, readBarTimer,
        focusTimer, flushTimer, leanTimer, quietTimer, writeTimer, dirtyTimer, remindTimer,
      ]) window.clearTimeout(id);
      sayTimer = backTimer = napTimer = deepNapTimer = stuckTimer = readIdleTimer = readTipTimer = 0;
      readBarTimer = focusTimer = flushTimer = leanTimer = quietTimer = writeTimer = dirtyTimer = remindTimer = 0;
    },
    pause() {
      window.clearTimeout(napTimer);
      window.clearTimeout(deepNapTimer);
      window.clearTimeout(stuckTimer);
      window.clearTimeout(readIdleTimer);
      window.clearTimeout(writeTimer);
      window.clearTimeout(dirtyTimer);
      window.clearTimeout(remindTimer);
      napTimer = deepNapTimer = stuckTimer = readIdleTimer = writeTimer = dirtyTimer = remindTimer = 0;
    },
    resume() {
      this.resetNap();
      this.scheduleRemind();
      this.scheduleFlush(1200);
    },

    // ------------------------------------------------------------ 气泡与表情
    say(text: string, ms = 4200, kind: 'info' | 'warn' | 'ok' = 'info') {
      if (!text) return;
      this.bubble = text;
      this.bubbleKind = kind;
      const token = ++saySeq;
      window.clearTimeout(sayTimer);
      sayTimer = window.setTimeout(() => {
        if (token === saySeq) this.bubble = '';
      }, ms);
    },
    dismissBubble() {
      saySeq += 1;
      this.bubble = '';
    },
    hop() {
      this.hopSeq += 1;
    },
    react(mood: PetMood, ms = 2200, lock = true) {
      window.clearTimeout(backTimer);
      this.mood = mood;
      this.moodLockUntil = lock ? Date.now() + ms : this.moodLockUntil;
      backTimer = window.setTimeout(() => {
        if (this.mood === mood) this.mood = 'idle';
      }, ms);
    },
    /** 悬停/离开不走固定时长：指针在上面时保持举爪，移开才收 */
    hover(continueName?: string) {
      const now = Date.now();
      if (now - lastHoverAt < 900) return;
      lastHoverAt = now;
      this.resetNap();
      /* 炸毛期间不抢：保存失败的说明还挂在气泡上，那 5 秒的表情计时也不能清 */
      if (this.mood === 'alert') return;
      window.clearTimeout(backTimer);
      if (this.mood !== 'happy') this.mood = 'greet';
      this.say(this.hoverText(continueName), 4200);
    },
    leave() {
      /* 炸毛时气泡是保存失败的说明，移开指针不能把它一起收掉 */
      if (this.mood === 'alert') return;
      if (this.mood === 'happy') {
        backTimer = window.setTimeout(() => {
          if (this.mood === 'happy') this.mood = 'idle';
        }, 600);
        return;
      }
      this.mood = 'idle';
      this.dismissBubble();
    },
    hoverText(continueName?: string): string {
      const { t } = useI18n();
      const c = this.context;
      if (c.hasDoc) {
        if (c.mode === 'read' && c.heading) return t('pet.hoverRead', { heading: short(c.heading, 10) });
        if (c.dirty && !c.autoSave) return t('pet.hoverDirty', { name: short(c.name, 16) });
        return t('pet.hoverSaved', { name: short(c.name, 16), n: c.wordCount.toLocaleString() });
      }
      if (continueName) return t('pet.backTo', { name: short(continueName, 16) });
      return t('pet.deskGreet');
    },
    press() {
      const now = Date.now();
      this.resetNap();
      clickTimes = clickTimes.filter((at) => now - at < 1300);
      clickTimes.push(now);
      if (clickTimes.length >= 3) {
        clickTimes = [];
        this.react('happy', 2600);
        this.hop();
        this.say(useI18n().t('pet.stopPoking'), 3000);
        return;
      }
      this.react('happy', 2200);
      this.hop();
      this.say(this.socialLine(), 4200);
    },
    longPress() {
      this.resetNap();
      this.react('happy', 2800);
      this.hop();
      this.say(useI18n().t('pet.purr'), 3200, 'ok');
    },
    socialLine(): string {
      const c = this.context;
      const keys: string[] = [];
      if (c.hasDoc && c.dirty && !c.autoSave && c.mode !== 'read') keys.push('pet.linesSave', 'pet.linesSave');
      if (c.mode === 'read' && c.hasDoc) keys.push('pet.linesRead', 'pet.linesRead');
      else if (c.hasDoc) keys.push('pet.linesWrite', 'pet.linesWrite');
      keys.push('pet.lines');
      const key = keys[Math.floor(Math.random() * keys.length)] ?? 'pet.lines';
      return this.pickPool(key) ?? useI18n().t('pet.deskGreet');
    },
    pickPool(key: string, params?: Record<string, string | number>): string | null {
      const list = useI18n().tList(key);
      if (!list.length) return null;
      let i = Math.floor(Math.random() * list.length);
      if (list.length > 1 && i === lastPoolIdx[key]) i = (i + 1) % list.length;
      lastPoolIdx[key] = i;
      return applyParams(list[i], params);
    },

    // ------------------------------------------------------------ 上下文与活动
    setContext(patch: Partial<PetContext>) {
      const next = { ...this.context, ...patch };
      const key = `${next.tabId}|${next.path}|${next.name}`;
      const docChanged = key !== this.docKey;
      const prevDirty = this.context.dirty;
      const prevMode = this.context.mode;

      if (docChanged) {
        next.heading = '';
        next.progress = 0;
        this.resetDoc(next);
      }
      this.context = next;
      this.docKey = key;

      if (next.mode === 'read' && prevMode !== 'read') {
        this.enterRead();
      } else if (next.mode !== 'read' && prevMode === 'read') {
        this.leaveRead();
      }

      if (!prevDirty && next.dirty) this.scheduleDirty();
      else if (prevDirty && !next.dirty) window.clearTimeout(dirtyTimer);

      if (!docChanged) {
        /* 只认用户改出来的字数：切文档/恢复会话时引擎会从 0 补报到全文，
           那不是「又多了 500 字」 */
        const bucket = Math.floor(next.wordCount / 500);
        if (next.dirty && bucket > this.wordBucket) {
          this.wordBucket = bucket;
          this.queueTip({ key: 'milestone', priority: 2, cooldownMs: 2 * 60_000 });
        } else if (bucket > this.wordBucket) {
          this.wordBucket = bucket;
        }
        if (next.wordCount >= 3000 && !this.seen.includes('feature.outline')) {
          this.queueTip({ key: 'outline', priority: 1, onceKey: 'feature.outline' });
        }
      }
      this.resetNap();
    },
    resetDoc(next: PetContext) {
      window.clearTimeout(dirtyTimer);
      window.clearTimeout(writeTimer);
      window.clearTimeout(readTipTimer);
      window.clearTimeout(readIdleTimer);
      window.clearTimeout(readBarTimer);
      readIdleTimer = 0;
      readBarTimer = 0;
      this.pending = [];
      this.readFlags = { half: false, end: false };
      this.wordBucket = Math.floor(next.wordCount / 500);
      this.manualSaves = 0;
      writeSessionStart = 0;
      if (this.mood !== 'alert') this.mood = 'idle';
      this.dismissBubble();
    },
    setHeading(text: string) {
      this.context.heading = text;
    },
    notifyInput() {
      const now = Date.now();
      this.lastInputAt = now;
      if (!this.context.hasDoc) {
        this.resetNap();
        return;
      }
      if (now > this.moodLockUntil && this.context.mode !== 'read') this.mood = 'focus';
      window.clearTimeout(focusTimer);
      focusTimer = window.setTimeout(() => {
        if (this.mood === 'focus') this.mood = 'idle';
        this.flushPending();
      }, FOCUS_BACK);
      if (!writeSessionStart) {
        writeSessionStart = now;
        this.queueTip({ key: 'startWrite', priority: 2, cooldownMs: 30 * 60_000 });
        this.scheduleWrite25();
      }
      this.resetNap();
    },
    notePresence() {
      if (this.mood === 'sleepy' || this.mood === 'think') this.mood = 'idle';
      this.resetNap();
      this.scheduleFlush(1400);
    },
    resetNap() {
      /* 阅读休息计时从「开始阅读」算满 8 分钟：滚动只该续发呆/卡稿计时，
         不能把这个计时清零又不补，否则一直滚就永远等不到休息提醒 */
      const reading = !!readIdleTimer;
      window.clearTimeout(napTimer);
      window.clearTimeout(deepNapTimer);
      window.clearTimeout(stuckTimer);
      if (!reading) {
        window.clearTimeout(readIdleTimer);
        readIdleTimer = 0;
      }
      if (!this.hostVisible || document.hidden) return;
      if (!this.context.hasDoc) {
        napTimer = window.setTimeout(() => {
          if (this.mood === 'idle' && Date.now() > this.moodLockUntil) this.mood = 'sleepy';
        }, NAP_AFTER);
        return;
      }
      napTimer = window.setTimeout(() => {
        if (this.mood === 'idle' && Date.now() > this.moodLockUntil) {
          this.mood = this.context.mode === 'read' ? 'idle' : 'think';
        }
        stuckTimer = window.setTimeout(() => this.maybeStuck(), 90_000);
        deepNapTimer = window.setTimeout(() => {
          if (this.mood === 'idle' || this.mood === 'think') this.mood = 'sleepy';
        }, THINK_TO_SLEEP);
      }, NAP_AFTER);
      if (this.context.mode === 'read' && !reading) {
        readIdleTimer = window.setTimeout(() => {
          readIdleTimer = 0;
          if (this.context.mode === 'read') {
            this.emitTip({
              key: 'eyeRest', priority: 2, cooldownMs: 15 * 60_000, mood: 'greet', ms: 3600,
            });
          }
        }, READ_REST);
      }
    },
    maybeStuck() {
      if (!this.context.hasDoc || this.context.mode === 'read') return;
      if (!document.hasFocus()) return;
      if (Date.now() - this.lastInputAt < 120_000) return;
      this.emitTip({ key: 'stuck', priority: 2, cooldownMs: 20 * 60_000, mood: 'think', ms: 3200 });
    },
    scheduleWrite25() {
      window.clearTimeout(writeTimer);
      writeTimer = window.setTimeout(() => {
        writeTimer = 0;
        if (!this.context.hasDoc) return;
        if (Date.now() - this.lastInputAt > 10 * 60_000) {
          writeSessionStart = 0;
          return;
        }
        this.emitTip({ key: 'write25', priority: 2, cooldownMs: 20 * 60_000, mood: 'greet', ms: 3600 });
        writeSessionStart = Date.now();
        this.scheduleWrite25();
      }, 25 * 60_000);
    },
    scheduleDirty() {
      window.clearTimeout(dirtyTimer);
      const c = this.context;
      // 自动保存开着且有落盘路径时不需要催；未命名文档自动保存也不会写盘
      if (c.autoSave && c.hasPath) return;
      dirtyTimer = window.setTimeout(() => {
        dirtyTimer = 0;
        if (!this.context.dirty) return;
        if (Date.now() - this.lastInputAt < 3000) {
          this.scheduleDirty();
          return;
        }
        this.emitTip({
          key: this.context.hasPath ? 'unsaved' : 'untitled',
          priority: 2,
          cooldownMs: 5 * 60_000,
          mood: 'greet',
          ms: 3800,
        });
      }, c.hasPath ? 90_000 : 60_000);
    },

    // ------------------------------------------------------------ 阅读
    enterRead() {
      this.lastReadingAt = Date.now();
      /* 表情立刻换成阅读态：首次进入那句提示要排队等全局间隔，不能让猫先愣在 idle */
      if (this.mood !== 'alert') {
        window.clearTimeout(backTimer);
        this.mood = 'read';
      }
      if (!readIntroDone) {
        readIntroDone = true;
        this.queueTip({ key: 'enterRead', priority: 2, cooldownMs: 0, mood: 'read', ms: 4200 });
      }
      if (!this.seen.includes('feature.previewBar')) {
        window.clearTimeout(readBarTimer);
        readBarTimer = window.setTimeout(() => {
          readBarTimer = 0;
          this.queueTip({ key: 'previewBar', priority: 1, onceKey: 'feature.previewBar' });
        }, 20_000);
      }
    },
    leaveRead() {
      window.clearTimeout(readTipTimer);
      window.clearTimeout(readIdleTimer);
      window.clearTimeout(readBarTimer);
      readBarTimer = 0;
      this.lean = 0;
      if (this.mood === 'read') this.mood = 'idle';
      this.resetNap();
    },
    notifyReading(progress: number) {
      if (!this.context.hasDoc || document.hidden) return;
      const now = Date.now();
      // 分栏下打字会带着预览一起滚：输入后短时间内的滚动不算阅读
      if (this.context.mode !== 'read' && now - this.lastInputAt < 1500) return;
      const before = this.context.progress;
      const delta = progress - before;
      if (Math.abs(delta) > 0.0015) {
        this.lean = delta > 0 ? 1 : -1;
        window.clearTimeout(leanTimer);
        leanTimer = window.setTimeout(() => (this.lean = 0), 460);
      }
      this.context.progress = progress;
      this.lastReadingAt = now;
      /* 炸毛的 5 秒归保存失败：此时接手表情计时会把警觉脸钉死在屏幕上 */
      if (this.mood !== 'alert') {
        if (now > this.moodLockUntil) this.mood = 'read';
        window.clearTimeout(backTimer);
        backTimer = window.setTimeout(() => {
          if (this.mood === 'read') this.mood = 'idle';
        }, READ_BACK);
      }
      this.resetNap();
      window.clearTimeout(readTipTimer);
      readTipTimer = window.setTimeout(() => {
        /* 直奔文末时只报「看完了」：两条一起排会互相挤掉（全局间隔 60s），
           而 readFlags 已经打上，丢掉的那条不会再补 */
        if (progress >= 0.95 && !this.readFlags.end) {
          this.readFlags.end = true;
          this.queueTip({ key: 'readEnd', priority: 2, cooldownMs: 0, mood: 'happy', ms: 4200 });
        } else if (progress >= 0.5 && !this.readFlags.half) {
          this.readFlags.half = true;
          this.queueTip({ key: 'readHalf', priority: 2, cooldownMs: 0, mood: 'read', ms: 3200 });
        }
      }, 1200);
    },

    // ------------------------------------------------------------ 保存与里程碑
    notifySaved(auto: boolean) {
      this.context.dirty = false;
      window.clearTimeout(dirtyTimer);
      if (auto) {
        if (this.mood !== 'alert') this.react('happy', 1100, false);
        return;
      }
      this.manualSaves += 1;
      this.react('happy', 1900);
      this.hop();
      if (!this.context.autoSave && this.manualSaves === 3) {
        this.queueTip({ key: 'autoSave', priority: 1, onceKey: 'feature.autoSave' });
      }
    },
    notifySaveError(kind: 'encoding' | 'other' = 'other') {
      this.emitTip({
        key: kind === 'encoding' ? 'saveFailEncoding' : 'saveFail',
        priority: 3,
        cooldownMs: 20_000,
        kind: 'warn',
        mood: 'alert',
        ms: 5200,
        minGapMs: 0,
      });
    },
    notifyExport(kind: string) {
      this.react('happy', 1800);
      this.hop();
      this.queueTip({ key: 'exportDone', params: { kind }, priority: 1, cooldownMs: 5 * 60_000 });
    },
    notifyTabs(n: number) {
      if (n >= 3) this.queueTip({ key: 'tabs', params: { n }, priority: 1, onceKey: 'feature.tabs' });
    },
    notifyFullscreen() {
      this.queueTip({ key: 'fullscreen', priority: 1, onceKey: 'feature.fullscreen' });
    },
    noteFocusMode(on: boolean) {
      const { t } = useI18n();
      this.react('happy', 2000);
      this.say(t(on ? 'pet.focusOn' : 'pet.focusOff'), 2600, 'ok');
    },
    noteBackTop() {
      this.say(useI18n().t('pet.topDone'), 2200, 'ok');
    },
    openQuiet(ms = 30 * 60_000) {
      this.quietUntil = Date.now() + ms;
      this.quietActive = true;
      window.clearTimeout(quietTimer);
      quietTimer = window.setTimeout(() => (this.quietActive = false), ms);
      this.dismissBubble();
      this.say(useI18n().t('pet.quietOn'), 2600, 'ok');
    },
    resumeTalk() {
      window.clearTimeout(quietTimer);
      this.quietUntil = 0;
      this.quietActive = false;
      this.say(useI18n().t('pet.quietOff'), 2200, 'ok');
    },
    toggleQuiet() {
      if (this.quietActive || this.quietUntil > Date.now()) this.resumeTalk();
      else this.openQuiet();
    },
    setBlocked(v: boolean) {
      this.blocked = v;
      if (!v) this.scheduleFlush(800);
    },

    // ------------------------------------------------------------ 提示队列与限流
    queueTip(tip: PetTip) {
      if (tip.onceKey && this.seen.includes(tip.onceKey)) return;
      if (this.pending.some((p) => p.key === tip.key && p.onceKey === tip.onceKey)) return;
      /* 高优先级插到前面：功能小贴士（1）不能把「看完了」「卡稿了」这类当下的回应挡住 */
      const p = tip.priority ?? 2;
      let i = this.pending.length;
      while (i > 0 && (this.pending[i - 1].priority ?? 2) < p) i -= 1;
      this.pending.splice(i, 0, tip);
      if (this.pending.length > 8) this.pending.pop();
      this.scheduleFlush(1400);
    },
    scheduleFlush(delay = 1400) {
      window.clearTimeout(flushTimer);
      flushTimer = window.setTimeout(() => this.flushPending(), delay);
    },
    flushPending() {
      if (!this.pending.length) return;
      if (!this.hostVisible || document.hidden || this.blocked) return;
      if (Date.now() - this.lastInputAt < 1600) return;
      const tip = this.pending[0];
      /* 安静档/静音是「别说」，不是「等会儿说」：直接丢弃，否则解除后会补发过期提示 */
      if ((tip.priority ?? 2) < 3) {
        const level = useSettingsStore().settings.petTipsLevel || 'normal';
        if (level === 'quiet' || Date.now() < this.quietUntil) {
          this.pending.shift();
          if (this.pending.length) this.scheduleFlush(20_000);
          return;
        }
      }
      this.pending.shift();
      if (!this.emitTip(tip)) {
        this.pending.unshift(tip);
        this.scheduleFlush(20_000);
      } else if (this.pending.length) {
        this.scheduleFlush(20_000);
      }
    },
    emitTip(tip: PetTip): boolean {
      const settings = useSettingsStore();
      const level = (settings.settings.petTipsLevel || 'normal') as PetTipsLevel;
      const priority = tip.priority ?? 2;
      const now = Date.now();
      if (!this.hostVisible) return false;
      if (document.hidden) return false;
      if (this.blocked && priority < 3) return false;
      if (level === 'quiet' && priority < 3) return false;
      if (priority < 3 && now < this.quietUntil) return false;
      if (priority < 3 && now - this.lastInputAt < 1500) return false;
      if (tip.onceKey && this.seen.includes(tip.onceKey)) return false;
      if ((this.cooldowns[tip.key] ?? 0) > now) return false;
      const gap = tip.minGapMs ?? (priority >= 3 ? 0 : TIP_GAP[level] ?? TIP_GAP.normal);
      if (priority < 3 && now - this.lastTipAt < gap) return false;
      if (priority === 1 && now - this.lastFeatureAt < FEATURE_GAP) return false;

      const text = this.tipText(tip);
      if (!text) return false;

      this.lastTipAt = now;
      this.cooldowns[tip.key] = now + (tip.cooldownMs ?? 30 * 60_000);
      if (priority === 1) this.lastFeatureAt = now;
      if (tip.onceKey) this.markSeen(tip.onceKey);
      this.say(text, tip.ms ?? 4200, tip.kind ?? 'info');
      if (tip.mood) this.react(tip.mood, Math.min(tip.ms ?? 3600, 5200), tip.mood === 'alert');
      return true;
    },
    tipText(tip: PetTip): string | null {
      const { t } = useI18n();
      const picked = this.pickPool(`pet.tips.${tip.key}`, tip.params);
      if (picked) return picked;
      const fallback = t(`pet.tips.${tip.key}`, tip.params);
      return fallback === `pet.tips.${tip.key}` ? null : fallback;
    },
    markSeen(key: string) {
      if (this.seen.includes(key)) return;
      this.seen.push(key);
      void useSettingsStore().update({ petTipsSeen: [...this.seen] });
    },

    // ------------------------------------------------------------ 定时提醒
    scheduleRemind() {
      window.clearTimeout(remindTimer);
      if (!this.hostVisible || document.hidden) return;
      const now = Date.now();
      const slot = nextSlot(now);
      remindTimer = window.setTimeout(() => {
        try {
          if (Date.now() - slot.at < 120_000) this.fireSlot(slot.kind);
        } finally {
          this.scheduleRemind();
        }
      }, Math.max(1000, slot.at - now));
    },
    fireSlot(kind: 'half' | 'lunch' | 'offwork') {
      if (!this.hostVisible || document.hidden || this.blocked) return;
      if (this.quietActive || Date.now() < this.quietUntil) return;
      /* 整点/饭点/下班是纯陪聊，提示频率选「安静」时不出现 */
      if (useSettingsStore().settings.petTipsLevel === 'quiet') return;
      if (Date.now() - lastFireAt < 90_000) return;
      lastFireAt = Date.now();
      const key = kind === 'lunch' ? 'pet.lunch' : kind === 'offwork' ? 'pet.offwork' : 'pet.reminds';
      const text = this.pickPool(key) ?? useI18n().t('pet.deskGreet');
      this.say(text, 9000);
      this.react('greet', 3800);
    },
  },
});

function applyParams(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  let out = text;
  for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}

function onPresence() {
  usePetStore().notePresence();
}

function onVisibility() {
  const pet = usePetStore();
  if (document.hidden) pet.pause();
  else pet.resume();
}

type SlotKind = 'half' | 'lunch' | 'offwork';
interface Slot { at: number; kind: SlotKind }

function nextSlot(from: number): Slot {
  const todayAt = (h: number, m: number) => {
    const d = new Date(from);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const hourStart = new Date(from);
  hourStart.setMinutes(0, 0, 0);
  const base = hourStart.getTime();
  const half = HALF_ANCHORS.map((m) => base + m * 60_000).find((at) => at > from) ?? base + 3_600_000 + 60_000;
  const slots: Slot[] = [{ at: half, kind: 'half' }];
  const lunch = todayAt(12, 0);
  const off = todayAt(17, 30);
  if (lunch > from) slots.push({ at: lunch, kind: 'lunch' });
  if (off > from) slots.push({ at: off, kind: 'offwork' });
  slots.sort((a, b) => a.at - b.at || (a.kind === 'half' ? 1 : -1));
  return slots[0];
}
