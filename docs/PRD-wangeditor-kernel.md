# MkDown 多编辑内核（wangEditor）需求分析文档（PRD）

> 版本：v0.4（v0.3 评审修订：与 DEV v0.4 同步——模式语义统一、类型单点、扩展名三处同步、新建文件链路、只读渲染安全、wangEditor 停更风险）
> 日期：2026-10-10
> 作者：高见远（架构师）
> 关联文档：`docs/ARCHITECTURE.md`（§4 适配层契约、§13 适配层边界）、`docs/plan-code-editor-pdf.md`、`src/adapters/*`、`src/views/Workbench.vue`
> 状态：**需求与方案分析阶段，未动代码**

---

## 1. 背景与动机

- **现状**：MkDown 当前编辑内核为 `md-editor-v3`（Markdown 源码 / 分栏 / 阅读三模式），非 Markdown 文本（代码 / html / svg / txt）走自建 CodeMirror 6（`CodeEditorEngine.vue`）。业务层一律经 `src/adapters/` 入口，除适配层实现文件外**禁止直接 import 任一内核**（ARCHITECTURE §13、README 第 121 行）。
- **诉求**：引入 `wangEditor` 作为第二编辑内核，用户可在设置中切换"编辑器引擎内核"，且文件仍**存于本地**（与现有 Tauri + 本地存储链路一致）。
- **关键事实**：`wangEditor v5` 本质是 **HTML WYSIWYG** 编辑器（核心 `@wangeditor/editor` + Vue3 组件 `@wangeditor/editor-for-vue@next`，API：`getHtml()/setHtml()/getText()/destroy()`，MIT 许可），它产出/消费 HTML，**没有原生 Markdown 导入导出**。
- **价值**：为不习惯 Markdown 语法的用户提供所见即所得写作面；验证"双内核经适配层隔离"架构的可扩展性（ARCHITECTURE §4.1 既定目标）。

---

## 2. 目标与范围

### 2.1 目标

| # | 目标 | 说明 |
|---|------|------|
| G1 | 设置提供"编辑内核 / 默认文档格式"切换 | 选项至少含：**Markdown（md-editor-v3，默认）**、**富文本（wangEditor）** |
| G2 | 富文本以独立原生格式本地保存 | 新增 `.mh` 文件（wangEditor 原生 HTML），复用现有 `write_file_atomic`，零转换损耗 |
| G3 | 对业务层透明 | 延续 `IMarkdownEngine` 适配层契约（`EngineHandle`），不破坏既有 md-editor-v3 / CodeEditorEngine 行为 |

### 2.2 范围（In）

- 适配层新增 `WangEditorEngine.vue`，实现 `EngineHandle` 通用能力（`CommonEngineHandle`）。
- 新增文件种类 `mh`：路由、标签类型、文件树图标、全局搜索纳入。
- 设置持久化 `editorEngine`（前端 `AppSettings` + Rust `models.rs` 同步），语义为"新建文件默认格式"。
- 主题（亮/暗）、字号、本地图片落盘、PDF 导出、i18n 在 wangEditor 下的适配。

### 2.3 范围（Out，本阶段不做）

- 代码文件（`CodeEditorEngine`）不切换内核。
- 让 wangEditor **直接读写既有 `.md`**（`md↔html` 双向转换方案，见 D1-B，已非首选）。
- 已打开标签的实时内核热切换（内核按扩展名绑定，切换设置只影响新建文件，见 D3）。
- 协同编辑 / 云同步 / 多端。

---

## 3. 用户角色与场景

| 角色 | 诉求 | 行为 |
|------|------|------|
| U1 习惯 Markdown 的用户 | 维持现状 | 默认内核即为 Markdown，`.md` 行为零变化 |
| U2 偏好 WYSIWYG 的用户 | 不想写 `#`/`**` | 设置选 wangEditor（默认新文件为 `.mh`），新建即所见即所得 |
| U3 两者兼顾 | 同一工作区混合 | `.md` 走 Markdown 内核，`.mh` 走 wangEditor，按扩展名自动分流 |

---

## 4. 功能需求

### FR-01 设置项"编辑内核"

- **位置**：设置对话框"编辑器"分区（`src/components/SettingsDialog.vue` 的 `editor` 模板段，当前 256–299 行）新增一行下拉/单选。
- **选项**：`Markdown`（默认） / `富文本（wangEditor）`。
- **语义**：选定"富文本"后，**新建文件默认生成 `.mh`** 并由 wangEditor 编辑；不影响已存在的 `.md`/`.html`/代码文件。
- **持久化**：写入 `AppSettings.editorEngine` → 经 `settingsStore.update`（`settingsStore.ts:33-44`）→ `set_settings` → Rust `settings_service` → `%APPDATA%\com.feizong.mkdown\settings.json`（完全复用现有链路，见 `api/types.ts:75-110`）。
- **验收**：切换后重启保持；仅影响此后新建文件。

### FR-02 路由选择（按扩展名绑定内核）

- `textKindOf`（`src/stores/tabsStore.ts:25-33`）新增分支：`.mh` → `'mh'`。
- `TabKind`（`tabsStore.ts:14`）新增 `'mh'`。
- **扩展名三处同步（v0.4 补充，沿用项目铁律）**：`src/utils/fileKind.ts`（图标）、Rust `fs_service::TEXT_EXTS`（文件可开性/8MB 闸门）、`search_service::TEXT_EXTS`（全局搜索纳入）。`.mh` 不进 `codeLanguage.ts`（非代码语言）。
- `Workbench.vue:1021-1052` 挂载链改为：
  1. `usesCodeEngine`（`kind` 非 md/mh，即 code/html/svg/text）→ `CodeEditorEngine`（**不变**）
  2. `kind === 'mh'` → `WangEditorEngine`（**新增**）
  3. `kind === 'md'` → `MdEditorV3Engine`（**不变**）
- **验收**：`.mh` 走 wangEditor；`.md` 永远走 Markdown 内核；代码/html/svg/txt 不变；文件树图标正常、全局搜索覆盖 `.mh`。

### FR-02b 新建文件链路（v0.4 补充）

- 新建文件入口按 `settings.editorEngine` 决定默认扩展名：`wangeditor` → `.mh`，`markdown` → `.md`（默认）。
- **验收**：见 §8 P0 第 2/4 条。

### FR-03 wangEditor 编辑能力（通用 `EngineHandle`）

- **模式语义（v0.4 统一）**：`.mh` 支持 edit/read/split 三模式（`setMode` 实现）：edit=可编辑；read=只读渲染；split=左编辑 + 右 wangEditor 只读实例。打开默认 edit（`opensInEdit`），Alt+E/W/R 可切换。
- **必实现**（`IMarkdownEngine.ts:17-28` 的 `CommonEngineHandle`）：`scrollToLine`、`insert`、`highlight`、`clearHighlight`、`getValue/setValue`（HTML 语义）、`setMode`、`setTheme`、`setFontSize`、`onChange/onCursor/onSaveRequest`。
- **选实现**：`exportPdf`（复用现有打印机制）、`getOutline`（由 HTML `<h1>-<h6>` 解析，跳转按标题索引定位，见 DEV §10）、`getSaveContent`/`getViewHtml`（见 DEV §3.3）。
- **不实现**（Markdown 专属，留 `Partial` 空）：`setHeading`、`wrapSelection`、`togglePageFullscreen`。
- **验收**：可输入、大纲跳转定位、`Ctrl+S` 保存、字号/主题跟随。

### FR-04 本地图片落盘（复用现有）

- wangEditor 通过 `MENU_CONF.uploadImage.customUpload` 接管上传：图片 → Base64 → 调 `savePastedImage` IPC（`src/api/imageApi.ts` → Rust `image_cmd`）落盘 `./assets/` → 返回相对路径 → 插入 `<img src="./assets/...">`。
- 渲染走 `asset://`（`convertFileSrc`，ADR-05），**禁止 `file://`**。
- **验收**：粘贴/插入图片在 wangEditor 下与 md-editor-v3 下行为一致。

### FR-05 主题与字号

- **亮/暗**：wangEditor v5 默认浅色，暗色需自定义 CSS 覆盖（风险 R3，实现前需验证）。
- **字号**：注入 `--mk-font-size`（沿用 `settingsStore.applyTheme` 约定，`settingsStore.ts:38-44`）。
- **验收**：随设置切换，无死白/死黑、无闪烁。

### FR-06 PDF 导出

- 复用现有 `exportPdf` 机制（window.print 打印内嵌预览体）。wangEditor 取 `getViewHtml()` 注入预览体后打印。
- **验收**：富文本内核下导出 PDF 可用；版式可有差异但需文档说明。

### FR-07 i18n

- wangEditor 内置中英文 locale；按应用 `language`（`zh-CN` / `en-US`）设置对应语言（API 待核实，风险 R5）。
- 运行时文案走 `src/i18n/packs/engine.ts` 体系。
- **验收**：切换应用语言，编辑器菜单/提示同步。

---

## 5. 非功能需求

| # | 需求 | 约束 | 来源 |
|---|------|------|------|
| NF-01 | 包体 | wangEditor 必须**动态 import**（懒加载），不进首屏 bundle；预估新增 gzip ~300–500KB，需在 ≤15MB 安装包约束下复核（R2） | ARCHITECTURE D4 |
| NF-02 | 离线 | wangEditor 为本地 npm 依赖，禁止任何 CDN/外联 | ARCHITECTURE 禁网约束 |
| NF-03 | 性能 | 打开 300KB 文档 ≤1.5s、输入延迟 ≤50ms（沿用现有基线） | ARCHITECTURE §11.3 |
| NF-04 | 许可 | wangEditor 采用 MIT（实现前最终确认），与闭源分发兼容 | — |

---

## 6. 关键决策与待定项

### D1 存储与内容模型策略（★已定方向：D 新增 `.mh` 原生格式）

`wangEditor` 本质是 HTML WYSIWYG 编辑器，与 Markdown 存在内容模型阻抗。若强行让 wangEditor 读写 `.md` 需做 `md↔html` 双向转换（turndown/markdown-it），存在保真度损耗。**飞总提议、并采纳为推荐方向**：引入独立富文本文件格式 `.mh`，wangEditor 以其**原生 HTML** 直接存储与解析（`setHtml()` 载入、`getHtml()` 保存），零转换损耗；`.md` 与 `.mh` 各走各内核。

| 策略 | 说明 | 优点 | 缺点 |
|------|------|------|------|
| **D 新增 `.mh` 原生格式（推荐）** | wangEditor 以 `.mh` 存原生 HTML；`.md`→Markdown 内核，`.mh`→wangEditor；设置决定"新建文件默认格式" | 零转换损耗；双格式清晰并存；最契合 wangEditor 本质 | 新增文件类型（路由/图标/搜索需适配）；文档分两族 |
| A 仅 HTML 文件 | wangEditor 只接管 `.html/.htm`（替代 `CodeEditorEngine`+`HtmlFrame`），`.md` 不变 | 零损耗、改动最小 | 复用 `.html` 与现有"代码编辑 html"行为冲突；未满足编 md 直觉 |
| B md 双向转换 | `.md` 载入转 html、保存转回 md（markdown-it+turndown） | 单格式、保持 `.md` | 保真度损耗、格式漂移；已非首选 |
| C 混合两级设置 | `md`/`html` 各自选内核 | 最灵活 | 配置复杂、实现量大 |

### D1.1 扩展名命名（已确认：`.mh`）

- 决定：富文本文件采用 **`.mh`**（"MkDown 富文本"）。
- 理由：不与现有 `.html` 的"代码编辑 + Frame 预览"行为冲突；语义独立，可单独做图标与默认应用关联。
- 复用 `.html` 方案已否决（需重新定义 `.html` 打开行为，破坏性大）。

### D1.2 既有 `.md` 在 wangEditor 内核下的处理（已确认：始终由 Markdown 内核打开）

- 决定：**(a) `.md` 始终由 Markdown 内核打开**——内核严格按扩展名绑定，`.md` 永不被 wangEditor 触碰，彻底规避保真度/格式漂移风险。
- 用户若想用富文本写作，新建 `.mh` 即可（设置选"富文本"后新建默认 `.mh`）。
- 方案 (b)（wangEditor 打开 `.md`）已否决。

### D2 内核与格式的绑定关系

- 采用 D 策略后，"内核"与"文件格式"一一绑定：`.md`↔Markdown 内核，`.mh`↔wangEditor 内核。
- 设置项"编辑内核"实际含义为"**新建文件的默认格式/默认内核**"；打开已有文件按扩展名选内核，与设置无关。

### D3 已打开标签的切换行为

- 因内核按扩展名绑定（D2），切换"默认内核"设置**不影响已打开文件**，仅决定新建文件格式。D3 风险基本消解；保留既有范式：切换 `tab.kind`/`usesCodeEngine` 时 `v-if` 销毁重建组件（`Workbench.vue:256-259`）。

---

## 7. 风险登记表

| # | 风险 | 影响 | 缓解 |
|---|------|------|------|
| R1 | 格式碎片化（新增 `.mh` 族） | 用户需理解两种文档；跨格式检索/迁移成本 | 文档内明确双格式定位；提供"`.md`→`.mh` 转换导出"可选命令（阶段二） |
| R2 | 包体超限 | 突破 ≤15MB | 动态 import + 实现前体积复核 |
| R3 | 暗色主题支持待验证 | 暗色下编辑器死白 | 自定义 CSS 覆盖；预留工作量；失败则阶段一仅亮色 + 提示 |
| R4 | 版本兼容（**v0.4 修订**） | wangEditor v5 上游已停止积极维护（2023 年后基本无更新） | 实现前 `npm` 实测最新小版本与 Vue3/vite 兼容；**锁定版本**，不指望上游升级修复；结论计入选型评估 |
| R5 | i18n API 不确定 | 语言切换不生效 | 实现前核实 wangEditor locale 切换 API |
| R6 | 查找高亮（CommonEngineHandle.highlight）在 wangEditor DOM 内实现 | 中等工作量 | 评估降级为"仅编辑器内原生 Ctrl+F 查找"，不实现全局高亮 |
| R7 | PDF 打印样式（v0.4 新增） | 富文本注入 `#export-pdf-preview` 后版式异常 | 打印样式验证并入 FR-06 验收 |
| R8 | split 只读渲染 XSS（v0.4 新增） | 外部 `.mh` 内 `<img onerror>` 等向量 | 右侧只读渲染必须经 wangEditor 解析器/只读实例，**禁止 v-html 直插** |

> 注：原"md↔html 保真度损耗（高）"风险已随 D 策略消除。

---

## 8. 验收标准（P0 摘要）

1. 设置出现"编辑内核"项且持久化；默认 **Markdown**。
2. 选 wangEditor 后，**新建文件默认生成 `.mh`**（FR-02b 链路）并由 wangEditor 编辑；`.md` 始终由 Markdown 内核打开（**零破坏**）。
3. 富文本下可输入、`Ctrl+S` 保存（落盘 `.mh`，本地）、图片落盘 `./assets`、PDF 导出可用（含打印样式验证 R7）、主题/字号/i18n 跟随。
4. 代码/html/svg/txt 行为不变；切回 Markdown 默认后新建文件恢复 `.md`。
5. 全局搜索覆盖 `.mh`；文件树图标正常（三处同步，FR-02）。

---

*本文档为需求分析，不进入编码。代码级设计见 `docs/DEV-wangeditor-kernel.md`。*
