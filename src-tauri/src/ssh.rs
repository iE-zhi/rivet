//! SSH 终端会话服务。
//!
//! 本模块负责建立 SSH 客户端连接、认证、PTY Shell、输入输出转发和窗口尺寸同步。
//! 活动会话仅保存在进程内存中；密码和私钥口令不会写入持久化存储。

use std::{collections::HashMap, error::Error as StdError, fmt, sync::Arc, time::Duration};

use crate::sftp::{self, SftpCommand};
use crate::shell_integration;
use crate::ssh_auth::{self, AuthBroker};
use crate::ssh_config::{self, ForwardKind, ForwardRule, SshAuthType, SshHopConfig};
use crate::ssh_forward::{ForwardRuntime, RemoteForwardAcceptor, MAX_FORWARD_CONNECTIONS};
use crate::x11::{self, X11ForwardConfig};
use russh::{
    client,
    keys::{check_known_hosts, known_hosts::learn_known_hosts, PublicKeyOrCertificate},
    ChannelMsg, Disconnect,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tokio::{
    sync::{mpsc, oneshot, watch, RwLock, Semaphore},
    time::timeout,
};

/// TCP 连接和 SSH 密钥交换的最大等待时间，单位为秒。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 会话资源清理与命令排队的最大等待时间。
const RESOURCE_CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
/// 同时连接中及活动的 SSH 会话数量上限。
const MAX_SESSIONS: usize = 64;
/// 探测远端登录 shell 的最大等待时间。
const SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// 单个会话等待处理的前端命令上限，防止输入洪泛无限占用内存。
const COMMAND_QUEUE_CAPACITY: usize = 256;
/// 单次前端输入允许的最大字节数。
const MAX_INPUT_BYTES: usize = 64 * 1024;
/// PTY 最大列数，用于拒绝异常窗口尺寸。
const MAX_COLUMNS: u32 = 1000;
/// PTY 最大行数，用于拒绝异常窗口尺寸。
const MAX_ROWS: u32 = 500;
/// 密码、私钥路径和私钥口令的单字段最大字节数。
const MAX_CREDENTIAL_BYTES: usize = 4096;
/// 前端会话标识的最大字节数。
const MAX_SESSION_ID_BYTES: usize = 128;

/// 前端提交的 SSH 连接参数。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectConfig {
    /// 前端生成的会话唯一标识，最长 128 字节。
    pub session_id: String,
    /// SSH 主机名或 IP 地址。
    pub host: String,
    /// SSH TCP 端口，范围为 1..=65535。
    pub port: u16,
    /// SSH 用户名。
    pub username: String,
    /// 本次连接使用的认证方式。
    pub auth_type: SshAuthType,
    /// 密码认证使用的明文密码，仅在当前调用和会话建立阶段存在。
    pub password: Option<String>,
    /// 私钥认证使用的本地私钥路径。
    pub key_path: Option<String>,
    /// 私钥解密口令；未加密私钥使用空值。
    pub key_passphrase: Option<String>,
    /// 是否请求 X11 forwarding。
    pub x11: bool,
    /// 由前端解析的跳板链，从本机可达主机到目标前一跳，最多 8 个。
    #[serde(default)]
    pub jump_hosts: Vec<SshHopConfig>,
    /// 随会话启停的非敏感端口转发规则，最多 32 条。
    #[serde(default)]
    pub forwards: Vec<ForwardRule>,
    /// X11 转发连接的本机 X Server TCP 地址；仅在启用 X11 时使用。
    pub x11_server_address: Option<String>,
    /// Linux 本机 xauth 可执行文件路径；仅在启用 X11 时使用。
    pub x11_linux_xauth_path: Option<String>,
    /// 初始 PTY 列数。
    pub columns: u32,
    /// 初始 PTY 行数。
    pub rows: u32,
    /// 前端生成的 Shell Integration 会话标识；只用于当前 SSH PTY。
    pub shell_integration_token: Option<String>,
}

/// SSH 终端输出事件。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshDataEvent {
    /// 对应前端标签页的会话标识。
    session_id: String,
    /// 原始终端字节，保留 ANSI 控制序列。
    data: Vec<u8>,
}

/// SSH 会话错误事件。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshErrorEvent {
    /// 对应前端标签页的会话标识。
    session_id: String,
    /// 可直接向用户展示的错误文本。
    message: String,
}

/// SSH 会话结束事件。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshClosedEvent {
    /// 对应前端标签页的会话标识。
    session_id: String,
    /// 远端提供的进程退出码；正常断链但无退出码时为空。
    exit_status: Option<u32>,
}

/// 前端发送给单个 SSH worker 的命令。
enum SshCommand {
    /// 向远端 PTY 写入原始 UTF-8/控制字符字节。
    Input(Vec<u8>),
    /// 同步 PTY 字符尺寸。
    Resize { columns: u32, rows: u32 },
    /// 创建或复用独立 SFTP worker，并返回其命令发送端。
    EnsureSftp {
        result: oneshot::Sender<Result<mpsc::Sender<SftpCommand>, String>>,
    },
}

/// 活动 SSH 会话表；每个会话只暴露一个有界命令发送端。
#[derive(Default)]
pub struct SshService {
    /// 包含连接中和已连接的会话，连接开始即预留标识。
    sessions: Arc<RwLock<HashMap<String, SessionControl>>>,
    /// 仅存于内存的键盘交互请求表。
    auth: AuthBroker,
}

/// 会话命令与取消通道；取消信号也能中止握手和用户输入等待。
struct SessionControl {
    /// 有界终端命令通道。
    sender: mpsc::Sender<SshCommand>,
    /// 最新取消状态；true 后该会话不可重新启用。
    cancel: watch::Sender<bool>,
}

/// 当前连接的全部 SSH transport；释放时逆序限时断开。
struct ConnectionChain {
    /// 最后一个为目标主机，前面的句柄维持跳板通道。
    handles: Vec<Arc<client::Handle<ClientHandler>>>,
}

/// 认证阶段独占 transport；认证 future 被取消时仍发送限时断开。
struct AuthenticatingConnection {
    /// 认证成功后移入连接链，否则由 Drop 回收。
    handle: Option<client::Handle<ClientHandler>>,
}

impl Drop for AuthenticatingConnection {
    /// 清理尚未转交连接链的 transport，不保留认证秘密。
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            tauri::async_runtime::spawn(async move {
                match timeout(
                    CONNECT_TIMEOUT,
                    handle.disconnect(Disconnect::ByApplication, "", "English"),
                )
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => eprintln!("关闭认证阶段 SSH transport 失败：{error}"),
                    Err(_) => eprintln!("关闭认证阶段 SSH transport 超时"),
                }
            });
        }
    }
}

impl Drop for ConnectionChain {
    /// 正常退出、连接失败或 future 取消后回收已有 transport。
    fn drop(&mut self) {
        let handles = std::mem::take(&mut self.handles);
        tauri::async_runtime::spawn(async move {
            for handle in handles.into_iter().rev() {
                match timeout(
                    CONNECT_TIMEOUT,
                    handle.disconnect(Disconnect::ByApplication, "", "English"),
                )
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => eprintln!("关闭 SSH transport 失败：{error}"),
                    Err(_) => eprintln!("关闭 SSH transport 超时"),
                }
            }
        });
    }
}

/// russh 客户端主机密钥检查失败。
#[derive(Debug)]
enum ClientHandlerError {
    /// SSH 协议或网络层错误。
    Ssh(russh::Error),
    /// known_hosts 读取、校验或写入错误。
    HostKey(russh::keys::Error),
}

impl fmt::Display for ClientHandlerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ssh(error) => write!(formatter, "{error}"),
            Self::HostKey(error) => write!(formatter, "{error}"),
        }
    }
}

impl StdError for ClientHandlerError {}

impl From<russh::Error> for ClientHandlerError {
    fn from(error: russh::Error) -> Self {
        Self::Ssh(error)
    }
}

impl From<russh::keys::Error> for ClientHandlerError {
    fn from(error: russh::keys::Error) -> Self {
        Self::HostKey(error)
    }
}

/// SSH 客户端事件处理器；采用 accept-new 语义维护用户的标准 known_hosts。
struct ClientHandler {
    /// 当前端点用于 known_hosts 检查的真实主机名。
    host: String,
    /// 当前端点的 TCP 端口。
    port: u16,
    /// 仅目标主机允许的 X11 配置。
    x11: Option<X11ForwardConfig>,
    /// 应用事件发布句柄。
    app: AppHandle,
    /// 当前终端会话标识。
    session_id: String,
    /// 精确匹配的远程监听规则、有界队列和共享配额。
    remote: RemoteForwardAcceptor,
}

impl client::Handler for ClientHandler {
    type Error = ClientHandlerError;

    /// 校验服务端主机密钥；未知主机首次写入 known_hosts，已记录主机发生变更时拒绝连接。
    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let public_key = server_public_key.public_key();
        match check_known_hosts(&self.host, self.port, &public_key)? {
            true => Ok(true),
            false => {
                learn_known_hosts(&self.host, self.port, &public_key)?;
                Ok(true)
            }
        }
    }

    /// 仅接受配置中精确匹配的远程转发，并限制排队与活动连接总数。
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        self.remote
            .accept(channel, connected_address, connected_port, reply)
            .await;
        Ok(())
    }

    /// 接受远端 X11 channel，并在后台桥接至本机 X Server；失败只影响该 X11 channel。
    fn server_channel_open_x11(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        let config = self.x11.clone();
        let app = self.app.clone();
        let session_id = self.session_id.clone();
        async move {
            let Some(config) = config else {
                reply
                    .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                    .await;
                return Ok(());
            };

            reply.accept().await;
            tauri::async_runtime::spawn(async move {
                if let Err(message) = x11::bridge_x11_channel(channel, config).await {
                    if let Err(error) = app.emit(
                        "ssh:x11-error",
                        SshErrorEvent {
                            session_id,
                            message,
                        },
                    ) {
                        eprintln!("发布 SSH X11 错误失败：{error}");
                    }
                }
            });
            Ok(())
        }
    }
}

/// 打开系统文件选择器，让用户选择本机 SSH 私钥文件。
///
/// 返回 `None` 表示用户取消；仅返回可转换为 UTF-8 的本机文件路径。
#[tauri::command]
pub async fn pick_ssh_private_key(app: AppHandle) -> Result<Option<String>, String> {
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app.dialog().file().blocking_pick_file()
    })
    .await
    .map_err(|error| format!("打开 SSH 私钥文件选择器失败：{error}"))?;

    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("SSH 私钥文件路径无效：{error}"))?;
    let path = path
        .to_str()
        .ok_or_else(|| "SSH 私钥文件路径不是有效 UTF-8".to_string())?;
    Ok(Some(path.to_string()))
}

/// 预留会话标识并建立 SSH 链、认证与 PTY；取消时回收连接阶段资源。
#[tauri::command]
pub async fn open_ssh_session(
    app: AppHandle,
    service: State<'_, SshService>,
    config: SshConnectConfig,
) -> Result<Option<String>, String> {
    validate_connect_config(&config)?;
    let (sender, receiver) = mpsc::channel(COMMAND_QUEUE_CAPACITY);
    let (cancel, mut cancellation) = watch::channel(false);
    {
        let mut sessions = service.sessions.write().await;
        if sessions.contains_key(&config.session_id) {
            return Err("SSH 会话标识已存在".into());
        }
        if sessions.len() >= MAX_SESSIONS {
            return Err("SSH 会话数量达到上限".into());
        }
        sessions.insert(config.session_id.clone(), SessionControl { sender, cancel });
    }
    let worker_cancellation = cancellation.clone();
    let result = tokio::select! {
        biased;
        _ = cancellation.changed() => Err("SSH 连接已取消".into()),
        result = establish_session(app, &service, &config, receiver, worker_cancellation) => result,
    };
    if result.is_err() {
        service.sessions.write().await.remove(&config.session_id);
    }
    result
}

/// 提交键盘交互响应；None 表示用户取消，响应不会进入持久化存储。
#[tauri::command]
pub async fn ssh_auth_respond(
    service: State<'_, SshService>,
    session_id: String,
    request_id: String,
    responses: Option<Vec<String>>,
) -> Result<(), String> {
    service.auth.respond(&session_id, &request_id, responses)
}

/// 建立完整连接后转交 worker；中途失败由 ConnectionChain 释放跳板 transport。
async fn establish_session(
    app: AppHandle,
    service: &SshService,
    config: &SshConnectConfig,
    command_receiver: mpsc::Receiver<SshCommand>,
    cancellation: watch::Receiver<bool>,
) -> Result<Option<String>, String> {
    let session_id = config.session_id.clone();
    let host = config.host.trim().to_string();
    let username = config.username.trim().to_string();
    let port = config.port;
    let x11_config = if config.x11 {
        #[cfg(target_os = "macos")]
        let xauth_path = None;
        #[cfg(all(unix, not(target_os = "macos")))]
        let xauth_path = config.x11_linux_xauth_path.clone();
        #[cfg(windows)]
        let xauth_path = None;

        Some(x11::prepare_x11_forwarding(config.x11_server_address.clone(), xauth_path).await?)
    } else {
        None
    };

    let (remote_sender, remote_receiver) = mpsc::channel(MAX_FORWARD_CONNECTIONS);
    let forward_permits = Arc::new(Semaphore::new(MAX_FORWARD_CONNECTIONS));
    let mut chain = ConnectionChain {
        handles: Vec::new(),
    };
    let target = SshHopConfig {
        host,
        port,
        username,
        auth_type: config.auth_type.clone(),
        password: config.password.clone(),
        key_path: config.key_path.clone(),
        key_passphrase: config.key_passphrase.clone(),
    };
    for (index, hop) in config
        .jump_hosts
        .iter()
        .chain(std::iter::once(&target))
        .enumerate()
    {
        let is_target = index == config.jump_hosts.len();
        let handler = ClientHandler {
            host: hop.host.clone(),
            port: hop.port,
            app: app.clone(),
            session_id: session_id.clone(),
            x11: if is_target { x11_config.clone() } else { None },
            remote: RemoteForwardAcceptor {
                rules: if is_target {
                    config
                        .forwards
                        .iter()
                        .filter(|r| r.kind == ForwardKind::Remote)
                        .cloned()
                        .collect()
                } else {
                    Vec::new()
                },
                sender: remote_sender.clone(),
                permits: Arc::clone(&forward_permits),
            },
        };
        // 各跳使用独立 SSH 握手及主机密钥检查，内层流只能经上一跳的 direct-tcpip 通道。
        let connection = async {
            let client_config = Arc::new(client::Config::default());
            if let Some(previous) = chain.handles.last() {
                let channel = previous
                    .channel_open_direct_tcpip(&hop.host, u32::from(hop.port), "127.0.0.1", 0)
                    .await
                    .map_err(|e| format!("建立跳板通道失败：{e}"))?;
                client::connect_stream(client_config, channel.into_stream(), handler)
                    .await
                    .map_err(|e| format!("跳板 SSH 握手失败：{e}"))
            } else {
                client::connect(client_config, (hop.host.as_str(), hop.port), handler)
                    .await
                    .map_err(|e| format!("SSH 连接失败：{e}"))
            }
        };
        let handle = timeout(CONNECT_TIMEOUT, connection)
            .await
            .map_err(|_| "SSH 连接超时".to_string())??;
        let mut authenticating = AuthenticatingConnection {
            handle: Some(handle),
        };
        ssh_auth::authenticate(
            authenticating.handle.as_mut().ok_or("SSH 认证连接已释放")?,
            hop,
            &app,
            &session_id,
            &service.auth,
        )
        .await?;
        chain.handles.push(Arc::new(
            authenticating.handle.take().ok_or("SSH 认证连接已释放")?,
        ));
    }
    let session = Arc::clone(chain.handles.last().ok_or("SSH 连接链为空")?);
    let mut forwarding = ForwardRuntime::start(
        Arc::clone(&session),
        &config.forwards,
        remote_receiver,
        forward_permits,
    )
    .await?;

    let mut shell_kind = if config.shell_integration_token.is_some() {
        detect_remote_shell(&session).await
    } else {
        None
    };

    let mut channel = open_pty_shell_channel(&session, config, x11_config.as_ref()).await?;
    let mut initial_output = Vec::new();
    if let (Some(kind), Some(token)) = (
        shell_kind.as_deref(),
        config.shell_integration_token.as_deref(),
    ) {
        match install_remote_shell_integration(&mut channel, kind, token).await {
            Ok(output) => initial_output = output,
            Err(_) => {
                // 初始化失败时丢弃整个旧 PTY，确保注入脚本及迟到回显绝不进入正式数据流。
                close_channel(&channel).await;
                channel = open_pty_shell_channel(&session, config, x11_config.as_ref()).await?;
                shell_kind = None;
            }
        }
    }

    let sessions = Arc::clone(&service.sessions);
    tauri::async_runtime::spawn(async move {
        let mut cancellation = cancellation;
        let mut sftp_sender = None;
        let context = SshWorkerContext {
            app: app.clone(),
            session_id: session_id.clone(),
            initial_output,
        };
        // 取消包围整个 worker future，可以中止队列拥塞中的发送与 SFTP 建立。
        let result = tokio::select! {
            biased;
            _ = wait_for_cancellation(&mut cancellation) => Ok(None),
            result = run_session_worker(context, &session, &mut channel, command_receiver, &mut forwarding, &mut sftp_sender) => result,
        };
        forwarding.shutdown().await;
        if let Some(sender) = sftp_sender {
            match timeout(RESOURCE_CLOSE_TIMEOUT, sender.send(SftpCommand::Close)).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => eprintln!("SFTP worker 已停止"),
                Err(_) => eprintln!("关闭 SFTP worker 超时"),
            }
        }
        close_channel(&channel).await;
        // 先释放转发和 PTY，再回收内层及跳板 transport。
        drop(session);
        drop(chain);
        sessions.write().await.remove(&session_id);

        match result {
            Ok(exit_status) => {
                if let Err(error) = app.emit(
                    "ssh:closed",
                    SshClosedEvent {
                        session_id,
                        exit_status,
                    },
                ) {
                    eprintln!("发布 SSH 关闭事件失败：{error}");
                }
            }
            Err(message) => {
                if let Err(error) = app.emit(
                    "ssh:error",
                    SshErrorEvent {
                        session_id,
                        message,
                    },
                ) {
                    eprintln!("发布 SSH 错误事件失败：{error}");
                }
            }
        }
    });

    Ok(shell_kind)
}

/// 向已连接 SSH PTY 写入字节；输入为空时直接忽略。
#[tauri::command]
pub async fn ssh_send_input(
    service: State<'_, SshService>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    if data.len() > MAX_INPUT_BYTES {
        return Err(format!("单次终端输入不能超过 {MAX_INPUT_BYTES} 字节"));
    }

    send_command(&service, &session_id, SshCommand::Input(data)).await
}

/// 更新远端 PTY 字符尺寸。
#[tauri::command]
pub async fn ssh_resize_session(
    service: State<'_, SshService>,
    session_id: String,
    columns: u32,
    rows: u32,
) -> Result<(), String> {
    validate_terminal_size(columns, rows)?;
    send_command(&service, &session_id, SshCommand::Resize { columns, rows }).await
}

/// 请求关闭 SSH 会话；实际资源由 worker 按顺序释放。
#[tauri::command]
pub async fn close_ssh_session(
    service: State<'_, SshService>,
    session_id: String,
) -> Result<(), String> {
    // 取消信号独立于终端命令队列，连接中和队列拥塞时同样生效；重复关闭幂等。
    if let Some(control) = service.sessions.read().await.get(&session_id) {
        control.cancel.send_replace(true);
    }
    Ok(())
}

/// 限时排队并请求活动 SSH worker 创建或复用 SFTP；超时后会话仍可复用。
pub(crate) async fn request_sftp_sender(
    service: &SshService,
    session_id: &str,
) -> Result<mpsc::Sender<SftpCommand>, String> {
    let shell_sender = {
        let sessions = service.sessions.read().await;
        sessions
            .get(session_id)
            .map(|control| control.sender.clone())
            .ok_or_else(|| "SSH 会话不存在或已关闭".to_string())?
    };
    let (result_sender, result_receiver) = oneshot::channel();
    timeout(
        RESOURCE_CLOSE_TIMEOUT,
        shell_sender.send(SshCommand::EnsureSftp {
            result: result_sender,
        }),
    )
    .await
    .map_err(|_| "SSH 命令排队超时".to_string())?
    .map_err(|_| "SSH 会话工作任务已停止".to_string())?;
    timeout(CONNECT_TIMEOUT, result_receiver)
        .await
        .map_err(|_| "建立 SFTP 会话超时".to_string())?
        .map_err(|_| "SSH worker 未返回 SFTP 会话结果".to_string())?
}

/// 创建配置完整的 SSH PTY Shell；Integration 失败时可复用此函数重建干净通道。
async fn open_pty_shell_channel(
    session: &client::Handle<ClientHandler>,
    config: &SshConnectConfig,
    x11_config: Option<&X11ForwardConfig>,
) -> Result<russh::Channel<client::Msg>, String> {
    timeout(CONNECT_TIMEOUT, async {
        let channel = session
            .channel_open_session()
            .await
            .map_err(|error| format!("创建 SSH 会话通道失败：{error}"))?;
        channel
            .request_pty(
                true,
                "xterm-256color",
                config.columns,
                config.rows,
                0,
                0,
                &[],
            )
            .await
            .map_err(|error| format!("申请 SSH PTY 失败：{error}"))?;
        if let Some(x11) = x11_config {
            channel
                .request_x11(
                    true,
                    false,
                    x11.protocol.as_ref(),
                    x11.fake_cookie_hex.as_ref(),
                    x11.screen,
                )
                .await
                .map_err(|error| format!("申请 SSH X11 转发失败：{error}"))?;
        }
        channel
            .request_shell(true)
            .await
            .map_err(|error| format!("启动 SSH Shell 失败：{error}"))?;
        Ok(channel)
    })
    .await
    .map_err(|_| "建立 SSH PTY 超时".to_string())?
}

/// 限时释放会话通道；断链时记录清理结果，不覆盖原始错误。
async fn close_channel(channel: &russh::Channel<client::Msg>) {
    let cleanup = async {
        if let Err(error) = channel.eof().await {
            eprintln!("SSH 通道 EOF 失败：{error}");
        }
        if let Err(error) = channel.close().await {
            eprintln!("关闭 SSH 通道 失败：{error}");
        }
    };
    if timeout(RESOURCE_CLOSE_TIMEOUT, cleanup).await.is_err() {
        eprintln!("关闭 SSH 通道 超时");
    }
}

/// 在正常 SSH 数据转发开始前完成 Shell Integration，并只保留真实 Prompt。
async fn install_remote_shell_integration(
    channel: &mut russh::Channel<client::Msg>,
    shell_kind: &str,
    token: &str,
) -> Result<Vec<u8>, String> {
    let bootstrap = shell_integration::unix_bootstrap(shell_kind, token)?;
    channel
        .data_bytes(bootstrap.into_bytes())
        .await
        .map_err(|error| format!("发送 Shell Integration 初始化脚本失败：{error}"))?;

    let wait_for_prompt = async {
        let mut buffered = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    if buffered.len() + data.len() > shell_integration::MAX_OUTPUT_BYTES {
                        return Err("Shell Integration 初始化输出过大".to_string());
                    }
                    buffered.extend_from_slice(&data);
                    if let Some(output) =
                        shell_integration::take_prompt_output(&mut buffered, token)
                    {
                        return Ok(output);
                    }
                }
                ChannelMsg::ExitStatus { .. } | ChannelMsg::Eof | ChannelMsg::Close => {
                    return Err("Shell Integration 初始化期间远端 Shell 已关闭".to_string());
                }
                _ => {}
            }
        }
        Err("Shell Integration 初始化期间远端 Shell 已关闭".to_string())
    };

    timeout(shell_integration::INSTALL_TIMEOUT, wait_for_prompt)
        .await
        .map_err(|_| {
            format!(
                "Shell Integration 初始化超时（{} 秒）",
                shell_integration::INSTALL_TIMEOUT.as_secs()
            )
        })?
}
/// 使用独立 exec channel 探测登录 shell；失败或未知 shell 时关闭自动命令记录。
async fn detect_remote_shell(session: &client::Handle<ClientHandler>) -> Option<String> {
    let probe = async {
        let mut channel = session.channel_open_session().await.ok()?;
        channel.exec(true, "printf '%s' \"$SHELL\"").await.ok()?;

        let mut output = Vec::with_capacity(64);
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if output.len() + data.len() > 512 {
                        return None;
                    }
                    output.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { .. } | ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        close_channel(&channel).await;

        let shell = String::from_utf8(output).ok()?;
        shell_integration_kind(shell.trim())
    };

    timeout(SHELL_PROBE_TIMEOUT, probe).await.ok().flatten()
}

/// 仅对白名单内的 Bourne 风格 shell 启用临时 Shell Integration。
fn shell_integration_kind(shell: &str) -> Option<String> {
    let name = shell.rsplit('/').next()?.trim().to_ascii_lowercase();
    match name.as_str() {
        "bash" | "zsh" => Some(name),
        _ => None,
    }
}

/// 获取活动会话发送端并提交命令，避免持有共享表锁跨越 await。
async fn send_command(
    service: &SshService,
    session_id: &str,
    command: SshCommand,
) -> Result<(), String> {
    let sender = {
        let sessions = service.sessions.read().await;
        sessions
            .get(session_id)
            .map(|control| control.sender.clone())
            .ok_or_else(|| "SSH 会话不存在或已关闭".to_string())?
    };
    timeout(RESOURCE_CLOSE_TIMEOUT, sender.send(command))
        .await
        .map_err(|_| "SSH 命令排队超时".to_string())?
        .map_err(|_| "SSH 会话工作任务已停止".to_string())
}

/// SSH 终端 worker 的事件上下文；初始字节在启动时消费一次。
struct SshWorkerContext {
    /// 事件发布句柄。
    app: AppHandle,
    /// 当前终端会话标识。
    session_id: String,
    /// Shell Integration 完成后的初始真实输出。
    initial_output: Vec<u8>,
}

/// 等待取消或控制端消失；不持有 watch 借用跨 await。
async fn wait_for_cancellation(cancellation: &mut watch::Receiver<bool>) {
    loop {
        if *cancellation.borrow() {
            return;
        }
        if cancellation.changed().await.is_err() {
            return;
        }
    }
}

/// 驱动单个 SSH Channel；按顺序处理输入、窗口变化和远端输出。
async fn run_session_worker(
    context: SshWorkerContext,
    session: &client::Handle<ClientHandler>,
    channel: &mut russh::Channel<russh::client::Msg>,
    mut commands: mpsc::Receiver<SshCommand>,
    forwarding: &mut ForwardRuntime,
    sftp_sender: &mut Option<mpsc::Sender<SftpCommand>>,
) -> Result<Option<u32>, String> {
    let SshWorkerContext {
        app,
        session_id,
        initial_output,
    } = context;
    let mut exit_status = None;

    if !initial_output.is_empty() {
        app.emit(
            "ssh:data",
            SshDataEvent {
                session_id: session_id.clone(),
                data: initial_output,
            },
        )
        .map_err(|error| format!("发布 SSH 初始终端数据失败：{error}"))?;
    }

    let result: Result<(), String> = loop {
        tokio::select! {
            Some(message) = forwarding.errors.recv() => {
                if let Err(error) = app.emit("ssh:forward-error", SshErrorEvent { session_id: session_id.clone(), message }) {
                    break Err(format!("发布 SSH 转发错误失败：{error}"));
                }
            }
            command = commands.recv() => {
                match command {
                    Some(SshCommand::Input(data)) => {
                        if let Err(error) = channel.data_bytes(data).await {
                            break Err(format!("发送 SSH 终端输入失败：{error}"));
                        }
                    }
                    Some(SshCommand::Resize { columns, rows }) => {
                        if let Err(error) = channel.window_change(columns, rows, 0, 0).await {
                            break Err(format!("更新 SSH PTY 尺寸失败：{error}"));
                        }
                    }
                    Some(SshCommand::EnsureSftp { result }) => {
                        let existing = sftp_sender
                            .as_ref()
                            .filter(|sender| !sender.is_closed())
                            .cloned();
                        let worker = match existing {
                            Some(sender) => Ok(sender),
                            None => timeout(CONNECT_TIMEOUT, sftp::start_sftp_worker(session)).await
                                .unwrap_or_else(|_| Err("建立 SFTP 会话超时".into())),
                        };
                        if let Ok(sender) = &worker {
                            *sftp_sender = Some(sender.clone());
                        }
                        // 调用方取消时仍保留可复用 worker，结束会话时统一关闭。
                        if result.send(worker).is_err() { eprintln!("SFTP 请求接收方已取消"); }
                    }
                    None => {
                        break Ok(());
                    }
                }
            }
            message = channel.wait() => {
                match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if let Err(error) = app.emit(
                            "ssh:data",
                            SshDataEvent {
                                session_id: session_id.clone(),
                                data: data.to_vec(),
                            },
                        ) {
                            break Err(format!("发布 SSH 终端数据失败：{error}"));
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status: status }) => {
                        exit_status = Some(status);
                        break Ok(());
                    }
                    Some(ChannelMsg::Close) | None => {
                        break Ok(());
                    }
                    _ => {}
                }
            }
        }
    };

    result.map(|_| exit_status)
}

/// 校验所有外部连接参数，避免无效地址和异常尺寸进入网络层。
fn validate_connect_config(config: &SshConnectConfig) -> Result<(), String> {
    if config.session_id.trim().is_empty() || config.session_id.len() > MAX_SESSION_ID_BYTES {
        return Err("SSH 会话标识无效".to_string());
    }
    let target = SshHopConfig {
        host: config.host.trim().into(),
        port: config.port,
        username: config.username.trim().into(),
        auth_type: config.auth_type.clone(),
        password: config.password.clone(),
        key_path: config.key_path.clone(),
        key_passphrase: config.key_passphrase.clone(),
    };
    ssh_config::validate_hop(&target)?;
    ssh_config::validate_forwards(&config.forwards)?;
    if config.jump_hosts.len() > ssh_config::MAX_JUMP_HOSTS {
        return Err("跳板链过长".into());
    }
    let mut endpoints = std::collections::HashSet::new();
    for hop in config.jump_hosts.iter().chain(std::iter::once(&target)) {
        ssh_config::validate_hop(hop)?;
        if !endpoints.insert((hop.host.to_lowercase(), hop.port, hop.username.clone())) {
            return Err("跳板链存在循环端点".into());
        }
    }
    if let Some(token) = config.shell_integration_token.as_deref() {
        shell_integration::validate_token(token)?;
    }
    if config.x11
        && config
            .x11_server_address
            .as_ref()
            .is_none_or(|value| value.trim().is_empty() || value.len() > 255)
    {
        return Err("X11 Server 地址为空或过长".to_string());
    }
    if config.x11 {
        if let Some(path) = config.x11_linux_xauth_path.as_deref() {
            if path.trim().is_empty()
                || path.len() > MAX_CREDENTIAL_BYTES
                || !path.trim().starts_with('/')
                || path.chars().any(char::is_control)
            {
                return Err("xauth 路径必须是有效的绝对路径".to_string());
            }
        }
    }
    validate_terminal_size(config.columns, config.rows)
}

/// 校验 PTY 字符尺寸。
fn validate_terminal_size(columns: u32, rows: u32) -> Result<(), String> {
    if !(1..=MAX_COLUMNS).contains(&columns) || !(1..=MAX_ROWS).contains(&rows) {
        return Err(format!(
            "终端尺寸无效，列数范围 1..={MAX_COLUMNS}，行数范围 1..={MAX_ROWS}"
        ));
    }
    Ok(())
}
