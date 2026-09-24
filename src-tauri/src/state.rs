//! 运行时共享状态：路径授权表 + 搜索取消令牌。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use crate::error::{AppError, AppResult};

/// 运行时已授权的路径根（ADR-01：自写 command + 运行时路径白名单）。
///
/// 授权**只**来自用户显式意图：打开工作区、文件/文件夹对话框、另存为与导出目标、
/// 搜索根，以及启动时从设置恢复的「上次工作区 + 最近文件」所在目录。
/// 其余命令执行前必须过 [`AppState::ensure_allowed`]，越界返回 `PERMISSION_DENIED`，
/// 使前端无法借 IPC 读写任意路径（这正是 ADR-01 拒绝 `tauri-plugin-fs` 开
/// `["**"]` 全盘范围的原因）。
#[derive(Default)]
pub struct AppState {
    /// 已授权目录根（canonical 形式）；锁中毒时按"无授权"处理而非 panic
    roots: RwLock<Vec<PathBuf>>,
    /// 最近一轮搜索的取消令牌；新一轮开始时置停上一轮
    /// （ADR-03 不建索引，靠提前退出避免连打搜索时多轮全库扫描叠加）
    search_cancel: RwLock<Option<Arc<AtomicBool>>>,
    /// 「打开方式」启动参数带来的待打开文件：setup 存入，
    /// 前端挂载后经 take_pending_open_args 命令取走（事件先于监听器注册的竞态规避）
    pending_open: RwLock<Vec<String>>,
}

impl AppState {
    /// 授权一个目录根。幂等：已被更上层根覆盖则跳过；若新根更上层，剔除被它覆盖的子根。
    /// 路径不存在（盘符拔出、目录被删）时静默忽略——授权是尽力而为，不该中断主流程。
    pub fn grant_root(&self, dir: &Path) {
        let Ok(canonical) = dir.canonicalize() else {
            return;
        };
        let Ok(mut roots) = self.roots.write() else {
            return;
        };
        if roots.iter().any(|r| canonical.starts_with(r)) {
            return;
        }
        roots.retain(|r| !r.starts_with(&canonical));
        roots.push(canonical);
    }

    /// 判断路径是否落在任一已授权根之内（含根自身）。
    pub fn is_allowed(&self, path: &Path) -> bool {
        let Some(target) = canonicalize_loose(path) else {
            return false;
        };
        self.roots
            .read()
            .map(|roots| roots.iter().any(|r| target.starts_with(r)))
            .unwrap_or(false)
    }

    /// 白名单校验入口：通过返回 `Ok(())`，否则返回 `PERMISSION_DENIED`。
    ///
    /// # Errors
    /// - `PermissionDenied`：路径不在任何已授权根内，或路径无法解析
    pub fn ensure_allowed(&self, path: &Path) -> AppResult<()> {
        if self.is_allowed(path) {
            Ok(())
        } else {
            Err(AppError::PermissionDenied(format!(
                "路径未授权（请先打开所在目录或工作区）: {}",
                path.display()
            )))
        }
    }

    /// 开启新一轮搜索：置停上一轮并返回本轮取消令牌。
    /// 搜索内核在每次取条目/命中时检查它，被置停即整体退出。
    pub fn begin_search(&self) -> Arc<AtomicBool> {
        let token = Arc::new(AtomicBool::new(false));
        if let Ok(mut slot) = self.search_cancel.write() {
            if let Some(prev) = slot.replace(Arc::clone(&token)) {
                prev.store(true, Ordering::Relaxed);
            }
        }
        token
    }

    /// 存入启动参数解析出的待打开文件（覆盖式：启动时只解析一次）
    pub fn set_pending_open(&self, files: Vec<String>) {
        if let Ok(mut slot) = self.pending_open.write() {
            *slot = files;
        }
    }

    /// 取走待打开文件（取后即清）；前端挂载完成时调用一次
    pub fn take_pending_open(&self) -> Vec<String> {
        self.pending_open
            .write()
            .map(|mut slot| std::mem::take(&mut *slot))
            .unwrap_or_default()
    }
}

/// 尽力 canonicalize：路径自身不存在时（如"另存为"的新文件），退化为
/// 「父目录 canonicalize + 文件名」，使白名单校验对新文件同样生效。
fn canonicalize_loose(path: &Path) -> Option<PathBuf> {
    if let Ok(c) = path.canonicalize() {
        return Some(c);
    }
    let name = path.file_name()?;
    let parent = path.parent()?.canonicalize().ok()?;
    Some(parent.join(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unauthorized_path_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::default();
        let inside = dir.path().join("a.md");
        std::fs::write(&inside, "x").unwrap();

        assert!(!state.is_allowed(&inside), "未授权前一律拒绝");
        assert!(state.ensure_allowed(&inside).is_err());

        state.grant_root(dir.path());
        assert!(state.is_allowed(&inside));
        assert!(state.is_allowed(dir.path()), "根自身也应放行");
        assert!(state.ensure_allowed(&inside).is_ok());
    }

    #[test]
    fn sibling_directory_stays_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let state = AppState::default();
        state.grant_root(dir.path());

        assert!(!state.is_allowed(other.path()), "同级目录不得越权");
        assert!(!state.is_allowed(&other.path().join("b.md")));
    }

    #[test]
    fn new_file_in_granted_dir_is_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::default();
        state.grant_root(dir.path());
        // 文件尚不存在（另存为场景）：退化为父目录判定
        assert!(state.is_allowed(&dir.path().join("还没落盘.md")));
    }

    #[test]
    fn begin_search_cancels_previous_round() {
        let state = AppState::default();
        let first = state.begin_search();
        assert!(!first.load(Ordering::Relaxed));
        let second = state.begin_search();
        assert!(first.load(Ordering::Relaxed), "新一轮必须置停上一轮");
        assert!(!second.load(Ordering::Relaxed));
    }
}
