//! SSH 高级连接模型与输入校验；仅承载连接阶段配置，不持久化认证秘密。

use serde::Deserialize;
use std::collections::HashSet;
use std::time::Duration;

/// SSH 无服务端数据时的默认探测间隔，单位秒。
const DEFAULT_KEEPALIVE_INTERVAL_SECONDS: u64 = 30;
/// 默认允许连续无响应的探测次数。
const DEFAULT_KEEPALIVE_MAX_FAILURES: usize = 3;
/// 保活间隔最大值，单位秒；最小值为 1 秒。
const MAX_KEEPALIVE_INTERVAL_SECONDS: u64 = 3600;
/// 连续无响应探测次数最大值；最小值为 1 次。
const MAX_KEEPALIVE_FAILURES: usize = 100;

/// 连接阶段的 SSH 协议保活配置；各跳独立计时，由 russh 拥有计数和定时器。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshKeepaliveConfig {
    /// 空闲探测间隔，1..=3600 秒。
    pub interval_seconds: u64,
    /// 允许连续无响应的探测次数，1..=100；服务端数据重置计数。
    pub max_failures: usize,
}

impl Default for SshKeepaliveConfig {
    /// 缺省配置启用每 30 秒探测，连续无响应上限为 3 次。
    fn default() -> Self {
        Self {
            interval_seconds: DEFAULT_KEEPALIVE_INTERVAL_SECONDS,
            max_failures: DEFAULT_KEEPALIVE_MAX_FAILURES,
        }
    }
}

impl SshKeepaliveConfig {
    /// 拒绝零值、过高探测频率及无界失败次数；非法配置不得进入网络层。
    pub(crate) fn validate(&self) -> Result<(), String> {
        if !(1..=MAX_KEEPALIVE_INTERVAL_SECONDS).contains(&self.interval_seconds)
            || !(1..=MAX_KEEPALIVE_FAILURES).contains(&self.max_failures)
        {
            return Err("SSH Keepalive 间隔范围为 1..3600 秒，失败次数范围为 1..100".into());
        }
        Ok(())
    }

    /// 创建已校验的协议配置；超时自动释放 transport，不向 PTY 注入字节。
    pub(crate) fn client_config(&self) -> Result<russh::client::Config, String> {
        self.validate()?;
        Ok(russh::client::Config {
            keepalive_interval: Some(Duration::from_secs(self.interval_seconds)),
            keepalive_max: self.max_failures,
            ..Default::default()
        })
    }
}

/// 单个连接最多启用 32 条转发规则。
pub(crate) const MAX_FORWARD_RULES: usize = 32;
/// 跳板链最多包含 8 个独立认证的主机。
pub(crate) const MAX_JUMP_HOSTS: usize = 8;
/// SSH 主机、目标主机和监听地址允许的最大 UTF-8 字节数。
const MAX_HOST_BYTES: usize = 255;
/// 密码、私钥路径和口令的单字段最大字节数。
const MAX_CREDENTIAL_BYTES: usize = 4096;
/// 用户名与规则标识的最大 UTF-8 字节数。
const MAX_IDENTIFIER_BYTES: usize = 128;

/// SSH 首因素；验证码交互由认证模块自动协商，Agent 仅请求签名，不读取其私钥。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SshAuthType {
    /// 用户名与密码认证。
    Password,
    /// 本地 OpenSSH 私钥认证。
    PrivateKey,
    /// 本机 SSH Agent 认证。
    Agent,
}

/// 单个跳板主机的连接阶段参数；不包含 PTY、X11 或端口转发配置。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHopConfig {
    /// 主机名或 IP，最多 255 字节，不允许控制字符。
    pub host: String,
    /// TCP 端口，范围 1..=65535。
    pub port: u16,
    /// 登录用户名，最多 128 字节。
    pub username: String,
    /// 此主机独立使用的认证方式。
    pub auth_type: SshAuthType,
    /// 密码认证秘密；仅驻留于连接阶段内存。
    pub password: Option<String>,
    /// 本机私钥路径，最多 4096 字节。
    pub key_path: Option<String>,
    /// 私钥解密口令；未加密私钥为空。
    pub key_passphrase: Option<String>,
}

/// 转发方向；动态转发只支持 SOCKS5 CONNECT，不支持 UDP 和 BIND。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForwardKind {
    /// 本机监听，经目标 SSH 主机访问指定目标。
    Local,
    /// 目标 SSH 主机监听，经本机访问指定目标。
    Remote,
    /// 本机 SOCKS5 监听，经目标 SSH 主机访问请求目标。
    Dynamic,
}

/// 一条非敏感转发规则；会话建立时启用，会话结束时释放。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForwardRule {
    /// 前端规则标识，最长 128 字节，在连接内唯一。
    pub id: String,
    /// 监听及目标所属方向。
    pub kind: ForwardKind,
    /// 必填监听地址；不隐式扩大到所有网络接口。
    pub bind_address: String,
    /// 固定监听端口，范围 1..=65535。
    pub bind_port: u16,
    /// 本地/远程转发的目标主机；动态转发必须为空。
    #[serde(default)]
    pub target_host: String,
    /// 目标端口；动态转发必须为 0。
    #[serde(default)]
    pub target_port: u16,
}

/// 校验非空主机字符串；允许 IPv6，拒绝空白、控制字符及异常长度。
pub(crate) fn validate_host(host: &str) -> Result<(), String> {
    if host.is_empty()
        || host.len() > MAX_HOST_BYTES
        || host.chars().any(char::is_whitespace)
        || host.chars().any(char::is_control)
    {
        return Err("SSH 主机或监听地址无效".into());
    }
    Ok(())
}

/// 校验单个认证端点；秘密不进入错误消息。
pub(crate) fn validate_hop(hop: &SshHopConfig) -> Result<(), String> {
    validate_host(&hop.host)?;
    if hop.port == 0
        || hop.username.trim().is_empty()
        || hop.username.len() > MAX_IDENTIFIER_BYTES
        || hop.username.chars().any(char::is_control)
    {
        return Err("SSH 端口或用户名无效".into());
    }
    for field in [&hop.password, &hop.key_path, &hop.key_passphrase]
        .into_iter()
        .flatten()
    {
        if field.len() > MAX_CREDENTIAL_BYTES {
            return Err("SSH 认证字段过长".into());
        }
    }
    match hop.auth_type {
        SshAuthType::Password if hop.password.is_none() => Err("缺少 SSH 密码".into()),
        SshAuthType::PrivateKey
            if hop
                .key_path
                .as_deref()
                .is_none_or(|p| p.trim().is_empty() || p.chars().any(char::is_control)) =>
        {
            Err("SSH 私钥路径无效".into())
        }
        _ => Ok(()),
    }
}

/// 校验规则数量、标识、固定端口及监听冲突；本地和动态转发共享本机端口空间。
pub(crate) fn validate_forwards(rules: &[ForwardRule]) -> Result<(), String> {
    if rules.len() > MAX_FORWARD_RULES {
        return Err(format!("端口转发最多 {MAX_FORWARD_RULES} 条"));
    }
    let mut ids = HashSet::new();
    let mut listeners = HashSet::new();
    for rule in rules {
        validate_host(&rule.bind_address)?;
        if rule.id.is_empty()
            || rule.id.len() > MAX_IDENTIFIER_BYTES
            || !ids.insert(&rule.id)
            || rule.bind_port == 0
        {
            return Err("端口转发标识或监听端口无效".into());
        }
        if !listeners.insert((
            rule.kind == ForwardKind::Remote,
            rule.bind_address.to_lowercase(),
            rule.bind_port,
        )) {
            return Err("端口转发监听地址和端口重复".into());
        }
        if rule.kind == ForwardKind::Dynamic {
            if !rule.target_host.is_empty() || rule.target_port != 0 {
                return Err("动态转发不接受固定目标".into());
            }
        } else {
            validate_host(&rule.target_host)?;
            if rule.target_port == 0 {
                return Err("端口转发目标端口无效".into());
            }
        }
    }
    Ok(())
}
