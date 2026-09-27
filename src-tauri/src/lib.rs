//! Rivet 桌面后端：提供串口、SSH/SFTP/X11 终端和日志导出能力，并通过 Tauri 命令与事件连接前端。

mod config;
mod credential_store;
mod external_links;
mod local_terminal;
mod log_export;
mod serial;
mod sftp;
mod ssh;
mod sync;
mod sync_secrets;
mod terminal_serial;
#[cfg(windows)]
mod windows_icon;
mod x11;

use local_terminal::LocalTerminalService;
use serial::SerialService;
use ssh::SshService;
use terminal_serial::TerminalSerialService;

/// 注册串口、SSH/SFTP/X11 终端及日志导出命令，初始化原生文件对话框并启动桌面窗口事件循环。
///
/// Windows 启动时同步主窗口的大图标与 Tauri 已配置的小图标。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(LocalTerminalService::default())
        .manage(SerialService::default())
        .manage(SshService::default())
        .manage(TerminalSerialService::default())
        .invoke_handler(tauri::generate_handler![
            serial::list_ports,
            serial::open_port,
            serial::close_port,
            serial::send_bytes,
            credential_store::load_ssh_secrets,
            credential_store::save_ssh_secrets,
            credential_store::delete_ssh_secrets,
            local_terminal::open_local_terminal,
            local_terminal::local_terminal_send_input,
            local_terminal::local_terminal_resize,
            local_terminal::local_terminal_has_child_processes,
            local_terminal::close_local_terminal,
            terminal_serial::open_terminal_serial_session,
            terminal_serial::terminal_serial_send_input,
            terminal_serial::close_terminal_serial_session,
            ssh::open_ssh_session,
            ssh::ssh_send_input,
            ssh::ssh_resize_session,
            ssh::close_ssh_session,
            sync::sync_token_exists,
            sync::save_sync_token,
            sync::replace_sync_token,
            sync::delete_sync_token,
            sync::open_sync_token_page,
            external_links::open_external_page,
            sync::ensure_sync_remote,
            sync::read_sync_remote,
            sync::write_sync_remote,
            sync::prepare_sync_local,
            sync::apply_sync_remote_secrets,
            sync::export_sync_backup,
            sync::read_sync_backup,
            sync::apply_sync_backup_secrets,
            sftp::sftp_list,
            sftp::sftp_upload_file,
            sftp::sftp_upload_path,
            sftp::sftp_download_file,
            sftp::sftp_delete,
            sftp::sftp_rename,
            log_export::save_log
        ])
        // 应用启动回调：Windows 同步主窗口图标，失败时将错误返回给启动流程。
        .setup(|_app| {
            credential_store::initialize(_app.handle()).map_err(|error| {
                std::io::Error::other(format!("初始化 Rivet 本地凭据存储失败：{error}"))
            })?;
            #[cfg(windows)]
            windows_icon::bind_main_window_icon(_app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
}
