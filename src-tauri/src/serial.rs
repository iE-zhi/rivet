//! 串口服务模块：独占活动端口，限时读取并发布原始字节，关闭时请求线程退出。

use crate::config::{validate_config, PortConfig};
use serde::Serialize;
use serial2::{CharSize, FlowControl, Parity, SerialPort, Settings, StopBits};
use std::io::{ErrorKind, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// 单次底层读取的超时上限，限定关闭命令等待读取线程的常规延迟。
const READ_TIMEOUT: Duration = Duration::from_millis(100);
/// 每次读取最多暂存的串口字节数，避免大块分配并限制事件大小。
const READ_BUFFER_SIZE: usize = 4096;
/// 单个待处理发送的队列容量；会话标志阻止结果未定时再次入队。
const COMMAND_QUEUE_CAPACITY: usize = 1;
/// 单次允许发送的最大字节数，避免命令队列缓存无界输入。
const MAX_WRITE_SIZE: usize = 1_048_576;
/// 单条发送的总时间上限；写调用的超时随剩余期限收紧，限制关闭等待时间。
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
/// 等待发送响应的上限，覆盖写入截止时间、读取轮询和调度余量。
const SEND_RESULT_TIMEOUT: Duration = Duration::from_secs(3);

/// 前端显示的串口设备名称和系统路径。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    /// 传给串口驱动的系统设备路径。
    pub path: String,
    /// 显示给用户的设备名称。
    pub name: String,
}

/// 事件中的原始串口数据块；边界按一次底层读取保留。
#[derive(Clone, Serialize)]
pub struct DataEvent {
    /// 一次底层读取取得的原始字节，不在 Rust 层做字符解码。
    pub bytes: Vec<u8>,
}

/// 发送工作线程内的有界写入请求；响应通道通知调用方写入是否完成。
enum WorkerCommand {
    Write {
        /// 已限制到单次发送上限的字节负载。
        bytes: Vec<u8>,
        /// 单次写入结果的有界返回通道。
        result: SyncSender<Result<(), String>>,
    },
}

/// 一个连接的命令队列、读取线程控制权和活动标志。
struct SerialSession {
    /// 会话身份标记，worker 只允许清理与自身匹配的活动连接。
    identity: Arc<()>,
    /// 有界命令队列；串口句柄只由工作线程访问。
    commands: SyncSender<WorkerCommand>,
    /// 请求工作线程在当前 I/O 超时后退出。
    stop: Arc<AtomicBool>,
    /// 发送请求从入队到 worker 完成期间保持置位，防止超时后重复排队。
    write_pending: Arc<AtomicBool>,
    /// 等待关闭和应用退出时回收的唯一线程句柄。
    worker: Mutex<Option<JoinHandle<()>>>,
}

/// 串口状态由互斥锁串行化；closing 在旧线程 join 完成前阻止新连接。
#[derive(Default)]
struct SerialState {
    /// 当前活动会话；设备读错误后由对应 worker 按会话身份清除。
    active: Option<Arc<SerialSession>>,
    /// 关闭流程正在 join 旧 worker，期间拒绝打开新设备。
    closing: bool,
}

/// 管理单个串口会话及其线程的 RAII 生命周期。
#[derive(Default)]
pub struct SerialService {
    /// 共享状态允许 worker 在退出后安全清除自身会话。
    state: Arc<Mutex<SerialState>>,
}

/// 应用退出时停止读取线程，确保串口句柄不随分离线程遗留。
impl Drop for SerialService {
    fn drop(&mut self) {
        // 即使锁已中毒也回收内部状态，避免设备句柄留在分离线程。
        let state = match self.state.lock() {
            Ok(mut state) => std::mem::take(&mut state.active),
            Err(poisoned) => std::mem::take(&mut poisoned.into_inner().active),
        };
        if let Some(session) = state {
            if let Err(error) = stop_session(&session) {
                eprintln!("关闭串口读取线程失败：{error}");
            }
        }
    }
}

/// 枚举操作系统当前可见的串口；错误传回前端并保留系统诊断信息。
#[tauri::command]
pub fn list_ports() -> Result<Vec<PortInfo>, String> {
    let mut ports =
        SerialPort::available_ports().map_err(|error| format!("枚举串口失败：{error}"))?;
    ports.sort();
    Ok(ports
        .into_iter()
        .map(|path| {
            let path = path.to_string_lossy().into_owned();
            PortInfo {
                name: path.clone(),
                path,
            }
        })
        .collect())
}

/// 校验帧参数、打开设备并启动有界读取循环；已连接时拒绝覆盖活动会话。
#[tauri::command]
pub fn open_port(
    app: AppHandle,
    service: State<'_, SerialService>,
    config: PortConfig,
) -> Result<(), String> {
    validate_config(&config)?;
    verify_available_path(&config.path)?;
    let mut state = service
        .state
        .lock()
        .map_err(|_| "串口状态锁异常".to_string())?;
    if state.active.is_some() || state.closing {
        return Err("已有串口连接，请先断开".to_string());
    }
    let mut port = SerialPort::open(&config.path, |mut settings: Settings| {
        settings.set_raw();
        settings.set_baud_rate(config.baud_rate)?;
        settings.set_char_size(if config.data_bits == 7 {
            CharSize::Bits7
        } else {
            CharSize::Bits8
        });
        settings.set_stop_bits(if config.stop_bits == 2 {
            StopBits::Two
        } else {
            StopBits::One
        });
        settings.set_parity(match config.parity.as_str() {
            "even" => Parity::Even,
            "odd" => Parity::Odd,
            _ => Parity::None,
        });
        settings.set_flow_control(if config.flow_control == "hardware" {
            FlowControl::RtsCts
        } else {
            FlowControl::None
        });
        Ok(settings)
    })
    .map_err(|error| format!("打开串口失败：{error}"))?;
    port.set_read_timeout(READ_TIMEOUT)
        .map_err(|error| format!("设置串口读取超时失败：{error}"))?;
    port.set_write_timeout(WRITE_TIMEOUT)
        .map_err(|error| format!("设置串口写入超时失败：{error}"))?;
    let (command_sender, command_receiver) = mpsc::sync_channel(COMMAND_QUEUE_CAPACITY);
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = Arc::clone(&stop);
    let write_pending = Arc::new(AtomicBool::new(false));
    let worker_write_pending = Arc::clone(&write_pending);
    // 握手确保会话先写入共享状态，再开始读设备或向前端发送错误事件。
    let (start_sender, start_receiver) = mpsc::sync_channel(0);
    let worker_state = Arc::downgrade(&service.state);
    let identity = Arc::new(());
    let worker_identity = Arc::downgrade(&identity);
    let worker = thread::Builder::new()
        .name("rivet-serial-reader".into())
        .spawn(move || {
            if start_receiver.recv().is_ok() {
                let failed = read_loop(
                    app,
                    port,
                    command_receiver,
                    worker_stop,
                    worker_write_pending,
                );
                if failed {
                    if let (Some(state), Some(identity)) =
                        (worker_state.upgrade(), worker_identity.upgrade())
                    {
                        let mut state = match state.lock() {
                            Ok(state) => state,
                            Err(poisoned) => {
                                eprintln!("串口状态锁中毒，worker 回收活动会话");
                                poisoned.into_inner()
                            }
                        };
                        if state
                            .active
                            .as_ref()
                            .is_some_and(|active| Arc::ptr_eq(&active.identity, &identity))
                            && !state.closing
                        {
                            state.active = None;
                        }
                    }
                }
            }
        })
        .map_err(|error| format!("启动串口读取线程失败：{error}"))?;
    let session = Arc::new(SerialSession {
        identity,
        commands: command_sender,
        stop,
        write_pending,
        worker: Mutex::new(Some(worker)),
    });
    state.active = Some(session);
    start_sender
        .send(())
        .map_err(|_| "启动串口读取线程失败".to_string())?;
    Ok(())
}

/// 请求工作线程退出；等待当前读写超时结束后释放活动端口。
#[tauri::command]
pub fn close_port(service: State<'_, SerialService>) -> Result<(), String> {
    let session = {
        let mut state = service
            .state
            .lock()
            .map_err(|_| "串口状态锁异常".to_string())?;
        if state.closing {
            return Err("串口正在关闭".to_string());
        }
        let session = state
            .active
            .clone()
            .ok_or_else(|| "当前没有已连接的串口".to_string())?;
        state.closing = true;
        session
    };
    let result = stop_session(&session);
    let mut state = service
        .state
        .lock()
        .map_err(|_| "串口状态锁异常".to_string())?;
    if state
        .active
        .as_ref()
        .is_some_and(|active| Arc::ptr_eq(active, &session))
    {
        state.active = None;
    }
    state.closing = false;
    result
}

/// 单飞发送有界字节并最多等待 3 秒；超时或 worker 退出时结果可能未知。
#[tauri::command]
pub fn send_bytes(service: State<'_, SerialService>, bytes: Vec<u8>) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("发送内容不能为空".to_string());
    }
    if bytes.len() > MAX_WRITE_SIZE {
        return Err(format!("单次发送不能超过 {MAX_WRITE_SIZE} 字节"));
    }
    let session = service
        .state
        .lock()
        .map_err(|_| "串口状态锁异常".to_string())?
        .active
        .as_ref()
        .cloned()
        .ok_or_else(|| "请先连接串口".to_string())?;
    if session.stop.load(Ordering::Acquire) {
        return Err("串口正在关闭".to_string());
    }
    // worker 清除该标志前拒绝新请求，避免调用方超时后将重试排到旧请求之后。
    session
        .write_pending
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "已有串口发送正在处理，请等待结果后重试".to_string())?;
    let (result_sender, result_receiver) = mpsc::sync_channel(1);
    if let Err(error) = session.commands.try_send(WorkerCommand::Write {
        bytes,
        result: result_sender,
    }) {
        session.write_pending.store(false, Ordering::Release);
        return Err(match error {
            TrySendError::Full(_) => "串口发送队列已满，请稍后重试".to_string(),
            TrySendError::Disconnected(_) => "串口工作线程已停止".to_string(),
        });
    }
    match result_receiver.recv_timeout(SEND_RESULT_TIMEOUT) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err(
            "等待串口发送结果超时，结果未知，可能已发送部分数据；重试可能造成重复发送".to_string(),
        ),
        Err(RecvTimeoutError::Disconnected) => Err(
            "串口工作线程退出，发送结果未知，可能已发送部分数据；重试可能造成重复发送".to_string(),
        ),
    }
}

/// 单 worker 轮询读取数据并串行处理唯一排队发送；完成发送后释放单飞标志。
fn read_loop(
    app: AppHandle,
    mut port: SerialPort,
    commands: mpsc::Receiver<WorkerCommand>,
    stop: Arc<AtomicBool>,
    write_pending: Arc<AtomicBool>,
) -> bool {
    let mut buffer = [0_u8; READ_BUFFER_SIZE];
    while !stop.load(Ordering::Acquire) {
        match commands.try_recv() {
            Ok(WorkerCommand::Write { bytes, result }) => {
                let write_result = write_in_chunks(&mut port, &bytes, &stop);
                write_pending.store(false, Ordering::Release);
                if let Err(error) = result.send(write_result) {
                    eprintln!("发送结果接收方已退出：{error}");
                }
                continue;
            }
            Err(TryRecvError::Disconnected) => break,
            Err(TryRecvError::Empty) => {}
        }
        match port.read(&mut buffer) {
            Ok(0) => continue,
            Ok(length) => {
                if let Err(error) = app.emit(
                    "serial:data",
                    DataEvent {
                        bytes: buffer[..length].to_vec(),
                    },
                ) {
                    eprintln!("发布串口数据事件失败：{error}");
                    return true;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                ) =>
            {
                continue
            }
            Err(error) => {
                if let Err(emit_error) = app.emit("serial:error", error.to_string()) {
                    eprintln!("发布串口错误事件失败：{emit_error}");
                }
                return true;
            }
        }
    }
    false
}

/// 使用总截止时间逐次写入；部分成功后出错会回报已发送字节数。
fn write_in_chunks(port: &mut SerialPort, bytes: &[u8], stop: &AtomicBool) -> Result<(), String> {
    let deadline = Instant::now() + WRITE_TIMEOUT;
    let mut written_total = 0;
    while written_total < bytes.len() {
        if stop.load(Ordering::Acquire) {
            return Err(format!("串口正在关闭，已发送 {written_total} 字节"));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!("串口发送超时，已发送 {written_total} 字节"));
        }
        port.set_write_timeout(remaining.min(WRITE_TIMEOUT))
            .map_err(|error| {
                format!("设置串口写入期限失败，已发送 {written_total} 字节：{error}")
            })?;
        match port.write(&bytes[written_total..]) {
            Ok(0) => return Err(format!("串口写入未取得进展，已发送 {written_total} 字节")),
            Ok(length) => written_total += length,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {
                continue;
            }
            Err(error) => {
                return Err(format!(
                    "串口发送失败，已发送 {written_total} 字节：{error}"
                ));
            }
        }
    }
    Ok(())
}

/// 设置停止标志并 join worker；等待时间受读取超时或单条写入总期限约束。
fn stop_session(session: &SerialSession) -> Result<(), String> {
    session.stop.store(true, Ordering::Release);
    let worker = session
        .worker
        .lock()
        .map_err(|_| "串口线程状态锁异常".to_string())?
        .take();
    if let Some(worker) = worker {
        worker
            .join()
            .map_err(|_| "串口读取线程异常退出".to_string())?;
    }
    Ok(())
}

/// 重新枚举串口并要求请求路径与当前可用设备完全匹配后才允许打开。
fn verify_available_path(path: &str) -> Result<(), String> {
    let available =
        SerialPort::available_ports().map_err(|error| format!("验证串口设备失败：{error}"))?;
    if available
        .iter()
        .any(|candidate| candidate.as_os_str() == Path::new(path).as_os_str())
    {
        return Ok(());
    }
    Err("串口设备当前不可用，请刷新设备列表后重试".to_string())
}
