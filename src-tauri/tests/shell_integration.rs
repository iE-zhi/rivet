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
    }

    let bash = shell_integration::unix_bootstrap("bash", TOKEN).unwrap();
    assert!(bash.contains(&format!("RivetExecute:{TOKEN}")));
    assert!(!bash.contains("RivetCommand:"));

    let zsh = shell_integration::unix_bootstrap("zsh", TOKEN).unwrap();
    assert!(!zsh.contains("RivetExecute:"));
    assert!(zsh.contains(&format!("RivetCommand:{TOKEN}:")));
    assert!(zsh.contains("add-zsh-hook preexec"));
}

#[test]
fn builds_powershell_bootstrap_with_multiline_command_marker() {
    let script = shell_integration::powershell_bootstrap(TOKEN).unwrap();
    assert!(script.contains(&format!("RivetReady:{TOKEN}")));
    assert!(script.contains(&format!("RivetPrompt:{TOKEN}")));
    assert!(script.contains(&format!("RivetCommand:{TOKEN}:")));
    assert!(script.contains("Get-History -Count 1"));
    assert!(script.contains("ToBase64String"));
    assert!(script.contains(&format!("__RIVET_PASTE__:{TOKEN}:")));
    assert!(script.contains("Set-PSReadLineKeyHandler"));
    assert!(script.contains("PSConsoleReadLine]::Replace"));
    assert!(!script.contains("IndexOf([char]10)"));
    assert!(!script.contains("IndexOf([char]13)"));
}

#[cfg(windows)]
#[test]
fn powershell_reports_multiline_command_from_real_pty() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::{
        io::{Read, Write},
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };

    fn read_until(
        receiver: &mpsc::Receiver<Vec<u8>>,
        writer: &mut dyn Write,
        marker: &[u8],
        timeout: Duration,
        stage: &str,
    ) -> Result<Vec<u8>, String> {
        let deadline = Instant::now() + timeout;
        let mut output = Vec::new();
        loop {
            if output.windows(marker.len()).any(|window| window == marker) {
                return Ok(output);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!(
                    "等待 PowerShell {stage} 输出超时：{:?}",
                    String::from_utf8_lossy(&output)
                ));
            }
            let chunk = receiver.recv_timeout(remaining).map_err(|error| {
                format!(
                    "读取 PowerShell {stage} 输出失败：{error}；已收到：{:?}",
                    String::from_utf8_lossy(&output)
                )
            })?;
            if chunk.windows(4).any(|window| window == b"\x1b[6n") {
                writer
                    .write_all(b"\x1b[1;1R")
                    .and_then(|_| writer.flush())
                    .map_err(|error| error.to_string())?;
            }
            output.extend_from_slice(&chunk);
        }
    }

    let result = (|| -> Result<(), String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;
        let mut command = CommandBuilder::new("powershell.exe");
        command.arg("-NoLogo");
        command.arg("-NoProfile");
        command.arg("-NoExit");
        command.arg("-Command");
        command.arg(shell_integration::powershell_bootstrap(TOKEN)?);
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| error.to_string())?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        let (sender, receiver) = mpsc::channel();
        let _reader_thread = thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(length) => {
                        if sender.send(buffer[..length].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let prompt_marker = format!("\x1b]633;RivetPrompt:{TOKEN}\x07");
        read_until(
            &receiver,
            writer.as_mut(),
            prompt_marker.as_bytes(),
            Duration::from_secs(10),
            "启动",
        )?;

        writer
            .write_all(b"if ($true) {\r  Write-Output 'rivet-multiline'\r}\r")
            .and_then(|_| writer.flush())
            .map_err(|error| error.to_string())?;
        let output = read_until(
            &receiver,
            writer.as_mut(),
            prompt_marker.as_bytes(),
            Duration::from_secs(10),
            "多行命令",
        )?;
        let prefix = format!("\x1b]633;RivetCommand:{TOKEN}:");
        let prefix_index = output
            .windows(prefix.len())
            .position(|window| window == prefix.as_bytes())
            .ok_or_else(|| "PowerShell 未返回完整命令标记".to_string())?;
        let encoded_start = prefix_index + prefix.len();
        let encoded_end = output[encoded_start..]
            .iter()
            .position(|byte| *byte == 0x07)
            .map(|index| encoded_start + index)
            .ok_or_else(|| "PowerShell 完整命令标记缺少结束符".to_string())?;
        let encoded = std::str::from_utf8(&output[encoded_start..encoded_end])
            .map_err(|error| error.to_string())?;
        let command = String::from_utf8(
            STANDARD
                .decode(encoded)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?
        .replace("\r\n", "\n")
        .replace('\r', "\n");
        if command != "if ($true) {\n  Write-Output 'rivet-multiline'\n}" {
            return Err(format!("PowerShell 返回了错误的多行命令：{command:?}"));
        }

        let inserted = "if ($true) {\n  Write-Output 'rivet-psreadline-insert'\n}";
        let insert_payload = format!(
            "__RIVET_PASTE__:{TOKEN}:{}\x18\x12",
            STANDARD.encode(inserted.as_bytes())
        );
        writer
            .write_all(insert_payload.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| error.to_string())?;
        thread::sleep(Duration::from_millis(150));
        let mut before_enter = Vec::new();
        while let Ok(chunk) = receiver.try_recv() {
            if chunk.windows(4).any(|window| window == b"\x1b[6n") {
                writer
                    .write_all(b"\x1b[1;1R")
                    .and_then(|_| writer.flush())
                    .map_err(|error| error.to_string())?;
            }
            before_enter.extend_from_slice(&chunk);
        }
        if before_enter
            .windows(prompt_marker.len())
            .any(|window| window == prompt_marker.as_bytes())
        {
            return Err("PowerShell PSReadLine 填充在按 Enter 前就执行了命令".to_string());
        }

        writer
            .write_all(b"\r")
            .and_then(|_| writer.flush())
            .map_err(|error| error.to_string())?;
        let output = read_until(
            &receiver,
            writer.as_mut(),
            prompt_marker.as_bytes(),
            Duration::from_secs(10),
            "PSReadLine 多行填充",
        )?;
        let prefix_index = output
            .windows(prefix.len())
            .position(|window| window == prefix.as_bytes())
            .ok_or_else(|| "PowerShell PSReadLine 填充未返回完整命令标记".to_string())?;
        let encoded_start = prefix_index + prefix.len();
        let encoded_end = output[encoded_start..]
            .iter()
            .position(|byte| *byte == 0x07)
            .map(|index| encoded_start + index)
            .ok_or_else(|| "PowerShell PSReadLine 填充命令标记缺少结束符".to_string())?;
        let encoded = std::str::from_utf8(&output[encoded_start..encoded_end])
            .map_err(|error| error.to_string())?;
        let command = String::from_utf8(
            STANDARD
                .decode(encoded)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?
        .replace("\r\n", "\n")
        .replace('\r', "\n");
        if command != inserted {
            return Err(format!(
                "PowerShell PSReadLine 填充返回错误命令：{command:?}"
            ));
        }

        writer.write_all(b"exit\r").ok();
        child.kill().ok();
        drop(writer);
        drop(receiver);
        Ok(())
    })();

    assert!(result.is_ok(), "{}", result.unwrap_err());
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
