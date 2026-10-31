//! 在现有 SFTP worker 上读写 Markdown；请求按会话串行执行，不通过 Shell。
//! 替换前保留同目录备份，失败时恢复；断线导致恢复失败时返回可人工恢复的路径。

use crate::markdown_file::{self, MarkdownFile, MAX_MARKDOWN_BYTES};
use russh_sftp::{
    client::SftpSession,
    protocol::{FileAttributes, OpenFlags},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 新临时文件只允许账户所有者读写，提交前再恢复原文件权限。
const PRIVATE_FILE_PERMISSIONS: u32 = 0o600;
/// POSIX 文件类型占权限字段低十六位中的高四位，必须整体匹配以排除链接和设备。
const FILE_TYPE_MASK: u32 = 0o170000;
/// 普通文件的 POSIX 类型值；SFTP 未提供类型时拒绝编辑。
const REGULAR_FILE_TYPE: u32 = 0o100000;

/// 有界读取普通远端文件，不接受设备、目录和符号链接。
///
/// # 参数
/// - `sftp`：worker 独占调度的已认证会话，借用期间不另起文件任务。
/// - `path`：通过扩展名校验的远端文件路径。
/// # Errors
/// 元数据、读取、关闭或 UTF-8 校验失败返回错误；句柄显式关闭，正文不被写回。
pub(crate) async fn read_remote(sftp: &SftpSession, path: &str) -> Result<MarkdownFile, String> {
    markdown_file::validate_path(path)?;
    let metadata = sftp
        .symlink_metadata(path)
        .await
        .map_err(|error| format!("读取远端属性失败 / Cannot read remote metadata: {error}"))?;
    if metadata.permissions.map(|mode| mode & FILE_TYPE_MASK) != Some(REGULAR_FILE_TYPE)
        || metadata.len() > MAX_MARKDOWN_BYTES as u64
    {
        return Err(
            "远端仅支持不超过 2 MiB 的普通文件 / Remote file must be regular and up to 2 MiB"
                .into(),
        );
    }
    let mut remote = sftp
        .open(path)
        .await
        .map_err(|error| format!("打开远端文件失败 / Cannot open remote file: {error}"))?;
    let mut bytes = Vec::new();
    let read_result = (&mut remote)
        .take((MAX_MARKDOWN_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await;
    let close_result = remote.close().await;
    read_result.map_err(|error| format!("读取远端文件失败 / Cannot read remote file: {error}"))?;
    close_result
        .map_err(|error| format!("关闭远端文件失败 / Cannot close remote file: {error}"))?;
    let content = String::from_utf8(bytes)
        .map_err(|_| "远端文件不是 UTF-8 / Remote file is not UTF-8".to_string())?;
    markdown_file::validate_content(&content)?;
    Ok(MarkdownFile {
        path: path.into(),
        revision: markdown_file::revision(content.as_bytes()),
        content,
    })
}

/// 排他创建空 Markdown，已有文件、目录和链接均拒绝覆盖。
///
/// # 参数
/// - `sftp`：worker 借用的已认证会话，创建和关闭按队列顺序执行。
/// - `path`：新文件的服务器路径，扩展名必须为 md/markdown，最长 4096 字节。
/// # Errors
/// 路径、权限或同名目标错误不修改已有节点；关闭失败时空文件可能已创建，返回路径供重新打开确认。
/// 操作开始后即使前端停止等待仍完成关闭，不自动删除可能已被其他客户端使用的新文件。
pub(crate) async fn create_remote(sftp: &SftpSession, path: &str) -> Result<MarkdownFile, String> {
    markdown_file::validate_path(path)?;
    let file = sftp
        .open_with_flags_and_attributes(
            path,
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            FileAttributes {
                permissions: Some(PRIVATE_FILE_PERMISSIONS),
                ..FileAttributes::empty()
            },
        )
        .await
        // 排他打开由服务器完成，检查与创建之间没有覆盖已有目标的窗口。
        .map_err(|error| format!("创建远端文件失败（同名目标不会覆盖） / Cannot create remote file (existing targets are protected): {error}"))?;
    file.close().await.map_err(|error| {
        format!("远端文件可能已创建，请重新打开确认 {path} / File may have been created; reopen to check: {error}")
    })?;
    Ok(MarkdownFile {
        path: path.into(),
        content: String::new(),
        revision: markdown_file::revision(b""),
    })
}

/// 准备完整新文件，再将原文件移到备份并提交；不依赖服务器的覆盖式 rename。
///
/// # 参数
/// - `sftp`：当前 worker 的已认证会话，读写顺序由 worker 保证。
/// - `path`：已有 Markdown 的远端路径。
/// - `content`：已校验的 UTF-8 新正文，最多 2 MiB。
/// - `expected_revision`：打开时摘要，最终移动原文件前再次检查。
/// # Errors
/// 失败时尝试恢复原文件并清理临时文件；断线可能保留备份，错误中给出恢复路径。
/// SFTP 不提供跨客户端的比较交换，其他客户端在最终检查后的并发写入仍可能竞态。
pub(crate) async fn write_remote(
    sftp: &SftpSession,
    path: &str,
    content: &str,
    expected_revision: &str,
) -> Result<MarkdownFile, String> {
    markdown_file::validate_content(content)?;
    let current = read_remote(sftp, path).await?;
    if current.revision != expected_revision {
        return Err(
            "远端文件已被修改，请重新打开或另存为 / Remote file changed; reopen or save a copy"
                .into(),
        );
    }
    let metadata = sftp
        .symlink_metadata(path)
        .await
        .map_err(|error| format!("读取远端权限失败 / Cannot read permissions: {error}"))?;
    // 128 位随机后缀避免跨进程临时文件重名；CREATE|EXCLUDE 进一步禁止意外覆盖。
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)
        .map_err(|error| format!("生成临时文件名失败 / Cannot generate file name: {error}"))?;
    let suffix = markdown_file::revision(&random);
    let parent = path.rsplit_once('/').map_or(
        ".",
        |(parent, _)| if parent.is_empty() { "/" } else { parent },
    );
    let temporary_path = format!("{parent}/.rivet-md-{suffix}.tmp");
    let backup_path = format!("{parent}/.rivet-md-{suffix}.bak");
    let attributes = FileAttributes {
        permissions: Some(PRIVATE_FILE_PERMISSIONS),
        ..FileAttributes::empty()
    };
    let mut temporary = sftp
        .open_with_flags_and_attributes(
            &temporary_path,
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            attributes,
        )
        .await
        .map_err(|error| {
            format!("创建远端临时文件失败 / Cannot create remote temporary file: {error}")
        })?;
    let write_result = async {
        temporary
            .write_all(content.as_bytes())
            .await
            .map_err(|error| format!("写入远端文件失败 / Cannot write remote file: {error}"))?;
        temporary
            .flush()
            .await
            .map_err(|error| format!("刷新远端文件失败 / Cannot flush remote file: {error}"))?;
        temporary
            .set_metadata(FileAttributes {
                permissions: metadata.permissions,
                ..FileAttributes::empty()
            })
            .await
            .map_err(|error| format!("保留远端权限失败 / Cannot preserve permissions: {error}"))?;
        Ok::<(), String>(())
    }
    .await;
    let close_result = temporary
        .close()
        .await
        .map_err(|error| format!("关闭远端临时文件失败 / Cannot close temporary file: {error}"));
    let commit_result = async {
        write_result?;
        close_result?;
        if read_remote(sftp, path).await?.revision != expected_revision {
            return Err("远端文件已被修改 / Remote file changed".into());
        }
        sftp.rename(path, &backup_path).await.map_err(|error| format!("备份远端原文件失败 / Cannot back up remote file: {error}"))?;
        if let Err(error) = sftp.rename(&temporary_path, path).await {
            if let Err(restore_error) = sftp.rename(&backup_path, path).await {
                return Err(format!("保存失败：{error}；原文件位于 {backup_path}，恢复失败：{restore_error} / Save and restore failed; original is at {backup_path}"));
            }
            return Err(format!("保存失败，原文件已恢复 / Save failed; original restored: {error}"));
        }
        // 提交成功后清理备份；清理失败记录位置，仍返回真实的成功版本，避免误重试覆盖。
        if let Err(error) = sftp.remove_file(&backup_path).await {
            eprintln!("Markdown 已保存，备份清理失败 {backup_path}: {error}");
        }
        Ok(MarkdownFile { path: path.into(), content: content.into(), revision: markdown_file::revision(content.as_bytes()) })
    }.await;
    if commit_result.is_err() {
        if let Err(error) = sftp.remove_file(&temporary_path).await {
            eprintln!("Markdown 临时文件清理失败 {temporary_path}: {error}");
        }
    }
    commit_result
}
