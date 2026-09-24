//! 日志导出边界的独立集成测试，不将测试代码编入生产模块。

#[allow(dead_code)] // 集成测试只调用校验与文件写入函数，不运行原生文件对话框命令。
#[path = "../src/log_export.rs"]
mod log_export;

#[cfg(test)]
mod tests {
    use super::log_export::{validate_log_content, write_log_file, MAX_LOG_CONTENT_BYTES};
    use std::fs;

    /// 验证非空内容在字节上限内时可通过导出校验。
    #[test]
    fn accepts_log_content_within_byte_limit() {
        let content = "a".repeat(MAX_LOG_CONTENT_BYTES);
        assert!(validate_log_content(&content).is_ok());
    }

    /// 验证空内容和超限 UTF-8 文本会在打开文件前被拒绝。
    #[test]
    fn rejects_empty_and_oversized_log_content() {
        assert!(validate_log_content("").is_err());
        let content = "字".repeat(MAX_LOG_CONTENT_BYTES / "字".len() + 1);
        assert!(validate_log_content(&content).is_err());
    }

    /// 验证成功写入会替换旧文件，输出与 UTF-8 输入完全一致。
    #[test]
    fn atomically_replaces_existing_log_file() {
        let directory = tempfile::tempdir().expect("创建临时测试目录");
        let path = directory.path().join("serial-log.txt");
        fs::write(&path, "旧日志").expect("写入旧日志");

        write_log_file(&path, "接收：测试数据\n").expect("保存新日志");

        assert_eq!(
            fs::read_to_string(path).expect("读取已保存日志"),
            "接收：测试数据\n"
        );
    }

    /// 验证目标路径不可写时，旧日志仍完整保留。
    #[test]
    fn preserves_existing_file_when_target_parent_is_not_a_directory() {
        let directory = tempfile::tempdir().expect("创建临时测试目录");
        let existing_file = directory.path().join("serial-log.txt");
        fs::write(&existing_file, "原有日志").expect("写入原有日志");
        let invalid_target = existing_file.join("child.txt");

        assert!(write_log_file(&invalid_target, "新日志").is_err());
        assert_eq!(
            fs::read_to_string(existing_file).expect("读取原有日志"),
            "原有日志"
        );
    }

    /// 验证替换非空目录失败后，目录内原文件保持不变且临时文件被清理。
    #[test]
    fn preserves_directory_contents_when_atomic_replace_fails() {
        let directory = tempfile::tempdir().expect("创建临时测试目录");
        let target = directory.path().join("serial-log.txt");
        fs::create_dir(&target).expect("创建目标目录");
        let original_file = target.join("existing.txt");
        fs::write(&original_file, "保留内容").expect("写入目录原文件");

        assert!(write_log_file(&target, "新日志").is_err());
        assert_eq!(
            fs::read_to_string(original_file).expect("读取目录原文件"),
            "保留内容"
        );
        assert_eq!(
            fs::read_dir(directory.path())
                .expect("读取测试目录")
                .count(),
            1
        );
    }
}
