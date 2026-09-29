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
///
/// bash 通过 PS0 标记完整命令即将执行，由前端保留精确的多行输入；
/// zsh 通过 preexec 直接发送 Base64 编码的完整命令。
pub(crate) fn unix_bootstrap(shell_kind: &str, token: &str) -> Result<String, String> {
    validate_token(token)?;
    const TOKEN: &str = "__RIVET_TOKEN__";
    let script = match shell_kind {
        "bash" => {
            r#" __rivet_ready_marker=$'\033]633;RivetReady:__RIVET_TOKEN__\007'; __rivet_prompt_marker=$'\033]633;RivetPrompt:__RIVET_TOKEN__\007'; __rivet_execute_marker=$'\033]633;RivetExecute:__RIVET_TOKEN__\007'; if [ -z "${__RIVET_SHELL_INTEGRATION-}" ]; then __RIVET_SHELL_INTEGRATION=1; if [ "${BASH_VERSINFO[0]:-0}" -gt 4 ] || { [ "${BASH_VERSINFO[0]:-0}" -eq 4 ] && [ "${BASH_VERSINFO[1]:-0}" -ge 4 ]; }; then PS0="${PS0-}${__rivet_execute_marker}"; fi; PS1="\[${__rivet_ready_marker}\]${PS1}\[${__rivet_prompt_marker}\]"; fi; printf '\r\033[2K'"#
        }
        "zsh" => {
            r#" typeset -g __rivet_ready_marker=$'\033]633;RivetReady:__RIVET_TOKEN__\007'; typeset -g __rivet_prompt_marker=$'\033]633;RivetPrompt:__RIVET_TOKEN__\007'; typeset -g __rivet_command_prefix=$'\033]633;RivetCommand:__RIVET_TOKEN__:'; if [[ -z ${__RIVET_SHELL_INTEGRATION-} ]]; then typeset -g __RIVET_SHELL_INTEGRATION=1; function __rivet_preexec() { local __rivet_line="$1" __rivet_encoded; if (( ${#__rivet_line} > 0 && ${#__rivet_line} <= 8192 )) && (( $+commands[base64] && $+commands[tr] )); then __rivet_encoded=$(printf '%s' "$__rivet_line" | base64 | tr -d '\r\n') || return 0; [[ -n "$__rivet_encoded" ]] && printf '%s%s\007' "$__rivet_command_prefix" "$__rivet_encoded"; fi; }; autoload -Uz add-zsh-hook; add-zsh-hook preexec __rivet_preexec; PROMPT="%{${__rivet_ready_marker}%}${PROMPT}%{${__rivet_prompt_marker}%}"; fi; printf '\r\033[2K'"#
        }
        _ => return Err("不支持的 Shell Integration 类型".to_string()),
    };
    Ok(format!("{}\r", script.replace(TOKEN, token)))
}

/// 生成只作用于当前 PowerShell 进程的 Integration 初始化脚本。
///
/// PowerShell 在下一次主 Prompt 出现前读取当前会话最新历史项，因此可以拿到完整的多行命令，
/// 同时不会把交互程序期间的 stdin 误当成 Shell 命令。
pub(crate) fn powershell_bootstrap(token: &str) -> Result<String, String> {
    validate_token(token)?;
    const TOKEN: &str = "__RIVET_TOKEN__";
    let script = r#"if (-not $global:__RIVET_SHELL_INTEGRATION) { $global:__RIVET_SHELL_INTEGRATION=$true; $global:__rivetReadyMarker=([char]27)+']633;RivetReady:__RIVET_TOKEN__'+([char]7); $global:__rivetPromptMarker=([char]27)+']633;RivetPrompt:__RIVET_TOKEN__'+([char]7); $global:__rivetCommandPrefix=([char]27)+']633;RivetCommand:__RIVET_TOKEN__:'; $global:__rivetPastePrefix='__RIVET_PASTE__:__RIVET_TOKEN__:'; $global:__rivetOriginalPrompt=(Get-Item Function:prompt).ScriptBlock; $global:__rivetSkipHistory=$true; $global:__rivetLastHistoryId=$null; if (-not (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue)) { Import-Module PSReadLine -ErrorAction SilentlyContinue }; if (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue) { Set-PSReadLineKeyHandler -Chord 'Ctrl+x,Ctrl+r' -ScriptBlock { param($key,$arg); $line=$null; $cursor=0; [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line,[ref]$cursor); if ($line.StartsWith($global:__rivetPastePrefix)) { $encoded=$line.Substring($global:__rivetPastePrefix.Length); try { $decoded=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)); [Microsoft.PowerShell.PSConsoleReadLine]::Replace(0,$line.Length,$decoded) } catch {} } } }; function global:prompt { $commandMarker=''; $historyItem=Get-History -Count 1 -ErrorAction SilentlyContinue; if ($global:__rivetSkipHistory) { if ($null -ne $historyItem) { $global:__rivetLastHistoryId=$historyItem.Id }; $global:__rivetSkipHistory=$false } elseif ($null -ne $historyItem -and $historyItem.Id -ne $global:__rivetLastHistoryId) { $global:__rivetLastHistoryId=$historyItem.Id; $line=[string]$historyItem.CommandLine; if (-not [string]::IsNullOrWhiteSpace($line) -and $line.Length -le 8192) { $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line)); $commandMarker=$global:__rivetCommandPrefix+$encoded+([char]7) } }; [Console]::Write($commandMarker+$global:__rivetReadyMarker); $promptText=& $global:__rivetOriginalPrompt; (@($promptText) -join '')+$global:__rivetPromptMarker } }"#;
    Ok(script.replace(TOKEN, token))
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
