//! Windows 主窗口图标适配模块。
//!
//! 本模块通过 Win32 消息复用 Tauri 持有的小图标句柄设置大图标，不拥有或释放该句柄；
//! 仅在 Windows 启动设置阶段处理默认主窗口。

use std::{
    error::Error,
    ffi::c_void,
    fmt::{self, Display, Formatter},
};

use tauri::Manager;

/// Windows `WM_GETICON` 消息码，用于读取窗口指定尺寸的图标句柄。
const WM_GETICON: u32 = 0x007F;
/// Windows `WM_SETICON` 消息码，用于设置窗口指定尺寸的图标句柄。
const WM_SETICON: u32 = 0x0080;
/// Windows 小图标类型，读取 Tauri 已配置且仍由窗口持有的图标句柄。
const ICON_SMALL: usize = 0;
/// Windows 大图标类型，使任务栏等调用方可读取高分辨率图标句柄。
const ICON_BIG: usize = 1;

/// 主窗口图标绑定流程可向 Tauri 启动钩子返回的错误。
#[derive(Debug)]
pub(super) enum WindowsIconError {
    /// Tauri 未创建默认主窗口。
    MainWindowUnavailable,
    /// Tauri 无法取得默认主窗口的原生句柄。
    NativeHandleUnavailable(String),
    /// Tauri 返回了空的原生窗口句柄。
    InvalidNativeHandle,
    /// 主窗口没有可复用的小图标句柄。
    SmallIconUnavailable,
    /// 设置后读回的大图标与指定的小图标不一致。
    BigIconMismatch {
        /// 传给 `WM_SETICON` 的 Tauri 小图标句柄。
        expected: isize,
        /// 从 `WM_GETICON` 读回的大图标句柄。
        actual: isize,
    },
}

/// 格式化图标同步错误，提供窗口阶段和句柄状态的上下文。
impl Display for WindowsIconError {
    /// 将错误类别和关联句柄状态写入格式化输出。
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::MainWindowUnavailable => formatter.write_str("Tauri 默认主窗口不可用"),
            Self::NativeHandleUnavailable(error) => {
                write!(formatter, "读取 Tauri 主窗口原生句柄失败：{error}")
            }
            Self::InvalidNativeHandle => formatter.write_str("Tauri 主窗口原生句柄为空"),
            Self::SmallIconUnavailable => formatter.write_str("Tauri 主窗口小图标句柄为空"),
            Self::BigIconMismatch { expected, actual } => write!(
                formatter,
                "Windows 大图标句柄校验失败：期望 {expected:#x}，实际 {actual:#x}"
            ),
        }
    }
}

impl Error for WindowsIconError {}

/// 通过当前窗口仍持有的小图标句柄设置并校验主窗口大图标。
///
/// # 参数
/// - `app`: Tauri 应用实例，用于取得默认标签 `main` 的 WebView 窗口。
///
/// # 返回
/// 设置并读回相同的图标句柄时返回 `Ok(())`；窗口、句柄或 Win32 校验失败时返回带上下文的错误。
pub(super) fn bind_main_window_icon(app: &tauri::App) -> Result<(), WindowsIconError> {
    let window = app
        .get_webview_window("main")
        .ok_or(WindowsIconError::MainWindowUnavailable)?;
    let hwnd = window
        .hwnd()
        .map_err(|error| WindowsIconError::NativeHandleUnavailable(error.to_string()))?
        .0;
    if hwnd.is_null() {
        return Err(WindowsIconError::InvalidNativeHandle);
    }

    // 该 HWND 来自仍存活的 Tauri 主窗口；同步消息只传递窗口当前持有的 HICON，不转移其所有权。
    let small_icon = unsafe { send_message_w(hwnd, WM_GETICON, ICON_SMALL, 0) };
    if small_icon == 0 {
        return Err(WindowsIconError::SmallIconUnavailable);
    }

    // 同一 HWND 在同步 setup 期间仍有效；复用 Tauri 持有的 HICON，不转移或释放句柄所有权。
    unsafe {
        send_message_w(hwnd, WM_SETICON, ICON_BIG, small_icon);
    }
    // 同一 HWND 在同步 setup 期间仍有效；读取大图标槽，不转移或释放句柄所有权。
    let actual_icon = unsafe { send_message_w(hwnd, WM_GETICON, ICON_BIG, 0) };
    if actual_icon != small_icon {
        return Err(WindowsIconError::BigIconMismatch {
            expected: small_icon,
            actual: actual_icon,
        });
    }

    Ok(())
}

#[link(name = "user32")]
unsafe extern "system" {
    /// 以 Win32 ABI 向窗口同步发送消息。
    ///
    /// # Safety
    /// 调用方必须传入仍有效的 HWND，并按消息约定传递指针宽度的图标句柄参数。
    #[link_name = "SendMessageW"]
    fn send_message_w(
        hwnd: *mut c_void,
        message: u32,
        icon_type: usize,
        icon_handle: isize,
    ) -> isize;
}
