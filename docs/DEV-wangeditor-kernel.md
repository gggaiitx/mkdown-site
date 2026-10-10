# MkDown 多编辑内核（wangEditor）开发设计文档

> 版本：v0.4（v0.3 评审修订：模式语义统一、EditorKernel 收敛单点、`.mh` 三处同步、新建文件链路任务化、只读渲染安全、大纲跳转机制、wangEditor 停更风险、PDF 样式验收）
> 日期：2026-10-10
> 作者：高见远（架构师）
> 关联：`docs/PRD-wangeditor-kernel.md`、`docs/ARCHITECTURE.md`（§4 适配层）、`src/adapters/*`、`src/views/Workbench.vue`、`src/api/types.ts`、`src/components/SettingsDialog.vue`
> 状态：**设计阶段，未动代码**

---

## 1. 设计目标与约束

- **复用适配层边界**（ARCHITECTURE §4、§13）：业务层仍只依赖 `src/adapters/` 导出的类型与组件；`wangEditor` 仅在 `WangEditorEngine.vue` 内 import，其余文件 `grep` 不到 `wangeditor` 字样。
- **契约兼容**：延续 `EngineHandle = CommonEngineHandle & Partial<MarkdownEngineHandle>`（`IMarkdownEngine.ts`）的组件 `defineExpose` 范式；不引入 class/Factory 体系（见 `docs/plan-code-editor-pdf.md:19-24`）。
- **零破坏**：md-editor-v3 与 CodeEditorEngine 既有行为不变；wangEditor 为新增分支，且**仅作用于新增的 `.mh` 文件族**。
- **懒加载**：wangEditor 经动态 `import()` 成独立 chunk，不进首屏（D4）。
- **零转换**：`.mh` 以 wangEditor 原生 HTML 读写，**不引入 markdown-it / turndown**（保真度 100%）。

---

## 2. 总体路由模型（按扩展名绑定内核）

采用 PRD D1-D 策略后，**内核与文件格式绑定**，路由回到清晰的两步判定（"设置切换内核"只决定新建文件格式，不影响已打开文件）：

```
step1: 按扩展名定 tab.kind（textKindOf 扩展）
  ├─ .md / .markdown / .mdx        → 'md'   → MdEditorV3Engine（不变）
  ├─ .mh（新增富文本，PRD D1.1）    → 'mh'   → WangEditorEngine（新增）
  ├─ .html / .htm / .svg          → 标记类  → CodeEditorEngine（源码）+ Frame（不变）
  └─ 代码扩展名 / .txt / .log …    → 'code'  → CodeEditorEngine（不变）

step2: mode（edit/split/read）由各内核内部映射（见 §6）
```

> 代码 / html / svg / md / mh 各走各引擎，互不干扰；"编辑内核"设置项仅决定**新建文件默认格式**。

---

## 3. 适配层扩展

### 3.1 新增文件：`src/adapters/WangEditorEngine.vue`

- 组件 `defineExpose` 实现 `EngineHandle`：
  - 必暴露：`scrollToLine`、`insert`、`highlight`、`clearHighlight`（来自 `CommonEngineHandle`）。
  - 选暴露：`exportPdf`、`getOutline`（HTML `<h1>-<h6>` 解析）；**不暴露** `setHeading` / `wrapSelection` / `togglePageFullscreen`（Markdown 专属，`Partial` 留空）。
  - `kind` 常量返回 `'mh'`。
- 内部依赖：`@wangeditor/editor` + `@wangeditor/editor-for-vue@next` 的 `<Editor>`/`<Toolbar>`，仅在本组件内 `import`（含 `import '@wangeditor/editor/dist/css/style.css'`）。

### 3.2 导出与工厂（`src/adapters/index.ts`）

```ts
export { default as MdEditorV3Engine } from './MdEditorV3Engine.vue';
export { default as CodeEditorEngine } from './CodeEditorEngine.vue';
export { default as WangEditorEngine } from './WangEditorEngine.vue';   // 新增
// createEngineKind() 桩可保留作默认值来源或删除（路由改按 tab.kind，不依赖它）
```

> **修订（v0.4）**：`EditorKernel` 类型**只在 `src/api/types.ts` 定义一次**（设置语义，见 §4.1），`adapters/index.ts` 不再重复定义，避免同名类型双处漂移；adapters 内部仅按需 import 消费。

### 3.3 契约补充（`src/adapters/IMarkdownEngine.ts`）

在 `EngineHandle` 上**可选**追加，使保存管线对两类内核统一：

```ts
export interface SaveableEngineHandle {
  /** 返回应落盘文本：md-editor-v3→Markdown；wangEditor→getHtml()（.mh） */
  getSaveContent(): string;
  /** 返回当前视图 HTML（PDF/预览复用） */
  getViewHtml(): string;
}
export type EngineHandle = CommonEngineHandle
  & Partial<MarkdownEngineHandle>
  & Partial<SaveableEngineHandle>;
```

---

## 4. 设置模型变更

### 4.1 前端（`src/api/types.ts`）

```ts
export type EditorKernel = 'markdown' | 'wangeditor';

export interface AppSettings {
  // …既有字段…
  editorEngine: EditorKernel;   // 新增：语义=新建文件默认格式，默认 'markdown'
}

export const DEFAULT_SETTINGS: AppSettings = {
  // …既有…
  editorEngine: 'markdown',      // 新增
};
```

### 4.2 Rust 侧（`src-tauri/src/models.rs`）

`AppSettings` 结构体新增（与 TS 同步，手写维护约定 ARCHITECTURE §13）：

```rust
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    // …既有…
    pub editor_engine: String,   // "markdown" | "wangeditor"
}
```

> `settings_service` 默认值与校验同步；非法值回退 `'markdown'`。

### 4.3 设置 UI（`src/components/SettingsDialog.vue`）

在 `editor` 模板段（256–299 行之间）新增一行；文案说明"富文本将新建 `.mh` 文件"：

```vue
<div class="row">
  <label>{{ t('settings.editorEngine') }}</label>
  <select
    :value="settings.settings.editorEngine"
    @change="patch({ editorEngine: ($event.target as HTMLSelectElement).value as AppSettings['editorEngine'] })"
  >
    <option value="markdown">{{ t('settings.engineMarkdown') }}</option>
    <option value="wangeditor">{{ t('settings.engineWangeditor') }}</option>
  </select>
</div>
```

### 4.4 i18n（`src/i18n/packs/settings.ts` / `engine.ts`）

新增键：`settings.editorEngine`、`settings.engineMarkdown`、`settings.engineWangeditor`；运行时提示（如"已新建 .mh 富文本文档"）走 `engine.ts`。

---

## 5. Workbench 路由改造（`src/views/Workbench.vue`）

现状挂载片段（1021–1052）：`usesCodeEngine` → `CodeEditorEngine`，否则 → `MdEditorV3Engine`。

改为按 `tab.kind` 三分支：

```vue
<div v-else class="text-area" :class="[{ 'html-mode': isMarkupTab }, editor.mode]">
  <CodeEditorEngine
    v-if="usesCodeEngine"
    ref="engineRef" ... />                 <!-- 不变：code/html/svg/text -->
  <WangEditorEngine
    v-else-if="tabs.activeTab.kind === 'mh'"
    ref="engineRef"
    :model-html="tabs.activeTab.content"   <!-- 已是 HTML，直接 setHtml -->
    :theme="settings.settings.theme"
    :font-size="settings.settings.fontSize"
    :doc-path="activeDocPath"
    :language="settings.settings.language"
    @change="onContentChange"
    @save="() => saveActive()"
    @cursor="({ line, col }) => editor.setCursor(line, col)"
  />
  <MdEditorV3Engine
    v-else
    ref="engineRef" ... />                 <!-- 现有 props/events 不变：md -->
  <HtmlFrame v-if="tabs.activeTab.kind === 'html' && editor.mode !== 'edit'" ... />
</div>
```

> `engineRef` 类型保持 `EngineHandle`（含新增可选成员）。`usesCodeEngine`（256–259）判定扩展为"非 md 且非 mh"；`isMarkupTab`（247–250）、`showOutline`（270–278）对 `'mh'` 按"无 Markdown 大纲"处理（改由 HTML 标题大纲替代，见 §10）。
> `opensInEdit`（`Workbench.vue:334`）与 `openFileFromTree` 的默认模式需把 `.mh` 纳入"默认进入编辑态"（与 html/svg 同类：打开即编辑，但三模式 Alt+E/W/R 仍可切换，见 §6.2）。

### 5.1 新建文件链路（v0.4 新增）

- 文件树/Workbench 的新建文件入口，当 `settings.settings.editorEngine === 'wangeditor'` 时，新建文件默认扩展名取 `.mh`（否则 `.md`）；文件名输入与 dirty 确认复用现有链路。
- 验收对齐 PRD §8 第 2/4 条：选 wangEditor 后新建出 `.mh`；切回 Markdown 后新建恢复 `.md`。

---

## 6. 内容模型实现（PRD D1-D：`.mh` 原生格式）

**无需 markdown-it / turndown**——wangEditor 以原生 HTML 读写 `.mh`，保真度 100%。

### 6.1 打开 `.mh`：HTML 直读

- `WangEditorEngine` 接收 `model-html`（已是 HTML），`onMounted` 内 `editor.setHtml(html)` 还原。
- 无转换；wangEditor 自产自消。

### 6.2 编辑：wangEditor WYSIWYG（模式映射，v0.4 统一）

- `edit` → wangEditor 可编辑。
- `read` → wangEditor 实例 `enable(false)` 只读渲染（隐藏工具条）。
- `split` → 左侧可编辑 wangEditor + 右侧**wangEditor 只读实例**（独立只读 editor 或同实例 enable(false) 的镜像渲染）。
- **安全约束（v0.4 新增）**：右侧只读渲染**禁止 `v-html` 直插原始 HTML**（`<img onerror>` 等属性向量不可控，`.mh` 可能来自外部）；必须经 wangEditor 解析器（自带标签/属性白名单）或同级只读实例渲染。
- 三模式按钮（`Alt+E/W/R`）对 `.mh` 继续可用；`setMode` 由组件实现（edit/read/split 全支持）。与 PRD FR-03、DEV §5 `opensInEdit`（默认 edit、可切换）三处语义一致。

### 6.3 保存 `.mh`：HTML 直写

- `getSaveContent()` = `editor.getHtml()`（存储选型见 6.4）。
- 保存管线（`saveActive`）优先 `engineRef.value?.getSaveContent?.() ?? tabs.activeTab.content`：`.mh` 标签返回 HTML，`.md` 返回 Markdown，逻辑统一。
- 复用现有 `write_file_atomic`，落盘到工作区（与 `.md` 完全一致，本地存储不变）。

### 6.4 存储内容选型：HTML vs wangEditor JSON

- **HTML（推荐）**：`getHtml()` 存盘、`setHtml()` 还原；可被浏览器/其他工具打开，可读性好；wangEditor 解析稳定。
- **JSON（`editor.children`）**：wangEditor 内部节点树，绝对无损但不可移植、人类不可读。
- 建议存 HTML；如需极致保真再考虑 JSON（扩展名区分或同 `.mh` 内含标记）。

### 6.5 大文件与降级（沿用 ADR-02）

- >1MB 自动只读预览；wangEditor 对超大 HTML 同样降级关闭实时渲染。

---

## 7. 主题 / 暗色 / 字号

- **字号**：`settingsStore.applyTheme` 已注入 `--mk-font-size`（`settingsStore.ts:38-44`）；wangEditor 经配置或 CSS 变量消费。
- **暗色**：wangEditor v5 默认浅色。需实现暗色 CSS 覆盖（`.w-e-toolbar` / `.w-e-text-container` 背景与前景，绑定 `[data-theme="dark"]`）。**实现前必须验证可行性**（R3）。
- 复用现有 `--mk-*` token 体系（ARCHITECTURE §13），组件不写死颜色。

---

## 8. 本地图片落盘（`src/api/imageApi.ts` + Rust `image_cmd`）

- wangEditor `editorConfig.MENU_CONF.uploadImage.customUpload` 接管：
  1. 拿到 `file` → 读为 Base64；
  2. 调 `savePastedImage(docPath, base64, ext)`（现有 IPC，返回 `SavedImage{relPath}`）；
  3. 编辑器内插入 `<img src="./assets/xxx.png">`；
  4. 渲染经 `transformImageUrl` 解析为 `asset://`（`convertFileSrc`，ADR-05）。
- 与 md-editor-v3 共用同一套 `savePastedImage` + `./assets/` 约定。

---

## 9. PDF 导出复用

- `exportPdf()` 在 `WangEditorEngine` 内实现：取 `getViewHtml()` → 注入现有 `#export-pdf-preview` 预览体 → `window.print()`（沿用 md-editor-v3 的 ExportPDF 机制；注意 `MdExportPdfTool.vue` 的 `inheritAttrs:false` + 固定 light/zh-CN 约束）。
- 富文本导出版式与 Markdown 内核略有差异，需在 PRD 验收说明中载明。

---

## 10. 大纲 / 滚动同步 / 查找高亮

| 能力 | md-editor-v3 | wangEditor 适配方案 | 工作量 |
|------|-------------|-------------------|--------|
| 大纲 `getOutline` | Markdown AST | 解析 HTML `<h1>-<h6>` → `OutlineItem[]`（标题文本 + 顺序） | 低 |
| 大纲跳转（v0.4 新增） | `scrollToLine(line)` | HTML 无行语义：按标题在 DOM 中的顺序索引定位——`getOutline` 产出带序号条目，新增内部方法按索引 `scrollIntoView` 对应标题节点（`scrollToLine` 对 `'mh'` 退化为标题索引 = line 的映射，业务层无感） | 中 |
| 滚动同步（split） | 内核比例同步 | 编辑器 scroll → 右侧只读渲染按比例滚动（wangEditor 是否暴露 scroll 事件需核实；否则降级为不强制同步） | 中 |
| 查找高亮 `highlight` | CM6 装饰 | 在 wangEditor DOM 内做关键词标记；**建议降级**为仅编辑器内原生 `Ctrl+F`（R6） | 中/低 |

---

## 11. i18n

- wangEditor 内置 zh-CN / en；按 `settings.language` 切换（API 待核实 R5）。
- 新增 `src/i18n/packs/engine.ts` 键，覆盖 wangEditor 专有提示（如"已新建 .mh 富文本文档"）。

---

## 12. 构建与包体（`vite.config.ts` / `package.json`）

- 依赖新增：`@wangeditor/editor`、`@wangeditor/editor-for-vue@next`（**不再需要** markdown-it / turndown，已随 D 策略移除）。
- **不**将 wangEditor 加入 `manualChunks` 静态列表（现有 `mdeditor: ['md-editor-v3']` 不动）；改为在 `WangEditorEngine.vue` 内动态 `import()`，使其成独立懒加载 chunk（D4）。
- 实现前复核总包体是否仍满足 ≤15MB（NF-01 / R2）。
- 许可：确认 `@wangeditor/editor` MIT 与闭源分发兼容（NF-04）。

---

## 13. 测试策略

| 层 | 用例 |
|----|------|
| 适配层契约测试 | 用 `FakeEngine` 验证业务层仅依赖 `EngineHandle`；`WangEditorEngine` 实现 `getSaveContent`/`getViewHtml` |
| Vitest | `settingsStore` 新增 `editorEngine` 持久化；`saveActive` 在 `.mh` 标签下调 `getSaveContent`；`textKindOf` 识别 `.mh` |
| 手工 P0 | PRD §8 四条；`.md` 在 wangEditor 默认下仍由 Markdown 内核打开（零破坏）；暗色下编辑器无死白 |
| 包体 CI | 构建产物体积监控，wangEditor 未在首屏 chunk |

---

## 14. 任务分解（建议实现顺序）

| 编号 | 任务 | 涉及文件 | 依赖 | 验收 |
|------|------|---------|------|------|
| **K01** | 依赖引入 + 验证（版本/许可/暗色/i18n API） | `package.json` | — | `npm` 安装成功；暗色 CSS 原型验证；locale API 跑通 |
| **K02** | 设置模型：前端 `AppSettings.editorEngine` + Rust `models.rs` + 默认值/校验 | `api/types.ts`、`models.rs`、`settings_service.rs` | — | 读写链路通过；非法值回退 |
| **K03** | 设置 UI + i18n | `SettingsDialog.vue`、`i18n/packs/settings.ts`、`engine.ts` | K02 | 设置项可见且持久化 |
| **K04** | `WangEditorEngine.vue` 骨架（通用 `EngineHandle` + `getSaveContent`/`getViewHtml`） | `adapters/WangEditorEngine.vue`、`IMarkdownEngine.ts`、`index.ts` | K01 | 组件可挂载、输入、`Ctrl+S`、主题/字号跟随 |
| **K05** | 内容模型：`.mh` 打开 `setHtml` + 保存 `getHtml` + 存储选型（HTML） | `WangEditorEngine.vue`、`saveActive` | K04 | 新建/重开 `.mh` 内容一致；落盘本地 |
| **K06** | 路由：`textKindOf`/`TabKind` 加 `'mh'` + Workbench 三分支 + `opensInEdit` + **三处同步（`fileKind.ts` 图标、Rust `fs_service::TEXT_EXTS`、`search_service::TEXT_EXTS`）** | `tabsStore.ts`、`Workbench.vue`、`fileKind.ts`、`fs_service.rs`、`search_service.rs` | K04,K05 | `.mh` 走 wangEditor；`.md` 不变；文件树图标正常；全局搜索覆盖 `.mh`；文件可开性通过 |
| **K06b** | **新建文件链路（v0.4 新增）**：按 `editorEngine` 决定新建扩展名（wangeditor→`.mh`） | `Workbench.vue`（新建文件入口） | K02,K06 | 选 wangEditor 后新建出 `.mh`；切回 Markdown 新建恢复 `.md` |
| **K07** | 图片落盘 customUpload + asset:// | `WangEditorEngine.vue`、`imageApi.ts` | K04 | 粘贴图片落 `./assets/`、预览可见 |
| **K08** | PDF 导出复用（含打印样式验证，R7） | `WangEditorEngine.vue` | K04 | 富文本导出 PDF 可用；字号/行距/代码块打印样式正常 |
| **K09** | 大纲/滚动同步/查找高亮适配（含 R6 降级决策） | `WangEditorEngine.vue`、`Workbench.vue` | K04 | 大纲可见；同步/高亮达可接受态 |
| **K10** | 构建/包体复核 + 端到端验收 | `vite.config.ts`、`package.json` | 全部 | ≤15MB；P0 全绿 |

---

## 15. 风险登记（汇总 PRD §7）

| # | 风险 | 等级 | 缓解 / 决策点 |
|---|------|------|--------------|
| R1 | 格式碎片化（新增 `.mh` 族） | 中 | 文档明确双格式定位；阶段二可选"`.md`→`.mh` 转换导出" |
| R2 | 包体超限 | 中 | 动态 import + 体积复核（K01/K10） |
| R3 | 暗色主题可行性 | 中 | K01 原型验证；失败则阶段一仅亮色 + 提示 |
| R4 | 版本兼容（**v0.4 修订**） | 中 | wangEditor v5 上游已停止积极维护（2023 年后基本无更新，issue 堆积），**锁定版本不指望上游升级修复**；K01 npm 实测当前最新小版本与 Vue3/vite 兼容性，评估结论计入选型 |
| R5 | i18n API | 低 | K01 核实 |
| R6 | 查找高亮实现成本 | 中 | 可降级为原生 Ctrl+F（K09 决策） |
| R7 | PDF 打印样式（v0.4 新增） | 低 | `#export-pdf-preview` 宿主与打印 CSS 围绕 Markdown 输出调整，富文本 HTML 注入后字号/行距/代码块样式需验证；并入 K08 验收 |

> 原"md↔html 保真度损耗（高）"风险已随 D 策略消除。

---

*设计文档结束（v0.4 评审修订定稿）。所有代码改动待飞总下令实施；当前阶段仅出文档，未动代码。按 K01–K06b、K07–K10 落地即可。*
