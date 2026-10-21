/**
 * 标记语言源码（SVG / XML）的轻量解析与保守美化。零依赖纯函数。
 *
 * ★ 自己数而不借语法树：.svg 在代码引擎里挂的是 CodeMirror 的 legacy('xml')
 *   StreamLanguage，没有 Lezer 语法树可借。
 *
 * 美化只敢做三件事：整体缩进、丢掉元素之间纯空白的文本、把「只含文本」的元素收成一行。
 * 混合内容（文本与子元素并存）整段原样输出——那里插换行会改渲染结果，不值得赌。
 */

interface MkEl {
  kind: 'el';
  tag: string;
  /** 起始标签原文，属性一律照抄（不重排、不改引号） */
  openRaw: string;
  /** 该元素在源码中的整体区间 [from, to)，含结束标签 */
  from: number;
  to: number;
  selfClose: boolean;
  /** 源码里是否真写了结束标签。没写就不替它补——凭空造 </p> 会改坏文档 */
  closed: boolean;
  children: MkNode[];
}

interface MkRaw {
  kind: 'raw';
  /** text = 标签间文本；其余都是「原样保留」的标记 */
  sub: 'text' | 'cdata' | 'comment' | 'pi' | 'doctype';
  s: string;
  from: number;
  to: number;
}

type MkNode = MkEl | MkRaw;
interface MkDoc {
  children: MkNode[];
}

/** 这些元素的内容是纯字符数据，内部的 '<' 不是标签起点（SVG 的 <style> 极常见） */
const RAW_TEXT_TAGS = new Set(['style', 'script', 'textarea']);

/** HTML 空元素：没有结束标签，不能当开标签压栈（否则 `<br>` 会把后面全吞进去）。
 *  SVG/XML 用不到这份，但同一个解析器也要吃 .html 源码 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

/** 从 '<' 起找到该标签的结束 '>'，跳过引号内的 '>'（属性值里出现 > 是合法的） */
function findTagEnd(src: string, lt: number): number {
  let q = '';
  for (let i = lt + 1; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === '>') return i + 1;
  }
  return -1;
}

function readName(src: string, from: number): string {
  let i = from;
  while (i < src.length && !/[\s/>]/.test(src[i])) i++;
  return src.slice(from, i);
}

/** 解析成树。不配对的结束标签不抛错也不硬猜：当原文留在当前层
 *  ★ 每个分支都必须让游标前进：曾经这里用 `findTagEnd(...) ?? src.length` 兜底，
 *    而 findTagEnd 找不到 '>' 时返回的是 **-1**（不是 null），`??` 兜不住 →
 *    游标退回 -1 → 解析从文档头重来 → 再撞同一个 -1 → 主线程死循环，
 *    点一下代码区整个程序卡住（2026-10-21 实锤）。所有取值一律走 below 的
 *    positive() 收敛，并在循环里再兜一道「没前进就跳一格」。 */
function parseDoc(src: string): MkDoc {
  const lower = src.toLowerCase();
  const doc: MkDoc = { children: [] };
  const stack: MkEl[] = [];
  const top = (): MkEl | null => (stack.length ? stack[stack.length - 1] : null);
  const push = (n: MkNode) => (top()?.children ?? doc.children).push(n);
  /** 收尾定位：没找到就吃到文档末尾，找到就跳过这个结束符本身 */
  const after = (found: number, len: number) => (found < 0 ? src.length : found + len);

  let i = 0;
  let lastI = -1;
  while (i < src.length) {
    // 兜底：万一哪个分支忘了推进游标，强推一格，绝不原地打转（主线程卡死过一次）
    if (i <= lastI) i = lastI + 1;
    lastI = i;
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      push({ kind: 'raw', sub: 'text', s: src.slice(i), from: i, to: src.length });
      break;
    }
    if (lt > i) push({ kind: 'raw', sub: 'text', s: src.slice(i, lt), from: i, to: lt });

    if (src.startsWith('<!--', lt)) {
      const to = after(src.indexOf('-->', lt), 3);
      push({ kind: 'raw', sub: 'comment', s: src.slice(lt, to), from: lt, to });
      i = to;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const to = after(src.indexOf(']]>', lt), 3);
      push({ kind: 'raw', sub: 'cdata', s: src.slice(lt, to), from: lt, to });
      i = to;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const to = after(src.indexOf('>', lt), 1);
      push({ kind: 'raw', sub: 'doctype', s: src.slice(lt, to), from: lt, to });
      i = to;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const to = after(src.indexOf('?>', lt), 2);
      push({ kind: 'raw', sub: 'pi', s: src.slice(lt, to), from: lt, to });
      i = to;
      continue;
    }

    const end = findTagEnd(src, lt);
    if (end < 0) {
      push({ kind: 'raw', sub: 'text', s: src.slice(lt), from: lt, to: src.length });
      i = src.length;
      continue;
    }
    const raw = src.slice(lt, end);

    if (raw.startsWith('</')) {
      const tag = readName(src, lt + 2);
      const open = top();
      if (open && open.tag === tag) {
        open.to = end;
        open.closed = true;
        stack.pop();
      } else {
        push({ kind: 'raw', sub: 'text', s: raw, from: lt, to: end });
      }
      i = end;
      continue;
    }

    const tag = readName(src, lt + 1);
    const lowerTag = tag.toLowerCase();
    const selfClose = raw.endsWith('/>') || VOID_TAGS.has(lowerTag);
    const el: MkEl = {
      kind: 'el',
      tag,
      openRaw: raw,
      from: lt,
      to: end,
      selfClose,
      closed: selfClose,
      children: [],
    };
    push(el);
    if (selfClose) {
      i = end;
      continue;
    }
    if (RAW_TEXT_TAGS.has(lowerTag)) {
      // 内容整段按字符数据吃掉，直到配对的结束标签
      const closeAt = lower.indexOf(`</${lowerTag}`, end);
      if (closeAt < 0) {
        el.children.push({ kind: 'raw', sub: 'text', s: src.slice(end), from: end, to: src.length });
        el.to = src.length;
        i = src.length;
        continue;
      }
      const rawCloseEnd = findTagEnd(src, closeAt);
      const closeEnd = rawCloseEnd < 0 ? src.length : rawCloseEnd;
      if (closeAt > end) {
        el.children.push({ kind: 'raw', sub: 'text', s: src.slice(end, closeAt), from: end, to: closeAt });
      }
      el.to = closeEnd;
      i = closeEnd;
      continue;
    }
    stack.push(el);
    i = end;
  }

  // 收尾：一路没闭合的元素，区间到源码末尾
  for (const el of stack) el.to = src.length;
  return doc;
}

/** 子节点里是否有非空文本 / 是否有元素 */
function childShape(el: MkEl): { hasEl: boolean; hasText: boolean } {
  let hasEl = false;
  let hasText = false;
  for (const c of el.children) {
    if (c.kind === 'el') hasEl = true;
    else if (c.sub === 'text' && c.s.trim() !== '') hasText = true;
  }
  return { hasEl, hasText };
}

function emit(node: { children: MkNode[] }, depth: number, src: string, out: string[]) {
  const pad = '  '.repeat(depth);
  for (const n of node.children) {
    if (n.kind === 'raw') {
      if (n.sub === 'text') {
        // 元素之间的纯空白是排版产物，丢掉；游离文本原样留一行
        if (n.s.trim() !== '') out.push(pad + n.s.trim());
      } else {
        out.push(pad + n.s);
      }
      continue;
    }
    if (n.selfClose) {
      out.push(pad + n.openRaw);
      continue;
    }
    if (!n.closed) {
      // 源码没写结束标签（HTML 省略 </p></li> 这类）：整段原样，绝不替它补一个。
      // trimEnd 是幂等的关键——不削掉尾部换行，每跑一次就多出一行
      out.push(pad + src.slice(n.from, n.to).trimEnd());
      continue;
    }
    const { hasEl, hasText } = childShape(n);
    if (!hasEl) {
      // 只含文本（或空）：收成一行，内部文本原样
      const text = n.children
        .map((c) => (c.kind === 'raw' ? c.s : ''))
        .join('')
        .trim();
      out.push(pad + n.openRaw + text + `</${n.tag}>`);
      continue;
    }
    if (hasText) {
      // 混合内容：整段原样，只加行首缩进，内部一个字符都不动
      out.push(pad + src.slice(n.from, n.to).trimEnd());
      continue;
    }
    out.push(pad + n.openRaw);
    emit(n, depth + 1, src, out);
    out.push(pad + `</${n.tag}>`);
  }
}

/**
 * 美化 SVG / XML 源码。空文档返回 null。
 * 幂等靠 emit 的两条纪律保证：元素间纯空白一律丢掉、未闭合段一律 trimEnd，
 * 所以再跑一次排版产物相同——不幂等的话每按一次就多出一行。
 */
export function formatXml(src: string): string | null {
  const text = src.replace(/\r\n?/g, '\n');
  if (!text.trim()) return null;
  const out: string[] = [];
  emit(parseDoc(text), 0, text, out);
  return out.join('\n') + '\n';
}
