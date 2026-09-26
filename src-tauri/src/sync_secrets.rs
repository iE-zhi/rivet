//! SSH 敏感凭据的同步加密、指纹和跨设备恢复。
//!
//! 密码、私钥口令和私钥文件内容只在 Rust 侧处理；前端只接触密文状态与本机私钥路径。

use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    num::NonZeroU32,
    path::Path,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ring::{
    aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM},
    digest::{digest, SHA256},
    pbkdf2::{self, PBKDF2_HMAC_SHA256},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::credential_store::{load_ssh_secrets_for_sync, save_ssh_secrets_for_sync};

/// 加密格式版本。
const ENCRYPTED_SECRET_VERSION: u8 = 1;
/// 明文秘密包格式版本。
const SECRET_BUNDLE_VERSION: u8 = 1;
/// AES-GCM 随机 Nonce 长度。
const NONCE_BYTES: usize = 12;
/// 单个私钥文件最大 256 KiB，远大于常见 OpenSSH 私钥。
const MAX_PRIVATE_KEY_BYTES: usize = 256 * 1024;
/// 解密后的整个 SSH 秘密包最大 768 KiB。
const MAX_SECRET_BUNDLE_BYTES: usize = 768 * 1024;
/// AEAD 附加认证数据，绑定 Rivet 的秘密同步用途。
const SECRET_AAD: &[u8] = b"Rivet Sync SSH Secrets v1";
/// 本地跨设备备份使用独立 AAD，避免与云端同步密文互换使用。
const BACKUP_SECRET_AAD: &[u8] = b"Rivet Portable Backup SSH Secrets v1";
/// PBKDF2 盐长度。
const BACKUP_SALT_BYTES: usize = 16;
/// 本地备份密码派生迭代次数。
const BACKUP_PBKDF2_ITERATIONS: u32 = 200_000;

/// 云端同步文档内保存的认证加密数据。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedSyncSecrets {
    version: u8,
    nonce: String,
    ciphertext: String,
}

/// 可离线跨设备恢复的本地备份密文；密钥只由用户提供的备份密码派生。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedBackupSecrets {
    version: u8,
    iterations: u32,
    salt: String,
    nonce: String,
    ciphertext: String,
}

/// 解密后的 SSH 秘密集合。
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretBundle {
    version: u8,
    connections: Vec<ConnectionSecret>,
}

/// 单个 SSH 连接的同步秘密。
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionSecret {
    id: String,
    auth_type: String,
    password: String,
    key_passphrase: String,
    private_key_base64: Option<String>,
}

/// 读取当前本机 SSH 秘密并返回稳定指纹；指纹不包含文件路径。
pub fn local_secret_revision(document: &str) -> Result<String, String> {
    let bundle = build_local_bundle(document)?;
    let bytes = serialize_bundle(&bundle)?;
    Ok(revision_for_plaintext(&bytes))
}

/// 使用同步 Token 派生的 256 位密钥加密当前本机 SSH 秘密。
pub fn encrypt_local_secrets(
    provider: &str,
    token: &str,
    document: &str,
) -> Result<EncryptedSyncSecrets, String> {
    let bundle = build_local_bundle(document)?;
    let mut plaintext = serialize_bundle(&bundle)?;
    let key = encryption_key(provider, token)?;
    let mut nonce_bytes = [0_u8; NONCE_BYTES];
    getrandom::fill(&mut nonce_bytes)
        .map_err(|error| format!("生成同步加密随机数失败：{error}"))?;

    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce_bytes),
        Aad::from(SECRET_AAD),
        &mut plaintext,
    )
    .map_err(|_| "加密 SSH 同步凭据失败".to_string())?;

    Ok(EncryptedSyncSecrets {
        version: ENCRYPTED_SECRET_VERSION,
        nonce: BASE64.encode(nonce_bytes),
        ciphertext: BASE64.encode(plaintext),
    })
}

/// 使用用户设置的备份密码加密 SSH 敏感数据；文件可复制到任意离线设备恢复。
pub fn encrypt_local_backup_secrets(
    password: &str,
    document: &str,
) -> Result<EncryptedBackupSecrets, String> {
    validate_backup_password(password)?;
    let bundle = build_local_bundle(document)?;
    let mut plaintext = serialize_bundle(&bundle)?;
    let mut salt = [0_u8; BACKUP_SALT_BYTES];
    let mut nonce_bytes = [0_u8; NONCE_BYTES];
    getrandom::fill(&mut salt).map_err(|error| format!("生成备份加密盐失败：{error}"))?;
    getrandom::fill(&mut nonce_bytes)
        .map_err(|error| format!("生成备份加密随机数失败：{error}"))?;
    let key = backup_encryption_key(password, &salt, BACKUP_PBKDF2_ITERATIONS)?;
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce_bytes),
        Aad::from(BACKUP_SECRET_AAD),
        &mut plaintext,
    )
    .map_err(|_| "加密本地备份 SSH 凭据失败".to_string())?;

    Ok(EncryptedBackupSecrets {
        version: ENCRYPTED_SECRET_VERSION,
        iterations: BACKUP_PBKDF2_ITERATIONS,
        salt: BASE64.encode(salt),
        nonce: BASE64.encode(nonce_bytes),
        ciphertext: BASE64.encode(plaintext),
    })
}

/// 使用备份密码解密并恢复 SSH 密码、私钥口令和私钥文件。
pub fn apply_encrypted_backup_secrets(
    app: &AppHandle,
    password: &str,
    encrypted: &EncryptedBackupSecrets,
) -> Result<HashMap<String, String>, String> {
    let bundle = decrypt_backup_bundle(password, encrypted)?;
    apply_secret_bundle(app, bundle)
}

/// 解密云端秘密并计算稳定指纹，不把明文返回给前端。
pub fn encrypted_secret_revision(
    provider: &str,
    token: &str,
    encrypted: &EncryptedSyncSecrets,
) -> Result<String, String> {
    let bundle = decrypt_bundle(provider, token, encrypted)?;
    let bytes = serialize_bundle(&bundle)?;
    Ok(revision_for_plaintext(&bytes))
}

/// 把云端秘密恢复到系统凭据库和 Rivet 管理的本机私钥目录。
pub fn apply_encrypted_secrets(
    app: &AppHandle,
    provider: &str,
    token: &str,
    encrypted: &EncryptedSyncSecrets,
) -> Result<HashMap<String, String>, String> {
    let bundle = decrypt_bundle(provider, token, encrypted)?;
    apply_secret_bundle(app, bundle)
}

/// 将已经解密并校验的秘密集合恢复到系统凭据库和 Rivet 管理的私钥目录。
fn apply_secret_bundle(
    app: &AppHandle,
    bundle: SecretBundle,
) -> Result<HashMap<String, String>, String> {
    let mut managed_key_paths = HashMap::new();
    let key_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("获取 Rivet 数据目录失败：{error}"))?
        .join("ssh-keys");
    fs::create_dir_all(&key_dir).map_err(|error| format!("创建 SSH 私钥目录失败：{error}"))?;

    for connection in bundle.connections {
        validate_connection_secret(&connection)?;
        match connection.auth_type.as_str() {
            "password" => {
                save_ssh_secrets_for_sync(&connection.id, "password", &connection.password, "")?;
            }
            "privateKey" => {
                save_ssh_secrets_for_sync(
                    &connection.id,
                    "privateKey",
                    "",
                    &connection.key_passphrase,
                )?;
                let encoded = connection
                    .private_key_base64
                    .as_deref()
                    .ok_or_else(|| format!("SSH 连接 {} 的同步私钥缺失", connection.id))?;
                let key_bytes = BASE64
                    .decode(encoded)
                    .map_err(|error| format!("解码 SSH 私钥失败：{error}"))?;
                if key_bytes.is_empty() || key_bytes.len() > MAX_PRIVATE_KEY_BYTES {
                    return Err(format!("SSH 连接 {} 的私钥大小无效", connection.id));
                }
                let path = managed_key_path(&key_dir, &connection.id);
                write_private_key(&path, &key_bytes)?;
                managed_key_paths.insert(connection.id, path.to_string_lossy().into_owned());
            }
            _ => return Err("SSH 凭据认证方式无效".to_string()),
        }
    }

    Ok(managed_key_paths)
}

/// 从当前同步文档和系统凭据库构造稳定的秘密集合。
fn build_local_bundle(document: &str) -> Result<SecretBundle, String> {
    let document: Value =
        serde_json::from_str(document).map_err(|error| format!("解析本机同步文档失败：{error}"))?;
    let connections = document
        .get("terminalConnections")
        .and_then(Value::as_array)
        .ok_or_else(|| "本机同步文档缺少终端连接列表".to_string())?;
    let mut secrets = Vec::new();
    for connection in connections {
        if connection.get("kind").and_then(Value::as_str) != Some("ssh") {
            continue;
        }
        let id = connection
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "SSH 同步连接缺少 ID".to_string())?;
        let auth_type = connection
            .get("authType")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("SSH 连接 {id} 缺少认证方式"))?;
        if id.is_empty() || id.len() > 128 {
            return Err("SSH 同步连接 ID 无效".to_string());
        }
        if !matches!(auth_type, "password" | "privateKey") {
            return Err(format!("SSH 连接 {id} 的认证方式无效"));
        }

        let stored = load_ssh_secrets_for_sync(id)?;
        let (password, key_passphrase, private_key_base64) = if auth_type == "password" {
            (stored.password, String::new(), None)
        } else {
            let key_path = connection
                .get("keyPath")
                .and_then(Value::as_str)
                .filter(|path| !path.trim().is_empty())
                .ok_or_else(|| format!("SSH 连接 {id} 缺少本机私钥路径"))?;
            let key_bytes = fs::read(key_path)
                .map_err(|error| format!("读取 SSH 私钥 {key_path} 失败：{error}"))?;
            if key_bytes.is_empty() || key_bytes.len() > MAX_PRIVATE_KEY_BYTES {
                return Err(format!("SSH 连接 {id} 的私钥大小无效"));
            }
            (
                String::new(),
                stored.key_passphrase,
                Some(BASE64.encode(key_bytes)),
            )
        };

        secrets.push(ConnectionSecret {
            id: id.to_string(),
            auth_type: auth_type.to_string(),
            password,
            key_passphrase,
            private_key_base64,
        });
    }

    secrets.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(SecretBundle {
        version: SECRET_BUNDLE_VERSION,
        connections: secrets,
    })
}

/// 将秘密包序列化为确定性 JSON，用于加密与指纹计算。
fn serialize_bundle(bundle: &SecretBundle) -> Result<Vec<u8>, String> {
    let bytes =
        serde_json::to_vec(bundle).map_err(|error| format!("序列化 SSH 同步凭据失败：{error}"))?;
    if bytes.len() > MAX_SECRET_BUNDLE_BYTES {
        return Err(format!(
            "SSH 同步凭据超过 {} KiB 上限",
            MAX_SECRET_BUNDLE_BYTES / 1024
        ));
    }
    Ok(bytes)
}

/// 解密并严格校验秘密包版本与大小。
fn decrypt_bundle(
    provider: &str,
    token: &str,
    encrypted: &EncryptedSyncSecrets,
) -> Result<SecretBundle, String> {
    if encrypted.version != ENCRYPTED_SECRET_VERSION {
        return Err("SSH 同步凭据加密格式不受支持".to_string());
    }
    let nonce = BASE64
        .decode(&encrypted.nonce)
        .map_err(|error| format!("解码 SSH 同步 Nonce 失败：{error}"))?;
    let nonce: [u8; NONCE_BYTES] = nonce
        .try_into()
        .map_err(|_| "SSH 同步 Nonce 长度无效".to_string())?;
    let mut ciphertext = BASE64
        .decode(&encrypted.ciphertext)
        .map_err(|error| format!("解码 SSH 同步密文失败：{error}"))?;
    if ciphertext.len() > MAX_SECRET_BUNDLE_BYTES + 32 {
        return Err("SSH 同步密文过大".to_string());
    }

    let key = encryption_key(provider, token)?;
    let plaintext = key
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(SECRET_AAD),
            &mut ciphertext,
        )
        .map_err(|_| "无法解密 SSH 同步凭据；Token 可能与创建同步数据时不同".to_string())?;
    let bundle: SecretBundle = serde_json::from_slice(plaintext)
        .map_err(|error| format!("解析 SSH 同步凭据失败：{error}"))?;
    if bundle.version != SECRET_BUNDLE_VERSION {
        return Err("SSH 同步凭据格式不受支持".to_string());
    }
    Ok(bundle)
}

/// 使用备份密码解密离线备份中的 SSH 秘密集合。
fn decrypt_backup_bundle(
    password: &str,
    encrypted: &EncryptedBackupSecrets,
) -> Result<SecretBundle, String> {
    validate_backup_password(password)?;
    if encrypted.version != ENCRYPTED_SECRET_VERSION {
        return Err("本地备份 SSH 凭据加密格式不受支持".to_string());
    }
    if encrypted.iterations < 100_000 || encrypted.iterations > 1_000_000 {
        return Err("本地备份密码派生参数无效".to_string());
    }
    let salt = BASE64
        .decode(&encrypted.salt)
        .map_err(|error| format!("解码备份加密盐失败：{error}"))?;
    if salt.len() != BACKUP_SALT_BYTES {
        return Err("备份加密盐长度无效".to_string());
    }
    let nonce = BASE64
        .decode(&encrypted.nonce)
        .map_err(|error| format!("解码备份 Nonce 失败：{error}"))?;
    let nonce: [u8; NONCE_BYTES] = nonce
        .try_into()
        .map_err(|_| "备份 Nonce 长度无效".to_string())?;
    let mut ciphertext = BASE64
        .decode(&encrypted.ciphertext)
        .map_err(|error| format!("解码备份密文失败：{error}"))?;
    if ciphertext.len() > MAX_SECRET_BUNDLE_BYTES + 32 {
        return Err("备份 SSH 密文过大".to_string());
    }
    let key = backup_encryption_key(password, &salt, encrypted.iterations)?;
    let plaintext = key
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(BACKUP_SECRET_AAD),
            &mut ciphertext,
        )
        .map_err(|_| "备份密码错误或备份文件已损坏".to_string())?;
    let bundle: SecretBundle = serde_json::from_slice(plaintext)
        .map_err(|error| format!("解析备份 SSH 凭据失败：{error}"))?;
    if bundle.version != SECRET_BUNDLE_VERSION {
        return Err("备份 SSH 凭据格式不受支持".to_string());
    }
    Ok(bundle)
}

/// 使用 PBKDF2-HMAC-SHA256 从用户备份密码派生 AES-256-GCM 密钥。
fn backup_encryption_key(
    password: &str,
    salt: &[u8],
    iterations: u32,
) -> Result<LessSafeKey, String> {
    validate_backup_password(password)?;
    let iterations =
        NonZeroU32::new(iterations).ok_or_else(|| "备份密码派生参数无效".to_string())?;
    let mut key_bytes = [0_u8; 32];
    pbkdf2::derive(
        PBKDF2_HMAC_SHA256,
        iterations,
        salt,
        password.as_bytes(),
        &mut key_bytes,
    );
    let unbound = UnboundKey::new(&AES_256_GCM, &key_bytes)
        .map_err(|_| "初始化备份加密密钥失败".to_string())?;
    Ok(LessSafeKey::new(unbound))
}

/// 备份密码只存在于当前导入/导出操作内存中，不写入凭据库或备份文件。
fn validate_backup_password(password: &str) -> Result<(), String> {
    let length = password.chars().count();
    if length < 8 {
        return Err("备份密码至少需要 8 个字符".to_string());
    }
    if length > 256 || password.chars().any(char::is_control) {
        return Err("备份密码格式无效".to_string());
    }
    Ok(())
}

/// 从平台和高熵访问 Token 派生 AES-256-GCM 密钥。
fn encryption_key(provider: &str, token: &str) -> Result<LessSafeKey, String> {
    if token.is_empty() {
        return Err("同步 Token 不能为空".to_string());
    }
    let mut material = Vec::with_capacity(provider.len() + token.len() + 32);
    material.extend_from_slice(b"Rivet Sync Secret Key v1\0");
    material.extend_from_slice(provider.as_bytes());
    material.push(0);
    material.extend_from_slice(token.as_bytes());
    let key_bytes = digest(&SHA256, &material);
    let unbound = UnboundKey::new(&AES_256_GCM, key_bytes.as_ref())
        .map_err(|_| "初始化 SSH 同步加密密钥失败".to_string())?;
    Ok(LessSafeKey::new(unbound))
}

/// 用 SHA-256 生成本地/远端秘密一致性指纹。
fn revision_for_plaintext(plaintext: &[u8]) -> String {
    let digest = digest(&SHA256, plaintext);
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 校验解密后的单连接秘密，禁止异常字段进入系统凭据库或文件系统。
fn validate_connection_secret(connection: &ConnectionSecret) -> Result<(), String> {
    if connection.id.is_empty() || connection.id.len() > 128 {
        return Err("SSH 同步连接 ID 无效".to_string());
    }
    if connection.password.len() > 4096 || connection.key_passphrase.len() > 4096 {
        return Err(format!("SSH 连接 {} 的凭据长度无效", connection.id));
    }
    if !matches!(connection.auth_type.as_str(), "password" | "privateKey") {
        return Err(format!("SSH 连接 {} 的认证方式无效", connection.id));
    }
    Ok(())
}

/// 使用连接 ID 的 SHA-256 生成不可路径穿越的管理文件名。
fn managed_key_path(directory: &Path, connection_id: &str) -> std::path::PathBuf {
    let digest = digest(&SHA256, connection_id.as_bytes());
    let name: String = digest
        .as_ref()
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    directory.join(format!("{name}.key"))
}

/// 写入 Rivet 管理的私钥文件；Unix 平台创建时限制为仅当前用户读写。
fn write_private_key(path: &Path, content: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = options
        .open(path)
        .map_err(|error| format!("创建本机 SSH 私钥失败：{error}"))?;
    file.write_all(content)
        .map_err(|error| format!("写入本机 SSH 私钥失败：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("刷新本机 SSH 私钥失败：{error}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("设置本机 SSH 私钥权限失败：{error}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypts_and_decrypts_empty_secret_bundle() {
        let document = r#"{"terminalConnections":[]}"#;
        let encrypted = encrypt_local_secrets("github", "test-token", document)
            .expect("encryption should succeed");
        let local_revision =
            local_secret_revision(document).expect("local revision should succeed");
        let remote_revision = encrypted_secret_revision("github", "test-token", &encrypted)
            .expect("remote revision should succeed");
        assert_eq!(local_revision, remote_revision);
    }

    #[test]
    fn portable_backup_uses_password_and_rejects_wrong_password() {
        let document = r#"{"terminalConnections":[]}"#;
        let encrypted = encrypt_local_backup_secrets("portable-password", document)
            .expect("backup encryption should succeed");
        let bundle = decrypt_backup_bundle("portable-password", &encrypted)
            .expect("correct password should decrypt");
        assert_eq!(bundle.version, SECRET_BUNDLE_VERSION);
        assert!(decrypt_backup_bundle("wrong-password", &encrypted).is_err());
    }

    #[test]
    fn rejects_tampered_ciphertext() {
        let document = r#"{"terminalConnections":[]}"#;
        let mut encrypted = encrypt_local_secrets("github", "test-token", document)
            .expect("encryption should succeed");
        encrypted.ciphertext.push('A');
        assert!(encrypted_secret_revision("github", "test-token", &encrypted).is_err());
    }
}
