#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Linux 默认使用更保守的 X11 + 非 DMA-BUF WebKitGTK 渲染路径，
/// 避免 Debian 13 / Wayland / NVIDIA 环境下出现 GBM/KMS buffer 创建失败。
///
/// 如果用户已显式设置对应环境变量，则保留用户配置，不做覆盖。
#[cfg(target_os = "linux")]
fn configure_linux_webview_compatibility() {
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }

    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
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
