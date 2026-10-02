//! SSH 高级配置、SOCKS 协议与本机 SSH 服务的端到端测试；不访问用户主机或凭据。

use crate::{
    ssh_auth,
    ssh_config::{self, ForwardKind, ForwardRule, SshAuthType, SshHopConfig},
    ssh_forward::{self, ForwardRuntime, RemoteForwardAcceptor},
};
use russh::{
    client,
    keys::{ssh_key::private::Ed25519Keypair, PrivateKey, PublicKeyOrCertificate},
    server,
};
use std::{future::Future, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, Semaphore},
    task::JoinSet,
    time::timeout,
};

/// 每个本机网络测试最大等待 10 秒，防止失败时挂起验证。
const TEST_TIMEOUT: Duration = Duration::from_secs(10);
/// 确定性测试密钥种子，仅用于隔离的本机测试服务。
const TEST_KEY_SEED: [u8; 32] = [17; 32];
/// 测试读写负载，用于检测字节丢失和半关闭。
const PAYLOAD: &[u8] = b"rivet-forward\x00\xff";

/// 在独立 Tokio 运行时中执行限时测试；panic 仅用于测试断言。
fn run_test(future: impl Future<Output = ()>) {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            timeout(TEST_TIMEOUT, future)
                .await
                .expect("network test timed out");
        });
}

/// 创建不依赖用户文件的测试 SSH 密钥。
fn test_key() -> PrivateKey {
    Ed25519Keypair::from_seed(&TEST_KEY_SEED).into()
}

/// 创建合法的回环规则；监听端口由测试用 OS 临时端口取得。
fn rule(kind: ForwardKind, bind_port: u16, target_port: u16) -> ForwardRule {
    ForwardRule {
        id: format!("{kind:?}"),
        kind,
        bind_address: "127.0.0.1".into(),
        bind_port,
        target_host: if kind == ForwardKind::Dynamic {
            String::new()
        } else {
            "127.0.0.1".into()
        },
        target_port: if kind == ForwardKind::Dynamic {
            0
        } else {
            target_port
        },
    }
}

/// 独立本机 SSH 服务；任务组拥有转发 socket，并随服务释放取消。
#[derive(Default)]
struct TestServer {
    /// 当前键盘交互轮次，验证两轮及多字段顺序。
    auth_round: usize,
    /// 测试服务建立的监听与桥接任务。
    tasks: JoinSet<()>,
}

impl server::Handler for TestServer {
    type Error = russh::Error;
    /// 固定密码服务；interactive 只声明交互协议，password-only 禁止验证码交互。
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        if user == "interactive" {
            return Ok(server::Auth::Reject {
                proceed_with_methods: Some(
                    [russh::MethodKind::KeyboardInteractive].as_slice().into(),
                ),
                partial_success: false,
            });
        }
        if user == "password-only" && password != "test-password" {
            return Ok(server::Auth::Reject {
                proceed_with_methods: Some([russh::MethodKind::Password].as_slice().into()),
                partial_success: false,
            });
        }
        Ok(
            if matches!(user, "test" | "mfa" | "password-only") && password == "test-password" {
                if user == "mfa" {
                    server::Auth::Reject {
                        proceed_with_methods: Some(
                            [russh::MethodKind::KeyboardInteractive].as_slice().into(),
                        ),
                        partial_success: true,
                    }
                } else {
                    server::Auth::Accept
                }
            } else {
                server::Auth::reject()
            },
        )
    }
    /// 只接受隔离测试 Agent 的公钥，签名由 SSH 协议层校验。
    async fn auth_publickey(
        &mut self,
        user: &str,
        key: &russh::keys::PublicKey,
    ) -> Result<server::Auth, Self::Error> {
        Ok(
            if matches!(user, "test" | "mfa") && key == test_key().public_key() {
                if user == "mfa" {
                    server::Auth::Reject {
                        proceed_with_methods: Some(
                            [russh::MethodKind::KeyboardInteractive].as_slice().into(),
                        ),
                        partial_success: true,
                    }
                } else {
                    server::Auth::Accept
                }
            } else {
                server::Auth::reject()
            },
        )
    }
    /// 提供两轮、多字段及 echo 标志；任何错误响应均拒绝。
    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        user: &str,
        _submethods: &str,
        response: Option<server::Response<'a>>,
    ) -> Result<server::Auth, Self::Error> {
        if !matches!(user, "test" | "mfa" | "interactive") {
            return Ok(server::Auth::reject());
        }
        if let Some(response) = response {
            let values = response.map(|bytes| bytes.to_vec()).collect::<Vec<_>>();
            let expected = if self.auth_round == 1 {
                vec![b"test-password".to_vec(), b"visible".to_vec()]
            } else {
                vec![b"123456".to_vec()]
            };
            if values != expected {
                return Ok(server::Auth::reject());
            }
            if self.auth_round == 2 {
                return Ok(server::Auth::Accept);
            }
        }
        self.auth_round += 1;
        let prompts = if self.auth_round == 1 {
            vec![("Password".into(), false), ("Label".into(), true)]
        } else {
            vec![("OTP".into(), false)]
        };
        Ok(server::Auth::Partial {
            name: "Test authentication".into(),
            instructions: "Two rounds".into(),
            prompts: prompts.into(),
        })
    }
    /// 仅桥接回环 TCP 目标；端口 1 用于稳定模拟服务端拒绝。
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: russh::Channel<server::Msg>,
        host: &str,
        port: u32,
        _origin: &str,
        _origin_port: u32,
        reply: server::ChannelOpenHandle,
        _session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if host != "127.0.0.1" || port == 1 {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        let mut socket = TcpStream::connect((host, port as u16)).await?;
        reply.accept().await;
        self.tasks.spawn(async move {
            let mut stream = channel.into_stream();
            tokio::io::copy_bidirectional(&mut socket, &mut stream)
                .await
                .unwrap();
        });
        Ok(())
    }
    /// 申请远程回环监听，收到连接时创建 forwarded-tcpip 通道。
    async fn tcpip_forward(
        &mut self,
        address: &str,
        port: &mut u32,
        session: &mut server::Session,
    ) -> Result<bool, Self::Error> {
        if address != "127.0.0.1" {
            return Ok(false);
        }
        let listener = TcpListener::bind((address, *port as u16)).await?;
        let port = *port;
        let handle = session.handle();
        self.tasks.spawn(async move {
            let mut bridges = JoinSet::new();
            loop {
                tokio::select! {
                    result = bridges.join_next(), if !bridges.is_empty() => { result.unwrap().unwrap(); }
                    accepted = listener.accept() => {
                        let (mut socket, origin) = accepted.unwrap();
                        let handle = handle.clone();
                        bridges.spawn(async move {
                            let channel = handle.channel_open_forwarded_tcpip("127.0.0.1", port, origin.ip().to_string(), u32::from(origin.port())).await.unwrap();
                            let mut stream = channel.into_stream();
                            tokio::io::copy_bidirectional(&mut socket, &mut stream).await.unwrap();
                        });
                    }
                }
            }
        });
        Ok(true)
    }
}

/// 测试客户端仅信任固定测试密钥，复用生产远程转发白名单处理器。
struct TestClient {
    /// 生产转发入口，测试通过真实协议调用。
    remote: RemoteForwardAcceptor,
}

impl client::Handler for TestClient {
    type Error = russh::Error;
    /// 固定测试主机密钥校验，不读写用户 known_hosts。
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(key.public_key() == *test_key().public_key())
    }
    /// 转交生产远程规则校验和配额限制。
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        address: &str,
        port: u32,
        _origin: &str,
        _origin_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        self.remote.accept(channel, address, port, reply).await;
        Ok(())
    }
}

/// 绑定临时回环端口并启动仅接受一个连接的 SSH 测试服务。
async fn start_server() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = Arc::new(server::Config {
        keys: vec![test_key()],
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let task = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        // 认证拒绝或取消后关闭 transport，EOF 与 TCP reset 均属于预期清理状态。
        match server::run_stream(config, socket, TestServer::default())
            .await
            .unwrap()
            .await
        {
            Ok(()) => {}
            Err(russh::Error::IO(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset
                ) => {}
            Err(error) => panic!("SSH test server failed: {error}"),
        }
    });
    (port, task)
}

/// 返回一个暂时可用的回环端口；测试不使用固定端口或用户服务。
async fn unused_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// 创建测试客户端，远程规则和连接配额全部由用例拥有。
async fn connect(
    port: u16,
    rules: Vec<ForwardRule>,
    sender: mpsc::Sender<ssh_forward::RemoteForward>,
    permits: Arc<Semaphore>,
) -> client::Handle<TestClient> {
    client::connect(
        Arc::new(client::Config::default()),
        ("127.0.0.1", port),
        TestClient {
            remote: RemoteForwardAcceptor {
                rules,
                sender,
                permits,
            },
        },
    )
    .await
    .unwrap()
}

/// 单次回环 echo 服务；先读取 EOF 再回复，以验证 TCP 半关闭不会截断响应。
async fn echo_server() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut data = Vec::new();
        socket.read_to_end(&mut data).await.unwrap();
        socket.write_all(&data).await.unwrap();
        socket.shutdown().await.unwrap();
    });
    (port, task)
}

/// 发送二进制数据后半关闭写端，必须完整读回 echo。
async fn assert_echo(socket: &mut (impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin)) {
    socket.write_all(PAYLOAD).await.unwrap();
    socket.shutdown().await.unwrap();
    let mut output = Vec::new();
    socket.read_to_end(&mut output).await.unwrap();
    assert_eq!(output, PAYLOAD);
}

/// 真实 SSH 协议中本地、远程和 SOCKS5 均转发二进制及半关闭；shutdown 释放本机端口。
#[test]
fn forwards_local_remote_and_dynamic_streams_and_releases_listeners() {
    run_test(async {
        for kind in [
            ForwardKind::Local,
            ForwardKind::Remote,
            ForwardKind::Dynamic,
        ] {
            let (target_port, echo) = echo_server().await;
            let bind_port = unused_port().await;
            let rules = vec![rule(kind, bind_port, target_port)];
            let (sender, receiver) = mpsc::channel(4);
            let permits = Arc::new(Semaphore::new(4));
            let (ssh_port, server) = start_server().await;
            let mut client = connect(ssh_port, rules.clone(), sender, permits.clone()).await;
            assert!(client
                .authenticate_password("test", "test-password")
                .await
                .unwrap()
                .success());
            let client = Arc::new(client);
            let mut runtime = ForwardRuntime::start(client.clone(), &rules, receiver, permits)
                .await
                .unwrap();
            let mut socket = TcpStream::connect(("127.0.0.1", bind_port)).await.unwrap();
            if kind == ForwardKind::Dynamic {
                socket.write_all(&[5, 1, 0]).await.unwrap();
                let mut response = [0u8; 2];
                socket.read_exact(&mut response).await.unwrap();
                assert_eq!(response, [5, 0]);
                let mut request = vec![5, 1, 0, 1, 127, 0, 0, 1];
                request.extend_from_slice(&target_port.to_be_bytes());
                socket.write_all(&request).await.unwrap();
                let mut response = [0u8; 10];
                socket.read_exact(&mut response).await.unwrap();
                assert_eq!(response[1], 0);
            }
            assert_echo(&mut socket).await;
            echo.await.unwrap();
            runtime.shutdown().await;
            client
                .disconnect(russh::Disconnect::ByApplication, "", "English")
                .await
                .unwrap();
            // 未完成认证时同时释放控制通道，使服务端结束等待认证响应。
            drop(client);
            server.await.unwrap();
            assert!(TcpListener::bind(("127.0.0.1", bind_port)).await.is_ok());
        }
    });
}

/// 后续监听失败必须回滚已创建 socket；SSH 拒绝目标时 SOCKS 回复失败且终端 transport 保持可用。
#[test]
fn forwarding_failure_rolls_back_listeners_and_socks_reports_channel_rejection() {
    run_test(async {
        let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let occupied_port = occupied.local_addr().unwrap().port();
        let free_port = unused_port().await;
        let mut blocked = rule(ForwardKind::Local, occupied_port, 1);
        blocked.id = "blocked".into();
        let rollback = vec![rule(ForwardKind::Local, free_port, 1), blocked];
        let (sender, receiver) = mpsc::channel(4);
        let permits = Arc::new(Semaphore::new(4));
        let (ssh_port, server) = start_server().await;
        let mut client = connect(ssh_port, Vec::new(), sender, permits.clone()).await;
        assert!(client
            .authenticate_password("test", "test-password")
            .await
            .unwrap()
            .success());
        let client = Arc::new(client);
        assert!(
            ForwardRuntime::start(client.clone(), &rollback, receiver, permits.clone())
                .await
                .is_err()
        );
        let reclaimed = TcpListener::bind(("127.0.0.1", free_port)).await.unwrap();
        drop(reclaimed);
        let dynamic = vec![rule(ForwardKind::Dynamic, free_port, 0)];
        let (_sender, receiver) = mpsc::channel(4);
        let mut runtime = ForwardRuntime::start(client.clone(), &dynamic, receiver, permits)
            .await
            .unwrap();
        let mut socket = TcpStream::connect(("127.0.0.1", free_port)).await.unwrap();
        socket.write_all(&[5, 1, 0]).await.unwrap();
        let mut method = [0u8; 2];
        socket.read_exact(&mut method).await.unwrap();
        assert_eq!(method, [5, 0]);
        // 测试服务固定拒绝端口 1，不依赖真实网络目标是否在线。
        socket
            .write_all(&[5, 1, 0, 1, 127, 0, 0, 1, 0, 1])
            .await
            .unwrap();
        let mut reply = [0u8; 10];
        socket.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply[1], 1);
        assert!(runtime.errors.recv().await.unwrap().contains("拒绝"));
        assert!(!client.is_closed());
        runtime.shutdown().await;
        client
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await
            .unwrap();
        server.await.unwrap();
        drop(client);
    });
}

/// 目标 SSH 再通过跳板 direct-tcpip 完成独立握手及认证，数据可以贯通两层加密链。
#[test]
fn nested_ssh_transport_authenticates_and_forwards_through_jump_host() {
    run_test(async {
        let (jump_port, jump_server) = start_server().await;
        let (target_port, target_server) = start_server().await;
        let (sender, _) = mpsc::channel(4);
        let mut jump = connect(
            jump_port,
            Vec::new(),
            sender.clone(),
            Arc::new(Semaphore::new(4)),
        )
        .await;
        assert!(jump
            .authenticate_password("test", "test-password")
            .await
            .unwrap()
            .success());
        let tunnel = jump
            .channel_open_direct_tcpip("127.0.0.1", u32::from(target_port), "127.0.0.1", 0)
            .await
            .unwrap();
        let mut target = client::connect_stream(
            Arc::new(client::Config::default()),
            tunnel.into_stream(),
            TestClient {
                remote: RemoteForwardAcceptor {
                    rules: Vec::new(),
                    sender,
                    permits: Arc::new(Semaphore::new(4)),
                },
            },
        )
        .await
        .unwrap();
        assert!(target
            .authenticate_password("test", "test-password")
            .await
            .unwrap()
            .success());
        let (echo_port, echo) = echo_server().await;
        let channel = target
            .channel_open_direct_tcpip("127.0.0.1", u32::from(echo_port), "127.0.0.1", 0)
            .await
            .unwrap();
        assert_echo(&mut channel.into_stream()).await;
        echo.await.unwrap();
        target
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await
            .unwrap();
        drop(target);
        target_server.await.unwrap();
        jump.disconnect(russh::Disconnect::ByApplication, "", "English")
            .await
            .unwrap();
        drop(jump);
        jump_server.await.unwrap();
    });
}

/// 密码方式自动协商服务器的两轮交互；错误验证码和 UI 取消必须失败。
#[test]
fn password_authentication_automatically_handles_verification_rejection_and_cancellation() {
    run_test(async {
        for behavior in ["success", "reject", "cancel"] {
            let (port, server) = start_server().await;
            let (sender, _) = mpsc::channel(4);
            let mut client = connect(port, Vec::new(), sender, Arc::new(Semaphore::new(4))).await;
            let hop = SshHopConfig {
                host: "127.0.0.1".into(),
                port,
                username: "interactive".into(),
                auth_type: SshAuthType::Password,
                password: Some("test-password".into()),
                key_path: None,
                key_passphrase: None,
            };
            let mut rounds = 0;
            let result = ssh_auth::authenticate_with_prompts(
                &mut client,
                &hop,
                |name, instructions, prompts| {
                    assert_eq!(name, "Test authentication");
                    assert_eq!(instructions, "Two rounds");
                    rounds += 1;
                    let values = if behavior == "cancel" {
                        Err("cancelled".into())
                    } else if behavior == "reject" {
                        Ok(vec!["wrong".into(); prompts.len()])
                    } else if rounds == 1 {
                        assert!(!prompts[0].echo);
                        assert!(prompts[1].echo);
                        Ok(vec!["test-password".into(), "visible".into()])
                    } else {
                        Ok(vec!["123456".into()])
                    };
                    std::future::ready(values)
                },
            )
            .await;
            assert_eq!(result.is_ok(), behavior == "success");
            assert_eq!(rounds, if behavior == "success" { 2 } else { 1 });
            client
                .disconnect(russh::Disconnect::ByApplication, "", "English")
                .await
                .unwrap();
            // 未完成认证时同时释放控制通道，使服务端结束等待认证响应。
            drop(client);
            server.await.unwrap();
        }
    });
}

/// 普通密码成功时直接完成；服务端未声明交互协议且密码错误时拒绝，不显示验证码提示。
#[test]
fn password_authentication_without_interactive_method_never_requests_verification() {
    run_test(async {
        for password in ["test-password", "wrong"] {
            let (port, server) = start_server().await;
            let (sender, _) = mpsc::channel(4);
            let mut client = connect(port, Vec::new(), sender, Arc::new(Semaphore::new(4))).await;
            let hop = SshHopConfig {
                host: "127.0.0.1".into(),
                port,
                username: "password-only".into(),
                auth_type: SshAuthType::Password,
                password: Some(password.into()),
                key_path: None,
                key_passphrase: None,
            };
            let mut prompts = 0;
            let result = ssh_auth::authenticate_with_prompts(&mut client, &hop, |_, _, _| {
                // 普通密码结果不应访问 UI；任何提示均使测试失败。
                prompts += 1;
                std::future::ready(Err("unexpected verification".into()))
            })
            .await;
            assert_eq!(result.is_ok(), password == "test-password");
            assert_eq!(prompts, 0);
            client
                .disconnect(russh::Disconnect::ByApplication, "", "English")
                .await
                .unwrap();
            drop(client);
            server.await.unwrap();
        }
    });
}

/// 非法固定端口、动态目标、控制字符、重复监听与响应数量超限均被拒绝。
#[test]
fn rejects_invalid_forwarding_and_authentication_inputs() {
    // 已移除的显式交互类型不能进入后端配置，也不执行兼容转换。
    assert!(serde_json::from_str::<SshAuthType>(r#""keyboardInteractive""#).is_err());
    let local = rule(ForwardKind::Local, 8080, 80);
    assert!(ssh_config::validate_forwards(std::slice::from_ref(&local)).is_ok());
    let dynamic = rule(ForwardKind::Dynamic, 8080, 0);
    assert!(ssh_config::validate_forwards(&[local.clone(), dynamic]).is_err());
    let mut invalid = local;
    invalid.bind_port = 0;
    assert!(ssh_config::validate_forwards(&[invalid]).is_err());
    assert!(ssh_config::validate_host("bad\naddress").is_err());
    assert!(ssh_auth::validate_responses(2, &["one".into()]).is_err());
    assert!(ssh_auth::validate_responses(1, &["x".repeat(4097)]).is_err());
    assert!(ssh_auth::validate_responses(1, &["valid".into()]).is_ok());
}

/// 隔离 Agent 响应身份与签名请求；支持空身份和拒签失败路径，私钥只在该任务内。
async fn mock_agent(mut stream: tokio::io::DuplexStream, behavior: &'static str) -> usize {
    use russh::keys::{
        signature::Signer,
        ssh_encoding::{Decode, Encode},
    };
    let key = test_key();
    let mut signatures = 0;
    loop {
        let length = match stream.read_u32().await {
            Ok(length) => length,
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return signatures,
            Err(error) => panic!("agent frame read failed: {error}"),
        };
        assert!(length <= 65536);
        let mut frame = vec![0u8; length as usize];
        stream.read_exact(&mut frame).await.unwrap();
        let mut response = match frame[0] {
            11 => {
                let mut response = vec![12];
                if behavior == "empty" {
                    0u32.encode(&mut response).unwrap();
                } else {
                    1u32.encode(&mut response).unwrap();
                    key.public_key()
                        .to_bytes()
                        .unwrap()
                        .encode(&mut response)
                        .unwrap();
                    String::new().encode(&mut response).unwrap();
                }
                response
            }
            13 => {
                signatures += 1;
                let mut reader = &frame[1..];
                assert_eq!(
                    Vec::<u8>::decode(&mut reader).unwrap(),
                    key.public_key().to_bytes().unwrap()
                );
                let data = Vec::<u8>::decode(&mut reader).unwrap();
                assert_eq!(u32::decode(&mut reader).unwrap(), 0);
                assert!(reader.is_empty());
                if behavior == "refuse" {
                    vec![5]
                } else {
                    let mut bytes = Vec::new();
                    key.try_sign(&data).unwrap().encode(&mut bytes).unwrap();
                    let mut response = vec![14];
                    bytes.encode(&mut response).unwrap();
                    response
                }
            }
            kind => panic!("unexpected agent message {kind}"),
        };
        stream.write_u32(response.len() as u32).await.unwrap();
        stream.write_all(&response).await.unwrap();
        response.clear();
    }
}

/// 生产 Agent 认证从本机流读取身份并请求真实签名；空身份与拒签不能被误报为成功。
#[test]
fn agent_authentication_uses_signatures_and_reports_empty_or_refused_identities() {
    run_test(async {
        for behavior in ["success", "empty", "refuse"] {
            let (port, server) = start_server().await;
            let (sender, _) = mpsc::channel(4);
            let mut client = connect(port, Vec::new(), sender, Arc::new(Semaphore::new(4))).await;
            let (agent_stream, service_stream) = tokio::io::duplex(65536);
            let agent_task = tokio::spawn(mock_agent(service_stream, behavior));
            let mut agent = russh::keys::agent::client::AgentClient::connect(agent_stream);
            let result = ssh_auth::authenticate_with_agent(&mut client, "test", &mut agent).await;
            assert_eq!(
                result.is_ok_and(|value| value.success()),
                behavior == "success"
            );
            drop(agent);
            assert_eq!(
                agent_task.await.unwrap(),
                if behavior == "empty" { 0 } else { 1 }
            );
            client
                .disconnect(russh::Disconnect::ByApplication, "", "English")
                .await
                .unwrap();
            // 未完成认证时同时释放控制通道，使服务端结束等待认证响应。
            drop(client);
            server.await.unwrap();
        }
    });
}

/// 三种首因素部分成功后必须完成验证码交互；被拒绝的公钥不得降级或提前报告成功。
#[test]
fn all_primary_authentication_methods_automatically_require_keyboard_second_factor() {
    run_test(async {
        for auth_type in [
            SshAuthType::Password,
            SshAuthType::PrivateKey,
            SshAuthType::Agent,
        ] {
            let (port, server) = start_server().await;
            let (sender, _) = mpsc::channel(4);
            let mut client = connect(port, Vec::new(), sender, Arc::new(Semaphore::new(4))).await;
            let first = if matches!(auth_type, SshAuthType::Agent) {
                let (stream, service) = tokio::io::duplex(65536);
                let task = tokio::spawn(mock_agent(service, "success"));
                let mut agent = russh::keys::agent::client::AgentClient::connect(stream);
                let result = ssh_auth::authenticate_with_agent(&mut client, "mfa", &mut agent)
                    .await
                    .unwrap();
                drop(agent);
                assert_eq!(task.await.unwrap(), 1);
                result
            } else if matches!(auth_type, SshAuthType::PrivateKey) {
                client
                    .authenticate_publickey(
                        "mfa",
                        russh::keys::PrivateKeyWithHashAlg::new(Arc::new(test_key()), None),
                    )
                    .await
                    .unwrap()
            } else {
                client
                    .authenticate_password("mfa", "test-password")
                    .await
                    .unwrap()
            };
            let client::AuthResult::Failure {
                remaining_methods, ..
            } = first
            else {
                panic!("first factor must require another method")
            };
            assert!(remaining_methods.contains(&russh::MethodKind::KeyboardInteractive));
            // 协议结果替身提供首因素部分成功位；后续交互仍使用真实 SSH 通道。
            let first = client::AuthResult::Failure {
                remaining_methods: remaining_methods.clone(),
                partial_success: true,
            };
            let rejected = client::AuthResult::Failure {
                remaining_methods,
                partial_success: false,
            };
            // 两种公钥来源被拒绝时都不能改走交互式密码；密码模式由独立测试覆盖。
            let rejected_type = if matches!(auth_type, SshAuthType::Agent) {
                SshAuthType::Agent
            } else {
                SshAuthType::PrivateKey
            };
            let mut rejected_prompts = 0;
            assert!(ssh_auth::finish_authentication(
                &mut client,
                "mfa",
                &rejected_type,
                rejected,
                |_, _, _| {
                    rejected_prompts += 1;
                    std::future::ready(Err("unexpected prompt".into()))
                }
            )
            .await
            .is_err());
            assert_eq!(rejected_prompts, 0);
            let mut rounds = 0;
            ssh_auth::finish_authentication(&mut client, "mfa", &auth_type, first, |_, _, _| {
                rounds += 1;
                std::future::ready(Ok(if rounds == 1 {
                    vec!["test-password".into(), "visible".into()]
                } else {
                    vec!["123456".into()]
                }))
            })
            .await
            .unwrap();
            assert_eq!(rounds, 2);
            client
                .disconnect(russh::Disconnect::ByApplication, "", "English")
                .await
                .unwrap();
            drop(client);
            server.await.unwrap();
        }
    });
}

/// SOCKS 域名及 IPv6 保持目标语义；无可用认证方式、BIND 和非法地址收到明确拒绝。
#[test]
fn socks_parser_preserves_domain_ipv6_and_rejects_unsupported_requests() {
    run_test(async {
        for address in [
            vec![
                3, 12, b'h', b'o', b's', b't', b'.', b'i', b'n', b'v', b'a', b'l', b'i', b'd',
            ],
            vec![4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        ] {
            let (mut client, mut server) = tokio::io::duplex(1024);
            let parser = tokio::spawn(async move { ssh_forward::socks_target(&mut server).await });
            client.write_all(&[5, 1, 0]).await.unwrap();
            let mut response = [0u8; 2];
            client.read_exact(&mut response).await.unwrap();
            assert_eq!(response, [5, 0]);
            client.write_all(&[5, 1, 0]).await.unwrap();
            client.write_all(&address).await.unwrap();
            client.write_all(&443u16.to_be_bytes()).await.unwrap();
            let target = parser.await.unwrap().unwrap();
            assert_eq!(
                target,
                (
                    if address[0] == 3 {
                        "host.invalid"
                    } else {
                        "::1"
                    }
                    .into(),
                    443
                )
            );
        }
        for (request, expected) in [(vec![5, 2, 0, 1], 7), (vec![5, 1, 0, 9], 8)] {
            let (mut client, mut server) = tokio::io::duplex(1024);
            let parser = tokio::spawn(async move { ssh_forward::socks_target(&mut server).await });
            client.write_all(&[5, 1, 0]).await.unwrap();
            let mut greeting = [0u8; 2];
            client.read_exact(&mut greeting).await.unwrap();
            client.write_all(&request).await.unwrap();
            let mut response = [0u8; 10];
            client.read_exact(&mut response).await.unwrap();
            assert_eq!(response[1], expected);
            assert!(parser.await.unwrap().is_err());
        }
    });
}

/// 认证响应绑定会话与随机轮次；非法提交不消费请求，完成后不得重放。
#[test]
fn authentication_broker_rejects_cross_session_invalid_and_replayed_responses() {
    run_test(async {
        let broker = ssh_auth::AuthBroker::default();
        let (registration, receiver) = broker.register("session", 2).unwrap();
        assert!(broker.register("session", 1).is_err());
        assert!(broker
            .respond(
                "other",
                &registration.request_id,
                Some(vec!["a".into(), "b".into()])
            )
            .is_err());
        assert!(broker
            .respond("session", &registration.request_id, Some(vec!["a".into()]))
            .is_err());
        broker
            .respond(
                "session",
                &registration.request_id,
                Some(vec!["a".into(), "b".into()]),
            )
            .unwrap();
        assert_eq!(receiver.await.unwrap(), Some(vec!["a".into(), "b".into()]));
        assert!(broker
            .respond("session", &registration.request_id, None)
            .is_err());
        drop(registration);
        let (registration, receiver) = broker.register("session", 1).unwrap();
        let request_id = registration.request_id.clone();
        drop(registration);
        assert!(receiver.await.is_err());
        assert!(broker.respond("session", &request_id, None).is_err());
        let (registration, receiver) = broker.register("session", 1).unwrap();
        broker
            .respond("session", &registration.request_id, None)
            .unwrap();
        assert_eq!(receiver.await.unwrap(), None);
    });
}

/// 私钥读取只接受有限普通文件，合法密钥可解码，空、超限和非法文件均拒绝。
#[test]
fn private_key_loading_rejects_empty_oversized_and_invalid_files() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("key");
    std::fs::write(&path, []).unwrap();
    assert!(ssh_auth::load_private_key(path.to_str().unwrap(), None).is_err());
    std::fs::write(&path, b"invalid key").unwrap();
    assert!(ssh_auth::load_private_key(path.to_str().unwrap(), None).is_err());
    std::fs::File::create(&path)
        .unwrap()
        .set_len(1024 * 1024 + 1)
        .unwrap();
    assert!(ssh_auth::load_private_key(path.to_str().unwrap(), None).is_err());
    std::fs::write(
        &path,
        test_key()
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    assert_eq!(
        ssh_auth::load_private_key(path.to_str().unwrap(), None)
            .unwrap()
            .public_key(),
        test_key().public_key()
    );
}
