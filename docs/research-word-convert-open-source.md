# Word 双向转换开源方案调研（2026-10-13）

> **落地状态（2026-10-13 当日实施完毕，待飞总实测）**：
> - ①Word→MD 已切换 `word-to-markdown-js`（`docxToMd.ts` 重写；图片 extract→savePastedImage 落盘链路复用）。
> - ②MD→Word 已加社区引擎试点 `@mohtasham/md-to-docx`（`mdToDocxCommunity.ts`；设置「导出 Word 引擎」开关，仅 md 标签分流；mermaid 接 renderMermaidSvg→PNG）。
> - ③Word→MH 已加高保真管线试点 `docxPreviewToMh.ts`（docx-preview breakPages:false + inline style 净化映射；设置「Word 转 Markhtml」开关）。
> - 顺手修复存量 bug：Rust AppSettings 缺 wordFontZh/En/Size 三字段导致导出字体设置不持久化（models.rs 已补）。
> - 验证：vue-tsc / cargo check 通过；node + 浏览器（esbuild browser bundle 无头）双路径实测——GFM 脚注、管道表格、原生 OMML 公式（m:oMath）、代码高亮着色、颜色/对齐/字号保留、图片落盘全部确认。
>
> 目的：现有 md/mh ⇄ word 四条管线"功能有了但人工测试效果不太好"，本文调研 GitHub 上可落地的开源方案，给出分方向推荐与落地路线。
> 现状代码：`src/convert/htmlToDocx.ts`（自研 HTML→docx）、`docxToMd.ts`（mammoth+turndown）、`docxToMh.ts`（mammoth+白名单净化）、`docxImagefy.ts`（KaTeX/Mermaid 光栅化）。

## 一、现状管线与已知短板（以人工实测反馈为准）

| 方向 | 现状实现 | 已知短板 |
|---|---|---|
| MD → Word | md-editor 预览 HTML → 自研白名单遍历 → docx 包 | 代码块无语法高亮着色；公式走图片/源码降级；任务列表、脚注缺失；样式硬编码 |
| MH → Word | 同上（wangEditor 方言特化） | 同上；todo 降级为 ☐/☑ 文本 |
| Word → MD | mammoth → turndown(+gfm) + 表格规范化补丁 | 颜色/字号/对齐丢失（mammoth 有意语义化）；OMML 公式不支持；脚注/尾注不支持；合并单元格表格受限 |
| Word → MH | mammoth → 白名单净化 → wangEditor 方言 | 同上；浮动图片/文本框丢失 |

## 二、候选总览（数据核实于 2026-10-13，GitHub API）

| 库 | 方向 | Stars | License | 最近推送 | 环境 | 核心能力 |
| --- | --- | --- | --- | --- | --- | --- |
| [MohtashamMurshid/md-to-docx](https://github.com/MohtashamMurshid/md-to-docx) `@mohtasham/md-to-docx` | MD→DOCX | 106 | MIT | 2026-09-10 | Node+浏览器 ESM | **原生可编辑 Word 公式（OMML，TeX 子集）**、lowlight 语法高亮（GitHub-light 主题可定制 token 色）、TOC、图表题注、多 section、参考 docx 继承样式、RTL；v4.0.1（2026-09） |
| [vace/markdown-docx](https://github.com/vace/markdown-docx) `markdown-docx` | MD→DOCX | 373 | MIT | 2026-10-11 | Node+浏览器（有在线 demo） | marked 系解析，GFM、任务列表、脚注、超链接、KaTeX 数学（fractions/roots/矩阵等）、样式可定制（styles/colors/numbering 导出）、图片 adapter；中文文档，v1.7.0（2026-06） |
| [md2docx/md2docx-legacy](https://github.com/md2docx/md2docx-legacy) `@m2d/md2docx` | MD→DOCX | 主仓库 404 | MPL-2.0 | — | Node+浏览器 | remark 生态 + math/mermaid/emoji 插件；**主仓库 404 疑似迁移中，暂不推荐** |
| [benbalter/word-to-markdown-js](https://github.com/benbalter/word-to-markdown-js) `word-to-markdown` | DOCX→MD | 269 | Apache-2.0 | **2026-10-13（当日）** | Node 22.13+ / 浏览器（ArrayBuffer）/ CLI | mammoth+turndown 生产级后处理：**GFM 脚注 `[^1]`**、图片三模式（内嵌 base64/落盘/抽取）、列表规范化、下划线保留开关、加密/敏感标签警告；word2md.com 在线版同源 |
| [eigenpal/docx-editor](https://github.com/eigenpal/docx-editor) `@docx-editor.dev/docx-to-markdown` | DOCX→MD | 481（2026-07 创建） | npm 标 Apache-2.0；**repo license 字段未识别** | 2026-10-13 | Node 20/22，需 WASM + bundled fonts | **排版引擎级保真**：分页、页眉页脚、批注、修订均进 MD；按页输出；97 open issues，项目仅 3 个月大 |
| [TurboDocx/html-to-docx](https://github.com/TurboDocx/html-to-docx) `@turbodocx/html-to-docx` | HTML→DOCX | 232 | MIT | 2026-10-11 | Node+浏览器（browser ESM ~1.6MB 全打包） | private-octopus 的活跃继任：real OOXML、页眉页脚、表格/图片/列表；SVG 直嵌需 Office 2019+ |
| [floodtide/dom-docx](https://github.com/floodtide/dom-docx) `dom-docx` | HTML→DOCX | 488 | MIT | 2026-09-19 | Node+浏览器+CLI | 语义 HTML→原生 OOXML；视觉回归评分闭环（HTML 截图 vs LibreOffice 光栅化打分）；支持 flex 行、页眉页脚、TOC；2026-07 新生项目 |
| [superdoc-dev/superdoc](https://github.com/superdoc-dev/superdoc) | DOCX 引擎/编辑器 | — | **AGPL-3.0 + 商业双授权** | 活跃 | 浏览器+Node headless | 全保真 DOCX 引擎（分页/页眉页脚/TOC/脚注）+ ProseMirror 编辑；**AGPL 授权风险 + ProseMirror/Yjs 依赖过重，不引入** |
| `docx-preview`（已在依赖） | DOCX→HTML（渲染） | — | Apache-2.0 | — | 浏览器 | 渲染 DOM 带**完整 inline style（颜色/字号/对齐/表格 colspan/rowspan）**，可作 Word→MH 高保真提取源（需 spike） |
| [pandoc](https://pandoc.org/) 3.12（sidecar） | 全方向 | — | GPL-2.0+（独立进程调用无传染） | 活跃（20+ 年） | 独立二进制，Windows zip 42MB | 四方向质量天花板：md→docx 配 `--reference-doc` 样式模板、docx→gfm、docx→html；**不渲染 mermaid/KaTeX 图**；安装包体积膨胀需实测 |

## 三、分方向推荐

### 1. Word → MD：换用 `word-to-markdown-js`（首选，低风险）

- 与现有栈同源（内部就是 mammoth+turndown，共享依赖，打包增量小），等价于"把社区生产环境打磨过的后处理规则集直接拿来用"。
- 接口 `convertWithWarnings(arrayBuffer)` 正好对接 `readPreviewBytes`；浏览器/Node 双端。
- 直接收益：GFM 脚注、嵌套列表规范化、图片落盘/内嵌三模式、加密文档警告。
- 替代做法：不换库，把它的 turndown 规则 cherry-pick 进 `docxToMd.ts`（工作量更大，收益相同）。
- 观望：`@docx-editor.dev/docx-to-markdown` 保真度天花板（连批注/修订/页眉页脚都能进 MD），但项目太年轻、license 标注混乱，半年后再看。

### 2. MD → Word：试点 `@mohtasham/md-to-docx`，备选 `markdown-docx`

- 直击两大痛点：**公式转原生 Word 公式（可编辑）**、**代码块语法高亮**（lowlight，与现有 highlight.js 主题思路一致）。
- 架构上更干净：直接喂 md 原文，不再依赖预览 HTML 产物（绕开 KaTeX/Mermaid DOM 光栅化链路）。
- 试点方式：在 `WordConvertDialog` 加"转换引擎"开关（自研 / 新库）做 A/B，验证中文字体 eastAsia、样式自定义粒度后再决定是否默认。
- `vace/markdown-docx`（373★，国人项目，在线 demo 可先人工试效果）作为对照候选；其数学走 KaTeX 渲染路线，需验证产物是图片还是原生公式。
- `@m2d/md2docx` 主仓库 404（迁移中），暂不推荐。

### 3. Word → MH：不换库，两条增量路线

- 路线①（保守）：扩充 mammoth `styleMap`，把常用 Word 样式（标题层级、代码、引用）映射得更全；保底语义导入。
- 路线②（高保真 spike）：用**已在依赖里的 docx-preview**（关闭分页 `breakPages:false`）渲染出带完整 inline style 的 DOM，写一个"docx-preview DOM → wangEditor 方言"净化器（span 的 color/font-size/背景/对齐映射进 wangEditor 支持的 inline style，表格保 colspan/rowspan）。保真度会显著超过 mammoth（后者有意丢弃视觉样式）。需要一个小 spike 验证输出结构的可用性。

### 4. MH → Word：维持自研 `htmlToDocx`

- wangEditor 方言特化 + KaTeX/Mermaid 双嵌管线已就绪，现成库（turbodocx/dom-docx）都不处理公式/图表。
- 从 `@turbodocx/html-to-docx` 与 `dom-docx` 借鉴表格样式、图片缩放、页眉页脚细节即可。

### 5. Pandoc sidecar：不默认捆绑，列为"旗舰模式"备选

- 四方向质量天花板（尤其复杂表格、脚注、公式），独立进程调用 GPL 二进制无传染问题。
- 代价：Windows zip 42MB（解压后单文件更大），安装包体积膨胀明显；mermaid/KaTeX 图不处理；需要 sidecar 更新维护。
- 若上述库试点后仍达不到预期，再评估"可选下载 pandoc 组件"的产品形态。

## 四、导出 PDF 选型（2026-10-13 新增需求）

**最终方案：系统 Edge headless `--print-to-pdf`（Chromium 打印引擎）**——当晚从 html2canvas 图片型切换而来（首版实测效果不达标，飞总反馈"巨差"：html2canvas 逐像素重绘、CSS 覆盖不全、文字不可选、体积大、分页生硬）。

| 候选 | 类型 | 结论 |
|---|---|---|
| html2canvas(1.4.1) + jsPDF(4.2.1) | 图片型 | **已下线**（模块与依赖已删）：效果不达标，原因见上 |
| Edge headless `--print-to-pdf` | 矢量文字型 | **已采用**：与浏览器"打印 PDF"同款引擎——CSS 完整保真、文字可选可搜索、智能分页不断表格、中文字体走系统渲染；零打包体积（Win10/11 必装 Edge）；无 Edge 时明确提示回退「打印 PDF」 |
| dompdf.js（lmn1919） | 矢量 | 2026 新库、单作者、样式覆盖有限（仅实线边框等）、中文需嵌 TTF，风险高 |
| dom-to-vector-pdf | 矢量 | DOM→SVG→svg2pdf→jsPDF；35★ 且半年前停更，中文需注册 TTF 子集化，mermaid SVG 保真存疑 |
| pdfmake | 矢量 | 声明式 JSON 定义，需把 HTML 重写映射（htmlToDocx 级工作量） |

落地实现（`src/convert/printDoc.ts` + Rust `export_pdf`）：
- **自包含化** `buildPrintDocument(快照HTML)`：抓运行 DOM 全部 `<style>`/`<link>` 样式文本；CSS `url()`（woff2 字体）与内容 img 一律转 data URI（临时 HTML 在 temp 目录，相对/dev 路径不可达、外链被 file:// CORS 拦）；内容包进 `.mk-export-host`（复用既有 `@media print` 规则：`body>*:not(.mk-export-host)` 隐藏 + 宿主打印显示，打印范围天然收敛）；`@page { size:A4; margin:16mm 14mm }`；快照本身即 MdPreview theme="light" 产物，无需剥暗色。
- **Rust 侧**：写临时 HTML（temp ASCII 路径免 URL 编码）→ 探测系统 Edge（Program Files 双路径）→ `--headless=new --disable-gpu --no-pdf-header-footer --virtual-time-budget=20000 --print-to-pdf=…` → 读回 PDF → 保存对话框 + 原子写 + grant_picked；Edge 缺失返回中文错误引导「打印 PDF」。
- 前端：`Workbench.doExportPdf`（md 走 getExportPreviewHtml 快照 / mh 走 getDisplayHtml → buildPrintDocument → exportPdf）。
- 全链路验证（无头 Edge + 真实 Edge 打印）：自包含化 7 项全过（含 woff2 data URI 内联）；产物为有效 PDF、**文字型（/Font）+ KaTeX woff2 字体嵌入成功**、A4 分页正常。

## 五、落地顺序建议

1. **Word→MD 换 `word-to-markdown-js`**（半天级改动，收益确定）。
2. **MD→Word 试点 `@mohtasham/md-to-docx`**，对话框加引擎开关 A/B（1~2 天）。
3. **Word→MH docx-preview 提取 spike**（1 天验证可行性）。
4. 视 A/B 结果决定默认引擎；pandoc 暂缓。

## 五、依赖引入纪律（2026-10-13 白板事故复盘）

- 新增 CJS 依赖（mammoth/turndown/docx 同类）**必须走预构建**：装完 → 停 dev → 删 `node_modules/.vite` → 重启；**严禁塞 `vite.config.ts` 的 exclude**。
- 动态 import 的 specifier 必须是字面量或可静态析出的相对路径（legacy 语言 104 模块静默失败的教训）。
