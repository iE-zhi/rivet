//! 串口日志导出模块：通过 Tauri 原生保存对话框选取路径并写入 UTF-8 日志。
//!
//! 文件对话框与磁盘 I/O 在阻塞线程执行；写入成功后才原子替换用户选择的目标文件。

use std::io::Write;
use std::path::Path;
use tauri_plugin_dialog::DialogExt;

/// 保存日志内容的最大 UTF-8 字节数；超出 128 KiB 的输入会在打开对话框前拒绝。
pub(crate) const MAX_LOG_CONTENT_BYTES: usize = 128 * 1024;

/// 打开原生保存对话框并将日志写入用户选择的 UTF-8 文本文件。
///
/// `content` 是待导出的日志文本，按 UTF-8 字节计长且不得为空或超过 128 KiB。
/// 返回 `false` 表示用户取消；参数、对话框、路径或文件操作失败时返回错误。
#[tauri::command]
pub async fn save_log(app: tauri::AppHandle, content: String) -> Result<bool, String> {
    validate_log_content(&content)?;

    tauri::async_runtime::spawn_blocking(move || save_log_blocking(&app, &content))
        .await
        .map_err(|error| format!("保存日志任务失败：{error}"))?
}

/// 在阻塞线程显示保存对话框，并按用户选择写入日志文件。
///
/// 对话框取消返回 `false`；无法转换路径或写入文件时返回错误。
fn save_log_blocking(app: &tauri::AppHandle, content: &str) -> Result<bool, String> {
    let Some(selected_path) = app
        .dialog()
        .file()
        .set_file_name("串口日志.txt")
        .add_filter("文本文件", &["txt"])
        .blocking_save_file()
    else {
        return Ok(false);
    };

    let path = selected_path
        .into_path()
        .map_err(|error| format!("保存路径无效：{error}"))?;
    write_log_file(&path, content)?;
    Ok(true)
}

/// 拒绝空日志和超过上限的 UTF-8 文本。
///
/// 长度按 UTF-8 字节计算，以限制传入命令的内存及磁盘写入量。
pub(crate) fn validate_log_content(content: &str) -> Result<(), String> {
    if content.is_empty() {
        return Err("日志内容为空，无法保存".to_string());
    }
    if content.len() > MAX_LOG_CONTENT_BYTES {
        return Err(format!(
            "日志内容超过 {} 字节，无法保存",
            MAX_LOG_CONTENT_BYTES
        ));
    }
    Ok(())
}

/// 先在目标目录完整写入临时文件，再原子替换目标，保留失败时的旧文件内容。
///
/// `path` 必须是保存对话框返回的文件路径；父目录必须已存在且允许写入。
/// 写入、同步或替换失败时返回系统错误，临时文件由 RAII 清理。
pub(crate) fn write_log_file(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("创建临时日志文件失败：{error}"))?;
    temporary
        .write_all(content.as_bytes())
        .map_err(|error| format!("写入日志文件失败：{error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("同步日志文件失败：{error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("替换日志文件失败：{}", error.error))?;
    Ok(())
}
