/** 独立 Markdown 工作区；本地/SFTP 文档共享编辑器，未保存正文仅保存在本机草稿中。 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog, HorizontalScrollbar, Input, PopupMenu, PopupMenuItem, SvgIcon, VerticalScrollbar, ViewportScrollbars, useNotification, type PopupMenuPoint } from "../components/ui";
import type { Locale } from "./SerialPage";
import BlockEditor from "./markdown/BlockEditor";
import { createFolder, listFolder, listRemoteDirectory, openFolder, openFolderFile, openLocal, openRemote, saveDocument, type LocalFolderDirectory } from "./markdown/api";
import FolderTree from "./markdown/FolderTree";
import DocumentOutline from "./markdown/DocumentOutline";
import { deserializeDrafts, DRAFT_STORAGE_KEY, isDocumentDirty, MAX_MARKDOWN_BYTES, MAX_OPEN_DOCUMENTS, newDocument, serializeDrafts, type MarkdownDocument, type MarkdownFile, type RemoteMarkdownSession, type RemoteMarkdownTarget } from "./markdown/model";
import RemoteFilePicker from "./markdown/RemoteFilePicker";
import "./markdown/markdown.css";
import "./markdown/haoContentTheme.css";

/** 页面保持挂载；remoteRequest 仅由已连接 SSH 的 SFTP 列表提交。 */
interface MarkdownPageProps {
  locale: Locale;
  /** 页面是否可见，只有当前页处理保存快捷键。 */
  pageActive: boolean;
  /** 每次打开为新对象，允许重连后为已有草稿重新关联会话。 */
  remoteRequest: RemoteMarkdownTarget | null;
  /** 不含认证信息的活动 SSH 会话，用于选择远程文件和文件夹。 */
  remoteSessions: RemoteMarkdownSession[];
  /** 应用标题栏的真实标签宿主；为空时在页面内保留可操作标签。 */
  titlebarHost: HTMLElement | null;
  /** 没有连接时前往终端，保留本页文档与草稿。 */
  onRequestTerminal: () => void;
}

/** 单次右键操作绑定文件 ID 和视口坐标，切换标签不会把操作发给其他文件。 */
interface FileMenuState {
  /** 本次菜单锚点的视口 CSS 像素坐标。 */
  point: PopupMenuPoint;
  /** 本次操作的固定文档 ID；目录和未打开文件为 null，禁止保存其他文件。 */
  documentId: string | null;
}

/** 文件栏的根目录及其来源，仅在本页内存中存在，不持久化活动 SSH 会话。 */
interface WorkspaceFolder extends LocalFolderDirectory {
  /** null 为本地目录；远程目录始终绑定选择时的服务器与已认证会话。 */
  remote: RemoteMarkdownSession | null;
}

/** 一个标题栏页面；启动页无文件栏，文件夹和文档页各自保留目录来源。 */
interface MarkdownPageTab {
  /** 页面会话标识；文档页与 MarkdownDocument.id 相同。 */
  id: string;
  /** start 显示入口，folder 等待选择文件，document 挂载编辑器。 */
  kind: "start" | "folder" | "document";
  /** 仅本次页面持有的目录快照；启动页或未选目录的文档为 null。 */
  folder: WorkspaceFolder | null;
}

/** 页面总数上限为文档上限加一，保证恢复八份草稿后仍能显示初始启动页。 */
const MAX_WORKSPACE_TABS = MAX_OPEN_DOCUMENTS + 1;

/** 按根目录来源读取一层；失败向调用方传播，保留原树和所有文档。 */
async function readWorkspaceFolder(folder: WorkspaceFolder, path = folder.path): Promise<WorkspaceFolder> {
  const directory = folder.remote
    ? await listRemoteDirectory(folder.remote.sessionId, path)
    : await listFolder(folder.path, path);
  return { ...directory, remote: folder.remote };
}

/** 恢复未保存文档；损坏草稿保留在存储中，向用户显示错误。 */
function restoreWorkspace() {
  /** 每次启动独立生成首页标识，不改变已恢复草稿的标识。 */
  const startId = crypto.randomUUID();
  try {
    const drafts = deserializeDrafts(window.localStorage.getItem(DRAFT_STORAGE_KEY));
    return { documents: drafts, startId, error: "" };
  } catch (error) {
    return { documents: [], startId, error: String(error) };
  }
}

/** 本地和远程 Markdown 编辑页；异步读取/保存均按文档标识回填，失败不覆盖草稿。 */
export default function MarkdownPage({ locale, pageActive, remoteRequest, remoteSessions, titlebarHost, onRequestTerminal }: MarkdownPageProps) {
  /** 当前页面内第三方视口复用应用轨道，关闭页面时统一释放绑定。 */
  const [scrollbarRoot, setScrollbarRoot] = useState<HTMLElement | null>(null);
  const zh = locale === "zh";
  const { notify } = useNotification();
  /** 普通操作错误统一交给应用右上角通知，页面不再放置独立提示条。 */
  const reportError = useCallback((error: unknown) => notify({ kind: "error", message: error instanceof Error ? error.message : String(error) }), [notify]);
  const [initial] = useState(restoreWorkspace);
  const [documents, setDocuments] = useState(initial.documents);
  /** 同步引用用于编辑事件和异步结果，避免尚未渲染的新正文被旧快照覆盖。 */
  const documentsRef = useRef(documents);
  /** 页面顺序独立于文档；每个新页面先显示启动页，操作后原位替换。 */
  const [tabs, setTabs] = useState<MarkdownPageTab[]>([
    { id: initial.startId, kind: "start", folder: null },
    ...initial.documents.map(/** 恢复草稿只恢复标签，初始仍选中启动页。 */ (document): MarkdownPageTab => ({ id: document.id, kind: "document", folder: null })),
  ]);
  const [activeId, setActiveId] = useState<string>(initial.startId);
  /** 同一时间只执行一次文件操作；编辑正文仍然可用。 */
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  /** 相同草稿存储错误只通知一次，恢复成功后允许再次报告。 */
  const draftFailure = useRef("");
  /** 恢复错误在 StrictMode 重放时不重复通知；原草稿仍留在本机。 */
  const restoreErrorReported = useRef(false);
  /** 正文第一次越过 2 MiB 上限时通知，避免每次输入都挤满通知区。 */
  const oversizedContent = useRef(false);
  /** 非空时显示该文档的丢弃确认，确认前保留正文。 */
  const [closeId, setCloseId] = useState<string | null>(null);
  /** 右键菜单及远端选择器只在本页可见期间存在。 */
  const [fileMenu, setFileMenu] = useState<FileMenuState | null>(null);
  /** null 关闭选择器；打开文件、打开目录与远程新建复用同一浏览界面。 */
  const [remotePickerMode, setRemotePickerMode] = useState<"file" | "folder" | "create" | null>(null);
  /** 保存快捷键和文件栏操作在任一选择器打开时暂停。 */
  const remotePickerOpen = remotePickerMode !== null;
  /** 页面类型与目录只取当前标签；启动页不会借用其他页面的文件栏。 */
  const activeTab = tabs.find(/** 活动标签决定启动页、目录来源与正文是否可见。 */ (tab) => tab.id === activeId);
  const startPage = activeTab?.kind === "start";
  const folder = activeTab?.folder ?? null;
  /** 目录更新绑定发起操作时的页面，不改变其他标签的目录与草稿。 */
  const setFolder = useCallback((next: WorkspaceFolder | null) => {
    setTabs(/** 选择目录会将当前启动页原位替换为文件夹工作区。 */ (current) => current.map(/** 目录只归属发起该操作的页面。 */ (tab) => tab.id === activeId ? { ...tab, folder: next, kind: tab.kind === "document" ? "document" : next ? "folder" : "start" } : tab));
  }, [activeId]);
  /** null 表示未开始命名，空串表示正在输入新文件夹名称；失败保留输入以便更正。 */
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  /** 文件栏的临时命名输入，取消或成功后随控件释放。 */
  const folderNameInput = useRef<HTMLInputElement>(null);
  const namingFolder = newFolderName !== null;
  /** 标题栏滚动容器；页面切换后仅将当前标签移入可见区域。 */
  const tabStrip = useRef<HTMLDivElement>(null);
  /** 当前正文的独立滚动区，目录只读取其标题和滚动位置。 */
  const editorScroll = useRef<HTMLDivElement>(null);
  /** 记录已处理的请求对象，避免 StrictMode 和语言切换重复读取同一远端。 */
  const lastRemoteRequest = useRef<RemoteMarkdownTarget | null>(null);
  const active = documents.find(/** 只挂载活动编辑器，其他文档保留正文与版本。 */ (document) => document.id === activeId);

  /** 新建或切换时滚动标签自身，正文滚动位置保持不变。 */
  useEffect(() => {
    tabStrip.current?.querySelector('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, titlebarHost]);

  /** 恢复失败使用手动关闭通知，避免短暂消失后看不到草稿问题。 */
  useEffect(() => {
    if (!initial.error || restoreErrorReported.current) return;
    restoreErrorReported.current = true;
    notify({ kind: "error", title: zh ? "草稿恢复失败" : "Draft recovery failed", message: initial.error, durationMs: 0 });
  }, [initial.error, notify, zh]);

  /** 将未保存内容写入本机草稿；失败保留内存正文，并对相同错误去重通知。 */
  const replaceDocuments = useCallback((next: MarkdownDocument[]) => {
    documentsRef.current = next;
    setDocuments(next);
    try {
      const serialized = serializeDrafts(next);
      if (serialized === "[]") window.localStorage.removeItem(DRAFT_STORAGE_KEY);
      else window.localStorage.setItem(DRAFT_STORAGE_KEY, serialized);
      draftFailure.current = "";
    } catch (error) {
      const message = String(error);
      if (draftFailure.current !== message) notify({ kind: "error", title: zh ? "草稿未保存到本机" : "Draft was not stored locally", message, durationMs: 0 });
      draftFailure.current = message;
    }
  }, [notify, zh]);

  /** 文档操作替换当前启动/文件夹页；已有文件保持唯一标签，旧版本标识原位更新。 */
  const activateDocument = useCallback((id: string, previousId?: string) => {
    setTabs(/** current 保留其他页面顺序；目录来源随被替换的页面移交给文档。 */ (current) => {
      const destination = current.find(/** 已打开文件不重复创建标签。 */ (tab) => tab.id === (previousId ?? id));
      const placeholder = current.find(/** 启动页和尚未选择正文的目录页都可原位成为文档。 */ (tab) => tab.id === activeId && tab.kind !== "document");
      if (destination) {
        const updated: MarkdownPageTab = { ...destination, id, kind: "document" };
        if (placeholder && placeholder !== destination) return current.flatMap(/** 当前启动页原位接收已打开文档，旧位置移除，正文始终只有一份。 */ (tab) => tab === placeholder ? [updated] : tab === destination ? [] : [tab]);
        return current.map(/** 重新读取的干净文档使用新编辑器标识。 */ (tab) => tab === destination ? updated : tab);
      }
      const documentTab: MarkdownPageTab = { id, kind: "document", folder: placeholder?.folder ?? activeTab?.folder ?? null };
      return placeholder ? current.map(/** 原位替换，不遗留启动页标签。 */ (tab) => tab === placeholder ? documentTab : tab) : [...current, documentTab];
    });
    setActiveId(id);
  }, [activeId, activeTab?.folder]);

  /** 将已读取文件加入工作区；同一文件已打开时保留未保存正文，并更新远程连接。 */
  const acceptFile = useCallback((file: MarkdownFile, remote: RemoteMarkdownTarget | null) => {
    const current = documentsRef.current;
    const existing = current.find(/** 本地路径和服务器连接共同决定文件身份，防止不同主机同路径混淆。 */ (document) => document.path === file.path && document.remote?.connectionId === remote?.connectionId);
    if (existing) {
      const dirty = isDocumentDirty(existing);
      const id = dirty ? existing.id : crypto.randomUUID();
      if (dirty && existing.revision !== file.revision) reportError(zh ? "文件已被外部修改，草稿保留；请另存为或关闭草稿后重新打开。" : "File changed externally. Draft retained; save a copy or close the draft and reopen.");
      replaceDocuments(current.map(/** 只更新读取目标，其他文档和草稿保持不变。 */ (document) => document.id === existing.id
        ? { ...document, id, remote, ...(dirty ? {} : { content: file.content, savedContent: file.content, revision: file.revision }) }
        : document));
      activateDocument(id, existing.id);
      return;
    }
    // 只有当前启动页或目录页会被替换，不复用其他标签中的空白文档。
    if (current.length >= MAX_OPEN_DOCUMENTS || (tabs.length >= MAX_WORKSPACE_TABS && activeTab?.kind === "document")) throw new Error(zh ? "页面或文档数量已达上限，请先关闭一页。" : "Page or document limit reached; close one first.");
    const document: MarkdownDocument = { id: crypto.randomUUID(), path: file.path, remote, content: file.content, savedContent: file.content, revision: file.revision };
    replaceDocuments([...current, document]);
    activateDocument(document.id);
  }, [activateDocument, activeTab?.kind, tabs.length, replaceDocuments, reportError, zh]);

  /** 执行一次文件操作，捕获错误并始终恢复按钮状态；正文编辑不受文件操作锁影响。 */
  const runFileAction = useCallback(async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await action(); }
    catch (error) { reportError(error instanceof Error ? error.message : String(error)); }
    finally { busyRef.current = false; setBusy(false); }
  }, [reportError]);

  /** 开始命名时聚焦文件栏；后续输入不会反复抢占光标。 */
  useEffect(() => { if (namingFolder) folderNameInput.current?.focus(); }, [namingFolder]);

  /** 切换根目录后取消旧目录的命名，避免将名称提交到另一工作区。 */
  useEffect(() => { setNewFolderName(null); }, [activeId, folder?.path, folder?.remote?.sessionId]);

  /** 在本地根目录创建文件夹；成功后关闭输入，刷新失败单独显示以防重复创建。 */
  const createNewFolder = () => {
    if (!folder || folder.remote || newFolderName === null) return;
    const root = folder.path;
    const name = newFolderName;
    void runFileAction(/** root 和 name 固定为提交时的快照，失败不丢失名称或编辑器草稿。 */ async () => {
      await createFolder(root, name);
      setNewFolderName(null);
      try { setFolder(await readWorkspaceFolder(folder)); }
      catch (error) { reportError(`${zh ? "文件夹已创建，刷新失败：" : "Folder created; refresh failed: "}${String(error)}`); }
    });
  };

  /** 从 SFTP 导航请求读取服务器文件；StrictMode 重放不重复发起读取。 */
  useEffect(() => {
    if (!remoteRequest || lastRemoteRequest.current === remoteRequest) return;
    if (busyRef.current) return;
    lastRemoteRequest.current = remoteRequest;
    void runFileAction(/** 读取期间保留现有草稿；成功后关联新的 SSH 会话。 */ async () => {
      const file = await openRemote(remoteRequest);
      acceptFile(file, { ...remoteRequest, path: file.path });
    });
  }, [remoteRequest, acceptFile, runFileAction, busy]);

  /** 新建空白页；超过文档上限时不替换任何已有内容。 */
  const createDocument = () => {
    if (documentsRef.current.length >= MAX_OPEN_DOCUMENTS || (tabs.length >= MAX_WORKSPACE_TABS && activeTab?.kind === "document")) { reportError(zh ? "页面或文档数量已达上限，请先关闭一页。" : "Page or document limit reached; close one first."); return; }
    const document = newDocument();
    replaceDocuments([...documentsRef.current, document]);
    activateDocument(document.id);
  };

  /** 使用原始快照保存；保存期间的新输入保留为未保存内容，不被成功结果覆盖。 */
  const save = useCallback((saveAs = false, documentId = activeId) => runFileAction(/** 保存快照与返回结果按同一文档 ID 对应，失败不改变版本。 */ async () => {
    const snapshot = documentsRef.current.find(/** 右键操作绑定其文件，快捷键默认针对调用时的活动页。 */ (document) => document.id === documentId);
    if (!snapshot) return;
    const file = await saveDocument(snapshot, saveAs, folder && !folder.remote ? folder.path : null);
    if (!file) return;
    replaceDocuments(documentsRef.current.map(/** 按文档 ID 回填，savedContent 只标记实际已提交的版本。 */ (document) => document.id === snapshot.id
      ? { ...document, path: file.path, remote: saveAs ? null : document.remote, savedContent: file.content, revision: file.revision }
      : document));
    // 新文件或副本保存后刷新物理目录；刷新失败不撤销已成功保存的正文状态。
    if (folder && !folder.remote && (saveAs || !snapshot.path)) {
      try { setFolder(await readWorkspaceFolder(folder)); }
      catch (error) { reportError(`${zh ? "文件已保存，刷新文件夹失败：" : "File saved; folder refresh failed: "}${String(error)}`); }
    }
  }), [activeId, folder, replaceDocuments, runFileAction, reportError, zh]);

  /** 页面当前可见时响应 Command/Ctrl+S，Shift 同时按下时另存为本地副本。 */
  useEffect(() => {
    if (!pageActive || remotePickerOpen || closeId) return;
    /** 快捷键不会触发浏览器保存 HTML，也不自动保存其他页的草稿。 */
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); setFileMenu(null); void save(event.shiftKey); }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [pageActive, remotePickerOpen, closeId, save]);

  /** 离开导航时关闭临时菜单和选择器，文档正文和 SSH 会话保持不变。 */
  useEffect(() => {
    if (!pageActive) { setFileMenu(null); setRemotePickerMode(null); setNewFolderName(null); setCloseId(null); }
  }, [pageActive]);

  /** 加号新建独立启动页，保留所有既有标签与正文。 */
  const createPage = () => {
    if (tabs.length >= MAX_WORKSPACE_TABS) { reportError(zh ? "最多打开九个页面，请先关闭一个。" : "Up to nine pages; close one first."); return; }
    const tab: MarkdownPageTab = { id: crypto.randomUUID(), kind: "start", folder: null };
    setTabs([...tabs, tab]);
    setActiveId(tab.id);
    setCloseId(null);
    setFileMenu(null);
  };

  /** 本地选择器取消或失败时保留现有工作区。 */
  const openLocalFile = () => {
    setFileMenu(null);
    void runFileAction(/** file 为用户选择后读取的快照，取消时为空。 */ async () => { const file = await openLocal(); if (file) acceptFile(file, null); });
  };

  /** 选择本地目录后将启动页替换为目录工作区；已有文档页只更新文件树。 */
  const openLocalFolder = () => {
    setFileMenu(null);
    void runFileAction(/** selected 为空表示用户取消，不改变目录来源。 */ async () => { const selected = await openFolder(); if (selected) setFolder({ ...selected, remote: null }); });
  };

  /** 更新活动正文并立即保存草稿；超限正文保留在内存，原文件不会被覆盖。 */
  const changeContent = (content: string) => {
    const oversized = new TextEncoder().encode(content).length > MAX_MARKDOWN_BYTES;
    if (oversized && !oversizedContent.current) reportError(zh ? "正文超过 2 MiB，请精简后保存。" : "Content exceeds 2 MiB; reduce it before saving.");
    oversizedContent.current = oversized;
    replaceDocuments(documentsRef.current.map(/** 只改变本编辑器对应文档的正文。 */ (document) => document.id === activeId ? { ...document, content } : document));
  };

  /** 关闭已确认页面；最后一页关闭后补一份启动页，不自动创建文档。 */
  const closeDocument = (id: string) => {
    if (documentsRef.current.some(/** 关闭启动页不重写草稿存储。 */ (document) => document.id === id)) replaceDocuments(documentsRef.current.filter(/** 仅丢弃已确认关闭的那一份正文。 */ (document) => document.id !== id));
    const next = tabs.filter(/** 不改变其他页面与目录归属。 */ (tab) => tab.id !== id);
    if (!next.length) next.push({ id: crypto.randomUUID(), kind: "start", folder: null });
    setTabs(next);
    if (id === activeId) setActiveId(next[0].id);
    setCloseId(null);
  };

  /** 将库的错误显示为文本；不将异常字符串作为 HTML 渲染。 */
  const editorError = reportError;
  /** 用户文件路径的最后一段仅用于显示，文件操作仍使用完整路径。 */
  const fileName = (document: MarkdownDocument) => document.path?.split(/[\\/]/).pop() || (zh ? "未命名" : "Untitled");

  /** 关闭自绘文件菜单，供共享浮层处理外部点击与键盘退出。 */
  const dismissFileMenu = useCallback(() => setFileMenu(null), []);

  /** 树节点按路径和服务器身份关联文档，未打开文件和目录只允许全局文件操作。 */
  const folderMenu = (point: PopupMenuPoint, path: string | null) => {
    const document = path ? documentsRef.current.find(/** 同路径的本地文件和不同服务器文件分别匹配。 */ (item) => item.remote?.connectionId === folder?.remote?.connectionId && item.path === path) : undefined;
    if (document) setActiveId(document.id);
    setFileMenu({ point, documentId: document?.id ?? null });
  };

  /** 在指针位置打开当前文件菜单，文件行和标题栏标签均复用同一套操作。 */
  const contextMenu = (event: MouseEvent<HTMLElement>, documentId: string | null = activeId) => {
    event.preventDefault();
    event.stopPropagation();
    if (remotePickerOpen) return;
    if (documentId) setActiveId(documentId);
    setFileMenu({ point: { x: event.clientX, y: event.clientY }, documentId });
  };

  /** Shift+F10 或菜单键在当前文件控件下方打开同一个自绘菜单。 */
  const menuKeyDown = (event: ReactKeyboardEvent<HTMLElement>, documentId: string | null = activeId) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    if (remotePickerOpen) return;
    const rect = (event.target instanceof HTMLElement ? event.target : event.currentTarget).getBoundingClientRect();
    if (documentId) setActiveId(documentId);
    setFileMenu({ point: { x: rect.left, y: rect.bottom }, documentId });
  };

  const menuDocument = documents.find(/** 菜单目标不存在时保存项不可用。 */ (document) => document.id === fileMenu?.documentId);
  const activityBar = <div className="markdown-activity" ref={tabStrip}><HorizontalScrollbar className="markdown-tab-scroll" height="35px" viewportLabel={zh ? "Markdown 活动文档" : "Markdown document tabs"} hideTrack>
    <div className="markdown-tabs" role="tablist" aria-label={zh ? "Markdown 文档" : "Markdown documents"}>
      {tabs.map(/** 每个标签对应独立页面，启动页操作后标签原位变为文件或目录。 */ (tab) => {
        const document = documents.find(/** 文档页使用文档标识读取标题和未保存状态。 */ (item) => item.id === tab.id);
        const name = document ? fileName(document) : tab.kind === "start" ? (zh ? "启动页" : "Welcome") : tab.folder?.path.split(/[\\/]/).filter(Boolean).pop() || (zh ? "文件夹" : "Folder");
        return <div className={`markdown-tab${activeId === tab.id ? " active" : ""}`} key={tab.id} onContextMenu={/** 启动页和目录页没有保存目标。 */ (event) => contextMenu(event, document?.id ?? null)} onKeyDown={/** 键盘菜单绑定该标签的真实文档。 */ (event) => menuKeyDown(event, document?.id ?? null)}>
          <button type="button" role="tab" aria-selected={activeId === tab.id} title={document?.path ?? tab.folder?.path} disabled={busy || remotePickerOpen} onClick={/** 只切换当前页面，不改变任何正文和目录。 */ () => { setActiveId(tab.id); setCloseId(null); dismissFileMenu(); }}><SvgIcon name={document ? (document.remote ? "globe" : "file") : tab.kind === "folder" ? "folder" : "markdown"} size={13} /><span className="markdown-file-name">{name}</span>{document && isDocumentDirty(document) && <span className="markdown-dirty" aria-label={zh ? "未保存" : "Unsaved"}>●</span>}</button>
          <button type="button" className="markdown-close" disabled={busy || remotePickerOpen} aria-label={`${zh ? "关闭" : "Close"} ${name}`} onClick={/** 启动页直接关闭，文档页关闭前保护未保存正文。 */ () => document && isDocumentDirty(document) ? setCloseId(document.id) : closeDocument(tab.id)}><SvgIcon name="close" size={12} /></button>
        </div>;
      })}
    </div>
  </HorizontalScrollbar>
    <button type="button" className="markdown-new-tab" aria-label={zh ? "新建页面" : "New page"} title={zh ? "新建页面" : "New page"} disabled={busy || remotePickerOpen} onClick={createPage}><SvgIcon name="plus" size={15} /></button>
  </div>;

  return <section ref={setScrollbarRoot} className={`markdown-page${titlebarHost ? "" : " has-inline-tabs"}${startPage ? " is-start-page" : ""}`} aria-label="Markdown" onContextMenu={contextMenu} onKeyDown={menuKeyDown}>
    <ViewportScrollbars root={scrollbarRoot} selector=".markdown-scroll, .markdown-start, .menu-groups, .language-list" />
    {titlebarHost ? createPortal(activityBar, titlebarHost) : <div className="markdown-activity-fallback">{activityBar}</div>}
    {!startPage && <aside className="markdown-files" aria-label={zh ? "文件栏" : "Files"}>
      <header><strong title={folder?.remote ? `${folder.remote.sessionName} · ${folder.path}` : folder?.path}>{folder ? `${folder.remote ? `${folder.remote.sessionName} · ` : ""}${folder.path.split(/[\\/]/).filter(Boolean).pop() || folder.path}` : zh ? "文件" : "Files"}</strong><div className="markdown-file-actions">
        <button type="button" disabled={busy || remotePickerOpen} aria-label={zh ? "新建文件" : "New file"} title={zh ? "新建文件" : "New file"} onClick={createDocument}><SvgIcon name="new-file" size={16} /></button>
        <button type="button" disabled={!folder || !!folder.remote || busy || remotePickerOpen} aria-label={zh ? "新建文件夹" : "New folder"} title={!folder ? (zh ? "请先打开文件夹" : "Open a folder first") : folder.remote ? (zh ? "远程文件夹暂不支持新建文件夹" : "Creating remote folders is unavailable") : (zh ? "新建文件夹" : "New folder")} onClick={/** 在当前根目录下命名新文件夹，重复点击只聚焦已有输入。 */ () => { setFileMenu(null); setNewFolderName(newFolderName ?? ""); folderNameInput.current?.focus(); }}><SvgIcon name="new-folder" size={16} /></button>
      </div></header>
      {namingFolder && <form className="markdown-folder-create" aria-label={zh ? "新建文件夹" : "New folder"} onSubmit={/** Enter 或确认按钮提交，禁止浏览器导航。 */ (event) => { event.preventDefault(); createNewFolder(); }}>
        <SvgIcon name="folder" size={14} />
        <Input ref={folderNameInput} value={newFolderName} disabled={busy} aria-label={zh ? "文件夹名称" : "Folder name"} placeholder={zh ? "文件夹名称" : "Folder name"} onChange={/** 用户输入保持原样，跨平台名称校验由后端统一处理。 */ (event) => setNewFolderName(event.target.value)} onKeyDown={/** Escape 取消；中文输入法确认候选字时不提前创建。 */ (event) => { if (event.nativeEvent.isComposing && event.key === "Enter") event.preventDefault(); else if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); setNewFolderName(null); } }} />
        <button type="submit" disabled={busy || !newFolderName} aria-label={zh ? "确认创建" : "Create folder"} title={zh ? "确认创建" : "Create folder"}><SvgIcon name="check" size={13} /></button>
        <button type="button" disabled={busy} aria-label={zh ? "取消新建文件夹" : "Cancel new folder"} title={zh ? "取消" : "Cancel"} onClick={/** 取消只丢弃尚未提交的名称。 */ () => setNewFolderName(null)}><SvgIcon name="close" size={12} /></button>
      </form>}
      <VerticalScrollbar height="100%" className="markdown-files-list" viewportLabel={zh ? "文件列表" : "File list"}>
        {folder ? <FolderTree key={`${folder.remote?.sessionId ?? "local"}:${folder.path}`} directory={folder} loadDirectory={/** 子目录读取固定当前根目录来源。 */ (path) => readWorkspaceFolder(folder, path)} activePath={active?.remote?.connectionId === folder.remote?.connectionId ? active?.path ?? null : null} disabled={busy || remotePickerOpen} zh={zh} onMenu={folderMenu} onOpen={/** 本地路径经过根目录校验，远程路径绑定当前服务器；两者都保护已有草稿。 */ (path) => { dismissFileMenu(); setCloseId(null); void runFileAction(/** 读取结果只能加入请求时选定的来源，不借用活动标签的会话。 */ async () => {
          if (folder.remote) {
            const target = { ...folder.remote, path };
            const file = await openRemote(target);
            acceptFile(file, { ...target, path: file.path });
          } else acceptFile(await openFolderFile(folder.path, path), null);
        }); }} /> : documents.map(/** 未打开文件夹时保留已打开文档列表。 */ (document) => <button key={document.id} type="button" className={`markdown-file-row${activeId === document.id ? " active" : ""}`} aria-current={activeId === document.id ? "page" : undefined} disabled={busy || remotePickerOpen} title={document.remote ? `${document.remote.sessionName} · ${document.path}` : document.path ?? undefined} onClick={/** 单击打开已有文档，不重新读取并覆盖草稿。 */ () => { setActiveId(document.id); setCloseId(null); dismissFileMenu(); }} onContextMenu={/** 文件栏右键始终操作点击的这一份文件。 */ (event) => contextMenu(event, document.id)} onKeyDown={/** 文件行也支持键盘打开菜单。 */ (event) => menuKeyDown(event, document.id)}><SvgIcon name={document.remote ? "globe" : "markdown"} size={15} /><span className="markdown-file-name">{fileName(document)}</span>{isDocumentDirty(document) && <span className="markdown-dirty" aria-label={zh ? "未保存" : "Unsaved"}>●</span>}</button>)}
      </VerticalScrollbar>
    </aside>}
    <div className="markdown-main">
    <ConfirmDialog open={!!closeId && pageActive} title={zh ? "丢弃未保存修改？" : "Discard unsaved changes?"}
      message={zh ? "关闭后将丢失这份文档的未保存修改。" : "Closing will discard this document’s unsaved changes."}
      cancelLabel={zh ? "取消" : "Cancel"} confirmLabel={zh ? "丢弃" : "Discard"}
      onCancel={/** 取消关闭，正文和草稿保持不变。 */ () => setCloseId(null)}
      onConfirm={/** 仅丢弃用户已明确确认的文档。 */ () => { if (closeId) closeDocument(closeId); }} />
    {active ? <>
    <div className="markdown-location"><span title={active.path ?? undefined}>{active.remote ? `${active.remote.sessionName} · ${active.path}` : active.path ?? (zh ? "新文档" : "New document")}</span></div>
    <div className="markdown-scroll" ref={editorScroll} role="tabpanel">
      <BlockEditor key={`${active.id}:${locale}`} content={active.content} zh={zh} onChange={changeContent} onError={editorError} />
    </div>
    <DocumentOutline key={active.id} scrollRoot={editorScroll} pageActive={pageActive} zh={zh} />
    </> : startPage ? <div className="markdown-start" role="tabpanel" aria-label={zh ? "启动页" : "Welcome"}>
      <div className="markdown-start-content">
        <SvgIcon name="markdown" size={48} />
        <h1>Markdown</h1>
        <h2>{zh ? "开始" : "Start"}</h2>
        <nav aria-label={zh ? "开始使用 Markdown" : "Get started with Markdown"}>
          <button type="button" disabled={busy || remotePickerOpen} onClick={createDocument}><SvgIcon name="new-file" />{zh ? "新建本地文件" : "New local file"}</button>
          <button type="button" disabled={busy || remotePickerOpen} onClick={/** 达到文档上限时先拒绝，避免创建了远端文件却无法打开。 */ () => { if (documentsRef.current.length >= MAX_OPEN_DOCUMENTS) { reportError(zh ? "最多打开八份文档，请先关闭一份。" : "Up to eight documents; close one first."); return; } setRemotePickerMode("create"); }}><SvgIcon name="new-file" />{zh ? "新建远程文件" : "New remote file"}</button>
          <button type="button" disabled={busy || remotePickerOpen} onClick={openLocalFile}><SvgIcon name="file" />{zh ? "打开本地文件" : "Open local file"}</button>
          <button type="button" disabled={busy || remotePickerOpen} onClick={openLocalFolder}><SvgIcon name="folder" />{zh ? "打开本地文件夹" : "Open local folder"}</button>
          <button type="button" disabled={busy || remotePickerOpen} onClick={/** 启动页复用文件菜单的 SFTP 选择器。 */ () => setRemotePickerMode("file")}><SvgIcon name="globe" />{zh ? "打开远程文件" : "Open remote file"}</button>
          <button type="button" disabled={busy || remotePickerOpen} onClick={/** 只切换选择器模式，确认目录前不改变文件栏。 */ () => setRemotePickerMode("folder")}><SvgIcon name="folder" />{zh ? "打开远程文件夹" : "Open remote folder"}</button>
        </nav>
      </div>
    </div> : <div className="markdown-folder-workspace" role="tabpanel" aria-label={zh ? "文件夹工作区" : "Folder workspace"} />}
    </div>
    <PopupMenu open={!!fileMenu} point={fileMenu?.point} onClose={dismissFileMenu} width={230} ariaLabel={zh ? "文件操作" : "File actions"} className="markdown-file-menu">
      <PopupMenuItem disabled={busy || !menuDocument || (!!menuDocument.path && !isDocumentDirty(menuDocument))} onClick={/** 只保存右键目标，菜单先收起再等待 I/O。 */ () => { const id = fileMenu?.documentId; dismissFileMenu(); if (id) void save(false, id); }}>{zh ? "保存" : "Save"}<kbd>⌘/Ctrl S</kbd></PopupMenuItem>
      <PopupMenuItem disabled={busy || !menuDocument} onClick={/** 远程文件也能另存为本机副本。 */ () => { const id = fileMenu?.documentId; dismissFileMenu(); if (id) void save(true, id); }}>{zh ? "另存为" : "Save as"}</PopupMenuItem>
      <div role="separator" className="rivet-popup-menu-separator" />
      <PopupMenuItem disabled={busy} onClick={openLocalFile}>{zh ? "打开本地文件" : "Open local file"}</PopupMenuItem>
      <PopupMenuItem disabled={busy} onClick={openLocalFolder}>{zh ? "打开文件夹" : "Open folder"}</PopupMenuItem>
      <PopupMenuItem disabled={busy} onClick={/** 打开自绘 SFTP 选择器，不新建连接或调用系统菜单。 */ () => { dismissFileMenu(); setRemotePickerMode("file"); }}>{zh ? "打开远程文件" : "Open remote file"}</PopupMenuItem>
      <PopupMenuItem disabled={busy} onClick={/** 复用 SFTP 选择器，确认后才替换文件栏根目录。 */ () => { dismissFileMenu(); setRemotePickerMode("folder"); }}>{zh ? "打开远程文件夹" : "Open remote folder"}</PopupMenuItem>
      {folder && <div role="separator" className="rivet-popup-menu-separator" />}
      {folder && <PopupMenuItem disabled={busy} onClick={/** 外部新增、删除和改名后重新读取，失败保留当前树。 */ () => { dismissFileMenu(); void runFileAction(/** 使用菜单触发时的根路径和 SSH 身份读取快照。 */ async () => setFolder(await readWorkspaceFolder(folder))); }}>{zh ? "刷新文件夹" : "Refresh folder"}</PopupMenuItem>}
      {folder && <PopupMenuItem disabled={busy} onClick={/** 关闭文件夹只恢复文档列表，不关闭文件或修改磁盘。 */ () => { dismissFileMenu(); setFolder(null); }}>{zh ? "关闭文件夹" : "Close folder"}</PopupMenuItem>}
    </PopupMenu>
    {remotePickerOpen && <RemoteFilePicker sessions={remoteSessions} zh={zh} mode={remotePickerMode ?? "file"} onFolderOpened={/** 文件夹与服务器身份原子替换，文档和草稿保持不变。 */ (directory, remote) => { setFolder({ ...directory, remote }); setRemotePickerMode(null); }} onClose={/** 关闭只取消前端选择，不关闭已有 SSH。 */ () => setRemotePickerMode(null)} onConnect={/** 终端建立连接后可从右键菜单重新选择远程文件。 */ () => { setRemotePickerMode(null); onRequestTerminal(); }} onOpened={/** 接收当前服务器文件，成功加入后关闭选择器。 */ (file, target) => { acceptFile(file, target); setRemotePickerMode(null); }} />}
  </section>;
}
