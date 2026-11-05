//! RFB 文本剪贴板协商及编解码。每个连接独占一份状态，不访问系统剪贴板。

use crate::X11Event;
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use std::io::{Read, Write};

/// 单条文本的 UTF-8 上限，单位字节。
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
/// 换行转为 CRLF 后最长两 MiB，另留终止符、压缩和消息头空间。
pub(crate) const MAX_PACKET_BYTES: usize = MAX_TEXT_BYTES * 2 + 64 * 1024;
/// 低十六位标识内容格式，本客户端只协商最低位的 UTF-8 文本。
const FORMATS: u32 = 0xffff;
/// 扩展消息的 UTF-8 文本格式标志。
const TEXT: u32 = 1;
/// 能力协商标志，可与多个动作位同时出现。
const CAPS: u32 = 1 << 24;
/// 请求当前剪贴板中的指定格式。
const REQUEST: u32 = 1 << 25;
/// 查询当前剪贴板有哪些格式。
const PEEK: u32 = 1 << 26;
/// 通知对端当前剪贴板的格式。
const NOTIFY: u32 = 1 << 27;
/// 提供压缩后的剪贴板内容。
const PROVIDE: u32 = 1 << 28;

/// 一条已校验消息对远端剪贴板缓存及协议写入的影响，内容只在会话中短暂使用。
#[derive(Default)]
pub struct ClipboardUpdate {
    /// 最新的非空纯文本；未收到可复制的文本时为 None。
    pub remote: Option<String>,
    /// 需要按顺序发送的剪贴板响应，无响应为 None。
    pub reply: Option<X11Event>,
}

/// 单个协议任务拥有的剪贴板状态；对端只能请求用户已经明确发送的文本。
#[derive(Default)]
pub struct Clipboard {
    /// 对端公布的格式和动作位，零表示尚未协商。
    peer: u32,
    /// 对端接受主动提供文本的最大字节数，包含 CRLF 与结尾 NUL。
    unsolicited_limit: usize,
    /// 用户已发往当前会话的 UTF-8 文本，对端宣布新内容时清除。
    offered: Option<String>,
}

impl Clipboard {
    /// 选择扩展协议或经典 Latin-1。只有编码成功后才替换当前已授权的文本。
    ///
    /// # 参数
    /// - `text`：用户明确发送的文本，移交所有权，UTF-8 最多一 MiB。
    /// # Errors
    /// 超限、含 NUL、旧服务端无法接收字符或压缩失败时返回错误，不改变先前内容。
    pub fn offer(&mut self, text: String) -> Result<X11Event, &'static str> {
        let text = validate_text(text)?;
        if self.peer & (TEXT | PROVIDE) == TEXT | PROVIDE {
            let wire_size = text.len() + text.bytes().filter(|&byte| byte == b'\n').count() + 1;
            let event = if wire_size <= self.unsolicited_limit {
                encode_text(&text)?
            } else if self.peer & NOTIFY != 0 {
                flags_message(NOTIFY | TEXT)
            } else {
                let event = legacy_text(text)?;
                self.offered = None;
                return Ok(event);
            };
            self.offered = Some(text);
            return Ok(event);
        }
        let event = legacy_text(text)?;
        self.offered = None;
        Ok(event)
    }

    /// 接收经典剪贴板文本，撤销当前会话向远端提供的旧内容。
    ///
    /// # 参数
    /// - `text`：引擎从 Latin-1 转换出的 UTF-8 文本，移交所有权。
    /// # Errors
    /// 无效文本不会替换现有内容。
    pub fn receive_legacy(&mut self, text: String) -> Result<ClipboardUpdate, &'static str> {
        Ok(self.receive_text(validate_text(text)?))
    }

    /// 处理一条已完成网络读取的扩展消息；只有文本格式会被解压或提供。
    ///
    /// # 参数
    /// - `packet`：有界的只读扩展载荷，借用仅在本次解析期间有效。
    /// # Errors
    /// 长度、压缩数据或文本不合法时拒绝消息，调用方可继续接收画面。
    pub fn receive(&mut self, packet: &[u8]) -> Result<ClipboardUpdate, &'static str> {
        let (flags, data) = packet
            .split_first_chunk::<4>()
            .ok_or("剪贴板消息缺少标志")?;
        let flags = u32::from_be_bytes(*flags);
        let formats = flags & FORMATS;
        let mut update = ClipboardUpdate::default();
        if flags & CAPS != 0 {
            if data.len() != formats.count_ones() as usize * 4 {
                return Err("剪贴板能力长度无效");
            }
            self.peer = flags;
            // 文本是最低位格式；主动上传上限为零时由对端先通知，本地再请求文本。
            self.unsolicited_limit = if formats & TEXT == 0 {
                0
            } else {
                u32::from_be_bytes(data[..4].try_into().map_err(|_| "剪贴板能力长度无效")?) as usize
            };
            let mut reply = (CAPS | TEXT | REQUEST | PEEK | NOTIFY | PROVIDE)
                .to_be_bytes()
                .to_vec();
            reply.extend_from_slice(&0u32.to_be_bytes());
            update.reply = Some(X11Event::ExtendedClipboard(reply));
            return Ok(update);
        }
        // 未交换能力之前不回传内容，避免将用户文本交给未协商的扩展。
        if self.peer & CAPS == 0 {
            return Ok(update);
        }
        let action = flags & (REQUEST | PEEK | NOTIFY | PROVIDE);
        if action != PROVIDE && !data.is_empty() {
            return Err("剪贴板控制消息包含多余载荷");
        }
        match action {
            NOTIFY => {
                self.offered = None;
                if formats & TEXT != 0 && self.peer & REQUEST != 0 {
                    update.reply = Some(flags_message(REQUEST | TEXT));
                }
            }
            REQUEST if formats & TEXT != 0 && self.peer & PROVIDE != 0 => {
                if let Some(text) = &self.offered {
                    update.reply = Some(encode_text(text)?);
                }
            }
            PEEK if self.peer & NOTIFY != 0 => {
                let formats = if self.offered.is_some() { TEXT } else { 0 };
                update.reply = Some(flags_message(NOTIFY | formats));
            }
            PROVIDE if formats & TEXT != 0 => return Ok(self.receive_text(decode_text(data)?)),
            _ => {}
        }
        Ok(update)
    }

    /// 用已校验的对端文本替换缓存并撤销旧的本地授权。
    ///
    /// # 参数
    /// - `text`：移动到响应的最新对端文本，空字符串表示清空。
    fn receive_text(&mut self, text: String) -> ClipboardUpdate {
        self.offered = None;
        ClipboardUpdate {
            remote: (!text.is_empty()).then_some(text),
            reply: None,
        }
    }
}

/// 检查长度和 NUL，并统一成 LF；拒绝不能完整写入系统剪贴板的文本。
///
/// # 参数
/// - `text`：移交所有权的 UTF-8 文本，允许空字符串。
fn validate_text(text: String) -> Result<String, &'static str> {
    if text.len() > MAX_TEXT_BYTES || text.contains('\0') {
        return Err("剪贴板文本超过一 MiB 或包含 NUL");
    }
    if text.contains('\r') {
        return Ok(text.replace("\r\n", "\n").replace('\r', "\n"));
    }
    Ok(text)
}

/// 选择经典消息，遇到 Latin-1 之外的字符时拒绝，避免复制出损坏文本。
///
/// # 参数
/// - `text`：已校验、使用 LF 的 UTF-8 文本。
fn legacy_text(text: String) -> Result<X11Event, &'static str> {
    if text.chars().any(|character| u32::from(character) > 255) {
        return Err("服务端只支持经典剪贴板，无法传输这段 Unicode 文本");
    }
    Ok(X11Event::CopyText(text))
}

/// 编码仅含标志的剪贴板控制消息。
///
/// # 参数
/// - `flags`：网络协议的动作位及可选文本格式位。
fn flags_message(flags: u32) -> X11Event {
    X11Event::ExtendedClipboard(flags.to_be_bytes().to_vec())
}

/// 编码 UTF-8 文本，按扩展协议加入 CRLF、NUL 和压缩后的长度字段。
///
/// # 参数
/// - `text`：已通过长度与 NUL 校验的 LF 文本，借用不保存。
/// # Errors
/// 压缩失败时不产生网络消息。
fn encode_text(text: &str) -> Result<X11Event, &'static str> {
    let text = text.replace('\n', "\r\n");
    let prefix = (PROVIDE | TEXT).to_be_bytes().to_vec();
    let mut writer = ZlibEncoder::new(prefix, Compression::fast());
    writer
        .write_all(&((text.len() + 1) as u32).to_be_bytes())
        .and_then(|_| writer.write_all(text.as_bytes()))
        .and_then(|_| writer.write_all(&[0]))
        .map_err(|_| "压缩剪贴板文本失败")?;
    writer
        .finish()
        .map(X11Event::ExtendedClipboard)
        .map_err(|_| "压缩剪贴板文本失败")
}

/// 读取扩展剪贴板的第一种格式（文本）；校验压缩内声明的长度后才分配。
///
/// # 参数
/// - `data`：有界的 zlib 载荷，可能还有其他格式；仅读取声明的文本字节。
/// # Errors
/// 长度、终止符、UTF-8 或压缩输入无效时返回错误。
fn decode_text(data: &[u8]) -> Result<String, &'static str> {
    let mut reader = ZlibDecoder::new(data);
    let mut length = [0; 4];
    reader
        .read_exact(&mut length)
        .map_err(|_| "剪贴板缺少文本长度")?;
    let length = u32::from_be_bytes(length) as usize;
    if !(1..=MAX_TEXT_BYTES * 2 + 1).contains(&length) {
        return Err("剪贴板文本长度超限");
    }
    let mut bytes = vec![0; length];
    reader
        .read_exact(&mut bytes)
        .map_err(|_| "解压剪贴板文本失败")?;
    if bytes.pop() != Some(0) {
        return Err("剪贴板文本缺少终止符");
    }
    let text = String::from_utf8(bytes).map_err(|_| "剪贴板文本不是 UTF-8")?;
    // 长度限制以归一化后的 UTF-8 为准，允许线上包含额外的 CRLF 字节。
    validate_text(text.replace("\r\n", "\n"))
}
