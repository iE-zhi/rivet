//! Rivet 配置同步：通过 GitHub Gist、Gitee 代码片段和 GitLab Personal Snippet 读写统一同步文件，并将访问令牌保存在系统凭据库。

use std::{
    error::Error as _,
    fs,
    io::Write,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command;

use reqwest::{Client, RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::sync_secrets::{self, EncryptedBackupSecrets, EncryptedSyncSecrets};

/// 同步访问令牌在系统凭据库中的服务名。
const TOKEN_SERVICE_NAME: &str = "Rivet Sync";
/// Rivet 项目主页；仅由固定命令打开，不接受前端传入任意 URL。
const RIVET_PROJECT_URL: &str = "https://gitee.com/boo0ood/rivet";
/// 三个平台片段中统一使用的同步文件名。
const SYNC_FILE_NAME: &str = "rivet-sync.json";
/// 自动创建的同步片段使用固定名称，便于同一账号的其他设备自动发现。
const SYNC_SNIPPET_TITLE: &str = "Rivet Sync";
/// GitLab 使用标题与描述双重标记，降低误认用户其他 Snippet 的概率。
const SYNC_SNIPPET_DESCRIPTION: &str = "Rivet settings sync";
/// 单个同步文件最大 900 KiB。
const MAX_SYNC_CONTENT_BYTES: usize = 900 * 1024;
/// 片段 ID 最大长度。
const MAX_SNIPPET_ID_LENGTH: usize = 256;
/// 远端 API 单次请求超时；避免网络异常时界面长期停留在“正在同步”。
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
/// TCP/TLS 建连等待上限；保留足够时间给 Windows 网络栈完成地址回退与 TLS 握手。
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// GitLab Snippet 创建/更新涉及服务端仓库提交，写请求单独给更长超时。
const GITLAB_WRITE_TIMEOUT: Duration = Duration::from_secs(60);
/// 云端封装格式版本。
const SYNC_ENVELOPE_VERSION: u8 = 1;
/// 本地恢复文件格式版本。
const LOCAL_BACKUP_VERSION: u8 = 1;
/// 本地恢复文件最大 2 MiB，覆盖当前 900 KiB 同步数据及加密开销。
const MAX_LOCAL_BACKUP_BYTES: usize = 2 * 1024 * 1024;

/// 前端可选择的远端片段平台。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SyncProvider {
    Github,
    Gitee,
    Gitlab,
}

impl SyncProvider {
    /// 从前端白名单字符串解析平台。
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "github" => Ok(Self::Github),
            "gitee" => Ok(Self::Gitee),
            "gitlab" => Ok(Self::Gitlab),
            _ => Err("不支持的同步平台".to_string()),
        }
    }

    /// 返回系统凭据库中的稳定用户名。
    fn credential_user(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Gitee => "gitee",
            Self::Gitlab => "gitlab",
        }
    }

    /// 返回当前平台官方 Token 创建页面；权限预填只使用平台官方支持的参数。
    fn token_creation_url(self) -> &'static str {
        match self {
            Self::Github => "https://github.com/settings/personal-access-tokens/new?name=Rivet+Sync&description=Rivet+settings+sync&gists=write",
            Self::Gitee => "https://gitee.com/profile/personal_access_tokens/new",
            Self::Gitlab => "https://gitlab.com/-/user_settings/personal_access_tokens?name=Rivet+Sync&description=Rivet+settings+sync&scopes=api",
        }
    }
}

/// 前端传入的非敏感片段目标。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRemoteConfig {
    pub(crate) provider: String,
    pub(crate) snippet_id: String,
}

/// 返回前端的远端同步文件。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSyncFile {
    pub(crate) exists: bool,
    pub(crate) content: Option<String>,
    pub(crate) revision: Option<String>,
    pub(crate) secret_revision: Option<String>,
}

/// 写入成功后的新远端版本。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSyncWriteResult {
    revision: String,
}

/// 自动发现或创建同步片段后的结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureSyncRemoteResult {
    snippet_id: String,
    created: bool,
    content: String,
    revision: String,
    secret_revision: Option<String>,
}

/// Token 更新成功后返回新的远端目标和内容版本。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceSyncTokenResult {
    snippet_id: String,
    revision: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncEnvelope {
    envelope_version: u8,
    document: Value,
    #[serde(default)]
    secret_revision: Option<String>,
    encrypted_secrets: EncryptedSyncSecrets,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySyncSecretsResult {
    key_paths: std::collections::HashMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareSyncLocalResult {
    secret_revision: String,
}

/// 本地备份包含的可选数据分组。
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSelection {
    pub(crate) settings: bool,
    pub(crate) serial_quick_commands: bool,
    pub(crate) terminal_connections: bool,
    pub(crate) terminal_quick_commands: bool,
}

impl BackupSelection {
    fn any(self) -> bool {
        self.settings
            || self.serial_quick_commands
            || self.terminal_connections
            || self.terminal_quick_commands
    }
}

/// 本地导出文件：记录用户选择的数据分组，SSH 密码、私钥口令和私钥内容使用独立备份密码加密。
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalBackupFile {
    pub(crate) backup_version: u8,
    pub(crate) exported_at: u64,
    pub(crate) included: BackupSelection,
    pub(crate) document: Value,
    pub(crate) encrypted_secrets: EncryptedBackupSecrets,
}

/// 读取本地恢复文件后返回前端先做严格业务字段校验；backup 仍只包含密文秘密。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSyncBackupResult {
    backup: String,
    content: String,
    included: BackupSelection,
}

/// 已验证的远端片段目标。
#[derive(Clone, Debug)]
pub(crate) struct ValidatedRemote {
    provider: SyncProvider,
    snippet_id: String,
}

impl ValidatedRemote {
    /// 校验平台和片段 ID，只允许平台实际 ID 使用的安全 ASCII 字符。
    pub(crate) fn from_config(config: SyncRemoteConfig) -> Result<Self, String> {
        let provider = SyncProvider::parse(config.provider.trim())?;
        let snippet_id = config.snippet_id.trim();
        if snippet_id.is_empty()
            || snippet_id.len() > MAX_SNIPPET_ID_LENGTH
            || !snippet_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("片段 ID 格式无效".to_string());
        }
        Ok(Self {
            provider,
            snippet_id: snippet_id.to_string(),
        })
    }

    /// 从已经解析的平台和远端返回的 ID 构造目标，复用相同的 ID 白名单校验。
    fn from_parts(provider: SyncProvider, snippet_id: String) -> Result<Self, String> {
        Self::from_config(SyncRemoteConfig {
            provider: provider.credential_user().to_string(),
            snippet_id,
        })
    }
}

/// 检查当前平台访问令牌是否已保存。
#[tauri::command]
pub async fn sync_token_exists(provider: String) -> Result<bool, String> {
    let provider = SyncProvider::parse(provider.trim())?;
    tauri::async_runtime::spawn_blocking(move || match token_entry(provider)?.get_password() {
        Ok(secret) => Ok(!secret.is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!("读取同步 Token 失败：{error}")),
    })
    .await
    .map_err(|error| format!("读取同步 Token 任务失败：{error}"))?
}

/// 校验同步 Token 的本地格式并返回去除首尾空白后的值。
pub(crate) fn validate_sync_token(token: String) -> Result<String, String> {
    let token = token.trim().to_string();
    if token.is_empty() || token.len() > 8192 || contains_control(&token) {
        return Err("同步 Token 格式无效".to_string());
    }
    Ok(token)
}

/// 将已校验的 Token 写入当前平台的系统凭据库。
async fn store_sync_token(provider: SyncProvider, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        token_entry(provider)?
            .set_password(&token)
            .map_err(|error| format!("保存同步 Token 失败：{error}"))
    })
    .await
    .map_err(|error| format!("保存同步 Token 任务失败：{error}"))?
}

/// 将当前平台访问令牌保存到操作系统凭据库。
#[tauri::command]
pub async fn save_sync_token(provider: String, token: String) -> Result<(), String> {
    let provider = SyncProvider::parse(provider.trim())?;
    let token = validate_sync_token(token)?;
    store_sync_token(provider, token).await
}

/// 使用新 Token 重新加密本机 SSH 凭据并覆盖当前账号的远端同步数据。
///
/// 远端写入成功后才替换系统凭据库中的 Token；不会读取或解密旧的云端 SSH 密文。
#[tauri::command]
pub async fn replace_sync_token(
    provider: String,
    token: String,
    content: String,
) -> Result<ReplaceSyncTokenResult, String> {
    let provider = SyncProvider::parse(provider.trim())?;
    let token = validate_sync_token(token)?;
    validate_sync_content(&content)?;

    let client = http_client()?;
    let encoded = encode_remote_content(provider, &token, &content).await?;
    let remote = match find_sync_remote(&client, provider, &token).await? {
        Some(remote) => {
            write_remote(&client, &remote, &token, &encoded).await?;
            remote
        }
        None => create_sync_remote(&client, provider, &token, &encoded).await?,
    };
    let revision = revision_for_content(&encoded);

    store_sync_token(provider, token).await?;

    Ok(ReplaceSyncTokenResult {
        snippet_id: remote.snippet_id,
        revision,
    })
}

/// 删除当前平台访问令牌。
#[tauri::command]
pub async fn delete_sync_token(provider: String) -> Result<(), String> {
    let provider = SyncProvider::parse(provider.trim())?;
    tauri::async_runtime::spawn_blocking(move || match token_entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除同步 Token 失败：{error}")),
    })
    .await
    .map_err(|error| format!("删除同步 Token 任务失败：{error}"))?
}

/// 使用系统默认浏览器打开当前平台的 Token 创建页。
#[tauri::command]
pub async fn open_sync_token_page(provider: String) -> Result<(), String> {
    let provider = SyncProvider::parse(provider.trim())?;
    let url = provider.token_creation_url();
    tauri::async_runtime::spawn_blocking(move || open_external_url(url))
        .await
        .map_err(|error| format!("打开 Token 页面任务失败：{error}"))?
}

/// 使用系统默认浏览器打开 Rivet 固定项目主页。
#[tauri::command]
pub async fn open_project_page() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| open_external_url(RIVET_PROJECT_URL))
        .await
        .map_err(|error| format!("打开项目主页任务失败：{error}"))?
}

/// 自动查找当前账号已有的 Rivet 同步片段；不存在时创建私有片段并写入当前本机数据。
#[tauri::command]
pub async fn ensure_sync_remote(
    provider: String,
    content: String,
) -> Result<EnsureSyncRemoteResult, String> {
    let provider = SyncProvider::parse(provider.trim())?;
    validate_sync_content(&content)?;
    let token = load_token(provider).await?;
    let client = http_client()?;

    if let Some(remote) = find_sync_remote(&client, provider, &token).await? {
        let file = decode_remote_file(
            provider,
            &token,
            read_remote(&client, &remote, &token).await?,
        )?;
        if file.exists {
            let remote_content = file
                .content
                .ok_or_else(|| "云端同步文件缺少内容".to_string())?;
            let revision = file
                .revision
                .ok_or_else(|| "云端同步文件缺少版本标识".to_string())?;
            return Ok(EnsureSyncRemoteResult {
                snippet_id: remote.snippet_id,
                created: false,
                content: remote_content,
                revision,
                secret_revision: file.secret_revision,
            });
        }
    }

    let encoded = encode_remote_content(provider, &token, &content).await?;
    let remote = create_sync_remote(&client, provider, &token, &encoded).await?;
    let file = decode_remote_file(
        provider,
        &token,
        read_remote(&client, &remote, &token).await?,
    )?;
    let remote_content = file
        .content
        .ok_or_else(|| "创建同步片段后无法读取内容".to_string())?;
    let revision = file
        .revision
        .ok_or_else(|| "创建同步片段后无法读取版本标识".to_string())?;
    Ok(EnsureSyncRemoteResult {
        snippet_id: remote.snippet_id,
        created: true,
        content: remote_content,
        revision,
        secret_revision: file.secret_revision,
    })
}

/// 读取指定 Gist/Snippet 内的 Rivet 同步文件。
#[tauri::command]
pub async fn read_sync_remote(config: SyncRemoteConfig) -> Result<RemoteSyncFile, String> {
    let remote = ValidatedRemote::from_config(config)?;
    let token = load_token(remote.provider).await?;
    let client = http_client()?;
    decode_remote_file(
        remote.provider,
        &token,
        read_remote(&client, &remote, &token).await?,
    )
}

/// 以调用方最近读取到的内容版本作为并发保护更新片段。
#[tauri::command]
pub async fn write_sync_remote(
    config: SyncRemoteConfig,
    content: String,
    expected_revision: Option<String>,
) -> Result<RemoteSyncWriteResult, String> {
    let remote = ValidatedRemote::from_config(config)?;
    validate_sync_content(&content)?;
    if expected_revision.as_ref().is_some_and(|revision| {
        revision.is_empty() || revision.len() > 64 || contains_control(revision)
    }) {
        return Err("远端版本标识无效".to_string());
    }

    let token = load_token(remote.provider).await?;
    let client = http_client()?;
    if let Some(expected) = expected_revision.as_deref() {
        let current = read_remote(&client, &remote, &token).await?;
        if current.revision.as_deref() != Some(expected) {
            return Err("云端片段已变化，请重新同步后再试".to_string());
        }
    }

    let encoded = encode_remote_content(remote.provider, &token, &content).await?;
    write_remote(&client, &remote, &token, &encoded).await?;
    let refreshed = read_remote(&client, &remote, &token).await?;
    let revision = refreshed
        .revision
        .ok_or_else(|| "同步写入成功但无法读取新远端版本".to_string())?;
    Ok(RemoteSyncWriteResult { revision })
}

#[tauri::command]
pub async fn prepare_sync_local(content: String) -> Result<PrepareSyncLocalResult, String> {
    validate_sync_content(&content)?;
    tauri::async_runtime::spawn_blocking(move || {
        let secret_revision = sync_secrets::local_secret_revision(&content)?;
        Ok(PrepareSyncLocalResult { secret_revision })
    })
    .await
    .map_err(|error| format!("准备本机同步数据任务失败：{error}"))?
}

#[tauri::command]
pub async fn apply_sync_remote_secrets(
    app: AppHandle,
    config: SyncRemoteConfig,
    expected_revision: String,
) -> Result<ApplySyncSecretsResult, String> {
    if expected_revision.is_empty()
        || expected_revision.len() > 64
        || contains_control(&expected_revision)
    {
        return Err("远端版本标识无效".to_string());
    }
    let remote = ValidatedRemote::from_config(config)?;
    let token = load_token(remote.provider).await?;
    let client = http_client()?;
    let raw = read_remote(&client, &remote, &token).await?;
    if raw.revision.as_deref() != Some(expected_revision.as_str()) {
        return Err("云端片段已变化，请重新同步后再试".to_string());
    }
    let Some(raw_content) = raw.content else {
        return Ok(ApplySyncSecretsResult {
            key_paths: std::collections::HashMap::new(),
        });
    };
    let Some(envelope) = parse_sync_envelope(&raw_content)? else {
        return Ok(ApplySyncSecretsResult {
            key_paths: std::collections::HashMap::new(),
        });
    };
    let provider = remote.provider.credential_user().to_string();
    let key_paths = tauri::async_runtime::spawn_blocking(move || {
        sync_secrets::apply_encrypted_secrets(&app, &provider, &token, &envelope.encrypted_secrets)
    })
    .await
    .map_err(|error| format!("同步数据恢复任务失败：{error}"))??;
    Ok(ApplySyncSecretsResult { key_paths })
}

/// 将当前可同步数据导出为可离线跨设备恢复的本地文件；SSH 敏感数据只使用用户备份密码加密。
#[tauri::command]
pub async fn export_sync_backup(
    app: AppHandle,
    content: String,
    password: String,
    included: BackupSelection,
) -> Result<bool, String> {
    if !included.any() {
        return Err("请至少选择一项要导出的内容".to_string());
    }
    validate_sync_content(&content)?;
    let canonical = canonicalize_sync_document(&content)?;
    let document: Value = serde_json::from_str(&canonical)
        .map_err(|error| format!("生成本地备份配置失败：{error}"))?;
    let encrypted_secrets = tauri::async_runtime::spawn_blocking({
        let content = content.clone();
        let password = password.clone();
        move || sync_secrets::encrypt_local_backup_secrets(&password, &content)
    })
    .await
    .map_err(|error| format!("加密本地备份任务失败：{error}"))??;
    let exported_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("获取导出时间失败：{error}"))?
        .as_secs();
    let backup = LocalBackupFile {
        backup_version: LOCAL_BACKUP_VERSION,
        exported_at,
        included,
        document,
        encrypted_secrets,
    };
    let backup = serde_json::to_string_pretty(&backup)
        .map_err(|error| format!("序列化本地备份失败：{error}"))?;
    validate_local_backup_size(&backup)?;
    tauri::async_runtime::spawn_blocking(move || save_sync_backup_blocking(&app, &backup))
        .await
        .map_err(|error| format!("导出本地备份任务失败：{error}"))?
}

/// 打开本地恢复文件并返回普通配置与原始密文备份；前端先完成业务字段校验后再恢复 SSH 秘密。
#[tauri::command]
pub async fn read_sync_backup(app: AppHandle) -> Result<Option<ReadSyncBackupResult>, String> {
    let backup = tauri::async_runtime::spawn_blocking(move || read_sync_backup_blocking(&app))
        .await
        .map_err(|error| format!("读取本地备份任务失败：{error}"))??;
    let Some(backup) = backup else {
        return Ok(None);
    };
    let parsed = parse_local_backup(&backup)?;
    let content = serde_json::to_string_pretty(&parsed.document)
        .map_err(|error| format!("解析本地备份配置失败：{error}"))?;
    validate_sync_content(&content)?;
    Ok(Some(ReadSyncBackupResult {
        backup,
        content,
        included: parsed.included,
    }))
}

/// 前端确认备份业务字段合法后，恢复其中的 SSH 密码、私钥口令和私钥文件。
#[tauri::command]
pub async fn apply_sync_backup_secrets(
    app: AppHandle,
    backup: String,
    password: String,
) -> Result<ApplySyncSecretsResult, String> {
    validate_local_backup_size(&backup)?;
    let parsed = parse_local_backup(&backup)?;
    let encrypted = parsed.encrypted_secrets;
    let key_paths = tauri::async_runtime::spawn_blocking(move || {
        sync_secrets::apply_encrypted_backup_secrets(&app, &password, &encrypted)
    })
    .await
    .map_err(|error| format!("恢复本地备份 SSH 数据任务失败：{error}"))??;
    Ok(ApplySyncSecretsResult { key_paths })
}

/// 校验本地恢复文件大小，避免异常文件占用过多内存。
fn validate_local_backup_size(content: &str) -> Result<(), String> {
    if content.is_empty() {
        return Err("备份文件为空".to_string());
    }
    if content.len() > MAX_LOCAL_BACKUP_BYTES {
        return Err(format!(
            "备份文件超过 {} MiB 上限",
            MAX_LOCAL_BACKUP_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

/// 解析并验证本地恢复文件的外层格式。
pub(crate) fn parse_local_backup(content: &str) -> Result<LocalBackupFile, String> {
    validate_local_backup_size(content)?;
    let backup: LocalBackupFile =
        serde_json::from_str(content).map_err(|error| format!("备份文件格式无效：{error}"))?;
    if backup.backup_version != LOCAL_BACKUP_VERSION {
        return Err("备份文件版本不受支持".to_string());
    }
    if !backup.document.is_object() {
        return Err("备份中的配置格式无效".to_string());
    }
    Ok(backup)
}

/// 在阻塞线程显示保存对话框并原子写入本地恢复文件。
fn save_sync_backup_blocking(app: &AppHandle, content: &str) -> Result<bool, String> {
    let Some(selected_path) = app
        .dialog()
        .file()
        .set_file_name("Rivet备份.rivet.json")
        .add_filter("Rivet 备份", &["json"])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = selected_path
        .into_path()
        .map_err(|error| format!("备份保存路径无效：{error}"))?;
    write_sync_backup_file(&path, content)?;
    Ok(true)
}

/// 在阻塞线程选择并读取一个本地恢复文件。
fn read_sync_backup_blocking(app: &AppHandle) -> Result<Option<String>, String> {
    let Some(selected_path) = app
        .dialog()
        .file()
        .add_filter("Rivet 备份", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = selected_path
        .into_path()
        .map_err(|error| format!("备份文件路径无效：{error}"))?;
    let bytes = fs::read(&path).map_err(|error| format!("读取备份文件失败：{error}"))?;
    if bytes.len() > MAX_LOCAL_BACKUP_BYTES {
        return Err(format!(
            "备份文件超过 {} MiB 上限",
            MAX_LOCAL_BACKUP_BYTES / 1024 / 1024
        ));
    }
    let content = String::from_utf8(bytes).map_err(|_| "备份文件不是 UTF-8 JSON".to_string())?;
    validate_local_backup_size(&content)?;
    Ok(Some(content))
}

/// 使用临时文件完整写入后再替换目标，避免导出过程中留下半个备份文件。
fn write_sync_backup_file(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("创建备份临时文件失败：{error}"))?;
    temporary
        .write_all(content.as_bytes())
        .map_err(|error| format!("写入备份文件失败：{error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("同步备份文件失败：{error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("替换备份文件失败：{}", error.error))?;
    Ok(())
}

/// 构造系统凭据库中的 Token 条目。
fn token_entry(provider: SyncProvider) -> Result<keyring::Entry, String> {
    keyring::Entry::new(TOKEN_SERVICE_NAME, provider.credential_user())
        .map_err(|error| format!("访问同步 Token 凭据库失败：{error}"))
}

/// 异步读取平台 Token，避免系统凭据库阻塞 Tauri 运行时工作线程。
async fn load_token(provider: SyncProvider) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        token_entry(provider)?
            .get_password()
            .map_err(|error| match error {
                keyring::Error::NoEntry => "尚未保存同步 Token".to_string(),
                other => format!("读取同步 Token 失败：{other}"),
            })
    })
    .await
    .map_err(|error| format!("读取同步 Token 任务失败：{error}"))?
}

async fn encode_remote_content(
    provider: SyncProvider,
    token: &str,
    content: &str,
) -> Result<String, String> {
    let provider_name = provider.credential_user().to_string();
    let token = token.to_string();
    let content = content.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let canonical = canonicalize_sync_document(&content)?;
        let document: Value = serde_json::from_str(&canonical)
            .map_err(|error| format!("解析同步文档失败：{error}"))?;
        let secret_revision = sync_secrets::local_secret_revision(&content)?;
        let encrypted_secrets =
            sync_secrets::encrypt_local_secrets(&provider_name, &token, &content)?;
        let envelope = SyncEnvelope {
            envelope_version: SYNC_ENVELOPE_VERSION,
            document,
            secret_revision: Some(secret_revision),
            encrypted_secrets,
        };
        let encoded = serde_json::to_string_pretty(&envelope)
            .map_err(|error| format!("序列化同步封装失败：{error}"))?;
        validate_sync_content(&encoded)?;
        Ok(encoded)
    })
    .await
    .map_err(|error| format!("准备同步数据任务失败：{error}"))?
}

pub(crate) fn canonicalize_sync_document(content: &str) -> Result<String, String> {
    let mut document: Value =
        serde_json::from_str(content).map_err(|error| format!("解析同步文档失败：{error}"))?;
    if let Some(connections) = document
        .get_mut("terminalConnections")
        .and_then(Value::as_array_mut)
    {
        for connection in connections {
            let is_ssh_connection = connection.get("kind").and_then(Value::as_str) == Some("ssh");
            if is_ssh_connection {
                if let Some(object) = connection.as_object_mut() {
                    object.insert("keyPath".to_string(), Value::String(String::new()));
                }
            }
        }
    }
    serde_json::to_string_pretty(&document).map_err(|error| format!("序列化同步文档失败：{error}"))
}

fn parse_sync_envelope(content: &str) -> Result<Option<SyncEnvelope>, String> {
    let value: Value =
        serde_json::from_str(content).map_err(|error| format!("解析云端同步数据失败：{error}"))?;
    if value.get("envelopeVersion").is_none() {
        return Ok(None);
    }
    let envelope: SyncEnvelope =
        serde_json::from_value(value).map_err(|error| format!("解析云端同步封装失败：{error}"))?;
    if envelope.envelope_version != SYNC_ENVELOPE_VERSION {
        return Err("云端同步封装格式不受支持".to_string());
    }
    Ok(Some(envelope))
}

fn decode_remote_file(
    _provider: SyncProvider,
    _token: &str,
    mut file: RemoteSyncFile,
) -> Result<RemoteSyncFile, String> {
    if !file.exists {
        return Ok(file);
    }
    let Some(raw_content) = file.content.as_deref() else {
        return Err("云端同步文件缺少内容".to_string());
    };
    let Some(envelope) = parse_sync_envelope(raw_content)? else {
        file.secret_revision = None;
        return Ok(file);
    };
    let document = serde_json::to_string_pretty(&envelope.document)
        .map_err(|error| format!("恢复同步文档失败：{error}"))?;
    validate_sync_content(&document)?;
    file.content = Some(document);
    file.secret_revision = envelope.secret_revision;
    Ok(file)
}

/// 构造带硬超时的 HTTP 客户端。
fn http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .timeout(HTTP_TIMEOUT)
        // 三个平台都是小型 REST 请求；Windows 上固定 HTTP/1.1 可避开 GitLab 偶发的 TLS/HTTP2 建链异常。
        .http1_only()
        .user_agent("Rivet/0.1")
        .build()
        .map_err(|error| format!("初始化同步网络客户端失败：{error}"))
}

/// 按平台查找当前账号已有的 Rivet 同步片段。
async fn find_sync_remote(
    client: &Client,
    provider: SyncProvider,
    token: &str,
) -> Result<Option<ValidatedRemote>, String> {
    match provider {
        SyncProvider::Github => find_github_gist(client, token).await,
        SyncProvider::Gitee => find_gitee_gist(client, token).await,
        SyncProvider::Gitlab => find_gitlab_snippet(client, token).await,
    }
}

/// 按平台创建私有同步片段，并返回新片段目标。
async fn create_sync_remote(
    client: &Client,
    provider: SyncProvider,
    token: &str,
    content: &str,
) -> Result<ValidatedRemote, String> {
    match provider {
        SyncProvider::Github => create_github_gist(client, token, content).await,
        SyncProvider::Gitee => create_gitee_gist(client, token, content).await,
        SyncProvider::Gitlab => create_gitlab_snippet(client, token, content).await,
    }
}

/// 按平台读取同步文件。
async fn read_remote(
    client: &Client,
    remote: &ValidatedRemote,
    token: &str,
) -> Result<RemoteSyncFile, String> {
    match remote.provider {
        SyncProvider::Github => read_github_gist(client, remote, token).await,
        SyncProvider::Gitee => read_gitee_gist(client, remote, token).await,
        SyncProvider::Gitlab => read_gitlab_snippet(client, remote, token).await,
    }
}

/// 按平台写入同步文件。
async fn write_remote(
    client: &Client,
    remote: &ValidatedRemote,
    token: &str,
    content: &str,
) -> Result<(), String> {
    match remote.provider {
        SyncProvider::Github => write_github_gist(client, remote, token, content).await,
        SyncProvider::Gitee => write_gitee_gist(client, remote, token, content).await,
        SyncProvider::Gitlab => write_gitlab_snippet(client, remote, token, content).await,
    }
}

/// 从列表项中读取字符串或数字形式的片段 ID。
fn snippet_id_from_value(value: &Value) -> Option<String> {
    match value.get("id")? {
        Value::String(id) if !id.is_empty() => Some(id.clone()),
        Value::Number(id) => Some(id.to_string()),
        _ => None,
    }
}

/// 判断 GitHub/Gitee Gist 列表项是否是 Rivet 的固定同步片段。
fn is_rivet_gist(value: &Value) -> bool {
    value
        .get("files")
        .and_then(Value::as_object)
        .is_some_and(|files| files.contains_key(SYNC_FILE_NAME))
        && value
            .get("description")
            .and_then(Value::as_str)
            .is_some_and(|description| description == SYNC_SNIPPET_TITLE)
}

/// GitHub：从当前用户 Gist 中自动发现 Rivet 同步片段。
async fn find_github_gist(client: &Client, token: &str) -> Result<Option<ValidatedRemote>, String> {
    let response = github_auth(client.get("https://api.github.com/gists"), token)
        .query(&[("per_page", "100")])
        .send()
        .await
        .map_err(|error| format!("查找 GitHub Gist 失败：{error}"))?;
    let response = ensure_success(response, "查找 GitHub Gist").await?;
    let payload: Vec<Value> = response
        .json()
        .await
        .map_err(|error| format!("解析 GitHub Gist 列表失败：{error}"))?;
    let Some(id) = payload
        .iter()
        .find(|item| is_rivet_gist(item))
        .and_then(snippet_id_from_value)
    else {
        return Ok(None);
    };
    ValidatedRemote::from_parts(SyncProvider::Github, id).map(Some)
}

/// GitHub：创建只包含 Rivet 同步文件的私有 Gist。
async fn create_github_gist(
    client: &Client,
    token: &str,
    content: &str,
) -> Result<ValidatedRemote, String> {
    let body = json!({
        "description": SYNC_SNIPPET_TITLE,
        "public": false,
        "files": {
            SYNC_FILE_NAME: { "content": content }
        }
    });
    let response = github_auth(client.post("https://api.github.com/gists"), token)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("创建 GitHub Gist 失败：{error}"))?;
    let response = ensure_success(response, "创建 GitHub Gist").await?;
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("解析新建 GitHub Gist 失败：{error}"))?;
    let id = snippet_id_from_value(&payload).ok_or_else(|| "GitHub 未返回 Gist ID".to_string())?;
    ValidatedRemote::from_parts(SyncProvider::Github, id)
}

/// Gitee：从当前用户代码片段中自动发现 Rivet 同步片段。
async fn find_gitee_gist(client: &Client, token: &str) -> Result<Option<ValidatedRemote>, String> {
    let response = client
        .get("https://gitee.com/api/v5/gists")
        .query(&[("access_token", token), ("per_page", "100")])
        .send()
        .await
        .map_err(|_| "查找 Gitee 代码片段失败：网络请求失败".to_string())?;
    let response = ensure_success_status_only(response, "查找 Gitee 代码片段")?;
    let payload: Vec<Value> = response
        .json()
        .await
        .map_err(|error| format!("解析 Gitee 代码片段列表失败：{error}"))?;
    let Some(id) = payload
        .iter()
        .find(|item| is_rivet_gist(item))
        .and_then(snippet_id_from_value)
    else {
        return Ok(None);
    };
    ValidatedRemote::from_parts(SyncProvider::Gitee, id).map(Some)
}

/// Gitee：创建私有 Rivet 代码片段。
async fn create_gitee_gist(
    client: &Client,
    token: &str,
    content: &str,
) -> Result<ValidatedRemote, String> {
    let body = json!({
        "files": {
            SYNC_FILE_NAME: { "content": content }
        },
        "description": SYNC_SNIPPET_TITLE,
        "public": false,
    });
    let response = client
        .post("https://gitee.com/api/v5/gists")
        .query(&[("access_token", token)])
        .json(&body)
        .send()
        .await
        .map_err(|_| "创建 Gitee 代码片段失败：网络请求失败".to_string())?;
    let response = ensure_success_status_only(response, "创建 Gitee 代码片段")?;
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("解析新建 Gitee 代码片段失败：{error}"))?;
    let id =
        snippet_id_from_value(&payload).ok_or_else(|| "Gitee 未返回代码片段 ID".to_string())?;
    ValidatedRemote::from_parts(SyncProvider::Gitee, id)
}

/// GitLab：从当前用户 Personal Snippet 中发现 Rivet 同步片段。
async fn find_gitlab_snippet(
    client: &Client,
    token: &str,
) -> Result<Option<ValidatedRemote>, String> {
    let response = client
        .get("https://gitlab.com/api/v4/snippets")
        .header("PRIVATE-TOKEN", token)
        .query(&[("per_page", "100")])
        .send()
        .await
        .map_err(|error| format_request_error("查找 GitLab Snippet 失败", error))?;
    let response = ensure_success(response, "查找 GitLab Snippet").await?;
    let payload: Vec<Value> = response
        .json()
        .await
        .map_err(|error| format!("解析 GitLab Snippet 列表失败：{error}"))?;
    let Some(id) = payload
        .iter()
        .find(|item| {
            item.get("title").and_then(Value::as_str) == Some(SYNC_SNIPPET_TITLE)
                && item.get("description").and_then(Value::as_str) == Some(SYNC_SNIPPET_DESCRIPTION)
        })
        .and_then(snippet_id_from_value)
    else {
        return Ok(None);
    };
    ValidatedRemote::from_parts(SyncProvider::Gitlab, id).map(Some)
}

/// GitLab：创建私有 Personal Snippet 并直接写入 Rivet 同步文件。
async fn create_gitlab_snippet(
    client: &Client,
    token: &str,
    content: &str,
) -> Result<ValidatedRemote, String> {
    let body = json!({
        "title": SYNC_SNIPPET_TITLE,
        "description": SYNC_SNIPPET_DESCRIPTION,
        "visibility": "private",
        "files": [
            {
                "file_path": SYNC_FILE_NAME,
                "content": content,
            }
        ]
    });
    let response = client
        .post("https://gitlab.com/api/v4/snippets")
        .timeout(GITLAB_WRITE_TIMEOUT)
        .header("PRIVATE-TOKEN", token)
        .json(&body)
        .send()
        .await
        .map_err(|error| format_request_error("创建 GitLab Snippet 失败", error))?;
    let response = ensure_success(response, "创建 GitLab Snippet").await?;
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("解析新建 GitLab Snippet 失败：{error}"))?;
    let id =
        snippet_id_from_value(&payload).ok_or_else(|| "GitLab 未返回 Snippet ID".to_string())?;
    ValidatedRemote::from_parts(SyncProvider::Gitlab, id)
}

/// GitHub Gist API 读取固定文件。
async fn read_github_gist(
    client: &Client,
    remote: &ValidatedRemote,
    token: &str,
) -> Result<RemoteSyncFile, String> {
    let url = format!("https://api.github.com/gists/{}", remote.snippet_id);
    let response = github_auth(client.get(url), token)
        .send()
        .await
        .map_err(|error| format!("访问 GitHub Gist 失败：{error}"))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(missing_remote());
    }
    let response = ensure_success(response, "读取 GitHub Gist").await?;
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("解析 GitHub Gist 失败：{error}"))?;
    remote_from_gist_value(&payload)
}

/// GitHub Gist API 更新固定文件，不创建额外仓库提交。
async fn write_github_gist(
    client: &Client,
    remote: &ValidatedRemote,
    token: &str,
    content: &str,
) -> Result<(), String> {
    let url = format!("https://api.github.com/gists/{}", remote.snippet_id);
    let body = json!({
        "files": {
            SYNC_FILE_NAME: {
                "content": content,
            }
        }
    });
    let response = github_auth(client.patch(url), token)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("写入 GitHub Gist 失败：{error}"))?;
    ensure_success(response, "写入 GitHub Gist").await?;
    Ok(())
}

/// Gitee 代码片段 API 读取固定文件；错误路径不回显带 access_token 的请求 URL。
async fn read_gitee_gist(
    client: &Client,
    remote: &ValidatedRemote,
    token: &str,
) -> Result<RemoteSyncFile, String> {
    let url = format!("https://gitee.com/api/v5/gists/{}", remote.snippet_id);
    let response = client
        .get(url)
        .query(&[("access_token", token)])
        .send()
        .await
        .map_err(|_| "访问 Gitee 代码片段失败：网络请求失败".to_string())?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(missing_remote());
    }
    let response = ensure_success_status_only(response, "读取 Gitee 代码片段")?;
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("解析 Gitee 代码片段失败：{error}"))?;
    remote_from_gist_value(&payload)
}

/// Gitee 代码片段 API 使用 JSON 对象更新固定文件；files 必须保持对象类型，不能作为 multipart 文本传递。
async fn write_gitee_gist(
    client: &Client,
    remote: &ValidatedRemote,
    token: &str,
    content: &str,
) -> Result<(), String> {
    let url = format!("https://gitee.com/api/v5/gists/{}", remote.snippet_id);
    let body = json!({
        "files": {
            SYNC_FILE_NAME: {
                "content": content,
            }
        }
    });
    let response = client
        .patch(url)
        .query(&[("access_token", token)])
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|_| "写入 Gitee 代码片段失败：网络请求失败".to_string())?;
    ensure_success_status_only(response, "写入 Gitee 代码片段")?;
    Ok(())
}

/// GitLab Personal Snippet 直接读取固定文件，避免先取元数据再取内容造成两次串行网络等待。
async fn read_gitlab_snippet(
    client: &Client,
    remote: &ValidatedRemote,
    token: &str,
) -> Result<RemoteSyncFile, String> {
    let raw_url = format!(
        "https://gitlab.com/api/v4/snippets/{}/files/main/{}/raw",
        remote.snippet_id,
        percent_encode(SYNC_FILE_NAME)
    );
    let response = client
        .get(raw_url)
        .header("PRIVATE-TOKEN", token)
        .send()
        .await
        .map_err(|error| format_request_error("读取 GitLab Snippet 文件失败", error))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(missing_remote());
    }
    let response = ensure_success(response, "读取 GitLab Snippet 文件").await?;
    let content = response
        .text()
        .await
        .map_err(|error| format!("解析 GitLab Snippet 文件失败：{error}"))?;
    validate_sync_content(&content)?;
    Ok(remote_with_content(content))
}

/// GitLab Personal Snippet 更新固定文件；调用前已读取并确认目标文件存在，因此无需再次请求元数据。
async fn write_gitlab_snippet(
    client: &Client,
    remote: &ValidatedRemote,
    token: &str,
    content: &str,
) -> Result<(), String> {
    let url = format!("https://gitlab.com/api/v4/snippets/{}", remote.snippet_id);
    let body = json!({
        "files": [
            {
                "action": "update",
                "file_path": SYNC_FILE_NAME,
                "content": content,
            }
        ]
    });
    let response = client
        .put(url)
        .timeout(GITLAB_WRITE_TIMEOUT)
        .header("PRIVATE-TOKEN", token)
        .json(&body)
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) if error.is_timeout() => {
            // GitLab 可能已经完成更新，只是响应在链路上超时；先回读确认，避免把成功误报成失败。
            match read_gitlab_snippet(client, remote, token).await {
                Ok(current) if current.content.as_deref() == Some(content) => return Ok(()),
                Ok(_) => return Err(format_request_error("写入 GitLab Snippet 失败", error)),
                Err(check_error) => {
                    return Err(format!(
                        "{}；超时后回读确认失败：{check_error}",
                        format_request_error("写入 GitLab Snippet 失败", error)
                    ))
                }
            }
        }
        Err(error) => return Err(format_request_error("写入 GitLab Snippet 失败", error)),
    };
    ensure_success(response, "写入 GitLab Snippet").await?;
    Ok(())
}

/// 从 GitHub/Gitee 兼容的 Gist JSON 中提取固定同步文件。
pub(crate) fn remote_from_gist_value(payload: &Value) -> Result<RemoteSyncFile, String> {
    let Some(file) = payload
        .get("files")
        .and_then(Value::as_object)
        .and_then(|files| files.get(SYNC_FILE_NAME))
    else {
        return Ok(missing_remote());
    };
    let content = file
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| "远端片段文件缺少文本内容".to_string())?
        .to_string();
    validate_sync_content(&content)?;
    Ok(remote_with_content(content))
}

/// 生成只用于冲突检测的稳定内容版本标识。
pub(crate) fn revision_for_content(content: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in content.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// 构造存在的远端文件结果。
fn remote_with_content(content: String) -> RemoteSyncFile {
    RemoteSyncFile {
        exists: true,
        revision: Some(revision_for_content(&content)),
        content: Some(content),
        secret_revision: None,
    }
}

/// 将 404 或缺少固定文件表示为首次同步尚无远端同步文件。
fn missing_remote() -> RemoteSyncFile {
    RemoteSyncFile {
        exists: false,
        content: None,
        revision: None,
        secret_revision: None,
    }
}

/// GitHub 请求的统一认证和响应格式头。
fn github_auth(request: RequestBuilder, token: &str) -> RequestBuilder {
    request
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
}

/// 格式化不含敏感查询参数的网络错误，并展开底层原因便于区分超时、DNS、TLS 和连接失败。
fn format_request_error(action: &str, error: reqwest::Error) -> String {
    let category = if error.is_timeout() {
        "请求超时"
    } else if error.is_connect() {
        "连接失败"
    } else if error.is_request() {
        "请求发送失败"
    } else {
        "网络错误"
    };
    let mut causes = Vec::new();
    let mut source = error.source();
    while let Some(cause) = source {
        let detail = cause.to_string();
        if !detail.is_empty() && !causes.iter().any(|item| item == &detail) {
            causes.push(detail);
        }
        source = cause.source();
    }
    if causes.is_empty() {
        format!("{action}：{category} · {error}")
    } else {
        format!("{action}：{category} · {error} · {}", causes.join(" · "))
    }
}

/// 检查 HTTP 状态，并限制读取错误正文的大小。
async fn ensure_success(
    response: reqwest::Response,
    action: &str,
) -> Result<reqwest::Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let detail: String = text.chars().take(2048).collect();
    if detail.trim().is_empty() {
        Err(format!("{action}失败：HTTP {status}"))
    } else {
        Err(format!("{action}失败：HTTP {status} · {detail}"))
    }
}

/// Gitee 请求可能携带 Token，失败时只返回状态码，避免凭据被错误信息回显。
fn ensure_success_status_only(
    response: reqwest::Response,
    action: &str,
) -> Result<reqwest::Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    Err(format!("{action}失败：HTTP {}", response.status()))
}

/// 校验同步文本大小。
fn validate_sync_content(content: &str) -> Result<(), String> {
    if content.as_bytes().len() > MAX_SYNC_CONTENT_BYTES {
        return Err(format!(
            "同步数据超过 {} KiB 上限",
            MAX_SYNC_CONTENT_BYTES / 1024
        ));
    }
    Ok(())
}

/// RFC 3986 路径段百分号编码。
fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(&mut encoded, "%{byte:02X}");
        }
    }
    encoded
}

/// 检查字符串中是否存在控制字符。
fn contains_control(value: &str) -> bool {
    value.chars().any(char::is_control)
}

/// 使用系统默认浏览器打开由平台白名单决定的固定 HTTPS 页面。
fn open_external_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::{iter::once, os::windows::ffi::OsStrExt};
        use windows::{
            core::PCWSTR,
            Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        };

        let wide_url: Vec<u16> = std::ffi::OsStr::new(url)
            .encode_wide()
            .chain(once(0))
            .collect();
        // ShellExecuteW 按 URL 协议关联调用系统默认浏览器，避免 explorer.exe 将 URL 当作文件路径处理。
        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR::null(),
                PCWSTR(wide_url.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize <= 32 {
            return Err(format!(
                "打开系统浏览器失败：ShellExecuteW 返回 {}",
                result.0 as isize
            ));
        }
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(url);
        command
    };

    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return Err("当前平台不支持直接打开浏览器".to_string());

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开系统浏览器失败：{error}"))
}
