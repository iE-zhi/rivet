/** Markdown 的桌面文件接口；浏览器预览允许编辑，文件读写只在 Tauri 中执行。 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { MAX_DIRECTORY_ENTRIES, type MarkdownDocument, type MarkdownFile, type RemoteMarkdownTarget } from "./model";

/** 本地目录的一层快照；链接和特殊节点仅展示，路径由后端返回。 */
export interface LocalFolderEntry {
  /** 原始文件名，只用于显示。 */
  name: string;
  /** 所选根目录下的绝对路径。 */
  path: string;
  /** 不跟随链接取得的类型，普通文件仍需校验 Markdown 扩展名。 */
  kind: "directory" | "file" | "symlink" | "other";
}

/** 用户所选目录或其子目录的直接子项，不递归扫描。 */
export interface LocalFolderDirectory {
  /** 后端规范化的绝对目录路径。 */
  path: string;
  /** 名称排序、目录优先的完整单层列表。 */
  entries: LocalFolderEntry[];
}

/** SFTP 浏览器使用的条目子集；完整路径来自服务器目录结果，不经过 Shell。 */
export interface RemoteMarkdownEntry {
  /** 目录内的展示名称。 */
  name: string;
  /** 当前服务器上的完整路径。 */
  path: string;
  /** 仅目录和普通 Markdown 文件进入选择列表。 */
  kind: "directory" | "file" | "symlink" | "other";
}

/** 一次目录读取的服务器规范化路径和直接子项。 */
export interface RemoteMarkdownDirectory {
  /** 服务器规范化后的当前目录。 */
  path: string;
  /** 当前目录的直接子项，选择器只放行目录和普通 Markdown。 */
  entries: RemoteMarkdownEntry[];
}

/** 拒绝浏览器预览调用原生文件读写，避免显示伪造的保存成功状态。 */
function requireDesktop(): void {
  if (!isTauri()) throw new Error("文件读写请使用 Rivet 桌面应用 / File access requires the Rivet desktop app");
}

/** 选择并读取本地文件；用户取消时返回 null。 */
export async function openLocal(): Promise<MarkdownFile | null> {
  requireDesktop();
  return invoke("markdown_open_local");
}

/** 选择本地文件夹并读取第一层；取消或失败不改变已有文档。 */
export async function openFolder(): Promise<LocalFolderDirectory | null> {
  requireDesktop();
  return invoke("markdown_open_folder");
}

/** 按需读取 root 内的普通目录 path；后端重新校验边界和链接。 */
export async function listFolder(root: string, path: string): Promise<LocalFolderDirectory> {
  requireDesktop();
  return invoke("markdown_list_folder", { root, path });
}

/** 在 root 根目录下创建单层文件夹 name；成功返回路径，同名文件或目录不会被覆盖。 */
export async function createFolder(root: string, name: string): Promise<string> {
  requireDesktop();
  return invoke("markdown_create_folder", { root, name });
}

/** 打开 root 文件树中选中的 Markdown path，失败交给页面显示并保留草稿。 */
export async function openFolderFile(root: string, path: string): Promise<MarkdownFile> {
  requireDesktop();
  return invoke("markdown_open_folder_file", { root, path });
}

/** 通过当前 SSH 会话读取 SFTP 文件；失败不改变已有草稿。 */
export async function openRemote(target: RemoteMarkdownTarget): Promise<MarkdownFile> {
  requireDesktop();
  return invoke("markdown_open_remote", { sessionId: target.sessionId, path: target.path });
}

/** 在已认证 SSH 上排他创建空 Markdown；失败不覆盖已有目标，超时需重新打开确认状态。 */
export async function createRemote(target: RemoteMarkdownTarget): Promise<MarkdownFile> {
  requireDesktop();
  return invoke("markdown_create_remote", { sessionId: target.sessionId, path: target.path });
}

/** 浏览已认证 SSH 的一层 SFTP 目录；断线、读取失败或超过一万项时拒绝替换当前列表。 */
export async function listRemoteDirectory(sessionId: string, path: string): Promise<RemoteMarkdownDirectory> {
  requireDesktop();
  const directory = await invoke<RemoteMarkdownDirectory>("sftp_list", { sessionId, path });
  if (directory.entries.length > MAX_DIRECTORY_ENTRIES) throw new Error("目录超过一万项，请选择更小的子目录 / Directory exceeds 10,000 entries; choose a smaller subfolder");
  return directory;
}

/** 保存 document 正文；saveAs 另存为本地副本，directory 仅指定对话框初始目录，null 结果表示取消。 */
export async function saveDocument(document: MarkdownDocument, saveAs = false, directory: string | null = null): Promise<MarkdownFile | null> {
  requireDesktop();
  if (document.remote && !saveAs) {
    if (!document.remote.sessionId) throw new Error("请从 SFTP 重新打开该文件以关联连接 / Reopen the file from SFTP to reconnect");
    return invoke("markdown_save_remote", { sessionId: document.remote.sessionId, path: document.path, content: document.content, revision: document.revision });
  }
  return invoke("markdown_save_local", { path: saveAs ? null : document.path, content: document.content, revision: saveAs ? null : document.revision, directory });
}
