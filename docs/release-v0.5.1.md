# v0.5.1 发布说明

## 新特性

- **代码编辑器语法高亮大幅扩容（30+ → 250+ 扩展名）**：新增 SQL 方言（`mysql` `pgsql` `sqlite` `mssql` `mariadb` `oracle` `hive` `spark`）、C#/Scala/Kotlin/Dart（`clike` 模块）、OCaml/F#/SML（`mllike` 模块）、配置类（`config` `cnf` `inf` `diff` `dockerfile` `cmake`）及 legacy-modes 大量语言（`clojure` `haskell` `erlang` `lua` `perl` `fortran` `verilog` `vhdl` `pascal` `rust` `coffee` `tex` `tcl` `proto` `sparql` `xquery` 等）。完整清单见 README「代码编辑引擎」小节。
- **新语言包按需懒加载、首屏零增长**：高亮映射经 Vite 自动按语言分包，无映射或加载失败的扩展名优雅降级为纯文本编辑，绝不崩溃。

## 问题修复

- 修复前端文件类型表漏登记 `mysql` / `pgsql` 导致这两类文件无法拖拽打开、默认不进编辑态的问题。代码编辑器扩展名现已在三处注册表——前端高亮映射、前端文件类型表、Rust 文本打开白名单——完全对齐（差集为空，`svg` 走内置三模式，预期内）。
- Rust 文本打开白名单由定长数组 `[&str; 46]` 改为切片 `&[&str]`（与 `BINARY_EXTS` 一致），规避新增扩展名漏改长度导致的编译错误；`svg` 纳入白名单实现零 IO 确定性打开。

## 其他

- Rust 全文检索白名单同步扩充，新代码文件纳入检索。
- README 与官网同步 250+ 扩展名口径。
