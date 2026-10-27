/**
 * ★ 富文本剪贴板写入（text/html + text/plain 双口味）。
 *
 * 为什么不用 writeText：公众号 / 知乎的编辑器读的是 text/html 那一格。只写纯文本过去，
 * 粘出来就是一段没排版的流水账——「复制为公众号」这件事本身就没意义了。
 *
 * 双通道（WebView2 = Chromium，两条路都实测可用）：
 * 1) ClipboardItem + navigator.clipboard.write：一次写两种 MIME，规范做法。需要文档持焦点；
 *    离线/权限策略下可能抛 NotAllowedError。
 * 2) execCommand('copy') + 选区：老路但最稳，离屏 contenteditable 的选区依然产出带样式的
 *    HTML。1 失败时用它兜底，不许静默失败——菜单点完没反应是最难排查的故障。
 *
 * 两条路都在结束后把焦点还给原元素：菜单项点完用户要能接着打字（Workbench 另有
 * focusEditor 兜底，这里不依赖它）。
 */

/** 离屏选区的临时容器：必须在文档流里且可见性不为 hidden，否则选区复制拿不到内容 */
const OFFSCREEN = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;';

function copyBySelection(html: string): boolean {
  const prev = document.activeElement as HTMLElement | null;
  const host = document.createElement('div');
  host.setAttribute('contenteditable', 'true');
  host.setAttribute('style', OFFSCREEN);
  host.innerHTML = html;
  document.body.appendChild(host);
  const sel = window.getSelection();
  let ok = false;
  try {
    const range = document.createRange();
    range.selectNodeContents(host);
    sel?.removeAllRanges();
    sel?.addRange(range);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    sel?.removeAllRanges();
    host.remove();
    prev?.focus?.();
  }
  return ok;
}

/** 两条路都失败的标记：调用方据此区分「剪贴板被拒」与「渲染快照没就位」，别把两回事说成一件 */
export const CLIPBOARD_UNAVAILABLE = 'clipboard-unavailable';

/**
 * 写入富文本剪贴板。两条路都失败时抛 CLIPBOARD_UNAVAILABLE，由调用方给用户明确出路（别闷着）。
 */
export async function writeClipboardHtml(html: string, text: string): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function') {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return;
    } catch {
      /* 落到 execCommand：焦点/权限被拒时这是唯一出路 */
    }
  }
  if (copyBySelection(html)) return;
  throw new Error(CLIPBOARD_UNAVAILABLE);
}
