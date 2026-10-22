/**
 * 全局右键守卫：默认禁用 WebView 原生上下文菜单，只让「已自绘菜单」的区域接管。
 *
 * 判定顺序（冒泡阶段，元素级业务 handler 先执行）：
 *  1) e.defaultPrevented === true → 业务已接管（TabBar / FileTree / 编辑区引擎 / 图片预览
 *     等都会 preventDefault 后抛 editorContext），直接放行，不再干预；
 *  2) 命中 NATIVE_MENU_SELECTOR → 保留系统菜单；
 *  3) 其余一律 preventDefault → 右键无反应（工具栏、空白背景、阅读区正文等）。
 *
 * 为什么放在 document 冒泡阶段而不是捕获阶段：
 *  Vue 模板上的 @contextmenu 与引擎的原生监听都绑定在元素自身，冒泡阶段晚于它们执行，
 *  因此能读到 defaultPrevented，不会抢在自绘菜单之前把事件吃掉。
 *
 * 例外区域用 data-native-ctx 标注即可放行（例如后续要做「图片另存为」的独立面板）。
 */
const NATIVE_MENU_SELECTOR = [
  // 可编辑文本：右键粘贴/全选是系统能力，应用菜单给不出等价项
  'input',
  'textarea',
  '[contenteditable="true"]',
  // 链接与图片：用户要的是「复制链接地址 / 图片另存为」（与各引擎在阅读态放行 a/img 的口径一致）
  'a[href]',
  'img',
  // 显式声明需要系统菜单的区域
  '[data-native-ctx]',
].join(', ');

let installed = false;

/** 安装全局右键守卫（幂等，main.ts 启动时调用一次） */
export function installContextMenuGuard(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('contextmenu', (e: MouseEvent) => {
    if (e.defaultPrevented) return;
    const el = e.target instanceof Element ? e.target : null;
    if (el?.closest(NATIVE_MENU_SELECTOR)) return;
    e.preventDefault();
  });
}
