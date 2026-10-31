//! VNC TCP 连接与认证策略边界：显式选择 VNC、Apple 或无认证，不允许自动降级。

use crate::vnc_apple_auth;

use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::TcpStream,
};

/// RFB 版本消息固定为十二字节，协议引擎的首次写入由本适配器消费。
const VERSION_BYTES: usize = 12;
/// Apple 屏幕共享的 DH/AES 用户名认证安全类型。
const APPLE_AUTH: u8 = 30;
/// 服务端拒绝连接的说明最多读取四 KiB，避免恶意长度造成无界分配。
const MAX_REASON_BYTES: usize = 4096;

/// 已完成版本协商的 TCP 流；向协议引擎重放协商头，随后直接转交网络 I/O。
/// 独占 socket，丢弃时关闭；不保留凭据，也不生成后台任务。
pub(crate) struct VncTransport {
    /// 会话独占的已连接 TCP socket。
    stream: TcpStream,
    /// 已校验的版本与单一允许认证类型，最多十八字节。
    prefix: Vec<u8>,
    /// 重放头已读取的字节数，不超过 prefix.len()。
    read_offset: usize,
    /// 引擎重放写入已消费的字节数，范围 0..=write_prefix.len()。
    write_offset: usize,
    /// 已写给服务端、需从引擎写入中消费的版本及可选安全类型选择。
    write_prefix: Vec<u8>,
}

impl VncTransport {
    /// 读取有限的版本与认证头，仅向引擎提供调用方允许的认证方式。
    ///
    /// # 参数
    /// - `stream`：转移所有权的 TCP socket；失败或取消时自动关闭。
    /// - `auth_type`：已校验的 password、apple 或 none，不允许协商降级。
    /// - `username`：Apple 账户名；其他认证模式忽略。
    /// - `password`：Apple 握手临时密码；其他模式由协议引擎处理。
    ///
    /// # Errors
    /// 网络、非法版本、认证方式不匹配均返回错误；超时和取消由调用方包围整个握手。
    pub(crate) async fn negotiate(
        mut stream: TcpStream,
        auth_type: &str,
        username: &str,
        password: &str,
    ) -> Result<Self, String> {
        let mut banner = [0; VERSION_BYTES];
        stream
            .read_exact(&mut banner)
            .await
            .map_err(|error| format!("读取 VNC 版本失败：{error}"))?;
        let version = negotiate_version(&banner)?;
        stream
            .write_all(&version)
            .await
            .map_err(|error| format!("发送 VNC 版本失败：{error}"))?;
        // 只选择配置明确指定的安全类型；Apple 账户密码不允许流入传统八字节认证。
        let selected = match auth_type {
            "password" => 2,
            "apple" => APPLE_AUTH,
            "none" => 1,
            _ => return Err("VNC 认证方式无效".into()),
        };
        let mut prefix = version.to_vec();
        let mut write_prefix = version.to_vec();
        if &version == b"RFB 003.003\n" {
            let security = stream
                .read_u32()
                .await
                .map_err(|error| format!("读取 VNC 认证方式失败：{error}"))?;
            if security == 0 {
                return Err(read_reason(&mut stream).await?);
            }
            if security != u32::from(selected) {
                return Err("VNC 服务端认证方式与连接配置不匹配".into());
            }
            prefix.extend_from_slice(&security.to_be_bytes());
        } else {
            let count = stream
                .read_u8()
                .await
                .map_err(|error| format!("读取 VNC 认证方式失败：{error}"))?;
            if count == 0 {
                return Err(read_reason(&mut stream).await?);
            }
            let mut methods = vec![0; usize::from(count)];
            stream
                .read_exact(&mut methods)
                .await
                .map_err(|error| format!("读取 VNC 认证列表失败：{error}"))?;
            if !methods.contains(&selected) {
                if selected != APPLE_AUTH && methods.contains(&APPLE_AUTH) {
                    return Err(
                        "服务端提供 macOS 账户认证，请选择“macOS 用户名和密码”并填写用户名".into(),
                    );
                }
                return Err(format!(
                    "服务端不支持所选认证方式：{auth_type}（提供的安全类型：{methods:?}）"
                ));
            }
            if selected == APPLE_AUTH {
                stream
                    .write_u8(APPLE_AUTH)
                    .await
                    .map_err(|error| format!("选择 Apple 认证失败：{error}"))?;
                vnc_apple_auth::authenticate(&mut stream, username, password).await?;
                let result = stream
                    .read_u32()
                    .await
                    .map_err(|error| format!("读取 Apple 认证结果失败：{error}"))?;
                if result != 0 {
                    return Err(if &version == b"RFB 003.008\n" {
                        read_reason(&mut stream).await?
                    } else {
                        "Apple 用户名或密码认证失败".into()
                    });
                }
                // Apple 认证已完成；向引擎重放成功握手并消费其 None 选择，不向远端发送 None。
                prefix.extend_from_slice(&[1, 1]);
                if &version == b"RFB 003.008\n" {
                    prefix.extend_from_slice(&0u32.to_be_bytes());
                }
                write_prefix.push(1);
            } else {
                prefix.extend_from_slice(&[1, selected]);
            }
        }
        Ok(Self {
            stream,
            prefix,
            read_offset: 0,
            write_offset: 0,
            write_prefix,
        })
    }
}

impl AsyncRead for VncTransport {
    /// 先重放 prefix，再读取 socket；cx/buf 仅在当前 poll 调用期间借用。
    ///
    /// # 参数
    /// - `cx`：运行时唤醒上下文，不保存引用。
    /// - `buf`：调用方拥有的可写缓冲，最多填满剩余空间。
    ///
    /// # Errors
    /// socket 读取错误直接向上传递，适配器不重试或改变偏移以外的状态。
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.read_offset < this.prefix.len() {
            let count = buf.remaining().min(this.prefix.len() - this.read_offset);
            buf.put_slice(&this.prefix[this.read_offset..this.read_offset + count]);
            this.read_offset += count;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut this.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for VncTransport {
    /// 消费已发送的版本头并校验一致性，后续写入直接转交 socket。
    ///
    /// # 参数
    /// - `cx`：网络写入的唤醒上下文，不跨调用保存。
    /// - `buf`：引擎提供的待写字节，只读且不保存借用。
    ///
    /// # Errors
    /// 版本内容不一致返回 InvalidData；其他网络错误原样传播，不自动重发。
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if this.write_offset < this.write_prefix.len() {
            let count = buf.len().min(this.write_prefix.len() - this.write_offset);
            if buf[..count] != this.write_prefix[this.write_offset..this.write_offset + count] {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "VNC 版本重放不一致",
                )));
            }
            this.write_offset += count;
            return Poll::Ready(Ok(count));
        }
        Pin::new(&mut this.stream).poll_write(cx, buf)
    }

    /// 刷新 socket 的待写数据。
    ///
    /// # 参数
    /// - `cx`：运行时的本次刷新上下文。
    ///
    /// # Errors
    /// socket 刷新错误原样传播，由会话负责关闭连接。
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(cx)
    }

    /// 关闭 socket 写方向；资源仍由会话拥有，最终通过 Drop 释放。
    ///
    /// # 参数
    /// - `cx`：运行时的本次关闭上下文。
    ///
    /// # Errors
    /// 关闭写方向的网络错误原样传播；最终 Drop 仍释放 socket。
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }
}

/// 将 RFB 3.x 的服务端公告降至双方支持的标准版本，兼容 Apple 3.889。
///
/// # 参数
/// - `banner`：恰好十二字节的网络版本公告，只接受固定格式 ASCII 数字。
///
/// # Errors
/// 格式错误、主版本不是三或次版本小于三时拒绝，不写入网络。
pub(crate) fn negotiate_version(
    banner: &[u8; VERSION_BYTES],
) -> Result<[u8; VERSION_BYTES], String> {
    if &banner[..8] != b"RFB 003."
        || banner[11] != b'\n'
        || !banner[8..11].iter().all(u8::is_ascii_digit)
    {
        return Err("VNC 协议版本公告无效".into());
    }
    let minor = (banner[8] - b'0') as u16 * 100
        + (banner[9] - b'0') as u16 * 10
        + (banner[10] - b'0') as u16;
    match minor {
        0..=2 => Err("不支持低于 RFB 3.3 的协议".into()),
        3..=6 => Ok(*b"RFB 003.003\n"),
        7 => Ok(*b"RFB 003.007\n"),
        _ => Ok(*b"RFB 003.008\n"),
    }
}

/// 读取有界远端失败说明，仅返回移除控制字符的文本，不自动重试认证。
///
/// # 参数
/// - `stream`：正在等待长度前缀失败说明的独占连接。
///
/// # Errors
/// 长度超限或连接截断返回本地错误，不分配超过四 KiB 的缓冲。
async fn read_reason(stream: &mut TcpStream) -> Result<String, String> {
    let length = stream
        .read_u32()
        .await
        .map_err(|error| format!("读取 VNC 拒绝说明失败：{error}"))? as usize;
    if length > MAX_REASON_BYTES {
        return Err("VNC 拒绝说明过长".into());
    }
    let mut bytes = vec![0; length];
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|error| format!("读取 VNC 拒绝说明失败：{error}"))?;
    let reason: String = String::from_utf8_lossy(&bytes)
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    Ok(if reason.is_empty() {
        "VNC 服务端拒绝认证或连接".into()
    } else {
        format!("VNC 服务端拒绝：{reason}")
    })
}
