//! 本机系统 Agent 的显式联网验收；复用生产认证代码，只访问环境变量指定的 SSH 端点。
//! 默认忽略，不加载密钥、不修改服务或 known_hosts；目标必须已受本机 known_hosts 信任。

#![allow(dead_code)]

#[path = "../src/ssh_auth.rs"]
mod ssh_auth;
#[path = "../src/ssh_config.rs"]
mod ssh_config;

use russh::{client, keys::PublicKeyOrCertificate, ChannelMsg, Disconnect};
use ssh_config::{SshAuthType, SshHopConfig};
use std::{error::Error, sync::Arc, time::Duration};
use tokio::time::timeout;

/// 每次完整联网验收最多等待 45 秒，超时后运行时释放连接资源。
const LIVE_TIMEOUT: Duration = Duration::from_secs(45);
/// SSH 单次传输等待上限，单位为秒。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 远端命令累计输出最多 64 KiB，超过即拒绝继续读取。
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
/// 验收 PTY 尺寸，单位为字符；不依赖本机窗口大小。
const PROBE_PTY_SIZE: (u32, u32) = (80, 24);
/// 只读命令输出标记、登录 UID 和内核名称；不修改远端状态。
const PROBE_COMMAND: &str = "printf 'RIVET_AGENT_OK\\n'; id -u; uname -s; exit\n";

/// 验收客户端仅接受已记录的目标主机密钥；不执行首次信任或覆盖。
struct TrustedHost {
    /// 本次测试唯一目标，用于 known_hosts 校验。
    host: String,
    /// SSH TCP 端口，范围 1..=65535。
    port: u16,
}

impl client::Handler for TrustedHost {
    /// 主机密钥、文件读取及 SSH 协议错误均保留原始原因。
    type Error = Box<dyn Error + Send + Sync>;

    /// 未知主机返回拒绝；主机密钥变化和文件读取错误向测试调用方传播。
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(russh::keys::check_known_hosts(
            &self.host,
            self.port,
            &key.public_key(),
        )?)
    }
}

/// 从显式测试环境读取非敏感目标；缺失或格式不合法时在联网前失败。
fn target_from_env() -> SshHopConfig {
    let target = SshHopConfig {
        host: std::env::var("RIVET_SSH_AGENT_TEST_HOST").expect("set RIVET_SSH_AGENT_TEST_HOST"),
        port: std::env::var("RIVET_SSH_AGENT_TEST_PORT")
            .expect("set RIVET_SSH_AGENT_TEST_PORT")
            .parse()
            .expect("port must be an integer in 1..=65535"),
        username: std::env::var("RIVET_SSH_AGENT_TEST_USER")
            .expect("set RIVET_SSH_AGENT_TEST_USER"),
        auth_type: SshAuthType::Agent,
        password: None,
        key_path: None,
        key_passphrase: None,
    };
    ssh_config::validate_hop(&target).expect("invalid SSH test target");
    target
}

/// 在独立运行时中限时连接真实 SSH 主机，校验生产 Agent 认证及交互式 PTY。
/// `expect_unavailable` 仅在系统 Agent 已停止时使用，断言可见错误且不降级到密码。
fn run_live_probe(expect_unavailable: bool) {
    let target = target_from_env();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("create probe runtime")
        .block_on(async {
            timeout(LIVE_TIMEOUT, async {
                let config = Arc::new(client::Config {
                    inactivity_timeout: Some(CONNECT_TIMEOUT),
                    ..Default::default()
                });
                let handler = TrustedHost {
                    host: target.host.clone(),
                    port: target.port,
                };
                let mut session =
                    client::connect(config, (target.host.as_str(), target.port), handler)
                        .await
                        .expect("connect trusted SSH host");
                // 调用与正式连接相同的平台 Agent 接入及身份签名流程，不提供密码回调。
                let auth = ssh_auth::authenticate_with_prompts(
                    &mut session,
                    &target,
                    // 实际验收仅允许 Agent；服务端要求交互时立即失败。
                    |_name, _instructions, _prompts| async {
                        Err("live Agent probe does not accept interactive authentication".into())
                    },
                )
                .await;
                if expect_unavailable {
                    let error = auth.expect_err("stopped Agent must reject authentication");
                    assert!(error.starts_with("连接本机 SSH Agent 失败"), "{error}");
                    println!("RIVET_AGENT_UNAVAILABLE_OK: {error}");
                } else {
                    auth.expect("authenticate through the system Agent");
                    let mut channel = session
                        .channel_open_session()
                        .await
                        .expect("open command channel");
                    channel
                        .request_pty(
                            true,
                            "xterm-256color",
                            PROBE_PTY_SIZE.0,
                            PROBE_PTY_SIZE.1,
                            // 像素宽高为 0，表示只提供字符尺寸。
                            0,
                            0,
                            &[],
                        )
                        .await
                        .expect("allocate remote terminal");
                    channel
                        .request_shell(true)
                        .await
                        .expect("start remote shell");
                    channel
                        .data(PROBE_COMMAND.as_bytes())
                        .await
                        .expect("send read-only probe to terminal");
                    let mut output = Vec::new();
                    let mut exit_status = None;
                    // 分别累计标准输出和错误输出；任何异常退出或缺少成功标记均使验收失败。
                    while let Some(message) = channel.wait().await {
                        match message {
                            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                                assert!(
                                    output.len() + data.len() <= MAX_OUTPUT_BYTES,
                                    "probe output too large"
                                );
                                output.extend_from_slice(&data);
                            }
                            ChannelMsg::ExitStatus {
                                exit_status: status,
                            } => exit_status = Some(status),
                            ChannelMsg::Close => break,
                            _ => {}
                        }
                    }
                    assert_eq!(
                        exit_status,
                        Some(0),
                        "probe command did not exit successfully"
                    );
                    let output = String::from_utf8(output).expect("probe output must be UTF-8");
                    // PTY 控制序列可用单独 CR 返回行首；成功标记必须独占一段终端文本。
                    assert!(
                        output
                            .split(['\r', '\n'])
                            .any(|line| line == "RIVET_AGENT_OK"),
                        "probe marker missing"
                    );
                    println!("RIVET_AGENT_PTY_OK");
                }
                // 两种结果均主动关闭传输；超时或 panic 由独立运行时回收所有 socket。
                session
                    .disconnect(Disconnect::ByApplication, "probe complete", "English")
                    .await
                    .expect("disconnect probe");
            })
            .await
            .expect("live SSH Agent probe timed out");
        });
}

/// 真实系统 Agent 已加载目标授权密钥时，应完成认证、创建 PTY 并执行只读命令。
#[test]
#[ignore = "requires an explicitly configured trusted SSH target and loaded system Agent"]
fn system_agent_authenticates_and_executes_read_only_command() {
    run_live_probe(false);
}

/// 系统 Agent 停止时，应返回连接 Agent 的明确错误，不尝试密码或私钥认证。
#[test]
#[ignore = "requires an explicitly configured trusted SSH target and stopped system Agent"]
fn stopped_system_agent_returns_visible_error_without_password_fallback() {
    run_live_probe(true);
}
