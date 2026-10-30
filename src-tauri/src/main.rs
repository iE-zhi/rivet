#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 在创建线程和初始化 GTK 前为 Linux 设置默认 X11 后端；保留用户指定的后端和 DMA-BUF 配置。
#[cfg(target_os = "linux")]
fn configure_linux_webview_compatibility() {
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
}

/// 启动 Tauri 桌面应用并委托库模块注册串口能力。
fn main() {
    #[cfg(target_os = "linux")]
    configure_linux_webview_compatibility();

    if let Err(error) = rivet_lib::run() {
        eprintln!("启动 Rivet Tauri 应用失败：{error}");
        std::process::exit(1);
    }
}
