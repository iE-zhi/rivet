//! 通过独立 OpenSSH sftp-server 进程验收真实 SFTP 报文与文件操作，不连接用户服务器。
//! 显式运行被忽略的测试；系统须安装 OpenSSH 的 sftp-server，全部写入隔离临时目录。
#![cfg(unix)]
#![allow(dead_code)]

#[path = "../src/markdown_file.rs"]
mod markdown_file;
#[path = "../src/markdown_remote.rs"]
mod markdown_remote;

use russh_sftp::client::SftpSession;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{
    process::{Child, Command},
    runtime::Runtime,
};

/// 启动本机真实 OpenSSH 文件服务；测试进程持有子进程，异常退出时自动杀死服务。
///
/// # 参数
/// - `read_only`：true 以 -R 启动，用于验收服务器拒绝写入时的原文件保护。
/// # Errors
/// 没有安装系统服务端或握手失败时测试失败，不使用模拟成功替代。
async fn session(read_only: bool) -> (SftpSession, Child) {
    let binary = [
        "/usr/libexec/sftp-server",
        "/usr/lib/openssh/sftp-server",
        "/usr/libexec/openssh/sftp-server",
    ]
    .into_iter()
    .find(|path| Path::new(path).is_file())
    .expect("需要安装 OpenSSH sftp-server");
    let mut command = Command::new(binary);
    if read_only {
        command.arg("-R");
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("启动 SFTP 服务");
    let input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let session = SftpSession::new(tokio::io::join(output, input))
        .await
        .expect("SFTP 握手成功");
    (session, child)
}

/// 终止测试服务并回收进程；服务会话只用于本测试的临时目录。
///
/// # 参数
/// - `session`：已完成读写的客户端会话，调用时移交所有权并关闭。
/// - `child`：对应 OpenSSH 进程，关闭后等待退出，避免残留。
async fn finish(session: SftpSession, mut child: Child) {
    session.close().await.unwrap();
    child.kill().await.unwrap();
    child.wait().await.unwrap();
}

/// 准备真实 UTF-8 测试文件，路径和内容均在本机临时目录内。
///
/// # 参数
/// - `directory`：测试独占的临时目录；返回路径随其销毁而失效。
fn document_path(directory: &Path) -> PathBuf {
    let path = directory.join("note.md");
    fs::write(&path, "# 原文\n\n- [ ] 第一项\n").unwrap();
    path
}

/// OpenSSH 不允许普通 rename 覆盖目标；备份式提交流程仍须保存成功、保留权限并清理辅助文件。
#[test]
#[ignore = "需要本机 OpenSSH sftp-server；显式运行 --test markdown_remote -- --ignored"]
fn saves_markdown_through_real_sftp_and_preserves_permissions() {
    use std::os::unix::fs::PermissionsExt;
    Runtime::new().unwrap().block_on(async {
        let directory = tempfile::tempdir().unwrap();
        let path = document_path(directory.path());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let (session, child) = session(false).await;
        let loaded = markdown_remote::read_remote(&session, path.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(loaded.content, fs::read_to_string(&path).unwrap());
        let saved = markdown_remote::write_remote(
            &session,
            &loaded.path,
            "# 新文\n\n正文\n",
            &loaded.revision,
        )
        .await
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), saved.content);
        assert_ne!(saved.revision, loaded.revision);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        finish(session, child).await;
    });
}

/// 真实服务端上的外部修改和符号链接均拒绝保存，不生成残留临时文件。
#[test]
#[ignore = "需要本机 OpenSSH sftp-server"]
fn rejects_remote_conflicts_and_symbolic_links() {
    Runtime::new().unwrap().block_on(async {
        let directory = tempfile::tempdir().unwrap();
        let path = document_path(directory.path());
        let (session, child) = session(false).await;
        let loaded = markdown_remote::read_remote(&session, path.to_str().unwrap())
            .await
            .unwrap();
        fs::write(&path, "external edit").unwrap();
        assert!(markdown_remote::write_remote(
            &session,
            &loaded.path,
            "lost edit",
            &loaded.revision
        )
        .await
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "external edit");
        let link = directory.path().join("link.md");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(
            markdown_remote::read_remote(&session, link.to_str().unwrap())
                .await
                .is_err()
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
        finish(session, child).await;
    });
}

/// 服务端真实拒绝写入时返回错误，旧内容与目录状态完整保留。
#[test]
#[ignore = "需要本机 OpenSSH sftp-server"]
fn preserves_original_when_server_rejects_writes() {
    Runtime::new().unwrap().block_on(async {
        let directory = tempfile::tempdir().unwrap();
        let path = document_path(directory.path());
        let (session, child) = session(true).await;
        let loaded = markdown_remote::read_remote(&session, path.to_str().unwrap())
            .await
            .unwrap();
        assert!(
            markdown_remote::write_remote(&session, &loaded.path, "new", &loaded.revision)
                .await
                .is_err()
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), loaded.content);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        finish(session, child).await;
    });
}

/// 真实 SFTP 排他创建空文件并可继续保存；同名文件、目录、链接和只读服务均不会被覆盖。
#[test]
#[ignore = "需要本机 OpenSSH sftp-server"]
fn creates_empty_remote_markdown_and_rejects_existing_targets() {
    use std::os::unix::fs::PermissionsExt;
    Runtime::new().unwrap().block_on(
        // 本任务拥有隔离目录与两个服务进程，逐个完成断言后关闭会话并回收进程。
        async {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("new.md");
            let (session, child) = session(false).await;
            let created = markdown_remote::create_remote(&session, path.to_str().unwrap())
                .await
                .unwrap();
            assert_eq!(created.content, "");
            assert_eq!(created.revision, markdown_file::revision(b""));
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            markdown_remote::write_remote(
                &session,
                &created.path,
                "new content",
                &created.revision,
            )
            .await
            .unwrap();
            assert!(markdown_remote::create_remote(&session, &created.path)
                .await
                .is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), "new content");
            let subdirectory = directory.path().join("directory.md");
            fs::create_dir(&subdirectory).unwrap();
            let link = directory.path().join("link.md");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            for invalid in [&subdirectory, &link, &directory.path().join("invalid.txt")] {
                assert!(
                    markdown_remote::create_remote(&session, invalid.to_str().unwrap())
                        .await
                        .is_err()
                );
            }
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 3);
            finish(session, child).await;
            let (session, child) = self::session(true).await;
            let denied = directory.path().join("denied.md");
            assert!(
                markdown_remote::create_remote(&session, denied.to_str().unwrap())
                    .await
                    .is_err()
            );
            assert!(!denied.exists());
            finish(session, child).await;
        },
    );
}
