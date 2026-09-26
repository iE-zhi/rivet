import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Input, SvgIcon, VerticalScrollbar, useNotification } from "../components/ui";
import type { Locale } from "./SerialPage";
import "./sftpPanel.css";

type SftpEntryKind = "directory" | "file" | "symlink" | "other";

interface SftpEntry {
  name: string;
  path: string;
  kind: SftpEntryKind;
  size: number;
  modified: number | null;
}

interface SftpDirectory {
  path: string;
  entries: SftpEntry[];
}

type SftpTransferDirection = "upload" | "download";
type SftpTransferStatus = "waiting" | "running" | "done" | "error";

interface SftpTransferProgressEvent {
  transferId: string;
  sessionId: string;
  direction: SftpTransferDirection;
  name: string;
  transferred: number;
  total: number;
}

interface SftpTransferTask extends SftpTransferProgressEvent {
  status: SftpTransferStatus;
  error?: string;
}

interface SftpPanelProps {
  open: boolean;
  sessionId: string | null;
  sessionName: string;
  locale: Locale;
  onClose: () => void;
}

const COPY = {
  zh: {
    sftp: "SFTP",
    path: "远端路径",
    parent: "上一级",
    upload: "上传文件",
    download: "下载",
    rename: "重命名",
    delete: "删除",
    cancel: "取消",
    save: "保存",
    name: "名称",
    size: "大小",
    actions: "操作",
    empty: "目录为空",
    loading: "正在读取…",
    unavailable: "请先选择已连接的 SSH 会话",
    listFailed: "读取 SFTP 目录失败：",
    uploadFailed: "上传失败：",
    uploadDone: "上传完成",
    downloadFailed: "下载失败：",
    downloadDone: "下载完成",
    renameFailed: "重命名失败：",
    renameDone: "重命名完成",
    deleteFailed: "删除失败：",
    deleteDone: "删除完成",
    renamePlaceholder: "新名称",
    dropUpload: "释放文件以上传到当前目录",
    uploadPreparing: "准备上传",
    transferError: "传输失败",
  },
  en: {
    sftp: "SFTP",
    path: "Remote path",
    parent: "Parent",
    upload: "Upload file",
    download: "Download",
    rename: "Rename",
    delete: "Delete",
    cancel: "Cancel",
    save: "Save",
    name: "Name",
    size: "Size",
    actions: "Actions",
    empty: "Directory is empty",
    loading: "Loading…",
    unavailable: "Select a connected SSH session first",
    listFailed: "Failed to read SFTP directory: ",
    uploadFailed: "Upload failed: ",
    uploadDone: "Upload complete",
    downloadFailed: "Download failed: ",
    downloadDone: "Download complete",
    renameFailed: "Rename failed: ",
    renameDone: "Rename complete",
    deleteFailed: "Delete failed: ",
    deleteDone: "Delete complete",
    renamePlaceholder: "New name",
    dropUpload: "Drop files to upload to this directory",
    uploadPreparing: "Preparing upload",
    transferError: "Transfer failed",
  },
} as const;

/** 将远端字节数格式化为紧凑文件大小。 */
function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return bytes === 0 ? "0 B" : "—";
  if (bytes < 1024) return `${Math.trunc(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[index]}`;
}

/** 创建前端传输任务标识。 */
function createTransferId(): string {
  if (typeof crypto.randomUUID === "function") return `sftp-${crypto.randomUUID()}`;
  const bytes = new Uint32Array(4);
  crypto.getRandomValues(bytes);
  return `sftp-${Array.from(bytes, (value) => value.toString(16)).join("")}`;
}

/** 从 Windows/Unix 本地路径提取显示文件名。 */
function localFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** 计算真实传输百分比；0 字节文件完成时显示 100%。 */
function transferPercent(task: SftpTransferTask): number {
  if (task.status === "done") return 100;
  if (task.total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((task.transferred / task.total) * 100)));
}

/** SFTP 文件浏览面板；所有操作复用当前 SSH 会话的独立 SFTP subsystem。 */
export default function SftpPanel({ open, sessionId, sessionName, locale, onClose }: SftpPanelProps) {
  const copy = COPY[locale];
  const { notify } = useNotification();
  const [path, setPath] = useState(".");
  const [pathInput, setPathInput] = useState(".");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const [deletePath, setDeletePath] = useState<string | null>(null);
  const [renamePath, setRenamePath] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [transfers, setTransfers] = useState<SftpTransferTask[]>([]);
  const [dragUploadActive, setDragUploadActive] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const transferTimersRef = useRef(new Map<string, number>());
  const requestSequenceRef = useRef(0);
  /** 仅在当前应用进程内按 SSH session 记忆最近访问目录；重连后的新 session 不继承。 */
  const lastPathBySessionRef = useRef(new Map<string, string>());

  /** 新建一个等待中的传输任务。 */
  const addTransfer = useCallback((
    id: string,
    taskSessionId: string,
    direction: SftpTransferDirection,
    name: string,
    total = 0,
  ) => {
    setTransfers((current) => [
      ...current.filter((task) => task.transferId !== id),
      {
        transferId: id,
        sessionId: taskSessionId,
        direction,
        name,
        transferred: 0,
        total,
        status: "waiting",
      },
    ]);
  }, []);

  /** 标记传输完成并短暂保留 100% 进度后自动移除。 */
  const completeTransfer = useCallback((transferId: string) => {
    setTransfers((current) =>
      current.map((task) =>
        task.transferId === transferId
          ? { ...task, transferred: task.total, status: "done" }
          : task,
      ),
    );
    const previous = transferTimersRef.current.get(transferId);
    if (previous !== undefined) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      transferTimersRef.current.delete(transferId);
      setTransfers((current) =>
        current.filter((task) => task.transferId !== transferId),
      );
    }, 1400);
    transferTimersRef.current.set(transferId, timer);
  }, []);

  /** 标记传输失败并短暂展示错误状态。 */
  const failTransfer = useCallback((transferId: string, error: unknown) => {
    setTransfers((current) =>
      current.map((task) =>
        task.transferId === transferId
          ? { ...task, status: "error", error: String(error) }
          : task,
      ),
    );
    const previous = transferTimersRef.current.get(transferId);
    if (previous !== undefined) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      transferTimersRef.current.delete(transferId);
      setTransfers((current) =>
        current.filter((task) => task.transferId !== transferId),
      );
    }, 3000);
    transferTimersRef.current.set(transferId, timer);
  }, []);

  const removeTransfer = useCallback((transferId: string) => {
    const timer = transferTimersRef.current.get(transferId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      transferTimersRef.current.delete(transferId);
    }
    setTransfers((current) =>
      current.filter((task) => task.transferId !== transferId),
    );
  }, []);

  /** 当前会话只显示正在运行或队首等待的一个传输进度，避免占满文件列表。 */
  const currentTransfer = useMemo(() => {
    if (!sessionId) return null;
    const sessionTransfers = transfers.filter((task) => task.sessionId === sessionId);
    return (
      sessionTransfers.find((task) => task.status === "running") ??
      sessionTransfers.find((task) => task.status === "waiting") ??
      sessionTransfers.at(-1) ??
      null
    );
  }, [sessionId, transfers]);

  /** 接收后端真实字节进度事件。 */
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<SftpTransferProgressEvent>("sftp:transfer-progress", (event) => {
      const progress = event.payload;
      setTransfers((current) => {
        const index = current.findIndex(
          (task) => task.transferId === progress.transferId,
        );
        if (index < 0) {
          return [
            ...current,
            { ...progress, status: "running" as const },
          ];
        }
        return current.map((task, taskIndex) =>
          taskIndex === index
            ? { ...task, ...progress, status: "running" as const, error: undefined }
            : task,
        );
      });
    }).then((disposeListener) => {
      if (disposed) disposeListener();
      else unlisten = disposeListener;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => () => {
    transferTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    transferTimersRef.current.clear();
  }, []);

  /** 读取目录并仅应用最后一次导航请求，防止慢响应覆盖新路径。 */
  const loadDirectory = useCallback(async (requestedPath: string) => {
    if (!sessionId) return;
    const sequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = sequence;
    setLoading(true);
    setMenuPath(null);
    setDeletePath(null);
    setRenamePath(null);
    try {
      const result = await invoke<SftpDirectory>("sftp_list", { sessionId, path: requestedPath });
      if (requestSequenceRef.current !== sequence) return;
      setPath(result.path);
      setPathInput(result.path);
      setEntries(result.entries);
      lastPathBySessionRef.current.set(sessionId, result.path);
    } catch (error) {
      if (requestSequenceRef.current !== sequence) return;
      notify({ kind: "error", message: `${copy.listFailed}${String(error)}` });
    } finally {
      if (requestSequenceRef.current === sequence) setLoading(false);
    }
  }, [copy.listFailed, notify, sessionId]);

  useEffect(() => {
    if (!open || !sessionId) return;
    const rememberedPath = lastPathBySessionRef.current.get(sessionId) ?? ".";
    setPath(rememberedPath);
    setPathInput(rememberedPath);
    setEntries([]);
    void loadDirectory(rememberedPath);
  }, [loadDirectory, open, sessionId]);

  useEffect(() => {
    if (!open) return;
    const closeMenus = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest(".sftp-row-actions")) {
        setMenuPath(null);
      }
    };
    document.addEventListener("pointerdown", closeMenus);
    return () => document.removeEventListener("pointerdown", closeMenus);
  }, [open]);

  /** 提交地址栏中的远端路径。 */
  const submitPath = (event: FormEvent) => {
    event.preventDefault();
    const requested = pathInput.trim();
    if (requested) void loadDirectory(requested);
  };

  /** 上传用户选择的本地文件，成功后刷新当前目录并显示真实进度。 */
  const uploadFile = async () => {
    if (!sessionId || loading || busyPath) return;
    const transferId = createTransferId();
    addTransfer(transferId, sessionId, "upload", copy.uploadPreparing);
    setBusyPath("__upload__");
    try {
      const result = await invoke<string | null>("sftp_upload_file", {
        sessionId,
        remoteDirectory: path,
        transferId,
      });
      if (result === null) {
        removeTransfer(transferId);
        return;
      }
      completeTransfer(transferId);
      notify({ kind: "success", message: copy.uploadDone });
      await loadDirectory(path);
    } catch (error) {
      failTransfer(transferId, error);
      notify({ kind: "error", message: `${copy.uploadFailed}${String(error)}` });
    } finally {
      setBusyPath(null);
    }
  };

  /** 批量上传系统拖入的本地文件；SFTP worker 顺序执行，进度按文件真实字节更新。 */
  const uploadDroppedPaths = useCallback(async (localPaths: string[]) => {
    if (!sessionId || loading || busyPath || localPaths.length === 0) return;

    const tasks = localPaths.map((localPath) => ({
      transferId: createTransferId(),
      localPath,
      name: localFileName(localPath),
    }));
    tasks.forEach((task) =>
      addTransfer(task.transferId, sessionId, "upload", task.name),
    );

    setBusyPath("__upload__");
    let uploaded = false;
    try {
      for (const task of tasks) {
        try {
          await invoke<string>("sftp_upload_path", {
            sessionId,
            remoteDirectory: path,
            localPath: task.localPath,
            transferId: task.transferId,
          });
          completeTransfer(task.transferId);
          uploaded = true;
        } catch (error) {
          failTransfer(task.transferId, error);
          notify({
            kind: "error",
            message: `${copy.uploadFailed}${task.name}: ${String(error)}`,
          });
        }
      }
      if (uploaded) {
        notify({ kind: "success", message: copy.uploadDone });
        await loadDirectory(path);
      }
    } finally {
      setBusyPath(null);
    }
  }, [
    addTransfer,
    busyPath,
    completeTransfer,
    copy.uploadDone,
    copy.uploadFailed,
    failTransfer,
    loadDirectory,
    loading,
    notify,
    path,
    sessionId,
  ]);

  /** 下载一个普通文件或符号链接目标，由原生保存对话框选择本地位置。 */
  const downloadFile = async (entry: SftpEntry) => {
    if (!sessionId || busyPath) return;
    const transferId = createTransferId();
    addTransfer(transferId, sessionId, "download", entry.name, entry.size);
    setBusyPath(entry.path);
    setMenuPath(null);
    try {
      const saved = await invoke<boolean>("sftp_download_file", {
        sessionId,
        remotePath: entry.path,
        transferId,
      });
      if (!saved) {
        removeTransfer(transferId);
        return;
      }
      completeTransfer(transferId);
      notify({ kind: "success", message: copy.downloadDone });
    } catch (error) {
      failTransfer(transferId, error);
      notify({ kind: "error", message: `${copy.downloadFailed}${String(error)}` });
    } finally {
      setBusyPath(null);
    }
  };

  /** 监听系统文件拖入；仅当释放位置落在 SFTP 面板内时执行上传。 */
  useEffect(() => {
    if (!open || !sessionId) {
      setDragUploadActive(false);
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    const webview = getCurrentWebview();

    const insidePanel = (position: { x: number; y: number }) => {
      const panel = panelRef.current;
      if (!panel) return false;
      const rect = panel.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const x = position.x / scale;
      const y = position.y / scale;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };

    void webview.onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "leave") {
        setDragUploadActive(false);
        return;
      }

      if (payload.type === "enter" || payload.type === "over") {
        setDragUploadActive(insidePanel(payload.position));
        return;
      }

      if (payload.type === "drop") {
        const accepted = insidePanel(payload.position);
        setDragUploadActive(false);
        if (accepted && payload.paths.length > 0) {
          void uploadDroppedPaths(payload.paths);
        }
      }
    }).then((disposeListener) => {
      if (disposed) disposeListener();
      else unlisten = disposeListener;
    });

    return () => {
      disposed = true;
      setDragUploadActive(false);
      unlisten?.();
    };
  }, [open, sessionId, uploadDroppedPaths]);

  /** 提交同目录重命名，并在成功后刷新列表。 */
  const submitRename = async (entry: SftpEntry) => {
    if (!sessionId || busyPath) return;
    const nextName = renameName.trim();
    if (!nextName || nextName === entry.name) {
      setRenamePath(null);
      return;
    }
    setBusyPath(entry.path);
    try {
      await invoke<string>("sftp_rename", {
        sessionId,
        oldPath: entry.path,
        newName: nextName,
      });
      notify({ kind: "success", message: copy.renameDone });
      setRenamePath(null);
      await loadDirectory(path);
    } catch (error) {
      notify({ kind: "error", message: `${copy.renameFailed}${String(error)}` });
    } finally {
      setBusyPath(null);
    }
  };

  /** 删除文件、链接或空目录，成功后刷新当前目录。 */
  const confirmDelete = async (entry: SftpEntry) => {
    if (!sessionId || busyPath) return;
    setBusyPath(entry.path);
    try {
      await invoke("sftp_delete", { sessionId, path: entry.path });
      notify({ kind: "success", message: copy.deleteDone });
      setDeletePath(null);
      await loadDirectory(path);
    } catch (error) {
      notify({ kind: "error", message: `${copy.deleteFailed}${String(error)}` });
    } finally {
      setBusyPath(null);
    }
  };

  const currentParent = path === "/" ? "/" : `${path.replace(/\/$/, "")}/..`;

  return (
    <aside ref={panelRef} className={`sftp-panel ${open ? "open" : ""}`} aria-hidden={!open}>
      <header className="sftp-header">
        <span className="sftp-title">{copy.sftp}{sessionName ? ` · ${sessionName}` : ""}</span>
        <button type="button" className="terminal-icon-button" aria-label={locale === "zh" ? "关闭 SFTP" : "Close SFTP"} onClick={onClose}>
          <SvgIcon name="close" size={14} />
        </button>
      </header>

      {!sessionId ? (
        <div className="sftp-unavailable">{copy.unavailable}</div>
      ) : (
        <>
          <div className="sftp-toolbar">
            <button type="button" className="sftp-button sftp-parent-button" title={copy.parent} aria-label={copy.parent} disabled={loading} onClick={() => void loadDirectory(currentParent)}>
              <SvgIcon name="chevron" size={14} />
            </button>
            <form className="sftp-path-form" onSubmit={submitPath}>
              <Input className="sftp-path-input" aria-label={copy.path} value={pathInput} onChange={(event) => setPathInput(event.target.value)} disabled={loading} />
            </form>
            <button type="button" className="sftp-button" title={copy.upload} aria-label={copy.upload} disabled={loading || busyPath !== null} onClick={() => void uploadFile()}>
              <SvgIcon name="upload" size={15} />
            </button>
          </div>

          {currentTransfer && (
            <div className={`sftp-transfer sftp-transfer-${currentTransfer.status}`}>
              <div className="sftp-transfer-meta">
                <span className="sftp-transfer-name">
                  <SvgIcon
                    name={currentTransfer.direction === "upload" ? "upload" : "download"}
                    size={12}
                  />
                  {currentTransfer.name}
                </span>
                <span className="sftp-transfer-value">
                  {currentTransfer.status === "error"
                    ? copy.transferError
                    : `${transferPercent(currentTransfer)}% · ${formatFileSize(currentTransfer.transferred)} / ${formatFileSize(currentTransfer.total)}`}
                </span>
              </div>
              <div className="sftp-transfer-track" aria-hidden="true">
                <div
                  className="sftp-transfer-fill"
                  style={{ width: `${transferPercent(currentTransfer)}%` }}
                />
              </div>
            </div>
          )}

          <div className="sftp-file-header">
            <div>{copy.name}</div>
            <div>{copy.size}</div>
            <div aria-label={copy.actions} />
          </div>

          <VerticalScrollbar
            className="sftp-file-list"
            viewportClassName="sftp-file-list-viewport"
            height="100%"
            viewportLabel={copy.sftp}
          >
            {loading ? (
              <div className="sftp-empty">{copy.loading}</div>
            ) : entries.length === 0 ? (
              <div className="sftp-empty">{copy.empty}</div>
            ) : (
              entries.map((entry) => (
                <div key={entry.path} className="sftp-entry">
                  <div className="sftp-file-row">
                    <button
                      type="button"
                      className={`sftp-file-main ${entry.kind === "directory" ? "is-directory" : ""}`}
                      disabled={busyPath !== null}
                      onClick={() => {
                        if (entry.kind === "directory") void loadDirectory(entry.path);
                      }}
                    >
                      <SvgIcon name={entry.kind === "directory" ? "folder" : "file"} size={15} />
                      <span>{entry.name}</span>
                    </button>
                    <div className="sftp-file-size">{entry.kind === "directory" ? "—" : formatFileSize(entry.size)}</div>
                    <div className="sftp-row-actions">
                      <button
                        type="button"
                        className="terminal-icon-button"
                        aria-label={locale === "zh" ? "文件操作" : "File actions"}
                        disabled={busyPath !== null}
                        onClick={() => {
                          setMenuPath((current) => current === entry.path ? null : entry.path);
                          setDeletePath(null);
                          setRenamePath(null);
                        }}
                      >
                        <SvgIcon name="more" size={15} />
                      </button>
                      {menuPath === entry.path && (
                        <div className="sftp-row-menu">
                          {entry.kind !== "directory" && (
                            <button type="button" onClick={() => void downloadFile(entry)}>
                              <SvgIcon name="download" size={13} />
                              {copy.download}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setMenuPath(null);
                              setRenamePath(entry.path);
                              setRenameName(entry.name);
                            }}
                          >
                            {copy.rename}
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => {
                              setMenuPath(null);
                              setDeletePath(entry.path);
                            }}
                          >
                            {copy.delete}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {renamePath === entry.path && (
                    <form className="sftp-inline-action" onSubmit={(event) => { event.preventDefault(); void submitRename(entry); }}>
                      <Input value={renameName} placeholder={copy.renamePlaceholder} onChange={(event) => setRenameName(event.target.value)} autoFocus disabled={busyPath !== null} />
                      <button type="button" onClick={() => setRenamePath(null)} disabled={busyPath !== null}>{copy.cancel}</button>
                      <button type="submit" className="primary" disabled={busyPath !== null}>{copy.save}</button>
                    </form>
                  )}

                  {deletePath === entry.path && (
                    <div className="sftp-inline-action sftp-delete-action">
                      <span>{locale === "zh" ? `删除“${entry.name}”？` : `Delete "${entry.name}"?`}</span>
                      <button type="button" onClick={() => setDeletePath(null)} disabled={busyPath !== null}>{copy.cancel}</button>
                      <button type="button" className="danger" disabled={busyPath !== null} onClick={() => void confirmDelete(entry)}>{copy.delete}</button>
                    </div>
                  )}
                </div>
              ))
            )}
          </VerticalScrollbar>
        </>
      )}
      {dragUploadActive && (
        <div className="sftp-drop-overlay" aria-hidden="true">
          <div className="sftp-drop-card">
            <SvgIcon name="upload" size={22} />
            <span>{copy.dropUpload}</span>
          </div>
        </div>
      )}
    </aside>
  );
}
