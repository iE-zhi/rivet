//! 同步模块的单元测试。

use crate::sync::{
    canonicalize_sync_document, parse_local_backup, remote_from_gist_value, revision_for_content,
    validate_sync_token, BackupSelection, LocalBackupFile, SyncRemoteConfig, ValidatedRemote,
};
use crate::sync_secrets;
use serde_json::{json, Value};

/// 判断 GitLab Snippet 是否已经包含固定同步文件。
fn gitlab_has_sync_file(payload: &Value) -> bool {
    payload
        .get("files")
        .and_then(Value::as_array)
        .is_some_and(|files| {
            files.iter().any(|file| {
                file.get("path")
                    .and_then(Value::as_str)
                    .is_some_and(|path| path == "rivet-sync.json")
            })
        })
}

/// Token 格式校验：去除首尾空白，拒绝空值、控制字符和超长内容。
#[test]
fn validates_sync_token_format() {
    assert_eq!(
        validate_sync_token("  token-value  ".to_string()).as_deref(),
        Ok("token-value")
    );
    assert!(validate_sync_token("   ".to_string()).is_err());
    assert!(validate_sync_token("token\nvalue".to_string()).is_err());
    assert!(validate_sync_token("x".repeat(8193)).is_err());
}

/// 片段 ID 只接受平台允许的安全格式。
#[test]
fn validates_snippet_ids() {
    assert!(ValidatedRemote::from_config(SyncRemoteConfig {
        provider: "github".to_string(),
        snippet_id: "abcdef0123456789".to_string(),
    })
    .is_ok());
    assert!(ValidatedRemote::from_config(SyncRemoteConfig {
        provider: "gitlab".to_string(),
        snippet_id: "12345".to_string(),
    })
    .is_ok());
    assert!(ValidatedRemote::from_config(SyncRemoteConfig {
        provider: "gitee".to_string(),
        snippet_id: "../bad".to_string(),
    })
    .is_err());
}

/// Gist 固定同步文件可被提取并生成稳定版本标识。
#[test]
fn extracts_gist_sync_file_and_revision() {
    let payload = json!({
        "files": {
            "rivet-sync.json": {
                "content": "{\"version\":1}"
            }
        }
    });
    let remote = remote_from_gist_value(&payload).expect("gist should parse");
    assert!(remote.exists);
    assert_eq!(remote.content.as_deref(), Some("{\"version\":1}"));
    assert_eq!(
        remote.revision.as_deref(),
        Some(revision_for_content("{\"version\":1}").as_str())
    );
}

/// SSH 私钥路径在同步文档规范化后必须清空。
#[test]
fn canonicalizes_local_private_key_paths() {
    let source = r#"{
  "terminalConnections": [
    {
      "kind": "ssh",
      "id": "ssh-1",
      "authType": "privateKey",
      "keyPath": "C:/Users/test/.ssh/id_ed25519"
    }
  ]
}"#;
    let canonical = canonicalize_sync_document(source).expect("document should canonicalize");
    let parsed: Value = serde_json::from_str(&canonical).expect("canonical JSON should parse");
    assert_eq!(
        parsed["terminalConnections"][0]["keyPath"].as_str(),
        Some("")
    );
}

/// 本地备份封装可被序列化并重新解析。
#[test]
fn parses_portable_local_backup() {
    let encrypted = sync_secrets::encrypt_local_backup_secrets(
        "portable-test-password",
        r#"{"terminalConnections":[]}"#,
    )
    .expect("backup secrets should encrypt");
    let backup = LocalBackupFile {
        backup_version: 1,
        exported_at: 1,
        included: BackupSelection {
            settings: true,
            serial_quick_commands: true,
            terminal_connections: true,
            terminal_quick_commands: true,
        },
        document: json!({"version": 1, "terminalConnections": []}),
        encrypted_secrets: encrypted,
    };
    let encoded = serde_json::to_string(&backup).expect("backup should serialize");
    let parsed = parse_local_backup(&encoded).expect("backup should parse");
    assert_eq!(parsed.backup_version, 1);
    assert_eq!(parsed.document["version"].as_u64(), Some(1));
}

/// GitLab 文件列表可识别 Rivet 固定同步文件。
#[test]
fn detects_gitlab_sync_file() {
    let payload = json!({
        "files": [
            { "path": "notes.txt" },
            { "path": "rivet-sync.json" }
        ]
    });
    assert!(gitlab_has_sync_file(&payload));
}
