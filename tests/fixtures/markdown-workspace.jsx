/** 只用于独立端口的前端集成验收；IPC 使用 Tauri 官方 mock，不连接真实服务器或写入本地文件。 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { Button, NotificationProvider } from "../../src/components/ui";
import MarkdownPage from "../../src/pages/MarkdownPage";
import "../../src/App.css";
import contentSample from "./markdown-content.md?raw";
import richSample from "./markdown-rich.md?raw";
import highlightSample from "./markdown-highlight.md?raw";

/** 两台模拟服务器具有相同路径，用于检查读取和保存是否始终绑定正确会话。 */
const sessions = [
  { sessionId: "test-a", connectionId: "server-a", sessionName: "测试服务器 A" },
  { sessionId: "test-b", connectionId: "server-b", sessionName: "测试服务器 B" },
];
/** 固定摘要只标识测试快照，真实摘要验证由 Rust 文件集成测试负责。 */
const revision = "a".repeat(43);
/** 记录最后一次保存请求，只有断言用的公开测试文本，不读取用户存储或凭据。 */
let lastSave = "尚未保存";
/** 已模拟保存的本地正文；同一页面内重新打开时回读，避免用固定样例代替持久化结果。 */
let savedLocalContent = null;
/** 模拟远程创建的文件路径，含会话标识以隔离不同服务器。 */
const remoteCreatedFiles = new Set();
/** 六十个章节让正文与目录均可独立滚动，用于验收上下阅读和收起后重新展开的跟随。 */
const outlineSample = Array.from({ length: 60 }, /** index 对应从一开始的章节号；每章含独立段落以形成真实正文滚动距离。 */ (_, index) => `## 章节 ${String(index + 1).padStart(2, "0")}\n\n${"目录应随当前阅读章节滚动，正文位置和输入焦点保持不变。\n\n".repeat(3)}`).join("\n");
/** 模拟本次页面会话创建的根目录子项；只保存在测试内存中。 */
const createdFolders = new Set();
Object.defineProperty(globalThis, "isTauri", { value: true, configurable: true });
mockIPC(/** command 和 args 是生产组件发出的真实 IPC 参数；未声明的请求直接失败。 */ async (command, args) => {
  if (command === "sftp_list") {
    // 固定生成上限加一项，验证超限结果被拒绝且不会替换已读取的目录。
    if (args.path === "/huge") return { path: args.path, entries: Array.from({ length: 10001 }, /** 每项都是普通文件，不递归生成目录。 */ (_, index) => ({ name: `${index}.md`, path: `/huge/${index}.md`, kind: "file" })) };
    if (args.path.endsWith("/denied")) throw new Error("测试：目录无读取权限");
    if (args.path === "/notes/empty") return { path: args.path, entries: [] };
    if (args.path === "/notes/sub") return { path: args.path, entries: [{ name: "child.md", path: "/notes/sub/child.md", kind: "file" }] };
    return { path: "/notes", entries: [
      { name: "sub", path: "/notes/sub", kind: "directory" },
      { name: "empty", path: "/notes/empty", kind: "directory" },
      { name: "denied", path: "/notes/denied", kind: "directory" },
      { name: "文档.md", path: "/notes/文档.md", kind: "file" },
      { name: "ignore.txt", path: "/notes/ignore.txt", kind: "file" },
      { name: "link.md", path: "/notes/link.md", kind: "symlink" },
    ] };
  }
  if (command === "markdown_create_remote") {
    const key = `${args.sessionId}:${args.path}`;
    if (remoteCreatedFiles.has(key) || args.path === "/notes/文档.md") throw new Error("文件已存在");
    remoteCreatedFiles.add(key);
    return { path: args.path, content: "", revision };
  }
  if (command === "markdown_open_remote") {
    return { path: args.path, content: `# ${args.sessionId === "test-a" ? "服务器 A" : "服务器 B"}\n\n远程正文\n`, revision };
  }
  if (command === "markdown_save_remote") {
    lastSave = `${args.sessionId} · ${args.path} · ${args.content}`;
    window.dispatchEvent(new Event("markdown-test-saved"));
    return { path: args.path, content: args.content, revision };
  }
  if (command === "markdown_open_local") return { path: "/test/local.md", content: savedLocalContent ?? (new URLSearchParams(location.search).get("sample") === "scrollbars" ? contentSample + "\n" + outlineSample : new URLSearchParams(location.search).get("sample") === "highlight" ? highlightSample : new URLSearchParams(location.search).get("sample") === "outline" ? outlineSample : new URLSearchParams(location.search).get("sample") === "rich" ? richSample : new URLSearchParams(location.search).has("sample") ? contentSample : "# 本地文件\n"), revision };
  if (command === "markdown_create_folder") {
    if (!args.name || /[\\/\u0000]/.test(args.name)) throw new Error("文件夹名称无效");
    if (createdFolders.has(args.name) || ["notes", "empty", "denied"].includes(args.name)) throw new Error("文件夹已存在");
    createdFolders.add(args.name);
    return `${args.root}/${args.name}`;
  }
  if (command === "markdown_open_folder" || command === "markdown_list_folder") {
    if (args?.path === "/test/folder/denied") throw new Error("测试：子目录无权限");
    if (args?.path === "/test/folder/notes") return { path: args.path, entries: [{ name: "child.md", path: `${args.path}/child.md`, kind: "file" }] };
    if (args?.path === "/test/folder/empty" || createdFolders.has(args?.path?.split("/").pop())) return { path: args.path, entries: [] };
    return { path: "/test/folder", entries: [
      { name: "denied", path: "/test/folder/denied", kind: "directory" },
      { name: "empty", path: "/test/folder/empty", kind: "directory" },
      { name: "notes", path: "/test/folder/notes", kind: "directory" },
      ...[...createdFolders].map(/** name 是测试命令接受的名称，每次刷新返回本会话创建的目录。 */ (name) => ({ name, path: `/test/folder/${name}`, kind: "directory" })),
      { name: "README.md", path: "/test/folder/README.md", kind: "file" },
      { name: "ignore.txt", path: "/test/folder/ignore.txt", kind: "file" },
      { name: "link.md", path: "/test/folder/link.md", kind: "symlink" },
    ] };
  }
  if (command === "markdown_open_folder_file") return { path: args.path, content: `# ${args.path.endsWith("child.md") ? "子目录正文" : "文件夹正文"}\n`, revision };
  if (command === "markdown_save_local") {
    if (args.path === "/test/local.md") savedLocalContent = args.content;
    lastSave = `local · ${args.path ?? "/test/copy.md"} · ${args.content}`;
    window.dispatchEvent(new Event("markdown-test-saved"));
    return { path: args.path ?? "/test/copy.md", content: args.content, revision };
  }
  throw new Error(`未定义测试 IPC：${command}`);
});

/** 渲染生产页面、真实标题栏宿主和已连接会话；verify 参数才显示保存回读。 */
function WorkspaceFixture() {
  /** 查询参数只控制隔离预览，不写入用户设置。 */
  const options = new URLSearchParams(window.location.search);
  const locale = options.get("locale") === "en" ? "en" : "zh";
  /** 可选测试按钮模拟应用原位切换主题，不重建 Markdown 页。 */
  const [theme, setTheme] = useState(options.get("theme") === "dark" ? "dark" : "light");
  const [host, setHost] = useState(null);
  const [saved, setSaved] = useState(lastSave);
  React.useEffect(() => {
    /** 只有模拟后端接受保存后才更新验收输出。 */
    const update = () => setSaved(lastSave);
    window.addEventListener("markdown-test-saved", update);
    return () => window.removeEventListener("markdown-test-saved", update);
  }, []);
  return <div className="app-shell rivet-ui" data-theme={theme} data-font={options.get("font") === "system" ? "system" : "builtin"} style={options.has("narrow") ? { width: 680, maxWidth: "100vw" } : undefined}>
    <NotificationProvider locale={locale}>
    <header className="app-titlebar"><div ref={setHost} className="app-titlebar-host app-titlebar-markdown-host" /></header>
    <div style={{ minHeight: 0 }}><MarkdownPage locale={locale} pageActive remoteRequest={null} remoteSessions={options.has("noSessions") ? [] : sessions} titlebarHost={host} onRequestTerminal={/** 测试不启动本机终端；无连接场景只验证引导和关闭。 */ () => { throw new Error("测试不应请求终端"); }} /></div>
    </NotificationProvider>
    <output hidden={!options.has("verify")} style={{ position: "fixed", bottom: 0, left: 24, fontSize: 11 }} aria-label="保存目标">{saved}</output>
    {options.has("themeToggle") && <Button style={{ position: "fixed", bottom: 12, right: 20 }} onClick={/** 仅切换当前测试页面的属性，不写入应用偏好。 */ () => setTheme(theme === "light" ? "dark" : "light")}>切换测试主题</Button>}
  </div>;
}

createRoot(document.getElementById("root")).render(<WorkspaceFixture />);
