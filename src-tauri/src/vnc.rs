//! 独立 VNC 会话服务与 Tauri 命令；拥有 TCP/协议任务、有界输入队列和最新桌面。
//! 仅支持直连标准 RFB，不访问 SSH 的连接、配置或会话状态。

use crate::vnc_system_clipboard::{SystemClipboard, WindowFocus};
use crate::{credential_store, vnc_apple_auth, vnc_frame::VncFrame, vnc_transport::VncTransport};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{ipc::Response, State, Window};
use tokio::{
    net::TcpStream,
    sync::{mpsc, watch, Notify},
    time::{sleep_until, timeout, Instant as TokioInstant},
};
use vnc::clipboard::{Clipboard, ClipboardUpdate};
use vnc::{PixelFormat, VncClient, VncConnector, VncEncoding, VncEvent, X11Event};
use zeroize::{Zeroize, Zeroizing};

/// 同时最多四个 VNC 桌面，限制连接和图像内存总量。
pub(crate) const MAX_VNC_SESSIONS: usize = 4;
/// TCP 连接、认证与初始化共用十五秒总超时。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 每次输入写入或协议关闭最多等待两秒，避免队列拥塞阻塞清理。
const INPUT_TIMEOUT: Duration = Duration::from_secs(2);
/// 相邻刷新请求至少间隔四毫秒，限制立即返回空更新的服务端造成的请求速率。
const REFRESH_INTERVAL: Duration = Duration::from_millis(4);
/// 静止画面的取帧请求最多等待二百五十毫秒，期间由图像或状态变化唤醒。
const FRAME_WAIT_TIMEOUT: Duration = Duration::from_millis(250);
/// 前端两秒未取帧时停止主动刷新，后台会话保持连接。
const VIEW_IDLE_TIMEOUT: Duration = Duration::from_secs(2);
/// 输入队列最多容纳一百二十八个批次；满时向前端返回错误。
const INPUT_QUEUE_CAPACITY: usize = 128;
/// 每个批次最多六十四个键鼠事件，限制单次 IPC 的处理开销。
const MAX_INPUT_BATCH: usize = 64;
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
    /// password 为传统密码，apple 为 macOS 用户名认证，none 为显式无认证。
    pub(crate) auth_type: String,
    /// Apple 认证账户名；旧配置及其他认证方式可省略，不作为密码保存。
    #[serde(default)]
    pub(crate) username: String,
    /// 临时密码；None 从本地加密存储读取，不写入连接列表。
    pub(crate) password: Option<String>,
    /// 此会话是否拒绝所有键鼠写入；建立后不可被前端输入绕过。
    pub(crate) read_only: bool,
}

impl Drop for VncOpenRequest {
    /// 请求被拒绝、取消或任务退出时清零尚未交给握手的密码；不执行 I/O 或阻塞清理。
    fn drop(&mut self) {
        if let Some(password) = self.password.as_mut() {
            password.zeroize();
        }
    }
}

/// 一个输入事件；使用带标签 JSON，未知字段与未知种类均被拒绝。
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum VncInput {
    /// 正常粘贴键按下；先读取焦点会话的系统文本，再发送同一个远端按键。
    Paste {
        /// X11 的 v 或 V 键值；修饰键和释放事件仍走常规队列。
        key: u32,
    },
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
    /// 解码中的像素、未送达的脏区及会话状态；读帧只在完整更新之间复制像素。
    frame: VncFrame,
    /// 已收到更新头且还未收到结束事件；此时不允许 IPC 读取工作缓冲。
    updating: bool,
    /// 首次图像或服务端尺寸更新到达后才允许发布画面。
    frame_ready: bool,
    /// 本批更新改变了尺寸，结束时安排一次新尺寸的整屏请求。
    resized_in_update: bool,
    /// 下次成功取帧需要整屏；等待超时只返回状态，保留此标志。
    full_requested: bool,
    /// 每个会话最多一个读帧请求；结束或取消时由其守卫移除。
    poll: Option<FramePoll>,
    /// 前端最近取帧的单调时间，用来停止隐藏页面的刷新请求。
    last_poll: Instant,
    /// 快照已就绪或会话进入终态时唤醒在途请求，只保留一个唤醒许可。
    changed: Arc<Notify>,
    /// 视图恢复取帧时唤醒协议任务；隐藏时不需要定时检查。
    view_resumed: Arc<Notify>,
}

/// 已注册的 IPC 读取；更新结束时可以预先准备一份快照，防止下一批覆盖可读窗口。
enum FramePoll {
    /// 已登记，等待完整更新或超时。
    Waiting,
    /// 在途请求独占的响应，至多一份桌面像素。
    Ready(Vec<u8>),
    /// 响应已取走，守卫移除槽位前禁止再次准备快照。
    Delivered,
}

/// 持有当前会话唯一读帧槽位；跨异步等待借用会话，未持有互斥锁。
struct FramePollGuard<'a> {
    /// 槽位所属的会话锁，析构时只短暂持锁回收槽位。
    shared: &'a Mutex<SharedFrame>,
}

impl Drop for FramePollGuard<'_> {
    /// 释放在途槽位；若取消时已有未取走的像素，下一次读帧会重建整屏。
    fn drop(&mut self) {
        match self.shared.lock() {
            Ok(mut current) => {
                if matches!(current.poll.take(), Some(FramePoll::Ready(_))) {
                    current.full_requested = true;
                }
            }
            Err(_) => eprintln!("VNC 图像状态锁已损坏"),
        }
    }
}

impl SharedFrame {
    /// 会话断开或超过取帧活跃期时拒绝剪贴板读写。
    fn check_clipboard_active(&self) -> Result<(), String> {
        if self.frame.state != 1 || self.last_poll.elapsed() >= VIEW_IDLE_TIMEOUT {
            return Err("VNC 桌面当前未激活".into());
        }
        Ok(())
    }

    /// 在会话锁内记录取帧时间；从闲置恢复时唤醒协议任务以补发待处理的刷新。
    fn mark_polled(&mut self) {
        let now = Instant::now();
        if now.duration_since(self.last_poll) >= VIEW_IDLE_TIMEOUT {
            self.view_resumed.notify_one();
        }
        self.last_poll = now;
    }

    /// 只有完整画面且有脏区或整屏需求时，才允许复制工作缓冲。
    fn can_snapshot(&self) -> bool {
        !self.updating && self.frame_ready && (self.full_requested || self.frame.has_changes())
    }

    /// 调用方已确认 `can_snapshot`；复制并消费脏区及本次整屏需求。
    fn take_snapshot(&mut self) -> Vec<u8> {
        self.frame
            .snapshot(std::mem::take(&mut self.full_requested))
    }

    /// 提交完整更新。有等待者时在释放会话锁前保存一份快照，下一批可以立即解码。
    fn finish_update(&mut self) {
        self.updating = false;
        if self.can_snapshot() && matches!(self.poll, Some(FramePoll::Waiting)) {
            self.poll = Some(FramePoll::Ready(self.take_snapshot()));
            self.changed.notify_one();
        }
    }

    /// 取走等待者独占的快照。终态优先，尚无快照时在超时后返回状态包。
    ///
    /// # 参数
    /// - `timed_out`：true 表示已到等待上限；false 时尚无快照返回 None。
    fn poll_response(&mut self, timed_out: bool) -> Option<Vec<u8>> {
        let poll = self.poll.as_mut()?;
        let bytes = match poll {
            _ if self.frame.state >= 2 => self.frame.status_packet(),
            FramePoll::Ready(bytes) => std::mem::take(bytes),
            FramePoll::Waiting if timed_out => self.frame.status_packet(),
            _ => return None,
        };
        *poll = FramePoll::Delivered;
        Some(bytes)
    }
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
    /// 应用内只允许一个 VNC 桌面拥有剪贴板焦点；协议任务共享此原生边界。
    clipboard: Arc<SystemClipboard>,
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
        if !["password", "apple", "none"].contains(&self.auth_type.as_str()) {
            return Err("VNC 认证方式无效".into());
        }
        if self.auth_type == "apple" {
            if self.username.trim().is_empty() {
                return Err("请输入 macOS 用户名".into());
            }
            vnc_apple_auth::validate_credential(&self.username)?;
        }
        if let Some(password) = &self.password {
            if self.auth_type == "apple" {
                vnc_apple_auth::validate_credential(password)?;
            } else {
                validate_password(password)?;
            }
            if self.auth_type != "none" && password.is_empty() {
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
            updating: false,
            frame_ready: false,
            resized_in_update: false,
            full_requested: false,
            poll: None,
            last_poll: Instant::now(),
            changed: Arc::new(Notify::new()),
            view_resumed: Arc::new(Notify::new()),
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
        tauri::async_runtime::spawn(run_session(
            request,
            shared,
            receiver,
            Arc::clone(&self.clipboard),
            cancelled,
        ));
        Ok(())
    }

    /// 等待整批画面、终态或超时。每个会话只允许一个在途请求，等待时不持锁。
    ///
    /// # 参数
    /// - `session_id`：目标会话 ID，仅用于查询已有句柄。
    /// - `full`：true 请求重建整屏；若本次只返回状态，整屏需求留到下一次成功取帧。
    ///
    /// # Errors
    /// 会话不存在、已有取帧或锁损坏时返回错误。取消后丢弃的快照由下次整屏恢复。
    pub(crate) async fn next_frame(&self, session_id: &str, full: bool) -> Result<Vec<u8>, String> {
        let shared = {
            let sessions = self.sessions.lock().map_err(|_| "VNC 会话锁已损坏")?;
            Arc::clone(&sessions.get(session_id).ok_or("VNC 会话不存在")?.shared)
        };
        // 先登记等待者，再释放锁；更新结束与开始等待之间的通知由 Notify 保留。
        let changed = {
            let mut current = shared.lock().map_err(|_| "VNC 图像锁已损坏")?;
            if current.poll.is_some() {
                return Err("VNC 会话已有取帧请求".into());
            }
            current.mark_polled();
            if current.frame.state >= 2 {
                return Ok(current.frame.status_packet());
            }
            current.full_requested |= full;
            if current.can_snapshot() {
                return Ok(current.take_snapshot());
            }
            current.poll = Some(FramePoll::Waiting);
            Arc::clone(&current.changed)
        };
        let _slot = FramePollGuard { shared: &shared };
        let wait = async {
            loop {
                {
                    let mut current = shared.lock().map_err(|_| "VNC 图像锁已损坏")?;
                    if let Some(bytes) = current.poll_response(false) {
                        return Ok(bytes);
                    }
                }
                changed.notified().await;
            }
        };
        match timeout(FRAME_WAIT_TIMEOUT, wait).await {
            Ok(result) => result,
            Err(_) => {
                let mut current = shared.lock().map_err(|_| "VNC 图像锁已损坏")?;
                // 与更新结束同时到达时先取已准备的响应，否则只返回状态。
                current
                    .poll_response(true)
                    .ok_or_else(|| "VNC 取帧槽位已结束".into())
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
                    VncInput::Paste { key }
                        if ![u32::from(b'v'), u32::from(b'V')].contains(key) =>
                    {
                        return Err("VNC 粘贴按键无效".into())
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

    /// 记录当前键盘焦点；前端只在原有远程键盘捕获启停时调用。
    ///
    /// # 参数
    /// - `session_id`：目标会话 ID；设置时必须已连接且可写。
    /// - `has_focus`：Some 设置原生焦点查询，None 幂等清除当前会话的焦点。
    /// # Errors
    /// 无效会话、只读或锁失败时不设置焦点，不访问系统剪贴板。
    pub(crate) fn set_clipboard_focus(
        &self,
        session_id: &str,
        has_focus: Option<WindowFocus>,
    ) -> Result<(), String> {
        if has_focus.is_some() {
            let sessions = self.sessions.lock().map_err(|_| "VNC 会话锁已损坏")?;
            let session = sessions.get(session_id).ok_or("VNC 会话不存在")?;
            if session.read_only {
                return Err("VNC 会话为只读模式".into());
            }
            session
                .shared
                .lock()
                .map_err(|_| "VNC 图像锁已损坏")?
                .check_clipboard_active()?;
            return self.clipboard.set_target(session_id, has_focus);
        }
        self.clipboard.set_target(session_id, None)
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

/// 返回当前会话已完成的二进制变化区域；等待最长二百五十毫秒，超时可只返回状态。
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

/// 同步键盘捕获焦点，只有其所属的本机窗口可以成为剪贴板目标。
///
/// # 参数
/// - `service`：应用的 VNC 注册表。
/// - `window`：发出 IPC 的窗口句柄，由 Tauri 注入。
/// - `session_id`：当前活动会话的 ID。
/// - `focused`：true 启用焦点，false 撤销该会话焦点。
/// # Errors
/// 会话无效、只读或锁损坏时返回错误。
#[tauri::command]
pub(crate) fn vnc_set_clipboard_focus(
    service: State<'_, VncService>,
    window: Window,
    session_id: String,
    focused: bool,
) -> Result<(), String> {
    // window 只由焦点任期持有；实际原生查询在剪贴板工作线程执行。
    let has_focus = if focused {
        let query: WindowFocus =
            Box::new(move || window.is_focused().map_err(|error| error.to_string()));
        Some(query)
    } else {
        None
    };
    service.set_clipboard_focus(&session_id, has_focus)
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
/// - `password`：最多六十三字节 UTF-8；空值删除，具体认证限制在建立连接时校验。
///
/// # Errors
/// 非法输入、加密或磁盘写入失败时返回错误，原凭据保留。
#[tauri::command]
pub(crate) async fn save_vnc_password(
    connection_id: String,
    password: String,
) -> Result<(), String> {
    let password = Zeroizing::new(password);
    validate_id(&connection_id)?;
    if !password.is_empty() {
        vnc_apple_auth::validate_credential(&password)?;
    }
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
        Zeroizing::new(String::new())
    } else {
        let value = Zeroizing::new(match request.password.take() {
            Some(value) => value,
            None => load_vnc_password(request.connection_id.clone()).await?,
        });
        if request.auth_type == "apple" {
            vnc_apple_auth::validate_credential(&value)?;
        } else {
            validate_password(&value)?;
        }
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
    let transport =
        VncTransport::negotiate(stream, &request.auth_type, &request.username, &password).await?;
    // Apple 凭据已经在适配器内使用，不再交给只支持传统密码的图像协议引擎。
    let engine_password = if request.auth_type == "password" {
        password.to_string()
    } else {
        String::new()
    };
    VncConnector::new(transport)
        // 密码只移动给一次认证 Future，不记录日志或转交图像通道。
        .set_auth_method(async move { Ok(engine_password) })
        .set_pixel_format(PixelFormat::rgba())
        .allow_shared(true)
        // 优先使用无损 Tight；未发送 JPEG 质量扩展，服务端可选 ZRLE 或 Raw。
        .add_encoding(VncEncoding::Tight)
        .add_encoding(VncEncoding::Zrle)
        .add_encoding(VncEncoding::CopyRect)
        .add_encoding(VncEncoding::Raw)
        .add_encoding(VncEncoding::DesktopSizePseudo)
        .add_encoding(VncEncoding::LastRectPseudo)
        .add_encoding(VncEncoding::ExtendedClipboardPseudo)
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
/// - `system_clipboard`：应用唯一的原生剪贴板边界，会话结束时撤销当前焦点。
/// - `cancelled`：注册表移除句柄时关闭的取消通道。
async fn run_session(
    mut request: VncOpenRequest,
    shared: Arc<Mutex<SharedFrame>>,
    mut input: mpsc::Receiver<Vec<VncInput>>,
    system_clipboard: Arc<SystemClipboard>,
    mut cancelled: watch::Receiver<()>,
) {
    let connected = tokio::select! {
        biased;
        _ = cancelled.changed() => None,
        result = timeout(CONNECT_TIMEOUT, connect(&mut request)) => Some(result.map_err(|_| "VNC 连接超时".to_string()).and_then(|result| result)),
    };
    let result = match connected {
        Some(Ok(client)) => {
            let result = tokio::select! {
                biased;
                _ = cancelled.changed() => Ok(()),
                result = drive(&client, &shared, &mut input, &system_clipboard, &request.session_id) => result,
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
        Some(Err(error)) => Err(error),
        None => Ok(()),
    };
    if let Err(error) = system_clipboard.set_target(&request.session_id, None) {
        eprintln!("清理 VNC 剪贴板焦点失败：{error}");
    }
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

/// 在更新头到达后安排下次请求，在更新结束时提交画面。隐藏视图暂停新请求。
///
/// # 参数
/// - `client`：已连接的协议引擎；取消读取会释放引擎锁，调用方负责关闭。
/// - `shared`：当前会话桌面和前端活动时间，锁仅保护同步像素操作。
/// - `input`：当前任务唯一输入接收端，关闭后正常结束。
/// - `system_clipboard`：共享原生剪贴板，只有焦点会话可读写。
/// - `session_id`：用于限定本次系统剪贴板操作的会话 ID。
///
/// # Errors
/// 远端断开、解码失败、像素越界或输入超时终止会话；调用方负责关闭引擎。
async fn drive(
    client: &VncClient,
    shared: &Mutex<SharedFrame>,
    input: &mut mpsc::Receiver<Vec<VncInput>>,
    system_clipboard: &Arc<SystemClipboard>,
    session_id: &str,
) -> Result<(), String> {
    let view_resumed = {
        let mut current = shared.lock().map_err(|_| "VNC 图像锁已损坏")?;
        current.frame.state = 1;
        Arc::clone(&current.view_resumed)
    };
    let mut next_refresh = TokioInstant::now();
    // 初始整屏由协议引擎请求。后续每批更新头触发一次增量请求，尺寸变化可要求整屏。
    let mut refresh = None;
    let mut clipboard = Clipboard::default();
    // 无效扩展载荷只诊断一次，避免远端持续刷日志；画面仍可继续。
    let mut clipboard_warning = false;
    // 剪贴板访问失败只保留一次诊断；之后仍转发原始粘贴按键。
    let mut system_clipboard_warning = false;
    loop {
        let can_refresh = refresh.is_some()
            && shared
                .lock()
                .map_err(|_| "VNC 图像锁已损坏")?
                .last_poll
                .elapsed()
                < VIEW_IDLE_TIMEOUT;
        if can_refresh && TokioInstant::now() >= next_refresh {
            if let Some(request) = refresh.take() {
                timeout(INPUT_TIMEOUT, client.input(request))
                    .await
                    .map_err(|_| "VNC 图像请求超时")?
                    .map_err(|error| error.to_string())?;
                next_refresh = TokioInstant::now() + REFRESH_INTERVAL;
            }
        }
        tokio::select! {
            // 输入分支一旦选中，等待 recv_event 的 Future 已释放引擎内部的锁。
            batch = input.recv() => {
                let Some(batch) = batch else { return Ok(()); };
                for event in batch {
                    let event = match event {
                        VncInput::Key { key, down } => X11Event::KeyEvent((key, down).into()),
                        VncInput::Paste { key } => {
                            if let Err(error) = offer_system_clipboard(client, &mut clipboard, system_clipboard, session_id).await {
                                if !system_clipboard_warning {
                                    system_clipboard_warning = true;
                                    eprintln!("VNC 本地剪贴板未同步：{error}");
                                }
                            }
                            X11Event::KeyEvent((key, true).into())
                        }
                        VncInput::Pointer { x, y, buttons } => X11Event::PointerEvent((x, y, buttons).into()),
                    };
                    timeout(INPUT_TIMEOUT, client.input(event)).await.map_err(|_| "VNC 输入超时")?.map_err(|error| error.to_string())?;
                }
            }
            event = client.recv_event() => {
                let event = event.map_err(|error| format!("VNC 连接已结束：{error}"))?;
                let event = match event {
                    VncEvent::Text(text) => clipboard.receive_legacy(text),
                    VncEvent::ExtendedClipboard(packet) => clipboard.receive(&packet),
                    event => {
                        if let Some(request) = apply_frame_event(shared, event)? {
                            // 尺寸变化的整屏请求优先于尚未发出的增量请求。
                            if !matches!(refresh, Some(X11Event::FullRefresh)) {
                                refresh = Some(request);
                            }
                        }
                        continue;
                    }
                };
                match event {
                    Ok(update) => {
                        if let Err(error) = apply_clipboard_update(client, system_clipboard, session_id, update).await {
                            if !system_clipboard_warning {
                                system_clipboard_warning = true;
                                eprintln!("VNC 远端剪贴板未同步：{error}");
                            }
                        }
                    }
                    Err(error) if !clipboard_warning => {
                        clipboard_warning = true;
                        eprintln!("VNC 剪贴板消息已拒绝：{error}");
                    }
                    Err(_) => {}
                }
            }
            _ = sleep_until(next_refresh), if can_refresh && refresh.is_some() => {}
            // 取帧在锁内记录活动时间后唤醒这里；下一轮重新判断是否可以刷新。
            _ = view_resumed.notified() => {}
        }
    }
}

/// 在有限等待内把剪贴板消息交给协议写队列；网络错误向调用者报告。
///
/// # 参数
/// - `client`：当前会话的协议引擎。
/// - `event`：移交所有权的剪贴板消息。
/// # Errors
/// 队列、连接或超时错误，不重发消息。
async fn write_clipboard(client: &VncClient, event: X11Event) -> Result<(), String> {
    timeout(INPUT_TIMEOUT, client.input(event))
        .await
        .map_err(|_| "VNC 剪贴板发送超时")?
        .map_err(|error| error.to_string())
}

/// 在远端收到粘贴键之前发布用户本机的纯文本；空或非文本保留远端原来的行为。
///
/// # 参数
/// - `client`：当前会话引擎。
/// - `clipboard`：当前会话的协议协商及已授权文本。
/// - `system`：原生剪贴板边界，失焦时不读取。
/// - `session_id`：用户实际按下粘贴键的会话。
/// # Errors
/// 原生读取、协议编码或队列失败均返回错误，调用方仍转发原始按键。
async fn offer_system_clipboard(
    client: &VncClient,
    clipboard: &mut Clipboard,
    system: &Arc<SystemClipboard>,
    session_id: &str,
) -> Result<(), String> {
    if let Some(text) = system
        .read(session_id)
        .await?
        .filter(|text| !text.is_empty())
    {
        write_clipboard(client, clipboard.offer(text)?).await?;
    }
    Ok(())
}

/// 发送协议响应并把收到的非空纯文本交给系统；空内容不覆盖本机剪贴板。
///
/// # 参数
/// - `client`：当前会话引擎。
/// - `system`：原生剪贴板边界，失焦时不写入。
/// - `session_id`：远端文本所属会话。
/// - `update`：移交的已校验文本变更和可选响应。
/// # Errors
/// 系统写入或协议发送失败向会话任务报告。
async fn apply_clipboard_update(
    client: &VncClient,
    system: &Arc<SystemClipboard>,
    session_id: &str,
    update: ClipboardUpdate,
) -> Result<(), String> {
    if let Some(reply) = update.reply {
        write_clipboard(client, reply).await?;
    }
    if let Some(text) = update.remote {
        system.write(session_id, text).await?;
    }
    Ok(())
}

/// 处理更新边界或矩形；仅开始和尺寸变化可安排下一次刷新。
///
/// # 参数
/// - `shared`：本会话桌面；锁在返回前释放，不等待网络。
/// - `event`：引擎移交的已解码事件，原始像素在写入后释放。
///
/// # Errors
/// 锁损坏、非法图像或协议错误结束会话；非法矩形不改变桌面。
fn apply_frame_event(
    shared: &Mutex<SharedFrame>,
    event: VncEvent,
) -> Result<Option<X11Event>, String> {
    let mut current = shared.lock().map_err(|_| "VNC 图像锁已损坏")?;
    match event {
        VncEvent::FramebufferUpdateStart => {
            current.updating = true;
            Ok(Some(X11Event::Refresh))
        }
        VncEvent::FramebufferUpdateEnd => {
            current.finish_update();
            // 更新头已按旧尺寸预取，实际改尺寸后需再请求一次新尺寸完整图像。
            Ok(std::mem::take(&mut current.resized_in_update).then_some(X11Event::FullRefresh))
        }
        VncEvent::SetResolution(screen) => {
            let resized =
                (current.frame.width, current.frame.height) != (screen.width, screen.height);
            current.frame.resize(screen.width, screen.height)?;
            // 握手只分配缓冲；首批像素到达前不向前端发送占位黑屏。
            if current.updating && resized {
                current.resized_in_update = true;
                current.frame_ready = true;
            }
            Ok(None)
        }
        VncEvent::RawImage(rect, data) => {
            current.frame.draw(rect, &data)?;
            current.frame_ready = true;
            Ok(None)
        }
        VncEvent::Copy(destination, source) => {
            current.frame.copy(destination, source)?;
            current.frame_ready = true;
            Ok(None)
        }
        VncEvent::Error(error) => Err(format!("VNC 协议错误：{error}")),
        VncEvent::JpegImage(_, _) => Err("服务端发送了未协商的 JPEG 编码".into()),
        // 此处仅处理画面，未协商的光标事件不修改本机光标。
        _ => Ok(None),
    }
}
