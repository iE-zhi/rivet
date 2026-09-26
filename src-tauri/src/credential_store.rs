//! SSH 凭据安全存储：使用操作系统凭据库持久化密码和私钥口令。

use serde::Serialize;

/// 系统凭据库中的服务名，所有 Rivet SSH 秘密都归属该命名空间。
const SERVICE_NAME: &str = "Rivet SSH";
/// 连接标识最大长度，与前端持久化模型保持一致。
const MAX_CONNECTION_ID_LENGTH: usize = 128;

/// 返回给前端的 SSH 秘密；字段为空表示系统凭据库中没有对应值。
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSshSecrets {
    password: String,
    key_passphrase: String,
}

/// 从系统凭据库读取指定连接的密码与私钥口令。
#[tauri::command]
pub async fn load_ssh_secrets(connection_id: String) -> Result<StoredSshSecrets, String> {
    validate_connection_id(&connection_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(StoredSshSecrets {
            password: read_secret(&connection_id, "password")?.unwrap_or_default(),
            key_passphrase: read_secret(&connection_id, "key-passphrase")?.unwrap_or_default(),
        })
    })
    .await
    .map_err(|error| format!("读取 SSH 凭据任务失败：{error}"))?
}

/// 按当前认证方式写入系统凭据库；同时删除另一种认证方式遗留的秘密。
#[tauri::command]
pub async fn save_ssh_secrets(
    connection_id: String,
    auth_type: String,
    password: String,
    key_passphrase: String,
) -> Result<(), String> {
    validate_connection_id(&connection_id)?;
    if !matches!(auth_type.as_str(), "password" | "privateKey") {
        return Err("SSH 认证方式无效".to_string());
    }
    if password.len() > 4096 || key_passphrase.len() > 4096 {
        return Err("SSH 凭据长度无效".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        if auth_type == "password" {
            write_or_delete_secret(&connection_id, "password", &password)?;
            delete_secret(&connection_id, "key-passphrase")?;
        } else {
            delete_secret(&connection_id, "password")?;
            write_or_delete_secret(&connection_id, "key-passphrase", &key_passphrase)?;
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("保存 SSH 凭据任务失败：{error}"))?
}

/// 删除指定连接在系统凭据库中的全部 SSH 秘密。
#[tauri::command]
pub async fn delete_ssh_secrets(connection_id: String) -> Result<(), String> {
    validate_connection_id(&connection_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        delete_secret(&connection_id, "password")?;
        delete_secret(&connection_id, "key-passphrase")?;
        Ok(())
    })
    .await
    .map_err(|error| format!("删除 SSH 凭据任务失败：{error}"))?
}

/// 验证前端传入的连接标识，避免空键或异常长键进入系统凭据库。
fn validate_connection_id(connection_id: &str) -> Result<(), String> {
    if connection_id.trim().is_empty() || connection_id.len() > MAX_CONNECTION_ID_LENGTH {
        return Err("SSH 连接标识无效".to_string());
    }
    Ok(())
}

/// 为一个连接和秘密类型构造稳定的系统凭据库用户名。
fn credential_user(connection_id: &str, secret_name: &str) -> String {
    format!("{connection_id}:{secret_name}")
}

/// 创建系统凭据库条目。
fn credential_entry(connection_id: &str, secret_name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE_NAME, &credential_user(connection_id, secret_name))
        .map_err(|error| format!("访问系统凭据库失败：{error}"))
}

/// 读取单个秘密；不存在时返回 None。
fn read_secret(connection_id: &str, secret_name: &str) -> Result<Option<String>, String> {
    let entry = credential_entry(connection_id, secret_name)?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取系统凭据失败：{error}")),
    }
}

/// 非空值写入系统凭据库，空值则删除原条目。
fn write_or_delete_secret(
    connection_id: &str,
    secret_name: &str,
    secret: &str,
) -> Result<(), String> {
    if secret.is_empty() {
        return delete_secret(connection_id, secret_name);
    }
    credential_entry(connection_id, secret_name)?
        .set_password(secret)
        .map_err(|error| format!("保存系统凭据失败：{error}"))
}

/// 删除单个系统凭据；条目不存在视为成功。
fn delete_secret(connection_id: &str, secret_name: &str) -> Result<(), String> {
    let entry = credential_entry(connection_id, secret_name)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除系统凭据失败：{error}")),
    }
}
