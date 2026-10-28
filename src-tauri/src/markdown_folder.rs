//! Markdown 本地文件夹浏览与创建；逐层读取、创建单个空目录，不跟随内部链接或覆盖内容。
//! 所有子目录和文件请求都重新检查所选根目录边界，文件正文仍由 markdown_file 校验。

use crate::markdown_file::{self, MarkdownFile};
use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

/// 单层目录最多返回 2000 项，超限整次失败，避免静默遗漏或无限占用内存。
pub(crate) const MAX_DIRECTORY_ENTRIES: usize = 2000;
/// 目录和条目路径最多 4096 个 UTF-8 字节，与 Markdown 文件路径上限一致。
const MAX_PATH_BYTES: usize = 4096;
/// 新目录名称最多 255 个 UTF-8 字节，保证单个节点名称有界。
const MAX_NAME_BYTES: usize = 255;

/// 文件树中的本地节点类型；链接和特殊节点只展示，不允许展开或编辑。
#[derive(Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FolderEntryKind {
    /// 可按需读取下一层的普通目录。
    Directory,
    /// 普通文件，编辑时还须满足 Markdown 扩展名和正文限制。
    File,
    /// 符号链接，不解析到其目标。
    Symlink,
    /// 设备、套接字等其他节点，不读取正文。
    Other,
}

/// 目录的直接子项；路径为根目录下的绝对路径，名称只用于展示。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderEntry {
    /// 不含父路径的原始文件名，必须为 UTF-8。
    pub name: String,
    /// 交给目录或文件读取命令的完整路径。
    pub path: String,
    /// 不跟随链接得到的节点类型。
    pub kind: FolderEntryKind,
}

/// 单层目录快照；目录优先、名称排序，不含递归读取的子树。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderDirectory {
    /// 已规范化的绝对目录路径，首次打开时也是工作区根目录。
    pub path: String,
    /// 已读取的全部直接子项；空目录为空数组，读取失败不返回部分结果。
    pub entries: Vec<FolderEntry>,
}

/// 将本地路径编码成有界 UTF-8，拒绝 NUL 和无法显示的路径。
///
/// # 参数
/// - `path`：本次读取借用的路径，不执行 Shell 或持久化该路径。
/// # Errors
/// 空路径、非 UTF-8、NUL 或超过 4096 字节时返回错误，不访问其内容。
fn path_text(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or("路径不是 UTF-8 / Path is not UTF-8")?;
    if text.is_empty() || text.len() > MAX_PATH_BYTES || text.contains('\0') {
        return Err("文件夹路径无效 / Invalid folder path".into());
    }
    Ok(text.into())
}

/// 解析用户所选的根目录；只在根路径处允许系统选择器返回的目录链接。
///
/// # 参数
/// - `root`：用户明确选择的目录，返回值为其真实绝对路径。
/// # Errors
/// 路径无效、不存在、无权限或不是目录时失败，不改变工作区或文件。
pub(crate) fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    path_text(root)?;
    let root = fs::canonicalize(root)
        // error 为路径解析的 I/O 错误，保留权限或不存在等系统原因。
        .map_err(|error| format!("打开文件夹失败 / Cannot open folder: {error}"))?;
    path_text(&root)?;
    if !root.is_dir() {
        return Err("所选路径不是文件夹 / Selected path is not a folder".into());
    }
    Ok(root)
}

/// 校验根目录内的子路径，禁止父目录跳转及任意内部链接。
///
/// # 参数
/// - `root`：用户选择的根目录，本次调用重新解析其真实路径。
/// - `path`：后端目录列表返回的绝对路径，必须位于根目录内。
/// # Errors
/// 越界、链接、路径不存在或不可访问时返回错误；这是读取前的边界检查，不锁定外部进程的目录修改。
fn resolve_child(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = canonical_root(root)?;
    path_text(path)?;
    let relative = path
        .strip_prefix(&root)
        // 路径前缀错误仅转成范围提示，不回退到其他目录。
        .map_err(|_| "路径不在所选文件夹内 / Path is outside the selected folder")?;
    let mut current = root.clone();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("不允许父目录跳转 / Parent traversal is not allowed".into());
        };
        current.push(name);
        let metadata = fs::symlink_metadata(&current)
            // error 为当前组成部分的读取错误，立即停止遍历。
            .map_err(|error| format!("读取目录项失败 / Cannot read entry: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(
                "不支持文件夹内部的符号链接 / Links inside the folder are not supported".into(),
            );
        }
    }
    let resolved = fs::canonicalize(&current)
        // error 保留路径在校验期间被删除或失去权限的原因。
        .map_err(|error| format!("解析目录项失败 / Cannot resolve entry: {error}"))?;
    if !resolved.starts_with(&root) {
        return Err("路径不在所选文件夹内 / Path is outside the selected folder".into());
    }
    Ok(resolved)
}

/// 有界读取一层目录，包含非 Markdown 文件，禁止跟随子项链接或返回不完整列表。
///
/// # 参数
/// - `root`：用户选择的工作区根目录，跨调用不保留文件句柄。
/// - `path`：根目录本身或其内部普通子目录。
/// # Errors
/// 路径越界、目录读取失败、超过 2000 项或文件名非 UTF-8 时返回错误；所有句柄随返回释放。
pub(crate) fn list_directory(root: &Path, path: &Path) -> Result<FolderDirectory, String> {
    let path = resolve_child(root, path)?;
    let directory = fs::read_dir(&path)
        // error 为打开目录失败；不返回旧目录或空列表冒充成功。
        .map_err(|error| format!("读取文件夹失败 / Cannot read folder: {error}"))?;
    let mut entries = Vec::new();
    for entry in directory {
        if entries.len() >= MAX_DIRECTORY_ENTRIES {
            return Err("目录超过 2000 项，请选择更小的文件夹 / Folder exceeds 2000 entries; choose a smaller folder".into());
        }
        let entry = entry
            // error 为遍历途中的 I/O 错误，拒绝部分列表。
            .map_err(|error| format!("读取目录项失败 / Cannot read entry: {error}"))?;
        let kind = entry
            .file_type()
            // error 为条目类型读取失败，不尝试跟随或打开该条目。
            .map_err(|error| format!("读取文件类型失败 / Cannot read file type: {error}"))?;
        let kind = if kind.is_symlink() {
            FolderEntryKind::Symlink
        } else if kind.is_dir() {
            FolderEntryKind::Directory
        } else if kind.is_file() {
            FolderEntryKind::File
        } else {
            FolderEntryKind::Other
        };
        let name = entry
            .file_name()
            .into_string()
            // 非 UTF-8 原名称不能无损传给前端，拒绝有损替换。
            .map_err(|_| "文件名不是 UTF-8 / File name is not UTF-8")?;
        entries.push(FolderEntry {
            name,
            path: path_text(&entry.path())?,
            kind,
        });
    }
    // entry 借用本层条目，缓存排序键；先目录，再按大小写无关名称和原名称排序。
    entries.sort_by_cached_key(|entry| {
        (
            entry.kind != FolderEntryKind::Directory,
            entry.name.to_lowercase(),
            entry.name.clone(),
        )
    });
    Ok(FolderDirectory {
        path: path_text(&path)?,
        entries,
    })
}

/// 读取文件树中的 Markdown，复用既有正文大小、编码、普通文件及版本摘要校验。
///
/// # 参数
/// - `root`：用户选择的工作区根目录。
/// - `path`：文件树返回的普通 Markdown 路径；读取前重新确认仍处于根目录内。
/// # Errors
/// 路径越界、链接、非 Markdown、二进制或 I/O 失败时返回错误，不改动文件。
pub(crate) fn read_file(root: &Path, path: &Path) -> Result<MarkdownFile, String> {
    markdown_file::read_local(&resolve_child(root, path)?)
}

/// 校验可跨平台使用的单个目录名称，拒绝路径、控制字符和 Windows 保留名称。
///
/// # 参数
/// - `name`：用户输入的原始名称，1～255 个 UTF-8 字节，不执行裁剪或替换。
/// # Errors
/// 名称为空、包含跳转、分隔符、非法字符、边缘空白、结尾点或设备保留名时失败，不访问磁盘。
fn validate_directory_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > MAX_NAME_BYTES
        || name.trim() != name
        || matches!(name, "." | "..")
        || name.ends_with('.')
        // character 来自外部名称，拒绝跨平台禁止的字符及全部控制字符。
        || name.chars().any(|character| character.is_control() || "<>:\"/\\|?*".contains(character))
    {
        return Err("文件夹名称无效 / Invalid folder name".into());
    }
    // Windows 在扩展名前同样保留设备名，比较时忽略大小写。
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let numbered_device = stem
        .strip_prefix("COM")
        .or_else(
            // 未匹配 COM 时只检查另一种带数字的 LPT 设备名称，不修改输入。
            || stem.strip_prefix("LPT"),
        )
        .is_some_and(
            // suffix 必须恰好是 1～9 的一个 ASCII 数字，COM10 等普通名称允许。
            |suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'),
        );
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered_device {
        return Err("文件夹名称为系统保留名称 / Folder name is reserved".into());
    }
    Ok(())
}

/// 在已打开的根目录中创建一个普通空文件夹；不递归、不覆盖、不修改已有内容。
///
/// # 参数
/// - `root`：用户选择的根目录，本次重新解析并验证可读取性与单层容量。
/// - `name`：单个新目录名称，创建前校验跨平台名称和完整路径长度。
/// # Errors
/// 校验、超过目录容量、同名节点或 I/O 失败时返回错误；create_dir 的同名冲突不会覆盖节点。
/// 成功仅返回新路径，调用方刷新失败不代表创建回滚；不持有长期文件句柄或锁。
pub(crate) fn create_directory(root: &Path, name: &str) -> Result<String, String> {
    validate_directory_name(name)?;
    let root = canonical_root(root)?;
    if list_directory(&root, &root)?.entries.len() >= MAX_DIRECTORY_ENTRIES {
        return Err("目录已达到 2000 项 / Folder already contains 2000 entries".into());
    }
    let path = root.join(name);
    let text = path_text(&path)?;
    fs::create_dir(&path)
        // error 保留权限、同名或目录消失的原因；不使用可覆盖已有节点的操作。
        .map_err(|error| format!("创建文件夹失败 / Cannot create folder: {error}"))?;
    Ok(text)
}
