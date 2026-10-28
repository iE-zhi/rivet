//! VNC 桌面缓冲与二进制增量快照；每个会话独占缓冲，不访问 SSH 或系统桌面。

use vnc::Rect;

/// 单个桌面最多容纳 4K 像素，RGBA 内存上限约 32 MiB。
pub(crate) const MAX_PIXELS: usize = 8_294_400;
/// 单边最大像素数，与协议引擎的尺寸限制一致。
pub(crate) const MAX_DIMENSION: u16 = 8192;
/// IPC 快照头长度，后接紧密排列的 RGBA 或 UTF-8 错误消息。
pub(crate) const FRAME_HEADER_BYTES: usize = 16;
/// 每个像素使用红、绿、蓝和不透明度四个字节。
const PIXEL_BYTES: usize = 4;

/// 会话内最新桌面；由服务层互斥锁保护，快照只消费脏区，不丢弃像素。
#[derive(Default)]
pub(crate) struct VncFrame {
    /// 当前远端桌面宽度，初始为零。
    pub(crate) width: u16,
    /// 当前远端桌面高度，初始为零。
    pub(crate) height: u16,
    /// 0 连接中、1 已连接、2 已关闭、3 错误；通过快照头传给前端。
    pub(crate) state: u8,
    /// 错误时向用户显示的消息，不含本机凭据。
    pub(crate) error: String,
    /// 行优先 RGBA 像素，尺寸变化时替换。
    pixels: Vec<u8>,
    /// 自上次快照以来变化区域的并集；None 表示无图像变化。
    dirty: Option<Rect>,
}

impl VncFrame {
    /// 分配受限桌面；相同尺寸保留像素，非法尺寸不会改变当前缓冲。
    ///
    /// # 参数
    /// - `width`：远端桌面宽度，单位像素，范围 1..=8192。
    /// - `height`：远端桌面高度，单位像素；总像素数不得超过 MAX_PIXELS。
    ///
    /// # Errors
    /// 零尺寸、超限或分配失败时返回错误，调用方应终止该会话。
    pub(crate) fn resize(&mut self, width: u16, height: u16) -> Result<(), String> {
        let count = usize::from(width) * usize::from(height);
        if width == 0
            || height == 0
            || width > MAX_DIMENSION
            || height > MAX_DIMENSION
            || count > MAX_PIXELS
        {
            return Err("VNC 桌面尺寸超过限制".into());
        }
        if self.width == width && self.height == height {
            return Ok(());
        }
        let mut pixels = Vec::new();
        pixels
            .try_reserve_exact(count * PIXEL_BYTES)
            .map_err(|_| "无法分配 VNC 桌面内存")?;
        pixels.resize(count * PIXEL_BYTES, 0);
        for pixel in pixels.as_chunks_mut::<PIXEL_BYTES>().0 {
            pixel[3] = u8::MAX;
        }
        self.pixels = pixels;
        self.width = width;
        self.height = height;
        self.dirty = Some(Rect {
            x: 0,
            y: 0,
            width,
            height,
        });
        Ok(())
    }

    /// 检查矩形完全位于当前桌面内，拒绝空矩形和越界网络数据。
    ///
    /// # 参数
    /// - `rect`：只读的远端像素区域，本函数不保存该借用。
    ///
    /// # Errors
    /// 无效区域返回错误且不修改像素。
    fn validate_rect(&self, rect: &Rect) -> Result<(), String> {
        if rect.width == 0
            || rect.height == 0
            || u32::from(rect.x) + u32::from(rect.width) > u32::from(self.width)
            || u32::from(rect.y) + u32::from(rect.height) > u32::from(self.height)
        {
            return Err("VNC 图像区域无效".into());
        }
        Ok(())
    }

    /// 合并有效的脏矩形；只保存区域边界，内存不会随更新次数增长。
    ///
    /// # 参数
    /// - `rect`：已通过边界校验的变化区域，按值保存其并集。
    fn mark_dirty(&mut self, rect: Rect) {
        self.dirty = Some(match self.dirty {
            None => rect,
            Some(previous) => {
                let x = previous.x.min(rect.x);
                let y = previous.y.min(rect.y);
                let right = (previous.x + previous.width).max(rect.x + rect.width);
                let bottom = (previous.y + previous.height).max(rect.y + rect.height);
                Rect {
                    x,
                    y,
                    width: right - x,
                    height: bottom - y,
                }
            }
        });
    }

    /// 写入协议引擎解码的 RGBA 区域，并将未使用的 alpha 字节设为不透明。
    ///
    /// # 参数
    /// - `rect`：远端变化区域，必须完全位于当前桌面内。
    /// - `data`：行优先像素；长度必须等于区域像素数乘四，借用仅本次有效。
    ///
    /// # Errors
    /// 区域或长度无效时返回错误，原缓冲不变。
    pub(crate) fn draw(&mut self, rect: Rect, data: &[u8]) -> Result<(), String> {
        self.validate_rect(&rect)?;
        let row_bytes = usize::from(rect.width) * PIXEL_BYTES;
        if data.len() != row_bytes * usize::from(rect.height) {
            return Err("VNC 像素长度无效".into());
        }
        for row in 0..usize::from(rect.height) {
            let start = ((usize::from(rect.y) + row) * usize::from(self.width)
                + usize::from(rect.x))
                * PIXEL_BYTES;
            let target = &mut self.pixels[start..start + row_bytes];
            target.copy_from_slice(&data[row * row_bytes..(row + 1) * row_bytes]);
            for pixel in target.as_chunks_mut::<PIXEL_BYTES>().0 {
                pixel[3] = u8::MAX;
            }
        }
        self.mark_dirty(rect);
        Ok(())
    }

    /// 在桌面内复制区域；按重叠方向逐行移动，不分配第二张完整图像。
    ///
    /// # 参数
    /// - `destination`：复制目标区域，必须与来源尺寸相同且不越界。
    /// - `source`：复制前的来源区域，允许与目标重叠。
    ///
    /// # Errors
    /// 尺寸或边界不符时不改变像素。
    pub(crate) fn copy(&mut self, destination: Rect, source: Rect) -> Result<(), String> {
        self.validate_rect(&destination)?;
        self.validate_rect(&source)?;
        if destination.width != source.width || destination.height != source.height {
            return Err("VNC 复制区域尺寸不一致".into());
        }
        let width = usize::from(self.width);
        let row_bytes = usize::from(source.width) * PIXEL_BYTES;
        for index in 0..usize::from(source.height) {
            let row = if destination.y > source.y {
                usize::from(source.height) - index - 1
            } else {
                index
            };
            let start =
                ((usize::from(source.y) + row) * width + usize::from(source.x)) * PIXEL_BYTES;
            let target = ((usize::from(destination.y) + row) * width + usize::from(destination.x))
                * PIXEL_BYTES;
            self.pixels.copy_within(start..start + row_bytes, target);
        }
        self.mark_dirty(destination);
        Ok(())
    }

    /// 返回并消费变化区域，使用小端 u16 头和原始 RGBA，避免像素 JSON/Base64 膨胀。
    ///
    /// 已关闭与错误状态保留至服务释放；每次最多复制一张受限桌面。
    ///
    /// # 参数
    /// - `full`：true 返回完整当前桌面，供新挂载或恢复显示的消费者重建 Canvas。
    pub(crate) fn snapshot(&mut self, full: bool) -> Vec<u8> {
        let mut bytes = vec![0; FRAME_HEADER_BYTES];
        bytes[0..2].copy_from_slice(&self.width.to_le_bytes());
        bytes[2..4].copy_from_slice(&self.height.to_le_bytes());
        bytes[12] = self.state;
        if self.state == 3 {
            bytes.extend_from_slice(self.error.as_bytes());
            return bytes;
        }
        if full && self.width > 0 && self.height > 0 {
            self.dirty = Some(Rect {
                x: 0,
                y: 0,
                width: self.width,
                height: self.height,
            });
        }
        if let Some(rect) = self.dirty.take() {
            for (offset, value) in [(4, rect.x), (6, rect.y), (8, rect.width), (10, rect.height)] {
                bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
            }
            let row_bytes = usize::from(rect.width) * PIXEL_BYTES;
            bytes.reserve(row_bytes * usize::from(rect.height));
            for row in 0..usize::from(rect.height) {
                let start = ((usize::from(rect.y) + row) * usize::from(self.width)
                    + usize::from(rect.x))
                    * PIXEL_BYTES;
                bytes.extend_from_slice(&self.pixels[start..start + row_bytes]);
            }
        }
        bytes
    }
}
