/** 独立 VNC 页面：管理自己的连接、分组、最近记录、标签与桌面会话。 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Button, HorizontalScrollbar, Input, SvgIcon } from "../components/ui";
import {
  closeSession,
  loadPassword,
  openSession,
  savePassword,
} from "./vnc/api";
import {
  copyConnection,
  isVncPassword,
  MAX_CONNECTIONS,
  MAX_RECENT,
  MAX_SESSIONS,
  parseConnections,
  parseOrder,
  serializeConnections,
  VNC_CONNECTIONS_KEY,
  VNC_GROUPS_KEY,
  VNC_RECENT_KEY,
  type VncConnection,
  type VncState,
} from "./vnc/model";
import VncConnections from "./vnc/VncConnections";
import VncViewport from "./vnc/VncViewport";
import "./vnc/vnc.css";

/** 单次会话拥有稳定的配置快照，编辑连接不修改已建立的桌面。 */
interface Session {
  /** 本次运行唯一 ID，重连后替换，不能复用旧 socket 的状态。 */
  id: string;
  /** 连接建立时复制的配置，活动会话不受列表编辑影响。 */
  connection: VncConnection;
  /** 后端报告的连接阶段，决定取帧和重连入口是否可用。 */
  state: VncState;
  /** 此会话的可见错误，成功重连后清除，不持久化。 */
  error: string;
  /** 后端已注册后才能挂载取帧组件，避免首次 IPC 竞态。 */
  ready: boolean;
}

/** 每个标签只引用一个 VNC 会话；标签和会话均不持久化。 */
interface Tab {
  /** 标签稳定标识，重连时保持不变。 */
  id: string;
  /** 所属会话 ID；重连时替换，关闭会话时同时移除标签。 */
  sessionId: string;
}

/** VNC 页面仅依赖应用语言、可见性与标题栏宿主。 */
interface VncPageProps {
  locale: "zh" | "en";
  pageActive: boolean;
  /** 页面切换时宿主保持挂载，VNC 标签不随页面隐藏而丢失。 */
  titlebarHost: HTMLDivElement | null;
}

/** 一次性读取 VNC 本机数据；损坏时保留原内容并禁用覆盖，错误显示在页面。 */
function readLibrary() {
  try {
    return {
      connections: parseConnections(localStorage.getItem(VNC_CONNECTIONS_KEY)),
      groups: parseOrder(localStorage.getItem(VNC_GROUPS_KEY)),
      recent: parseOrder(localStorage.getItem(VNC_RECENT_KEY)).slice(
        0,
        MAX_RECENT,
      ),
      error: "",
    };
  } catch (error) {
    return {
      connections: [] as VncConnection[],
      groups: [] as string[],
      recent: [] as string[],
      error: String(error),
    };
  }
}

/** 展示独立 VNC 连接和会话；共享基础 UI 组件，业务状态始终留在本模块。 */
export default function VncPage({
  locale,
  pageActive,
  titlebarHost,
}: VncPageProps) {
  const zh = locale === "zh";
  const [initial] = useState(readLibrary);
  const [connections, setConnections] = useState(initial.connections);
  const [groupOrder, setGroupOrder] = useState(initial.groups);
  const [recent, setRecent] = useState(initial.recent);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [error, setError] = useState(initial.error);
  /** 待认证连接和可选重连目标，只保留到提交或取消。 */
  const [prompt, setPrompt] = useState<{
    connection: VncConnection;
    replacing?: string;
  } | null>(null);
  const [password, setPassword] = useState("");
  /** 不保存密码的连接只在当前页面生命周期缓存，卸载时清空。 */
  const passwords = useRef(new Map<string, string>());
  /** 同步引用用于限制连续点击的并发数，避免 React 更新前重复分配会话。 */
  const sessionsRef = useRef<Session[]>([]);
  const connectionsRef = useRef(connections);
  const operation = useRef(false);
  const alive = useRef(true);
  const groups = [
    ...new Set([
      ...groupOrder.filter((name) =>
        connections.some((item) => item.group === name),
      ),
      ...connections.map((item) => item.group),
    ]),
  ];

  /** 关闭当前标签后选择仍然存在的最后一个标签，不在状态更新器中触发另一状态写入。 */
  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTab))
      setActiveTab(tabs.at(-1)?.id ?? "");
  }, [tabs, activeTab]);

  /** 更新会话状态；像素轮询返回相同状态时不触发页面重新渲染。 */
  const updateState = useCallback(
    (id: string, state: VncState, message: string) => {
      if (!alive.current) return;
      const previous = sessionsRef.current.find((session) => session.id === id);
      if (!previous || (previous.state === state && previous.error === message))
        return;
      sessionsRef.current = sessionsRef.current.map((session) =>
        session.id === id ? { ...session, state, error: message } : session,
      );
      setSessions(sessionsRef.current);
    },
    [],
  );

  /** 页面真正卸载时关闭全部 VNC 资源；普通导航切换只隐藏页面。 */
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      passwords.current.clear();
      for (const session of sessionsRef.current)
        void closeSession(session.id).catch((cause: unknown) =>
          console.error("卸载 VNC 会话失败", cause),
        );
    };
  }, []);

  /** 关闭连接浮层，不改变已连接桌面。 */
  const closePanel = useCallback(() => {
    setPanelOpen(false);
  }, []);

  /** 在秘密保存成功后提交配置；浏览器写入失败时恢复旧秘密，两个存储均保留错误上下文。 */
  const saveConnection = async (
    connection: VncConnection,
    secret: string,
    remember: boolean,
  ) => {
    if (initial.error || operation.current)
      throw new Error(
        zh ? "VNC 配置当前不可写" : "VNC configuration is not writable",
      );
    operation.current = true;
    const before = connectionsRef.current;
    try {
      const next = before.some((item) => item.id === connection.id)
        ? before.map((item) =>
            item.id === connection.id ? copyConnection(connection) : item,
          )
        : [...before, copyConnection(connection)];
      if (next.length > MAX_CONNECTIONS)
        throw new Error(
          zh ? "VNC 连接已达上限" : "VNC connection limit reached",
        );
      const serialized = serializeConnections(next);
      const oldPassword = await loadPassword(connection.id);
      await savePassword(
        connection.id,
        connection.authType !== "none" && remember ? secret : "",
      );
      try {
        localStorage.setItem(VNC_CONNECTIONS_KEY, serialized);
      } catch (cause) {
        try {
          await savePassword(connection.id, oldPassword);
        } catch (rollback) {
          throw new Error(
            `${String(cause)}; ${zh ? "恢复旧密码失败" : "Password rollback failed"}: ${String(rollback)}`,
          );
        }
        throw cause;
      }
      if (connection.authType !== "none" && !remember)
        passwords.current.set(connection.id, secret);
      else passwords.current.delete(connection.id);
      connectionsRef.current = next;
      setConnections(next);
      setError("");
    } finally {
      operation.current = false;
    }
  };

  /** 删除单条配置后删除其 VNC 密码；凭据删除失败时恢复连接 JSON，活动会话不变。 */
  const deleteConnection = async (connection: VncConnection) => {
    if (initial.error || operation.current)
      throw new Error(
        zh ? "VNC 配置当前不可写" : "VNC configuration is not writable",
      );
    operation.current = true;
    const before = connectionsRef.current;
    try {
      const next = before.filter((item) => item.id !== connection.id);
      localStorage.setItem(VNC_CONNECTIONS_KEY, serializeConnections(next));
      try {
        await savePassword(connection.id, "");
      } catch (cause) {
        try {
          localStorage.setItem(
            VNC_CONNECTIONS_KEY,
            serializeConnections(before),
          );
        } catch (rollback) {
          throw new Error(
            `${String(cause)}; ${zh ? "恢复连接失败" : "Connection rollback failed"}: ${String(rollback)}`,
          );
        }
        throw cause;
      }
      passwords.current.delete(connection.id);
      connectionsRef.current = next;
      setConnections(next);
    } finally {
      operation.current = false;
    }
  };

  /** 创建新会话，或使用新 ID 原位替换失败会话；先注册再挂载桌面消费者。 */
  const start = async (
    connection: VncConnection,
    secret?: string,
    replacing?: string,
  ) => {
    if (!replacing && sessionsRef.current.length >= MAX_SESSIONS) {
      setError(
        zh
          ? "最多同时打开四个 VNC 桌面"
          : "Up to four VNC desktops can be opened",
      );
      return;
    }
    const id = crypto.randomUUID();
    if (replacing) await closeSession(replacing);
    const session: Session = {
      id,
      connection: copyConnection(connection),
      state: "connecting",
      error: "",
      ready: false,
    };
    sessionsRef.current = replacing
      ? sessionsRef.current.map((item) =>
          item.id === replacing ? session : item,
        )
      : [...sessionsRef.current, session];
    setSessions(sessionsRef.current);
    if (replacing)
      setTabs(/** 将重连会话关联到原标签。 */ (current) =>
        current.map(/** 保留标签 ID，只替换对应的会话引用。 */ (tab) => ({
          ...tab,
          sessionId: tab.sessionId === replacing ? id : tab.sessionId,
        })),
      );
    else {
      setTabs(/** 新会话始终追加独立标签。 */ (current) => [...current, { id, sessionId: id }]);
      setActiveTab(id);
    }
    closePanel();
    setError("");
    try {
      await openSession(id, connection, secret);
      // 用户可能在注册 IPC 返回前关闭标签或卸载页面，迟到的资源立即关闭。
      if (
        !alive.current ||
        !sessionsRef.current.some((item) => item.id === id)
      ) {
        await closeSession(id);
        return;
      }
      sessionsRef.current = sessionsRef.current.map((item) =>
        item.id === id ? { ...item, ready: true } : item,
      );
      setSessions(sessionsRef.current);
      const nextRecent = [
        connection.id,
        ...recent.filter((item) => item !== connection.id),
      ].slice(0, MAX_RECENT);
      try {
        localStorage.setItem(VNC_RECENT_KEY, JSON.stringify(nextRecent));
        setRecent(nextRecent);
      } catch (cause) {
        setError(String(cause));
      }
    } catch (cause) {
      updateState(id, "error", String(cause));
    }
  };

  /** 读取连接专属密码；没有保存秘密时显示短期输入弹窗，不写入本机配置。 */
  const connect = async (connection: VncConnection, replacing?: string) => {
    if (operation.current) return;
    operation.current = true;
    try {
      const secret =
        connection.authType !== "none"
          ? (passwords.current.get(connection.id) ??
            (await loadPassword(connection.id)))
          : "";
      if (connection.authType !== "none" && !secret) {
        setPassword("");
        setPrompt({ connection, replacing });
        return;
      }
      await start(connection, secret, replacing);
    } catch (cause) {
      setError(String(cause));
    } finally {
      operation.current = false;
    }
  };

  /** 临时认证只用于本次连接，提交后清除弹窗密码。 */
  const authenticate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      operation.current || !prompt ||
      !isVncPassword(password, prompt.connection.authType)
    )
      return;
    operation.current = true;
    const pending = prompt,
      secret = password;
    setPrompt(null);
    setPassword("");
    void start(pending.connection, secret, pending.replacing)
      .catch((cause: unknown) => setError(String(cause)))
      .finally(() => {
        operation.current = false;
      });
  };

  /** 临时认证弹窗内循环 Tab 焦点，Escape 清除密码并返回原页面。 */
  const handleAuthKeys = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setPrompt(null);
      setPassword("");
      return;
    }
    if (event.key !== "Tab") return;
    const fields = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        "input:not(:disabled),button:not(:disabled)",
      ),
    );
    const first = fields[0],
      last = fields.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  /** 先关闭后端再移除会话及标签；id 为会话 ID，失败保留桌面和错误状态。 */
  const closeTab = async (id: string) => {
    try {
      await closeSession(id);
      sessionsRef.current = sessionsRef.current.filter(
        (item) => item.id !== id,
      );
      setSessions(sessionsRef.current);
      setTabs(/** 后端关闭成功后移除对应标签。 */ (current) =>
        current.filter(/** 其余会话的标签保持不变。 */ (tab) => tab.sessionId !== id),
      );
    } catch (cause) {
      updateState(id, "error", String(cause));
    }
  };

  /** 保存独立 VNC 分组顺序；写盘失败不改变当前顺序。 */
  const reorder = (order: string[]) => {
    try {
      localStorage.setItem(VNC_GROUPS_KEY, JSON.stringify(order));
      setGroupOrder(order);
    } catch (cause) {
      setError(String(cause));
    }
  };

  /** 打开连接面板，新连接始终使用独立标签。 */
  const showConnections = () => {
    setPanelOpen(true);
  };

  const tabbar = (
    <div className="vnc-tabbar">
      <HorizontalScrollbar height={35} className="vnc-tabs" hideTrack>
        <div className="vnc-tabs-row">
          {tabs.map(/** 绘制单会话标签的名称和关闭入口。 */ (tab) => {
            const session = sessions.find(
              /** 按会话 ID 读取当前连接快照。 */ (item) => item.id === tab.sessionId,
            );
            return (
              <div
                key={tab.id}
                className={`vnc-tab${activeTab === tab.id ? " active" : ""}`}
              >
                <button
                  type="button"
                  className="vnc-tab-main"
                  onClick={() => setActiveTab(tab.id)}
                  title={session?.connection.name}
                >
                  <SvgIcon name="vnc" size={14} />
                  <span>{session?.connection.name}</span>
                </button>
                <button
                  type="button"
                  className="vnc-icon-button"
                  aria-label={zh ? "关闭标签" : "Close tab"}
                  onClick={/** 关闭此标签对应的唯一会话。 */ () => {
                    void closeTab(tab.sessionId);
                  }}
                >
                  <SvgIcon name="close" size={12} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="vnc-new-tab vnc-icon-button"
            title={zh ? "新建连接" : "New connection"}
            aria-label={zh ? "新建连接" : "New connection"}
            onClick={() => showConnections()}
          >
            <SvgIcon name="plus" />
          </button>
        </div>
      </HorizontalScrollbar>
    </div>
  );

  return (
    <div className="vnc-page">
      {titlebarHost ? createPortal(tabbar, titlebarHost) : tabbar}
      {error && (
        <div className="vnc-page-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="vnc-icon-button"
            aria-label={zh ? "关闭提示" : "Dismiss"}
            onClick={() => setError("")}
          >
            <SvgIcon name="close" size={12} />
          </button>
        </div>
      )}
      <div className="vnc-workspace">
        {!tabs.length && (
          <div className="vnc-empty">
            <SvgIcon name="vnc" size={44} />
            <strong>{zh ? "VNC 远程桌面" : "VNC remote desktop"}</strong>
          </div>
        )}
        {tabs.map(/** 每个标签只挂载自己的桌面，非活动标签保持隐藏。 */ (tab) => {
          const session = sessions.find(/** 跳过已移除的会话。 */ (item) => item.id === tab.sessionId);
          if (!session) return null;
          const id = session.id;
          return (
            <div
              key={tab.id}
              hidden={activeTab !== tab.id}
              className="vnc-tab-content"
            >
              <section
                key={id}
                className="vnc-pane"
                aria-label={session.connection.name}
              >
                {session.ready && (
                  <VncViewport
                    sessionId={id}
                    locale={locale}
                    readOnly={session.connection.readOnly}
                    active={
                      pageActive &&
                      activeTab === tab.id &&
                      (session.state === "connecting" ||
                        session.state === "connected")
                    }
                    onState={updateState}
                  />
                )}
                {session.state !== "connected" && (
                  <div className="vnc-session-status" role="status">
                    <strong>
                      {session.state === "connecting"
                        ? zh
                          ? "连接中…"
                          : "Connecting…"
                        : session.state === "closed"
                          ? zh
                            ? "连接已关闭"
                            : "Connection closed"
                          : zh
                            ? "连接失败"
                            : "Connection failed"}
                    </strong>
                    {session.error && <span>{session.error}</span>}
                    {(session.state === "error" ||
                      session.state === "closed") && (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          void connect(session.connection, id);
                        }}
                      >
                        <SvgIcon name="retry" size={14} />
                        {zh ? "重连" : "Reconnect"}
                      </Button>
                    )}
                  </div>
                )}
                {session.state === "connected" && session.error && (
                  <div className="vnc-error" role="alert">
                    {session.error}
                  </div>
                )}
              </section>
            </div>
          );
        })}
        {panelOpen && (
          <VncConnections
            locale={locale}
            connections={connections}
            groups={groups}
            recent={recent}
            onClose={closePanel}
            onConnect={(connection) => {
              void connect(connection);
            }}
            onSave={saveConnection}
            onDelete={deleteConnection}
            onOrder={reorder}
            writable={!initial.error}
          />
        )}
      </div>
      <footer className="vnc-bottom-toolbar">
        <button
          type="button"
          className={`vnc-connection-toggle${panelOpen ? " active" : ""}`}
          aria-expanded={panelOpen}
          onClick={() => {
            if (panelOpen) closePanel();
            else showConnections();
          }}
        >
          <SvgIcon name="list" size={15} />
          {zh ? "连接管理" : "Connections"}
        </button>
      </footer>
      {prompt && (
        <div className="vnc-modal-backdrop">
          <form
            className="vnc-auth-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="vnc-auth-title"
            onSubmit={authenticate}
            onKeyDown={handleAuthKeys}
          >
            <strong id="vnc-auth-title">{prompt.connection.name}</strong>
            <label className="vnc-field">
              <span>
                {prompt.connection.authType === "apple"
                  ? zh ? "macOS 密码" : "macOS password"
                  : zh ? "VNC 密码" : "VNC password"}
              </span>
              <Input
                autoFocus
                type="password"
                autoComplete="off"
                maxLength={prompt.connection.authType === "apple" ? 63 : 8}
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
              />
            </label>
            <footer>
              <Button
                variant="secondary"
                type="button"
                onClick={() => {
                  setPrompt(null);
                  setPassword("");
                }}
              >
                {zh ? "取消" : "Cancel"}
              </Button>
              <Button
                type="submit"
                disabled={!isVncPassword(password, prompt.connection.authType)}
              >
                {zh ? "连接" : "Connect"}
              </Button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
}
