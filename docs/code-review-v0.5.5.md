# 码克 MkDown v0.5.5 代码 Review 报告

- 审查日期：2026-10-12
- 审查方式：全量人工通读（Rust 24 个 .rs 文件 3711 行 + 前端 src/ 全部 50 ts/25 vue 约 12000 行）+ 客观门禁（vue-tsc / cargo check）+ 两轮交叉审查（主代理通读 + 前端专项子代理）；子代理报告的全部发现均由主代理逐条独立复核（含行号证据）后采信
- 工作区状态：3 个未提交改动（docs/PRD.mh、site/index.html、src/api/types.ts 均仅文案级），不影响审查结论
- **修订记录（v1.1，2026-10-12 晚）**：复核前端第二路线审查子代理报告后增补 P0-2、P1-9~P1-13、P2-27~P2-34（均经独立取证确认）；原 P2-6 升级为 P1-13（复核发现写盘失败后 markSaved 仍无条件执行，数据丢失双重通道）

## 一、总体结论

**工程质量判定：优秀（A-）。** 架构分层清晰（adapters 契约隔离三引擎、ADR-01 路径白名单、状态/命令/服务三层），注释文化极强（关键设计决策均有"为什么"而非"是什么"），测试覆盖核心链路（Rust 40+ 单测覆盖编码探测/白名单/原子写/检索/缓存失效）。客观门禁全绿：`vue-tsc --noEmit` 零错误，`cargo check` 项目 crate 零告警。

风险画像：**P0×2（1 项安全原语 + 1 项功能性缺陷）、P1×13（含 4 处数据丢失风险路径）、P2×33**。P0/P1 全部有明确修复路径，无架构级返工。建议按第六节路线分三批处理：第一批 10 项（数据丢失/功能性缺陷/panic/静默失败）v0.5.6 立即修，第二批安全加固，第三批体积/依赖/工程按排期。

## 二、P0（2 项）

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P0-1 | src-tauri/src/commands/update_cmd.rs:156,107 | `apply_update(installer_path)` 仅校验 `exists()` 即执行，参数完全来自前端；与 `download_update(download_url)` 不校验 URL 协议叠加，构成"前端可控 → 执行任意本地 exe / 明文 http 下载并运行"的原语，违背工程自设 ADR-01（前端不可借 IPC 触达任意路径）的威胁模型 | `download_url` 限定 https 且 host 以 `objects.githubusercontent.com`/`github.com` 结尾；`installer_path` 限定必须等于本次 `download_update` 返回的 `%TEMP%\mkdown-update-setup.exe`（或该前缀路径） |
| P0-2 | src/adapters/WangEditorEngine.vue:211-219（对照 82-102、200-209、538） | **功能性缺陷（含本地图片的 .mh 文档编辑态被逐键重置）**：`onChange` 中 `lastEmitted = html`（显示态 HTML，图片为 asset:// 形态）却 `emit('update:modelValue', htmlToDisk(html))`（磁盘态相对路径）——文档含本地图片时二者必然不等，父级回写 modelValue 后 watch（:204）误判为"外部变更"，**每次按键都执行 `setHtml` 全量重置编辑器**：光标跳回文档头、撤销历史丢失；且回写分支 `valueHtml.value = disk`（:205）把磁盘态赋给编辑器 v-model（:538，显示态口径）亦属口径错位，打印导出（onExportCreated 取 valueHtml）随之丢图片。无图片文档两态相等故不触发，这也是此前未被发现的原因 | `lastEmitted` 存实际 emit 的值（`lastEmitted = htmlToDisk(html)`）；watch 回写分支改 `valueHtml.value = htmlToDisplay(disk)`，与 :207 的 setHtml 口径对齐 |

## 三、P1（13 项）

| # | 位置 | 问题 | 建议 |
|-------|------|------|------|
| P1-1 | src/views/Workbench.vue:644-645, 1001-1010 | **数据丢失**：关窗口确认对话框承诺"保存全部并退出"（workbench.ts:56/123 双语文案），但 `onCloseConfirm` 对关窗口场景走 `confirmCloseWindow('discard')`——纯丢弃路径，**未执行任何保存**，且 `flushSessionSnapshot({dropDirty:true})` 后草稿连恢复都没了 | `confirmCloseWindow('discard')` 前复用 `confirmCloseBatch` 的保存循环遍历保存全部可保存脏标签，保存失败提示后中止关闭 |
| P1-2 | src-tauri/src/services/search_service.rs:384-385 | **panic**：慢路径（GBK 等非 UTF-8 文件）`text[line_start..m.start()].chars().count() - lead`，当正则匹配落在行前导空白内部（`\s+`、`.*` 等常见正则）时 usize 下溢，debug panic / release 列号回绕成巨值；且快路径列号含前导空白、慢路径扣减，两编码口径不一致 | 改为 `saturating_sub`，并将行匹配统一为 `raw.trim()` 后的口径（`let line = raw.trim(); let off = lead; cs = count(text[line_start..m.start()]) - off`，即全用慢路径口径） |
| P1-3 | src/adapters/CodeEditorEngine.vue:52-55,88-93 | `loadLanguage` 异步无请求序号：连续快速切换文件（a.ts→b.py→c.go）时旧请求可能后返回 reconfigure，语言包与文档错配 | 闭包捕获递增 seq，reconfigure 前比对 `seq === mySeq`，过期直接丢弃 |
| P1-4 | src-tauri/src/commands/update_cmd.rs:107-127 | `download_update` 的 `Vec::with_capacity(total as usize)` 信任 Content-Length：异常/恶意响应头可致分配失败直接 abort（release 下 capacity overflow）；URL 无协议与 host 校验 | 去掉 with_capacity 预分配（改渐进 extend）；URL 校验同 P0-1 |
| P1-5 | src-tauri/src/commands/{settings,session,update}_cmd.rs | 4 个 async 命令在 async fn 内直接同步 IO（`settings_service::load/save`、`session_service::load/save`），与 file_cmd 全线 `spawn_io` 的模式不一致；session.json 含大量脏草稿时 read_to_string+write_atomic 阻塞 async runtime | 包一层 `spawn_blocking`（file_cmd.rs:13 的 spawn_io 可直接复用） |
| P1-6 | src-tauri/src/commands/file_cmd.rs:46-55 | 8MB 闸门是 check-then-read 竞态：`metadata` 检查后 `read_text` 内部 `fs::read` 全量读，活跃追加的日志文件在两步之间增长即可超读进内存，"硬闸门"名不副实 | `read_text` 改为 `File::open` + `take(MAX_TEXT_BYTES+1)` 限量读，超限返回 `Unsupported` |
| P1-7 | src/components/preview/{SheetPreview,DocxPreview}.vue + dist 实测 | 首屏体积 2.72MB（未压缩）：docx-preview（1.26MB）与 xlsx（403KB）经静态 import 打进 index 入口 chunk（实测 index-CRvYiIbt.js 1.69MB + mdeditor 1.03MB），预览组件却只在用户点开对应文件时才用；xlsx 0.18.5 另有两个公开 CVE（原型污染 CVE-2023-30533、ReDoS CVE-2024-22363，以 npm audit 复核为准），触发路径实锤在 SheetPreview.vue:39 `XLSX.read(buf)` | 预览组件改 `defineAsyncComponent` 懒加载（Workbench 已按 kind v-if，改 import 即可）；xlsx 升级官方社区维护分支（@stackline/xlsx）或 keep-lts，并对预览文件加大小上限 |
| P1-8 | src/utils/sessionSnapshot.ts:187-195 | 未命名 `.mh` 脏文档（path=null, kind='mh'）恢复时落入 else 分支被丢弃——崩溃/更新重启后该草稿丢失（md 未命名草稿有专门分支，mh 漏了） | `else if (kind === 'md' \|\| kind === 'mh')` 并补 mh 标题/骨架处理 |
| P1-9 | src/stores/searchStore.ts:28-63 | `run()` 无请求序号/取消令牌（Tauri Channel 不支持中止）：连发两次搜索时旧搜索的流式回调继续往新 `hits` 数组 push，两批结果交错污染；且 :53-56 达到 500 条后仅置 `searching=false`，回调仍继续 push，hits 实际可涨到 maxResults 2000，与"前端最多展示 500 条"注释不符 | 加自增 seq token，过期回调直接丢弃；达到 500 后回调内 `return` 不再 push |
| P1-10 | src/adapters/codeLanguage.ts:402,418,422 | `loaders` 表引用 `legacy('jinja2'/'z80'/'asn1')`，但 `legacyLoaders` 未注册这三个模块，`legacy()`（:35）回落 `async () => []`——`.jinja/.j2/.jinja2/.z80/.asn/.asn1` 文件静默无语法高亮（fileKind 已归 code 类会进代码编辑器），属"配了映射但静默失效" | 在 legacyLoaders 补三个字面量 loader（`@codemirror/legacy-modes/mode/{jinja2,z80,asn1}`），或从 loaders 表移除这些扩展名 |
| P1-11 | src/adapters/MdEditorV3Engine.vue:180-191,459-468,905-933 | `outlineTimer`/`exportSyncTimer` 未在 onBeforeUnmount 清理（该函数清了另外 5 个 timer + rAF，独漏这两个）：快速切标签时旧引擎卸载后 150ms 定时器仍触发 `emit('outline')`，旧文档大纲覆盖新文档大纲（与 Workbench syncOutline 120ms 防抖竞速，旧大纲后写赢） | onBeforeUnmount 补 `clearTimeout(outlineTimer)` / `clearTimeout(exportSyncTimer)` |
| P1-12 | src/views/Workbench.vue:570-572 | 自动保存写盘失败被 `catch { /* 静默失败，下次停顿重试 */ }` 吞掉：文件被锁/只读/被删时自动保存永远失败，用户零感知（代码注释自标"P1-9"，说明作者已知晓但未处理提示） | 失败时 toast（本次编辑周期内只提示一次防刷屏）或状态栏常驻警示 |
| P1-13 | src/views/Workbench.vue:621,633-634 | **数据丢失**（原 P2-6 升级）："保存并关闭/批量保存"写盘失败被 `.catch(()=>undefined)` 静吞后照常关标签；更严重的是 :634 `tabs.markSaved(id, tab.content)` 在 catch 之外**无条件执行**——写盘失败也标记为已保存，防抖快照随之丢弃该 tab 内容，未保存内容经"关标签 + 标记干净 + 快照剔除"三通道丢失且无任何提示 | 写盘失败时 toast 并中止关闭（保留标签）；`markSaved` 仅在 await 成功后调用 |

## 四、P2（33 项，按主题分组；P2-27 起为 v1.1 增补项）

**安全加固**

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P2-1 | src-tauri/src/services/search_service.rs:192 | 搜索遍历 `path.is_file()` 跟随符号链接：授权目录内预置指向白名单外的 symlink/junction，其内容可经搜索通道回传（read_file 因 canonicalize_loose 不受影响，仅搜索遍历是缺口） | 遍历用 `entry.file_type()`（不跟随）判定，或 fs::read 前对 canonicalize 结果再过一次 is_allowed |
| P2-2 | src-tauri/tauri.conf.json:28 | CSP 缺 `object-src 'none'`/`base-uri 'self'`/`form-action 'none'` 默认拒绝项；`img-src` 含 `http:` 明文（外部图片需要 https: 即可，勿整体收窄 https:） | 补三项默认拒绝；评估 img-src 去 http: |
| P2-3 | src-tauri/src/commands/update_cmd.rs | 安装包无签名/完整性校验，仅 HTTPS 传输保护 | 采用 minisign 签名校验或文档明示风险 |
| P2-4 | .github/workflows/sync-to-gitee.yml | ad-m/github-repo-action-sync@v2.2.1 未 pin 到 commit SHA，tag 可被改指向 → 供应链风险 | pin SHA |
| P2-5 | .github/workflows/*.yml | CI 无 `npm audit` / `cargo audit` 门禁 | 加 audit 步骤（至少 warn 级） |

**数据与一致性**

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P2-7 | src-tauri/src/services/workspace_service.rs:27-35 | `validate_name` 未拒 Windows 保留设备名（CON/PRN/AUX/COM1-9/LPT1-9，任意扩展名）与尾点/尾空格 | 补黑名单 + trim 后比较 |
| P2-8 | src-tauri/src/services/search_cache.rs:69-78 | 缓存指纹 = mtime(ms)+size，同毫秒同大小的内容变更会误命中旧缓存 | 指纹加内容哈希（或首 4KB 哈希） |
| P2-9 | src-tauri/src/commands/export_cmd.rs | `export_html` 保存后未 `grant_picked`（save_as 有），导出到新目录后该目录内文件操作会被白名单拒 | 保存后补 grant_picked |
| P2-10 | src/api/ipc.ts:44-55 + 各组件 | ERROR_TEXT 错误码文案表定义了但全代码零消费，toast 直接显示 Rust 英文原文（"io error: ..."），error.rs 自称的稳定错误码契约空转 | 统一在 ipc.ts call() 出口或 toast 封装处按 code 映射 i18n 文案 |
| P2-11 | src-tauri/src/commands/update_cmd.rs:47-52 | HTTP 非 2xx 映射为 `INVALID_ARG`（4xx 才是，5xx 应为 Io） | 按状态码分类 |
| P2-12 | src/stores/settingsStore.ts:6-10 | 设置持久化失败静默（"下次变更重试"），无后续变更则设置丢失 | 失败 toast 提示 |
| P2-27 | src/views/Workbench.vue:318-329 | 切标签恢复视图模式的条件 `m !== 'split'` 漏掉 split：从代码标签（强制 edit）切回存储模式为 split 的 md 标签时模式不恢复，停留 edit（若为有意为之需注释说明） | 条件改仅 `editor.mode !== m` |
| P2-28 | src/components/FileTree.vue:306-328 + workspaceStore.ts:48-51 | 刷新失败无任何用户提示（注释称"错误提示走 store toast"但 ws.refresh 不 toast），图标停转即无下文 | refresh catch 后 showToast |
| P2-29 | src/components/SearchHub.vue:52-76 + utils/htmlText.ts:8-16 | mh 标签 `htmlPlainText` 用 textContent 拼接无换行，所有命中行号恒为 L1，面板行号与 cursorLine 回写无意义（定位仅靠 matchIndex 兜底） | mh 模式按块级元素补行号或隐藏行号列 |

**跨平台**

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P2-13 | src/adapters/WangEditorEngine.vue:91 / Workbench.vue:795 | `htmlToDisk`/`deAssetify` 只还原 `http(s)://asset.localhost/` 前缀；Tauri 2 在 macOS 的 convertFileSrc 形态若非该前缀（待实测确认），macOS 下 .mh/导出 HTML 会残留 asset:// 绝对路径，文档失去可搬迁性 | 实测 macOS 形态后补兼容分支 |
| P2-14 | .github/workflows/build-mac.yml | macos-13 已退役应迁 macos-14；dmg 无 Apple 签名/公证（Gatekeeper 拦截，靠 xattr -cr 缓解） | 迁 runner；长期做签名公证 |
| P2-15 | vite.config.ts:18 | `target: chrome105` 锚定过低（Tauri 2 的 WebView2 evergreen 远高于此），白放弃 ES 新特性优化 | 提至 chrome120+ 并与 tauri 2 最低 WebView2 对齐 |

**性能**

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P2-16 | src-tauri/src/services/office_text.rs:135-180 | 单部件 32MB 上限但无 zip 总解压量/总行数上限，高压缩比恶意包可撑爆内存（search_service 侧有 32MB 文件级上限兜底，直接打开预览路径也走 asset:// fetch 有 CSP 约束，风险中等） | 加累计解压量与总行数双上限 |
| P2-17 | src/adapters/WangEditorEngine.vue:361-392 | `collectRanges` 每命中对 parts 做 `findIndex` 全扫，2000 命中 × N 文本节点 | 改指针/二分定位 |
| P2-18 | src/stores/searchStore.ts:51-56 | Channel 回调里逐条 `hits.push`，每次触发 Pinia 响应式更新；500 条上限内可接受但大结果时渲染抖动 | 攒批（rAF 合并）后一次性写入 |
| P2-19 | src/components/FileTreeNode.vue:94-104 + workspace_service.rs:14 | 树上限 20000 节点，"一键展开全部"后 20000 个递归组件实例同时渲染，明显卡顿 | 展开全部时对超大 N 提示或限制 |
| P2-30 | src/components/SearchHub.vue:52-76,452 | 文件内匹配对全文档 split+scan 且无防抖，超大文档每次按键全量计算；hitSegs 在模板中每行被调用 3 次 | 匹配加防抖、segments 预计算一次 |

**工程与一致性**

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P2-20 | 多处 | 重复实现：`extractOutline`（editorStore.ts:13 与 MdEditorV3Engine.vue:156 两份）、行级匹配（SearchHub.vue:52 与 FindBar.vue:28 两份） | 抽到 utils 单点 |
| P2-21 | src/components/SettingsDialog.vue:93-130、WangEditorEngine.vue:149 | 快捷键文案硬编码 'Ctrl'（Mac 应 ⌘；项目已有 modKey() 工具并在 mdRendererConfig 正确使用） | 统一走 keyHint |
| P2-22 | src/components/TabBar.vue:121-122,149-161 | hoverTimer/ovCloseTimer 未在 onBeforeUnmount 清理（220-260ms 自停，无崩溃，属坏味道） | 卸载时 clear |
| P2-23 | src/components/preview/HtmlFrame.vue:47,89-91 | build 防抖 timer 未在卸载时清理（300ms 自停） | 同上 |
| P2-24 | src/api/ipc.ts:44-55,74-75 | ERROR_TEXT 与 toIpcError 的 'UNKNOWN' 兜底在当前调用面属下被死代码（P2-10 修复时会自然用上） | 随 P2-10 处理 |
| P2-25 | src/utils/mdFormat.ts:29 | 美化规则 `#123` → `# 123`：对 Shell/CMake 注释行是语义改写（"要不要美化"应由用户确认） | 至少在大纲/注释启发式命中时跳过或提示 |
| P2-26 | vite.config.ts:20 | `sourcemap: false`，线上排障只能靠复现 | ~~产出隐藏 sourcemap 归档~~ **v1.2 修正：维持 false**——Tauri 会把 frontendDist 连 `.map` 全量嵌进二进制，v0.5.6 实测主程序 9.4→14.9MB、安装包近翻倍；源图改走 CI 归档，不随应用分发 |
| P2-31 | src/views/Workbench.vue:136-141,1322-1323 | toast 去重时 `dup.seq = seq` 改变 :key，TransitionGroup 销毁重建 DOM、重播进出场动画 | 用稳定自增 id 作 key，seq 仅用于 dismiss 查找 |
| P2-32 | FindBar.vue / SearchPanel.vue（全文）、editorStore.ts:66,94-96、Workbench.vue:684,692、WangEditorEngine.vue:475-476 | 死代码：FindBar/SearchPanel 两组件无任何引用（仅 i18n packs 注释提及）；`lastWorkMode` 只写不读、`scrollTarget` 无消费方、editorStore.scrollToLine 无调用方（滚动均直调引擎 API）；WangEditor 的 getSaveContent/getViewHtml 契约方法无调用方 | 删除死组件与对应 i18n 包/死状态，或明确启用 |
| P2-33 | src/components/SearchHub.vue:19 | 注释称"Ctrl+Alt+F 在两模式间切换"，但 Workbench.onKeydown（:969 `k === 'f' && !e.altKey`）无此绑定，文档与实现不符 | 补绑定或改注释 |
| P2-34 | src/adapters/MdEditorV3Engine.vue:471-479 | exportPdf 用固定 650ms 等待 MdPreview 渲染（renderDelay 500ms），大文档/mermaid 渲染更慢时会打印到旧内容 | 以 on-html-changed 事件或轮询 exportContent 渲染完成为准 |

## 五、做得好的方面（抽样）

- **安全模型自洽**：capabilities 最小权限（不声明 fs:allow-*）+ ADR-01 运行时白名单 + canonicalize_loose 对新文件生效 + 删除走回收站（trash crate + PowerShell 回退），全套有单测锁定（state.rs 4 个测试）。
- **桌面正确性细节**：原子写（tmp+sync+rename）、8MB 闸门、编码探测（UTF-8/16 BOM + chardetng GBK 无损判定）、explorer raw_arg 引号传递、cmd OEM 码表纯 ASCII bat、NSIS /D= 无引号——每处都有"实测踩坑"注释，可信度高。
- **三模式位置同步**：锚点/校正/用户操作守卫/五条异步链五 timer 的设计与注释是全书最复杂也最完整的部分，未见逻辑漏洞。
- **链接拦截安全**：javascript:/未知协议禁止、盘符路径特判、外链独立 WebView 窗口（天然隔离远程 origin 权限）。
- **i18n**：329 个 key 中英零缺失（实测比对），回退链完整。

## 六、修复优先级建议

第一批（数据丢失/功能性缺陷/panic/静默失败，建议 v0.5.6 立即修）：P0-2、P1-1、P1-2、P1-3、P1-8、P1-9、P1-10、P1-11、P1-12、P1-13。
第二批（安全加固，v0.5.6~v0.6.0）：P0-1、P1-4、P2-1、P2-2、P2-4、P2-5、P2-7。
第三批（体积/依赖/性能/工程）：P1-5、P1-6、P1-7、P2-3、P2-8~P2-34 按排期。

## 七、覆盖范围说明

Rust 侧 24 个 .rs 文件 100% 通读；前端经两轮覆盖——主代理核心文件 100% 通读（Workbench、MdEditorV3Engine、WangEditorEngine、CodeEditorEngine、全部 6 个 store、全部 api、sessionSnapshot、useUpdateCheck、SearchHub、TabBar、SettingsDialog、Toolbar、FileTree、FileTreeNode、AppDialog、FindBar、OutlinePanel、StatusBar、App.vue、main.ts、mdRendererConfig、findHighlight、cmHeadingLine、codeTheme、fileKind、htmlText、keyHint、mdFormat、markdownTemplate、i18n/index、preview/HtmlFrame、SvgFrame、useFrameScale、SheetPreview、DocxPreview、PreviewAssets）+ 专项子代理第二轮（adapters 10 文件、components 22 文件、stores 5 文件、composables 2 文件、utils 7 文件）；子代理报告全部发现均经主代理逐条复核行号证据后采信，P1-3（语言包竞态）与 P1-8（mh 草稿恢复）为两轮独立双通道发现、互为印证。Welcome/FloatTip/ImagePreview/OpenSystemBtn/PreviewZoomBar 为展示层小组件，抽查无重大疑点（SearchPanel 经 grep 确认无任何引用，列为死代码 P2-32）。工作区 3 个未提交改动为文案级，不影响结论。
