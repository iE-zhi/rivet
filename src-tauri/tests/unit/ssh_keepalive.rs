//! SSH 保活配置与真实协议测试；仅使用内存双向流及隔离测试密钥。

use crate::ssh_config::SshKeepaliveConfig;
use russh::{client, keys::ssh_key::private::Ed25519Keypair, keys::PublicKeyOrCertificate, server};
use std::{
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncWrite, DuplexStream, ReadBuf};

/// 单次协议测试的硬超时，单位秒。
const TEST_TIMEOUT: Duration = Duration::from_secs(10);
/// 内存 transport 的有界缓冲区大小，单位字节。
const STREAM_CAPACITY: usize = 65_536;
/// 隔离测试服务公钥的固定种子；不访问用户密钥。
const TEST_KEY_SEED: [u8; 32] = [23; 32];

/// 可停止服务端读取的内存 transport；阻塞后不再恢复，用于模拟链路无响应。
struct GatedStream {
    /// 拥有服务端内存流，释放时关闭连接。
    stream: DuplexStream,
    /// 测试客户端认证后设置；仅控制读取，无跨 await 的锁。
    blocked: Arc<AtomicBool>,
}

impl AsyncRead for GatedStream {
    /// 阻塞时不消费协议请求；其余时候代理内存流读取。
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if self.blocked.load(Ordering::SeqCst) {
            return Poll::Pending;
        }
        Pin::new(&mut self.stream).poll_read(cx, buffer)
    }
}

impl AsyncWrite for GatedStream {
    /// 写入始终委托内存流，不改变健康连接的认证与保活回复。
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, buffer)
    }
    /// 将协议刷新委托内存流。
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    /// 关闭由测试拥有的内存流写入端。
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

/// 隔离服务仅接受测试用户名和密码，保活由 russh 协议层回复。
struct TestServer;
impl server::Handler for TestServer {
    type Error = russh::Error;
    /// 固定测试凭据；所有其他认证尝试均拒绝。
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        Ok(if user == "test" && password == "test" {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
}

/// 测试客户端只接受确定性服务密钥，不读写 known_hosts。
struct TestClient;
impl client::Handler for TestClient {
    type Error = russh::Error;
    /// 拒绝测试密钥之外的所有服务密钥。
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let private_key: russh::keys::PrivateKey = Ed25519Keypair::from_seed(&TEST_KEY_SEED).into();
        Ok(key.public_key() == *private_key.public_key())
    }
}

/// 在有硬超时的独立运行时中执行协议用例；运行时释放取消全部服务任务。
fn run_protocol_test(future: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(TEST_TIMEOUT, future)
                .await
                .expect("keepalive test timed out");
        });
}

/// 验证默认参数及范围，零值、负数、未知字段和越界输入不得进入连接配置。
#[test]
fn keepalive_defaults_and_invalid_boundaries() {
    let config = SshKeepaliveConfig::default().client_config().unwrap();
    assert_eq!(config.keepalive_interval, Some(Duration::from_secs(30)));
    assert_eq!(config.keepalive_max, 3);
    for (interval_seconds, max_failures) in [(1, 1), (3600, 100)] {
        assert!(SshKeepaliveConfig {
            interval_seconds,
            max_failures
        }
        .client_config()
        .is_ok());
    }
    for (interval_seconds, max_failures) in [(0, 3), (3601, 3), (30, 0), (30, 101)] {
        assert!(SshKeepaliveConfig {
            interval_seconds,
            max_failures
        }
        .client_config()
        .is_err());
    }
    for raw in [
        r#"{"intervalSeconds":-1,"maxFailures":3}"#,
        r#"{"intervalSeconds":1.5,"maxFailures":3}"#,
        r#"{"intervalSeconds":30,"maxFailures":3,"extra":true}"#,
    ] {
        assert!(serde_json::from_str::<SshKeepaliveConfig>(raw).is_err());
    }
}

/// 启动隔离内存 SSH 服务并用生产配置建立认证连接；返回读取闸门和服务任务。
async fn connect_test_client(
    max_failures: usize,
) -> (
    client::Handle<TestClient>,
    Arc<AtomicBool>,
    tokio::task::JoinHandle<()>,
) {
    let (client_stream, server_stream) = tokio::io::duplex(STREAM_CAPACITY);
    let blocked = Arc::new(AtomicBool::new(false));
    let stream = GatedStream {
        stream: server_stream,
        blocked: Arc::clone(&blocked),
    };
    let key: russh::keys::PrivateKey = Ed25519Keypair::from_seed(&TEST_KEY_SEED).into();
    let config = Arc::new(server::Config {
        keys: vec![key],
        ..Default::default()
    });
    let server_task = tokio::spawn(async move {
        let handle = server::run_stream(config, stream, TestServer)
            .await
            .unwrap();
        // 客户端关闭或运行时取消后服务资源由任务及内存流归属回收。
        let result = handle.await;
        assert!(result.is_ok() || matches!(result, Err(russh::Error::IO(_))));
    });
    let settings = SshKeepaliveConfig {
        interval_seconds: 1,
        max_failures,
    };
    let mut client = client::connect_stream(
        Arc::new(settings.client_config().unwrap()),
        client_stream,
        TestClient,
    )
    .await
    .unwrap();
    assert!(client
        .authenticate_password("test", "test")
        .await
        .unwrap()
        .success());
    (client, blocked, server_task)
}

/// 健康空闲连接收到协议回复后保持存活，跨越连续失败上限仍不会超时。
#[test]
fn responsive_idle_server_stays_connected() {
    run_protocol_test(async {
        let (client, _, server_task) = connect_test_client(1).await;
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(!client.is_closed());
        client
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await
            .unwrap();
        // 主动关闭完成时允许 russh 返回 Disconnect；保活超时不属于成功清理。
        assert!(matches!(
            client.await,
            Ok(()) | Err(russh::Error::Disconnect)
        ));
        server_task.await.unwrap();
    });
}

/// 服务端停止读取后连续三次无响应触发 KeepaliveTimeout，并关闭客户端 transport。
#[test]
fn unresponsive_server_reaches_configured_failure_limit() {
    run_protocol_test(async {
        let (client, blocked, server_task) = connect_test_client(3).await;
        blocked.store(true, Ordering::SeqCst);
        // 两秒尚未超过三次无响应上限，连接必须继续存活。
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(!client.is_closed());
        assert!(matches!(client.await, Err(russh::Error::KeepaliveTimeout)));
        server_task.abort();
        assert!(server_task.await.unwrap_err().is_cancelled());
    });
}
