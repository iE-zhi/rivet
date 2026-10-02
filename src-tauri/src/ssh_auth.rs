//! SSH 认证与键盘交互请求代理；响应仅驻留内存，超时或取消后立即失效。
//! Agent 平台传输局限于本机 Unix socket 或 Windows OpenSSH 命名管道。

use crate::ssh_config::{SshAuthType, SshHopConfig};
use russh::{
    client,
    keys::{
        agent::{
            client::{AgentClient, AgentStream},
            AgentIdentity,
        },
        decode_secret_key, PrivateKeyWithHashAlg,
    },
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio::{sync::oneshot, time::timeout};

/// 单次密码、私钥、Agent 或认证协议操作的等待上限。
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
/// 每轮用户输入等待上限，单位为秒。
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(120);
/// 一次认证最多处理 16 轮服务端提示，防止无限交互。
const MAX_AUTH_ROUNDS: usize = 16;
/// 每轮最多 16 个字段，包含无回显字段。
const MAX_PROMPTS: usize = 16;
/// 单条服务端文本和单条用户响应最多 4096 字节。
const MAX_FIELD_BYTES: usize = 4096;
/// 最多尝试 32 个 Agent 身份，避免无界签名请求。
const MAX_AGENT_IDENTITIES: usize = 32;
/// 单个私钥文件读取上限，单位为字节。
const MAX_PRIVATE_KEY_BYTES: u64 = 1024 * 1024;
/// 一次性认证请求标识的随机字节数。
const REQUEST_ID_BYTES: usize = 16;
/// 同时等待用户认证的请求上限，与 SSH 会话上限一致。
const MAX_PENDING_REQUESTS: usize = 64;
/// SSH 会话标识的最大字节数。
const MAX_SESSION_ID_BYTES: usize = 128;
/// Windows OpenSSH Agent 的标准本机管道；仅在显式选择 Agent 时访问。
#[cfg(windows)]
const OPENSSH_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

/// 服务端提示；echo 为 false 的输入不得显示或持久化。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthPrompt {
    /// 服务端字段标题，最多 4096 字节。
    pub(crate) prompt: String,
    /// 是否允许明文回显。
    pub(crate) echo: bool,
}

/// 发送给前端的一轮认证请求；请求标识不能跨会话复用。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthRequest {
    /// 所属终端会话。
    session_id: String,
    /// 一次性随机请求标识。
    request_id: String,
    /// 当前认证端点，包含跳板或最终主机。
    host: String,
    /// 服务端认证标题。
    name: String,
    /// 服务端本轮说明。
    instructions: String,
    /// 必须按原顺序回复的字段。
    prompts: Vec<AuthPrompt>,
}

/// 等待一次性用户响应的内部状态；互斥锁只用于短时查表，不跨 await。
struct PendingResponse {
    /// 仅接受此会话的响应。
    session_id: String,
    /// 必须匹配服务端本轮字段数。
    count: usize,
    /// 发送端仅被成功响应或取消消费一次。
    sender: oneshot::Sender<Option<Vec<String>>>,
}

/// 当前进程的认证提示表；每个已预留 SSH 会话最多保留一轮请求。
#[derive(Default, Clone)]
pub(crate) struct AuthBroker {
    /// 不持久化的请求表，由 ticket 负责取消清理。
    pending: Arc<Mutex<HashMap<String, PendingResponse>>>,
}

/// 单次用户响应；None 表示取消，Some 按服务端字段顺序回复。
pub(crate) type AuthResponse = Option<Vec<String>>;

/// 一次性请求的资源所有权；释放时从共享表撤销并关闭未消费的响应通道。
pub(crate) struct AuthRegistration {
    /// 共享请求表，不跨 await 持锁。
    broker: AuthBroker,
    /// 随机请求标识，在当前注册生命周期内有效。
    pub(crate) request_id: String,
}

impl Drop for AuthRegistration {
    /// 撤销剩余请求；锁中毒时恢复表以保证通道和排队状态仍得到清理。
    fn drop(&mut self) {
        match self.broker.pending.lock() {
            Ok(mut pending) => {
                pending.remove(&self.request_id);
            }
            Err(error) => {
                eprintln!("清理 SSH 认证请求时恢复已中毒的锁");
                error.into_inner().remove(&self.request_id);
            }
        }
    }
}

/// 在认证 future 完成、超时或取消时撤销请求并通知 UI 清空秘密。
struct PromptTicket {
    /// 请求注册的 RAII 生命周期。
    registration: AuthRegistration,
    /// 发布撤销事件的应用句柄。
    app: AppHandle,
}

impl Drop for PromptTicket {
    /// 撤销未消费响应；清理事件失败写入诊断，不记录用户输入。
    fn drop(&mut self) {
        if let Err(error) = self
            .app
            .emit("ssh:auth-ended", &self.registration.request_id)
        {
            eprintln!("发布 SSH 认证结束事件失败：{error}");
        }
    }
}

impl AuthBroker {
    /// 预留唯一请求与响应通道；拒绝无效输入、重复会话请求、过载及随机标识碰撞。
    pub(crate) fn register(
        &self,
        session_id: &str,
        count: usize,
    ) -> Result<(AuthRegistration, oneshot::Receiver<AuthResponse>), String> {
        if session_id.is_empty()
            || session_id.len() > MAX_SESSION_ID_BYTES
            || count == 0
            || count > MAX_PROMPTS
        {
            return Err("SSH 认证请求参数无效".into());
        }
        let mut random = [0u8; REQUEST_ID_BYTES];
        getrandom::fill(&mut random).map_err(|_| "生成 SSH 认证请求标识失败".to_string())?;
        let request_id = random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "SSH 认证请求锁不可用".to_string())?;
        if pending.len() >= MAX_PENDING_REQUESTS
            || pending
                .values()
                .any(|request| request.session_id == session_id)
            || pending.contains_key(&request_id)
        {
            return Err("SSH 认证请求已存在或数量达到上限".into());
        }
        let (sender, receiver) = oneshot::channel();
        pending.insert(
            request_id.clone(),
            PendingResponse {
                session_id: session_id.into(),
                count,
                sender,
            },
        );
        Ok((
            AuthRegistration {
                broker: self.clone(),
                request_id,
            },
            receiver,
        ))
    }

    /// 提交响应或取消；非法、过期及跨会话响应返回错误且不消费有效请求。
    pub(crate) fn respond(
        &self,
        session_id: &str,
        request_id: &str,
        responses: Option<Vec<String>>,
    ) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "SSH 认证请求锁不可用".to_string())?;
        let entry = pending.get(request_id).ok_or("SSH 认证请求已失效")?;
        if entry.session_id != session_id {
            return Err("SSH 认证请求不属于此会话".into());
        }
        if let Some(values) = &responses {
            validate_responses(entry.count, values)?;
        }
        let entry = pending.remove(request_id).ok_or("SSH 认证请求已失效")?;
        entry
            .sender
            .send(responses)
            .map_err(|_| "SSH 认证请求已取消".into())
    }

    /// 发布一轮服务端提示并等待用户响应；ticket 保证超时与取消时撤销请求。
    async fn ask(
        &self,
        app: &AppHandle,
        session_id: &str,
        hop: &SshHopConfig,
        name: String,
        instructions: String,
        prompts: Vec<client::Prompt>,
    ) -> Result<Vec<String>, String> {
        if prompts.len() > MAX_PROMPTS
            || name.len() > MAX_FIELD_BYTES
            || instructions.len() > MAX_FIELD_BYTES
            || prompts.iter().any(|p| p.prompt.len() > MAX_FIELD_BYTES)
        {
            return Err("SSH 认证提示过多或过长".into());
        }
        // 空提示无需 UI 输入；仍由认证循环的轮数上限约束。
        if prompts.is_empty() {
            return Ok(Vec::new());
        }
        let (registration, receiver) = self.register(session_id, prompts.len())?;
        let request_id = registration.request_id.clone();
        let _ticket = PromptTicket {
            registration,
            app: app.clone(),
        };
        app.emit(
            "ssh:auth-request",
            AuthRequest {
                session_id: session_id.into(),
                request_id,
                host: format!("{}@{}:{}", hop.username, hop.host, hop.port),
                name,
                instructions,
                prompts: prompts
                    .into_iter()
                    .map(|p| AuthPrompt {
                        prompt: p.prompt,
                        echo: p.echo,
                    })
                    .collect(),
            },
        )
        .map_err(|e| format!("发布 SSH 认证请求失败：{e}"))?;
        timeout(RESPONSE_TIMEOUT, receiver)
            .await
            .map_err(|_| "SSH 认证输入超时".to_string())?
            .map_err(|_| "SSH 认证请求已关闭".to_string())?
            .ok_or_else(|| "SSH 认证已取消".into())
    }
}

/// 校验响应数量及单字段字节数，不回显秘密内容。
pub(crate) fn validate_responses(count: usize, values: &[String]) -> Result<(), String> {
    if count > MAX_PROMPTS
        || values.len() != count
        || values.iter().any(|s| s.len() > MAX_FIELD_BYTES)
    {
        return Err("SSH 认证响应数量或长度无效".into());
    }
    Ok(())
}

/// 从普通文件限量读取 UTF-8 私钥并解密；拒绝设备、空文件、超限与格式错误。
pub(crate) fn load_private_key(
    path: &str,
    passphrase: Option<&str>,
) -> Result<russh::keys::PrivateKey, String> {
    use std::io::Read;
    // 打开前拒绝设备和 FIFO；打开后再次确认实际句柄类型与大小。
    let metadata = std::fs::metadata(path).map_err(|e| format!("读取 SSH 私钥元数据失败：{e}"))?;
    if !metadata.is_file() {
        return Err("SSH 私钥必须是普通文件".into());
    }
    let file = std::fs::File::open(path).map_err(|e| format!("打开 SSH 私钥失败：{e}"))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("读取 SSH 私钥元数据失败：{e}"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_PRIVATE_KEY_BYTES {
        return Err("SSH 私钥必须是非空、大小不超过 1 MiB 的普通文件".into());
    }
    // 同时限制实际读取大小，文件在元数据校验后增长也不会导致无界分配。
    let mut secret = String::new();
    file.take(MAX_PRIVATE_KEY_BYTES + 1)
        .read_to_string(&mut secret)
        .map_err(|e| format!("读取 SSH 私钥失败：{e}"))?;
    if secret.len() as u64 > MAX_PRIVATE_KEY_BYTES {
        return Err("SSH 私钥大小超过上限".into());
    }
    decode_secret_key(&secret, passphrase).map_err(|e| format!("解析 SSH 私钥失败：{e}"))
}

/// 连接本机 Agent；平台服务未运行时返回可见错误，绝不启动服务或导入密钥。
async fn connect_agent() -> Result<AgentClient<Box<dyn AgentStream + Send + Unpin>>, String> {
    #[cfg(unix)]
    let agent = AgentClient::connect_env().await;
    #[cfg(windows)]
    let agent = AgentClient::connect_named_pipe(
        std::env::var_os("SSH_AUTH_SOCK").unwrap_or_else(|| OPENSSH_AGENT_PIPE.into()),
    )
    .await;
    agent
        .map(AgentClient::dynamic)
        .map_err(|e| format!("连接本机 SSH Agent 失败：{e}"))
}

/// 认证一个端点；协议操作分别限时，交互字段逐轮在内存中消费。
pub(crate) async fn authenticate<H: client::Handler>(
    session: &mut client::Handle<H>,
    hop: &SshHopConfig,
    app: &AppHandle,
    session_id: &str,
    broker: &AuthBroker,
) -> Result<(), String> {
    authenticate_with_prompts(session, hop, |name, instructions, prompts| {
        broker.ask(app, session_id, hop, name, instructions, prompts)
    })
    .await
}

/// 驱动所选首因素认证并自动续接服务端交互；提示回调仅拥有本轮数据，可返回取消错误。
pub(crate) async fn authenticate_with_prompts<H, F, Fut>(
    session: &mut client::Handle<H>,
    hop: &SshHopConfig,
    ask: F,
) -> Result<(), String>
where
    H: client::Handler,
    F: FnMut(String, String, Vec<client::Prompt>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<String>, String>>,
{
    let username = hop.username.trim();
    let authentication = async {
        match hop.auth_type {
            SshAuthType::Password => session
                .authenticate_password(username, hop.password.as_deref().ok_or("缺少 SSH 密码")?)
                .await
                .map_err(|e| format!("SSH 密码认证失败：{e}")),
            SshAuthType::PrivateKey => {
                let key_path = hop.key_path.clone().ok_or("缺少 SSH 私钥路径")?;
                let passphrase = hop.key_passphrase.clone().filter(|s| !s.is_empty());
                // 文件读取和解密不占用异步运行时线程；任务只拥有本轮秘密副本。
                let key = tauri::async_runtime::spawn_blocking(move || {
                    load_private_key(&key_path, passphrase.as_deref())
                })
                .await
                .map_err(|e| format!("读取 SSH 私钥任务失败：{e}"))?
                .map_err(|e| format!("读取 SSH 私钥失败：{e}"))?;
                let hash = session
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| format!("协商 SSH 签名算法失败：{e}"))?
                    .flatten();
                session
                    .authenticate_publickey(
                        username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await
                    .map_err(|e| format!("SSH 私钥认证失败：{e}"))
            }
            SshAuthType::Agent => {
                let mut agent = connect_agent().await?;
                authenticate_with_agent(session, username, &mut agent).await
            }
        }
    };
    let result = timeout(AUTH_TIMEOUT, authentication)
        .await
        .map_err(|_| "SSH 认证超时".to_string())??;
    finish_authentication(session, username, &hop.auth_type, result, ask).await
}

/// 自动处理服务端交互；密码方式允许服务器采用交互式密码/验证码，公钥方式必须先部分成功。
/// `auth_type` 是用户选择的首因素；未提供交互协议或公钥被拒绝时返回认证失败。
pub(crate) async fn finish_authentication<H, F, Fut>(
    session: &mut client::Handle<H>,
    username: &str,
    auth_type: &SshAuthType,
    result: client::AuthResult,
    ask: F,
) -> Result<(), String>
where
    H: client::Handler,
    F: FnMut(String, String, Vec<client::Prompt>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<String>, String>>,
{
    match result {
        client::AuthResult::Success => Ok(()),
        client::AuthResult::Failure {
            partial_success,
            remaining_methods,
        } if remaining_methods.contains(&russh::MethodKind::KeyboardInteractive)
            && (partial_success || matches!(auth_type, SshAuthType::Password)) =>
        {
            // 只协商服务器声明的交互协议；未通过公钥首因素时不降级为密码登录。
            authenticate_interactive(session, username, ask).await
        }
        _ => Err("SSH 认证被服务器拒绝".into()),
    }
}

/// 驱动有界键盘交互轮次；协议逐次限时，用户响应由一次性提示回调拥有。
async fn authenticate_interactive<H, F, Fut>(
    session: &mut client::Handle<H>,
    username: &str,
    mut ask: F,
) -> Result<(), String>
where
    H: client::Handler,
    F: FnMut(String, String, Vec<client::Prompt>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<String>, String>>,
{
    let mut response = timeout(
        AUTH_TIMEOUT,
        session.authenticate_keyboard_interactive_start(username, None),
    )
    .await
    .map_err(|_| "SSH 认证协议超时".to_string())?
    .map_err(|e| format!("SSH 验证交互失败：{e}"))?;
    for _ in 0..MAX_AUTH_ROUNDS {
        match response {
            client::KeyboardInteractiveAuthResponse::Success => return Ok(()),
            client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err("SSH 身份验证被服务器拒绝".into())
            }
            client::KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let values = ask(name, instructions, prompts).await?;
                response = timeout(
                    AUTH_TIMEOUT,
                    session.authenticate_keyboard_interactive_respond(values),
                )
                .await
                .map_err(|_| "SSH 认证协议超时".to_string())?
                .map_err(|e| format!("SSH 验证交互失败：{e}"))?;
            }
        }
    }
    if matches!(response, client::KeyboardInteractiveAuthResponse::Success) {
        Ok(())
    } else {
        Err("SSH 身份验证轮数超限".into())
    }
}

/// 使用已连接 Agent 的身份完成签名认证；仅尝试有界身份列表，不读取私钥。
pub(crate) async fn authenticate_with_agent<H, S>(
    session: &mut client::Handle<H>,
    username: &str,
    agent: &mut AgentClient<S>,
) -> Result<client::AuthResult, String>
where
    H: client::Handler,
    S: AgentStream + Send + Unpin,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| format!("读取 SSH Agent 身份失败：{e}"))?;
    if identities.is_empty() {
        return Err("SSH Agent 中没有可用身份".into());
    }
    let hash = session
        .best_supported_rsa_hash()
        .await
        .map_err(|e| format!("协商 SSH 签名算法失败：{e}"))?
        .flatten();
    // 保留最后拒绝结果；首因素部分成功后不得继续尝试其他身份。
    let mut last = client::AuthResult::Failure {
        remaining_methods: russh::MethodSet::empty(),
        partial_success: false,
    };
    for identity in identities.into_iter().take(MAX_AGENT_IDENTITIES) {
        let result = match identity {
            AgentIdentity::PublicKey { key, .. } => {
                session
                    .authenticate_publickey_with(username, key, hash, agent)
                    .await
            }
            AgentIdentity::Certificate { certificate, .. } => {
                session
                    .authenticate_certificate_with(username, certificate, hash, agent)
                    .await
            }
        }
        .map_err(|e| format!("SSH Agent 签名认证失败：{e}"))?;
        if result.success()
            || matches!(
                result,
                client::AuthResult::Failure {
                    partial_success: true,
                    ..
                }
            )
        {
            return Ok(result);
        }
        last = result;
    }
    Ok(last)
}
