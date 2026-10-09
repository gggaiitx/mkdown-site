# 码克 - MarkDown 桌面编辑与阅读器 

> 本地优先的 Markdown 编辑与阅读器 · Rust + Tauri 2.x 外壳 · Vue 3 + Vite + TypeScript + Pinia 前端 · md-editor-v3 v7 编辑内核
>
> 纯本地、离线优先、中文原生。文档、图片、配置全部落在本机磁盘，不上云、不登录、不联网。

**下载安装**：前往 [Releases](https://github.com/gggaiitx/mkdown-site/releases)（当前 v0.5.1）或[官网下载页](https://mkdown.opensites.net)获取安装包——Windows 为 NSIS 安装包（自带卸载程序，注册到系统「应用与功能」，卸载保留用户数据）；macOS 提供 Apple 芯片 / Intel 双架构 dmg（未签名，首次打开需绕过 Gatekeeper，见 Release 说明）。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 外壳 | Rust + Tauri 2.x（Windows 优先，WebView2；macOS 走 CI 云端构建） |
| 编辑内核 | md-editor-v3 v7（CodeMirror 6 内核，经 `IMarkdownEngine` 适配层隔离，仅处理 Markdown） |
| 代码编辑引擎 | CodeMirror 6 自建（`CodeEditorEngine.vue`，经 `adapters` 适配层与 Markdown 内核并列，处理全部非 Markdown 文本 / 源码） |
| 前端 | Vue 3 + Vite 7 + TypeScript 5 + Pinia 3 |
| 富媒体预览 | docx-preview（Word）+ SheetJS `sheet_to_html`（Excel）+ 原生 `<img>` / `iframe` |
| 文件 IO | 自写 `#[tauri::command]`（原子写 / 编码探测 / 回收站删除） |
| 搜索 | `ignore` + `grep-searcher` 实时遍历，Channel 流式推送 |

## 功能总览

### 编辑与阅读（Markdown 文本）
- **编辑 / 分屏 / 阅读** 三模式切换（分栏实时预览、滚动同步、沉浸阅读态）
- **多标签页**，脏标记 ●，切换 / 关闭 / 退出均有未保存确认
- **大纲面板**：随内容实时更新，点击跳转（编辑态 CodeMirror 定位 / 阅读态锚点滚动）；左缘拖拽调宽（160–460px），拖到最右隐藏、拖动右缘边线复原
- **会话快照**：重启后自动恢复上次的标签页与光标位置，未保存内容恢复后仍标记为未保存（不替用户写盘）
- **模板库**：新建文档可套用「笔记 / 方案骨架」；**自动保存**（可开关，停顿后原子落盘）
- **图表与公式**：Mermaid 流程图 + KaTeX 公式（内核按需懒加载）
- **预览主题**：内置 default / github / vuepress / mk-cute / smart-blue / cyanosis 六主题，另含自建 **win** 主题（Windows 11 Fluent 风：系统蓝强调、Segoe UI 字体栈、卡片式代码块、可隐藏 mac 红绿灯）；打印 PDF 与预览同主题

### 代码编辑引擎（非 Markdown 文本）

Markdown 之外的所有文本文件统一由自建 **CodeMirror 6 代码引擎**接管（与 md-editor-v3 内核经 `src/adapters/` 适配层隔离，互不耦合）：

- **语法高亮（250+ 扩展名，按需懒加载、首屏零增长）**：
  - JS / TS 系：`js` `mjs` `cjs` `jsx` `ts` `tsx` `es6` `mts` `cts`
  - JSON / 数据交换：`json` `jsonc` `json5` `ndjson` `geojson` `jsonld`
  - Web 标记 / 模板：`html` `htm` `xhtml` `vue` `svelte` `xml` `xsd` `xsl` `svg` `rss` `atom` `jsp` `erb` `ejs`
  - 样式：`css` `scss` `less` `sass` `pcss` `stylus`
  - 配置 / 差异：`toml` `ini` `cfg` `conf` `properties` `env` `config` `diff` `patch` `dockerfile` `cmake`
  - 后端 / 脚本：`py` `rs` `go` `java` `rb` `lua` `pl` `r` `swift` `groovy` `julia` `sh` `bash` `bat` `ps1`
  - C / C++ / 系：`c` `h` `cpp` `hpp` `cc` `cxx` `cs` `scala` `kotlin` `dart`
  - SQL 方言：`sql` `mysql` `pgsql` `sqlite` `mssql` `mariadb` `oracle` `hive` `spark`
  - 更多（legacy-modes）：`clj` `hs` `elm` `erl` `lisp` `scm` `ocaml` `pas` `d` `fortran` `v` `vhd` `asm` `cob` `cr` `coffee` `tex` `tcl` `proto` `sparql` `xquery` 等
- **纯文本不再误渲染**：`.txt / .log / .csv / .tsv` 及无扩展名文本文件改为纯文本编辑，`#`、`**`、`-` 等字符保持字面量原样，不再被误判为 Markdown。
- **HTML / SVG 源码高亮**：编辑态为带高亮的源码；分栏态左侧源码、右侧 `<iframe>` 实时渲染（相对资源经 `<base href=asset://>` 加载、脚本不执行）；阅读态由内置 Frame 呈现。
- **拖拽即开**：拖入代码、文本、HTML、SVG 文件直接打开编辑，源码类默认进编辑态。
- **配色**：自建 GitHub Light / GitHub Dark 双主题（关键词红、函数紫、类型橙、字符串浅蓝、注释灰斜体），跟随亮 / 暗切换；选区与光标清晰可见。
- **快捷键跨平台**：提示按平台显示（⌘ / ⌥ / ⇧ 或 Ctrl / Alt / Shift），⌥E / ⌥W / ⌥R 模式切换在 macOS 可用（Option 死字符键位已兼容）。
- **界面字号固定**：顶栏 / 标签栏 / 状态栏 / 目录树等界面文字不再随「字号」设置缩放，字号仅作用于编辑区与预览正文。

### 文件与工作区
- **多工作区**：左上角根目录名一键切换，最近列表（上限 10）自动去重，支持单项移除 / 全部移除（仅清列表不删文件）；切换前未保存文档确认
- **工作区边线**：右缘拖拽调宽（200–440px），拖到最左隐藏（与「隐藏工作区」按钮一致）；隐藏后左缘边线拖动向右展开（交互同大纲面板）
- **工作区文件树**：新建 / 重命名 / 删除（进回收站）/ 刷新 / 右键菜单 / 名称过滤 / 折叠全部
- **打开分流三分支**：文本类进编辑器 → docx / xlsx / 图片进应用内预览标签 → 其余（pdf / ppt / 音视频 / drawio…）交系统默认程序（判定唯一真相源在 Rust 侧）
- **原子写**：临时文件 + rename，写一半崩溃不毁原文件；UTF-8 / BOM / UTF-16 / GBK 自动探测，非 UTF-8 禁止就地写（防乱码毁文件）
- **图片粘贴落盘**：截图粘贴自动存文档同级 `assets/`，文档内保留相对路径（可整体搬迁），预览经 `asset://` 加载

### 应用内预览（只读）
- **Word（.docx）**：docx-preview 渲染，保留 Word 纸张视觉 / 页眉页脚 / 图片
- **Excel（.xlsx）**：SheetJS 转 HTML 表格，多工作表页签切换
- **图片**：png / jpg / gif / bmp / webp / svg / ico，带缩放工具条
- **HTML / SVG**：已移交代码编辑引擎——编辑态源码高亮，分栏态左侧源码 + 右侧 `<iframe>` 实时渲染（相对资源经 `<base href=asset://>` 加载、脚本不执行），阅读态由内置 Frame 呈现（详见上文「代码编辑引擎」）。
- 预览区均带「用系统默认程序打开」按钮；.doc / .ppt 等遗留 OLE 格式仍交系统程序

### 其他
- **全局搜索**：工作区文件名 + 正文，正则 / 大小写 / 仅 .md 可选，结果高亮直达
- **导出 HTML**（asset:// 自动还原相对路径）；**导出 PDF** 走 WebView 打印
- **主题**：亮 / 暗切换 + 字号调节 + 预览主题；全应用统一深色 tooltip 气泡（JS 浮动定位，不受容器裁剪）
- **设置面板**：标题栏可拖动；分「外观 / 编辑器 / 快捷键 / 关于」四组，版本号随构建自动同步（F1 呼出）
- 设置持久化 `%APPDATA%\com.feizong.mkdown\settings.json`；启动自动恢复上次工作区
- 快捷键：Ctrl+N/O/S/F/P、Alt+E/W/R 三视图、F11 编辑器全屏、F1 设置面板；
  格式类 Ctrl+B/I/K、Ctrl+1~6 标题、Ctrl+Shift+C 代码块 / I 图片 / F 美化（编辑/分栏态生效，阅读态有提示）；
  功能栏按钮 hover 提示同步标注对应快捷键

## 开发与构建

```bash
# 开发（Tauri 窗口 + Vite 热更新；若 vite 起不来先删 node_modules/.vite）
npm run tauri dev

# 前端类型检查 + 打包
npm run build

# Rust 单测
cd src-tauri && cargo test

# 打 Windows 安装包（NSIS，currentUser 免管理员）
# 若报 safe-delete 批量删除确认，先手动清空 dist/ 再跑
npm run tauri build
```

> **注意**：仓库内 `vendor/schemars` 是依赖补丁（修 tauri 链上 schemars 0.8.22 × indexmap 1.9.3 的 E0107），由 `src-tauri/Cargo.toml` 的 `[patch.crates-io]` 引用——**删除会导致编译失败**。

### macOS 构建

由 tag `v*` 触发 GitHub Actions（build-mac）云端构建，产出 Apple 芯片（`aarch64-apple-darwin`）与 Intel（`x86_64-apple-darwin`）双架构 dmg 并自动上传 Release。应用内「检查更新」在 macOS 上按当前架构选包：下载 dmg → `hdiutil` 挂载替换 → `xattr -cr` 清除隔离属性 → 自动重启。

## 目录结构（关键）

```
src-tauri/src/
  commands/        # 命令层（薄）：file/workspace/search/image/export/settings/session
  services/        # 业务层（可单测）：fs原子写/编码/preview_kind、目录树、搜索、图片落盘、设置、会话快照
  error.rs         # AppError：稳定错误码 {code, message} IPC 契约
  models.rs        # serde 结构体（camelCase 输出，与 src/api/types.ts 手工同步）
src/
  adapters/        # ★ IMarkdownEngine 契约 + MdEditorV3Engine（Markdown）+ CodeEditorEngine（非 Markdown 代码引擎）；业务层唯一 import 入口
  api/             # invoke 封装 + 类型化命令 API
  stores/          # Pinia：workspace / tabs / editor / settings / search
  components/      # Toolbar / FileTree / TabBar / FloatTip / preview(Docx/Sheet/Image/Html) / ...
  views/           # Workbench（主工作台）
site/              # 官网静态页（下载页，图片经 jsDelivr 引用 site/images/）
vendor/            # schemars 依赖补丁（勿删）
```

## 架构约束（重要）

1. **双编辑内核、经适配层隔离**：Markdown 走 `src/adapters/MdEditorV3Engine.vue`（md-editor-v3 v7），非 Markdown 文本走 `src/adapters/CodeEditorEngine.vue`（自建 CodeMirror 6）；业务层一律经 `src/adapters/` 入口，禁止直接 import 任一方（换 / 加内核成本≈改一个文件）。
2. **前端不直接碰文件系统**——所有 IO 走 Rust command；前端只透传路径字符串。
3. **文件打开分流判定在 Rust 侧**（`probe_text_file` + `probe_preview_kind`），前端不做扩展名猜测。
4. **预览本地资源必须走 `convertFileSrc`（asset://）**，打开工作区时由 `allow_asset_dir` 运行时动态授权。
5. 错误处理按稳定错误码分支（`IpcError.code`），禁止匹配 message 文本。

## 已知边界

- 所见即所得模式、文档元数据（标签 / 收藏）、Word 导出、全文替换、版本历史未实现（见 `docs/PRD.md` P2）。
- 预览标签内 Ctrl+F 查找高亮不可用（无编辑器实例）；docx 内嵌 wmf/emf 图片渲染占位。
- 单实例、文件监视（notify）为架构预留，未启用。
- md-editor chunk 约 980KB（gzip 344KB）。

## 文档

- [PRD](docs/PRD.md) · [架构说明](docs/ARCHITECTURE.md) · 类图 / 时序图（`docs/*.mermaid`）
