/**
 * 渲染层全局错误兜底：未捕获异常一律「落盘 + 提示一次」。
 *
 * 为什么必须有：渲染层被打断后界面停在半白状态，用户既看不到 DevTools、也复述不出细节，
 * 只能关掉重开。这里把 Vue 运行时错误、window error、未处理的 Promise rejection 统一收口，
 * 经 Rust 写入 `%APPDATA%\com.feizong.mkdown\logs\renderer.log`，并在首次出错时给一条
 * 带「怎么重载」的提示。
 *
 * 去重策略：同一条消息 60s 内只记一次——渲染循环里的异常会每秒抛几十次，不去重会把
 * 1MB 的日志额度瞬间写满，真正有用的首条反而被轮转掉。
 */
import type { App } from 'vue';
import { call } from '../api/ipc';
import { useEditorStore } from '../stores/editorStore';
import { useI18n } from '../i18n';

const DEDUPE_MS = 60_000;
/** 去重表上限：长会话里消息常带路径/行号，条目只增不减等于慢性泄漏；
 *  超过上限时按插入顺序丢掉最早的一条（旧条目本来也已过去重窗口） */
const SEEN_LIMIT = 200;
const seen = new Map<string, number>();
let toastShown = false;

/**
 * 已知噪音：浏览器/WebView 的良性告警，不影响功能。
 * ResizeObserver loop 是布局回调里改了尺寸的常见提示（每次拖窗口都可能来一条），
 * Script error. 是跨域脚本的无信息占位——两类都不该写日志，更不该弹「界面出错」。
 */
const NOISE = [/^ResizeObserver loop/i, /^Script error\.?$/i];

function isNoise(message: string): boolean {
  return NOISE.some((re) => re.test(message));
}

/**
 * 主动取消不是故障：fetch / AbortSignal / 组件卸载时中止的读盘都会以 AbortError
 * 的形式走到 unhandledrejection，记成「界面出错」既误导用户又刷满日志。
 */
function isCancellation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const name = (e as { name?: unknown }).name;
  return name === 'AbortError' || name === 'CanceledError' || name === 'CancelledError';
}

function textOf(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function stackOf(e: unknown): string | undefined {
  return e instanceof Error ? e.stack : undefined;
}

/** 写盘：日志通道自身失败必须静默（报错再触发上报就是死循环）。
 *  返回 false = 该条属已知噪音，调用方不应再弹提示。 */
function report(level: 'error' | 'warn', message: string, stack?: string, context?: string): boolean {
  if (isNoise(message)) return false;
  const key = `${level}|${message}`;
  const now = Date.now();
  if (now - (seen.get(key) ?? 0) < DEDUPE_MS) return false;
  // 重新插入到队尾：Map 按插入序迭代，这样驱逐的才是真正最久没出现的条目
  seen.delete(key);
  if (seen.size >= SEEN_LIMIT) {
    const oldest = seen.keys().next();
    if (!oldest.done) seen.delete(oldest.value);
  }
  seen.set(key, now);
  void call<void>('log_renderer_error', {
    level,
    message,
    stack: stack ?? null,
    context: context ?? null,
    ts: new Date().toISOString(),
  }).catch(() => undefined);
  return true;
}

/** 首次出错提示一次：反复弹 toast 本身就是二次伤害 */
function notifyOnce(): void {
  if (toastShown) return;
  toastShown = true;
  try {
    const { t } = useI18n();
    useEditorStore().showToast(t('workbench.toast.renderError'), 'error');
  } catch {
    /* 应用尚未挂载（pinia 未就绪）：只落盘，不提示 */
  }
}

export function installRendererErrorHandler(app: App<Element>): void {
  // Vue 运行时：模板求值、生命周期、watch 回调里抛的错都走这里
  app.config.errorHandler = (err, _instance, info) => {
    if (isCancellation(err)) return;
    const recorded = report('error', textOf(err), stackOf(err), `vue:${info}`);
    if (recorded) notifyOnce();
    // 保留控制台输出：开发期仍要能一眼看到出错发生在哪个环节
    console.error(err, info);
  };

  window.addEventListener('error', (e) => {
    // 资源加载失败（img/script）也会触发 error，但 target 不是 window：那类噪音不记
    if (e.target && e.target !== window) return;
    const err = (e as ErrorEvent).error;
    const recorded = report(
      'error',
      e.message || textOf(err),
      stackOf(err) ?? (e as ErrorEvent).filename,
      'window.onerror',
    );
    if (recorded) notifyOnce();
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    if (isCancellation(reason)) return;
    const recorded = report(
      'error',
      `Unhandled rejection: ${textOf(reason)}`,
      stackOf(reason),
      'unhandledrejection',
    );
    if (recorded) notifyOnce();
    console.error(reason);
  });
}
