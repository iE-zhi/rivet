//! Markdown 文件边界与本地存储；只处理普通 UTF-8 文件，以内容摘要检测外部修改。
//! 本机写入按进程内互斥执行，先同步同目录临时文件，再提交替换；不持有跨异步锁。

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::digest::{digest, SHA256};
use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    sync::Mutex,
};

/// 单份 Markdown 的 UTF-8 上限为 2 MiB，同时限制读取和保存的内存占用。
pub(crate) const MAX_MARKDOWN_BYTES: usize = 2 * 1024 * 1024;
/// 本地与远端路径最多 4096 个 UTF-8 字节，和 SFTP 的路径边界保持一致。
const MAX_PATH_BYTES: usize = 4096;
/// 串行化本进程的本地检查与提交；锁仅覆盖文件 I/O，不覆盖文件选择对话框。
static LOCAL_FILE_LOCK: Mutex<()> = Mutex::new(());

/// 传给编辑器的 UTF-8 文件快照；摘要对应原始字节，路径不包含凭据。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarkdownFile {
    /// 本地绝对路径或服务端规范化路径。
    pub path: String,
    /// 原始 UTF-8 正文，空文件合法。
    pub content: String,
    /// SHA-256 的无填充 URL-safe Base64；保存时必须与磁盘当前内容一致。
    pub revision: String,
}

/// 校验扩展名、路径长度及 NUL；不解释 Shell 字符，也不执行路径内容。
///
/// # 参数
/// - `path`：本地或远程路径，UTF-8 长度为 1～4096 字节，扩展名为 md 或 markdown。
/// # Errors
/// 非 Markdown 路径返回错误，调用方不得继续读写。
pub(crate) fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > MAX_PATH_BYTES || path.contains('\0') {
        return Err("Markdown 路径无效 / Invalid Markdown path".into());
    }
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !extension.eq_ignore_ascii_case("md") && !extension.eq_ignore_ascii_case("markdown") {
        return Err("请选择 .md 或 .markdown 文件 / Select a Markdown file".into());
    }
    Ok(())
}

/// 限制正文大小并拒绝 NUL；不执行 HTML、脚本或正文中的命令。
///
/// # 参数
/// - `content`：待保存的 UTF-8 正文，允许空字符串，最多 2 MiB。
/// # Errors
/// 超限或包含 NUL 时返回错误，现有文件不变。
pub(crate) fn validate_content(content: &str) -> Result<(), String> {
    if content.len() > MAX_MARKDOWN_BYTES || content.contains('\0') {
        return Err(
            "文件超过 2 MiB 或包含二进制内容 / File exceeds 2 MiB or contains binary content"
                .into(),
        );
    }
    Ok(())
}

/// 计算原始字节的版本摘要，时间戳相同的修改也能被识别。
///
/// # 参数
/// - `bytes`：本次读取或准备写入的完整字节，只借用到返回为止。
pub(crate) fn revision(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(digest(&SHA256, bytes).as_ref())
}

/// 拒绝非普通文件与符号链接，以免替换链接或阻塞在设备文件上。
///
/// # 参数
/// - `path`：已通过扩展名校验的本地路径。
/// # Errors
/// 文件不存在、类型不符或过大时返回错误，不创建文件。
fn regular_metadata(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("读取文件属性失败 / Cannot read file metadata: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_MARKDOWN_BYTES as u64 {
        return Err(
            "仅支持不超过 2 MiB 的普通文件 / Only regular files up to 2 MiB are supported".into(),
        );
    }
    Ok(metadata)
}

/// 有界读取并严格解码 UTF-8；文件句柄在返回或错误时自动关闭。
///
/// # 参数
/// - `path`：要读取的普通本地文件；增长到上限以上时仍会被拒绝。
/// # Errors
/// I/O、非 UTF-8 或正文校验失败时返回错误，不产生写入。
fn read_content(path: &Path) -> Result<String, String> {
    regular_metadata(path)?;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| format!("打开文件失败 / Cannot open file: {error}"))?
        .take((MAX_MARKDOWN_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取文件失败 / Cannot read file: {error}"))?;
    let content =
        String::from_utf8(bytes).map_err(|_| "文件不是 UTF-8 / File is not UTF-8".to_string())?;
    validate_content(&content)?;
    Ok(content)
}

/// 读取用户选中的本地 Markdown；不解析正文，不改变换行或 BOM。
///
/// # 参数
/// - `path`：文件选择器返回的本地路径，必须能表示为 UTF-8。
/// # Errors
/// 路径、读取或锁异常返回错误；文件保持不变。
pub(crate) fn read_local(path: &Path) -> Result<MarkdownFile, String> {
    let path_string = path.to_str().ok_or("路径不是 UTF-8 / Path is not UTF-8")?;
    validate_path(path_string)?;
    let _guard = LOCAL_FILE_LOCK
        .lock()
        .map_err(|_| "Markdown 文件锁不可用 / File lock unavailable")?;
    let content = read_content(path)?;
    Ok(MarkdownFile {
        path: path_string.into(),
        revision: revision(content.as_bytes()),
        content,
    })
}

/// 将正文提交到本地文件；已有文件必须匹配打开时的摘要，新文件禁止覆盖。
///
/// # 参数
/// - `path`：用户选择的新路径或原文件路径；同目录必须可写。
/// - `content`：待保存的 UTF-8 正文，最多 2 MiB。
/// - `expected_revision`：已有文件的内容摘要；None 仅允许创建不存在的新文件。
/// # Errors
/// 冲突、权限、I/O 或提交失败返回错误；临时文件由 RAII 删除，原文件保留。
/// 检查与替换不能阻止其他进程在最终检查后的并发写入。
pub(crate) fn write_local(
    path: &Path,
    content: &str,
    expected_revision: Option<&str>,
) -> Result<MarkdownFile, String> {
    let path_string = path.to_str().ok_or("路径不是 UTF-8 / Path is not UTF-8")?;
    validate_path(path_string)?;
    validate_content(content)?;
    let _guard = LOCAL_FILE_LOCK
        .lock()
        .map_err(|_| "Markdown 文件锁不可用 / File lock unavailable")?;
    let metadata = if let Some(expected) = expected_revision {
        if revision(read_content(path)?.as_bytes()) != expected {
            return Err("文件已被外部修改，请重新打开或另存为 / File changed externally; reopen or save a copy".into());
        }
        Some(regular_metadata(path)?)
    } else {
        None
    };
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("创建临时文件失败 / Cannot create temporary file: {error}"))?;
    temporary
        .write_all(content.as_bytes())
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|error| format!("写入文件失败 / Cannot write file: {error}"))?;
    if let Some(metadata) = metadata {
        temporary
            .as_file()
            .set_permissions(metadata.permissions())
            .map_err(|error| {
                format!("保留文件权限失败 / Cannot preserve file permissions: {error}")
            })?;
        // 写入临时文件期间的外部修改也必须拒绝；不会用旧内容覆盖已检测到的新版本。
        if Some(revision(read_content(path)?.as_bytes()).as_str()) != expected_revision {
            return Err("文件已被外部修改 / File changed externally".into());
        }
        temporary
            .persist(path)
            .map_err(|error| format!("提交文件失败 / Cannot commit file: {}", error.error))?;
    } else {
        temporary.persist_noclobber(path).map_err(|error| format!("创建文件失败；同名文件不会被覆盖 / Cannot create file; existing files are preserved: {}", error.error))?;
    }
    Ok(MarkdownFile {
        path: path_string.into(),
        content: content.into(),
        revision: revision(content.as_bytes()),
    })
}
