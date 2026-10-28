//! VNC 的独立测试：边界、像素复制、真实 loopback RFB 握手、输入及取消释放。

use crate::{
    credential_store::CredentialStore,
    vnc::{validate_password, VncInput, VncOpenRequest, VncService},
    vnc_frame::{VncFrame, FRAME_HEADER_BYTES},
};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::{sleep, timeout},
};
use vnc::Rect;

/// 测试连接和异步事件最多等待三秒，超时直接失败，不依赖长期随机等待。
const TEST_TIMEOUT: Duration = Duration::from_secs(3);

/// 创建指向 loopback 假服务器的配置；id 为独立会话标识，port 为随机绑定的端口。
fn request(id: &str, port: u16) -> VncOpenRequest {
    VncOpenRequest {
        session_id: id.into(),
        connection_id: id.into(),
        host: "127.0.0.1".into(),
        port,
        auth_type: "none".into(),
        password: Some(String::new()),
        read_only: false,
    }
}

/// 覆盖端口零、URL、控制字符、未知认证和密码截断边界；失败前不建立连接。
#[test]
fn connection_validation_rejects_invalid_endpoints_and_truncated_passwords() {
    let mut config = request("valid", 5900);
    assert!(config.validate().is_ok());
    for host in ["", "http://localhost", "user@host", "host\n", "[::1]"] {
        config.host = host.into();
        assert!(config.validate().is_err());
    }
    config.host = "::1".into();
    assert!(config.validate().is_ok());
    config.port = 0;
    assert!(config.validate().is_err());
    for password in ["123456789", "密码", "a\nb"] {
        assert!(validate_password(password).is_err());
    }
    assert!(validate_password("12345678").is_ok());
    assert!(validate_password("").is_ok());
}

/// 使用三行各不相同的真实像素验证重叠复制；空区、越界和短载荷不修改缓冲。
#[test]
fn framebuffer_preserves_overlapping_copy_and_rejects_out_of_bounds_updates() {
    let mut frame = VncFrame::default();
    frame.resize(2, 3).unwrap();
    let whole = Rect {
        x: 0,
        y: 0,
        width: 2,
        height: 3,
    };
    let pixels: Vec<u8> = (0..6).flat_map(|pixel| [pixel, 0, 0, 0]).collect();
    frame.draw(whole, &pixels).unwrap();
    frame
        .copy(
            Rect {
                x: 0,
                y: 1,
                width: 2,
                height: 2,
            },
            Rect {
                x: 0,
                y: 0,
                width: 2,
                height: 2,
            },
        )
        .unwrap();
    let snapshot = frame.snapshot(false);
    let values: Vec<u8> = snapshot[FRAME_HEADER_BYTES..]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|pixel| {
            assert_eq!(pixel[3], 255);
            pixel[0]
        })
        .collect();
    assert_eq!(values, [0, 1, 0, 1, 2, 3]);
    assert_eq!(frame.snapshot(false).len(), FRAME_HEADER_BYTES);
    assert_eq!(
        frame.snapshot(true),
        snapshot,
        "full snapshot must reconstruct an unchanged desktop"
    );
    assert!(frame
        .draw(
            Rect {
                x: 2,
                y: 0,
                width: 1,
                height: 1
            },
            &[0; 4]
        )
        .is_err());
    assert!(frame.draw(whole, &[0; 4]).is_err());
    assert!(frame.resize(8192, 8192).is_err());
    assert_eq!((frame.width, frame.height), (2, 3));
}

/// 相同 ID 的 SSH/VNC 凭据独立加密保存；删除 VNC 后 SSH 和磁文仍有效。
#[test]
fn vnc_credentials_roundtrip_without_affecting_same_id_ssh_secrets() {
    let temporary = tempfile::tempdir().unwrap();
    let store = CredentialStore::open_at(temporary.path().to_path_buf()).unwrap();
    store
        .save_ssh("same-id", "password", "ssh-password", "")
        .unwrap();
    store.save_vnc("same-id", "vnc-pass").unwrap();
    assert_eq!(store.load_vnc("same-id").unwrap(), "vnc-pass");
    let encrypted = std::fs::read_to_string(temporary.path().join("credentials.enc.json")).unwrap();
    assert!(!encrypted.contains("vnc-pass"));
    assert!(!encrypted.contains("ssh-password"));
    let reopened = CredentialStore::open_at(temporary.path().to_path_buf()).unwrap();
    assert_eq!(reopened.load_vnc("same-id").unwrap(), "vnc-pass");
    reopened.save_vnc("same-id", "").unwrap();
    assert_eq!(reopened.load_vnc("same-id").unwrap(), "");
    assert_eq!(
        reopened.load_ssh("same-id").unwrap().password,
        "ssh-password"
    );
}

/// 在 stream 上完成 RFB3.8 假服务端初始化；password=true 同时提供两种认证以检验策略筛选。
/// reject=true 模拟密码认证失败；该函数只使用内存和随机 loopback 端口。
async fn handshake(stream: &mut TcpStream, password: bool, reject: bool) -> bool {
    stream.write_all(b"RFB 003.008\n").await.unwrap();
    let mut version = [0; 12];
    stream.read_exact(&mut version).await.unwrap();
    assert_eq!(&version, b"RFB 003.008\n");
    if password {
        stream.write_all(&[2, 1, 2]).await.unwrap();
    } else {
        stream.write_all(&[1, 1]).await.unwrap();
    }
    let security = stream.read_u8().await.unwrap();
    assert_eq!(security, if password { 2 } else { 1 });
    if password {
        stream.write_all(&[17; 16]).await.unwrap();
        let mut response = [0; 16];
        stream.read_exact(&mut response).await.unwrap();
        assert_ne!(response, [0; 16]);
    }
    stream.write_u32(u32::from(reject)).await.unwrap();
    if reject {
        stream.write_u32(6).await.unwrap();
        stream.write_all(b"denied").await.unwrap();
        return false;
    }
    assert_eq!(stream.read_u8().await.unwrap(), 1); // 共享桌面标志，不踢掉其他客户端。
    stream.write_u16(2).await.unwrap();
    stream.write_u16(2).await.unwrap();
    stream
        .write_all(&[32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0])
        .await
        .unwrap();
    stream.write_u32(4).await.unwrap();
    stream.write_all(b"test").await.unwrap();
    true
}

/// 读取客户端设置消息到首次完整刷新；stream 只连接假服务器，不接触真实桌面。
async fn wait_for_refresh(stream: &mut TcpStream) {
    loop {
        match stream.read_u8().await.unwrap() {
            0 => {
                let mut rest = [0; 19];
                stream.read_exact(&mut rest).await.unwrap();
            }
            2 => {
                stream.read_u8().await.unwrap();
                let count = stream.read_u16().await.unwrap();
                let mut encodings = vec![0; usize::from(count) * 4];
                stream.read_exact(&mut encodings).await.unwrap();
            }
            3 => {
                let mut rest = [0; 9];
                stream.read_exact(&mut rest).await.unwrap();
                assert_eq!(rest[0], 0, "initial request must be non-incremental");
                break;
            }
            other => panic!("unexpected client message {other}"),
        }
    }
}

/// 等到指定会话状态出现，或三秒超时；每轮读取真实快照，间隔仅用于让出调度。
async fn wait_state(service: &VncService, id: &str, state: u8) -> Vec<u8> {
    timeout(TEST_TIMEOUT, async {
        loop {
            let frame = service.snapshot(id, false).unwrap();
            if frame[12] == state {
                return frame;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("session should reach expected state")
}

/// 完成真实 TCP/RFB 初始化、2×2 RGBA 更新和键盘传输；关闭句柄后服务端必须收到 EOF。
#[tokio::test]
async fn loopback_desktop_renders_pixels_sends_keys_and_closes_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (pixels_sent, pixels_ready) = tokio::sync::oneshot::channel();
    let (key_sent, key_ready) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        assert!(handshake(&mut stream, false, false).await);
        wait_for_refresh(&mut stream).await;
        stream.write_all(&[0, 0, 0, 1]).await.unwrap(); // FramebufferUpdate，一个 Raw 矩形。
        for value in [0, 0, 2, 2] {
            stream.write_u16(value).await.unwrap();
        }
        stream.write_u32(0).await.unwrap();
        stream.write_all(&[21, 22, 23, 0].repeat(4)).await.unwrap();
        pixels_sent.send(()).unwrap();
        loop {
            match stream.read_u8().await.unwrap() {
                3 => {
                    let mut rest = [0; 9];
                    stream.read_exact(&mut rest).await.unwrap();
                }
                4 => {
                    let mut rest = [0; 7];
                    stream.read_exact(&mut rest).await.unwrap();
                    assert_eq!(rest[0], 1);
                    assert_eq!(u32::from_be_bytes(rest[3..7].try_into().unwrap()), 97);
                    break;
                }
                other => panic!("unexpected message {other}"),
            }
        }
        key_sent.send(()).unwrap();
        let mut remaining = Vec::new();
        stream.read_to_end(&mut remaining).await.unwrap();
    });
    let service = VncService::default();
    service.open(request("desktop", port)).unwrap();
    timeout(TEST_TIMEOUT, pixels_ready).await.unwrap().unwrap();
    let frame = timeout(TEST_TIMEOUT, async {
        loop {
            let frame = service.snapshot("desktop", false).unwrap();
            // 初始尺寸事件会先产生黑色完整帧；只有目标像素到达才完成验收。
            if frame.get(FRAME_HEADER_BYTES) == Some(&21) {
                break frame;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(&frame[FRAME_HEADER_BYTES..], &[21, 22, 23, 255].repeat(4));
    service
        .send(
            "desktop",
            vec![VncInput::Key {
                key: 97,
                down: true,
            }],
        )
        .unwrap();
    timeout(TEST_TIMEOUT, key_ready).await.unwrap().unwrap();
    service.close("desktop").unwrap();
    service.close("desktop").unwrap();
    timeout(TEST_TIMEOUT, server).await.unwrap().unwrap();
    assert!(service.snapshot("desktop", false).is_err());
}

/// 服务端同时提供无认证和密码时必须选择密码；拒绝结果使会话进入错误而不发送 ClientInit。
#[tokio::test]
async fn password_authentication_never_downgrades_and_rejection_is_visible() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        assert!(!handshake(&mut stream, true, true).await);
        let mut rest = Vec::new();
        stream.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
    });
    let service = VncService::default();
    let mut config = request("denied", port);
    config.auth_type = "password".into();
    config.password = Some("secret".into());
    service.open(config).unwrap();
    let frame = wait_state(&service, "denied", 3).await;
    assert!(String::from_utf8_lossy(&frame[FRAME_HEADER_BYTES..]).contains("denied"));
    service.close("denied").unwrap();
    timeout(TEST_TIMEOUT, server).await.unwrap().unwrap();
}

/// 真实密码握手成功后仍由 Rust 拒绝只读会话的键鼠输入，关闭后 socket 收到 EOF。
#[tokio::test]
async fn password_authentication_succeeds_and_readonly_remains_enforced() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        assert!(handshake(&mut stream, true, false).await);
        let mut remaining = Vec::new();
        stream.read_to_end(&mut remaining).await.unwrap();
    });
    let service = VncService::default();
    let mut config = request("password-readonly", port);
    config.auth_type = "password".into();
    config.password = Some("secret".into());
    config.read_only = true;
    service.open(config).unwrap();
    wait_state(&service, "password-readonly", 1).await;
    assert!(service
        .send(
            "password-readonly",
            vec![VncInput::Pointer {
                x: 0,
                y: 0,
                buttons: 1
            }]
        )
        .unwrap_err()
        .contains("只读"));
    service.close("password-readonly").unwrap();
    timeout(TEST_TIMEOUT, server).await.unwrap().unwrap();
}

/// 只提供无认证的服务器不能满足密码配置；握手拒绝后不得发送认证选择或 ClientInit。
#[tokio::test]
async fn password_policy_rejects_unauthenticated_servers_before_client_init() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        stream.write_all(b"RFB 003.008\n").await.unwrap();
        let mut banner = [0; 12];
        stream.read_exact(&mut banner).await.unwrap();
        stream.write_all(&[1, 1]).await.unwrap();
        let mut remaining = Vec::new();
        stream.read_to_end(&mut remaining).await.unwrap();
        assert!(remaining.is_empty());
    });
    let service = VncService::default();
    let mut config = request("no-downgrade", port);
    config.auth_type = "password".into();
    config.password = Some("secret".into());
    service.open(config).unwrap();
    let frame = wait_state(&service, "no-downgrade", 3).await;
    assert!(String::from_utf8_lossy(&frame[FRAME_HEADER_BYTES..]).contains("认证"));
    service.close("no-downgrade").unwrap();
    timeout(TEST_TIMEOUT, server).await.unwrap().unwrap();
}

/// 只读配置在 Rust 层拒绝输入；连接中的会话可取消，重复 ID 和第五个会话被拒绝。
#[tokio::test]
async fn readonly_and_session_limits_are_enforced_and_pending_handshake_can_be_cancelled() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (accepted, ready) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        accepted.send(()).unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.unwrap();
        assert!(bytes.is_empty());
    });
    let service = VncService::default();
    let mut config = request("readonly", port);
    config.read_only = true;
    service.open(config).unwrap();
    timeout(TEST_TIMEOUT, ready).await.unwrap().unwrap();
    assert!(service
        .send(
            "readonly",
            vec![VncInput::Key {
                key: 97,
                down: true
            }]
        )
        .unwrap_err()
        .contains("只读"));
    assert!(service.open(request("readonly", port)).is_err());
    for id in ["second", "third", "fourth"] {
        service.open(request(id, port)).unwrap();
    }
    assert!(service.open(request("fifth", port)).is_err());
    // 确认 TCP 已接受，再移除句柄；EOF 应由取消握手触发，不依赖连接超时。
    for id in ["readonly", "second", "third", "fourth"] {
        service.close(id).unwrap();
    }
    timeout(TEST_TIMEOUT, server).await.unwrap().unwrap();
}
