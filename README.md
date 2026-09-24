# MkDown

> 本地 Markdown 编辑与阅读器 · Rust + Tauri 2.x 外壳 · Vue 3 + Vite + TypeScript + Pinia 前端 · md-editor-v3 编辑内核
>
> 纯本地、离线优先、中文原生。文档、图片、配置全部落在本机磁盘，不上云、不登录、不联网。

## 技术栈（已冻结）

| 层     | 选型                                             |
| ----- | ---------------------------------------------- |
| 外壳    | Rust + Tauri 2.x（Windows 优先，WebView2）          |
| 编辑内核  | md-editor-v3 v7（MIT，经 `IMarkdownEngine` 适配层隔离） |
| 前端    | Vue 3 + Vite 7 + TypeScript 5 + Pinia 3        |
| 文件 IO | 自写 `#[tauri::command]`（原子写 / 编码探测 / 回收站删除）     |
| 搜索    | `ignore` + `grep-searcher` 实时遍历，Channel 流式推送   |

## 已实现功能（对应 PRD P0/P1）

- **编辑/预览/阅读** 三态切换（分栏实时预览、滚动同步、纯阅读态）
- **多标签页**，脏标记 ●，切换/关闭/退出均有未保存确认
- **工作区文件树**：新建 / 重命名 / 删除（进回收站）/ 刷新 / 右键菜单
- **打开 / 保存 / 另存为**（Ctrl+S），**原子写**（临时文件+rename，写一半崩溃不毁原文件）
- **编码**：UTF-8 / BOM / UTF-16 / GBK 自动探测；GBK 等非 UTF-8 禁止就地写，提示另存为 UTF-8
- **图片粘贴落盘**：截图粘贴自动存文档同级 `assets/`，文档内保留**相对路径**（可整体搬迁），预览经 `asset://` 加载
- **大纲面板**：随内容实时更新，点击跳转（编辑态 CodeMirror 定位 / 阅读态锚点滚动）
- **全局搜索**：工作区内文件名+正文，正则/大小写/仅 .md 可选，结果高亮可点击直达
- **导出 HTML**（asset:// 自动还原为相对路径）；**导出 PDF** 走 WebView 打印（中文排版与预览一致）
- **主题**：亮/暗切换 + 字号调节 + 预览主题，全部持久化到 `%APPDATA%\com.feizong.mkdown\settings.json`
- **最近打开** + 启动自动恢复上次工作区
- **模板库**：新建文档可套用「笔记 / 方案骨架」
- **自动保存**（可开关，停顿后原子落盘）
- 快捷键：Ctrl+N/O/S/F/P、F1（设置与快捷键面板）、Ctrl+B/I/K、Ctrl+1~6 等（内核内置）

## 开发与构建

```bash
# 开发（起 Tauri 窗口 + Vite 热更新）
npm run tauri dev

# 前端类型检查 + 打包
npm run build

# Rust 单测（19 个：原子写/编码/搜索/工作区/图片/错误码）
cd src-tauri && cargo test

# 打 Windows 安装包（NSIS，currentUser 免管理员）
npm run tauri build
```

## 目录结构（关键）

```
src-tauri/src/
  commands/        # 命令层（薄）：file/workspace/search/image/export/settings
  services/        # 业务层（可单测）：fs原子写/编码、目录树、搜索、图片落盘、设置
  error.rs         # AppError：稳定错误码 {code, message} IPC 契约
  models.rs        # serde 结构体（camelCase 输出，与 src/api/types.ts 手工同步）
src/
  adapters/        # ★ IMarkdownEngine 契约 + MdEditorV3Engine（唯一可 import md-editor-v3 处）
  api/             # invoke 封装 + 类型化命令 API
  stores/          # Pinia：workspace / tabs / editor / settings / search
  components/      # Toolbar / FileTree / TabBar / OutlinePanel / SearchPanel / SettingsDialog ...
  views/           # Workbench（主工作台）
```

## 架构约束（重要）

1. **业务代码禁止 import md-editor-v3**——只允许出现在 `src/adapters/MdEditorV3Engine.vue`（换内核成本≈改一个文件）。
2. **前端不直接碰文件系统**——所有 IO 走 Rust command；前端只透传路径字符串。
3. **预览本地图片必须走 `convertFileSrc`（asset://）**，打开工作区时由 `allow_asset_dir` 运行时动态授权。
4. 错误处理按稳定错误码分支（`IpcError.code`），禁止匹配 message 文本。

## 已知边界（P2 / 待定项）

- 所见即所得模式、文档元数据（标签/收藏）、Word 导出、多工作区、全文替换、版本历史未实现（见 PRD P2）。
- 设置持久化由 `settings_service` 直接读写（行为等价 tauri-plugin-store，未引入该插件）。
- 单实例、文件监视（notify）为架构预留，未启用。
- mdeditor chunk 约 980KB（gzip 344KB），Mermaid/KaTeX 由内核按需懒加载。
