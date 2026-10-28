/** Markdown 本地/SFTP 文件树；只读取展开的目录，收起或切换根目录即释放子树缓存。 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { SvgIcon, useNotification, type PopupMenuPoint } from "../../components/ui";
import type { LocalFolderDirectory, LocalFolderEntry } from "./api";
import { isMarkdownPath, MAX_DIRECTORY_ENTRIES } from "./model";

/** 最多展开 32 层，限制递归渲染深度；根目录为第零层。 */
const MAX_FOLDER_DEPTH = 32;

/** 文件树不持有正文或文件句柄；编辑和右键操作交给工作区。 */
interface FolderTreeProps {
  /** 当前根目录快照；更新对象会清空展开状态并取消旧结果。 */
  directory: LocalFolderDirectory;
  /** 与当前根目录来源一致的活动文件路径；其他服务器、本地来源或新文档为 null。 */
  activePath: string | null;
  /** 读取本根目录的直接子目录；调用方固定本地根路径或已认证 SSH 身份。 */
  loadDirectory: (path: string) => Promise<LocalFolderDirectory>;
  /** 文件操作或远程选择期间禁用树操作。 */
  disabled: boolean;
  zh: boolean;
  /** 打开普通 Markdown，父组件负责异步错误和草稿保护。 */
  onOpen: (path: string) => void;
  /** null 表示目录或未打开文件，菜单不得保存其他文档。 */
  onMenu: (point: PopupMenuPoint, path: string | null) => void;
}

/** 当前根目录下的按需目录树；同一时刻只读取一个子目录，晚到结果不写入新树。 */
export default function FolderTree({ directory, activePath, loadDirectory, disabled, zh, onOpen, onMenu }: FolderTreeProps) {
  /** Map 只保存已展开目录；同步引用用于读取完成时重新检查缓存总量。 */
  const [expanded, setExpanded] = useState(new Map<string, LocalFolderDirectory>());
  const expandedRef = useRef(expanded);
  /** 单次目录读取的身份；收起、根目录更新或卸载后旧请求失效。 */
  const request = useRef<symbol | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const { notify } = useNotification();

  /** 新根目录和刷新均释放旧缓存；IPC 不可取消，清除身份即可忽略晚到结果。 */
  useEffect(() => {
    expandedRef.current = new Map();
    setExpanded(expandedRef.current);
    request.current = null;
    setLoading(null);
    return () => { request.current = null; };
  }, [directory]);

  /** entry 是待切换目录，depth 为其从零开始的层数；收起释放后代，展开失败保留已有树。 */
  const toggle = async (entry: LocalFolderEntry, depth: number) => {
    if (disabled || request.current) return;
    const current = expandedRef.current;
    if (current.has(entry.path)) {
      const next = new Map(current);
      for (const path of next.keys()) {
        if (path === entry.path || path.startsWith(`${entry.path}/`) || path.startsWith(`${entry.path}\\`)) next.delete(path);
      }
      expandedRef.current = next;
      setExpanded(next);
      return;
    }
    if (depth >= MAX_FOLDER_DEPTH) { notify({ kind: "warning", message: zh ? "最多展开 32 层文件夹。" : "Maximum folder depth is 32." }); return; }
    const token = Symbol(entry.path);
    request.current = token;
    setLoading(entry.path);
    try {
      const child = await loadDirectory(entry.path);
      if (request.current !== token) return;
      let count = directory.entries.length + child.entries.length;
      for (const cached of expandedRef.current.values()) count += cached.entries.length;
      if (count > MAX_DIRECTORY_ENTRIES) throw new Error(zh ? "文件树达到一万项，请先收起部分目录。" : "Tree reached 10,000 entries; collapse some folders first.");
      const next = new Map(expandedRef.current).set(entry.path, child);
      expandedRef.current = next;
      setExpanded(next);
    } catch (error) {
      if (request.current === token) notify({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (request.current === token) { request.current = null; setLoading(null); }
    }
  };

  /** 文件树右键绑定指针所在路径，未打开文件不借用当前编辑器的保存目标。 */
  const contextMenu = (event: MouseEvent, entry: LocalFolderEntry) => {
    event.preventDefault();
    event.stopPropagation();
    if (!disabled) onMenu({ x: event.clientX, y: event.clientY }, entry.kind === "file" ? entry.path : null);
  };

  /** 键盘菜单与鼠标菜单共享目标；普通 Tab 和方向键由浏览器处理。 */
  const menuKeyDown = (event: KeyboardEvent<HTMLElement>, entry: LocalFolderEntry) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    if (!disabled) onMenu({ x: rect.left, y: rect.bottom }, entry.kind === "file" ? entry.path : null);
  };

  /** 深度有界的嵌套列表；基础左缩进 12px、每层增加 14px，非 Markdown 和链接只展示。 */
  const renderEntries = (entries: LocalFolderEntry[], depth: number): ReactNode => <ul className="markdown-folder-entries">
    {entries.map(/** 每个节点使用后端完整路径作标识，避免重名子目录混淆。 */ (entry) => {
      const child = expanded.get(entry.path);
      const folder = entry.kind === "directory";
      const readable = folder || (entry.kind === "file" && isMarkdownPath(entry.path));
      const title = readable ? entry.path : `${entry.path}\n${zh ? "仅支持编辑普通 Markdown 文件" : "Only regular Markdown files can be edited"}`;
      return <li key={entry.path}>
        <div onContextMenu={/** 禁用的文件按钮仍有自绘菜单，不冒用其他文档。 */ (event) => contextMenu(event, entry)} onKeyDown={/** 为可聚焦节点提供键盘菜单。 */ (event) => menuKeyDown(event, entry)}>
          <button type="button" className={`markdown-file-row markdown-folder-row${entry.path === activePath ? " active" : ""}`} style={{ paddingLeft: 12 + depth * 14 }} title={title} aria-expanded={folder ? !!child : undefined} aria-current={entry.path === activePath ? "page" : undefined} disabled={disabled || !!loading || !readable} onClick={/** 目录只展开一层，文件交给工作区打开。 */ () => { if (folder) void toggle(entry, depth); else onOpen(entry.path); }}>
            {folder ? <span className={`markdown-folder-chevron${child ? " expanded" : ""}`}><SvgIcon name="chevron" size={10} /></span> : <span className="markdown-folder-spacer" />}
            <SvgIcon name={folder ? "folder" : isMarkdownPath(entry.path) ? "markdown" : "file"} size={14} /><span className="markdown-file-name">{entry.name}</span>
          </button>
        </div>
        {loading === entry.path && <div className="markdown-folder-note" role="status">{zh ? "读取中…" : "Loading…"}</div>}
        {child && (child.entries.length ? renderEntries(child.entries, depth + 1) : <div className="markdown-folder-note">{zh ? "空文件夹" : "Empty folder"}</div>)}
      </li>;
    })}
  </ul>;

  return <nav aria-label={zh ? "文件夹内容" : "Folder contents"}>
    {directory.entries.length ? renderEntries(directory.entries, 0) : <div className="markdown-folder-note">{zh ? "空文件夹" : "Empty folder"}</div>}
  </nav>;
}
