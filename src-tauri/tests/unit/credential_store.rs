//! Rivet 自有凭据存储测试。

use std::fs;

use crate::credential_store::CredentialStore;

/// 同步 Token 与 SSH 凭据应跨实例恢复，且密文文件不得出现明文秘密。
#[test]
fn app_owned_store_roundtrips_without_plaintext_secrets() {
    let temporary = tempfile::tempdir().expect("temporary directory should be created");
    let directory = temporary.path().join("credentials");
    let store = CredentialStore::open_at(directory.clone()).expect("store should open");

    store
        .save_sync_token("github", "github-secret-token")
        .expect("token should save");
    store
        .save_ssh("connection-1", "password", "ssh-secret-password", "")
        .expect("SSH password should save");

    let token = store
        .load_sync_token("github")
        .expect("token should load")
        .expect("token should exist");
    assert_eq!(token, "github-secret-token");
    let ssh = store
        .load_ssh("connection-1")
        .expect("SSH secrets should load");
    assert_eq!(ssh.password, "ssh-secret-password");
    assert!(ssh.key_passphrase.is_empty());

    let encrypted = fs::read_to_string(directory.join("credentials.enc.json"))
        .expect("encrypted credential file should exist");
    assert!(!encrypted.contains("github-secret-token"));
    assert!(!encrypted.contains("ssh-secret-password"));
    assert_eq!(
        fs::read(directory.join("credentials.key"))
            .expect("master key should exist")
            .len(),
        32,
    );

    drop(store);
    let reopened = CredentialStore::open_at(directory).expect("store should reopen");
    assert_eq!(
        reopened
            .load_sync_token("github")
            .expect("reopened token should load")
            .as_deref(),
        Some("github-secret-token"),
    );
    assert_eq!(
        reopened
            .load_ssh("connection-1")
            .expect("reopened SSH secrets should load")
            .password,
        "ssh-secret-password",
    );
}

/// 认证方式切换和删除操作不得保留旧秘密。
#[test]
fn app_owned_store_replaces_and_deletes_secrets() {
    let temporary = tempfile::tempdir().expect("temporary directory should be created");
    let store =
        CredentialStore::open_at(temporary.path().join("credentials")).expect("store should open");

    store
        .save_ssh("connection-2", "password", "old-password", "")
        .expect("password should save");
    store
        .save_ssh("connection-2", "privateKey", "", "new-passphrase")
        .expect("passphrase should replace password");

    let ssh = store
        .load_ssh("connection-2")
        .expect("SSH secrets should load");
    assert!(ssh.password.is_empty());
    assert_eq!(ssh.key_passphrase, "new-passphrase");

    store
        .save_sync_token("gitlab", "gitlab-token")
        .expect("token should save");
    store
        .delete_sync_token("gitlab")
        .expect("token should delete");
    assert!(store
        .load_sync_token("gitlab")
        .expect("token lookup should succeed")
        .is_none());

    store
        .delete_ssh("connection-2")
        .expect("SSH secrets should delete");
    let deleted = store
        .load_ssh("connection-2")
        .expect("deleted SSH lookup should succeed");
    assert!(deleted.password.is_empty());
    assert!(deleted.key_passphrase.is_empty());
}

/// Unix 下 Rivet 自有凭据目录和文件必须限制为当前用户访问。
#[cfg(unix)]
#[test]
fn app_owned_store_uses_private_unix_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let temporary = tempfile::tempdir().expect("temporary directory should be created");
    let directory = temporary.path().join("credentials");
    let store = CredentialStore::open_at(directory.clone()).expect("store should open");
    store
        .save_sync_token("gitee", "gitee-token")
        .expect("token should save");

    let directory_mode = fs::metadata(&directory)
        .expect("credential directory metadata should exist")
        .permissions()
        .mode()
        & 0o777;
    let key_mode = fs::metadata(directory.join("credentials.key"))
        .expect("master key metadata should exist")
        .permissions()
        .mode()
        & 0o777;
    let credential_mode = fs::metadata(directory.join("credentials.enc.json"))
        .expect("credential file metadata should exist")
        .permissions()
        .mode()
        & 0o777;

    assert_eq!(directory_mode, 0o700);
    assert_eq!(key_mode, 0o600);
    assert_eq!(credential_mode, 0o600);
}
