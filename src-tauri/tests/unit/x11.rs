//! X11 转发模块测试。

use std::sync::Arc;

use crate::x11::{self, LocalAuth, LocalEndpoint, X11ForwardConfig};

/// 构造远端 X11 setup 的认证头和对齐后的认证区。
fn fake_setup(config: &X11ForwardConfig, little_endian: bool) -> ([u8; 12], Vec<u8>) {
    let protocol = config.protocol.as_bytes();
    let cookie = config.fake_cookie.as_ref();
    let protocol_padded = (protocol.len() + 3) & !3;
    let cookie_padded = (cookie.len() + 3) & !3;
    let mut header = [0_u8; 12];
    header[0] = if little_endian { b'l' } else { b'B' };
    let protocol_len = protocol.len() as u16;
    let cookie_len = cookie.len() as u16;
    let protocol_bytes = if little_endian {
        protocol_len.to_le_bytes()
    } else {
        protocol_len.to_be_bytes()
    };
    let cookie_bytes = if little_endian {
        cookie_len.to_le_bytes()
    } else {
        cookie_len.to_be_bytes()
    };
    header[6..8].copy_from_slice(&protocol_bytes);
    header[8..10].copy_from_slice(&cookie_bytes);

    let mut auth = vec![0_u8; protocol_padded + cookie_padded];
    auth[..protocol.len()].copy_from_slice(protocol);
    auth[protocol_padded..protocol_padded + cookie.len()].copy_from_slice(cookie);
    (header, auth)
}

/// Linux 本地 DISPLAY 应映射到 /tmp/.X11-unix 下的 Unix socket。
#[cfg(unix)]
#[test]
fn linux_display_resolves_local_unix_socket() {
    use std::path::PathBuf;

    let display = ":10.0";
    let (display_number, screen) = x11::parse_display_numbers(display).unwrap();
    let path = x11::local_unix_socket_path(display, display_number)
        .unwrap()
        .unwrap();

    assert_eq!(display_number, 10);
    assert_eq!(screen, 0);
    assert_eq!(path, PathBuf::from("/tmp/.X11-unix/X10"));
}

/// XQuartz 的绝对路径 DISPLAY 应直接作为本机 Unix socket。
#[cfg(unix)]
#[test]
fn xquartz_display_resolves_launchd_socket() {
    use std::path::PathBuf;

    let display = "/private/tmp/com.apple.launchd.example/org.xquartz:0";
    let (display_number, screen) = x11::parse_display_numbers(display).unwrap();
    let path = x11::local_unix_socket_path(display, display_number)
        .unwrap()
        .unwrap();

    assert_eq!(display_number, 0);
    assert_eq!(screen, 0);
    assert_eq!(path, PathBuf::from(display));
}

#[cfg(target_os = "macos")]
#[test]
fn xquartz_launchd_display_uses_no_local_cookie() {
    let previous = std::env::var_os("DISPLAY");
    std::env::set_var(
        "DISPLAY",
        "/private/tmp/com.apple.launchd.example/org.xquartz:0",
    );

    let result = x11::prepare_local_x11(None, Some("/opt/X11/bin/xauth"));

    match previous {
        Some(value) => std::env::set_var("DISPLAY", value),
        None => std::env::remove_var("DISPLAY"),
    }

    let (endpoint, local_auth, screen) = result.unwrap();
    assert_eq!(screen, 0);
    assert!(matches!(local_auth, LocalAuth::Disabled));
    assert!(matches!(endpoint, LocalEndpoint::Unix(_)));
}

/// 无认证模式应保留远端假 cookie 校验，但向本地 X Server 清除认证字段。
#[cfg(any(windows, target_os = "macos"))]
#[test]
fn disabled_local_auth_strips_setup_authentication() {
    let fake_cookie = [0x5a_u8; 16];
    let config = X11ForwardConfig {
        protocol: Arc::from("MIT-MAGIC-COOKIE-1"),
        fake_cookie_hex: Arc::from("5a".repeat(16)),
        fake_cookie: Arc::from(fake_cookie),
        local_auth: LocalAuth::Disabled,
        screen: 0,
        endpoint: LocalEndpoint::Tcp {
            host: Arc::from("127.0.0.1"),
            port: 6000,
        },
    };
    let (mut header, mut auth) = fake_setup(&config, true);

    let auth_len = x11::rewrite_x11_auth(&mut header, &mut auth, &config).unwrap();

    assert_eq!(auth_len, 0);
    assert_eq!(&header[6..10], &[0, 0, 0, 0]);
}

/// Unix cookie 模式应把远端假 cookie 替换为本机真实 cookie，并保留完整认证区。
#[cfg(unix)]
#[test]
fn cookie_local_auth_replaces_fake_cookie() {
    let fake_cookie = [0x11_u8; 16];
    let real_cookie = [0x22_u8; 16];
    let config = X11ForwardConfig {
        protocol: Arc::from("MIT-MAGIC-COOKIE-1"),
        fake_cookie_hex: Arc::from("11".repeat(16)),
        fake_cookie: Arc::from(fake_cookie),
        local_auth: LocalAuth::Cookie(Arc::from(real_cookie)),
        screen: 0,
        endpoint: LocalEndpoint::Tcp {
            host: Arc::from("127.0.0.1"),
            port: 6000,
        },
    };
    let (mut header, mut auth) = fake_setup(&config, false);
    let protocol_padded = (config.protocol.len() + 3) & !3;

    let auth_len = x11::rewrite_x11_auth(&mut header, &mut auth, &config).unwrap();

    assert_eq!(auth_len, auth.len());
    assert_eq!(&auth[protocol_padded..protocol_padded + 16], &real_cookie,);
}

/// Windows 平台准备函数只使用设置地址，且固定采用无认证本地 setup。
#[cfg(windows)]
#[test]
fn windows_preparation_uses_configured_server_without_display() {
    let (endpoint, local_auth, screen) =
        x11::prepare_local_x11(Some("127.0.0.1:6000"), None).unwrap();

    assert_eq!(screen, 0);
    assert!(matches!(local_auth, LocalAuth::Disabled));
    match endpoint {
        LocalEndpoint::Tcp { host, port } => {
            assert_eq!(host.as_ref(), "127.0.0.1");
            assert_eq!(port, 6000);
        }
    }
}
