use std::cmp::Ordering;
use std::fs;
use std::path::Path;

use crate::error::{AppError, AppResult};
use crate::models::{NodeKind, WorkspaceNode};
use crate::services::fs_service;

/// 只忽略"构建产物/依赖/版本库内部"这类纯噪音目录。
/// 注意：**不再**按 `.` 开头判隐藏——`.workbuddy`、`.NET…`、`.vscode` 这类
/// 以点开头的真实目录必须照常显示（工作区里它们就是要编辑的对象）。
const IGNORED_DIRS: [&str; 5] = ["node_modules", "target", "dist", "__pycache__", ".git"];
/// 目录树节点上限：超过则停止继续深入（根目录挂错盘时的兜底，避免卡死 UI）
const MAX_NODES: usize = 20_000;

fn is_ignored_dir(name: &str) -> bool {
    IGNORED_DIRS.contains(&name)
}

/// 目录树展示工作区里的**全部**条目：Office/PDF/图片/点开头文件等一并列出，
/// 点击时按类型分流——文本进编辑器，其余交系统默认程序（见 `fs_service::is_text_file`）。
/// 唯一跳过的是 Office 打开时生成的 `~$xxx.docx` 锁文件（既打不开也无意义）。
fn is_skipped_file(name: &str) -> bool {
    name.starts_with("~$")
}

/// Windows 保留设备名（大小写不敏感，任意扩展名）：CON.txt 同样拒——
/// 这类名字建得出来但普通程序打不开，资源管理器也会行为错乱。
/// 覆盖经典名单 CON/PRN/AUX/NUL + COM1-9/LPT1-9（COM0/LPT0 现代 Windows 亦保留，
/// 但历史行为不一，从紧只收清单内项，避免误伤正常命名）。
const RESERVED_DEVICE_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn validate_name(name: &str) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(AppError::InvalidArg("名称不能为空".into()));
    }
    if name.chars().any(|c| "\\/:*?\"<>|".contains(c)) {
        return Err(AppError::InvalidArg(format!("名称含非法字符: {name}")));
    }
    // 尾点/尾空格：Windows 创建时会静默剥掉，造成"建了却打不开/删不掉"的幽灵条目
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(AppError::InvalidArg(format!(
            "名称不能以点或空格结尾: {name}"
        )));
    }
    // 保留设备名：取首个 '.' 前的主名，大小写不敏感精确比对（任意扩展名都拒）。
    // 不做 trim——"CON .txt" 在 Windows 并非设备名（尾剥离只作用于整段末尾），
    // 精确比对与平台语义一致，也避免误伤 "COM1 备份" 这类正常命名。
    let stem = name.split('.').next().unwrap_or("");
    if RESERVED_DEVICE_NAMES
        .iter()
        .any(|r| stem.eq_ignore_ascii_case(r))
    {
        return Err(AppError::InvalidArg(format!(
            "名称是 Windows 保留设备名，禁止使用: {name}"
        )));
    }
    Ok(())
}

/// 构建工作区目录树。目录优先、名称不区分大小写排序；只跳过构建/依赖/版本库目录。
pub fn build_tree(root: &Path, max_depth: usize) -> AppResult<WorkspaceNode> {
    if !root.is_dir() {
        return Err(AppError::NotFound(format!(
            "目录不存在: {}",
            root.display()
        )));
    }
    let mut budget = MAX_NODES;
    let mut node = build_node(root, 0, max_depth, &mut budget);
    node.name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());
    Ok(node)
}

/// `budget` 是全局剩余节点配额：所有层级共享，耗尽即停止扩展。
fn build_node(dir: &Path, depth: usize, max_depth: usize, budget: &mut usize) -> WorkspaceNode {
    let mut children: Vec<WorkspaceNode> = Vec::new();
    if depth < max_depth {
        if let Ok(rd) = fs::read_dir(dir) {
            for entry in rd.flatten() {
                if *budget == 0 {
                    break;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let p = entry.path();
                let Ok(ft) = entry.file_type() else { continue };
                if ft.is_dir() {
                    if is_ignored_dir(&name) {
                        continue;
                    }
                    *budget -= 1;
                    children.push(build_node(&p, depth + 1, max_depth, budget));
                } else {
                    if is_skipped_file(&name) {
                        continue;
                    }
                    *budget -= 1;
                    let md = entry.metadata().ok();
                    children.push(WorkspaceNode {
                        name,
                        path: p.to_string_lossy().into_owned(),
                        kind: NodeKind::File,
                        children: None,
                        size: md.as_ref().map(|m| m.len()),
                        mtime_ms: md.as_ref().map(fs_service::mtime_from_meta),
                    });
                }
            }
        }
        children.sort_by(|a, b| match (&a.kind, &b.kind) {
            (NodeKind::Dir, NodeKind::File) => Ordering::Less,
            (NodeKind::File, NodeKind::Dir) => Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
    }
    WorkspaceNode {
        name: dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: dir.to_string_lossy().into_owned(),
        kind: NodeKind::Dir,
        children: Some(children),
        size: None,
        mtime_ms: None,
    }
}

pub fn create_entry(parent: &Path, name: &str, kind: NodeKind) -> AppResult<WorkspaceNode> {
    validate_name(name)?;
    if !parent.is_dir() {
        return Err(AppError::NotFound(format!(
            "父目录不存在: {}",
            parent.display()
        )));
    }
    let target = parent.join(name);
    if target.exists() {
        return Err(AppError::Conflict(format!("已存在同名条目: {name}")));
    }
    match kind {
        NodeKind::File => fs::write(&target, b"")?,
        NodeKind::Dir => fs::create_dir(&target)?,
    }
    let md = fs::metadata(&target)?;
    Ok(WorkspaceNode {
        name: name.into(),
        path: target.to_string_lossy().into_owned(),
        kind,
        children: (kind == NodeKind::Dir).then_some(Vec::new()),
        size: (kind == NodeKind::File).then_some(0),
        mtime_ms: Some(fs_service::mtime_from_meta(&md)),
    })
}

pub fn rename_entry(path: &Path, new_name: &str) -> AppResult<WorkspaceNode> {
    validate_name(new_name)?;
    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "条目不存在: {}",
            path.display()
        )));
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidArg("没有父目录".into()))?;
    let target = parent.join(new_name);
    if target.exists() {
        return Err(AppError::Conflict(format!("已存在同名条目: {new_name}")));
    }
    fs::rename(path, &target)?;
    let md = fs::metadata(&target)?;
    let kind = if md.is_dir() {
        NodeKind::Dir
    } else {
        NodeKind::File
    };
    Ok(WorkspaceNode {
        name: new_name.into(),
        path: target.to_string_lossy().into_owned(),
        kind,
        children: (kind == NodeKind::Dir).then_some(Vec::new()),
        size: (kind == NodeKind::File).then_some(md.len()),
        mtime_ms: Some(fs_service::mtime_from_meta(&md)),
    })
}

/// 把条目移动到目标目录（文件树拖拽）。
///
/// - 同卷直接 `fs::rename`（原子、瞬时）；
/// - 跨卷（Windows `ERROR_NOT_SAME_DEVICE` / POSIX `EXDEV`）回退「递归复制 → 删源」，
///   复制失败时**不动源**，宁可留下半份副本也不丢原文件；
/// - 拒绝把条目移进它自己或它的子目录（会造成无限层级），拒绝覆盖同名条目，
///   拖回原父目录按幂等处理（直接返回当前节点）。
pub fn move_entry(path: &Path, target_dir: &Path) -> AppResult<WorkspaceNode> {
    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "条目不存在: {}",
            path.display()
        )));
    }
    if !target_dir.is_dir() {
        return Err(AppError::NotFound(format!(
            "目标目录不存在: {}",
            target_dir.display()
        )));
    }
    let name = path
        .file_name()
        .ok_or_else(|| AppError::InvalidArg("路径没有条目名".into()))?;
    if is_same_or_inside(target_dir, path) {
        return Err(AppError::InvalidArg(
            "不能把条目移动到它自己或它的子目录里".into(),
        ));
    }
    let target = target_dir.join(name);
    if is_same_or_inside(&target, path) || path == target {
        // 拖回原处：当成幂等操作，返回当前节点让前端照常刷新
        return node_of(path);
    }
    if target.exists() {
        return Err(AppError::Conflict(format!(
            "目标目录里已存在同名条目: {}",
            name.to_string_lossy()
        )));
    }
    // 同卷 rename 的「先检查再改名」存在窗口期：标准库没有不覆盖的 rename，
    // POSIX 的 rename 会静默替换窗口期内冒出来的同名文件。用户拖拽场景下手速
    // 撞上这个窗口的概率极低，真要闭合得用 renameat2(RENAME_NOREPLACE)（仅 Linux）；
    // 跨卷回退那条路已经用 create_new 保证不覆盖。
    match fs::rename(path, &target) {
        Ok(()) => {}
        Err(e) if is_cross_device(&e) => move_across_devices(path, &target)?,
        Err(e) => return Err(e.into()),
    }
    node_of(&target)
}

/// 条目路径 → 节点（移动/原地返回共用）
fn node_of(path: &Path) -> AppResult<WorkspaceNode> {
    let md = fs::metadata(path)?;
    let kind = if md.is_dir() {
        NodeKind::Dir
    } else {
        NodeKind::File
    };
    Ok(WorkspaceNode {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        kind,
        children: (kind == NodeKind::Dir).then_some(Vec::new()),
        size: (kind == NodeKind::File).then_some(md.len()),
        mtime_ms: Some(fs_service::mtime_from_meta(&md)),
    })
}

/// 跨卷错误判定：Windows 17 = ERROR_NOT_SAME_DEVICE，POSIX 18 = EXDEV。
/// 两个值恰好相邻，但绝不能合成 `Some(17) | Some(18)`——Windows 的 18 是
/// ERROR_NO_MORE_FILES，POSIX 的 17 是 EEXIST，误判会把无关错误当成跨卷。
fn is_cross_device(e: &std::io::Error) -> bool {
    #[cfg(windows)]
    const CROSS_DEVICE: i32 = 17;
    #[cfg(unix)]
    const CROSS_DEVICE: i32 = 18;
    #[cfg(not(any(windows, unix)))]
    const CROSS_DEVICE: i32 = -1;
    e.raw_os_error() == Some(CROSS_DEVICE)
}

/// 跨卷移动：先完整复制到目标，成功后再删源。复制途中失败会清掉半成品，源文件原样保留。
fn move_across_devices(src: &Path, dst: &Path) -> AppResult<()> {
    let copied = if src.is_dir() {
        copy_dir_all(src, dst)
    } else {
        copy_file_new(src, dst)
    };
    if let Err(e) = copied {
        // 清掉可能留下的半份副本（只删我们刚创建的目标路径）
        if dst.exists() {
            clear_readonly_recursive(dst);
            let _ = if dst.is_dir() {
                fs::remove_dir_all(dst)
            } else {
                fs::remove_file(dst)
            };
        }
        return Err(AppError::Io(format!("跨盘复制失败: {e}")));
    }
    // Windows 下只读属性的条目删不掉，复制过来时也保留了只读属性；
    // 不清掉的话「复制成功、删源失败」会成常态（副本+原件“双份”）
    clear_readonly_recursive(src);
    let removed = if src.is_dir() {
        fs::remove_dir_all(src)
    } else {
        fs::remove_file(src)
    };
    if let Err(e) = removed {
        // 副本已就位、源删不掉：两个路径同时存在比丢文件安全，报错让用户自己处理
        return Err(AppError::Io(format!(
            "已复制到目标，但原条目删除失败（可手动删除）: {e}"
        )));
    }
    Ok(())
}

/// 复制单个文件，目标必须不存在（create_new 一次完成「判重 + 创建」）。
/// 不用 fs::copy：它会直接覆盖窗口期内新冒出来的同名文件。
fn copy_file_new(src: &Path, dst: &Path) -> std::io::Result<()> {
    let mut input = fs::File::open(src)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dst)?;
    std::io::copy(&mut input, &mut output)?;
    drop(output);
    // 保留源文件权限（只读、可执行位），与 fs::copy 的行为对齐
    fs::set_permissions(dst, fs::metadata(src)?.permissions())?;
    Ok(())
}

/// 逐层清除只读属性（Windows 删目录/文件时只读会直接拦下；其他平台是 no-op）
fn clear_readonly_recursive(path: &Path) {
    #[cfg(windows)]
    {
        if let Ok(md) = fs::metadata(path) {
            if md.permissions().readonly() {
                let mut perms = md.permissions();
                #[allow(clippy::permissions_set_readonly_false)]
                perms.set_readonly(false);
                let _ = fs::set_permissions(path, perms);
            }
            if md.is_dir() {
                if let Ok(rd) = fs::read_dir(path) {
                    for entry in rd.flatten() {
                        clear_readonly_recursive(&entry.path());
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    let _ = path;
}

/// 递归复制目录。目标必须不存在：create_dir（不是 create_dir_all）失败即中止，
/// 防止窗口期内出现的同名目录被「合并」成半新半旧的混合树。
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            copy_file_new(&entry.path(), &to)?;
        }
    }
    Ok(())
}

/// child 是否等于 ancestor 或位于其下。
/// 先按真实路径（canonicalize）比较：软链/目录联接会让字面不同的路径指向同一处，
/// 只比字面会放过「经联接移进自己的子目录」。路径还不存在（移动目标尚未创建）或
/// 无权限解析时退回字面比较——字面比较是保守下界，最多漏判、不会误拒。
fn is_same_or_inside(child: &Path, ancestor: &Path) -> bool {
    if let (Ok(c), Ok(a)) = (fs::canonicalize(child), fs::canonicalize(ancestor)) {
        if lexical_same_or_inside(&c, &a) {
            return true;
        }
    }
    lexical_same_or_inside(child, ancestor)
}

/// 路径组件逐段比较（Windows 下大小写不敏感）
fn lexical_same_or_inside(child: &Path, ancestor: &Path) -> bool {
    fn parts(p: &Path) -> Vec<String> {
        p.components()
            .map(|c| {
                let s = c.as_os_str().to_string_lossy().into_owned();
                #[cfg(windows)]
                {
                    s.to_lowercase()
                }
                #[cfg(not(windows))]
                {
                    s
                }
            })
            .collect()
    }
    let (c, a) = (parts(child), parts(ancestor));
    a.len() <= c.len() && a.iter().zip(c.iter()).all(|(x, y)| x == y)
}

pub fn delete_entry(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "条目不存在: {}",
            path.display()
        )));
    }
    // 只读属性会让 Windows 的回收站操作直接中止，先清掉
    #[cfg(windows)]
    if let Ok(md) = fs::metadata(path) {
        if md.permissions().readonly() {
            let mut perms = md.permissions();
            // clippy 提示 set_readonly(false) 创建文件时不生效——这里目的正是
            // 修改既有条目的只读属性以便移入回收站，属有意为之
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = fs::set_permissions(path, perms);
        }
    }
    // 删除进回收站，避免误删不可恢复
    if let Err(e) = trash::delete(path) {
        // trash 可能报错但实际已完成（SHFileOperation 假失败）：目标已消失即达标
        if !path.exists() {
            return Ok(());
        }
        #[cfg(windows)]
        {
            // trash crate 在文件被占用/网络盘/特殊属性场景会报
            // "Some operations were aborted"，回退到 shell 的 SendToRecycleBin
            recycle_via_shell(path)?;
            let _ = e;
            return Ok(());
        }
        #[cfg(not(windows))]
        return Err(AppError::Io(format!("移入回收站失败: {e}")));
    }
    Ok(())
}

/// Windows 兜底：PowerShell + VisualBasic.FileSystem 的 SendToRecycleBin。
/// 同样进回收站，不物理删除。
#[cfg(windows)]
fn recycle_via_shell(path: &Path) -> AppResult<()> {
    let quoted = path.to_string_lossy().replace('\'', "''");
    let verb = if path.is_dir() {
        "DeleteDirectory"
    } else {
        "DeleteFile"
    };
    let script = format!(
        "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::{verb}('{q}','OnlyErrorDialogs','SendToRecycleBin')",
        verb = verb,
        q = quoted,
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| AppError::Io(format!("回收站回退启动失败: {e}")))?;
    if out.status.success() {
        return Ok(());
    }
    // 目标在删除过程中已消失（如临时文件被创建方回收）＝目的已达成
    if !path.exists() {
        return Ok(());
    }
    // PowerShell stderr 在中文系统是 GBK，utf8 直转会乱码，用 encoding_rs 解码
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if stderr.contains('\u{FFFD}') {
        let (decoded, _, _) = encoding_rs::GBK.decode(&out.stderr);
        return Err(AppError::Io(format!("移入回收站失败: {}", decoded.trim())));
    }
    Err(AppError::Io(format!("移入回收站失败: {}", stderr.trim())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, name: &str) {
        fs::write(dir.join(name), "x").unwrap();
    }

    #[test]
    fn tree_sorts_dirs_first_and_shows_dot_prefixed() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "b.md");
        touch(dir.path(), "A.md");
        touch(dir.path(), ".hidden.md");
        fs::create_dir(dir.path().join("zfolder")).unwrap();
        touch(&dir.path().join("zfolder"), "inner.md");
        fs::create_dir(dir.path().join(".workbuddy")).unwrap();
        fs::create_dir(dir.path().join("node_modules")).unwrap();

        let tree = build_tree(dir.path(), 4).unwrap();
        let names: Vec<String> = tree.children.unwrap().into_iter().map(|n| n.name).collect();
        // 目录优先且点开头目录照常显示（.workbuddy），随后文件；只有 node_modules 被忽略
        assert_eq!(
            names,
            vec![".workbuddy", "zfolder", ".hidden.md", "A.md", "b.md"]
        );
    }

    #[test]
    fn create_conflict_is_conflict_error() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "exist.md");
        let err = create_entry(dir.path(), "exist.md", NodeKind::File).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)));
    }

    #[test]
    fn create_file_then_rename() {
        let dir = tempfile::tempdir().unwrap();
        let node = create_entry(dir.path(), "新建.md", NodeKind::File).unwrap();
        assert!(dir.path().join("新建.md").exists());
        let renamed = rename_entry(Path::new(&node.path), "改名.md").unwrap();
        assert_eq!(renamed.name, "改名.md");
        assert!(dir.path().join("改名.md").exists());
        assert!(!dir.path().join("新建.md").exists());
    }

    #[test]
    fn invalid_names_rejected() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["", "a/b", "a:b", "a?b"] {
            assert!(
                create_entry(dir.path(), bad, NodeKind::File).is_err(),
                "应拒绝: {bad}"
            );
        }
    }

    // ---- 拖拽移动 ----
    #[test]
    fn move_file_into_subdir() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        touch(dir.path(), "a.md");

        let node = move_entry(&dir.path().join("a.md"), &dir.path().join("sub")).unwrap();
        assert_eq!(node.name, "a.md");
        assert!(dir.path().join("sub").join("a.md").exists());
        assert!(!dir.path().join("a.md").exists(), "源文件应已消失");
    }

    #[test]
    fn move_rejects_self_and_descendant() {
        let dir = tempfile::tempdir().unwrap();
        let outer = dir.path().join("outer");
        fs::create_dir(&outer).unwrap();
        fs::create_dir(outer.join("inner")).unwrap();

        assert!(move_entry(&outer, &outer).is_err(), "不能移进自己");
        let err = move_entry(&outer, &outer.join("inner")).unwrap_err();
        assert!(
            matches!(err, AppError::InvalidArg(_)),
            "移进子目录应为参数错误: {err:?}"
        );
        assert!(outer.is_dir(), "拒绝后目录必须原样还在");
    }

    #[test]
    fn move_conflict_keeps_source() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        touch(dir.path(), "a.md");
        touch(&dir.path().join("sub"), "a.md");

        let err = move_entry(&dir.path().join("a.md"), &dir.path().join("sub")).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)), "同名应报冲突: {err:?}");
        assert!(dir.path().join("a.md").exists(), "冲突时源文件不能被删");
    }

    #[test]
    fn move_to_same_parent_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "a.md");
        let node = move_entry(&dir.path().join("a.md"), dir.path()).unwrap();
        assert_eq!(node.name, "a.md");
        assert!(dir.path().join("a.md").exists());
    }

    #[test]
    fn cross_device_code_is_platform_specific() {
        #[cfg(windows)]
        {
            assert!(is_cross_device(&std::io::Error::from_raw_os_error(17)));
            // 18 在 Windows 是 ERROR_NO_MORE_FILES，不能当跨卷
            assert!(!is_cross_device(&std::io::Error::from_raw_os_error(18)));
        }
        #[cfg(unix)]
        {
            assert!(is_cross_device(&std::io::Error::from_raw_os_error(18)));
            // 17 在 POSIX 是 EEXIST，不能当跨卷
            assert!(!is_cross_device(&std::io::Error::from_raw_os_error(17)));
        }
    }

    #[test]
    fn copy_dir_all_copies_nested_and_rejects_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("a.md"), "a").unwrap();
        fs::write(src.join("nested").join("b.md"), "b").unwrap();
        let dst = dir.path().join("dst");
        copy_dir_all(&src, &dst).unwrap();
        assert_eq!(fs::read_to_string(dst.join("a.md")).unwrap(), "a");
        assert_eq!(
            fs::read_to_string(dst.join("nested").join("b.md")).unwrap(),
            "b"
        );
        // 目标已存在必须报错：合并进已有目录会得到半新半旧的混合树
        assert!(copy_dir_all(&src, &dst).is_err());
    }

    #[test]
    fn copy_file_new_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.md");
        fs::write(&src, "new").unwrap();
        let dst = dir.path().join("b.md");
        fs::write(&dst, "old").unwrap();
        assert!(copy_file_new(&src, &dst).is_err());
        assert_eq!(fs::read_to_string(&dst).unwrap(), "old", "已存在的目标不能被覆盖");
    }

    /// Windows 保留设备名（任意扩展名、大小写不敏感）与尾点/尾空格一律拒
    #[test]
    fn reserved_device_names_and_trailing_chars_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let bad = [
            "CON", "con.txt", "PRN.md", "aux", "NUL.log", "nul.",
            "COM1", "com9.txt", "LPT1", "lpt9.doc",
            "a.", "a ", "方案.", "方案 ",
        ];
        for b in bad {
            assert!(
                create_entry(dir.path(), b, NodeKind::File).is_err(),
                "应拒绝: {b}"
            );
            // 重命名入口同样过 validate_name（目标不存在也会先拒非法名）
            assert!(
                rename_entry(&dir.path().join("whatever"), b).is_err(),
                "重命名应拒绝: {b}"
            );
        }
        // 形似但非保留名 / 序号超范围的必须放行
        let ok = ["CONS.md", "com10.txt", "LPT10", "COM0", "a.b", "正常.md", "con sole.md"];
        for g in ok {
            assert!(
                create_entry(dir.path(), g, NodeKind::File).is_ok(),
                "应允许: {g}"
            );
        }
    }

    #[test]
    fn tree_shows_every_visible_entry() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "a.md");
        touch(dir.path(), "b.docx");
        touch(dir.path(), "c.xlsx");
        touch(dir.path(), "方案.pdf");
        touch(dir.path(), "noext");
        touch(dir.path(), "~$b.docx"); // Office 锁文件
        let tree = build_tree(dir.path(), 4).unwrap();
        let names: Vec<String> = tree.children.unwrap().into_iter().map(|n| n.name).collect();
        // 全部可见条目进树（Office/PDF/无扩展名都在），仅 ~$ 锁文件被跳过
        assert_eq!(names, vec!["a.md", "b.docx", "c.xlsx", "noext", "方案.pdf"]);
    }
}
