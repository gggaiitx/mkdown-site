/**
 * ★ 从内核渲染好的 KaTeX 节点里取回 TeX 源码（纯 DOM，不依赖 Vue、不 import 内核）。
 *
 * 两条通道都要认：标准 KaTeX 把原文放在 MathML 的 `<annotation encoding="application/x-tex">` 里，
 * 但内核渲染结果过了 DOMPurify——annotation 不在白名单，标签被拆壳、**文字留在了 `<math>` 里**
 * （实测 md-editor-v3 v7 + katex 0.18：`<math><mrow>…</mrow>\int_0^1 x^2 dx</math>`）。
 * 只认 annotation ⇒ 公式源码取不到；退回整棵 `textContent` ⇒ MathML 与源码拼两遍，
 * 拿到的是「Emc2E=mc^2」这种重复一遍的垃圾。
 *
 * 为什么单独一层：同一份内核形态有两处消费者——「复制为公众号/知乎」（utils/copyHtml.ts，
 * 取不到就把公式整块抹掉，绝不能留两份节点）与 Word 导出的 D9 降级（convert/docxImagefy.ts）。
 * 两边各写一遍已经漂移过一次（copyHtml 修了三条通道，docxImagefy 还停在 annotation ?? textContent）。
 */
export function katexTexOf(el: Element): string {
  for (const a of Array.from(el.querySelectorAll('annotation'))) {
    if ((a.getAttribute('encoding') ?? '').toLowerCase() === 'application/x-tex') {
      return (a.textContent ?? '').trim();
    }
  }
  // 只取 <math> 的直接文本子节点：mrow 里那些 mi/mo/mn 拼起来是「Emc2」，会把公式说两遍
  for (const math of Array.from(el.getElementsByTagName('math'))) {
    const bare = Array.from(math.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.nodeValue ?? '')
      .join('')
      .trim();
    if (bare) return bare;
  }
  return '';
}
