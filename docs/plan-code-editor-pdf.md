# MkDown 开发方案：代码编辑引擎 + PDF 应用内预览

> 版本：v0.2（开发方案 · 已复审修订）
> 作者：高见远（架构师）；复审修订：小B（2026-10-09，逐项对照真实代码，修正 5 处，见文末修订记录）
> 日期：2026-10-09
> 范围：在现有 MkDown（md-editor-v3 + Tauri 2 + Vue3 + Pinia）上扩展两项能力
> 1. **代码编辑**：让 `.py/.rs/.ts/.js/.json/.sql/.css…` 等源文件用真正的代码编辑器打开（目前被 md-editor-v3 当 Markdown 误渲染）
> 2. **PDF 应用内预览**：`pdf` 文件不再丢给系统程序，改为应用内 canvas 渲染
> 决策（已与飞总确认）：代码引擎 = **CodeMirror 6 自建**；PDF = **pdfjs-dist** 渲染。

---

## 0. 实现现状与文档差异（重要，避免按错骨架改）

`docs/ARCHITECTURE.md` 是 v1.1 架构基线，但落地代码已偏离其描述，方案以**真实代码**为准：

| ARCHITECTURE.md 描述 | 真实代码（`src/`） |
|---|---|
| `IMarkdownEngine`（class 接口）+ `EngineFactory` | `src/adapters/IMarkdownEngine.ts` 仅定义 `EngineHandle`（组件 `defineExpose` 契约）；`src/adapters/index.ts` 导出 `MdEditorV3Engine` 与 `createEngineKind()`（无 Factory 类） |
| `MdEditorV3Engine.ts`（class） | `src/adapters/MdEditorV3Engine.vue`（SFC 组件，经 `defineExpose` 暴露 `EngineHandle`） |
| `EditorMode = 'edit'\|'split'\|'preview'\|'read'` | 真实 `EditorMode = 'edit'\|'split'\|'read'`（无独立 `preview`） |
| 业务层经 `EngineFactory.createEngine()` 拿实例 | 业务层在 `Workbench.vue` 直接 `<MdEditorV3Engine ref="engineRef">` 挂载，`engineRef` 类型 `EngineHandle` |

**结论**：本方案在 `MdEditorV3Engine.vue` 同层新增 `CodeEditorEngine.vue`，沿用 `defineExpose(EngineHandle)` 契约；`Workbench.vue` 按 `tab.kind` 选择挂载哪个引擎。不引入 class/Factory 体系。

---

## 1. 现状边界（基于源码实证）

| 能力 | 现状 | 证据 |
|---|---|---|
| 编辑 Markdown | ✅ 完善 | `src/adapters/MdEditorV3Engine.vue` |
| 编辑代码类文件 | ⚠️ 能打开但**误渲染** | `src-tauri/src/services/fs_service.rs` 的 `TEXT_EXTS`（46 项）把 `.py/.rs/.ts/.js/.json/.sql/.css` 等判为文本 → `Workbench.routeByType` 进编辑器；但编辑器是 md-editor-v3（Markdown 专用），代码被当 MD 解析 |
| 预览 docx/xlsx/图片 | ✅ 已有 | `fs_service.preview_kind()` 返回 docx/xlsx/image；`Workbench` 模板挂 `DocxPreview/SheetPreview/ImagePreview` |
| 预览 HTML/SVG | ✅ 分栏/阅读态由 Frame 渲染 | `HtmlFrame.vue` / `SvgFrame.vue` |
| 预览 **PDF** | ❌ 缺口 | `pdf` 在 `BINARY_EXTS` → `preview_kind` 返回 `None` → `routeByType` 走 `openInSystem` |
| 预览 PPT/其他 | ❌ 缺口（前端无可靠渲染器） | 本期不做 |

**关键推论**：
- 代码编辑的"打开"链路**已通**（Rust `is_text_file` 已放行），只需在前端把代码文件路由到**新引擎**即可，**Rust 侧零改动**。
- PDF 预览需要 Rust 一处小改（`preview_kind` 增 `pdf`）+ 前端新组件。

---

## 2. 总体改动地图

### 阶段一：代码编辑引擎（纯前端）
| 文件 | 改动性质 | 说明 |
|---|---|---|
| `src/utils/fileKind.ts` | 改 | 导出 `isCodeExt(name)` 或 `codeKindOf()`，供 `tabsStore` 复用（已有 `EXT_KIND` 把代码扩展名标 `'code'`，仅前端展示用） |
| `src/stores/tabsStore.ts` | 改 | `TabKind` 增 `'code'`；`textKindOf()` 按扩展名把代码类归 `'code'` |
| `src/adapters/IMarkdownEngine.ts` | 改 | `EngineHandle` 拆为「通用」+「Markdown 专属（可选）」两段，见 §4.2 |
| `src/adapters/CodeEditorEngine.vue` | **新增** | 纯 CodeMirror 6 代码引擎，实现通用 `EngineHandle` |
| `src/adapters/index.ts` | 改 | 导出 `CodeEditorEngine` |
| `src/views/Workbench.vue` | 改 | 按 `tab.kind` 选择挂载 `MdEditorV3Engine` / `CodeEditorEngine`；代码标签强制 edit 模式、隐藏模式切换/大纲/格式快捷键 |
| `src/components/Toolbar.vue` | 改 | 当激活标签为代码时禁用 read/split 模式按钮 |
| `src-tauri/...` | **不改** | 代码文件走既有 `is_text_file` 文本路径 |

### 阶段二：PDF 应用内预览
| 文件 | 改动性质 | 说明 |
|---|---|---|
| `src-tauri/src/services/fs_service.rs` | 改 | `preview_kind()` 增 `"pdf" => Some("pdf")`；`BINARY_EXTS` 移除 `pdf`（可选，仅为语义清晰） |
| `src/stores/tabsStore.ts` | 改 | `PreviewKind` 增 `'pdf'`；`openPreviewByPath` 已支持，无需改逻辑 |
| `src/api/fileApi.ts` | 改 | `probePreviewKind` 返回类型联合需增 `'pdf'`（当前是 `'docx'|'xlsx'|'image'|null`，不加会类型报错） |
| `src/components/preview/PdfPreview.vue` | **新增** | pdfjs-dist 渲染 canvas + 翻页/缩放 |
| `src/views/Workbench.vue` | 改 | `routeByType` 的预览分支是**白名单判断**（`kind === 'docx' || kind === 'xlsx' || kind === 'image'`，Workbench.vue:268），**必须显式加入 `'pdf'`**（建议改为 `if (kind)`，与 preview_kind 命中即预览的语义一致）；模板增 `<PdfPreview v-else-if="kind==='pdf'">` |
| `src-tauri/tauri.conf.json` | **不改** | CSP `connect-src` 已含 `asset: http://asset.localhost`（2026-09-24 冻结预览架构时已放行），fetch PDF 字节无需任何 CSP 改动 |
| `package.json` | 改 | 增 `pdfjs-dist`（+ CodeMirror 相关包，见 §3，注意 `codemirror` 包名） |

---

## 3. 依赖清单（前端）

> 严守 `ARCHITECTURE.md` 决策 **D4：高亮/重体积库全部懒加载**，以及"禁网"硬约束（pdfjs/md-editor 均本地打包，不联网）。

| 包 | 用途 | 加载方式 |
|---|---|---|
| `@codemirror/state` `@codemirror/view` `@codemirror/commands` `@codemirror/language` `@codemirror/autocomplete` `@codemirror/search` `@codemirror/lint` | CodeMirror 6 内核 | 静态（已间接依赖 `@codemirror/view`/`@codemirror/language`，补齐其余） |
| `codemirror`（`basicSetup`） | 行号/折叠/括号匹配/自动补全（官方整合包；**注意没有 `@codemirror/extensions` 这个包**） | 静态 |
| `@codemirror/lang-javascript` `@codemirror/lang-json` `@codemirror/lang-html` `@codemirror/lang-css` `@codemirror/lang-python` `@codemirror/lang-rust` `@codemirror/lang-sql` `@codemirror/lang-yaml` `@codemirror/lang-cpp` `@codemirror/lang-java` `@codemirror/lang-markdown` | 主流语言高亮 | **按扩展名动态 `import()`**，见 §4.3 |
| `@codemirror/legacy-modes` | go/shell/ini/toml/lua/ruby 等其余语言的 StreamLanguage | **动态 `import()`** |
| `@codemirror/theme-one-dark`（或自写 token 主题） | 暗色主题 | 动态/静态均可 |
| `pdfjs-dist` | PDF 解析与渲染 | **组件内动态 `import()`**（PdfPreview 挂在 Workbench 模板内，顶层静态 import 会把 pdfjs 主库拉进首屏 chunk，违背 D4）；worker 经 `?url` 单独成 chunk |

> 体积控制：所有 `lang-*` 与 `legacy-modes` 必须在 `CodeEditorEngine.vue` 内**按需动态 import**，不要顶层静态 import，避免首次加载即拉全量语言包（违反 D4）。

---

## 4. 阶段一详细设计：代码编辑引擎

### 4.1 CodeEditorEngine.vue 核心结构
纯 CM6，不依赖 md-editor-v3。组件 `defineExpose` 实现通用 `EngineHandle`，逻辑与 `MdEditorV3Engine.vue` 中已有的 CM6 操作（滚动定位、`scrollIntoView` effect、光标追踪）同源，可直接复用范式。

```ts
// 伪代码骨架
import { EditorView, basicSetup } from '@codemirror/view'; // 实际按包拆分
import { EditorState } from '@codemirror/state';
import { mkFindExtension, setCmFind } from './findHighlight'; // 复用现有查找高亮扩展
import { codeTheme } from './codeTheme';                     // 绑定 --mk-* token 的主题

async function buildLanguage(ext: string) {
  // 动态 import，按扩展名映射到 lang-*
  switch (ext) {
    case 'ts': case 'tsx': return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true });
    case 'js': case 'jsx': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'py': return (await import('@codemirror/lang-python')).python();
    case 'rs': return (await import('@codemirror/lang-rust')).rust();
    case 'sql': return (await import('@codemirror/lang-sql')).sql();
    case 'json': return (await import('@codemirror/lang-json')).json();
    case 'go': { const { go } = await import('@codemirror/legacy-modes/mode/go'); return StreamLanguage.define(go); }
    // ... 其余映射见 §4.3
    default: return []; // 无高亮，纯文本
  }
}
```

### 4.2 EngineHandle 契约重构（关键）
现状 `EngineHandle` 把 Markdown 专属方法（`setHeading`/`wrapSelection`/`exportPdf`/`togglePageFullscreen`）和通用方法混在一起。代码引擎不应实现 Markdown 专属方法。`Workbench.vue` 对专属方法已用 `?.` 可选调用，因此拆成"通用必实现 + Markdown 可选"即可零破坏：

```ts
// src/adapters/IMarkdownEngine.ts
export interface CommonEngineHandle {
  scrollToLine(line: number, headingIndex?: number): void;
  insert(text: string): void;
  highlight(keyword: string, caseSensitive?: boolean): void;
  clearHighlight(): void;
}
export interface MarkdownEngineHandle extends CommonEngineHandle {
  wrapSelection(prefix: string, suffix: string, placeholder?: string): void;
  setHeading(level: number): void;
  togglePageFullscreen(): void;
  exportPdf(): Promise<void>;
}
// 对外统一类型：通用必选 + Markdown 方法可选
export type EngineHandle = CommonEngineHandle & Partial<MarkdownEngineHandle>;
```

- `MdEditorV3Engine.vue`：`defineExpose` 不变（实现全部）。
- `CodeEditorEngine.vue`：`defineExpose` 仅实现 `scrollToLine/insert/highlight/clearHighlight`（及 `onCursor` 等事件），**不暴露** `setHeading`/`wrapSelection`/`exportPdf`。
- `Workbench.vue` 现有 4 处专属方法调用点（`wrapSelection`×1、`setHeading`×1、`togglePageFullscreen`×1、`exportPdf`×1）当前只有一层 `engineRef.value?.`；拆分后方法本身可能 `undefined`（strict TS 报 TS2722），**需补第二层 `?.`**（如 `engineRef.value?.setHeading?.(...)`）。改动小但必须做，否则 `vue-tsc --noEmit` 不过。

### 4.3 语言包映射表（扩展名 → CM6 Language）
| 扩展名 | 语言支持 | 来源包 |
|---|---|---|
| `ts` `tsx` | javascript({typescript,jsx}) | `@codemirror/lang-javascript` |
| `js` `mjs` `cjs` `jsx` | javascript({jsx}) | 同上 |
| `json` `jsonc` `json5` | json() | `@codemirror/lang-json` |
| `html` `htm` | html() | `@codemirror/lang-html` |
| `vue` `svelte` | 降级 html()（最佳努力，非完美） | 同上 |
| `css` `scss` `less` `sass` | css() | `@codemirror/lang-css` |
| `py` | python() | `@codemirror/lang-python` |
| `rs` | rust() | `@codemirror/lang-rust` |
| `sql` | sql() | `@codemirror/lang-sql` |
| `yaml` `yml` | yaml() | `@codemirror/lang-yaml` |
| `cpp` `c` `h` `hpp` | cpp() | `@codemirror/lang-cpp` |
| `java` | java() | `@codemirror/lang-java` |
| `go` | StreamLanguage(go) | `@codemirror/legacy-modes/mode/go` |
| `sh` `bash` `zsh` | StreamLanguage(shell) | `@codemirror/legacy-modes/mode/shell` |
| `bat` `ps1` | StreamLanguage(powershell) | `@codemirror/legacy-modes/mode/powershell` |
| `toml` `ini` `cfg` `conf` `properties` `env` | StreamLanguage(toml/ini) | `@codemirror/legacy-modes/mode/{toml,properties}` |
| `xml` `xsd` `xsl` | xml() | `@codemirror/lang-html` 或 `@codemirror/legacy-modes/mode/xml` |
| `rb` | StreamLanguage(ruby) | `@codemirror/legacy-modes/mode/ruby` |
| 其他 | 纯文本（无高亮） | — |

### 4.4 主题与样式（与现有编辑器一致）
现有 `MdEditorV3Engine.vue` 已用 `--mk-editor-fg`/`--mk-font-size`/`--mk-bg` 等 token 校准 CM6 外观。代码引擎新建 `src/adapters/codeTheme.ts`：
- `EditorView.theme({...}, {dark: settings.isDark})` 绑定到同名 `--mk-*` 变量（亮/暗自动跟随）。
- 字号跟随 `settings.fontSize`（复用 `Workbench` 已传的 `:font` 逻辑 / `editorStore`）。
- 行高/字体族与现有 CM 编辑区对齐（`Consolas, 'Cascadia Mono', 'Microsoft YaHei', monospace`）。

### 4.5 模式与 UI 约束（代码标签）
- 代码文件 **只支持 edit 模式**（无 Markdown 式的 split/read）。`Workbench.setMode` 对代码标签忽略 read/split；`Toolbar` 的模式按钮在 `kind==='code'` 时禁用。
- `showOutline` 计算属性已排除 `html`/`svg`/预览类；补一条 `kind==='code'` 排除（代码无 Markdown 大纲概念）。
- 格式快捷键（`handleFormatShortcut`：Ctrl+B/I/1~6/Shift+C 等）**仅对 Markdown 标签生效**；代码标签下这些键交 CM6 自身 keymap（或 no-op）。在 `Workbench` 内加 `isMarkdownTab` 门控。
- 拖拽打开：`Workbench.onDragDrop` 的 `OPENABLE_EXT` 当前为 `/\.(md|markdown|txt)$/i`，扩展为含代码扩展名（或直接复用 `fileKind()` 的 `code` 判定），使拖入 `.py/.ts` 等也进编辑。
- 光标/状态栏：代码引擎需像 `MdEditorV3Engine` 一样 `emit('cursor', {line, col})`，让底部状态栏 L:C 对代码也有效。

### 4.6 复用点（避免重造）
| 现有能力 | 复用方式 |
|---|---|
| 查找高亮 `findHighlight.ts`（`mkFindExtension` + `setCmFind`） | CM6 装饰，语言无关；代码引擎直接 import 同一扩展，调用 `setCmFind` 即可 |
| 滚动定位（`.cm-content .cm-line` + `EditorView.scrollIntoView`） | 与 `MdEditorV3Engine` 编辑态逻辑完全一致，复制范式 |
| 保存链路（`tabs.markDirty` → `writeFileAtomic` + 编码/BOM 守卫） | 代码标签走与文本标签完全相同的保存链路（`saveActive` 已按 `isUtf8`/`hadBom` 守卫） |
| 主题/字号响应式（`settingsStore`） | 直接读同一 store |

---

## 5. 阶段二详细设计：PDF 应用内预览

### 5.1 Rust 侧（一处小改）
```rust
// src-tauri/src/services/fs_service.rs
pub fn preview_kind(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    match ext.as_str() {
        "docx" => Some("docx"),
        "xlsx" | "xlsm" => Some("xlsx"),
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "ico" => Some("image"),
        "pdf" => Some("pdf"),   // ← 新增
        _ => None,
    }
}
```
**`BINARY_EXTS` 里的 `"pdf"` 必须保留，绝不能移除**（修订：v0.1 认为"可移除、仅为语义清晰"，是错的）：
`is_text_file` 的判定顺序是 大小闸门 → **黑名单** → 白名单 → 无扩展名文本名 → `sniff_text` 兜底。pdf 不在 `TEXT_EXTS`，一旦移出黑名单会掉进 `sniff_text`——PDF 文件头 `%PDF-1.x` 是合法 UTF-8，若前 8KB 无 NUL 字节（纯文本结构的 PDF 很常见），嗅探会把它判成文本。且 `Workbench.routeByType` 里 `probeTextFile` **先于** `probePreviewKind`，编辑器分支直接短路，PDF 预览永远轮不到。黑名单是唯一防线。

### 5.2 pdfjs-dist 集成与 worker 加载（Tauri 关键点）
```ts
// src/components/preview/PdfPreview.vue
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'; // Vite 资源 URL
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
```
- **dev 环境**：`?url` 指向 `http://localhost:1420/...`，WebView2 可 fetch，正常。
- **prod 环境**：Vite 把 worker 打进 `dist/assets/`，经 Tauri 自定义协议同源提供，通常可用。
- **风险/兜底**：若 prod 下 worker 同源策略报错，退路是把 `workerSrc` 设为 `convertFileSrc(绝对路径)`（需把 worker 文件拷到 `src-tauri/resources` 并由 `tauri.conf.json` 的 `bundle.resources` 打包）。**本方案以 `?url` 为首选，prod 打包后实测验证**。
- CSP：`connect-src` 已放行 `asset: http://asset.localhost`（Windows 下 asset 协议是 **http** 不是 https）；`script-src 'self'` 覆盖同源 worker，module worker 同源加载不需 `blob:`；若报错再补。

### 5.3 PdfPreview.vue 设计
```ts
// 伪代码
import { convertFileSrc } from '@tauri-apps/api/core';
const url = convertFileSrc(props.path);          // https://asset.localhost/...
const buf = await (await fetch(url)).arrayBuffer();
const doc = await pdfjsLib.getDocument({ data: buf }).promise;
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const canvas = renderPage(page, scale);        // 按 PreviewZoomBar 的 scale 渲染
  container.appendChild(canvas);
}
```
- 字节获取：用 `convertFileSrc(path)` + `fetch` 取 `arrayBuffer`（复用既有 asset 协议，符合 ADR-05）。CSP `connect-src` **已放行** `asset: http://asset.localhost`（无需改动）。
- 渲染：`page.getViewport({scale})` → canvas 逐页渲染；缩放复用 `PreviewZoomBar.vue` 已有的 scale 状态（或新建精简缩放条）。
- 翻页：顶部/底部加页码输入 + 上/下页按钮；或整文档连续滚动（推荐连续滚动，体验更接近阅读）。
- 只读：PDF 标签为预览类，`saveActive` 已对 `activeIsPreview` 拦截，无需额外处理。

### 5.4 前端路由接入
- `tabsStore.PreviewKind` 增 `'pdf'`；`openPreviewByPath` 逻辑不变（已按 kind 建只读预览标签）。
- `Workbench.routeByType`（修订：v0.1 说"无需改分支"是错的）：当前是**白名单** `if (kind === 'docx' || kind === 'xlsx' || kind === 'image')`（Workbench.vue:268），pdf 命中后不改动会掉进 `openInSystem`。**改为 `if (kind)` 即可**（probe_preview_kind 返回非 null 即预览，与 Rust 侧 `preview_kind` 命中即预览的语义严格一致，后续加预览种类也不再改前端）。
- `Workbench` 模板在现有预览组件后追加：
  ```html
  <PdfPreview v-else-if="tabs.activeTab.kind === 'pdf'" :path="tabs.activeTab.path ?? ''" />
  ```

---

## 6. 关键技术风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | `EngineHandle` 拆分破坏现有调用 | 编译/运行错误 | 用 `Partial<MarkdownEngineHandle>` 语义零破坏；但 Workbench 4 处专属方法调用点需补第二层 `?.`（§4.2），`vue-tsc` 保障 |
| R2 | 代码引擎误实现 Markdown 方法 | 行为错乱 | 代码引擎 `defineExpose` 只暴露通用方法；UI 在代码标签下禁用相关按钮 |
| R3 | `lang-*` 全量静态 import 撑大首屏 | 违反 D4、包体超 15MB | 全部动态 `import()`，按扩展名懒加载（§3/§4.1） |
| R4 | pdfjs worker 在 prod 下加载失败 | PDF 打不开 | 首选 `?url`；兜底 `convertFileSrc` + `bundle.resources` 打包 worker（§5.2） |
| R5 | ~~fetch PDF 字节被 CSP 拦~~ | （已消解） | `connect-src` 已含 `asset: http://asset.localhost`，实测配置无需改动（复审确认，tauri.conf.json:28） |
| R6 | 代码标签下格式快捷键误触发 | 把代码包进 `**` 等 | `Workbench` 加 `isMarkdownTab` 门控，代码标签下格式快捷键不接管（§4.5） |
| R7 | 切换标签时两个引擎实例并存/泄漏 | 内存/光标异常 | 沿用现有 `v-if` 卸载机制；代码引擎 `onBeforeUnmount` 调 `view.destroy()` |
| R8 | 超大代码文件（>MAX_TEXT_BYTES=8MB）卡顿 | 编辑卡 | 沿用 Rust 侧 `MAX_TEXT_BYTES` 闸门，超大文件根本不进编辑器（已生效） |

---

## 7. 验证与回归（复用既有无头工作流）

> 项目已有 `repro/*.html` + Edge `--headless=new --dump-dom` 无头验证范式（见 `working_memory`：rAF polyfill、live query、CM6 测量坑）。本功能验证沿用之。

### 代码引擎验证点
1. 打开 `.ts` 文件 → 挂载 `CodeEditorEngine`，关键字/字符串/注释高亮正确。
2. 打开 `.py` / `.rs` / `.sql` → 各自语言高亮生效（验证动态 import 映射）。
3. 文件内查找（Ctrl+F）→ `mkFindExtension` 高亮命中（复用验证）。
4. 大纲跳转/搜索命中跳转 → `scrollToLine` 滚动到正确行。
5. 底部状态栏 L:C 随光标更新。
6. Ctrl+S 保存 → 原子写 + 脏标记清除（复用 `saveActive` 链路）。
7. 代码标签下 Alt+R/Alt+W 模式切换被禁用；Ctrl+B 等格式键不包 Markdown 语法。
8. 关闭/切换标签 → 引擎 `destroy()`，无 CM 实例泄漏（无头 dump 校验）。

### PDF 预览验证点
1. 双击/拖入 `.pdf` → 进应用内预览标签，首屏渲染第一页（离线断网验证，零外联）。
2. 多页连续滚动 / 翻页按钮正确。
3. 缩放条改变 `scale` → 画布重绘清晰。
4. `routeByType` 对 pdf 走 `openPreviewByPath`，不触发 `saveActive`（预览类守卫）。
5. prod 构建后 PDF worker 实际加载成功（R4 兜底路径在 dev 验证通过后，prod 单独验证）。

### 回归（确保不破坏既有）
- Markdown 三模式 / 滚动同步 / 大纲 / 查找 / 导出 PDF 行为不变（代码引擎为新增分支，不触既有 `MdEditorV3Engine`）。
- docx/xlsx/image 预览不变。
- `cargo test`（fs_service：编码/原子写/预览种类）全绿；`vue-tsc --noEmit` 通过。

---

## 8. 工作量与排期（估算）

| 阶段 | 任务 | 估时 |
|---|---|---|
| 一 | 依赖安装 + `EngineHandle` 拆分 + `tabsStore` 增 `code` | 0.5 天 |
| 一 | `CodeEditorEngine.vue`（CM6 装配 + 语言映射 + 主题 + 查找/滚动/光标/保存） | 1.5 天 |
| 一 | `Workbench`/`Toolbar` 路由与条件 UI + 拖拽扩展 | 0.5 天 |
| 一 | 无头验证 + 回归 | 0.5 天 |
| 二 | `fs_service.preview_kind` 增 pdf + `PreviewKind` 类型 | 0.25 天 |
| 二 | `PdfPreview.vue`（pdfjs + worker + 翻页/缩放） | 1 天 |
| 二 | CSP/tauri.conf 调整 + `Workbench` 接入 + prod worker 验证 | 0.5 天 |
| 二 | 无头验证 + 回归 | 0.5 天 |
| **合计** | | **约 6~7 天** |

---

## 9. 验收清单（提交前逐条）

### 代码编辑
- [ ] `.ts/.js/.py/.rs/.sql/.json/.css/.go/.sh/.toml` 等打开即语法高亮，非 Markdown 误渲染
- [ ] 查找高亮、行跳转、L:C 状态、Ctrl+S 保存均可用
- [ ] 代码标签：模式切换/大纲/格式快捷键正确禁用
- [ ] 切换/关闭标签无引擎实例泄漏

### PDF 预览
- [ ] `.pdf` 应用内预览，首屏与多页渲染正确，离线零外联
- [ ] 翻页/缩放可用
- [ ] 不触发保存（预览类守卫）
- [ ] prod 构建下 worker 加载成功

### 回归
- [ ] Markdown 全功能不变；docx/xlsx/image 预览不变
- [ ] `cargo test` + `vue-tsc --noEmit` 通过

---

*本文档为开发方案。编码阶段严格按 §2 改动地图与 §7 验证点执行。*

---

## 附：v0.2 复审修订记录（2026-10-09，逐项对照真实代码）

| # | 位置 | v0.1 原文 | 问题 | 修订 |
|---|---|---|---|---|
| 1 | §5.1 | `BINARY_EXTS` 移除 `pdf`（可选，仅为语义清晰） | **功能性硬伤**：pdf 移出黑名单后掉进 `sniff_text` 兜底，`%PDF-` 头是合法 UTF-8、前 8KB 常无 NUL → 会被判成文本；且 `routeByType` 里 `probeTextFile` 先于 `probePreviewKind` 直接短路 | **保留** `pdf` 在 `BINARY_EXTS`，一行不动 |
| 2 | §5.4 | `routeByType` 同一分支"自动覆盖，无需改分支" | **功能性硬伤**：真实代码是白名单 `kind === 'docx' \|\| 'xlsx' \|\| 'image'`（Workbench.vue:268），pdf 会掉进 `openInSystem` | 白名单改 `if (kind)`；`fileApi.probePreviewKind` 返回类型联合增 `'pdf'` |
| 3 | §3 | `@codemirror/extensions`（basicSetup） | **包名不存在**：basicSetup 在官方整合包 `codemirror` 里 | 改为 `codemirror`；`@codemirror/lint` 无用武之地（无 lint 源），从依赖清单裁剪 |
| 4 | §2/§5.2/§5.3/§6-R5 | CSP `connect-src` 增 `asset:`/`https://asset.localhost` | **过时**：connect-src 已含 `asset: http://asset.localhost`（预览架构冻结时放行）；且 Windows 下 asset 协议是 http 不是 https | tauri.conf.json **零改动**，R5 消解 |
| 5 | §4.2/§6-R1 | 拆分后调用点"零破坏" | `Partial<MarkdownEngineHandle>` 后方法可能 `undefined`，strict TS 下现有 4 处调用报 TS2722 | 4 处调用点补第二层 `?.`（`engineRef.value?.setHeading?.(...)`） |

另：pdfjs-dist 加载方式由"静态"改为"组件内动态 `import()`"（PdfPreview 挂在 Workbench 模板内，静态 import 会把 ~1MB 主库拉进首屏 chunk，违背 D4）。
