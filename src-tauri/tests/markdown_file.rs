//! 使用隔离的真实临时文件验证 Markdown 边界、冲突与失败时的原文件保留。
#[allow(dead_code)]
#[path = "../src/markdown_file.rs"]
mod markdown_file;

use markdown_file::{
    read_local, revision, validate_content, validate_path, write_local, MAX_MARKDOWN_BYTES,
};
use std::fs;

/// 空文件、中文及 CRLF 原样读写；原摘要只在真正提交后更新。
#[test]
fn preserves_utf8_line_endings_and_supports_empty_files() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("document.md");
    let content = "\u{feff}# 标题\r\n\r\n- [ ] 内容\r\n";
    let created = write_local(&path, content, None).unwrap();
    let loaded = read_local(&path).unwrap();
    assert_eq!(loaded.content, content);
    assert_eq!(created.revision, loaded.revision);
    let saved = write_local(&path, "", Some(&loaded.revision)).unwrap();
    assert_eq!(saved.content, "");
    assert_eq!(fs::read(&path).unwrap(), b"");
    assert_ne!(saved.revision, loaded.revision);
}

/// 同大小的外部修改也被摘要识别；冲突和另存为同名目标均不覆盖现有内容。
#[test]
fn rejects_external_changes_and_existing_save_as_targets() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("document.md");
    let original = write_local(&path, "aaaa", None).unwrap();
    fs::write(&path, "bbbb").unwrap();
    assert!(write_local(&path, "new", Some(&original.revision)).is_err());
    assert!(write_local(&path, "new", None).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "bbbb");
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

/// 精确字节上限允许，超限、NUL、非 UTF-8、错误扩展名和目录全部拒绝。
#[test]
fn rejects_binary_oversized_and_non_file_inputs() {
    assert!(validate_content(&"a".repeat(MAX_MARKDOWN_BYTES)).is_ok());
    assert!(validate_content(&"字".repeat(MAX_MARKDOWN_BYTES / 3 + 1)).is_err());
    assert!(validate_content("a\0b").is_err());
    assert!(validate_path("test.MARKDOWN").is_ok());
    for path in ["", "file.txt", "file.md\0", "file.md/child"] {
        assert!(validate_path(path).is_err());
    }
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("bad.md");
    fs::write(&path, [0xff]).unwrap();
    assert!(read_local(&path).is_err());
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(read_local(&path).is_err());
    assert!(write_local(&path, "new", None).is_err());
    assert!(path.is_dir());
}

/// 两个保存线程使用同一旧版本时只允许一个成功，另一个必须看到冲突。
#[test]
fn serializes_concurrent_saves_with_the_same_revision() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("concurrent.md");
    write_local(&path, "original", None).unwrap();
    let handles = ["first", "second"].map(|content| {
        let path = path.clone();
        // 每个线程持有独立路径，模拟两个调用方同时提交同一已打开版本。
        std::thread::spawn(move || write_local(&path, content, Some(&revision(b"original"))))
    });
    let results = handles.map(|handle| handle.join().unwrap());
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
}

/// Unix 上保留原文件权限，拒绝覆盖符号链接及其目标。
#[cfg(unix)]
#[test]
fn preserves_permissions_and_rejects_symbolic_links() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("private.md");
    let original = write_local(&path, "old", None).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    write_local(&path, "new", Some(&original.revision)).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o640
    );
    let link = directory.path().join("link.md");
    symlink(&path, &link).unwrap();
    assert!(read_local(&link).is_err());
    assert!(write_local(&link, "lost", Some(&revision(b"new"))).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "new");
}
