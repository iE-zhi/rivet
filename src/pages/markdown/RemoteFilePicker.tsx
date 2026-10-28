/** Markdown 的自绘 SFTP 文件/文件夹选择器；只复用已连接 SSH，不读取或保存服务器凭据。 */
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, Input, Select, SvgIcon, VerticalScrollbar, useNotification } from "../../components/ui";
import { listRemoteDirectory, openRemote, type RemoteMarkdownDirectory } from "./api";
import { isMarkdownPath, type MarkdownFile, type RemoteMarkdownSession, type RemoteMarkdownTarget } from "./model";

/** 选择器不拥有连接，关闭只取消前端接收，不关闭底层 SSH。 */
interface RemoteFilePickerProps {
  /** 当前可用 SSH 身份，断线后由终端页移除。 */
  sessions: RemoteMarkdownSession[];
  zh: boolean;
  /** 默认选择文件；folder 模式只浏览目录，确认后返回当前目录快照。 */
  mode?: "file" | "folder";
  /** 文件交给工作区；拒绝接收时选择器保留，错误发到应用通知。 */
  onOpened: (file: MarkdownFile, target: RemoteMarkdownTarget) => void;
  /** folder 模式的接收方；为空时禁止确认，目录与 SSH 身份一起提交。 */
  onFolderOpened?: (directory: RemoteMarkdownDirectory, session: RemoteMarkdownSession) => void;
  /** 收起选择器并释放焦点与事件监听。 */
  onClose: () => void;
  /** 没有连接时前往终端建立 SSH。 */
  onConnect: () => void;
}

/** 浏览服务器并选择文件或目录；所有迟到结果按请求代次丢弃，避免串服或关闭后接收结果。 */
export default function RemoteFilePicker({ sessions, zh, mode = "file", onOpened, onFolderOpened, onClose, onConnect }: RemoteFilePickerProps) {
  /** 选择目标在一次挂载期间固定，文件夹模式不提供文件打开动作。 */
  const folderMode = mode === "folder";
  const [sessionId, setSessionId] = useState(sessions[0]?.sessionId ?? "");
  const selected = sessions.find(/** 断开的会话不可再被选择；有其他连接时回退第一项。 */ (session) => session.sessionId === sessionId) ?? sessions[0] ?? null;
  const currentSessionId = selected?.sessionId ?? "";
  /** 目录结果附带其所属会话，切换服务器时不会短暂显示旧服务器的可点击条目。 */
  const [directory, setDirectory] = useState<(RemoteMarkdownDirectory & { sessionId: string }) | null>(null);
  const [pathInput, setPathInput] = useState(".");
  const [busy, setBusy] = useState(false);
  const { notify } = useNotification();
  /** 每次目录/文件读取或关闭递增；旧请求不能覆盖新会话或重新打开工作区。 */
  const sequence = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);

  /** 读取指定会话目录；失败保留原目录，只有当前代次可以更新加载状态。 */
  const loadDirectory = useCallback(async (path: string) => {
    const request = ++sequence.current;
    if (!currentSessionId) { setDirectory(null); setBusy(false); return; }
    setBusy(true);
    try {
      const result = await listRemoteDirectory(currentSessionId, path || ".");
      if (request !== sequence.current) return;
      setDirectory({ ...result, sessionId: currentSessionId });
      setPathInput(result.path);
    } catch (error) {
      if (request === sequence.current) notify({ kind: "error", message: String(error) });
    } finally { if (request === sequence.current) setBusy(false); }
  }, [currentSessionId, notify]);

  /** 切换服务器后从其默认目录开始；卸载提交时立即让旧读取失效，不能在关闭后打开文件。 */
  useLayoutEffect(() => {
    setPathInput(".");
    void loadDirectory(".");
    return () => { sequence.current += 1; };
  }, [loadDirectory]);

  /** 挂载时进入对话框，关闭后回到原文件控件，不保留对 DOM 的借用。 */
  useLayoutEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  /** 读取已选择服务器的普通 Markdown；连接切换或选择器关闭后忽略迟到正文。 */
  const openFile = async (path: string) => {
    if (!selected || busy || directory?.sessionId !== selected.sessionId) return;
    const request = ++sequence.current;
    const target = { ...selected, path };
    setBusy(true);
    try {
      const file = await openRemote(target);
      if (request === sequence.current) onOpened(file, { ...target, path: file.path });
    } catch (error) { if (request === sequence.current) notify({ kind: "error", message: String(error) }); }
    finally { if (request === sequence.current) setBusy(false); }
  };

  /** Escape 关闭，Tab 限制在当前对话框，文件读取可在关闭后安全丢弃结果。 */
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
  };

  const currentDirectory = directory?.sessionId === currentSessionId ? directory : null;
  const entries = currentDirectory?.entries.filter(/** 文件夹模式只显示可进入的目录；文件模式另放行普通 Markdown，链接和设备不可选。 */ (entry) => entry.kind === "directory" || (!folderMode && entry.kind === "file" && isMarkdownPath(entry.path))) ?? [];

  /** 只接受当前会话已成功读取且与路径输入一致的目录；失败保留选择器并通知。 */
  const chooseFolder = () => {
    if (busy || !currentDirectory || pathInput !== currentDirectory.path || !selected || !onFolderOpened) return;
    try { onFolderOpened({ path: currentDirectory.path, entries: currentDirectory.entries }, selected); }
    catch (error) { notify({ kind: "error", message: error instanceof Error ? error.message : String(error) }); }
  };

  return <div className="markdown-remote-backdrop" onContextMenu={/** 选择器内不弹出原生菜单或背后的文件菜单。 */ (event) => { event.preventDefault(); event.stopPropagation(); }} onPointerDown={/** 点击空白只关闭选择器，不影响已连接会话。 */ (event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className={`markdown-remote-dialog${selected ? "" : " is-empty"}`} role="dialog" aria-modal="true" aria-labelledby="markdown-remote-title" tabIndex={-1} onKeyDown={keyDown}>
      <header><strong id="markdown-remote-title">{folderMode ? (zh ? "打开远程文件夹" : "Open remote folder") : (zh ? "打开远程文件" : "Open remote file")}</strong><button type="button" aria-label={folderMode ? (zh ? "关闭远程文件夹选择器" : "Close remote folder picker") : (zh ? "关闭远程文件选择器" : "Close remote file picker")} onClick={onClose}><SvgIcon name="close" size={14} /></button></header>
      {!selected ? <div className="markdown-remote-empty"><span>{zh ? "请先连接 SSH 服务器" : "Connect to an SSH server first"}</span><Button variant="secondary" onClick={onConnect}>{zh ? "前往终端连接" : "Connect in Terminal"}</Button></div> : <>
        <div className="markdown-remote-server"><Select ariaLabel={zh ? "SSH 会话" : "SSH session"} value={currentSessionId} disabled={busy} options={sessions.map(/** 只展示身份快照中的服务器名称。 */ (session) => ({ value: session.sessionId, label: session.sessionName }))} onChange={/** 新会话结果返回前旧目录不可操作。 */ (value) => { setDirectory(null); setSessionId(value); }} /></div>
        <form className="markdown-remote-path" onSubmit={/** 用户可以直接输入服务器目录，路径不经 Shell。 */ (event) => { event.preventDefault(); void loadDirectory(pathInput); }}>
          <button type="button" disabled={busy || !currentDirectory} aria-label={zh ? "上一级" : "Parent directory"} onClick={/** 由 SFTP 规范化父目录，根目录继续保持在根。 */ () => void loadDirectory(`${currentDirectory?.path ?? "."}/..`)}><SvgIcon name="back" size={15} /></button>
          <Input aria-label={zh ? "远端目录" : "Remote directory"} value={pathInput} maxLength={4096} disabled={busy} onChange={/** 编辑中的路径不改变当前列表。 */ (event) => setPathInput(event.currentTarget.value)} />
          <button type="submit" disabled={busy} aria-label={zh ? "读取目录" : "Read directory"}><SvgIcon name="refresh" size={15} /></button>
        </form>
        <VerticalScrollbar className="markdown-remote-list" height="100%" viewportLabel={zh ? "远程文件" : "Remote files"}>
          {busy ? <div className="markdown-remote-empty">{zh ? "正在读取…" : "Loading…"}</div> : !currentDirectory ? null : !entries.length ? <div className="markdown-remote-empty">{folderMode ? (zh ? "没有子文件夹" : "No subfolders") : (zh ? "此目录没有 Markdown 文件或子目录" : "No Markdown files or subdirectories")}</div> : entries.map(/** 点击目录继续浏览，点击 Markdown 读取正文后交给工作区。 */ (entry) => <button key={entry.path} type="button" className="markdown-remote-entry" disabled={!currentDirectory} title={entry.path} onClick={/** 根据服务器类型选择浏览或读取，均绑定当前会话。 */ () => { if (entry.kind === "directory") void loadDirectory(entry.path); else void openFile(entry.path); }}><SvgIcon name={entry.kind === "directory" ? "folder" : "markdown"} size={16} /><span>{entry.name}</span>{entry.kind === "directory" && <SvgIcon name="chevron" size={12} />}</button>)}
        </VerticalScrollbar>
        {folderMode && <footer className="markdown-remote-footer"><Button disabled={busy || !currentDirectory || pathInput !== currentDirectory.path || !onFolderOpened} onClick={chooseFolder}>{zh ? "打开此文件夹" : "Open this folder"}</Button></footer>}
      </>}
    </div>
  </div>;
}
