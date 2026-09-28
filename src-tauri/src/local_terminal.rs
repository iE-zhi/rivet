//! 本地 PTY 终端会话服务。
//!
//! Windows 使用 ConPTY 启动 PowerShell；Unix 使用用户的 SHELL。阻塞 PTY I/O 全部运行在
//! 独立线程，不占用 Tauri async runtime。

use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc,
    },
    thread,
    time::Duration,
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;

/// 单个本地终端命令队列容量。
const COMMAND_QUEUE_CAPACITY: usize = 256;
/// 单次输入最大字节数。
const MAX_INPUT_BYTES: usize = 64 * 1024;
/// PTY 最大列数。
const MAX_COLUMNS: u16 = 1000;
/// PTY 最大行数。
const MAX_ROWS: u16 = 500;
/// worker 等待命令的轮询周期，用于同时检测子进程退出。
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(80);

/// 活动本地终端会话表。
#[derive(Default)]
pub struct LocalTerminalService {
    sessions: Arc<RwLock<HashMap<String, LocalSessionEntry>>>,
}

/// 活动本地终端条目；shell PID 用于按成熟终端做法检测仍在运行的子进程。
struct LocalSessionEntry {
    sender: SyncSender<LocalCommand>,
    shell_pid: u32,
}

/// 本地终端输出事件。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDataEvent {
    session_id: String,
    data: Vec<u8>,
}

/// 本地终端错误事件。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalErrorEvent {
    session_id: String,
    message: String,
}

/// 本地终端关闭事件。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalClosedEvent {
    session_id: String,
    exit_status: Option<u32>,
}

/// 发给本地 PTY worker 的控制命令。
enum LocalCommand {
    Input(Vec<u8>),
    Resize { columns: u16, rows: u16 },
    Close,
}

/// 创建本地 PTY 会话。
#[tauri::command]
pub async fn open_local_terminal(
    app: AppHandle,
    service: State<'_, LocalTerminalService>,
    session_id: String,
    columns: u16,
    rows: u16,
    shell_integration_token: Option<String>,
    powershell_mode: Option<String>,
) -> Result<Option<String>, String> {
    validate_session_id(&session_id)?;
    validate_terminal_size(columns, rows)?;

    {
        let sessions = service.sessions.read().await;
        if sessions.contains_key(&session_id) {
            return Err("本地终端会话标识已存在".to_string());
        }
    }

    let sessions = Arc::clone(&service.sessions);
    let worker_sessions = Arc::clone(&sessions);
    let worker_session_id = session_id.clone();
    let (sender, shell_pid, shell_kind) = tauri::async_runtime::spawn_blocking(move || {
        start_local_worker(
            app,
            worker_session_id,
            columns,
            rows,
            shell_integration_token,
            powershell_mode,
            worker_sessions,
        )
    })
    .await
    .map_err(|error| format!("启动本地终端任务失败：{error}"))??;

    let mut sessions = sessions.write().await;
    if sessions.contains_key(&session_id) {
        let _ = sender.try_send(LocalCommand::Close);
        return Err("本地终端会话标识已存在".to_string());
    }
    sessions.insert(
        session_id.clone(),
        LocalSessionEntry {
            sender: sender.clone(),
            shell_pid,
        },
    );
    drop(sessions);

    if let Err(error) = sender.try_send(LocalCommand::Resize { columns, rows }) {
        service.sessions.write().await.remove(&session_id);
        return Err(match error {
            TrySendError::Full(_) => "本地终端启动后命令队列异常".to_string(),
            TrySendError::Disconnected(_) => "本地终端 Shell 启动后立即退出".to_string(),
        });
    }
    Ok(shell_kind)
}

/// 向本地 PTY 写入键盘字节。
#[tauri::command]
pub async fn local_terminal_send_input(
    service: State<'_, LocalTerminalService>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    if data.len() > MAX_INPUT_BYTES {
        return Err(format!("单次本地终端输入不能超过 {MAX_INPUT_BYTES} 字节"));
    }
    send_command(&service, &session_id, LocalCommand::Input(data)).await
}

/// 调整本地 PTY 窗口尺寸。
#[tauri::command]
pub async fn local_terminal_resize(
    service: State<'_, LocalTerminalService>,
    session_id: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    validate_terminal_size(columns, rows)?;
    send_command(
        &service,
        &session_id,
        LocalCommand::Resize { columns, rows },
    )
    .await
}

/// 检查本地 shell 是否仍有子进程；用于关闭前确认，不把已经结束的短命令视为活跃。
#[tauri::command]
pub async fn local_terminal_has_child_processes(
    service: State<'_, LocalTerminalService>,
    session_id: String,
) -> Result<bool, String> {
    validate_session_id(&session_id)?;
    let shell_pid = {
        let sessions = service.sessions.read().await;
        sessions
            .get(&session_id)
            .map(|entry| entry.shell_pid)
            .ok_or_else(|| "本地终端会话不存在或已关闭".to_string())?
    };

    tauri::async_runtime::spawn_blocking(move || has_process_descendant(shell_pid))
        .await
        .map_err(|error| format!("检查本地终端子进程失败：{error}"))
}

/// 关闭本地 PTY 会话。
#[tauri::command]
pub async fn close_local_terminal(
    service: State<'_, LocalTerminalService>,
    session_id: String,
) -> Result<(), String> {
    send_command(&service, &session_id, LocalCommand::Close).await
}

/// 从活动表中获取 worker sender，并使用 try_send 避免阻塞 async runtime。
async fn send_command(
    service: &LocalTerminalService,
    session_id: &str,
    command: LocalCommand,
) -> Result<(), String> {
    let sender = {
        let sessions = service.sessions.read().await;
        sessions
            .get(session_id)
            .map(|entry| entry.sender.clone())
            .ok_or_else(|| "本地终端会话不存在或已关闭".to_string())?
    };

    sender.try_send(command).map_err(|error| match error {
        TrySendError::Full(_) => "本地终端命令队列已满".to_string(),
        TrySendError::Disconnected(_) => "本地终端 worker 已停止".to_string(),
    })
}

/// 创建 PTY、启动 shell，并为其启动控制线程和输出读取线程。
fn start_local_worker(
    app: AppHandle,
    session_id: String,
    columns: u16,
    rows: u16,
    shell_integration_token: Option<String>,
    powershell_mode: Option<String>,
    sessions: Arc<RwLock<HashMap<String, LocalSessionEntry>>>,
) -> Result<(SyncSender<LocalCommand>, u32, Option<String>), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols: columns,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("创建本地 PTY 失败：{error}"))?;

    let shell_kind = default_shell_integration_kind(shell_integration_token.as_deref());
    let mut command = default_shell_command(
        shell_integration_token.as_deref(),
        powershell_mode.as_deref(),
    )?;
    command.env("TERM", "xterm-256color");
    if let Some(home) = user_home_directory() {
        command.cwd(home);
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("启动本地 Shell 失败：{error}"))?;
    let shell_pid = child
        .process_id()
        .ok_or_else(|| "无法获取本地 Shell 进程标识".to_string())?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("创建 PTY 输出 reader 失败：{error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("创建 PTY 输入 writer 失败：{error}"))?;

    let (sender, receiver) = mpsc::sync_channel(COMMAND_QUEUE_CAPACITY);

    let reader_app = app.clone();
    let reader_session_id = session_id.clone();
    thread::Builder::new()
        .name(format!("rivet-local-reader-{session_id}"))
        .spawn(move || read_output(reader_app, reader_session_id, reader))
        .map_err(|error| format!("启动本地终端输出线程失败：{error}"))?;

    thread::Builder::new()
        .name(format!("rivet-local-worker-{session_id}"))
        .spawn(move || {
            run_worker(
                app,
                session_id,
                pair.master,
                writer,
                child,
                receiver,
                sessions,
            )
        })
        .map_err(|error| format!("启动本地终端 worker 失败：{error}"))?;

    Ok((sender, shell_pid, shell_kind))
}

/// 循环读取 PTY 输出并发送给前端；EOF 正常结束。
fn read_output(app: AppHandle, session_id: String, mut reader: Box<dyn Read + Send>) {
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => {
                let _ = app.emit(
                    "local:data",
                    LocalDataEvent {
                        session_id: session_id.clone(),
                        data: buffer[..length].to_vec(),
                    },
                );
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::UnexpectedEof
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::ConnectionAborted
                        | std::io::ErrorKind::NotConnected
                ) =>
            {
                break;
            }
            Err(error) => {
                let _ = app.emit(
                    "local:error",
                    LocalErrorEvent {
                        session_id,
                        message: format!("读取本地终端输出失败：{error}"),
                    },
                );
                break;
            }
        }
    }
}

/// 处理输入、resize、关闭以及子进程退出。
fn run_worker(
    app: AppHandle,
    session_id: String,
    master: Box<dyn MasterPty + Send>,
    mut writer: Box<dyn Write + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    receiver: Receiver<LocalCommand>,
    sessions: Arc<RwLock<HashMap<String, LocalSessionEntry>>>,
) {
    let mut exit_status = None;
    let mut worker_error = None;

    loop {
        match receiver.recv_timeout(CHILD_POLL_INTERVAL) {
            Ok(LocalCommand::Input(data)) => {
                if let Err(error) = writer.write_all(&data).and_then(|_| writer.flush()) {
                    worker_error = Some(format!("写入本地终端失败：{error}"));
                    break;
                }
            }
            Ok(LocalCommand::Resize { columns, rows }) => {
                if let Err(error) = master.resize(PtySize {
                    rows,
                    cols: columns,
                    pixel_width: 0,
                    pixel_height: 0,
                }) {
                    worker_error = Some(format!("调整本地 PTY 尺寸失败：{error}"));
                    break;
                }
            }
            Ok(LocalCommand::Close) => {
                let _ = child.kill();
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.kill();
                break;
            }
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                exit_status = Some(status.exit_code());
                break;
            }
            Ok(None) => {}
            Err(error) => {
                worker_error = Some(format!("查询本地 Shell 状态失败：{error}"));
                break;
            }
        }
    }

    if exit_status.is_none() {
        if let Ok(status) = child.wait() {
            exit_status = Some(status.exit_code());
        }
    }

    drop(writer);
    drop(master);

    if let Some(message) = worker_error {
        let _ = app.emit(
            "local:error",
            LocalErrorEvent {
                session_id: session_id.clone(),
                message,
            },
        );
    }

    let _ = app.emit(
        "local:closed",
        LocalClosedEvent {
            session_id: session_id.clone(),
            exit_status,
        },
    );

    tauri::async_runtime::spawn(async move {
        sessions.write().await.remove(&session_id);
    });
}

/// 平台默认交互 shell。
fn default_shell_command(
    shell_integration_token: Option<&str>,
    powershell_mode: Option<&str>,
) -> Result<CommandBuilder, String> {
    #[cfg(windows)]
    {
        let mut command = CommandBuilder::new(select_windows_powershell(powershell_mode)?);
        command.arg("-NoLogo");
        if let Some(token) = shell_integration_token {
            validate_shell_integration_token(token)?;
            command.arg("-NoExit");
            command.arg("-Command");
            command.arg(powershell_shell_integration_bootstrap(token));
        }
        return Ok(command);
    }

    #[cfg(unix)]
    {
        let _ = shell_integration_token;
        let _ = powershell_mode;
        let shell = env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
        if shell.is_empty() {
            return Err("SHELL 环境变量为空".to_string());
        }
        return Ok(CommandBuilder::new(shell));
    }

    #[allow(unreachable_code)]
    Err("当前平台不支持本地 PTY 终端".to_string())
}

/// 仅对白名单内的交互 shell 启用临时 Shell Integration。
fn default_shell_integration_kind(shell_integration_token: Option<&str>) -> Option<String> {
    #[cfg(windows)]
    {
        return shell_integration_token.map(|_| "powershell".to_string());
    }

    #[cfg(unix)]
    {
        let _ = shell_integration_token;
        let shell = env::var_os("SHELL")?;
        let shell = PathBuf::from(shell);
        let name = shell.file_name()?.to_str()?.to_ascii_lowercase();
        return match name.as_str() {
            "bash" | "zsh" => Some(name),
            _ => None,
        };
    }

    #[allow(unreachable_code)]
    None
}

#[cfg(windows)]
/// 每次打开终端重新探测 PowerShell 7 可执行文件。
fn find_windows_powershell_7() -> Option<PathBuf> {
    for variable in ["ProgramW6432", "ProgramFiles"] {
        if let Some(root) = env::var_os(variable) {
            let candidate = PathBuf::from(root)
                .join("PowerShell")
                .join("7")
                .join("pwsh.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    if let Some(path) = env::var_os("PATH") {
        for directory in env::split_paths(&path) {
            let candidate = directory.join("pwsh.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

#[cfg(windows)]
/// 按本机设置选择 Windows PowerShell；自动模式优先 7，不可用时回退 5.1。
fn select_windows_powershell(mode: Option<&str>) -> Result<PathBuf, String> {
    match mode.unwrap_or("auto") {
        "auto" => {
            Ok(find_windows_powershell_7().unwrap_or_else(|| PathBuf::from("powershell.exe")))
        }
        "ps7" => find_windows_powershell_7().ok_or_else(|| {
            "未找到 PowerShell 7（pwsh.exe），请安装 PowerShell 7 或切换默认 PowerShell。"
                .to_string()
        }),
        "ps5" => Ok(PathBuf::from("powershell.exe")),
        _ => Err("默认 PowerShell 设置无效".to_string()),
    }
}

#[cfg(windows)]
/// 校验前端生成的 Shell Integration 会话标识。
fn validate_shell_integration_token(token: &str) -> Result<(), String> {
    if !(16..=128).contains(&token.len()) || !token.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err("Shell Integration 会话标识无效".to_string());
    }
    Ok(())
}

#[cfg(windows)]
/// 生成仅作用于当前 PowerShell 进程的 Shell Integration 初始化脚本。
fn powershell_shell_integration_bootstrap(token: &str) -> String {
    format!(
        r#"if (-not $global:__RIVET_SHELL_INTEGRATION) {{ $global:__RIVET_SHELL_INTEGRATION=$true; $global:__rivetReadyMarker=([char]27)+']633;RivetReady:{token}'+([char]7); $global:__rivetPromptMarker=([char]27)+']633;RivetPrompt:{token}'+([char]7); $global:__rivetCommandPrefix=([char]27)+']633;RivetCommand:{token}:'; $global:__rivetOriginalPrompt=(Get-Item Function:prompt).ScriptBlock; $global:__rivetSkipHistory=$true; $global:__rivetLastHistoryId=$null; function global:prompt {{ $commandMarker=''; $historyItem=Get-History -Count 1 -ErrorAction SilentlyContinue; if ($global:__rivetSkipHistory) {{ if ($null -ne $historyItem) {{ $global:__rivetLastHistoryId=$historyItem.Id }}; $global:__rivetSkipHistory=$false }} elseif ($null -ne $historyItem -and $historyItem.Id -ne $global:__rivetLastHistoryId) {{ $global:__rivetLastHistoryId=$historyItem.Id; $line=[string]$historyItem.CommandLine; if (-not [string]::IsNullOrWhiteSpace($line) -and $line.IndexOf([char]10) -lt 0 -and $line.IndexOf([char]13) -lt 0) {{ $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line)); $commandMarker=$global:__rivetCommandPrefix+$encoded+([char]7) }} }}; [Console]::Write($commandMarker+$global:__rivetReadyMarker); $promptText=& $global:__rivetOriginalPrompt; (@($promptText) -join '')+$global:__rivetPromptMarker }} }}"#
    )
}

/// 枚举当前进程树，只要 shell 仍有任意直接或间接子进程就返回 true。
fn has_process_descendant(shell_pid: u32) -> bool {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let shell_pid = Pid::from_u32(shell_pid);

    system.processes().keys().copied().any(|candidate_pid| {
        if candidate_pid == shell_pid {
            return false;
        }

        let mut parent = system
            .process(candidate_pid)
            .and_then(|process| process.parent());
        let mut depth = 0_u16;
        while let Some(parent_pid) = parent {
            if parent_pid == shell_pid {
                return true;
            }
            depth += 1;
            if depth >= 128 {
                break;
            }
            parent = system
                .process(parent_pid)
                .and_then(|process| process.parent());
        }
        false
    })
}

/// 优先在用户 Home 目录打开本地终端。
fn user_home_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        return env::var_os("USERPROFILE")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from);
    }
    #[cfg(unix)]
    {
        return env::var_os("HOME")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from);
    }
    #[allow(unreachable_code)]
    None
}

/// 校验前端会话标识。
fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.trim().is_empty() || session_id.len() > 128 {
        return Err("本地终端会话标识无效".to_string());
    }
    Ok(())
}

/// 校验 PTY 字符尺寸。
fn validate_terminal_size(columns: u16, rows: u16) -> Result<(), String> {
    if !(1..=MAX_COLUMNS).contains(&columns) || !(1..=MAX_ROWS).contains(&rows) {
        return Err(format!(
            "本地终端尺寸无效，列数范围 1..={MAX_COLUMNS}，行数范围 1..={MAX_ROWS}"
        ));
    }
    Ok(())
}
