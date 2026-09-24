#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 入口不再 expect：启动失败打日志并以非零码退出，而非 panic + abort
    if let Err(e) = mkdown_lib::run() {
        eprintln!("[mkdown] 应用启动失败: {e}");
        std::process::exit(1);
    }
}
