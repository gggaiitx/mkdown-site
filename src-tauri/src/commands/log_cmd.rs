use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

/// 渲染层日志上限：超了就轮转一份（只留一代），长期运行不会把磁盘写满
const MAX_LOG_BYTES: u64 = 1_024 * 1_024;

/// 单条日志各字段的字节上限。错误往往来自 `JSON.stringify(大对象)` 或整段 HTML，
/// 一条就能顶到轮转阈值、把之前的上下文全挤掉；8KB 足够放下真实栈信息。
const MAX_FIELD_BYTES: usize = 8 * 1024;

/// 按字节截断但保证落在字符边界上（中文日志不能切出半个字）
fn clip(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// 正文类字段压成单行：错误消息里夹带换行会让它在日志里伪造出「另一条记录」
fn one_line(s: &str) -> String {
    s.replace('\r', " ").replace('\n', "\\n")
}

/// 把用户主目录替换成 `~`：日志可能被用户贴进 issue，不该带上完整用户名。
/// 用 ASCII 小写比较（Windows 路径大小写不敏感），ASCII 大小写转换不改变字节长度，
/// 才能安全地用字节下标切片；非 ASCII 字符保持原样。
fn redact_home(s: &str, home: Option<&Path>) -> String {
    let Some(home) = home else {
        return s.to_string();
    };
    let h = home.to_string_lossy();
    if h.is_empty() {
        return s.to_string();
    }
    let hay = s.to_ascii_lowercase();
    let needle = h.to_ascii_lowercase();
    let mut out = String::with_capacity(s.len());
    let mut start = 0;
    while let Some(pos) = hay[start..].find(&needle) {
        let abs = start + pos;
        out.push_str(&s[start..abs]);
        out.push('~');
        start = abs + h.len();
    }
    out.push_str(&s[start..]);
    out
}

/// 渲染层错误写盘：`$APPCONFIG/logs/renderer.log`
/// （Windows 为 `%APPDATA%\com.feizong.mkdown\logs\renderer.log`）。
///
/// 为什么需要落盘：渲染层一旦被未捕获异常打断，界面停在半白状态，用户既看不到 DevTools
/// 也没有可复述的信息。这份日志至少能回答「什么时候、哪个标签、什么栈」。
/// 前端已做同类错误 60s 去重，这里不做二次节流。
#[tauri::command]
pub async fn log_renderer_error(
    app: AppHandle,
    level: String,
    message: String,
    stack: Option<String>,
    context: Option<String>,
    ts: Option<String>,
) -> AppResult<()> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Io(format!("无法定位配置目录: {e}")))?
        .join("logs");

    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        fs::create_dir_all(&dir)?;
        let path = dir.join("renderer.log");
        // 轮转：超限就把现值改名成 .1（覆盖上一代），日志总量恒定在 ~2MB
        if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_LOG_BYTES {
            if fs::rename(&path, dir.join("renderer.1.log")).is_err() {
                // 旧文件被占用/权限不足时轮转不了：退化成清空当前文件，
                // 宁可丢历史，也不让日志无限增长（下次启动通常就能正常轮转）
                let _ = OpenOptions::new().write(true).truncate(true).open(&path);
            }
        }
        let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
        let ts = ts.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis().to_string())
                .unwrap_or_else(|_| "?".into())
        });
        let home = app.path().home_dir().ok();
        let message = redact_home(&one_line(clip(&message, MAX_FIELD_BYTES)), home.as_deref());
        writeln!(f, "[{ts}] {level}: {message}")?;
        if let Some(s) = stack.as_deref().filter(|s| !s.is_empty()) {
            // 栈只留前 40 行：Vue 的调用栈常带整条组件链，再多就淹了日志
            for line in s.lines().take(40) {
                writeln!(f, "    {}", clip(line, MAX_FIELD_BYTES))?;
            }
        }
        if let Some(c) = context.as_deref().filter(|s| !s.is_empty()) {
            let c = redact_home(&one_line(clip(c, MAX_FIELD_BYTES)), home.as_deref());
            writeln!(f, "    context: {c}")?;
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Internal(format!("日志线程异常: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn clip_respects_char_boundaries() {
        let s = "中文日志内容";
        let cut = clip(s, 4); // 4 落在「日」的中间
        assert_eq!(cut, "中");
        assert_eq!(clip("short", 100), "short");
        assert_eq!(clip(s, 0), "");
    }

    #[test]
    fn one_line_escapes_newlines() {
        assert_eq!(one_line("a\r\nb\nc"), "a \\nb\\nc");
    }

    #[test]
    fn redact_home_is_case_insensitive_on_ascii() {
        let home = PathBuf::from("C:\\Users\\FeiZong");
        let msg = "err at c:\\users\\feizong\\doc.md and C:\\Users\\FeiZong\\b.md";
        assert_eq!(redact_home(msg, Some(&home)), "err at ~\\doc.md and ~\\b.md");
    }

    #[test]
    fn redact_home_without_match_and_without_home() {
        assert_eq!(redact_home("plain", None), "plain");
        let home = PathBuf::from("D:\\home");
        assert_eq!(redact_home("plain", Some(&home)), "plain");
    }
}
