//! 系统字体枚举：设置-外观「字体」下拉的数据源。
//!
//! 字体枚举在 Linux（fontconfig）上要扫描目录，首次可能耗时数百毫秒，
//! 因此放到阻塞线程池，不占 IPC 的异步执行器。

use std::collections::BTreeSet;

/// 列出系统已安装的字体家族（去重、排序）。
///
/// 只取家族名而不是具体字面（Regular/Bold…）：设置里选的是「字体」，
/// 字重/斜体由正文字体渲染自己决定。查询失败返回空列表，前端仍保留
/// 「应用默认 / 系统默认 / 自定义」三项，不会把用户卡死在空下拉里。
#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(system_font_families)
        .await
        .map_err(|err| err.to_string())
}

fn system_font_families() -> Vec<String> {
    let source = font_kit::source::SystemSource::new();
    match source.all_families() {
        Ok(families) => families
            .into_iter()
            .map(|family| family.trim().to_string())
            .filter(|family| !family.is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::system_font_families;

    #[test]
    fn enumerates_sorted_unique_families() {
        let fonts = system_font_families();
        assert!(!fonts.is_empty(), "字体枚举应当在本机返回非空列表");
        assert!(fonts.windows(2).all(|pair| pair[0] < pair[1]), "家族名应去重且有序");
    }
}
