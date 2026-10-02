//! SSH TCP 转发与 SOCKS5 CONNECT；监听器、桥接任务和并发配额归属于单个 SSH 会话。
//! 规则建立失败会回滚本机监听；远端监听由 SSH 连接关闭回收。

use crate::ssh_config::{ForwardKind, ForwardRule};
use russh::client;
use std::{
    net::{Ipv4Addr, Ipv6Addr},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, OwnedSemaphorePermit, Semaphore},
    task::JoinSet,
    time::timeout,
};

/// 转发连接建立、SOCKS 握手和远端监听申请的最大等待时间。
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
/// 单个会话最多同时拥有 128 个待建或已建转发连接。
pub(crate) const MAX_FORWARD_CONNECTIONS: usize = 128;
/// 转发诊断队列最大条数；队列满时额外错误只写入进程诊断。
const ERROR_QUEUE_CAPACITY: usize = 16;
/// SOCKS5 协议版本。
const SOCKS_VERSION: u8 = 5;
/// SOCKS5 CONNECT 命令，UDP/BIND 不在本模块能力范围内。
const SOCKS_CONNECT: u8 = 1;
/// SOCKS5 无认证方式；监听地址由用户显式配置。
const SOCKS_NO_AUTH: u8 = 0;
/// SOCKS5 无可接受认证方式的协商拒绝码。
const SOCKS_NO_ACCEPTABLE_AUTH: u8 = 0xff;
/// SOCKS5 IPv4 地址类型。
const SOCKS_IPV4: u8 = 1;
/// SOCKS5 域名地址类型。
const SOCKS_DOMAIN: u8 = 3;
/// SOCKS5 IPv6 地址类型。
const SOCKS_IPV6: u8 = 4;
/// SOCKS5 成功响应码。
pub(crate) const SOCKS_SUCCESS: u8 = 0;
/// SOCKS5 常规失败响应码。
const SOCKS_FAILURE: u8 = 1;
/// SOCKS5 不支持命令响应码。
const SOCKS_COMMAND_UNSUPPORTED: u8 = 7;
/// SOCKS5 不支持地址响应码。
const SOCKS_ADDRESS_UNSUPPORTED: u8 = 8;

/// 被 handler 接受的远程转发连接；permit 覆盖排队和整个桥接生命周期。
pub(crate) struct RemoteForward {
    /// 服务端提供的已批准通道。
    pub(crate) channel: russh::Channel<client::Msg>,
    /// 精确匹配的远程规则。
    pub(crate) rule: ForwardRule,
    /// 并发配额，任务完成或取消时归还。
    pub(crate) permit: OwnedSemaphorePermit,
}

/// 远程转发入口的规则白名单、队列和配额；每个 SSH handler 独占规则副本。
pub(crate) struct RemoteForwardAcceptor {
    /// 只允许此处已配置的远程监听端点。
    pub(crate) rules: Vec<ForwardRule>,
    /// 有界远程转发接收队列。
    pub(crate) sender: mpsc::Sender<RemoteForward>,
    /// 与本地/动态转发共享的连接配额。
    pub(crate) permits: Arc<Semaphore>,
}

impl RemoteForwardAcceptor {
    /// 精确匹配监听端点并预留队列与配额；未授权或过载通道显式拒绝。
    pub(crate) async fn accept(
        &self,
        channel: russh::Channel<client::Msg>,
        address: &str,
        port: u32,
        reply: client::ChannelOpenHandle,
    ) {
        let Some(rule) = self
            .rules
            .iter()
            .find(|r| r.bind_address == address && u32::from(r.bind_port) == port)
            .cloned()
        else {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return;
        };
        let Ok(permit) = Arc::clone(&self.permits).try_acquire_owned() else {
            reply
                .reject(russh::ChannelOpenFailure::ResourceShortage)
                .await;
            return;
        };
        let Ok(slot) = self.sender.try_reserve() else {
            reply
                .reject(russh::ChannelOpenFailure::ResourceShortage)
                .await;
            return;
        };
        reply.accept().await;
        slot.send(RemoteForward {
            channel,
            rule,
            permit,
        });
    }
}

/// 会话转发任务组；Drop 中 JoinSet 取消任务及其子连接，释放所有监听 socket。
pub(crate) struct ForwardRuntime {
    /// 每条本地/动态监听及远程调度任务，数量受规则上限约束。
    tasks: JoinSet<()>,
    /// 向终端 worker 返回可见诊断，不影响其他转发。
    pub(crate) errors: mpsc::Receiver<String>,
}

/// 将单连接失败加入有界诊断队列；拥塞时只记录不含秘密的错误。
fn report_error(sender: &mpsc::Sender<String>, error: String) {
    if let Err(error) = sender.try_send(error) {
        eprintln!("SSH 转发诊断：{}", error.into_inner());
    }
}

impl ForwardRuntime {
    /// 建立全部转发监听；任何规则失败即回滚，不把部分启用的连接报告为成功。
    pub(crate) async fn start<H: client::Handler + 'static>(
        session: Arc<client::Handle<H>>,
        rules: &[ForwardRule],
        mut remote: mpsc::Receiver<RemoteForward>,
        permits: Arc<Semaphore>,
    ) -> Result<Self, String> {
        let (errors, receiver) = mpsc::channel(ERROR_QUEUE_CAPACITY);
        let mut runtime = Self {
            tasks: JoinSet::new(),
            errors: receiver,
        };
        // 先创建所有监听，再启动任务；局部 Vec 与 runtime 在失败时释放资源。
        let mut listeners = Vec::new();
        for rule in rules {
            if rule.kind == ForwardKind::Remote {
                timeout(
                    OPEN_TIMEOUT,
                    session.tcpip_forward(&rule.bind_address, u32::from(rule.bind_port)),
                )
                .await
                .map_err(|_| "申请远程转发超时".to_string())?
                .map_err(|e| {
                    format!(
                        "远程转发 {}:{} 被拒绝：{e}",
                        rule.bind_address, rule.bind_port
                    )
                })?;
            } else {
                let listener = timeout(
                    OPEN_TIMEOUT,
                    TcpListener::bind((rule.bind_address.as_str(), rule.bind_port)),
                )
                .await
                .map_err(|_| "建立本机转发监听超时".to_string())?
                .map_err(|e| format!("监听 {}:{} 失败：{e}", rule.bind_address, rule.bind_port))?;
                listeners.push((listener, rule.clone()));
            }
        }
        for (listener, rule) in listeners {
            let session = Arc::clone(&session);
            let permits = Arc::clone(&permits);
            let errors = errors.clone();
            // 优先回收已完成子任务，避免持续 accept 时积累已释放配额的 JoinHandle。
            runtime.tasks.spawn(async move {
                let mut bridges = JoinSet::new();
                loop {
                    tokio::select! {
                        biased;
                        result = bridges.join_next(), if !bridges.is_empty() => {
                            handle_bridge_result(result, &errors);
                        }
                        accepted = listener.accept() => {
                            let (socket, origin) = match accepted {
                                Ok(value) => value,
                                Err(e) => { report_error(&errors, format!("转发监听失败：{e}")); break; }
                            };
                            let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else {
                                report_error(&errors, "SSH 转发连接数量达到上限".into());
                                continue;
                            };
                            let session = Arc::clone(&session);
                            let rule = rule.clone();
                            // socket 和 permit 由子任务独占；取消时 RAII 关闭并归还。
                            bridges.spawn(async move {
                                let _permit = permit;
                                bridge_local(session, socket, &rule, origin).await
                            });
                        }
                    }
                }
            });
        }
        // 单个远程调度任务拥有桥接子任务，优先回收完成项再接收新通道。
        runtime.tasks.spawn(async move {
            let mut bridges = JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    result = bridges.join_next(), if !bridges.is_empty() => handle_bridge_result(result, &errors),
                    incoming = remote.recv() => {
                        let Some(incoming) = incoming else { break; };
                        // 目标连接只能来自已批准规则，不接受服务器提供的目标路径或地址。
                        bridges.spawn(async move {
                            let _permit = incoming.permit;
                            let mut socket = timeout(OPEN_TIMEOUT, TcpStream::connect((incoming.rule.target_host.as_str(), incoming.rule.target_port))).await
                                .map_err(|_| "远程转发连接本机目标超时".to_string())?
                                .map_err(|e| format!("远程转发连接本机目标失败：{e}"))?;
                            let mut stream = incoming.channel.into_stream();
                            tokio::io::copy_bidirectional(&mut socket, &mut stream).await
                                .map_err(|e| format!("远程转发 I/O 失败：{e}"))?;
                            Ok(())
                        });
                    }
                }
            }
        });
        Ok(runtime)
    }

    /// 停止并等待全部监听任务；取消嵌套桥接任务并释放 socket。
    pub(crate) async fn shutdown(&mut self) {
        self.tasks.abort_all();
        while let Some(result) = self.tasks.join_next().await {
            if let Err(error) = result {
                if !error.is_cancelled() {
                    eprintln!("SSH 转发任务结束失败：{error}");
                }
            }
        }
    }
}

/// 回收桥接任务并报告失败；任务取消属于会话资源清理。
fn handle_bridge_result(
    result: Option<Result<Result<(), String>, tokio::task::JoinError>>,
    errors: &mpsc::Sender<String>,
) {
    match result {
        Some(Ok(Err(error))) => report_error(errors, error),
        Some(Err(error)) if !error.is_cancelled() => {
            report_error(errors, format!("SSH 转发任务失败：{error}"))
        }
        _ => {}
    }
}

/// 建立本地或动态转发通道；SOCKS 仅在 SSH 确认通道建立后发送成功响应。
async fn bridge_local<H: client::Handler>(
    session: Arc<client::Handle<H>>,
    mut socket: TcpStream,
    rule: &ForwardRule,
    origin: std::net::SocketAddr,
) -> Result<(), String> {
    let dynamic = rule.kind == ForwardKind::Dynamic;
    let (host, port) = if dynamic {
        timeout(OPEN_TIMEOUT, socks_target(&mut socket))
            .await
            .map_err(|_| "SOCKS5 握手超时".to_string())??
    } else {
        (rule.target_host.clone(), rule.target_port)
    };
    let opened = timeout(
        OPEN_TIMEOUT,
        session.channel_open_direct_tcpip(
            host,
            u32::from(port),
            origin.ip().to_string(),
            u32::from(origin.port()),
        ),
    )
    .await;
    let channel = match opened {
        Ok(Ok(channel)) => channel,
        failure => {
            if dynamic {
                socks_reply(&mut socket, SOCKS_FAILURE).await?;
            }
            return Err(match failure {
                Ok(Err(e)) => format!("SSH 转发通道被拒绝：{e}"),
                _ => "建立 SSH 转发通道超时".into(),
            });
        }
    };
    if dynamic {
        socks_reply(&mut socket, SOCKS_SUCCESS).await?;
    }
    let mut stream = channel.into_stream();
    // copy_bidirectional 传播半关闭；两端 EOF 后完成，任务取消时两个流均释放。
    tokio::io::copy_bidirectional(&mut socket, &mut stream)
        .await
        .map_err(|e| format!("本地转发 I/O 失败：{e}"))?;
    Ok(())
}

/// 解析 SOCKS5 无认证 CONNECT；域名保持原文交由 SSH 服务端解析。
pub(crate) async fn socks_target<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
) -> Result<(String, u16), String> {
    // 定长两字节分别为版本与后续认证方式数量。
    let mut greeting = [0u8; 2];
    stream
        .read_exact(&mut greeting)
        .await
        .map_err(|e| format!("读取 SOCKS5 握手失败：{e}"))?;
    if greeting[0] != SOCKS_VERSION || greeting[1] == 0 {
        return Err("SOCKS5 握手无效".into());
    }
    let mut methods = vec![0u8; usize::from(greeting[1])];
    stream
        .read_exact(&mut methods)
        .await
        .map_err(|e| format!("读取 SOCKS5 认证方式失败：{e}"))?;
    // 无认证监听只在配置地址开放；不支持的认证方式明确拒绝。
    if !methods.contains(&SOCKS_NO_AUTH) {
        stream
            .write_all(&[SOCKS_VERSION, SOCKS_NO_ACCEPTABLE_AUTH])
            .await
            .map_err(|e| format!("回复 SOCKS5 认证失败：{e}"))?;
        return Err("SOCKS5 不支持此认证方式".into());
    }
    stream
        .write_all(&[SOCKS_VERSION, SOCKS_NO_AUTH])
        .await
        .map_err(|e| format!("回复 SOCKS5 认证方式失败：{e}"))?;
    // 定长四字节为版本、命令、零保留位及地址类型。
    let mut header = [0u8; 4];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|e| format!("读取 SOCKS5 请求失败：{e}"))?;
    if header[0] != SOCKS_VERSION || header[2] != 0 {
        return Err("SOCKS5 请求头无效".into());
    }
    if header[1] != SOCKS_CONNECT {
        socks_reply(stream, SOCKS_COMMAND_UNSUPPORTED).await?;
        return Err("SOCKS5 仅支持 CONNECT".into());
    }
    let host = match header[3] {
        SOCKS_IPV4 => {
            // IPv4 协议地址固定为四个八位组。
            let mut bytes = [0u8; 4];
            stream
                .read_exact(&mut bytes)
                .await
                .map_err(|e| format!("读取 SOCKS5 IPv4 失败：{e}"))?;
            Ipv4Addr::from(bytes).to_string()
        }
        SOCKS_IPV6 => {
            // IPv6 协议地址固定为十六个八位组。
            let mut bytes = [0u8; 16];
            stream
                .read_exact(&mut bytes)
                .await
                .map_err(|e| format!("读取 SOCKS5 IPv6 失败：{e}"))?;
            Ipv6Addr::from(bytes).to_string()
        }
        SOCKS_DOMAIN => {
            let length = stream
                .read_u8()
                .await
                .map_err(|e| format!("读取 SOCKS5 域名长度失败：{e}"))?;
            let mut bytes = vec![0u8; usize::from(length)];
            stream
                .read_exact(&mut bytes)
                .await
                .map_err(|e| format!("读取 SOCKS5 域名失败：{e}"))?;
            String::from_utf8(bytes).map_err(|_| "SOCKS5 域名不是 UTF-8".to_string())?
        }
        _ => {
            socks_reply(stream, SOCKS_ADDRESS_UNSUPPORTED).await?;
            return Err("SOCKS5 地址类型无效".into());
        }
    };
    crate::ssh_config::validate_host(&host)?;
    let port = stream
        .read_u16()
        .await
        .map_err(|e| format!("读取 SOCKS5 目标端口失败：{e}"))?;
    if port == 0 {
        return Err("SOCKS5 目标端口无效".into());
    }
    Ok((host, port))
}

/// 发送 IPv4 未指定绑定地址的 SOCKS5 状态响应，不声明不存在的本机目标监听。
pub(crate) async fn socks_reply<S: AsyncWrite + Unpin>(
    stream: &mut S,
    status: u8,
) -> Result<(), String> {
    // 保留位为零，四字节地址与两字节端口均未知，统一填零。
    stream
        .write_all(&[SOCKS_VERSION, status, 0, SOCKS_IPV4, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|e| format!("回复 SOCKS5 状态失败：{e}"))
}
