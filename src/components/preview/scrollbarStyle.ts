/**
 * 注入预览文档（HTML / SVG）的滚动条样式，与 global.css 那段全局规则逐条同款：
 * 10px 圆角、轨道透明、hover / active 加深。
 *
 * ★ 必须同时把根元素的 scrollbar-width / scrollbar-color 打回 auto：不少页面自带
 *   `*{scrollbar-width:thin;scrollbar-color:…}`，WebView2 一见元素命中标准属性就把它
 *   切到 Fluent 悬浮滚动条渲染路径，`::-webkit-scrollbar` 整段被忽略（2026-10-08 修
 *   大纲区悬浮条时同一现象），预览条就跟应用对不上。只动 html——页面内部的小滚动区
 *   是它自己的设计，不替它改。
 *
 * @param dark 应用暗色主题。预览文档取不到应用的 CSS 变量，配色在此按主题落死，
 *             取值与 global.css 的 --mk-bg / --mk-border-strong / --mk-fg-muted 一致。
 *             轨道必须给实色、不能像应用内那样留透明：滚动条占据的那一条不画页面
 *             canvas 背景，透出的是 iframe 元素自己的底色（.html-frame 是 #fff），
 *             暗色应用里就成了一条白带（2026-10-20 实测 A/B 定位）。
 */
export function scrollbarCss(dark: boolean): string {
  const track = dark ? 'rgb(19 20 22)' : 'rgb(255 255 255)';
  const thumb = dark ? 'rgb(110 110 114 / 0.45)' : 'rgb(212 212 212)';
  const thumbStrong = dark ? 'rgb(190 191 197)' : 'rgb(115 115 115)';
  return (
    'html{scrollbar-width:auto!important;scrollbar-color:auto!important}' +
    '::-webkit-scrollbar{width:10px;height:10px}' +
    '::-webkit-scrollbar-button{display:none;width:0;height:0}' +
    `::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:${track};margin:0}` +
    `::-webkit-scrollbar-thumb{background:${thumb};border-radius:6px;border:2.5px solid transparent;background-clip:padding-box}` +
    `::-webkit-scrollbar-thumb:hover{background:${thumbStrong};border:2.5px solid transparent;background-clip:padding-box}` +
    `::-webkit-scrollbar-thumb:active{background:${thumbStrong}}`
  );
}
