//! Shell Integration 协议与初始化脚本测试。

#![allow(dead_code)]

#[path = "../src/shell_integration.rs"]
mod shell_integration;

const TOKEN: &str = "0123456789abcdef0123456789abcdef";

#[test]
fn validates_shell_integration_token() {
    assert!(shell_integration::validate_token(TOKEN).is_ok());
    assert!(shell_integration::validate_token("short").is_err());
    assert!(shell_integration::validate_token("0123456789abcdef!").is_err());
}

#[test]
fn builds_bash_and_zsh_bootstrap_with_session_markers() {
    for shell in ["bash", "zsh"] {
        let script = shell_integration::unix_bootstrap(shell, TOKEN).unwrap();
        assert!(script.ends_with('\r'));
        assert!(script.contains(&format!("RivetReady:{TOKEN}")));
        assert!(script.contains(&format!("RivetPrompt:{TOKEN}")));
        assert!(!script.contains("RivetExecute:"));
        assert!(!script.contains("RivetCommand:"));
    }
}

#[test]
fn rejects_unknown_shell_bootstrap() {
    assert!(shell_integration::unix_bootstrap("fish", TOKEN).is_err());
}

#[test]
fn extracts_only_real_prompt_from_initialization_output() {
    let ready = format!("\x1b]633;RivetReady:{TOKEN}\x07");
    let prompt = format!("\x1b]633;RivetPrompt:{TOKEN}\x07");
    let mut buffered = format!(
        "user@host:~$ echoed bootstrap text RivetReady:{TOKEN}\r\n{ready}user@host:~$ {prompt}"
    )
    .into_bytes();

    let output = shell_integration::take_prompt_output(&mut buffered, TOKEN).unwrap();
    assert_eq!(
        String::from_utf8(output).unwrap(),
        format!("{ready}user@host:~$ {prompt}")
    );
}

#[test]
fn waits_for_complete_prompt_marker() {
    let ready = format!("\x1b]633;RivetReady:{TOKEN}\x07");
    let mut buffered = format!("{ready}user@host:~$ ").into_bytes();
    assert!(shell_integration::take_prompt_output(&mut buffered, TOKEN).is_none());
}
