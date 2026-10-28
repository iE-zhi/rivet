//! 使用隔离的真实目录验证文件树、路径边界和读取失败；不访问用户文件。
#[allow(dead_code)]
#[path = "../src/markdown_file.rs"]
mod markdown_file;
#[path = "../src/markdown_folder.rs"]
mod markdown_folder;

use markdown_folder::{
    canonical_root, create_directory, list_directory, read_file, FolderEntryKind,
    MAX_DIRECTORY_ENTRIES,
};
use std::fs;

/// 根目录只返回直接子项；目录优先且名称排序，普通非 Markdown 文件也应展示。
#[test]
fn lists_one_level_with_directories_first_and_opens_nested_markdown() {
    let temporary = tempfile::tempdir().unwrap();
    let root = canonical_root(temporary.path()).unwrap();
    fs::create_dir(root.join("notes")).unwrap();
    fs::write(root.join("notes/inside.md"), "# 中文\r\n").unwrap();
    fs::write(root.join("z.txt"), "visible").unwrap();
    fs::write(root.join("A.MARKDOWN"), "").unwrap();
    let directory = list_directory(&root, &root).unwrap();
    assert_eq!(directory.path, root.to_str().unwrap());
    let names: Vec<_> = directory
        .entries
        .iter()
        // entry 借用目录结果，只取原名称验证完整顺序。
        .map(|entry| entry.name.as_str())
        .collect();
    assert_eq!(names, ["notes", "A.MARKDOWN", "z.txt"]);
    assert!(directory.entries[0].kind == FolderEntryKind::Directory);
    assert!(directory.entries[2].kind == FolderEntryKind::File);
    let child = list_directory(&root, &root.join("notes")).unwrap();
    assert_eq!(child.entries.len(), 1);
    assert_eq!(
        read_file(&root, &root.join("notes/inside.md"))
            .unwrap()
            .content,
        "# 中文\r\n"
    );
    assert!(read_file(&root, &root.join("z.txt")).is_err());
}

/// 根目录、同前缀兄弟目录和 .. 均不能扩大所选范围；失败不改变原文件。
#[test]
fn rejects_outside_paths_parent_traversal_and_missing_entries() {
    let temporary = tempfile::tempdir().unwrap();
    let base = canonical_root(temporary.path()).unwrap();
    let root = base.join("notes");
    let sibling = base.join("notes-copy");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&sibling).unwrap();
    fs::write(sibling.join("private.md"), "unchanged").unwrap();
    for path in [
        base.clone(),
        sibling.clone(),
        root.join("../notes-copy"),
        root.join("missing"),
    ] {
        assert!(list_directory(&root, &path).is_err());
    }
    assert!(read_file(&root, &sibling.join("private.md")).is_err());
    assert!(canonical_root(&sibling.join("private.md")).is_err());
    assert!(canonical_root(std::path::Path::new("")).is_err());
    assert_eq!(
        fs::read_to_string(sibling.join("private.md")).unwrap(),
        "unchanged"
    );
}

/// 空目录可打开；恰好 2000 项完整返回，多一项必须整次失败而非悄悄截断。
#[test]
fn accepts_empty_and_exact_limit_but_rejects_oversized_directory() {
    let temporary = tempfile::tempdir().unwrap();
    let root = canonical_root(temporary.path()).unwrap();
    assert!(list_directory(&root, &root).unwrap().entries.is_empty());
    for index in 0..MAX_DIRECTORY_ENTRIES {
        fs::write(root.join(format!("{index}.md")), "").unwrap();
    }
    assert_eq!(
        list_directory(&root, &root).unwrap().entries.len(),
        MAX_DIRECTORY_ENTRIES
    );
    assert!(create_directory(&root, "new-folder").is_err());
    assert!(!root.join("new-folder").exists());
    fs::write(root.join("overflow.md"), "").unwrap();
    assert!(list_directory(&root, &root).is_err());
}

/// Unix 链接节点仍可展示，但文件、目录及循环链接都不能被读取或展开。
#[cfg(unix)]
#[test]
fn shows_links_without_following_files_directories_or_cycles() {
    use std::os::unix::fs::symlink;
    let temporary = tempfile::tempdir().unwrap();
    let root = canonical_root(temporary.path()).unwrap();
    fs::write(root.join("real.md"), "safe").unwrap();
    fs::create_dir(root.join("real-dir")).unwrap();
    symlink(root.join("real.md"), root.join("link.md")).unwrap();
    symlink(root.join("real-dir"), root.join("linked-dir")).unwrap();
    symlink(&root, root.join("cycle")).unwrap();
    let directory = list_directory(&root, &root).unwrap();
    assert_eq!(
        directory
            .entries
            .iter()
            // entry 为未跟随目标的节点，三种链接都应被识别。
            .filter(|entry| entry.kind == FolderEntryKind::Symlink)
            .count(),
        3
    );
    assert!(read_file(&root, &root.join("link.md")).is_err());
    assert!(list_directory(&root, &root.join("linked-dir")).is_err());
    assert!(list_directory(&root, &root.join("cycle")).is_err());
    assert_eq!(fs::read_to_string(root.join("real.md")).unwrap(), "safe");
}

/// Unix 非 UTF-8 路径在访问文件系统前被拒绝，不依赖文件系统允许创建此名称。
#[cfg(unix)]
#[test]
fn rejects_non_utf8_paths_before_accessing_the_filesystem() {
    use std::os::unix::ffi::OsStringExt;
    let temporary = tempfile::tempdir().unwrap();
    let root = canonical_root(temporary.path()).unwrap();
    let invalid = root.join(std::ffi::OsString::from_vec(vec![0xff]));
    assert!(canonical_root(&invalid).is_err());
    assert!(list_directory(&root, &invalid).is_err());
    assert!(read_file(&root, &invalid).is_err());
    assert!(list_directory(&root, &root).unwrap().entries.is_empty());
}

/// 创建中文空目录并回读列表；同名目录和文件均保留原内容，不自动合并或覆盖。
#[test]
fn creates_empty_directory_and_preserves_existing_nodes() {
    let temporary = tempfile::tempdir().unwrap();
    let root = canonical_root(temporary.path()).unwrap();
    let created = create_directory(&root, "新文件夹").unwrap();
    assert_eq!(created, root.join("新文件夹").to_str().unwrap());
    assert!(list_directory(&root, std::path::Path::new(&created))
        .unwrap()
        .entries
        .is_empty());
    assert_eq!(
        list_directory(&root, &root).unwrap().entries[0].name,
        "新文件夹"
    );
    fs::write(root.join("新文件夹/keep.md"), "keep").unwrap();
    fs::write(root.join("existing"), "original").unwrap();
    assert!(create_directory(&root, "新文件夹").is_err());
    assert!(create_directory(&root, "existing").is_err());
    assert_eq!(
        fs::read_to_string(root.join("新文件夹/keep.md")).unwrap(),
        "keep"
    );
    assert_eq!(
        fs::read_to_string(root.join("existing")).unwrap(),
        "original"
    );
}

/// 路径跳转、跨平台非法字符、保留名和超过 255 字节的名称全部在创建前拒绝。
#[test]
fn rejects_invalid_directory_names_without_creating_any_nodes() {
    let temporary = tempfile::tempdir().unwrap();
    let root = canonical_root(temporary.path()).unwrap();
    for name in [
        "",
        ".",
        "..",
        "../outside",
        "a/b",
        "a\\b",
        "/absolute",
        "a\0b",
        "a\nb",
        "a:b",
        "a?b",
        "a*b",
        "a<b",
        "a>b",
        "a|b",
        "a\"b",
        " leading",
        "trailing ",
        "dot.",
        "CON",
        "con.txt",
        "PRN",
        "AUX",
        "nul",
        "COM1",
        "LPT9",
    ] {
        assert!(create_directory(&root, name).is_err(), "{name:?}");
    }
    assert!(create_directory(&root, &"字".repeat(86)).is_err());
    assert!(list_directory(&root, &root).unwrap().entries.is_empty());
    assert!(create_directory(&root, "COM10").is_ok());
}

/// 两个真实线程创建同名目录时只有一个成功，另一个收到冲突，最终只有一个空目录。
#[test]
fn concurrent_creation_of_the_same_name_only_succeeds_once() {
    let temporary = tempfile::tempdir().unwrap();
    let root = canonical_root(temporary.path()).unwrap();
    let handles = [root.clone(), root.clone()].map(
        // root 移入独立线程，任务只创建 shared，不保留句柄或随机等待。
        |root| std::thread::spawn(move || create_directory(&root, "shared")),
    );
    let results = handles.map(
        // handle 必须完成后才检查目录，线程异常作为测试失败暴露。
        |handle| handle.join().unwrap(),
    );
    assert_eq!(
        results
            .iter()
            .filter(
                // result 来自两个同名创建调用，严格只允许一次成功。
                |result| result.is_ok(),
            )
            .count(),
        1
    );
    assert_eq!(list_directory(&root, &root).unwrap().entries.len(), 1);
}
