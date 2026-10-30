//! 独立 VNC 会话服务与 Tauri 命令；拥有 TCP/协议任务、有界输入队列和最新桌面。
//! 仅支持直连标准 RFB，不访问 SSH 的连接、配置或会话状态。

use crate::{credential_store, vnc_frame::VncFrame, vnc_transport::VncTransport};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{ipc::Response, State};
use tokio::{
    net::TcpStream,
    sync::{mpsc, watch, Notify},
    time::{interval, timeout, MissedTickBehavior},
};
use vnc::{PixelFormat, VncClient, VncConnector, VncEncoding, VncEvent, X11Event};

/// 同时最多四个 VNC 桌面，限制连接和图像内存总量。
pub(crate) const MAX_VNC_SESSIONS: usize = 4;
/// TCP 连接、认证与初始化共用十五秒总超时。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 每次输入写入或协议关闭最多等待两秒，避免队列拥塞阻塞清理。
const INPUT_TIMEOUT: Duration = Duration::from_secs(2);
/// 协议事件每两毫秒检查一次，不占用线程忙等。
const EVENT_INTERVAL: Duration = Duration::from_millis(2);
/// 活跃桌面最多每四毫秒请求一次变化图像，允许高刷新率显示并限制请求积压。
const REFRESH_INTERVAL: Duration = Duration::from_millis(4);
/// 静止画面的取帧请求最多等待二百五十毫秒，期间由图像或状态变化唤醒。
const FRAME_WAIT_TIMEOUT: Duration = Duration::from_millis(250);
/// 前端两秒未取帧时停止主动刷新，后台会话保持连接。
const VIEW_IDLE_TIMEOUT: Duration = Duration::from_secs(2);
/// 输入队列最多容纳一百二十八个批次；满时向前端返回错误。
const INPUT_QUEUE_CAPACITY: usize = 128;
/// 每个批次最多六十四个键鼠事件，限制单次 IPC 的处理开销。
const MAX_INPUT_BATCH: usize = 64;
/// 每轮最多处理一千零二十四个区域事件，避免 4K 的分块图像被低批量上限阻塞。
const MAX_EVENTS_PER_TICK: usize = 1024;
/// 单轮图像处理最多占用两毫秒，随后交还调度以处理输入、取消及其他会话。
const EVENT_BATCH_BUDGET: Duration = Duration::from_millis(2);
/// 单条可见协议错误最多一千零二十四个字符，不保留无限远端文本。
const MAX_ERROR_CHARS: usize = 1024;

/// 已校验后才能建立会话的配置；camelCase 为前端 IPC 表示，不持久化密码。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VncOpenRequest {
    /// 前端生成的唯一会话标识，长度 1..=128，不允许控制字符。
    pub(crate) session_id: String,
    /// 独立 VNC 连接标识，用于读取该连接的加密密码。
    pub(crate) connection_id: String,
    /// DNS 名称或 IP，不接受 URL、空白或控制字符，最多 255 字节。
    pub(crate) host: String,
    /// TCP 端口，范围 1..=65535。
    pub(crate) port: u16,
    /// password 使用传统 VNC 密码；none 必须由用户显式选择。
    pub(crate) auth_type: String,
    /// 临时密码；None 从本地加密存储读取，不写入连接列表。
    pub(crate) password: Option<String>,
    /// 此会话是否拒绝所有键鼠写入；建立后不可被前端输入绕过。
    pub(crate) read_only: bool,
}

/// 一个输入事件；使用带标签 JSON，未知字段与未知种类均被拒绝。
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum VncInput {
    /// X11 keysym 按下或释放事件。
    Key {
        /// 标准 X11 keysym 或 Unicode keysym，零值非法。
        key: u32,
        /// true 按下，false 释放。
        down: bool,
    },
    /// 远端像素坐标与 RFB 鼠标按键位图。
    Pointer {
        /// 从左边起的像素坐标，必须小于当前桌面宽度。
        x: u16,
        /// 从顶部起的像素坐标，必须小于当前桌面高度。
        y: u16,
        /// 左、中、右、上下滚轮五个低位，高位拒绝。
        buttons: u8,
    },
}

/// 同一会话共享的桌面与消费者活动时间；只通过短时互斥锁访问，不跨 await 持锁。
struct SharedFrame {
    /// 最近像素、状态与错误，独立于前端标签生命周期。
    frame: VncFrame,
    /// 前端最近取帧的单调时间，用来停止隐藏页面的刷新请求。
    last_poll: Instant,
    /// 图像或状态变化通知；只保留一个唤醒许可，不累积图像消息或跨 await 持锁。
    changed: Arc<Notify>,
}

/// 注册表拥有的会话句柄；Drop 关闭取消通道，后台任务随后关闭协议客户端。
struct VncSession {
    /// 保护最新桌面的短时锁，与注册表锁按注册表在先的顺序获取。
    shared: Arc<Mutex<SharedFrame>>,
    /// 有界输入发送端；后台任务退出后发送返回错误。
    input: mpsc::Sender<Vec<VncInput>>,
    /// 取消发送端只由此句柄持有；移除会话即可取消连接或运行中的任务。
    _cancel: watch::Sender<()>,
    /// 服务端执行的只读约束，整个会话生命周期固定。
    read_only: bool,
}

/// 应用级独立 VNC 注册表；最多四个会话，锁内不做网络、磁盘或异步等待。
#[derive(Default)]
pub(crate) struct VncService {
    /// 会话 ID 到资源句柄的映射；关闭或应用退出时释放句柄触发取消。
    sessions: Mutex<HashMap<String, VncSession>>,
}

/// 校验独立连接/会话标识，拒绝控制字符和空值。
///
/// # 参数
/// - `id`：不可信 IPC 标识，长度单位为 UTF-8 字节，范围 1..=128。
///
/// # Errors
/// 输入不符合约束时返回用户可见错误，不修改服务状态。
pub(crate) fn validate_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        return Err("VNC 标识无效".into());
    }
    Ok(())
}

/// 校验传统 VNC 密码；协议有效密码最多八个单字节 ASCII 字符，避免静默截断。
///
/// # 参数
/// - `password`：仅在内存使用的认证秘密；允许空值用于删除已保存密码。
///
/// # Errors
/// 超过八字节、非 ASCII 或包含控制字符时拒绝。
pub(crate) fn validate_password(password: &str) -> Result<(), String> {
    if password.len() > 8 || !password.is_ascii() || password.chars().any(char::is_control) {
        return Err("标准 VNC 密码最多八个 ASCII 字符".into());
    }
    Ok(())
}

impl VncOpenRequest {
    /// 校验全部连接参数；失败时尚未分配会话或打开网络连接。
    ///
    /// # Errors
    /// 非法标识、主机、端口、认证方式或临时密码返回错误。
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_id(&self.session_id)?;
        validate_id(&self.connection_id)?;
        if self.host.is_empty()
            || self.host.len() > 255
            || self
                .host
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
            || self.host.contains(['/', '\\', '@', '[', ']'])
            || self.port == 0
        {
            return Err("VNC 主机或端口无效".into());
        }
        if self.auth_type != "password" && self.auth_type != "none" {
            return Err("VNC 认证方式无效".into());
        }
        if let Some(password) = &self.password {
            validate_password(password)?;
            if self.auth_type == "password" && password.is_empty() {
                return Err("请输入 VNC 密码".into());
            }
        }
        Ok(())
    }
}

impl VncService {
    /// 注册独立 VNC 会话并启动可取消握手；返回后通过 vnc_poll_frame 观察连接结果。
    ///
    /// # 参数
    /// - `request`：前端连接配置，包含临时密码时只交给该任务使用。
    ///
    /// # Errors
    /// 参数无效、重复会话、超过并发上限或锁损坏时不启动任务。
    pub(crate) fn open(&self, request: VncOpenRequest) -> Result<(), String> {
        request.validate()?;
        let mut sessions = self.sessions.lock().map_err(|_| "VNC 会话锁已损坏")?;
        if sessions.contains_key(&request.session_id) || sessions.len() >= MAX_VNC_SESSIONS {
            return Err("VNC 会话重复或已达到四个会话的上限".into());
        }
        let shared = Arc::new(Mutex::new(SharedFrame {
            frame: VncFrame::default(),
            last_poll: Instant::now(),
            changed: Arc::new(Notify::new()),
        }));
        let (input, receiver) = mpsc::channel(INPUT_QUEUE_CAPACITY);
        let (cancel, cancelled) = watch::channel(());
        sessions.insert(
            request.session_id.clone(),
            VncSession {
                shared: Arc::clone(&shared),
                input,
                _cancel: cancel,
                read_only: request.read_only,
            },
        );
        // 任务独占请求中的密码、输入接收端和取消接收端；注册表移除后取消优先执行。
        tauri::async_runtime::spawn(run_session(request, shared, receiver, cancelled));
        Ok(())
    }

    /// 读取并消费最新脏区域；二进制响应由 Tauri 直接交给前端，不累积帧队列。
    ///
    /// # 参数
    /// - `session_id`：待读取的有效会话 ID。
    /// - `full`：true 返回完整桌面，false 只返回自上次读取以来的变化。
    ///
    /// # Errors
    /// 会话不存在或锁损坏时返回错误；调用方停止取帧并显示失败状态。
    pub(crate) fn snapshot(&self, session_id: &str, full: bool) -> Result<Vec<u8>, String> {
        let shared = {
            let sessions = self.sessions.lock().map_err(|_| "VNC 会话锁已损坏")?;
            Arc::clone(&sessions.get(session_id).ok_or("VNC 会话不存在")?.shared)
        };
        // 图像复制只持有本会话的锁，不占用全局注册表锁。
        let mut shared = shared.lock().map_err(|_| "VNC 图像锁已损坏")?;
        shared.last_poll = Instant::now();
        Ok(shared.frame.snapshot(full))
    }

    /// 等到变化区域、终态或有限超时后返回快照；等待时释放所有锁，不排队保存旧帧。
    ///
    /// # 参数
    /// - `session_id`：目标会话 ID，仅用于查询已有句柄。
    /// - `full`：true 立即返回完整桌面；false 在已连接且无变化时等待通知。
    ///
    /// # Errors
    /// 会话不存在或锁损坏时返回错误；取消等待不消费区域，允许后续请求重试。
    pub(crate) async fn next_frame(&self, session_id: &str, full: bool) -> Result<Vec<u8>, String> {
        if full {
            return self.snapshot(session_id, true);
        }
        let shared = {
            let sessions = self.sessions.lock().map_err(|_| "VNC 会话锁已损坏")?;
            Arc::clone(&sessions.get(session_id).ok_or("VNC 会话不存在")?.shared)
        };
        // notify_one 会保留一个许可，检查区域到开始等待之间发生的更新不会丢失。
        let changed = {
            let mut current = shared.lock().map_err(|_| "VNC 图像锁已损坏")?;
            current.last_poll = Instant::now();
            Arc::clone(&current.changed)
        };
        let wait = async {
            loop {
                {
                    let mut current = shared.lock().map_err(|_| "VNC 图像锁已损坏")?;
                    if current.frame.has_changes() || current.frame.state != 1 {
                        return Ok(current.frame.snapshot(false));
                    }
                }
                changed.notified().await;
            }
        };
        match timeout(FRAME_WAIT_TIMEOUT, wait).await {
            Ok(result) => result,
            Err(_) => {
                let mut current = shared.lock().map_err(|_| "VNC 图像锁已损坏")?;
                Ok(current.frame.snapshot(false))
            }
        }
    }

    /// 将有限的键鼠批次加入会话队列；只读会话、越界坐标和积压均拒绝。
    ///
    /// # 参数
    /// - `session_id`：目标会话 ID，不会匹配 SSH 会话。
    /// - `events`：最多六十四个事件，按数组顺序发送；失败时整个批次均不入队。
    ///
    /// # Errors
    /// 只读、未连接、输入非法、队列已满或关闭时返回错误，不静默丢弃按键。
    pub(crate) fn send(&self, session_id: &str, events: Vec<VncInput>) -> Result<(), String> {
        if events.is_empty() || events.len() > MAX_INPUT_BATCH {
            return Err("VNC 输入批次无效".into());
        }
        let sessions = self.sessions.lock().map_err(|_| "VNC 会话锁已损坏")?;
        let session = sessions.get(session_id).ok_or("VNC 会话不存在")?;
        if session.read_only {
            return Err("VNC 会话为只读模式".into());
        }
        {
            let shared = session.shared.lock().map_err(|_| "VNC 图像锁已损坏")?;
            if shared.frame.state != 1 {
                return Err("VNC 尚未连接".into());
            }
            for event in &events {
                match event {
                    VncInput::Key { key, .. } if *key == 0 || *key > 0x0110_ffff => {
                        return Err("VNC 按键无效".into())
                    }
                    VncInput::Pointer { x, y, buttons }
                        if *x >= shared.frame.width
                            || *y >= shared.frame.height
                            || *buttons > 31 =>
                    {
                        return Err("VNC 鼠标输入无效".into())
                    }
                    _ => {}
                }
            }
        }
        session
            .input
            .try_send(events)
            .map_err(|error| format!("VNC 输入队列不可用：{error}"))
    }

    /// 幂等移除会话；关闭取消发送端，后台任务释放 TCP 和协议资源。
    ///
    /// # 参数
    /// - `session_id`：要关闭的会话 ID；不存在时仍成功。
    ///
    /// # Errors
    /// 注册表锁损坏时返回错误。
    pub(crate) fn close(&self, session_id: &str) -> Result<(), String> {
        self.sessions
            .lock()
            .map_err(|_| "VNC 会话锁已损坏")?
            .remove(session_id);
        Ok(())
    }
}

/// 注册独立 VNC 会话，连接结果通过取帧接口传回。
///
/// # 参数
/// - `service`：应用拥有的独立 VNC 注册表。
/// - `request`：必须通过服务校验的连接请求，秘密只交给连接任务。
///
/// # Errors
/// 参数、并发上限或注册表错误原样返回，不启动未注册的连接。
#[tauri::command]
pub(crate) fn open_vnc_session(
    service: State<'_, VncService>,
    request: VncOpenRequest,
) -> Result<(), String> {
    service.open(request)
}

/// 返回当前会话的二进制变化区域；静止画面异步等待通知，最长二百五十毫秒。
///
/// # 参数
/// - `service`：应用拥有的 VNC 注册表。
/// - `session_id`：目标会话 ID。
/// - `full`：新建或恢复显示的 Canvas 传 true，其他轮询传 false。
///
/// # Errors
/// 不存在的会话或损坏锁返回错误，不创建新资源。
#[tauri::command]
pub(crate) async fn vnc_poll_frame(
    service: State<'_, VncService>,
    session_id: String,
    full: bool,
) -> Result<Response, String> {
    service
        .next_frame(&session_id, full)
        .await
        .map(Response::new)
}

/// 校验后将有序输入交给所属 VNC 会话。
///
/// # 参数
/// - `service`：应用拥有的 VNC 注册表。
/// - `session_id`：目标会话 ID。
/// - `events`：最多六十四个键鼠事件，整个批次共同接受或拒绝。
///
/// # Errors
/// 只读、越界、状态或队列错误原样返回前端。
#[tauri::command]
pub(crate) fn vnc_send_input(
    service: State<'_, VncService>,
    session_id: String,
    events: Vec<VncInput>,
) -> Result<(), String> {
    service.send(&session_id, events)
}

/// 幂等关闭并注销一个会话。
///
/// # 参数
/// - `service`：应用拥有的 VNC 注册表。
/// - `session_id`：目标会话 ID；不存在仍返回成功。
///
/// # Errors
/// 注册表锁损坏时返回错误，调用方保留该窗格用于显示失败。
#[tauri::command]
pub(crate) fn close_vnc_session(
    service: State<'_, VncService>,
    session_id: String,
) -> Result<(), String> {
    service.close(&session_id)
}

/// 读取独立 VNC 加密密码；不复用 SSH 连接标识空间。
///
/// # 参数
/// - `connection_id`：独立 VNC 连接 ID，必须通过标识校验。
///
/// # Errors
/// 文件读取、解密或后台任务失败时向前端返回错误。
#[tauri::command]
pub(crate) async fn load_vnc_password(connection_id: String) -> Result<String, String> {
    validate_id(&connection_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        credential_store::load_vnc_password(&connection_id)
    })
    .await
    .map_err(|error| format!("读取 VNC 密码任务失败：{error}"))?
}

/// 保存或删除独立 VNC 密码，空密码表示删除；所有写盘均由 Rivet 凭据存储加密。
///
/// # 参数
/// - `connection_id`：VNC 连接 ID，不影响同名 SSH 凭据。
/// - `password`：最多八字节 ASCII；空值删除，无浏览器持久化副作用。
///
/// # Errors
/// 非法输入、加密或磁盘写入失败时返回错误，原凭据保留。
#[tauri::command]
pub(crate) async fn save_vnc_password(
    connection_id: String,
    password: String,
) -> Result<(), String> {
    validate_id(&connection_id)?;
    validate_password(&password)?;
    tauri::async_runtime::spawn_blocking(move || {
        credential_store::save_vnc_password(&connection_id, &password)
    })
    .await
    .map_err(|error| format!("保存 VNC 密码任务失败：{error}"))?
}

/// 建立带总超时的连接，消费密码后只返回协议客户端；取消时 socket 自动释放。
///
/// # 参数
/// - `request`：当前任务独占的连接参数，临时密码会从其中取出。
///
/// # Errors
/// 密码缺失、连接、握手及认证失败均返回错误，不自动重试认证。
async fn connect(request: &mut VncOpenRequest) -> Result<VncClient, String> {
    let password = if request.auth_type == "none" {
        String::new()
    } else {
        let value = match request.password.take() {
            Some(value) => value,
            None => load_vnc_password(request.connection_id.clone()).await?,
        };
        validate_password(&value)?;
        if value.is_empty() {
            return Err("请输入 VNC 密码".into());
        }
        value
    };
    let stream = TcpStream::connect((request.host.as_str(), request.port))
        .await
        .map_err(|error| format!("连接 VNC 失败：{error}"))?;
    stream
        .set_nodelay(true)
        .map_err(|error| format!("配置 VNC TCP 失败：{error}"))?;
    let transport = VncTransport::negotiate(stream, request.auth_type == "password").await?;
    VncConnector::new(transport)
        // 密码只移动给一次认证 Future，不记录日志或转交图像通道。
        .set_auth_method(async move { Ok(password) })
        .set_pixel_format(PixelFormat::rgba())
        .allow_shared(true)
        .add_encoding(VncEncoding::Zrle)
        .add_encoding(VncEncoding::CopyRect)
        .add_encoding(VncEncoding::Raw)
        .add_encoding(VncEncoding::DesktopSizePseudo)
        .build()
        .map_err(|error| error.to_string())?
        .try_start()
        .await
        .map_err(|error| format!("VNC 认证或初始化失败：{error}"))?
        .finish()
        .map_err(|error| error.to_string())
}

/// 拥有一个会话的连接和清理过程；取消优先于连接与运行，任何结果均更新可见状态。
///
/// # 参数
/// - `request`：本任务拥有的配置和临时密码，不跨会话共享。
/// - `shared`：短锁保护的最新桌面，锁不会跨 await。
/// - `input`：有界输入接收端，任务结束后关闭。
/// - `cancelled`：注册表移除句柄时关闭的取消通道。
async fn run_session(
    mut request: VncOpenRequest,
    shared: Arc<Mutex<SharedFrame>>,
    mut input: mpsc::Receiver<Vec<VncInput>>,
    mut cancelled: watch::Receiver<()>,
) {
    let connected = tokio::select! {
        biased;
        _ = cancelled.changed() => return,
        result = timeout(CONNECT_TIMEOUT, connect(&mut request)) => result.map_err(|_| "VNC 连接超时".to_string()).and_then(|result| result),
    };
    let result = match connected {
        Ok(client) => {
            let result = tokio::select! {
                biased;
                _ = cancelled.changed() => Ok(()),
                result = drive(&client, &shared, &mut input) => result,
            };
            // 关闭引擎会释放网络/解码任务；清理失败保留为会话错误，不掩盖先前错误。
            let cleanup = timeout(INPUT_TIMEOUT, client.close()).await;
            match (result, cleanup) {
                (Err(error), cleanup) => {
                    if !matches!(cleanup, Ok(Ok(()))) {
                        eprintln!("VNC 会话失败后，协议清理未能正常完成");
                    }
                    Err(error)
                }
                (Ok(()), Ok(Ok(()))) => Ok(()),
                (Ok(()), _) => Err("关闭 VNC 协议任务失败".into()),
            }
        }
        Err(error) => Err(error),
    };
    match shared.lock() {
        Ok(mut current) => {
            match result {
                Ok(()) => current.frame.state = 2,
                Err(error) => {
                    current.frame.state = 3;
                    current.frame.error = error.chars().take(MAX_ERROR_CHARS).collect();
                }
            }
            current.changed.notify_one();
        }
        Err(_) => eprintln!("VNC 图像状态锁已损坏"),
    };
}

/// 顺序消费有界输入和协议事件，只维护最新像素；隐藏视图停止主动请求变化。
///
/// # 参数
/// - `client`：已连接的协议引擎，函数不接管关闭职责。
/// - `shared`：当前会话桌面和前端活动时间，锁仅保护同步像素操作。
/// - `input`：当前任务唯一输入接收端，关闭后正常结束。
///
/// # Errors
/// 远端断开、解码失败、像素越界或输入超时终止会话；调用方负责关闭引擎。
async fn drive(
    client: &VncClient,
    shared: &Arc<Mutex<SharedFrame>>,
    input: &mut mpsc::Receiver<Vec<VncInput>>,
) -> Result<(), String> {
    {
        let mut current = shared.lock().map_err(|_| "VNC 图像锁已损坏")?;
        current.frame.state = 1;
        current.changed.notify_one();
    }
    let mut tick = interval(EVENT_INTERVAL);
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut last_refresh = Instant::now() - REFRESH_INTERVAL;
    // 协议引擎已请求首张完整桌面；收到像素后才补充增量请求，静止时等待远端响应。
    let mut refresh_pending = true;
    loop {
        tokio::select! {
            batch = input.recv() => {
                let Some(batch) = batch else { return Ok(()); };
                for event in batch {
                    let event = match event {
                        VncInput::Key { key, down } => X11Event::KeyEvent((key, down).into()),
                        VncInput::Pointer { x, y, buttons } => X11Event::PointerEvent((x, y, buttons).into()),
                    };
                    timeout(INPUT_TIMEOUT, client.input(event)).await.map_err(|_| "VNC 输入超时")?.map_err(|error| error.to_string())?;
                }
            }
            _ = tick.tick() => {
                let started = Instant::now();
                for _ in 0..MAX_EVENTS_PER_TICK {
                    let Some(event) = client.poll_event().await.map_err(|error| format!("VNC 连接已结束：{error}"))? else { break; };
                    let mut current = shared.lock().map_err(|_| "VNC 图像锁已损坏")?;
                    match event {
                        VncEvent::SetResolution(screen) => current.frame.resize(screen.width, screen.height)?,
                        VncEvent::RawImage(rect, data) => { current.frame.draw(rect, &data)?; refresh_pending = false; }
                        VncEvent::Copy(destination, source) => { current.frame.copy(destination, source)?; refresh_pending = false; }
                        VncEvent::Error(error) => return Err(format!("VNC 协议错误：{error}")),
                        // 未协商 Tight/JPEG、光标或扩展剪贴板；不将远端文本写入系统剪贴板。
                        VncEvent::JpegImage(_, _) => return Err("服务端发送了未协商的 JPEG 编码".into()),
                        _ => {}
                    }
                    if current.frame.has_changes() {
                        current.changed.notify_one();
                    }
                    if started.elapsed() >= EVENT_BATCH_BUDGET {
                        break;
                    }
                }
                let active = shared.lock().map_err(|_| "VNC 图像锁已损坏")?.last_poll.elapsed() < VIEW_IDLE_TIMEOUT;
                if active && !refresh_pending && last_refresh.elapsed() >= REFRESH_INTERVAL {
                    timeout(INPUT_TIMEOUT, client.input(X11Event::Refresh)).await.map_err(|_| "VNC 图像请求超时")?.map_err(|error| error.to_string())?;
                    refresh_pending = true;
                    last_refresh = Instant::now();
                }
            }
        }
    }
}
