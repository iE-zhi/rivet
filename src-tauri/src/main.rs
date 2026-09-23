#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 启动 Tauri 桌面应用并委托库模块注册串口能力。
fn main() {
    if let Err(error) = rivet_lib::run() {
        eprintln!("启动 Rivet Tauri 应用失败：{error}");
        std::process::exit(1);
    }
}
