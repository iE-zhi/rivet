//! SSH 同步凭据加密模块的单元测试。

use crate::sync_secrets::{
    decrypt_backup_bundle, decrypt_bundle, encrypt_local_backup_secrets, encrypt_local_secrets,
    local_secret_revision,
};

/// 空 SSH 凭据包加密解密后应保持稳定指纹。
#[test]
fn encrypts_and_decrypts_empty_secret_bundle() {
    let document = r#"{"terminalConnections":[]}"#;
    let encrypted =
        encrypt_local_secrets("github", "test-token", document).expect("encryption should succeed");
    let first_revision = local_secret_revision(document).expect("local revision should succeed");
    let second_revision = local_secret_revision(document).expect("local revision should succeed");
    assert_eq!(first_revision, second_revision);
    assert!(decrypt_bundle("github", "test-token", &encrypted).is_ok());
}

/// 本地备份使用正确密码可解密，错误密码必须被拒绝。
#[test]
fn portable_backup_uses_password_and_rejects_wrong_password() {
    let document = r#"{"terminalConnections":[]}"#;
    let encrypted = encrypt_local_backup_secrets("portable-password", document)
        .expect("backup encryption should succeed");
    assert!(decrypt_backup_bundle("portable-password", &encrypted).is_ok());
    assert!(decrypt_backup_bundle("wrong-password", &encrypted).is_err());
}

/// 云端 SSH 密文被篡改后认证解密必须失败。
#[test]
fn rejects_tampered_ciphertext() {
    let document = r#"{"terminalConnections":[]}"#;
    let mut encrypted =
        encrypt_local_secrets("github", "test-token", document).expect("encryption should succeed");
    encrypted.ciphertext.push('A');
    assert!(decrypt_bundle("github", "test-token", &encrypted).is_err());
}

/// Agent 记录不访问凭据存储，秘密指纹与空集合一致且可加密备份。
#[test]
fn advanced_authentication_exports_no_persistent_secrets() {
    let document = r#"{"terminalConnections":[{"kind":"ssh","id":"agent","authType":"agent"}]}"#;
    assert_eq!(
        local_secret_revision(document).unwrap(),
        local_secret_revision(r#"{"terminalConnections":[]}"#).unwrap()
    );
    assert!(encrypt_local_backup_secrets("portable-password", document).is_ok());
}

/// 已移除的独立交互认证类型必须拒绝导出，不能静默回退或读取密码。
#[test]
fn removed_authentication_type_is_rejected_by_secret_export() {
    let document = r#"{"terminalConnections":[{"kind":"ssh","id":"removed","authType":"keyboardInteractive"}]}"#;
    assert!(local_secret_revision(document).is_err());
    assert!(encrypt_local_backup_secrets("portable-password", document).is_err());
}
