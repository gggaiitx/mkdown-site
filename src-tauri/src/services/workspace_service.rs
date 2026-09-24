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

fn validate_name(name: &str) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(AppError::InvalidArg("名称不能为空".into()));
    }
    if name.chars().any(|c| "\\/:*?\"<>|".contains(c)) {
        return Err(AppError::InvalidArg(format!("名称含非法字符: {name}")));
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
