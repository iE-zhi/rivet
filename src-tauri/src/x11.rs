//! X11 转发桥接。
//!
//! 本模块读取本机 DISPLAY/xauth，向远端仅暴露随机假 cookie，并在 X11 setup
//! 握手进入本地 X Server 前替换为真实 cookie。后续字节流直接双向转发。

use std::{env, process::Command, sync::Arc};

use russh::Channel;
use tokio::io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[cfg(unix)]
use std::path::PathBuf;
use tokio::net::TcpStream;
#[cfg(unix)]
use tokio::net::UnixStream;

/// X11 MIT-MAGIC-COOKIE-1 的标准原始字节长度。
const X11_COOKIE_BYTES: usize = 16;
/// X11 setup 中认证协议名称与数据的最大长度。
const MAX_X11_AUTH_FIELD_BYTES: usize = 256;
/// X11 TCP 基础端口。
const X11_TCP_BASE_PORT: u16 = 6000;

/// 供 russh handler 克隆使用的 X11 转发配置。
#[derive(Clone)]
pub(crate) struct X11ForwardConfig {
    /// SSH request_x11 发送的认证协议。
    pub protocol: Arc<str>,
    /// SSH request_x11 发送的随机假 cookie 十六进制字符串。
    pub fake_cookie_hex: Arc<str>,
    /// 假 cookie 的原始字节，用于远端 X11 setup 验证。
    fake_cookie: Arc<[u8]>,
    /// 本机 X Server 实际 cookie 原始字节。
    real_cookie: Arc<[u8]>,
    /// 远端 DISPLAY 的 screen 编号。
    pub screen: u32,
    /// 本地 X Server socket 目标。
    endpoint: LocalEndpoint,
}

/// 本机 X Server 连接目标。
#[derive(Clone)]
enum LocalEndpoint {
    /// TCP X Server。
    Tcp { host: Arc<str>, port: u16 },
    /// Unix domain socket X Server。
    #[cfg(unix)]
    Unix(PathBuf),
}

/// 用于统一 TCP/Unix X Server stream 的异步流边界。
trait LocalX11Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T> LocalX11Stream for T where T: AsyncRead + AsyncWrite + Unpin + Send {}

/// 读取 DISPLAY 与 xauth，并生成只提供给远端的随机假 cookie。
pub(crate) async fn prepare_x11_forwarding() -> Result<X11ForwardConfig, String> {
    tauri::async_runtime::spawn_blocking(prepare_x11_forwarding_blocking)
        .await
        .map_err(|error| format!("准备 X11 转发任务失败：{error}"))?
}

/// 在阻塞线程解析环境变量、运行 xauth 并生成转发配置。
fn prepare_x11_forwarding_blocking() -> Result<X11ForwardConfig, String> {
    let display =
        env::var("DISPLAY").map_err(|_| "启用 X11 转发前必须设置 DISPLAY 环境变量".to_string())?;
    let display = display.trim();
    if display.is_empty() || display.len() > 4096 {
        return Err("DISPLAY 环境变量为空或过长".to_string());
    }

    let (display_number, screen) = parse_display_numbers(display)?;
    let endpoint = parse_local_endpoint(display, display_number)?;
    let real_cookie = read_xauth_cookie(display)?;

    let mut fake_cookie = [0_u8; X11_COOKIE_BYTES];
    getrandom::fill(&mut fake_cookie)
        .map_err(|error| format!("生成 X11 随机 cookie 失败：{error}"))?;
    let fake_cookie_hex = encode_hex(&fake_cookie);

    Ok(X11ForwardConfig {
        protocol: Arc::from("MIT-MAGIC-COOKIE-1"),
        fake_cookie_hex: Arc::from(fake_cookie_hex),
        fake_cookie: Arc::from(fake_cookie),
        real_cookie: Arc::from(real_cookie),
        screen,
        endpoint,
    })
}

/// 连接当前配置对应的本机 X Server。
async fn connect_local_x_server(
    config: &X11ForwardConfig,
) -> Result<Box<dyn LocalX11Stream>, String> {
    match &config.endpoint {
        LocalEndpoint::Tcp { host, port } => {
            let stream = TcpStream::connect((host.as_ref(), *port))
                .await
                .map_err(|error| format!("连接本地 X Server {host}:{port} 失败：{error}"))?;
            let _ = stream.set_nodelay(true);
            Ok(Box::new(stream))
        }
        #[cfg(unix)]
        LocalEndpoint::Unix(path) => {
            let stream = UnixStream::connect(path)
                .await
                .map_err(|error| format!("连接本地 X Server {} 失败：{error}", path.display()))?;
            Ok(Box::new(stream))
        }
    }
}

/// 接受一个服务端发起的 X11 channel，并桥接到本地 X Server。
pub(crate) async fn bridge_x11_channel(
    channel: Channel<russh::client::Msg>,
    config: X11ForwardConfig,
) -> Result<(), String> {
    let mut local = connect_local_x_server(&config).await?;
    let mut remote = channel.into_stream();

    rewrite_x11_setup(&mut remote, &mut local, &config).await?;
    io::copy_bidirectional(&mut remote, &mut local)
        .await
        .map_err(|error| format!("X11 双向转发失败：{error}"))?;
    Ok(())
}

/// 验证远端 setup 使用假 cookie，并将认证数据替换为本地真实 cookie。
async fn rewrite_x11_setup<R, W>(
    remote: &mut R,
    local: &mut W,
    config: &X11ForwardConfig,
) -> Result<(), String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut header = [0_u8; 12];
    remote
        .read_exact(&mut header)
        .await
        .map_err(|error| format!("读取 X11 setup 头失败：{error}"))?;

    let little_endian = match header[0] {
        b'l' => true,
        b'B' => false,
        _ => return Err("X11 setup 使用了无效字节序标识".to_string()),
    };
    let protocol_len = read_u16(&header[6..8], little_endian) as usize;
    let cookie_len = read_u16(&header[8..10], little_endian) as usize;
    if protocol_len > MAX_X11_AUTH_FIELD_BYTES || cookie_len > MAX_X11_AUTH_FIELD_BYTES {
        return Err("X11 setup 认证字段过长".to_string());
    }

    let protocol_padded = padded_x11_len(protocol_len)?;
    let cookie_padded = padded_x11_len(cookie_len)?;
    let mut auth = vec![0_u8; protocol_padded + cookie_padded];
    remote
        .read_exact(&mut auth)
        .await
        .map_err(|error| format!("读取 X11 setup 认证数据失败：{error}"))?;

    let protocol = &auth[..protocol_len];
    let cookie_offset = protocol_padded;
    let cookie = &auth[cookie_offset..cookie_offset + cookie_len];
    if protocol != config.protocol.as_bytes() {
        return Err("远端 X11 使用了不受支持的认证协议".to_string());
    }
    if cookie != config.fake_cookie.as_ref() {
        return Err("远端 X11 cookie 校验失败".to_string());
    }
    if config.real_cookie.len() != cookie_len {
        return Err("本地 X11 cookie 长度与远端握手不匹配".to_string());
    }

    auth[cookie_offset..cookie_offset + cookie_len].copy_from_slice(&config.real_cookie);
    local
        .write_all(&header)
        .await
        .map_err(|error| format!("写入本地 X11 setup 头失败：{error}"))?;
    local
        .write_all(&auth)
        .await
        .map_err(|error| format!("写入本地 X11 setup 认证失败：{error}"))?;
    local
        .flush()
        .await
        .map_err(|error| format!("刷新本地 X11 setup 失败：{error}"))?;
    Ok(())
}

/// 从 xauth 输出中读取 DISPLAY 对应的 MIT-MAGIC-COOKIE-1。
fn read_xauth_cookie(display: &str) -> Result<[u8; X11_COOKIE_BYTES], String> {
    let output = Command::new("xauth")
        .args(["list", display])
        .output()
        .map_err(|error| format!("运行 xauth 失败，请确认已安装 xauth：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "xauth 查询 DISPLAY 失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let stdout =
        String::from_utf8(output.stdout).map_err(|_| "xauth 输出不是有效 UTF-8".to_string())?;
    let cookie_hex = stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let _display = fields.next()?;
            let protocol = fields.next()?;
            let cookie = fields.next()?;
            (protocol == "MIT-MAGIC-COOKIE-1").then_some(cookie)
        })
        .next()
        .ok_or_else(|| "xauth 未找到 DISPLAY 的 MIT-MAGIC-COOKIE-1".to_string())?;

    decode_cookie_hex(cookie_hex)
}

/// 解析 DISPLAY 中的 display 与 screen 编号。
fn parse_display_numbers(display: &str) -> Result<(u16, u32), String> {
    let colon = display
        .rfind(':')
        .ok_or_else(|| "DISPLAY 缺少 display 编号".to_string())?;
    let suffix = &display[colon + 1..];
    let mut parts = suffix.splitn(2, '.');
    let display_number = parts
        .next()
        .ok_or_else(|| "DISPLAY 编号为空".to_string())?
        .parse::<u16>()
        .map_err(|_| "DISPLAY 编号无效".to_string())?;
    let screen = parts
        .next()
        .unwrap_or("0")
        .parse::<u32>()
        .map_err(|_| "DISPLAY screen 编号无效".to_string())?;
    Ok((display_number, screen))
}

/// 将 DISPLAY 映射成本机 TCP 或 Unix X Server socket。
fn parse_local_endpoint(display: &str, display_number: u16) -> Result<LocalEndpoint, String> {
    let colon = display
        .rfind(':')
        .ok_or_else(|| "DISPLAY 缺少主机分隔符".to_string())?;
    let host = &display[..colon];

    #[cfg(unix)]
    if display.starts_with('/') {
        return Ok(LocalEndpoint::Unix(PathBuf::from(display)));
    }

    if host.is_empty() || host == "unix" {
        #[cfg(unix)]
        {
            return Ok(LocalEndpoint::Unix(PathBuf::from(format!(
                "/tmp/.X11-unix/X{display_number}"
            ))));
        }
        #[cfg(not(unix))]
        {
            let port = X11_TCP_BASE_PORT
                .checked_add(display_number)
                .ok_or_else(|| "DISPLAY 对应的 TCP 端口溢出".to_string())?;
            return Ok(LocalEndpoint::Tcp {
                host: Arc::from("127.0.0.1"),
                port,
            });
        }
    }

    let port = X11_TCP_BASE_PORT
        .checked_add(display_number)
        .ok_or_else(|| "DISPLAY 对应的 TCP 端口溢出".to_string())?;
    Ok(LocalEndpoint::Tcp {
        host: Arc::from(if host == "localhost" {
            "127.0.0.1"
        } else {
            host
        }),
        port,
    })
}

/// 将十六进制 xauth cookie 解析为固定 16 字节。
fn decode_cookie_hex(input: &str) -> Result<[u8; X11_COOKIE_BYTES], String> {
    if input.len() != X11_COOKIE_BYTES * 2 || !input.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("xauth cookie 长度或格式无效".to_string());
    }
    let mut output = [0_u8; X11_COOKIE_BYTES];
    for (index, chunk) in input.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        let text = std::str::from_utf8(chunk).map_err(|_| "xauth cookie 格式无效".to_string())?;
        output[index] =
            u8::from_str_radix(text, 16).map_err(|_| "xauth cookie 格式无效".to_string())?;
    }
    Ok(output)
}

/// 将原始 cookie 编码为小写十六进制。
fn encode_hex(input: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(input.len() * 2);
    for byte in input {
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

/// 按 X11 协议将字段长度向上对齐到 4 字节。
fn padded_x11_len(length: usize) -> Result<usize, String> {
    length
        .checked_add(3)
        .map(|value| value & !3)
        .ok_or_else(|| "X11 setup 长度溢出".to_string())
}

/// 按 X11 setup 指定字节序读取 16 位整数。
fn read_u16(bytes: &[u8], little_endian: bool) -> u16 {
    let pair = [bytes[0], bytes[1]];
    if little_endian {
        u16::from_le_bytes(pair)
    } else {
        u16::from_be_bytes(pair)
    }
}
