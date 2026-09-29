//! 终端页串口会话服务：按会话标识独占串口并桥接原始字节到 xterm。

use serde::{Deserialize, Serialize};
use serial2::{CharSize, FlowControl, Parity, SerialPort, Settings, StopBits};
use std::{
    collections::HashMap,
    io::{ErrorKind, Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
        Arc, Weak,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{watch, RwLock};

/// 每个会话允许排队的控制命令数量。
const COMMAND_QUEUE_CAPACITY: usize = 256;
/// 单次 xterm 输入的最大字节数。
const MAX_INPUT_BYTES: usize = 64 * 1024;
/// 每次读取最多发布的串口字节数。
const READ_BUFFER_SIZE: usize = 4096;
/// 串口读取轮询周期，限制关闭等待时间。
const READ_TIMEOUT: Duration = Duration::from_millis(80);
/// 单次底层写调用超时。
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
/// 关闭命令等待串口句柄实际释放的最大时间。
const CLOSE_RELEASE_TIMEOUT: Duration = Duration::from_secs(3);

/// 终端串口会话配置；完整保存设备、波特率、帧格式和流控参数。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSerialConfig {
    /// 前端 pane 对应的稳定会话标识。
    session_id: String,
    /// 操作系统串口设备路径。
    path: String,
    /// 每秒波特数，必须大于零。
    baud_rate: u32,
    /// 数据位数，仅支持 5、6、7、8。
    data_bits: u8,
    /// 校验模式：none、even、odd。
    parity: String,
    /// 停止位数，仅支持 1 或 2。
    stop_bits: u8,
    /// 流控模式：none、hardware、software。
    flow_control: String,
}

/// 终端串口数据事件。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSerialDataEvent {
    session_id: String,
    data: Vec<u8>,
}

/// 终端串口错误事件。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSerialErrorEvent {
    session_id: String,
    message: String,
}

/// 终端串口关闭事件。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSerialClosedEvent {
    session_id: String,
}

/// worker 接收的串口终端控制命令。
enum TerminalSerialCommand {
    Input(Vec<u8>),
}

/// 活动表条目；sender 为 None 时表示设备正在启动，路径仍被预占。
struct TerminalSerialEntry {
    path: String,
    sender: Option<SyncSender<TerminalSerialCommand>>,
    closing: Arc<AtomicBool>,
    released: watch::Receiver<bool>,
}

/// 管理终端页串口会话，并在同一终端管理器内阻止同一设备被重复打开。
#[derive(Default)]
pub struct TerminalSerialService {
    sessions: Arc<RwLock<HashMap<String, TerminalSerialEntry>>>,
}

/// 打开一个终端页串口会话；同一设备已有终端会话时拒绝重复占用。
#[tauri::command]
pub async fn open_terminal_serial_session(
    app: AppHandle,
    service: State<'_, TerminalSerialService>,
    config: TerminalSerialConfig,
) -> Result<(), String> {
    validate_config(&config)?;
    let closing = Arc::new(AtomicBool::new(false));
    let (released_sender, released_receiver) = watch::channel(false);

    {
        let mut sessions = service.sessions.write().await;
        if sessions.contains_key(&config.session_id) {
            return Err("串口终端会话标识已存在".to_string());
        }
        if sessions.values().any(|entry| entry.path == config.path) {
            return Err("该串口已被终端会话占用".to_string());
        }
        sessions.insert(
            config.session_id.clone(),
            TerminalSerialEntry {
                path: config.path.clone(),
                sender: None,
                closing: Arc::clone(&closing),
                released: released_receiver,
            },
        );
    }

    let sessions = Arc::clone(&service.sessions);
    let worker_sessions = Arc::downgrade(&sessions);
    let worker_config = config.clone();
    let worker_closing = Arc::clone(&closing);
    let release_on_error = released_sender.clone();
    let worker_result = match tauri::async_runtime::spawn_blocking(move || {
        start_terminal_serial_worker(
            app,
            worker_config,
            worker_sessions,
            worker_closing,
            released_sender,
        )
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            let _ = release_on_error.send(true);
            sessions.write().await.remove(&config.session_id);
            return Err(format!("启动串口终端任务失败：{error}"));
        }
    };

    let sender = match worker_result {
        Ok(sender) => sender,
        Err(error) => {
            let _ = release_on_error.send(true);
            sessions.write().await.remove(&config.session_id);
            return Err(error);
        }
    };

    let mut session_map = sessions.write().await;
    let Some(entry) = session_map.get_mut(&config.session_id) else {
        closing.store(true, Ordering::Release);
        return Err("串口终端会话在启动期间已关闭".to_string());
    };
    if entry.closing.load(Ordering::Acquire) {
        return Err("串口终端会话在启动期间已关闭".to_string());
    }
    entry.sender = Some(sender);
    Ok(())
}

/// 向指定串口终端写入原始 xterm 输入字节。
#[tauri::command]
pub async fn terminal_serial_send_input(
    service: State<'_, TerminalSerialService>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    if data.len() > MAX_INPUT_BYTES {
        return Err(format!("单次串口终端输入不能超过 {MAX_INPUT_BYTES} 字节"));
    }
    send_command(&service, &session_id, TerminalSerialCommand::Input(data)).await
}

/// 关闭指定串口终端会话，并等待底层 SerialPort 句柄实际释放后才返回。
#[tauri::command]
pub async fn close_terminal_serial_session(
    service: State<'_, TerminalSerialService>,
    session_id: String,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let mut released = {
        let sessions = service.sessions.read().await;
        let Some(entry) = sessions.get(&session_id) else {
            return Ok(());
        };
        entry.closing.store(true, Ordering::Release);
        entry.released.clone()
    };

    wait_for_serial_release(&mut released).await?;
    service.sessions.write().await.remove(&session_id);
    Ok(())
}

/// 从活动表取得 worker sender 并非阻塞投递命令。
async fn send_command(
    service: &TerminalSerialService,
    session_id: &str,
    command: TerminalSerialCommand,
) -> Result<(), String> {
    validate_session_id(session_id)?;
    let sender = {
        let sessions = service.sessions.read().await;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| "串口终端会话不存在或已关闭".to_string())?;
        if entry.closing.load(Ordering::Acquire) {
            return Err("串口终端会话正在关闭".to_string());
        }
        entry
            .sender
            .clone()
            .ok_or_else(|| "串口终端会话仍在启动".to_string())?
    };
    sender.try_send(command).map_err(|error| match error {
        TrySendError::Full(_) => "串口终端命令队列已满".to_string(),
        TrySendError::Disconnected(_) => "串口终端 worker 已停止".to_string(),
    })
}

/// 打开串口并启动唯一 worker；worker 独占句柄并串行处理读写。
fn start_terminal_serial_worker(
    app: AppHandle,
    config: TerminalSerialConfig,
    sessions: Weak<RwLock<HashMap<String, TerminalSerialEntry>>>,
    closing: Arc<AtomicBool>,
    released: watch::Sender<bool>,
) -> Result<SyncSender<TerminalSerialCommand>, String> {
    let mut port = SerialPort::open(&config.path, |mut settings: Settings| {
        settings.set_raw();
        settings.set_baud_rate(config.baud_rate)?;
        settings.set_char_size(match config.data_bits {
            5 => CharSize::Bits5,
            6 => CharSize::Bits6,
            7 => CharSize::Bits7,
            8 => CharSize::Bits8,
            _ => unreachable!("串口参数已在打开前校验"),
        });
        settings.set_stop_bits(match config.stop_bits {
            1 => StopBits::One,
            2 => StopBits::Two,
            _ => unreachable!("串口参数已在打开前校验"),
        });
        settings.set_parity(match config.parity.as_str() {
            "none" => Parity::None,
            "even" => Parity::Even,
            "odd" => Parity::Odd,
            _ => unreachable!("串口参数已在打开前校验"),
        });
        settings.set_flow_control(match config.flow_control.as_str() {
            "none" => FlowControl::None,
            "hardware" => FlowControl::RtsCts,
            "software" => FlowControl::XonXoff,
            _ => unreachable!("串口参数已在打开前校验"),
        });
        Ok(settings)
    })
    .map_err(|error| format!("打开串口终端失败：{error}"))?;
    port.set_read_timeout(READ_TIMEOUT)
        .map_err(|error| format!("设置串口终端读取超时失败：{error}"))?;
    port.set_write_timeout(WRITE_TIMEOUT)
        .map_err(|error| format!("设置串口终端写入超时失败：{error}"))?;

    let (sender, receiver) = mpsc::sync_channel(COMMAND_QUEUE_CAPACITY);
    let session_id = config.session_id.clone();
    thread::Builder::new()
        .name(format!("rivet-terminal-serial-{}", config.session_id))
        .spawn(move || {
            run_terminal_serial_loop(&app, &session_id, &mut port, receiver, &closing);
            drop(port);
            let _ = released.send(true);
            // 先从活动表释放会话，再通知前端可按同一会话标识重新打开设备。
            if let Some(sessions) = sessions.upgrade() {
                let closed_app = app.clone();
                tauri::async_runtime::spawn(async move {
                    sessions.write().await.remove(&session_id);
                    let _ = closed_app.emit(
                        "terminal-serial:closed",
                        TerminalSerialClosedEvent { session_id },
                    );
                });
            } else {
                let _ = app.emit(
                    "terminal-serial:closed",
                    TerminalSerialClosedEvent { session_id },
                );
            }
        })
        .map_err(|error| format!("启动串口终端 worker 失败：{error}"))?;

    Ok(sender)
}

/// 在同一线程内轮询命令和串口输入，避免串口句柄跨线程共享。
fn run_terminal_serial_loop(
    app: &AppHandle,
    session_id: &str,
    port: &mut SerialPort,
    receiver: Receiver<TerminalSerialCommand>,
    closing: &AtomicBool,
) {
    let mut buffer = [0_u8; READ_BUFFER_SIZE];
    loop {
        if closing.load(Ordering::Acquire) {
            break;
        }
        match receiver.try_recv() {
            Ok(TerminalSerialCommand::Input(data)) => {
                if let Err(error) = port.write_all(&data) {
                    emit_terminal_serial_error(
                        app,
                        session_id,
                        format!("串口终端写入失败：{error}"),
                    );
                    break;
                }
            }
            Err(TryRecvError::Disconnected) => break,
            Err(TryRecvError::Empty) => {}
        }

        match port.read(&mut buffer) {
            Ok(0) => {}
            Ok(length) => {
                if app
                    .emit(
                        "terminal-serial:data",
                        TerminalSerialDataEvent {
                            session_id: session_id.to_string(),
                            data: buffer[..length].to_vec(),
                        },
                    )
                    .is_err()
                {
                    break;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                ) => {}
            Err(error) => {
                emit_terminal_serial_error(app, session_id, format!("串口终端读取失败：{error}"));
                break;
            }
        }
    }
}

/// 等待 worker 在关闭 SerialPort 句柄后发出释放信号，避免 UI 关闭后设备仍被占用。
async fn wait_for_serial_release(released: &mut watch::Receiver<bool>) -> Result<(), String> {
    if *released.borrow() {
        return Ok(());
    }

    tokio::time::timeout(CLOSE_RELEASE_TIMEOUT, async {
        loop {
            released
                .changed()
                .await
                .map_err(|_| "串口终端 worker 在释放资源前异常停止".to_string())?;
            if *released.borrow() {
                return Ok(());
            }
        }
    })
    .await
    .map_err(|_| "等待串口资源释放超时".to_string())?
}

/// 发布单个串口终端错误事件；前端负责展示并更新 pane 状态。
fn emit_terminal_serial_error(app: &AppHandle, session_id: &str, message: String) {
    let _ = app.emit(
        "terminal-serial:error",
        TerminalSerialErrorEvent {
            session_id: session_id.to_string(),
            message,
        },
    );
}

/// 校验会话标识、设备路径、波特率及当前系统可见设备。
fn validate_config(config: &TerminalSerialConfig) -> Result<(), String> {
    validate_session_id(&config.session_id)?;
    if config.path.trim().is_empty() || config.path.len() > 4096 {
        return Err("串口终端设备路径无效".to_string());
    }
    if config.baud_rate == 0 {
        return Err("串口终端波特率必须大于零".to_string());
    }
    if !matches!(config.data_bits, 5..=8) {
        return Err("串口终端数据位仅支持 5、6、7 或 8".to_string());
    }
    if !matches!(config.stop_bits, 1 | 2) {
        return Err("串口终端停止位仅支持 1 或 2".to_string());
    }
    if !matches!(config.parity.as_str(), "none" | "even" | "odd") {
        return Err("串口终端校验位参数无效".to_string());
    }
    if !matches!(
        config.flow_control.as_str(),
        "none" | "hardware" | "software"
    ) {
        return Err("串口终端流控参数无效".to_string());
    }
    let available =
        SerialPort::available_ports().map_err(|error| format!("验证串口终端设备失败：{error}"))?;
    if !available
        .iter()
        .any(|candidate| candidate.as_os_str() == Path::new(&config.path).as_os_str())
    {
        return Err("串口设备当前不可用".to_string());
    }
    Ok(())
}

/// 校验前端会话标识，避免空标识或异常大键进入活动表。
fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.trim().is_empty() || session_id.len() > 128 {
        return Err("串口终端会话标识无效".to_string());
    }
    Ok(())
}
