//! VNC 的独立测试：边界、像素复制、真实 loopback RFB 握手、输入及取消释放。

use crate::{
    credential_store::CredentialStore,
    vnc::{validate_password, VncInput, VncOpenRequest, VncService},
    vnc_frame::{VncFrame, FRAME_HEADER_BYTES},
};
use aes::{
    cipher::{BlockCipherDecrypt, KeyInit},
    Aes128,
};
use num_bigint::BigUint;
use std::time::Duration;
use std::{
    future::{poll_fn, Future},
    sync::Arc,
    task::Poll,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::{sleep, timeout},
};
use vnc::Rect;

/// RFC 2409 的公开 1024 位 DH 测试组；仅用于独立假服务器。
const APPLE_TEST_MODULUS: &str = concat!(
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E08",
    "8A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B",
    "302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9",
    "A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE6",
    "49286651ECE65381FFFFFFFFFFFFFFFF"
);

/// 将假服务器数值补到 Apple 公钥的 128 字节线上宽度。
///
/// # 参数
/// - `number`：测试组中不超过 1024 位的公开数或假服务器共享值。
fn apple_test_bytes(number: &BigUint) -> Vec<u8> {
    let bytes = number.to_bytes_be();
    let mut result = vec![0; 128 - bytes.len()];
    result.extend_from_slice(&bytes);
    result
}

/// 假服务器使用独立大整数 DH 运算解密真实客户端响应，核对长密码和用户名的字节布局。
///
/// # 参数
/// - `stream`：loopback 假服务器的唯一连接，不访问真实服务器或凭据。
/// - `reject`：true 返回认证拒绝并断言客户端不再发送 ClientInit。
async fn apple_handshake(stream: &mut TcpStream, reject: bool) {
    stream.write_all(b"RFB 003.889\n").await.unwrap();
    let mut banner = [0; 12];
    stream.read_exact(&mut banner).await.unwrap();
    assert_eq!(&banner, b"RFB 003.008\n");
    stream.write_all(&[3, 1, 2, 30]).await.unwrap();
    assert_eq!(stream.read_u8().await.unwrap(), 30);
    let modulus = BigUint::parse_bytes(APPLE_TEST_MODULUS.as_bytes(), 16).unwrap();
    let exponent = BigUint::from(7u8);
    let public = BigUint::from(2u8).modpow(&exponent, &modulus);
    stream.write_u16(2).await.unwrap();
    stream.write_u16(128).await.unwrap();
    stream.write_all(&apple_test_bytes(&modulus)).await.unwrap();
    stream.write_all(&apple_test_bytes(&public)).await.unwrap();
    let mut encrypted = [0; 128];
    let mut client_public = [0; 128];
    stream.read_exact(&mut encrypted).await.unwrap();
    stream.read_exact(&mut client_public).await.unwrap();
    let shared = BigUint::from_bytes_be(&client_public).modpow(&exponent, &modulus);
    let key = md5::compute(apple_test_bytes(&shared));
    let cipher = Aes128::new_from_slice(&key.0).unwrap();
    for block in encrypted.as_chunks_mut::<16>().0 {
        cipher.decrypt_block(block.into());
    }
    assert_eq!(&encrypted[..7], b"viewer\0");
    assert_eq!(&encrypted[64..81], b"abcdefghijklmno.\0");
    if reject {
        stream.write_u32(1).await.unwrap();
        stream.write_u32(6).await.unwrap();
        stream.write_all(b"denied").await.unwrap();
        let mut rest = Vec::new();
        stream.read_to_end(&mut rest).await.unwrap();
        assert!(
            rest.is_empty(),
            "rejection must not trigger fallback or ClientInit"
        );
        return;
    }
    stream.write_u32(0).await.unwrap();
    // 认证后唯一的客户端字节是共享 ClientInit；不能把合成的 None 选择发送到远端。
    assert_eq!(stream.read_u8().await.unwrap(), 1);
    stream.write_u16(2).await.unwrap();
    stream.write_u16(2).await.unwrap();
    stream
        .write_all(&[32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0])
        .await
        .unwrap();
    stream.write_u32(4).await.unwrap();
    stream.write_all(b"test").await.unwrap();
    let mut rest = Vec::new();
    stream.read_to_end(&mut rest).await.unwrap();
}

/// 完整经过 Apple 版本协商、DH/AES 账户认证和图像引擎初始化；拒绝不降级，关闭释放 socket。
#[tokio::test]
async fn apple_account_authentication_reaches_desktop_and_rejection_never_downgrades() {
    for reject in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // listener/reject 移交本次假服务器任务；任务由三秒测试超时及下方 join 收束。
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            apple_handshake(&mut stream, reject).await;
        });
        let service = VncService::default();
        let mut config = request("apple-account", port);
        config.auth_type = "apple".into();
        config.username = "viewer".into();
        config.password = Some("abcdefghijklmno.".into());
        service.open(config).unwrap();
        let frame = wait_state(&service, "apple-account", if reject { 3 } else { 1 }).await;
        if reject {
            assert!(String::from_utf8_lossy(&frame[FRAME_HEADER_BYTES..]).contains("denied"));
        }
        service.close("apple-account").unwrap();
        timeout(TEST_TIMEOUT, server).await.unwrap().unwrap();
    }
}

/// 校验 Apple 凭据的 UTF-8 字节边界、无效 DH 公钥及版本公告格式；所有错误在响应生成前返回。
#[test]
fn apple_validation_rejects_invalid_key_parameters_and_credential_boundaries() {
    use crate::{
        vnc_apple_auth::{response, validate_credential},
        vnc_transport::negotiate_version,
    };
    assert!(validate_credential(&"中".repeat(21)).is_ok());
    for invalid in [String::new(), "中".repeat(22), "a\0b".into(), "x\ny".into()] {
        assert!(validate_credential(&invalid).is_err());
    }
    let modulus =
        apple_test_bytes(&BigUint::parse_bytes(APPLE_TEST_MODULUS.as_bytes(), 16).unwrap());
    for peer in [
        vec![0; 128],
        apple_test_bytes(&BigUint::from(1u8)),
        modulus.clone(),
    ] {
        assert!(response(2, &modulus, &peer, "viewer", "secret").is_err());
    }
    assert!(response(1, &modulus, &modulus, "viewer", "secret").is_err());
    assert!(response(2, &[1; 127], &[2; 127], "viewer", "secret").is_err());
    assert!(response(2, &[1; 1025], &[2; 1025], "viewer", "secret").is_err());
    assert_eq!(
        negotiate_version(b"RFB 003.889\n").unwrap(),
        *b"RFB 003.008\n"
    );
    assert_eq!(
        negotiate_version(b"RFB 003.006\n").unwrap(),
        *b"RFB 003.003\n"
    );
    assert!(negotiate_version(b"RFB 004.008\n").is_err());
    assert!(negotiate_version(b"RFB 003.00x\n").is_err());
}

/// Apple 策略遇到只提供传统密码/无认证的服务器时，在发送凭据或 ClientInit 前关闭。
#[tokio::test]
async fn apple_policy_never_falls_back_to_legacy_password_or_no_authentication() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    // 假服务器只声明类型 1/2；收到任何后续字节都说明客户端错误降级。
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        stream.write_all(b"RFB 003.008\n").await.unwrap();
        let mut version = [0; 12];
        stream.read_exact(&mut version).await.unwrap();
        stream.write_all(&[2, 1, 2]).await.unwrap();
        let mut rest = Vec::new();
        stream.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
    });
    let service = VncService::default();
    let mut config = request("apple-required", port);
    config.auth_type = "apple".into();
    config.username = "viewer".into();
    config.password = Some("abcdefghijklmno.".into());
    service.open(config).unwrap();
    let frame = wait_state(&service, "apple-required", 3).await;
    assert!(String::from_utf8_lossy(&frame[FRAME_HEADER_BYTES..]).contains("不支持"));
    service.close("apple-required").unwrap();
    timeout(TEST_TIMEOUT, server).await.unwrap().unwrap();
}

/// RFB 3.3/3.8 的拒绝原因均有界读取；过长声明不等待载荷，控制字符不进入错误文本。
#[tokio::test]
async fn server_rejection_reasons_are_bounded_and_sanitized_for_legacy_and_modern_versions() {
    for (legacy, oversized) in [(true, false), (false, false), (false, true)] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // 假服务器仅发送拒绝头；超长长度后不发送载荷，以验证客户端不会等待无界读取。
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let version = if legacy {
                b"RFB 003.003\n"
            } else {
                b"RFB 003.008\n"
            };
            stream.write_all(version).await.unwrap();
            let mut response = [0; 12];
            stream.read_exact(&mut response).await.unwrap();
            if legacy {
                stream.write_u32(0).await.unwrap();
            } else {
                stream.write_u8(0).await.unwrap();
            }
            stream
                .write_u32(if oversized { 4097 } else { 7 })
                .await
                .unwrap();
            if !oversized {
                stream.write_all(b"de\nnied").await.unwrap();
            }
            let mut rest = Vec::new();
            stream.read_to_end(&mut rest).await.unwrap();
            assert!(rest.is_empty());
        });
        let service = VncService::default();
        service.open(request("rejected", port)).unwrap();
        let frame = wait_state(&service, "rejected", 3).await;
        let error = String::from_utf8_lossy(&frame[FRAME_HEADER_BYTES..]);
        assert!(error.contains(if oversized { "过长" } else { "denied" }));
        assert!(!error.contains('\n'));
        service.close("rejected").unwrap();
        timeout(TEST_TIMEOUT, server).await.unwrap().unwrap();
    }
}

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
        username: String::new(),
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

/// 校验客户端的编码优先级及首次完整刷新，消息不符或断开时使测试失败。
///
/// # 参数
/// - `stream`：假服务端独占的 socket，读取到首个完整刷新为止。
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
                // 图像编码顺序固定，扩展剪贴板仅用于协商 UTF-8 文本。
                let expected = [7, 16, 1, 0, -223, -224, 0xc0a1_e5ce_u32 as i32];
                assert_eq!(usize::from(count), expected.len());
                for encoding in expected {
                    assert_eq!(stream.read_i32().await.unwrap(), encoding);
                }
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

/// 读取真实快照直到预期状态；三秒超时使测试失败。
///
/// # 参数
/// - `service`：测试独占的会话注册表。
/// - `id`：刚注册的测试会话 ID。
/// - `state`：预期的二进制会话状态码。
async fn wait_state(service: &VncService, id: &str, state: u8) -> Vec<u8> {
    // service、id 和 state 借给限时任务，结果包含首次匹配状态的快照。
    timeout(TEST_TIMEOUT, async {
        loop {
            let frame = service.next_frame(id, false).await.unwrap();
            if frame[12] == state {
                return frame;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("session should reach expected state")
}

/// 回环桌面可绘制 2×2 像素。没有系统焦点时，粘贴只转发按键，关闭后服务端收到 EOF。
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
                    assert_eq!(
                        u32::from_be_bytes(rest[3..7].try_into().unwrap()),
                        u32::from(b'v')
                    );
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
            let frame = service.next_frame("desktop", false).await.unwrap();
            // 只有完整更新才携带像素；超时状态包由下一次请求继续等待。
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
            vec![VncInput::Paste {
                key: u32::from(b'v'),
            }],
        )
        .unwrap();
    timeout(TEST_TIMEOUT, key_ready).await.unwrap().unwrap();
    service.close("desktop").unwrap();
    service.close("desktop").unwrap();
    timeout(TEST_TIMEOUT, server).await.unwrap().unwrap();
    assert!(service.next_frame("desktop", false).await.is_err());
}

/// 验证真实扩展消息的通知、UTF-8/CRLF 解码和发送授权；所有剪贴板数据均为测试常量。
#[test]
fn extended_clipboard_requests_text_and_only_provides_locally_offered_content() {
    use vnc::{clipboard::Clipboard, X11Event};
    let mut clipboard = Clipboard::default();
    // CAPS 支持纯文本、Request、Peek、Notify 和 Provide，禁止主动直接发送内容。
    let caps = [0x1f, 0, 0, 1, 0, 0, 0, 0];
    let reply = clipboard.receive(&caps).unwrap().reply;
    assert!(matches!(reply, Some(X11Event::ExtendedClipboard(bytes)) if bytes == caps));
    let request = [0x02, 0, 0, 1];
    assert!(clipboard.receive(&request).unwrap().reply.is_none());
    let notify = [0x08, 0, 0, 1];
    let reply = clipboard.receive(&notify).unwrap().reply;
    assert!(matches!(reply, Some(X11Event::ExtendedClipboard(bytes)) if bytes == request));
    // TigerVNC 可用 zlib 同步刷新结束消息，夹具独立编码“你好\r\nVNC\0”。
    let provide = [
        0x10, 0, 0, 1, 120, 156, 98, 96, 96, 224, 121, 178, 119, 193, 211, 165, 123, 121, 185, 194,
        252, 156, 25, 0, 0, 0, 0, 255, 255,
    ];
    assert_eq!(
        clipboard.receive(&provide).unwrap().remote.as_deref(),
        Some("你好\nVNC")
    );
    assert!(clipboard.receive(&provide[..8]).is_err());
    assert!(
        matches!(clipboard.offer("本地\n剪贴板".into()).unwrap(), X11Event::ExtendedClipboard(bytes) if bytes == notify)
    );
    let Some(X11Event::ExtendedClipboard(packet)) = clipboard.receive(&request).unwrap().reply
    else {
        panic!("expected the explicitly offered text");
    };
    assert_eq!(
        clipboard.receive(&packet).unwrap().remote.as_deref(),
        Some("本地\n剪贴板")
    );
    assert!(clipboard.receive(&request).unwrap().reply.is_none());
}

/// 旧服务端使用 Latin-1，验证保真、换行归一化及超长或不支持字符的拒绝路径。
#[test]
fn legacy_clipboard_rejects_unrepresentable_text_and_normalizes_line_endings() {
    use vnc::{
        clipboard::{Clipboard, MAX_TEXT_BYTES},
        X11Event,
    };
    let mut clipboard = Clipboard::default();
    assert!(
        matches!(clipboard.offer("café\r\nVNC".into()).unwrap(), X11Event::CopyText(text) if text == "café\nVNC")
    );
    assert!(clipboard.offer("你好".into()).is_err());
    assert!(clipboard.offer("a\0b".into()).is_err());
    assert!(clipboard.offer("a".repeat(MAX_TEXT_BYTES + 1)).is_err());
    assert_eq!(
        clipboard
            .receive_legacy("é\r\n".into())
            .unwrap()
            .remote
            .as_deref(),
        Some("é\n")
    );
}

/// 用始终失焦的窗口替身验证会话切换和迟到的失焦通知，测试不会接触系统剪贴板。
#[tokio::test]
async fn clipboard_focus_replacement_keeps_the_new_session_isolated() {
    use crate::vnc_system_clipboard::SystemClipboard;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let bridge = Arc::new(SystemClipboard::default());
    let calls = Arc::new(AtomicUsize::new(0));
    // 若旧会话被错误地保留，查询即失败，且不会访问真实系统剪贴板。
    bridge
        .set_target(
            "previous",
            Some(Box::new(|| panic!("previous target must not be queried"))),
        )
        .unwrap();
    let observed = Arc::clone(&calls);
    // observed 归替身窗口所有；只统计新会话的查询，false 阻止原生访问。
    bridge
        .set_target(
            "current",
            Some(Box::new(move || {
                observed.fetch_add(1, Ordering::Relaxed);
                Ok(false)
            })),
        )
        .unwrap();
    bridge.set_target("previous", None).unwrap();
    assert!(bridge.read("previous").await.unwrap().is_none());
    assert!(bridge.read("current").await.unwrap().is_none());
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

/// 在真实回环会话中验证负长度扩展消息的协商和请求；无窗口焦点时不碰系统剪贴板。
#[tokio::test]
async fn loopback_clipboard_capabilities_and_notify_use_signed_lengths() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (complete, completed) = tokio::sync::oneshot::channel();
    // listener 与完成信号归假服务器所有；客户端最后关闭会话并等待 EOF。
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        assert!(handshake(&mut stream, false, false).await);
        wait_for_refresh(&mut stream).await;
        // ServerCutText: -8、文本能力及零主动发送限额。
        stream
            .write_all(&[3, 0, 0, 0, 255, 255, 255, 248, 0x1f, 0, 0, 1, 0, 0, 0, 0])
            .await
            .unwrap();
        let mut caps = [0; 16];
        stream.read_exact(&mut caps).await.unwrap();
        assert_eq!(
            caps,
            [6, 0, 0, 0, 255, 255, 255, 248, 0x1f, 0, 0, 1, 0, 0, 0, 0]
        );
        // -4 的 Notify 声明有纯文本；客户端回复 Request，随后仍正常处理画面。
        stream
            .write_all(&[3, 0, 0, 0, 255, 255, 255, 252, 0x08, 0, 0, 1])
            .await
            .unwrap();
        let mut request = [0; 12];
        stream.read_exact(&mut request).await.unwrap();
        assert_eq!(request, [6, 0, 0, 0, 255, 255, 255, 252, 0x02, 0, 0, 1]);
        stream
            .write_all(&[3, 0, 0, 0, 0, 0, 0, 1, 0xe9, 0, 0, 0, 0])
            .await
            .unwrap();
        let mut refresh = [0; 10];
        stream.read_exact(&mut refresh).await.unwrap();
        assert_eq!(refresh, [3, 1, 0, 0, 0, 0, 0, 2, 0, 2]);
        complete.send(()).unwrap();
        let mut remaining = Vec::new();
        stream.read_to_end(&mut remaining).await.unwrap();
        assert!(remaining.is_empty());
    });
    let service = VncService::default();
    service.open(request("clipboard-wire", port)).unwrap();
    timeout(TEST_TIMEOUT, completed).await.unwrap().unwrap();
    service.close("clipboard-wire").unwrap();
    timeout(TEST_TIMEOUT, server).await.unwrap().unwrap();
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

/// 在真实 1080p 缓冲的对角写两个像素；区域包只应传四十字节，完整恢复仍保留两处修改。
#[test]
fn sparse_regions_do_not_copy_the_unchanged_desktop() {
    let mut frame = VncFrame::default();
    frame.resize(1920, 1080).unwrap();
    frame.snapshot(false);
    for (x, y) in [(0, 0), (1919, 1079)] {
        frame
            .draw(
                Rect {
                    x,
                    y,
                    width: 1,
                    height: 1,
                },
                &[1, 2, 3, 0],
            )
            .unwrap();
    }
    let packet = frame.snapshot(false);
    assert_eq!(packet.len(), 40);
    assert_eq!(packet[13], 1);
    assert_eq!(u16::from_le_bytes(packet[14..16].try_into().unwrap()), 2);
    assert_eq!(&packet[24..28], &[1, 2, 3, 255]);
    assert_eq!(&packet[36..40], &[1, 2, 3, 255]);
    assert!(!frame.has_changes());
    let full = frame.snapshot(true);
    assert_eq!(full.len(), FRAME_HEADER_BYTES + 1920 * 1080 * 4);
    assert_eq!(
        &full[FRAME_HEADER_BYTES..FRAME_HEADER_BYTES + 4],
        &[1, 2, 3, 255]
    );
    assert_eq!(&full[full.len() - 4..], &[1, 2, 3, 255]);
}

/// 桥接区域必须递归合并旧边界；第六十五个分离区域触发有界合并，不漏掉已写入像素。
#[test]
fn dirty_regions_merge_transitively_and_bound_fragmentation() {
    let mut frame = VncFrame::default();
    frame.resize(256, 1).unwrap();
    frame.snapshot(false);
    for x in [0, 2, 1] {
        frame
            .draw(
                Rect {
                    x,
                    y: 0,
                    width: 1,
                    height: 1,
                },
                &[9, 0, 0, 0],
            )
            .unwrap();
    }
    let merged = frame.snapshot(false);
    assert_eq!(merged[13], 0);
    assert_eq!(u16::from_le_bytes(merged[8..10].try_into().unwrap()), 3);
    assert_eq!(merged.len(), FRAME_HEADER_BYTES + 3 * 4);
    for index in 0..65 {
        frame
            .draw(
                Rect {
                    x: index * 3,
                    y: 0,
                    width: 1,
                    height: 1,
                },
                &[7, 0, 0, 0],
            )
            .unwrap();
    }
    let bounded = frame.snapshot(false);
    assert_eq!(bounded[13], 0);
    assert_eq!(bounded.len(), FRAME_HEADER_BYTES + 193 * 4);
    for index in 0..65 {
        assert_eq!(bounded[FRAME_HEADER_BYTES + index * 3 * 4], 7);
    }
}

/// 假服务器按通知发送 Tight 和 Raw 更新；验证无损解码、LastRect、增量等待及关闭唤醒。
#[tokio::test]
async fn frame_wait_wakes_for_pixels_and_close_without_duplicate_full_requests() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (requested, request_ready) = tokio::sync::oneshot::channel();
    let (advance, advanced) = tokio::sync::oneshot::channel();
    // listener、requested、advanced 移交假服务器；测试末尾等待 socket 关闭与任务退出。
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        stream.set_nodelay(true).unwrap();
        assert!(handshake(&mut stream, false, false).await);
        wait_for_refresh(&mut stream).await;
        // 未预先计算矩形数量的更新以 LastRect 结束，Tight 载荷为 2×2 RGB 的 zlib 同步块。
        stream.write_all(&[0, 0, 255, 255]).await.unwrap();
        for value in [0, 0, 2, 2] {
            stream.write_u16(value).await.unwrap();
        }
        stream.write_i32(7).await.unwrap();
        stream
            .write_all(&[
                0, 20, 120, 156, 18, 21, 19, 151, 87, 80, 212, 212, 210, 54, 54, 49, 5, 0, 0, 0,
                255, 255,
            ])
            .await
            .unwrap();
        stream.write_u64(0).await.unwrap();
        stream.write_i32(-224).await.unwrap();
        assert_eq!(stream.read_u8().await.unwrap(), 3);
        let mut refresh = [0; 9];
        stream.read_exact(&mut refresh).await.unwrap();
        assert_eq!(
            refresh[0], 1,
            "the engine already requested the full initial frame"
        );
        requested.send(()).unwrap();
        advanced.await.unwrap();
        stream.write_all(&[0, 0, 0, 1]).await.unwrap();
        for value in [0, 0, 2, 2] {
            stream.write_u16(value).await.unwrap();
        }
        stream.write_u32(0).await.unwrap();
        stream.write_all(&[31, 32, 33, 0].repeat(4)).await.unwrap();
        let mut remaining = Vec::new();
        stream.read_to_end(&mut remaining).await.unwrap();
    });
    let service = Arc::new(VncService::default());
    service.open(request("wait-frames", port)).unwrap();
    timeout(TEST_TIMEOUT, request_ready).await.unwrap().unwrap();
    let first = timeout(TEST_TIMEOUT, service.next_frame("wait-frames", true))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        &first[FRAME_HEADER_BYTES..],
        &[21, 22, 23, 255, 31, 32, 33, 255, 41, 42, 43, 255, 51, 52, 53, 255]
    );

    // 远端不更新时，有限等待最终返回空区域快照，不挂起 IPC 或重复请求整屏。
    let idle = timeout(TEST_TIMEOUT, service.next_frame("wait-frames", false))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(idle.len(), FRAME_HEADER_BYTES);
    assert_eq!(idle[12], 1);

    let mut waiting = Box::pin(service.next_frame("wait-frames", false));
    let pending = poll_fn(|cx| Poll::Ready(waiting.as_mut().poll(cx))).await;
    assert!(
        pending.is_pending(),
        "unchanged desktops must wait instead of polling IPC"
    );
    // 取消一次在途等待后不改变桌面；新等待仍能接到下一次更新。
    drop(waiting);
    let mut waiting = Box::pin(service.next_frame("wait-frames", false));
    let pending = poll_fn(|cx| Poll::Ready(waiting.as_mut().poll(cx))).await;
    assert!(pending.is_pending());
    advance.send(()).unwrap();
    let next = timeout(TEST_TIMEOUT, waiting).await.unwrap().unwrap();
    assert_eq!(next[FRAME_HEADER_BYTES], 31);

    let mut closing = Box::pin(service.next_frame("wait-frames", false));
    assert!(poll_fn(|cx| Poll::Ready(closing.as_mut().poll(cx)))
        .await
        .is_pending());
    service.close("wait-frames").unwrap();
    let closed = timeout(TEST_TIMEOUT, closing).await.unwrap().unwrap();
    assert_eq!(closed[12], 2);
    timeout(TEST_TIMEOUT, server).await.unwrap().unwrap();
}

/// 模拟一个更新分四块送达。首块前预取下一批，前三块保持不可见，空更新仍继续请求。
#[tokio::test]
async fn fragmented_update_prefetches_on_header_and_publishes_only_once_complete() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (partial_sent, partial_ready) = tokio::sync::oneshot::channel();
    let (finish, finish_ready) = tokio::sync::oneshot::channel();
    let (empty_followed, empty_ready) = tokio::sync::oneshot::channel();
    // listener 和三个同步通道移交服务端；客户端释放末块后等到 EOF 收束任务。
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        stream.set_nodelay(true).unwrap();
        assert!(handshake(&mut stream, false, false).await);
        wait_for_refresh(&mut stream).await;
        // 一批共四个 Raw 像素；收到下一批请求之前只发送更新头。
        stream.write_all(&[0, 0, 0, 4]).await.unwrap();
        let mut packet = [0; 10];
        stream.read_exact(&mut packet).await.unwrap();
        assert_eq!(packet, [3, 1, 0, 0, 0, 0, 0, 2, 0, 2]);
        let rectangles = [
            [0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0],
            [0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0],
            [0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 3, 0, 0, 0],
            [0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 4, 0, 0, 0],
        ];
        for rectangle in &rectangles[..3] {
            stream.write_all(rectangle).await.unwrap();
        }
        partial_sent.send(()).unwrap();
        // 末块被挡住期间，键盘应及时通过，前面的矩形不能产生额外刷新。
        let mut key = [0; 8];
        stream.read_exact(&mut key).await.unwrap();
        assert_eq!(key, [4, 1, 0, 0, 0, 0, 0, 97]);
        finish_ready.await.unwrap();
        stream.write_all(&rectangles[3]).await.unwrap();
        // 紧跟下一批空更新，先前等待的快照仍应可取，空更新也必须继续流水线。
        stream.write_all(&[0, 0, 0, 0]).await.unwrap();
        stream.read_exact(&mut packet).await.unwrap();
        assert_eq!(packet, [3, 1, 0, 0, 0, 0, 0, 2, 0, 2]);
        empty_followed.send(()).unwrap();
        let mut remaining = Vec::new();
        stream.read_to_end(&mut remaining).await.unwrap();
        assert!(remaining.is_empty());
    });
    let service = VncService::default();
    service.open(request("fragmented", port)).unwrap();
    timeout(TEST_TIMEOUT, partial_ready).await.unwrap().unwrap();
    let status = service.next_frame("fragmented", true).await.unwrap();
    assert_eq!(status.len(), FRAME_HEADER_BYTES);
    assert_eq!(&status[..4], &[0; 4]);
    assert_eq!(status[12], 1);
    service
        .send(
            "fragmented",
            vec![VncInput::Key {
                key: 97,
                down: true,
            }],
        )
        .unwrap();
    let mut waiting = Box::pin(service.next_frame("fragmented", false));
    // cx 仅轮询一次以登记等待者，服务端此时还不能发送末块。
    assert!(poll_fn(|cx| Poll::Ready(waiting.as_mut().poll(cx)))
        .await
        .is_pending());
    assert!(service.next_frame("fragmented", true).await.is_err());
    finish.send(()).unwrap();
    // 先等到服务端确认下一批请求已发出，再消费已经提交的快照。
    timeout(TEST_TIMEOUT, empty_ready).await.unwrap().unwrap();
    let frame = timeout(TEST_TIMEOUT, waiting).await.unwrap().unwrap();
    assert_eq!(&frame[..4], &[2, 0, 2, 0]);
    assert_eq!(
        &frame[FRAME_HEADER_BYTES..],
        &[1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255]
    );
    let idle = service.next_frame("fragmented", false).await.unwrap();
    assert_eq!(idle.len(), FRAME_HEADER_BYTES);
    service.close("fragmented").unwrap();
    timeout(TEST_TIMEOUT, server).await.unwrap().unwrap();
}

/// 假服务器只回复尺寸变更，断言客户端用新尺寸请求完整像素，不因没有收到 Raw 区域而停住。
#[tokio::test]
async fn resize_only_update_requests_full_pixels_at_the_new_size() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (requested, request_ready) = tokio::sync::oneshot::channel();
    // listener、requested 移交假服务器；测试确认收到刷新后关闭会话并等待 socket EOF。
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        assert!(handshake(&mut stream, false, false).await);
        wait_for_refresh(&mut stream).await;
        stream.write_all(&[0, 0, 0, 1]).await.unwrap();
        let mut request = [0; 10];
        stream.read_exact(&mut request).await.unwrap();
        assert_eq!(request, [3, 1, 0, 0, 0, 0, 0, 2, 0, 2]);
        // 单矩形更新只携带 3×2 尺寸和 DesktopSize 编码（-223），没有像素载荷。
        stream
            .write_all(&[0, 0, 0, 0, 0, 3, 0, 2, 255, 255, 255, 33])
            .await
            .unwrap();
        stream.read_exact(&mut request).await.unwrap();
        assert_eq!(request, [3, 0, 0, 0, 0, 0, 0, 3, 0, 2]);
        requested.send(()).unwrap();
        let mut remaining = Vec::new();
        stream.read_to_end(&mut remaining).await.unwrap();
        assert!(remaining.is_empty());
    });
    let service = VncService::default();
    service.open(request("resize-only", port)).unwrap();
    // 以真实取帧唤醒为同步点；忽略握手时的初始 2×2 缓冲。
    timeout(TEST_TIMEOUT, async {
        loop {
            let frame = service.next_frame("resize-only", false).await.unwrap();
            assert!(frame[12] < 2);
            if frame[..4] == [3, 0, 2, 0] {
                break;
            }
        }
    })
    .await
    .unwrap();
    // 测试先确认服务端收到请求，再关闭，避免取消尚未发送的刷新。
    timeout(TEST_TIMEOUT, request_ready).await.unwrap().unwrap();
    service.close("resize-only").unwrap();
    timeout(TEST_TIMEOUT, server).await.unwrap().unwrap();
}
