//! VNC 的系统纯文本剪贴板边界。只对当前键盘焦点所属的会话执行操作。

use std::sync::{Arc, Mutex};

/// 查询一次原生窗口焦点的回调；由界面层提供，工作线程可调用。
pub(crate) type WindowFocus = Box<dyn Fn() -> Result<bool, String> + Send + Sync>;

/// 应用内唯一的剪贴板桥。焦点切换时撤销旧会话资格，系统对象跨操作保留。
#[derive(Default)]
pub(crate) struct SystemClipboard {
    /// 当前键盘捕获视图及其所属窗口。更新焦点时不调用系统剪贴板。
    target: Mutex<Option<Arc<ClipboardTarget>>>,
    /// 串行访问系统剪贴板，Linux 下同时维持已经复制的内容所有权。
    native: Mutex<Option<arboard::Clipboard>>,
}

/// 一次焦点任期。每次重新激活生成新实例，过期任务不能借用新焦点。
struct ClipboardTarget {
    /// 当前会话 ID，注销时释放。
    session_id: String,
    /// 执行时复核原生窗口焦点，只查询该次任期的窗口。
    has_focus: WindowFocus,
}

impl SystemClipboard {
    /// 激活当前会话，或仅清除指定会话仍持有的焦点。
    ///
    /// # 参数
    /// - `session_id`：已注册的 VNC 会话 ID。
    /// - `has_focus`：Some 表示键盘捕获获得焦点，None 表示焦点已离开。
    /// # Errors
    /// 焦点锁损坏时返回错误，不变更系统剪贴板。
    pub(crate) fn set_target(
        &self,
        session_id: &str,
        has_focus: Option<WindowFocus>,
    ) -> Result<(), String> {
        let mut target = self.target.lock().map_err(|_| "VNC 剪贴板焦点锁已损坏")?;
        if let Some(has_focus) = has_focus {
            *target = Some(Arc::new(ClipboardTarget {
                session_id: session_id.to_owned(),
                has_focus,
            }));
        } else if target
            .as_ref()
            .is_some_and(|target| target.session_id == session_id)
        {
            *target = None;
        }
        Ok(())
    }

    /// 在正常粘贴按键前读取系统文本；文件、图像、无焦点或空剪贴板返回 None。
    ///
    /// # 参数
    /// - `session_id`：本次按键所属会话。
    /// # Errors
    /// 系统访问或任务失败时返回错误，调用方仍可发送原始按键。
    pub(crate) async fn read(self: &Arc<Self>, session_id: &str) -> Result<Option<String>, String> {
        // clipboard 仅由当前阻塞任务独占；没有纯文本时让远端按原方式粘贴。
        self.with_clipboard(session_id, |clipboard| match clipboard.get_text() {
            Ok(text) => Ok(Some(text)),
            Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(error) => Err(error),
        })
        .await
        .map(Option::flatten)
    }

    /// 把远端已验证的纯文本写入仍有焦点的系统剪贴板。
    ///
    /// # 参数
    /// - `session_id`：远端文本所属会话。
    /// - `text`：交给系统剪贴板的 UTF-8 文本，不持久化。
    /// # Errors
    /// 系统访问或任务失败时返回错误，不重试旧文本。
    pub(crate) async fn write(
        self: &Arc<Self>,
        session_id: &str,
        text: String,
    ) -> Result<(), String> {
        // clipboard 仅在此操作期间借用；text 所有权交给系统实现。
        self.with_clipboard(session_id, move |clipboard| clipboard.set_text(text))
            .await
            .map(|_| ())
    }

    /// 将可能阻塞的系统调用交给工作线程；每次执行前重新验证焦点任期。
    ///
    /// # 参数
    /// - `session_id`：目标会话 ID，仅借用至取得当前任期。
    /// - `operation`：本次唯一操作，在系统锁内调用并移交其结果。
    /// # Errors
    /// 锁、窗口查询或系统剪贴板错误向调用方传播；失焦时返回 None。
    async fn with_clipboard<T: Send + 'static>(
        self: &Arc<Self>,
        session_id: &str,
        operation: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error> + Send + 'static,
    ) -> Result<Option<T>, String> {
        let target = self
            .target
            .lock()
            .map_err(|_| "VNC 剪贴板焦点锁已损坏")?
            .as_ref()
            .filter(|target| target.session_id == session_id)
            .cloned();
        let Some(target) = target else {
            return Ok(None);
        };
        let bridge = Arc::clone(self);
        // bridge、target 和 operation 归工作线程；调用方只等待本次操作，锁不跨 await。
        tauri::async_runtime::spawn_blocking(move || {
            let mut native = bridge.native.lock().map_err(|_| "VNC 系统剪贴板锁已损坏")?;
            if !(target.has_focus)()? {
                return Ok(None);
            }
            if native.is_none() {
                *native = Some(arboard::Clipboard::new().map_err(|error| error.to_string())?);
            }
            // 不在系统调用期间保留焦点锁，避免与窗口线程互相等待。
            if !bridge.matches_target(&target)? {
                return Ok(None);
            }
            let clipboard = native.as_mut().ok_or("VNC 系统剪贴板不可用")?;
            let result = operation(clipboard).map_err(|error| error.to_string())?;
            // 若读取期间切换了会话，不把已读到的本机内容交给旧会话。
            Ok(bridge.matches_target(&target)?.then_some(result))
        })
        .await
        .map_err(|error| error.to_string())?
    }

    /// 比较当前焦点任期，锁只覆盖指针比较；损坏时停止访问。
    ///
    /// # 参数
    /// - `target`：阻塞任务开始时取得的焦点快照。
    fn matches_target(&self, target: &Arc<ClipboardTarget>) -> Result<bool, String> {
        let current = self.target.lock().map_err(|_| "VNC 剪贴板焦点锁已损坏")?;
        Ok(current
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, target)))
    }
}
