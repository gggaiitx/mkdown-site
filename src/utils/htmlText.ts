/**
 * mh（富文本）标签的匹配 haystack 工具：tab.content 是 HTML 源码，
 * 直接按源码匹配会命中标签属性且计数/行号全错——DOMParser 去标签取纯文本。
 *
 * textContent 拼接口径 = WangEditorEngine 查找高亮的 TreeWalker 文本节点 join
 * （两侧行为一致），实体（&nbsp; 等）也同步解码。FindBar 与 SearchHub 共用。
 */
export function htmlPlainText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style').forEach((el) => el.remove());
    return doc.body.textContent ?? '';
  } catch {
    return html;
  }
}
