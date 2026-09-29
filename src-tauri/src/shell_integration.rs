//! Shell Integration 共用协议与初始化脚本。
//!
//! bash/zsh 的初始化由后端在 PTY 正式转发前完成；前端只解析 OSC 633 标记。

use std::time::Duration;

/// Shell Integration 安装的最大等待时间。
pub(crate) const INSTALL_TIMEOUT: Duration = Duration::from_secs(10);
/// 初始化期间最多缓存的 PTY 输出，防止异常 Shell 无限占用内存。
pub(crate) const MAX_OUTPUT_BYTES: usize = 256 * 1024;

/// 校验前端生成的 Shell Integration 会话标识，确保可以安全嵌入初始化脚本。
pub(crate) fn validate_token(token: &str) -> Result<(), String> {
    if !(16..=128).contains(&token.len()) || !token.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err("Shell Integration 会话标识无效".to_string());
    }
    Ok(())
}

/// 生成只作用于当前 bash/zsh 进程的 Integration 初始化脚本。
pub(crate) fn unix_bootstrap(shell_kind: &str, token: &str) -> Result<String, String> {
    validate_token(token)?;
    const TOKEN: &str = "__RIVET_TOKEN__";
    let script = match shell_kind {
        "bash" => {
            r#" __rivet_ready_marker=$'\033]633;RivetReady:__RIVET_TOKEN__\007'; __rivet_prompt_marker=$'\033]633;RivetPrompt:__RIVET_TOKEN__\007'; if [ -z "${__RIVET_SHELL_INTEGRATION-}" ]; then __RIVET_SHELL_INTEGRATION=1; PS1="\[${__rivet_ready_marker}\]${PS1}\[${__rivet_prompt_marker}\]"; fi; printf '\r\033[2K'"#
        }
        "zsh" => {
            r#" typeset -g __rivet_ready_marker=$'\033]633;RivetReady:__RIVET_TOKEN__\007'; typeset -g __rivet_prompt_marker=$'\033]633;RivetPrompt:__RIVET_TOKEN__\007'; if [[ -z ${__RIVET_SHELL_INTEGRATION-} ]]; then typeset -g __RIVET_SHELL_INTEGRATION=1; PROMPT="%{${__rivet_ready_marker}%}${PROMPT}%{${__rivet_prompt_marker}%}"; fi; printf '\r\033[2K'"#
        }
        _ => return Err("不支持的 Shell Integration 类型".to_string()),
    };
    Ok(format!("{}\r", script.replace(TOKEN, token)))
}

/// 从缓存中提取最后一个 Ready 标记起始的真实 Prompt；未完整出现时返回 None。
pub(crate) fn take_prompt_output(buffered: &mut Vec<u8>, token: &str) -> Option<Vec<u8>> {
    let ready_marker = format!("\x1b]633;RivetReady:{token}\x07").into_bytes();
    let prompt_marker = format!("\x1b]633;RivetPrompt:{token}\x07").into_bytes();
    let prompt_index = find_bytes(buffered, &prompt_marker)?;
    let ready_index = find_last_bytes_before(buffered, &ready_marker, prompt_index)?;
    Some(buffered.split_off(ready_index))
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn find_last_bytes_before(haystack: &[u8], needle: &[u8], end_exclusive: usize) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() || end_exclusive < needle.len() {
        return None;
    }
    let end = end_exclusive.min(haystack.len());
    haystack[..end]
        .windows(needle.len())
        .rposition(|window| window == needle)
}
