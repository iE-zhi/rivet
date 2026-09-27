//! Rivet 自有凭据存储：跨平台保存同步 Token、SSH 密码和私钥口令，不依赖系统凭据库。

use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 本地凭据文档与密文封装版本。
const CREDENTIAL_STORE_VERSION: u8 = 1;
/// AES-256-GCM 主密钥长度。
const MASTER_KEY_BYTES: usize = 32;
/// AES-GCM Nonce 长度。
const NONCE_BYTES: usize = 12;
/// 本地凭据文件最大 1 MiB，防止异常文件造成无界解析。
const MAX_CREDENTIAL_FILE_BYTES: usize = 1024 * 1024;
/// 连接标识最大长度，与前端持久化模型保持一致。
const MAX_CONNECTION_ID_LENGTH: usize = 128;
/// 单个 SSH 密码或私钥口令最大长度。
const MAX_SSH_SECRET_BYTES: usize = 4096;
/// 单个平台同步 Token 最大长度。
const MAX_SYNC_TOKEN_BYTES: usize = 8192;
/// 本地凭据密文的 AEAD 附加认证数据。
const CREDENTIAL_AAD: &[u8] = b"Rivet Local Credentials v1";
/// 应用自有凭据目录名。
const CREDENTIAL_DIRECTORY_NAME: &str = "credentials";
/// 应用自有主密钥文件名。
const MASTER_KEY_FILE_NAME: &str = "credentials.key";
/// 应用自有密文凭据文件名。
const CREDENTIAL_FILE_NAME: &str = "credentials.enc.json";

/// 进程内唯一凭据存储实例；启动后仅使用 Rivet 自有文件。
static CREDENTIAL_STORE: OnceLock<CredentialStore> = OnceLock::new();

/// 返回给前端和同步模块的 SSH 秘密。
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredSshSecrets {
    pub(crate) password: String,
    pub(crate) key_passphrase: String,
}

/// Rivet 自有凭据明文结构；写盘前始终整体加密。
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialDocument {
    version: u8,
    sync_tokens: BTreeMap<String, String>,
    ssh: BTreeMap<String, StoredSshSecrets>,
}

impl Default for CredentialDocument {
    fn default() -> Self {
        Self {
            version: CREDENTIAL_STORE_VERSION,
            sync_tokens: BTreeMap::new(),
            ssh: BTreeMap::new(),
        }
    }
}

/// 本地凭据文件封装；Nonce 与密文使用 Base64 保存。
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncryptedCredentialFile {
    version: u8,
    nonce: String,
    ciphertext: String,
}

/// Rivet 应用自有凭据存储。
pub(crate) struct CredentialStore {
    directory: PathBuf,
    credential_path: PathBuf,
    master_key: [u8; MASTER_KEY_BYTES],
    lock: Mutex<()>,
}

impl CredentialStore {
    /// 在指定目录打开或初始化 Rivet 自有凭据存储。
    pub(crate) fn open_at(directory: PathBuf) -> Result<Self, String> {
        ensure_private_directory(&directory)?;
        let master_key = load_or_create_master_key(&directory)?;
        let credential_path = directory.join(CREDENTIAL_FILE_NAME);
        if credential_path.exists() {
            ensure_private_file(&credential_path)?;
        }
        Ok(Self {
            directory,
            credential_path,
            master_key,
            lock: Mutex::new(()),
        })
    }

    /// 读取一个同步平台 Token。
    pub(crate) fn load_sync_token(&self, provider: &str) -> Result<Option<String>, String> {
        validate_provider(provider)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "本地凭据锁已损坏".to_string())?;
        let document = self.read_document_unlocked()?;
        Ok(document.sync_tokens.get(provider).cloned())
    }

    /// 保存一个同步平台 Token。
    pub(crate) fn save_sync_token(&self, provider: &str, token: &str) -> Result<(), String> {
        validate_provider(provider)?;
        validate_sync_token_value(token)?;
        self.update_document(|document| {
            document
                .sync_tokens
                .insert(provider.to_string(), token.to_string());
            Ok(())
        })
    }

    /// 删除一个同步平台 Token。
    pub(crate) fn delete_sync_token(&self, provider: &str) -> Result<(), String> {
        validate_provider(provider)?;
        self.update_document(|document| {
            document.sync_tokens.remove(provider);
            Ok(())
        })
    }

    /// 读取指定 SSH 连接的密码与私钥口令。
    pub(crate) fn load_ssh(&self, connection_id: &str) -> Result<StoredSshSecrets, String> {
        validate_connection_id(connection_id)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "本地凭据锁已损坏".to_string())?;
        let document = self.read_document_unlocked()?;
        Ok(document.ssh.get(connection_id).cloned().unwrap_or_default())
    }

    /// 按当前认证方式保存 SSH 凭据，并删除另一认证方式遗留的秘密。
    pub(crate) fn save_ssh(
        &self,
        connection_id: &str,
        auth_type: &str,
        password: &str,
        key_passphrase: &str,
    ) -> Result<(), String> {
        validate_connection_id(connection_id)?;
        validate_ssh_secret_input(auth_type, password, key_passphrase)?;
        self.update_document(|document| {
            let secrets = if auth_type == "password" {
                StoredSshSecrets {
                    password: password.to_string(),
                    key_passphrase: String::new(),
                }
            } else {
                StoredSshSecrets {
                    password: String::new(),
                    key_passphrase: key_passphrase.to_string(),
                }
            };
            if secrets.password.is_empty() && secrets.key_passphrase.is_empty() {
                document.ssh.remove(connection_id);
            } else {
                document.ssh.insert(connection_id.to_string(), secrets);
            }
            Ok(())
        })
    }

    /// 删除指定 SSH 连接的全部秘密。
    pub(crate) fn delete_ssh(&self, connection_id: &str) -> Result<(), String> {
        validate_connection_id(connection_id)?;
        self.update_document(|document| {
            document.ssh.remove(connection_id);
            Ok(())
        })
    }

    /// 串行执行一次读改写，避免同进程并发覆盖本地凭据。
    fn update_document(
        &self,
        mutate: impl FnOnce(&mut CredentialDocument) -> Result<(), String>,
    ) -> Result<(), String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "本地凭据锁已损坏".to_string())?;
        let mut document = self.read_document_unlocked()?;
        mutate(&mut document)?;
        validate_document(&document)?;
        self.write_document_unlocked(&document)
    }

    /// 在已持有进程锁时读取并解密凭据文件。
    fn read_document_unlocked(&self) -> Result<CredentialDocument, String> {
        if !self.credential_path.exists() {
            return Ok(CredentialDocument::default());
        }
        let encoded = fs::read(&self.credential_path)
            .map_err(|error| format!("读取 Rivet 本地凭据失败：{error}"))?;
        if encoded.len() > MAX_CREDENTIAL_FILE_BYTES {
            return Err("Rivet 本地凭据文件过大".to_string());
        }
        let envelope: EncryptedCredentialFile = serde_json::from_slice(&encoded)
            .map_err(|error| format!("解析 Rivet 本地凭据失败：{error}"))?;
        if envelope.version != CREDENTIAL_STORE_VERSION {
            return Err("Rivet 本地凭据版本不受支持".to_string());
        }

        let nonce = BASE64
            .decode(envelope.nonce)
            .map_err(|error| format!("解码 Rivet 本地凭据 Nonce 失败：{error}"))?;
        let nonce: [u8; NONCE_BYTES] = nonce
            .try_into()
            .map_err(|_| "Rivet 本地凭据 Nonce 长度无效".to_string())?;
        let mut ciphertext = BASE64
            .decode(envelope.ciphertext)
            .map_err(|error| format!("解码 Rivet 本地凭据密文失败：{error}"))?;
        if ciphertext.len() > MAX_CREDENTIAL_FILE_BYTES {
            return Err("Rivet 本地凭据密文过大".to_string());
        }

        let key = LessSafeKey::new(
            UnboundKey::new(&AES_256_GCM, &self.master_key)
                .map_err(|_| "初始化 Rivet 本地凭据密钥失败".to_string())?,
        );
        let plaintext = key
            .open_in_place(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(CREDENTIAL_AAD),
                &mut ciphertext,
            )
            .map_err(|_| "Rivet 本地凭据认证或解密失败".to_string())?;
        let document: CredentialDocument = serde_json::from_slice(plaintext)
            .map_err(|error| format!("解析 Rivet 本地凭据内容失败：{error}"))?;
        validate_document(&document)?;
        Ok(document)
    }

    /// 在已持有进程锁时加密并原子替换凭据文件。
    fn write_document_unlocked(&self, document: &CredentialDocument) -> Result<(), String> {
        validate_document(document)?;
        let plaintext = serde_json::to_vec(document)
            .map_err(|error| format!("序列化 Rivet 本地凭据失败：{error}"))?;
        if plaintext.len() > MAX_CREDENTIAL_FILE_BYTES {
            return Err("Rivet 本地凭据内容过大".to_string());
        }

        let mut nonce = [0_u8; NONCE_BYTES];
        getrandom::fill(&mut nonce)
            .map_err(|error| format!("生成 Rivet 本地凭据 Nonce 失败：{error}"))?;
        let key = LessSafeKey::new(
            UnboundKey::new(&AES_256_GCM, &self.master_key)
                .map_err(|_| "初始化 Rivet 本地凭据密钥失败".to_string())?,
        );
        let mut ciphertext = plaintext;
        key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(CREDENTIAL_AAD),
            &mut ciphertext,
        )
        .map_err(|_| "加密 Rivet 本地凭据失败".to_string())?;

        let envelope = EncryptedCredentialFile {
            version: CREDENTIAL_STORE_VERSION,
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        };
        let encoded = serde_json::to_vec_pretty(&envelope)
            .map_err(|error| format!("序列化 Rivet 本地凭据密文失败：{error}"))?;
        if encoded.len() > MAX_CREDENTIAL_FILE_BYTES {
            return Err("Rivet 本地凭据文件过大".to_string());
        }

        let mut temporary = tempfile::NamedTempFile::new_in(&self.directory)
            .map_err(|error| format!("创建 Rivet 本地凭据临时文件失败：{error}"))?;
        ensure_private_file(temporary.path())?;
        temporary
            .write_all(&encoded)
            .map_err(|error| format!("写入 Rivet 本地凭据临时文件失败：{error}"))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| format!("同步 Rivet 本地凭据临时文件失败：{error}"))?;
        temporary
            .persist(&self.credential_path)
            .map_err(|error| format!("替换 Rivet 本地凭据文件失败：{}", error.error))?;
        ensure_private_file(&self.credential_path)
    }
}

/// 应用启动时初始化 Rivet 自有凭据目录和主密钥。
pub(crate) fn initialize(app: &AppHandle) -> Result<(), String> {
    if CREDENTIAL_STORE.get().is_some() {
        return Ok(());
    }
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("获取 Rivet 数据目录失败：{error}"))?
        .join(CREDENTIAL_DIRECTORY_NAME);
    let store = CredentialStore::open_at(directory)?;
    CREDENTIAL_STORE
        .set(store)
        .map_err(|_| "Rivet 本地凭据存储已经初始化".to_string())
}

/// 返回已经初始化的 Rivet 自有凭据存储。
fn store() -> Result<&'static CredentialStore, String> {
    CREDENTIAL_STORE
        .get()
        .ok_or_else(|| "Rivet 本地凭据存储尚未初始化".to_string())
}

/// 从 Rivet 自有凭据文件读取指定连接的密码与私钥口令。
#[tauri::command]
pub async fn load_ssh_secrets(connection_id: String) -> Result<StoredSshSecrets, String> {
    validate_connection_id(&connection_id)?;
    tauri::async_runtime::spawn_blocking(move || load_ssh_secrets_for_sync(&connection_id))
        .await
        .map_err(|error| format!("读取 SSH 凭据任务失败：{error}"))?
}

/// 按当前认证方式写入 Rivet 自有凭据文件。
#[tauri::command]
pub async fn save_ssh_secrets(
    connection_id: String,
    auth_type: String,
    password: String,
    key_passphrase: String,
) -> Result<(), String> {
    validate_connection_id(&connection_id)?;
    validate_ssh_secret_input(&auth_type, &password, &key_passphrase)?;
    tauri::async_runtime::spawn_blocking(move || {
        save_ssh_secrets_for_sync(&connection_id, &auth_type, &password, &key_passphrase)
    })
    .await
    .map_err(|error| format!("保存 SSH 凭据任务失败：{error}"))?
}

/// 删除指定连接在 Rivet 自有凭据文件中的全部 SSH 秘密。
#[tauri::command]
pub async fn delete_ssh_secrets(connection_id: String) -> Result<(), String> {
    validate_connection_id(&connection_id)?;
    tauri::async_runtime::spawn_blocking(move || store()?.delete_ssh(&connection_id))
        .await
        .map_err(|error| format!("删除 SSH 凭据任务失败：{error}"))?
}

/// 同步模块内部读取 SSH 凭据；不会把秘密写入前端或浏览器存储。
pub(crate) fn load_ssh_secrets_for_sync(connection_id: &str) -> Result<StoredSshSecrets, String> {
    store()?.load_ssh(connection_id)
}

/// 同步模块内部恢复 SSH 凭据；认证方式切换时同时清理另一类旧秘密。
pub(crate) fn save_ssh_secrets_for_sync(
    connection_id: &str,
    auth_type: &str,
    password: &str,
    key_passphrase: &str,
) -> Result<(), String> {
    store()?.save_ssh(connection_id, auth_type, password, key_passphrase)
}

/// 查询指定同步平台是否存在本机 Token。
pub(crate) fn sync_token_exists(provider: &str) -> Result<bool, String> {
    Ok(store()?.load_sync_token(provider)?.is_some())
}

/// 读取指定同步平台 Token。
pub(crate) fn load_sync_token(provider: &str) -> Result<Option<String>, String> {
    store()?.load_sync_token(provider)
}

/// 保存指定同步平台 Token。
pub(crate) fn save_sync_token(provider: &str, token: &str) -> Result<(), String> {
    store()?.save_sync_token(provider, token)
}

/// 删除指定同步平台 Token。
pub(crate) fn delete_sync_token(provider: &str) -> Result<(), String> {
    store()?.delete_sync_token(provider)
}

/// 校验前端传入的连接标识。
fn validate_connection_id(connection_id: &str) -> Result<(), String> {
    if connection_id.trim().is_empty()
        || connection_id.len() > MAX_CONNECTION_ID_LENGTH
        || connection_id.chars().any(char::is_control)
    {
        return Err("SSH 连接标识无效".to_string());
    }
    Ok(())
}

/// 校验 SSH 凭据长度和认证方式。
fn validate_ssh_secret_input(
    auth_type: &str,
    password: &str,
    key_passphrase: &str,
) -> Result<(), String> {
    if !matches!(auth_type, "password" | "privateKey") {
        return Err("SSH 凭据认证方式无效".to_string());
    }
    if password.len() > MAX_SSH_SECRET_BYTES || key_passphrase.len() > MAX_SSH_SECRET_BYTES {
        return Err("SSH 凭据长度无效".to_string());
    }
    Ok(())
}

/// 校验同步平台键。
fn validate_provider(provider: &str) -> Result<(), String> {
    if matches!(provider, "github" | "gitee" | "gitlab") {
        Ok(())
    } else {
        Err("不支持的同步平台".to_string())
    }
}

/// 校验同步 Token 的本地存储边界。
fn validate_sync_token_value(token: &str) -> Result<(), String> {
    if token.is_empty() || token.len() > MAX_SYNC_TOKEN_BYTES || token.chars().any(char::is_control)
    {
        return Err("同步 Token 格式无效".to_string());
    }
    Ok(())
}

/// 校验整个明文凭据文档，损坏内容不得进入运行时。
fn validate_document(document: &CredentialDocument) -> Result<(), String> {
    if document.version != CREDENTIAL_STORE_VERSION || document.sync_tokens.len() > 3 {
        return Err("Rivet 本地凭据结构无效".to_string());
    }
    for (provider, token) in &document.sync_tokens {
        validate_provider(provider)?;
        validate_sync_token_value(token)?;
    }
    for (connection_id, secrets) in &document.ssh {
        validate_connection_id(connection_id)?;
        if secrets.password.len() > MAX_SSH_SECRET_BYTES
            || secrets.key_passphrase.len() > MAX_SSH_SECRET_BYTES
            || (!secrets.password.is_empty() && !secrets.key_passphrase.is_empty())
        {
            return Err("Rivet 本地 SSH 凭据结构无效".to_string());
        }
    }
    Ok(())
}

/// 读取或首次创建 Rivet 自有 256 位主密钥。
fn load_or_create_master_key(directory: &Path) -> Result<[u8; MASTER_KEY_BYTES], String> {
    let path = directory.join(MASTER_KEY_FILE_NAME);
    match fs::read(&path) {
        Ok(bytes) => {
            ensure_private_file(&path)?;
            return bytes
                .try_into()
                .map_err(|_| "Rivet 本地主密钥长度无效".to_string());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("读取 Rivet 本地主密钥失败：{error}")),
    }

    let mut key = [0_u8; MASTER_KEY_BYTES];
    getrandom::fill(&mut key).map_err(|error| format!("生成 Rivet 本地主密钥失败：{error}"))?;
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            ensure_private_file(&path)?;
            file.write_all(&key)
                .map_err(|error| format!("写入 Rivet 本地主密钥失败：{error}"))?;
            file.sync_all()
                .map_err(|error| format!("同步 Rivet 本地主密钥失败：{error}"))?;
            Ok(key)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let bytes = fs::read(&path)
                .map_err(|error| format!("读取并发创建的 Rivet 本地主密钥失败：{error}"))?;
            ensure_private_file(&path)?;
            bytes
                .try_into()
                .map_err(|_| "Rivet 本地主密钥长度无效".to_string())
        }
        Err(error) => Err(format!("创建 Rivet 本地主密钥失败：{error}")),
    }
}

/// 创建凭据目录并在 Unix 上收紧为仅当前用户访问。
fn ensure_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("创建 Rivet 凭据目录失败：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("设置 Rivet 凭据目录权限失败：{error}"))?;
    }
    Ok(())
}

/// 在 Unix 上将凭据文件权限收紧为仅当前用户读写。
fn ensure_private_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("设置 Rivet 凭据文件权限失败：{error}"))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}
