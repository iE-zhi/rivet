//! 系统浏览器外链。
//!
//! 本模块集中管理桌面端允许直接打开的固定外部页面，并封装 Windows、macOS、Linux
//! 的系统默认浏览器调用。Tauri 命令只接受白名单页面标识；crate 内部可复用浏览器打开能力。

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command;

/// Rivet GitHub 项目主页。
const RIVET_GITHUB_PROJECT_URL: &str = "https://github.com/iE-zhi/rivet";
/// Rivet Gitee 项目主页。
const RIVET_GITEE_PROJECT_URL: &str = "https://gitee.com/boo0ood/rivet";
/// Windows X Server VcXsrv 项目主页。
const VCXSRV_PROJECT_URL: &str = "https://github.com/marchaesen/vcxsrv";
/// macOS X Server XQuartz 官方主页。
const XQUARTZ_PROJECT_URL: &str = "https://www.xquartz.org/";

/// 使用系统默认浏览器打开前端允许访问的固定外部页面。
///
/// page 只接受内置白名单标识，不允许前端传入任意 URL。
#[tauri::command]
pub async fn open_external_page(page: String) -> Result<(), String> {
    let url = external_page_url(page.trim())?;
    tauri::async_runtime::spawn_blocking(move || open_external_url(url))
        .await
        .map_err(|error| format!("打开外部页面任务失败：{error}"))?
}

/// 将外部页面白名单标识转换为固定 HTTPS URL。
pub(crate) fn external_page_url(page: &str) -> Result<&'static str, String> {
    match page {
        "rivet-github" => Ok(RIVET_GITHUB_PROJECT_URL),
        "rivet-gitee" => Ok(RIVET_GITEE_PROJECT_URL),
        "vcxsrv" => Ok(VCXSRV_PROJECT_URL),
        "xquartz" => Ok(XQUARTZ_PROJECT_URL),
        _ => Err("不支持的外部页面".to_string()),
    }
}

/// 使用系统默认浏览器打开受信任 URL。
///
/// 该函数仅供 crate 内部传入编译期固定或经过业务白名单选择的 URL。
pub(crate) fn open_external_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::{iter::once, os::windows::ffi::OsStrExt};
        use windows::{
            core::PCWSTR,
            Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        };

        let wide_url: Vec<u16> = std::ffi::OsStr::new(url)
            .encode_wide()
            .chain(once(0))
            .collect();
        // 按 URL 协议关联调用系统默认浏览器。
        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR::null(),
                PCWSTR(wide_url.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize <= 32 {
            return Err(format!(
                "打开系统浏览器失败：ShellExecuteW 返回 {}",
                result.0 as isize
            ));
        }
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(url);
        command
    };

    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return Err("当前平台不支持直接打开浏览器".to_string());

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开系统浏览器失败：{error}"))
}
