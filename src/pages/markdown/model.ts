/** Markdown 文档和草稿格式；只保存在本机，不参与连接配置同步。 */

/** 与后端一致的正文上限，单位为 UTF-8 字节。 */
export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
/** 同时保留最多八份文档，限制编辑器和草稿内存。 */
export const MAX_OPEN_DOCUMENTS = 8;
/** 单层远程目录和文件树缓存最多保留一万项，限制前端列表与展开树的内存。 */
export const MAX_DIRECTORY_ENTRIES = 10_000;
/** 本机未保存草稿的专用存储键，不含服务器密码。 */
export const DRAFT_STORAGE_KEY = "rivet.markdownDrafts";
/** 草稿 JSON 最多三 MiB 字符；存储空间不足时界面明确报错。 */
const MAX_DRAFT_CHARACTERS = 3 * 1024 * 1024;

/** 从 SFTP 文件列表传入的打开目标；连接标识稳定，会话标识仅本次连接有效。 */
export interface RemoteMarkdownTarget {
  /** 当前已认证 SSH 会话，重连后必须更新。 */
  sessionId: string;
  /** 连接库中的稳定标识，用于重连后关联同一份草稿。 */
  connectionId: string;
  /** 只用于展示的服务器名称。 */
  sessionName: string;
  /** 服务器文件的完整路径。 */
  path: string;
}

/** 已连接 SSH 会话的只读身份快照，不含密码或私钥；只在应用进程中共享。 */
export type RemoteMarkdownSession = Omit<RemoteMarkdownTarget, "path">;

/** 后端返回的原始文件快照，摘要对应未经格式化的 UTF-8 内容。 */
export interface MarkdownFile {
  /** 后端确认的完整文件路径。 */
  path: string;
  /** 不改变换行和 BOM 的原始 UTF-8 正文，允许为空。 */
  content: string;
  /** 与正文原始字节对应的 SHA-256 摘要。 */
  revision: string;
}

/** 一份已打开文档；切换导航或文档不会丢弃正文，远程会话不写入草稿。 */
export interface MarkdownDocument {
  /** 当前编辑会话内的唯一标识，用于隔离异步结果。 */
  id: string;
  /** null 表示尚未保存到文件的新文档。 */
  path: string | null;
  /** null 表示本地文档；恢复草稿后 sessionId 为空，需从 SFTP 重新关联。 */
  remote: RemoteMarkdownTarget | null;
  /** 最新正文；只在真实编辑后发生 Markdown 格式归一化。 */
  content: string;
  /** 最后一次成功读取或保存的原始正文。 */
  savedContent: string;
  /** null 表示新文档，否则用于检测外部修改。 */
  revision: string | null;
}

/** 判断文件名是否可用 Markdown 编辑器打开，不接受目录或任意扩展名。 */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path) && !path.includes("\0");
}

/** 创建空白草稿；使用随机标识，重复新建不会复用旧编辑状态。 */
export function newDocument(): MarkdownDocument {
  return { id: crypto.randomUUID(), path: null, remote: null, content: "", savedContent: "", revision: null };
}

/** 返回待保存状态；尚未命名的空白文档无需恢复。 */
export function isDocumentDirty(document: MarkdownDocument): boolean {
  return document.content !== document.savedContent;
}

/** 编码未保存正文；不保存活动会话，恢复后需重新关联 SSH 连接。 */
export function serializeDrafts(documents: MarkdownDocument[]): string {
  if (documents.some(/** 超限或二进制正文保留在内存，不能生成无法恢复或保存的草稿。 */ (document) => new TextEncoder().encode(document.content).length > MAX_MARKDOWN_BYTES || document.content.includes("\0"))) {
    throw new Error("正文超过 2 MiB 或包含二进制内容，草稿未落盘 / Content exceeds 2 MiB or contains binary data; draft was not stored");
  }
  const drafts = documents.filter(isDocumentDirty).map(/** 仅落盘恢复编辑所需的字段。 */ (document) => ({
    ...document,
    remote: document.remote ? { ...document.remote, sessionId: "" } : null,
  }));
  const value = JSON.stringify(drafts);
  if (value.length > MAX_DRAFT_CHARACTERS) throw new Error("草稿超出本机存储上限，请保存文件 / Draft storage limit reached; save your files");
  return value;
}

/** 从不可信本机 JSON 恢复有限数量的草稿，拒绝异常类型、重复 ID 和超限正文。 */
export function deserializeDrafts(value: string | null): MarkdownDocument[] {
  if (!value) return [];
  if (value.length > MAX_DRAFT_CHARACTERS) throw new Error("草稿过大 / Drafts are too large");
  const drafts: unknown = JSON.parse(value);
  if (!Array.isArray(drafts) || drafts.length > MAX_OPEN_DOCUMENTS) throw new Error("草稿格式无效 / Invalid drafts");
  const ids = new Set<string>();
  for (const draft of drafts) {
    if (!draft || typeof draft !== "object" || typeof draft.id !== "string" || !draft.id || ids.has(draft.id)
      || (draft.path !== null && (typeof draft.path !== "string" || draft.path.length > 4096 || !isMarkdownPath(draft.path)))
      || typeof draft.content !== "string" || typeof draft.savedContent !== "string" || draft.content.includes("\0") || draft.savedContent.includes("\0")
      || (draft.path === null) !== (draft.revision === null)
      || new TextEncoder().encode(draft.content).length > MAX_MARKDOWN_BYTES
      || new TextEncoder().encode(draft.savedContent).length > MAX_MARKDOWN_BYTES
      || (draft.revision !== null && (typeof draft.revision !== "string" || !/^[\w-]{43}$/.test(draft.revision)))) {
      throw new Error("草稿格式无效 / Invalid drafts");
    }
    if (draft.remote !== null && (!draft.remote || typeof draft.remote !== "object"
      || typeof draft.remote.connectionId !== "string" || !draft.remote.connectionId || draft.remote.connectionId.length > 128
      || typeof draft.remote.sessionName !== "string" || draft.remote.sessionName.length > 4096
      || draft.remote.path !== draft.path)) throw new Error("远程草稿格式无效 / Invalid remote draft");
    if (draft.remote) draft.remote.sessionId = "";
    ids.add(draft.id);
  }
  return drafts as MarkdownDocument[];
}

/** 使用明确的协议白名单展示图片，禁止脚本、SVG 和任意本机协议；原链接仍保存在正文。 */
export function safeImageUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(url) && url.length <= MAX_MARKDOWN_BYTES) return url;
  return "";
}
