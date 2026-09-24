# 码克 - Markdown 桌面编辑与阅读器 

> 本地优先的 Markdown 编辑与阅读器 · Rust + Tauri 2.x 外壳 · Vue 3 + Vite + TypeScript + Pinia 前端 · md-editor-v3 v7 编辑内核
>
> 纯本地、离线优先、中文原生。文档、图片、配置全部落在本机磁盘，不上云、不登录、不联网。

**下载安装**（Windows）：前往 [Releases](https://github.com/gggaiitx/mkdown-site/releases) 或[官网下载页](https://mkdown.opensites.net)获取 NSIS 安装包；安装器自带卸载程序（注册到系统「应用与功能」，卸载保留用户数据）。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 外壳 | Rust + Tauri 2.x（Windows 优先，WebView2；macOS 走 CI 云端构建） |
| 编辑内核 | md-editor-v3 v7（CodeMirror 6 内核，经 `IMarkdownEngine` 适配层隔离） |
| 前端 | Vue 3 + Vite 7 + TypeScript 5 + Pinia 3 |
| 富媒体预览 | docx-preview（Word）+ SheetJS `sheet_to_html`（Excel）+ 原生 `<img>` / `iframe` |
| 文件 IO | 自写 `#[tauri::command]`（原子写 / 编码探测 / 回收站删除） |
| 搜索 | `ignore` + `grep-searcher` 实时遍历，Channel 流式推送 |

## 功能总览

### 编辑与阅读
- **编辑 / 分屏 / 阅读** 三模式切换（分栏实时预览、滚动同步、沉浸阅读态）
- **多标签页**，脏标记 ●，切换 / 关闭 / 退出均有未保存确认
- **大纲面板**：随内容实时更新，点击跳转（编辑态 CodeMirror 定位 / 阅读态锚点滚动）
- **模板库**：新建文档可套用「笔记 / 方案骨架」；**自动保存**（可开关，停顿后原子落盘）
- **图表与公式**：Mermaid 流程图 + KaTeX 公式（内核按需懒加载）

### 文件与工作区
- **多工作区**：左上角根目录名一键切换，最近列表（上限 10）自动去重，支持单项移除 / 全部移除（仅清列表不删文件）；切换前未保存文档确认
- **工作区文件树**：新建 / 重命名 / 删除（进回收站）/ 刷新 / 右键菜单 / 名称过滤 / 折叠全部
- **打开分流三分支**：文本类进编辑器 → docx / xlsx / 图片进应用内预览标签 → 其余（pdf / ppt / 音视频 / drawio…）交系统默认程序（判定唯一真相源在 Rust 侧）
- **原子写**：临时文件 + rename，写一半崩溃不毁原文件；UTF-8 / BOM / UTF-16 / GBK 自动探测，非 UTF-8 禁止就地写（防乱码毁文件）
- **图片粘贴落盘**：截图粘贴自动存文档同级 `assets/`，文档内保留相对路径（可整体搬迁），预览经 `asset://` 加载

### 应用内预览（只读）
- **Word（.docx）**：docx-preview 渲染，保留 Word 纸张视觉 / 页眉页脚 / 图片
- **Excel（.xlsx）**：SheetJS 转 HTML 表格，多工作表页签切换
- **图片**：png / jpg / gif / bmp / webp / svg / ico，带缩放工具条
- **HTML**：编辑 / 分屏 / 阅读三模式；相对路径资源经 `<base href=asset://>` 正常加载；脚本不执行（安全设计）
- 预览区均带「用系统默认程序打开」按钮；.doc / .ppt 等遗留 OLE 格式仍交系统程序

### 其他
- **全局搜索**：工作区文件名 + 正文，正则 / 大小写 / 仅 .md 可选，结果高亮直达
- **导出 HTML**（asset:// 自动还原相对路径）；**导出 PDF** 走 WebView 打印
- **主题**：亮 / 暗切换 + 字号调节 + 预览主题；全应用统一深色 tooltip 气泡（JS 浮动定位，不受容器裁剪）
- 设置持久化 `%APPDATA%\com.feizong.mkdown\settings.json`；启动自动恢复上次工作区
- 快捷键：Ctrl+N/O/S/F/P、F1（设置与快捷键面板）、Ctrl+B/I/K、Ctrl+1~6 等

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



## 目录结构（关键）

```
src-tauri/src/
  commands/        # 命令层（薄）：file/workspace/search/image/export/settings
  services/        # 业务层（可单测）：fs原子写/编码/preview_kind、目录树、搜索、图片落盘、设置
  error.rs         # AppError：稳定错误码 {code, message} IPC 契约
  models.rs        # serde 结构体（camelCase 输出，与 src/api/types.ts 手工同步）
src/
  adapters/        # ★ IMarkdownEngine 契约 + MdEditorV3Engine（唯一可 import md-editor-v3 处）
  api/             # invoke 封装 + 类型化命令 API
  stores/          # Pinia：workspace / tabs / editor / settings / search
  components/      # Toolbar / FileTree / TabBar / FloatTip / preview(Docx/Sheet/Image/Html) / ...
  views/           # Workbench（主工作台）
site/              # 官网静态页（下载页，图片经 jsDelivr 引用 site/images/）
vendor/            # schemars 依赖补丁（勿删）
```

## 架构约束（重要）

1. **业务代码禁止 import md-editor-v3**——只允许出现在 `src/adapters/MdEditorV3Engine.vue`（换内核成本≈改一个文件）。
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
