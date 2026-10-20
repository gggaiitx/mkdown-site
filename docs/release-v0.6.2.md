# 码克 v0.6.2

上一版把 HTML 预览改成真实 URL 加载是对的，但漏了一条配套前提：CSP 里没有 `frame-src`。结果 v0.6.1 的产品版里预览任何网页都是「已阻止此内容」，本版补上这一条，并顺手把发布流水线改成先 Windows 后 macOS。

## 修：产品版 HTML 预览被整框拦掉

- **现象**：装了 v0.6.1 的人，预览网页只剩一个禁止图标；开发机上却一切正常。
- **为什么只在产品版暴露**：Tauri 的 CSP 是**打包时**才注进 HTML 的，开发机走 vite 那份 `index.html` 根本没有这条策略 —— 所以 dev 绿灯不代表产品版没问题。
- **根因**：那份 CSP 里没有 `frame-src`，iframe 于是回落到 `default-src 'self'`；而预览文档走的是 `http://asset.localhost`，与主文档不同源，整个框架被拦下。
- **修法**：CSP 补 `frame-src 'self' asset: http://asset.localhost`。SVG 预览用的是 srcdoc（同源），不受这条影响，所以只有 HTML 预览翻车。
- 预览的安全边界不变：仍然是只给 `allow-scripts` 的 opaque origin 沙箱，读不到应用本身。

## 构建顺序：先 Windows 后 macOS

- 两端并成同一个工作流（`release.yml`），macOS 排在 Windows 之后 —— Actions 的依赖不能跨工作流文件，要排序只能并档。
- 排序只借时序、不引入依赖：Windows 失败时 macOS 照旧出包。
- 顺带收掉一类抢建竞态：Release 恒定由 Windows 一侧先创建。

## 已知限制

- v0.6.1 的产品版 HTML 预览不可用（本包修复）；已装 v0.6.1 的用户会收到本次升级提示。
- 预览文档落在 opaque origin：少数依赖 `localStorage` 的网页在预览里会拿不到存储而报错，这类页面请用工具条上的「系统打开」在浏览器里看。
- macOS 产物仍未做代码签名与公证，首次打开需右键「打开」绕过 Gatekeeper。
