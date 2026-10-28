//! VNC TCP 连接与认证策略边界：显式选择密码或无认证，不允许自动降级。

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

/// 已完成版本协商的 TCP 流；向协议引擎重放协商头，随后直接转交网络 I/O。
/// 独占 socket，丢弃时关闭；不保留凭据，也不生成后台任务。
pub(crate) struct VncTransport {
    /// 会话独占的已连接 TCP socket。
    stream: TcpStream,
    /// 已校验的版本与单一允许认证类型，最多十八字节。
    prefix: Vec<u8>,
    /// 重放头已读取的字节数，不超过 prefix.len()。
    read_offset: usize,
    /// 协议引擎版本写入已消费的字节数，范围 0..=12。
    write_offset: usize,
}

impl VncTransport {
    /// 读取有限的版本与认证头，仅向引擎提供调用方允许的认证方式。
    ///
    /// # 参数
    /// - `stream`：转移所有权的 TCP socket；失败或取消时自动关闭。
    /// - `password_auth`：true 必须使用 VNC 密码，false 必须显式使用无认证。
    ///
    /// # Errors
    /// 网络、非法版本、认证方式不匹配均返回错误；超时和取消由调用方包围整个握手。
    pub(crate) async fn negotiate(
        mut stream: TcpStream,
        password_auth: bool,
    ) -> Result<Self, String> {
        let mut banner = [0; VERSION_BYTES];
        stream
            .read_exact(&mut banner)
            .await
            .map_err(|error| format!("读取 VNC 版本失败：{error}"))?;
        let version = match &banner {
            b"RFB 003.003\n" => *b"RFB 003.003\n",
            b"RFB 003.007\n" => *b"RFB 003.007\n",
            b"RFB 003.008\n" => *b"RFB 003.008\n",
            _ => return Err("不支持此 VNC 协议版本（支持 RFB 3.3/3.7/3.8）".into()),
        };
        stream
            .write_all(&version)
            .await
            .map_err(|error| format!("发送 VNC 版本失败：{error}"))?;
        // RFB 安全类型：1 为无认证，2 为传统 VNC 密码。禁止替用户改变认证要求。
        let selected = if password_auth { 2 } else { 1 };
        let mut prefix = version.to_vec();
        if &version == b"RFB 003.003\n" {
            let security = stream
                .read_u32()
                .await
                .map_err(|error| format!("读取 VNC 认证方式失败：{error}"))?;
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
                return Err("VNC 服务端拒绝连接".into());
            }
            let mut methods = vec![0; usize::from(count)];
            stream
                .read_exact(&mut methods)
                .await
                .map_err(|error| format!("读取 VNC 认证列表失败：{error}"))?;
            if !methods.contains(&selected) {
                return Err("服务端不支持所选认证方式（当前支持 VNC 密码或无认证）".into());
            }
            prefix.extend_from_slice(&[1, selected]);
        }
        Ok(Self {
            stream,
            prefix,
            read_offset: 0,
            write_offset: 0,
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
        if this.write_offset < VERSION_BYTES {
            let count = buf.len().min(VERSION_BYTES - this.write_offset);
            if buf[..count] != this.prefix[this.write_offset..this.write_offset + count] {
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
