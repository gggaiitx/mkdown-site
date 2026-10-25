# 代码审查：可优化点与功能缺口（2026-10-24）

审查基线：`main` 工作区当前代码（v0.7.3），前端 36.6k 行 + Rust 服务层。
方法：静态阅读 + 针对性 grep 取证（每条结论都标了文件:行号），未做真机性能实测。

---

## 一、结论先行

代码底子比预期干净：全仓 **0 个 TODO/FIXME**、只有 1 处 `console.*`；
编码检测（BOM/UTF-16/chardetng）、会话热恢复（脏标签连正文一起存）、单实例转发、
外部修改检测、索引排除 `node_modules`/`.git` 这些容易漏的地方都已经做了。

缺口集中在两条主线：**文件保真度**（能打开但写不回去）与**资源管理**（索引无开关、无错误兜底）。
下面三项建议现在做，成本都在半天以内。

---

## 二、建议优先补的三项

### 1. 非 UTF-8 文档就地保存被硬拦（GBK/UTF-16 只能另存为）

**证据**

| 位置 | 内容 |
|---|---|
| `src/views/Workbench.vue:937-940` | `if (!tab.isUtf8) { toast(encodingWarning); return; }` —— 直接 return，不写盘 |
| `src/api/types.ts:15-18` | `/** 非 UTF-8 文档（如 GBK）禁止就地写，提示另存为 UTF-8 */` —— 这是刻意的保守决策 |
| `src-tauri/src/commands/file_cmd.rs:68-92` | `write_file_atomic(path, content, keep_bom)`：**只用 `keep_bom` 补 UTF-8 BOM，正文恒 `content.as_bytes()`**，没有按原编码回写的通路 |
| `src/i18n/packs/workbench.ts:150` | 提示文案："请使用「另存为」保存为 UTF-8" |

**影响**：GBK 的 `.txt/.csv/.md`（中文 Windows 老文档的常态）能打开、能编辑，按 Ctrl+S 只弹错误，
内容原地改不动。走"另存为"会改编码，反过来破坏与既有工具链（Excel/老系统）的兼容。

**补法**（低风险）
1. Rust：`write_file_atomic` 增 `encoding: Option<String>` 参数，用已在依赖里的 `encoding_rs`
   按名取编码器回写；`utf-16le/be` 补对应 BOM，`utf-8-bom` 沿用 `keep_bom`。
2. 前端：`saveActive()` 去掉 `isUtf8` 早退，改传 `tab.encoding`；`hadBom` 语义不变。
3. 必须加一条**可表示性校验**：目标编码无法表示的字符（GBK 里写 emoji）不能静默变 `?`，
   要明确报错并提示另存为 UTF-8。这一条不写，功能等于埋雷。

### 2. 文件树没有拖拽移动（整理文档库的最后一环缺失）

**证据**
- `src/components/FileTreeNode.vue` / `FileTree.vue` 全文无 `draggable` / `dragstart` / `dragover`。
- 对照：标签栏**已实现**拖拽排序（`TabBar.vue:236-271`，含 before/after 落点提示），技术路径已验证可行。
- 后端只有改名没有移动：`src-tauri/src/services/workspace_service.rs:162,177` `rename_entry(path, new_name)` → `fs::rename` 到同目录新名。

**影响**：应用能新建、重命名、删除，唯独不能"把文件挪进另一个目录"——整理 400+ 篇文档必须
切到资源管理器。这是文件管理器类界面的基本操作，不是锦上添花。

**补法**（中低风险）
1. Rust 新增 `move_entry(path, target_dir)`：同卷 `fs::rename`；跨卷回退 copy + remove（先判 `std::fs::rename` 的 `EXDEV`）。
2. 前端：节点 `draggable`，`dragover` 命中目录高亮 + 拖到文件上取父目录，`drop` 调新命令后刷新该子树。
3. 防误操作：禁止拖到自身子目录（`isPathInside` 已有现成函数，`utils/pathJoin.ts`）；跨工作区根目录外一律拒绝。

### 3. 渲染层没有全局错误兜底（白板时无提示、无日志、无重载入口）

**证据**
- `src/main.ts` 全文不到 20 行，只做 4 件事（DPR、右键守卫、pinia、挂载），**没有**
  `app.config.errorHandler`、`window.onerror`、`unhandledrejection`。
- 全仓唯一与 `error` 相关的监听是 `MdEditorV3Engine.vue:1653` 的图片加载失败兜底。

**影响**：渲染层任何未捕获异常（第三方库内部、模板求值、异步链）都会让界面停在半白状态，
用户只能关掉重开，且没有任何可回收的现场（这个项目已经因为白板吃过一次亏）。

**补法**（小）
1. 挂 `app.config.errorHandler` + `window.addEventListener('error' | 'unhandledrejection')`，
   统一走 toast 提示"界面出错，可重载"。
2. 落盘：经 Rust 写 `%APPDATA%\com.feizong.mkdown\logs\renderer.log`（带时间戳、栈、当前标签路径）。
3. 给一个 `Ctrl+Shift+R` 重载入口（现在 `Ctrl+R` 已被文件树刷新占用，不能复用）。

---

## 三、需要权衡的三项

| 项 | 证据 | 判断 |
|---|---|---|
| **全文索引预热无开关**：打开任何工作区都 `requestIdleCallback` 全库并行解压（注释实测冷缓存 62s） | `src/stores/workspaceStore.ts:36-42` | 对"只编辑少量文件"的用户是纯开销（CPU/磁盘/发热），且日志每次刷跳过告警。加一个设置项即可；但若目标用户都是"整库检索"场景，加了反而多一个要解释的开关 → 先看真实使用比例 |
| **搜索不覆盖无扩展名文本**：`classify()` 只认扩展名，`is_text_file` 的内容嗅探没进搜索路径 | `src-tauri/src/services/search_service.rs:44-46`（注释已说明成本原因） | 与"编辑器能打开无扩展名文本"不一致（Makefile、LICENSE 搜不到）。折中方案：只对无扩展名且 <64KB 的文件做嗅探，成本可控 |
| **孤儿图片无清理**：粘贴图落 `./assets/`，删除引用后文件留在盘上 | `src-tauri` 侧 assets 落盘 + 前端粘贴链路 | 长期文档库会积累垃圾。可做"清理未引用资源"工具（先出清单再删），但误删风险需要预览确认 + 回收站 |

---

## 四、不建议现在动的两项

| 项 | 理由 |
|---|---|
| **首屏三引擎静态引入**（`Workbench.vue:35`；dist：main 686kB / mdRendererConfig 1238kB / WangEditor 817kB） | 本地协议加载，gzip 后约 570KB，解析成本约 100–200ms。改成异步组件要动"三引擎常驻 DOM + 打印宿主"的架构（`v-show` 而非 `v-if`），牵一发动全身，实测收益不足 |
| **拆分 Workbench.vue（2916 行）** | 它是 god component（script 1511 / style 1007 / template 397），但拆分需要跨 store 重排调度，回归面极大。渐进做法：只抽 `useCtxActions`（右键动作分发）与 `useExport`（导出链路）两个 composable，其余不动 |

---

## 五、本次未覆盖

- 真机交互手感（三引擎切换、分栏拖拽、长文档滚动）——需要人工实测。
- 大文件（接近 8MB 文本上限）打开耗时、三引擎常驻内存占用——未做基准。
- Word 三管线（`word-to-markdown-js` / `@mohtasham/md-to-docx` / `docxPreviewToMh`）保真度——需用真实文档回归。
