//! Markdown 的 Tauri 命令边界；本地文件操作移到工作线程，远程操作交给已有 SFTP 队列。
//! 本地任务拥有移入的参数；前端取消等待不会终止阻塞任务，任务结束后释放资源。

use crate::markdown_file::{self, MarkdownFile};
use crate::markdown_folder::{self, FolderDirectory};
use crate::{
    sftp::SftpCommand,
    ssh::{request_sftp_sender, SshService},
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tokio::{
    sync::oneshot,
    time::{timeout, Duration},
};

/// 选择并读取本地 Markdown，取消时返回 None。
///
/// # 参数
/// - `app`：当前应用句柄，仅用于在用户桌面显示文件选择器。
/// # Errors
/// 对话框、工作线程或读取失败返回可展示错误，不修改文件。
#[tauri::command]
pub(crate) async fn markdown_open_local(app: AppHandle) -> Result<Option<MarkdownFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selected) = app
            .dialog()
            .file()
            .add_filter("Markdown", &["md", "markdown"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|error| format!("文件路径无效 / Invalid file path: {error}"))?;
        markdown_file::read_local(&path).map(Some)
    })
    .await
    .map_err(|error| format!("读取任务失败 / Read task failed: {error}"))?
}

/// 选择本地工作区文件夹并读取第一层，取消时返回 None，不影响已有草稿。
///
/// # 参数
/// - `app`：只用于显示系统目录选择器的当前应用句柄。
/// # Errors
/// 选择器、工作线程或目录读取失败时返回错误，不修改任何文件。
#[tauri::command]
pub(crate) async fn markdown_open_folder(
    app: AppHandle,
) -> Result<Option<FolderDirectory>, String> {
    // app 移入工作线程，仅选择和读取目录，取消对话框不改变文件。
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selected) = app.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            // error 为选择器路径转换错误，保留原因交给界面。
            .map_err(|error| format!("文件夹路径无效 / Invalid folder path: {error}"))?;
        let root = markdown_folder::canonical_root(&path)?;
        markdown_folder::list_directory(&root, &root).map(Some)
    })
    .await
    // error 为工作线程异常，目录读取未修改任何文件。
    .map_err(|error| format!("打开文件夹任务失败 / Folder task failed: {error}"))?
}

/// 按需读取本地工作区的一层目录，不阻塞桌面事件循环。
///
/// # 参数
/// - `root`：目录选择器返回的工作区绝对根路径。
/// - `path`：根目录或其内部普通目录的绝对路径。
/// # Errors
/// 路径越界、链接、权限或目录上限错误传播给文件树，原列表保持不变。
#[tauri::command]
pub(crate) async fn markdown_list_folder(
    root: String,
    path: String,
) -> Result<FolderDirectory, String> {
    // root 和 path 移入只读任务，不跨 await 借用路径或持锁。
    tauri::async_runtime::spawn_blocking(move || {
        markdown_folder::list_directory(std::path::Path::new(&root), std::path::Path::new(&path))
    })
    .await
    // error 为任务退出错误，与目录内的 I/O 错误一并返回界面。
    .map_err(|error| format!("目录读取任务失败 / Folder read task failed: {error}"))?
}

/// 在所选根目录创建单个空文件夹，返回新节点的绝对路径。
///
/// # 参数
/// - `root`：用户明确选择的工作区根目录。
/// - `name`：单个文件夹名称，不允许路径分隔符或特殊目录名。
/// # Errors
/// 校验、同名节点、目录容量、权限或线程错误直接返回，不覆盖任何已有节点。
#[tauri::command]
pub(crate) async fn markdown_create_folder(root: String, name: String) -> Result<String, String> {
    // root、name 移交工作线程，只创建一个目录；任务取消等待后仍会执行到返回。
    tauri::async_runtime::spawn_blocking(move || {
        markdown_folder::create_directory(std::path::Path::new(&root), &name)
    })
    .await
    // error 为线程退出错误，不能据此假定目录创建已回滚。
    .map_err(|error| format!("创建文件夹任务失败 / Folder creation task failed: {error}"))?
}

/// 读取文件树选中的本地 Markdown，不重新弹出文件选择器。
///
/// # 参数
/// - `root`：用户明确选择的工作区根目录。
/// - `path`：根目录内待打开的 Markdown 绝对路径。
/// # Errors
/// 文件边界、编码、大小或读取失败时返回错误，调用方保留当前编辑内容。
#[tauri::command]
pub(crate) async fn markdown_open_folder_file(
    root: String,
    path: String,
) -> Result<MarkdownFile, String> {
    // root 和 path 由该工作线程持有；结果只包含正文，不留下文件句柄。
    tauri::async_runtime::spawn_blocking(move || {
        markdown_folder::read_file(std::path::Path::new(&root), std::path::Path::new(&path))
    })
    .await
    // error 为任务退出错误，不将失败标记成文件已打开。
    .map_err(|error| format!("文件读取任务失败 / File read task failed: {error}"))?
}

/// 保存本地 Markdown；path 为空时选择新文件，取消时返回 None。
///
/// # 参数
/// - `app`：显示另存为对话框的应用句柄。
/// - `path`：原文件路径；None 打开保存对话框，新目标不覆盖已有文件。
/// - `content`：最多 2 MiB 的 UTF-8 正文。
/// - `revision`：原文件摘要；原路径保存时必须提供，另存为时忽略。
/// - `directory`：新文件保存对话框的初始目录；只影响默认位置，最终路径由用户选择。
/// # Errors
/// 参数、选择器、I/O 或冲突失败返回错误，编辑器应保留草稿。
#[tauri::command]
pub(crate) async fn markdown_save_local(
    app: AppHandle,
    path: Option<String>,
    content: String,
    revision: Option<String>,
    directory: Option<String>,
) -> Result<Option<MarkdownFile>, String> {
    markdown_file::validate_content(&content)?;
    // 文件参数和 app 移交工作线程；写入锁及临时文件由 markdown_file 负责释放。
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(path) = path {
            let revision = revision
                .as_deref()
                .ok_or("缺少文件版本 / Missing file revision")?;
            return markdown_file::write_local(
                std::path::Path::new(&path),
                &content,
                Some(revision),
            )
            .map(Some);
        }
        let mut dialog = app
            .dialog()
            .file()
            .add_filter("Markdown", &["md", "markdown"])
            .set_file_name("Untitled.md");
        // 初始位置必须是仍可访问的真实目录；失效时返回错误并保留草稿。
        if let Some(directory) = directory {
            dialog = dialog.set_directory(markdown_folder::canonical_root(std::path::Path::new(
                &directory,
            ))?);
        }
        let Some(selected) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            // error 为保存目标转换错误，不启动文件写入。
            .map_err(|error| format!("文件路径无效 / Invalid file path: {error}"))?;
        markdown_file::write_local(&path, &content, None).map(Some)
    })
    .await
    // error 为工作线程退出错误；前端保留草稿，不能假定写入已回滚。
    .map_err(|error| format!("保存任务失败 / Save task failed: {error}"))?
}

/// 包括命令排队的最大等待时间为 60 秒；超时不表示服务器已回滚，前端保留草稿。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// 通过已认证的 SSH 会话读取远端文件；没有独立服务器凭据。
///
/// # 参数
/// - `service`：现有 SSH 会话注册表，借用仅用于取得 SFTP 队列。
/// - `session_id`：当前连接的会话标识，连接关闭后不可复用。
/// - `path`：服务器上的 md/markdown 普通文件路径，最长 4096 字节。
/// # Errors
/// 未连接、超时、非法文件或读取失败返回错误，不修改远端。
#[tauri::command]
pub(crate) async fn markdown_open_remote(
    service: State<'_, SshService>,
    session_id: String,
    path: String,
) -> Result<MarkdownFile, String> {
    markdown_file::validate_path(&path)?;
    timeout(REQUEST_TIMEOUT, async {
        let sender = request_sftp_sender(&service, &session_id).await?;
        let (result, receiver) = oneshot::channel();
        sender
            .send(SftpCommand::ReadMarkdown { path, result })
            .await
            .map_err(|_| "SFTP worker 已停止 / SFTP worker stopped")?;
        receiver
            .await
            .map_err(|_| "SFTP 未返回读取结果 / Missing SFTP read result")?
    })
    .await
    .map_err(|_| "远端读取超时 / Remote read timed out".to_string())?
}

/// 保存已经打开的远端文件，摘要不一致时拒绝覆盖。
///
/// # 参数
/// - `service`：活动 SSH 会话注册表，不保存额外认证信息。
/// - `session_id`：打开该文件的活动会话标识。
/// - `path`：读取时返回的服务器文件路径，不允许符号链接。
/// - `content`：最多 2 MiB 的 UTF-8 新正文，所有权移交给 worker。
/// - `revision`：上次成功读取或保存的内容摘要。
/// # Errors
/// 冲突、断线或保存失败返回错误；超时后需重新读取确认服务器状态。
#[tauri::command]
pub(crate) async fn markdown_save_remote(
    service: State<'_, SshService>,
    session_id: String,
    path: String,
    content: String,
    revision: String,
) -> Result<MarkdownFile, String> {
    markdown_file::validate_path(&path)?;
    markdown_file::validate_content(&content)?;
    timeout(REQUEST_TIMEOUT, async {
        let sender = request_sftp_sender(&service, &session_id).await?;
        let (result, receiver) = oneshot::channel();
        sender.send(SftpCommand::WriteMarkdown { path, content, revision, result }).await.map_err(|_| "SFTP worker 已停止 / SFTP worker stopped")?;
        receiver.await.map_err(|_| "SFTP 未返回保存结果 / Missing SFTP save result")?
    }).await.map_err(|_| "远端保存超时，请重新打开确认状态；草稿已保留 / Save timed out; reopen to check server state; draft retained".to_string())?
}

/// 在活动 SSH 会话创建空 Markdown，不覆盖同名节点。
///
/// # 参数
/// - `service`：活动会话注册表，仅用于借用有界 SFTP 队列，不持锁等待 I/O。
/// - `session_id`：用户在选择器中明确选择的已认证会话。
/// - `path`：服务器新文件路径，最长 4096 字节，必须以 md/markdown 结尾。
/// # Errors
/// 参数、断线、权限或已有目标错误直接返回；超时不等于回滚，应重新打开路径确认。
#[tauri::command]
pub(crate) async fn markdown_create_remote(
    service: State<'_, SshService>,
    session_id: String,
    path: String,
) -> Result<MarkdownFile, String> {
    markdown_file::validate_path(&path)?;
    timeout(REQUEST_TIMEOUT, async {
        let sender = request_sftp_sender(&service, &session_id).await?;
        let (result, receiver) = oneshot::channel();
        sender
            .send(SftpCommand::CreateMarkdown { path, result })
            .await
            .map_err(|_| "SFTP worker 已停止 / SFTP worker stopped")?;
        receiver
            .await
            .map_err(|_| "SFTP 未返回创建结果 / Missing SFTP creation result")?
    })
    .await
    .map_err(|_| {
        "远端创建超时，请重新打开确认状态 / Creation timed out; reopen to check server state"
            .to_string()
    })?
}
