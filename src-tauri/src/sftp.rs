//! SFTP 文件管理。
//!
//! 本模块通过活动 SSH 连接创建独立 SFTP subsystem worker，负责目录浏览和文件操作。
//! 上传和下载均先写临时文件，成功后再替换最终路径，避免失败时留下半成品。

use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use russh::client;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tokio::{
    io::{copy, AsyncWriteExt},
    sync::{mpsc, oneshot},
};

use crate::ssh::{request_sftp_sender, SshService};

/// SFTP worker 的有界命令队列容量。
const SFTP_COMMAND_QUEUE_CAPACITY: usize = 32;
/// 前端允许提交的远端路径最大 UTF-8 字节数。
const MAX_REMOTE_PATH_BYTES: usize = 4096;
/// 单个远端文件名允许的最大 UTF-8 字节数。
const MAX_REMOTE_NAME_BYTES: usize = 255;

/// SFTP 文件类型。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SftpEntryKind {
    /// 普通目录。
    Directory,
    /// 普通文件。
    File,
    /// 符号链接。
    Symlink,
    /// 其他特殊节点。
    Other,
}

/// 前端文件列表中的单个远端条目。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    /// 文件名，不包含父路径。
    pub name: String,
    /// SFTP 远端完整路径。
    pub path: String,
    /// 文件类型。
    pub kind: SftpEntryKind,
    /// 文件大小，未知时为 0。
    pub size: u64,
    /// Unix 修改时间，服务器未提供时为空。
    pub modified: Option<u32>,
}

/// SFTP 目录列表结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpDirectory {
    /// 服务器规范化后的当前目录。
    pub path: String,
    /// 已排序的直接子项，目录优先。
    pub entries: Vec<SftpEntry>,
}

/// 独立 SFTP worker 支持的操作。
pub(crate) enum SftpCommand {
    /// 读取一个目录。
    List {
        path: String,
        result: oneshot::Sender<Result<SftpDirectory, String>>,
    },
    /// 将本地文件原子上传到远端路径。
    Upload {
        local_path: PathBuf,
        remote_path: String,
        result: oneshot::Sender<Result<(), String>>,
    },
    /// 将远端文件原子下载到本地路径。
    Download {
        remote_path: String,
        local_path: PathBuf,
        result: oneshot::Sender<Result<(), String>>,
    },
    /// 删除文件、链接或空目录。
    Delete {
        path: String,
        result: oneshot::Sender<Result<(), String>>,
    },
    /// 在同一父目录内重命名。
    Rename {
        old_path: String,
        new_path: String,
        result: oneshot::Sender<Result<(), String>>,
    },
    /// 关闭 SFTP subsystem。
    Close,
}

/// 在已经认证的 SSH 连接上创建 SFTP subsystem，并启动独立文件 worker。
pub(crate) async fn start_sftp_worker<H>(
    session: &client::Handle<H>,
) -> Result<mpsc::Sender<SftpCommand>, String>
where
    H: client::Handler,
{
    let channel = session
        .channel_open_session()
        .await
        .map_err(|error| format!("创建 SFTP 通道失败：{error}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| format!("启动 SFTP subsystem 失败：{error}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|error| format!("初始化 SFTP 会话失败：{error}"))?;

    let (sender, receiver) = mpsc::channel(SFTP_COMMAND_QUEUE_CAPACITY);
    tauri::async_runtime::spawn(run_sftp_worker(sftp, receiver));
    Ok(sender)
}

/// 返回远端目录条目；路径在服务器端 canonicalize 后返回给前端。
#[tauri::command]
pub async fn sftp_list(
    service: State<'_, SshService>,
    session_id: String,
    path: String,
) -> Result<SftpDirectory, String> {
    validate_remote_path(&path)?;
    let sender = request_sftp_sender(&service, &session_id).await?;
    let (result_sender, result_receiver) = oneshot::channel();
    sender
        .send(SftpCommand::List {
            path,
            result: result_sender,
        })
        .await
        .map_err(|_| "SFTP worker 已停止".to_string())?;
    result_receiver
        .await
        .map_err(|_| "SFTP worker 未返回目录结果".to_string())?
}

/// 打开系统文件选择器，并把选中的文件上传到当前远端目录。
///
/// 返回 None 表示用户取消；成功时返回最终远端路径。
#[tauri::command]
pub async fn sftp_upload_file(
    app: AppHandle,
    service: State<'_, SshService>,
    session_id: String,
    remote_directory: String,
) -> Result<Option<String>, String> {
    validate_remote_path(&remote_directory)?;
    let selected =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_file())
            .await
            .map_err(|error| format!("打开上传文件对话框失败：{error}"))?;

    let Some(selected) = selected else {
        return Ok(None);
    };
    let local_path = selected
        .into_path()
        .map_err(|error| format!("本地文件路径无效：{error}"))?;
    let file_name = local_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "本地文件名不是有效 UTF-8".to_string())?;
    validate_remote_name(file_name)?;
    let remote_path = join_remote_path(&remote_directory, file_name)?;

    let sender = request_sftp_sender(&service, &session_id).await?;
    let (result_sender, result_receiver) = oneshot::channel();
    sender
        .send(SftpCommand::Upload {
            local_path,
            remote_path: remote_path.clone(),
            result: result_sender,
        })
        .await
        .map_err(|_| "SFTP worker 已停止".to_string())?;
    result_receiver
        .await
        .map_err(|_| "SFTP worker 未返回上传结果".to_string())??;
    Ok(Some(remote_path))
}

/// 打开系统保存对话框，把远端文件下载到用户选择的位置。
///
/// 返回 false 表示用户取消。
#[tauri::command]
pub async fn sftp_download_file(
    app: AppHandle,
    service: State<'_, SshService>,
    session_id: String,
    remote_path: String,
) -> Result<bool, String> {
    validate_remote_path(&remote_path)?;
    let suggested_name = remote_file_name(&remote_path)?.to_string();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(suggested_name)
            .blocking_save_file()
    })
    .await
    .map_err(|error| format!("打开下载保存对话框失败：{error}"))?;

    let Some(selected) = selected else {
        return Ok(false);
    };
    let local_path = selected
        .into_path()
        .map_err(|error| format!("本地保存路径无效：{error}"))?;

    let sender = request_sftp_sender(&service, &session_id).await?;
    let (result_sender, result_receiver) = oneshot::channel();
    sender
        .send(SftpCommand::Download {
            remote_path,
            local_path,
            result: result_sender,
        })
        .await
        .map_err(|_| "SFTP worker 已停止".to_string())?;
    result_receiver
        .await
        .map_err(|_| "SFTP worker 未返回下载结果".to_string())??;
    Ok(true)
}

/// 删除远端文件、符号链接或空目录；类型由服务端元数据确定。
#[tauri::command]
pub async fn sftp_delete(
    service: State<'_, SshService>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    validate_remote_path(&path)?;
    let sender = request_sftp_sender(&service, &session_id).await?;
    let (result_sender, result_receiver) = oneshot::channel();
    sender
        .send(SftpCommand::Delete {
            path,
            result: result_sender,
        })
        .await
        .map_err(|_| "SFTP worker 已停止".to_string())?;
    result_receiver
        .await
        .map_err(|_| "SFTP worker 未返回删除结果".to_string())?
}

/// 重命名远端条目；新名称只能是同一目录内的单个文件名。
///
/// 成功后返回新完整路径。
#[tauri::command]
pub async fn sftp_rename(
    service: State<'_, SshService>,
    session_id: String,
    old_path: String,
    new_name: String,
) -> Result<String, String> {
    validate_remote_path(&old_path)?;
    validate_remote_name(&new_name)?;
    let parent = remote_parent_path(&old_path);
    let new_path = join_remote_path(&parent, &new_name)?;

    let sender = request_sftp_sender(&service, &session_id).await?;
    let (result_sender, result_receiver) = oneshot::channel();
    sender
        .send(SftpCommand::Rename {
            old_path,
            new_path: new_path.clone(),
            result: result_sender,
        })
        .await
        .map_err(|_| "SFTP worker 已停止".to_string())?;
    result_receiver
        .await
        .map_err(|_| "SFTP worker 未返回重命名结果".to_string())??;
    Ok(new_path)
}

/// 顺序执行文件操作；该 worker 与终端 shell worker 独立，长传输不会阻塞键盘输入。
async fn run_sftp_worker(sftp: SftpSession, mut commands: mpsc::Receiver<SftpCommand>) {
    while let Some(command) = commands.recv().await {
        match command {
            SftpCommand::List { path, result } => {
                let _ = result.send(list_directory(&sftp, path).await);
            }
            SftpCommand::Upload {
                local_path,
                remote_path,
                result,
            } => {
                let _ = result.send(upload_file(&sftp, &local_path, &remote_path).await);
            }
            SftpCommand::Download {
                remote_path,
                local_path,
                result,
            } => {
                let _ = result.send(download_file(&sftp, &remote_path, &local_path).await);
            }
            SftpCommand::Delete { path, result } => {
                let _ = result.send(delete_entry(&sftp, &path).await);
            }
            SftpCommand::Rename {
                old_path,
                new_path,
                result,
            } => {
                let _ = result.send(rename_entry(&sftp, &old_path, &new_path).await);
            }
            SftpCommand::Close => break,
        }
    }

    let _ = sftp.close().await;
}

/// 读取并排序一个远端目录。
async fn list_directory(sftp: &SftpSession, path: String) -> Result<SftpDirectory, String> {
    let canonical = sftp
        .canonicalize(path)
        .await
        .map_err(|error| format!("解析 SFTP 路径失败：{error}"))?;
    validate_remote_path(&canonical)?;
    let directory = sftp
        .read_dir(canonical.clone())
        .await
        .map_err(|error| format!("读取 SFTP 目录失败：{error}"))?;

    let mut entries = directory
        .filter(|entry| !matches!(entry.file_name().as_str(), "." | ".."))
        .map(|entry| {
            let metadata = entry.metadata();
            let kind = if metadata.is_dir() {
                SftpEntryKind::Directory
            } else if metadata.is_regular() {
                SftpEntryKind::File
            } else if metadata.is_symlink() {
                SftpEntryKind::Symlink
            } else {
                SftpEntryKind::Other
            };
            SftpEntry {
                name: entry.file_name(),
                path: entry.path(),
                kind,
                size: metadata.len(),
                modified: metadata.mtime,
            }
        })
        .collect::<Vec<_>>();

    entries.sort_by(|left, right| {
        let left_dir = matches!(left.kind, SftpEntryKind::Directory);
        let right_dir = matches!(right.kind, SftpEntryKind::Directory);
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(SftpDirectory {
        path: canonical,
        entries,
    })
}

/// 将本地文件写入远端临时路径，关闭成功后再 rename 到最终文件名。
async fn upload_file(
    sftp: &SftpSession,
    local_path: &Path,
    remote_path: &str,
) -> Result<(), String> {
    validate_remote_path(remote_path)?;
    if sftp
        .try_exists(remote_path.to_string())
        .await
        .map_err(|error| format!("检查远端目标文件失败：{error}"))?
    {
        return Err("远端已存在同名文件，请先重命名或删除".to_string());
    }

    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|error| format!("打开本地上传文件失败：{error}"))?;
    let temporary_path = remote_temporary_path(remote_path)?;
    let mut remote = sftp
        .create(temporary_path.clone())
        .await
        .map_err(|error| format!("创建远端临时文件失败：{error}"))?;

    let transfer_result = async {
        copy(&mut local, &mut remote)
            .await
            .map_err(|error| format!("上传文件失败：{error}"))?;
        remote
            .flush()
            .await
            .map_err(|error| format!("刷新远端文件失败：{error}"))?;
        remote
            .close()
            .await
            .map_err(|error| format!("关闭远端文件失败：{error}"))?;
        sftp.rename(temporary_path.clone(), remote_path.to_string())
            .await
            .map_err(|error| format!("提交远端上传文件失败：{error}"))?;
        Ok::<(), String>(())
    }
    .await;

    if transfer_result.is_err() {
        let _ = sftp.remove_file(temporary_path).await;
    }
    transfer_result
}

/// 将远端文件流式写入本地临时文件，成功后原子替换用户选择的目标。
async fn download_file(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &Path,
) -> Result<(), String> {
    validate_remote_path(remote_path)?;
    let parent = local_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("创建本地临时下载文件失败：{error}"))?;
    let std_file = temporary
        .as_file()
        .try_clone()
        .map_err(|error| format!("打开本地临时下载文件失败：{error}"))?;
    let mut local = tokio::fs::File::from_std(std_file);
    let mut remote = sftp
        .open(remote_path.to_string())
        .await
        .map_err(|error| format!("打开远端下载文件失败：{error}"))?;

    copy(&mut remote, &mut local)
        .await
        .map_err(|error| format!("下载文件失败：{error}"))?;
    remote
        .close()
        .await
        .map_err(|error| format!("关闭远端下载文件失败：{error}"))?;
    local
        .flush()
        .await
        .map_err(|error| format!("刷新本地下载文件失败：{error}"))?;
    local
        .sync_all()
        .await
        .map_err(|error| format!("同步本地下载文件失败：{error}"))?;
    drop(local);

    temporary
        .persist(local_path)
        .map_err(|error| format!("提交本地下载文件失败：{}", error.error))?;
    Ok(())
}

/// 重命名前拒绝覆盖已有目标，避免服务端 rename 语义造成数据丢失。
async fn rename_entry(sftp: &SftpSession, old_path: &str, new_path: &str) -> Result<(), String> {
    if old_path == new_path {
        return Ok(());
    }
    if sftp
        .try_exists(new_path.to_string())
        .await
        .map_err(|error| format!("检查远端重命名目标失败：{error}"))?
    {
        return Err("远端已存在同名条目".to_string());
    }
    sftp.rename(old_path.to_string(), new_path.to_string())
        .await
        .map_err(|error| format!("SFTP 重命名失败：{error}"))
}

/// 根据远端元数据删除文件、链接或空目录。
async fn delete_entry(sftp: &SftpSession, path: &str) -> Result<(), String> {
    let metadata = sftp
        .symlink_metadata(path.to_string())
        .await
        .map_err(|error| format!("读取远端条目元数据失败：{error}"))?;
    if metadata.is_dir() {
        sftp.remove_dir(path.to_string())
            .await
            .map_err(|error| format!("删除远端目录失败：{error}"))
    } else {
        sftp.remove_file(path.to_string())
            .await
            .map_err(|error| format!("删除远端文件失败：{error}"))
    }
}

/// 校验前端或服务端返回的远端路径。
fn validate_remote_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > MAX_REMOTE_PATH_BYTES || path.contains('\0') {
        return Err("SFTP 路径为空、过长或包含非法字符".to_string());
    }
    Ok(())
}

/// 校验同一目录内的文件名，禁止路径分隔符和特殊目录名。
fn validate_remote_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > MAX_REMOTE_NAME_BYTES
        || matches!(name, "." | "..")
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err("SFTP 文件名无效".to_string());
    }
    Ok(())
}

/// 使用 SFTP / 分隔规则组合目录和文件名。
fn join_remote_path(directory: &str, name: &str) -> Result<String, String> {
    validate_remote_path(directory)?;
    validate_remote_name(name)?;
    let directory = directory.trim_end_matches('/');
    let path = if directory.is_empty() {
        format!("/{name}")
    } else {
        format!("{directory}/{name}")
    };
    validate_remote_path(&path)?;
    Ok(path)
}

/// 返回远端路径的父目录；根目录保持 /。
fn remote_parent_path(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => "/".to_string(),
        Some(index) => trimmed[..index].to_string(),
        None => ".".to_string(),
    }
}

/// 返回远端路径最后一个非空组件。
fn remote_file_name(path: &str) -> Result<&str, String> {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "远端文件名无效".to_string())
}

/// 为原子上传生成同目录临时文件名。
fn remote_temporary_path(remote_path: &str) -> Result<String, String> {
    let parent = remote_parent_path(remote_path);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let name = format!(".rivet-upload-{}-{nanos}", std::process::id());
    join_remote_path(&parent, &name)
}
