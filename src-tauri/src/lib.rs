//! 跨平台串口控制层：通过 Tauri 命令执行设备访问，并以事件向界面推送接收字节。

mod config;
mod serial;

use serial::SerialService;

/// 注册串口命令与共享服务，启动桌面窗口事件循环。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        .manage(SerialService::default())
        .invoke_handler(tauri::generate_handler![
            serial::list_ports,
            serial::open_port,
            serial::close_port,
            serial::send_bytes
        ])
        .run(tauri::generate_context!())
}
