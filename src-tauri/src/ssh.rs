//! SSH 终端会话服务。
//!
//! 本模块负责建立 SSH 客户端连接、认证、PTY Shell、输入输出转发和窗口尺寸同步。
//! 活动会话仅保存在进程内存中；密码和私钥口令不会写入持久化存储。

use std::{collections::HashMap, error::Error as StdError, fmt, sync::Arc, time::Duration};

use crate::sftp::{self, SftpCommand};
use crate::x11::{self, X11ForwardConfig};
use russh::{
    client,
    keys::{
        check_known_hosts, known_hosts::learn_known_hosts, load_secret_key, PrivateKeyWithHashAlg,
        PublicKeyOrCertificate,
    },
    ChannelMsg, Disconnect,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    sync::{mpsc, oneshot, RwLock},
    time::timeout,
};

/// TCP 连接和 SSH 密钥交换的最大等待时间，单位为秒。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// SSH 用户认证的最大等待时间，单位为秒。
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
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

/// SSH 认证方式。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SshAuthType {
    /// 使用用户名和密码认证。
    Password,
    /// 使用 OpenSSH 私钥文件认证。
    PrivateKey,
}

/// 前端提交的 SSH 连接参数。
#[derive(Debug, Deserialize)]
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
    /// X11 转发连接的本机 X Server TCP 地址；仅在启用 X11 时使用。
    pub x11_server_address: Option<String>,
    /// Linux 本机 xauth 可执行文件路径；仅在启用 X11 时使用。
    pub x11_linux_xauth_path: Option<String>,
    /// 初始 PTY 列数。
    pub columns: u32,
    /// 初始 PTY 行数。
    pub rows: u32,
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
    /// 主动关闭当前会话。
    Close,
}

/// 活动 SSH 会话表；每个会话只暴露一个有界命令发送端。
#[derive(Default)]
pub struct SshService {
    sessions: Arc<RwLock<HashMap<String, mpsc::Sender<SshCommand>>>>,
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
    host: String,
    port: u16,
    x11: Option<X11ForwardConfig>,
    app: AppHandle,
    session_id: String,
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
                    let _ = app.emit(
                        "ssh:x11-error",
                        SshErrorEvent {
                            session_id,
                            message,
                        },
                    );
                }
            });
            Ok(())
        }
    }
}

/// 建立 SSH PTY Shell，并在成功后启动独立异步 worker。
#[tauri::command]
pub async fn open_ssh_session(
    app: AppHandle,
    service: State<'_, SshService>,
    config: SshConnectConfig,
) -> Result<(), String> {
    validate_connect_config(&config)?;

    {
        let sessions = service.sessions.read().await;
        if sessions.contains_key(&config.session_id) {
            return Err("SSH 会话标识已存在".to_string());
        }
    }

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

    let handler = ClientHandler {
        host: host.clone(),
        port,
        x11: x11_config.clone(),
        app: app.clone(),
        session_id: session_id.clone(),
    };
    let client_config = Arc::new(client::Config::default());
    let mut session = timeout(
        CONNECT_TIMEOUT,
        client::connect(client_config, (host.as_str(), port), handler),
    )
    .await
    .map_err(|_| format!("连接 SSH 主机超时（{} 秒）", CONNECT_TIMEOUT.as_secs()))?
    .map_err(|error| format!("SSH 连接失败：{error}"))?;

    let authenticated = match config.auth_type {
        SshAuthType::Password => {
            let password = config
                .password
                .as_deref()
                .ok_or_else(|| "密码不能为空".to_string())?;
            timeout(
                AUTH_TIMEOUT,
                session.authenticate_password(username.clone(), password),
            )
            .await
            .map_err(|_| format!("SSH 认证超时（{} 秒）", AUTH_TIMEOUT.as_secs()))?
            .map_err(|error| format!("SSH 密码认证失败：{error}"))?
            .success()
        }
        SshAuthType::PrivateKey => {
            let key_path = config
                .key_path
                .as_deref()
                .filter(|path| !path.trim().is_empty())
                .ok_or_else(|| "私钥路径不能为空".to_string())?;
            let passphrase = config
                .key_passphrase
                .as_deref()
                .filter(|value| !value.is_empty());
            let private_key = load_secret_key(key_path, passphrase)
                .map_err(|error| format!("读取 SSH 私钥失败：{error}"))?;
            let hash_algorithm = session
                .best_supported_rsa_hash()
                .await
                .map_err(|error| format!("协商 SSH 私钥算法失败：{error}"))?
                .flatten();
            timeout(
                AUTH_TIMEOUT,
                session.authenticate_publickey(
                    username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(private_key), hash_algorithm),
                ),
            )
            .await
            .map_err(|_| format!("SSH 认证超时（{} 秒）", AUTH_TIMEOUT.as_secs()))?
            .map_err(|error| format!("SSH 私钥认证失败：{error}"))?
            .success()
        }
    };

    if !authenticated {
        return Err("SSH 认证被服务器拒绝".to_string());
    }

    let mut channel = session
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
    if let Some(x11) = x11_config.as_ref() {
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

    let (command_sender, command_receiver) = mpsc::channel(COMMAND_QUEUE_CAPACITY);
    {
        let mut sessions = service.sessions.write().await;
        if sessions.contains_key(&session_id) {
            return Err("SSH 会话标识已存在".to_string());
        }
        sessions.insert(session_id.clone(), command_sender);
    }

    let sessions = Arc::clone(&service.sessions);
    tauri::async_runtime::spawn(async move {
        let result = run_session_worker(
            app.clone(),
            session_id.clone(),
            &mut session,
            &mut channel,
            command_receiver,
        )
        .await;

        if let Err(message) = result {
            let _ = app.emit(
                "ssh:error",
                SshErrorEvent {
                    session_id: session_id.clone(),
                    message,
                },
            );
        }

        sessions.write().await.remove(&session_id);
    });

    Ok(())
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
    send_command(&service, &session_id, SshCommand::Close).await
}

/// 请求活动 SSH worker 创建或复用对应 SFTP worker。
pub(crate) async fn request_sftp_sender(
    service: &SshService,
    session_id: &str,
) -> Result<mpsc::Sender<SftpCommand>, String> {
    let shell_sender = {
        let sessions = service.sessions.read().await;
        sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| "SSH 会话不存在或已关闭".to_string())?
    };
    let (result_sender, result_receiver) = oneshot::channel();
    shell_sender
        .send(SshCommand::EnsureSftp {
            result: result_sender,
        })
        .await
        .map_err(|_| "SSH 会话工作任务已停止".to_string())?;
    result_receiver
        .await
        .map_err(|_| "SSH worker 未返回 SFTP 会话结果".to_string())?
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
            .cloned()
            .ok_or_else(|| "SSH 会话不存在或已关闭".to_string())?
    };
    sender
        .send(command)
        .await
        .map_err(|_| "SSH 会话工作任务已停止".to_string())
}

/// 驱动单个 SSH Channel；按顺序处理输入、窗口变化和远端输出。
async fn run_session_worker(
    app: AppHandle,
    session_id: String,
    session: &mut client::Handle<ClientHandler>,
    channel: &mut russh::Channel<russh::client::Msg>,
    mut commands: mpsc::Receiver<SshCommand>,
) -> Result<(), String> {
    let mut exit_status = None;
    let mut sftp_sender: Option<mpsc::Sender<SftpCommand>> = None;

    let result: Result<(), String> = loop {
        tokio::select! {
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
                            None => sftp::start_sftp_worker(session).await,
                        };
                        if let Ok(sender) = &worker {
                            sftp_sender = Some(sender.clone());
                        }
                        let _ = result.send(worker);
                    }
                    Some(SshCommand::Close) | None => {
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

    if let Some(sender) = sftp_sender.take() {
        let _ = sender.send(SftpCommand::Close).await;
    }

    // 无论正常关闭还是 I/O 失败都显式释放远端通道和 SSH 连接。
    let _ = channel.eof().await;
    let _ = channel.close().await;
    let _ = session
        .disconnect(Disconnect::ByApplication, "", "English")
        .await;

    if result.is_ok() {
        let _ = app.emit(
            "ssh:closed",
            SshClosedEvent {
                session_id,
                exit_status,
            },
        );
    }

    result
}

/// 校验所有外部连接参数，避免无效地址和异常尺寸进入网络层。
fn validate_connect_config(config: &SshConnectConfig) -> Result<(), String> {
    if config.session_id.trim().is_empty() || config.session_id.len() > 128 {
        return Err("SSH 会话标识无效".to_string());
    }
    if config.host.trim().is_empty() || config.host.len() > 255 {
        return Err("SSH 主机不能为空或过长".to_string());
    }
    if config.port == 0 {
        return Err("SSH 端口必须大于 0".to_string());
    }
    if config.username.trim().is_empty() || config.username.len() > 128 {
        return Err("SSH 用户名不能为空或过长".to_string());
    }
    if config
        .password
        .as_ref()
        .is_some_and(|value| value.len() > MAX_CREDENTIAL_BYTES)
        || config
            .key_path
            .as_ref()
            .is_some_and(|value| value.len() > MAX_CREDENTIAL_BYTES)
        || config
            .key_passphrase
            .as_ref()
            .is_some_and(|value| value.len() > MAX_CREDENTIAL_BYTES)
    {
        return Err("SSH 认证字段过长".to_string());
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
