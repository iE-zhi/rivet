/** VNC 专用连接面板；沿用终端的浮层、分组和表单交互，不读取终端配置。 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Button,
  Checkbox,
  GroupManager,
  Input,
  PopupMenu,
  PopupMenuItem,
  SearchInput,
  Select,
  SvgIcon,
  VerticalScrollbar,
} from "../../components/ui";
import { loadPassword } from "./api";
import { DEFAULT_VNC_PORT, isVncConnection, type VncConnection } from "./model";

/** 表单只在组件内暂存密码；取消、保存或卸载时清空。 */
interface Draft {
  /** 被编辑的配置；新建时生成独立 UUID。 */
  connection: VncConnection;
  /** 端口编辑文本，提交时转换为整数并校验。 */
  port: string;
  /** 运行时密码，不参与连接 JSON。 */
  password: string;
  /** 用户允许将密码交给后端加密保存。 */
  remember: boolean;
}

/** 面板依赖均由独立 VNC 页面提供，没有 SSH 模型或回调。 */
interface VncConnectionsProps {
  /** 应用当前语言，独立面板不修改应用偏好。 */
  locale: "zh" | "en";
  /** 只读使用的连接列表；编辑时复制到表单，保存后交给页面提交。 */
  connections: VncConnection[];
  /** 由页面整理后的完整分组顺序，分组名称同时作为排序 ID。 */
  groups: string[];
  /** 最近使用的独立 VNC 连接 ID，缺失连接在显示时过滤。 */
  recent: string[];
  /** 关闭浮层，不关闭已建立的会话。 */
  onClose: () => void;
  /** 双击或菜单连接时创建新 VNC 会话。 */
  onConnect: (connection: VncConnection) => void;
  /** 保存完整配置和可选密码；失败时原记录仍可继续编辑。 */
  onSave: (
    connection: VncConnection,
    password: string,
    remember: boolean,
  ) => Promise<void>;
  /** 删除记录和独立 VNC 凭据，不操作活动桌面。 */
  onDelete: (connection: VncConnection) => Promise<void>;
  /** 保存独立 VNC 分组顺序。 */
  onOrder: (groups: string[]) => void;
  /** 存储损坏时禁用写入，避免覆盖原始配置。 */
  writable: boolean;
}

/** 绘制独立连接浮层，支持搜索、最近连接、分组排序、编辑和确认删除。 */
export default function VncConnections({
  locale,
  connections,
  groups,
  recent,
  onClose,
  onConnect,
  onSave,
  onDelete,
  onOrder,
  writable,
}: VncConnectionsProps) {
  const zh = locale === "zh";
  const [draft, setDraft] = useState<Draft | null>(null);
  const [search, setSearch] = useState("");
  const [manage, setManage] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 每次编辑请求的代次；迟到的凭据读取不得覆盖用户已打开的另一表单。 */
  const generation = useRef(0);
  const rootRef = useRef<HTMLElement>(null);

  /** 点击菜单外部或按 Escape 时关闭菜单；编辑中保留表单，防止意外丢失内容。 */
  useEffect(() => {
    /** event 为页面指针事件，只有菜单外部点击会改变菜单状态。 */
    const outside = (event: globalThis.PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".vnc-row-actions")
      )
        setMenu(null);
    };
    /** Escape 先关闭行菜单，其次关闭面板；忙碌时保留当前操作。 */
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      if (menu) setMenu(null);
      else if (!draft) onClose();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [busy, draft, menu, onClose]);

  /** 卸载时让所有在途的凭据读取失效，不保留密码引用。 */
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  /** 新建空配置，默认采用密码认证；名称和分组随当前语言初始化。 */
  const create = () => {
    generation.current += 1;
    setError("");
    setManage(false);
    setDraft({
      connection: {
        id: crypto.randomUUID(),
        name: "",
        group: groups[0] ?? (zh ? "默认分组" : "Default"),
        host: "",
        port: DEFAULT_VNC_PORT,
        authType: "password",
        readOnly: false,
      },
      port: String(DEFAULT_VNC_PORT),
      password: "",
      remember: true,
    });
  };

  /** 加载当前连接的加密密码，读取失败时不打开一个会覆盖秘密的空表单。 */
  const edit = async (connection: VncConnection) => {
    const ticket = ++generation.current;
    setBusy(true);
    setMenu(null);
    setError("");
    try {
      const password = await loadPassword(connection.id);
      if (generation.current === ticket)
        setDraft({
          connection: { ...connection },
          port: String(connection.port),
          password,
          remember: Boolean(password),
        });
    } catch (cause) {
      if (generation.current === ticket) setError(String(cause));
    } finally {
      if (generation.current === ticket) setBusy(false);
    }
  };

  /** 只修改被命名的配置字段，密码留在独立运行时字段中。 */
  const update = (field: keyof VncConnection, value: string | boolean) => {
    setDraft((current) =>
      current
        ? { ...current, connection: { ...current.connection, [field]: value } }
        : null,
    );
  };

  /** 校验后保存；await 失败时保留用户表单和密码，允许修改后重试。 */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || busy) return;
    const connection = {
      ...draft.connection,
      name: draft.connection.name.trim(),
      group: draft.connection.group.trim(),
      host: draft.connection.host.trim(),
      port: Number(draft.port),
    };
    if (!/^\d+$/u.test(draft.port) || !isVncConnection(connection)) {
      setError(
        zh
          ? "请检查名称、分组、主机和端口"
          : "Check name, group, host and port",
      );
      return;
    }
    if (
      connection.authType === "password" &&
      (!draft.password || !/^[\x20-\x7e]{1,8}$/u.test(draft.password))
    ) {
      setError(
        zh
          ? "标准 VNC 密码为 1–8 个 ASCII 字符"
          : "Standard VNC passwords require 1–8 ASCII characters",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave(connection, draft.password, draft.remember);
      setDraft(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  /** 用户确认后删除单条配置；失败显示错误并保留确认区域。 */
  const remove = async (connection: VncConnection) => {
    setBusy(true);
    setError("");
    try {
      await onDelete(connection);
      setDeleting(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  /** 生成可键盘聚焦的连接行；菜单与右键菜单使用同一共享浮层组件。 */
  const row = (connection: VncConnection, prefix: string) => (
    <div
      key={`${prefix}-${connection.id}`}
      className="vnc-connection-row"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu(`${prefix}-${connection.id}`);
      }}
    >
      <button
        type="button"
        className="vnc-connection-main"
        disabled={busy}
        title={`${connection.host}:${connection.port}`}
        onDoubleClick={() => onConnect(connection)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onConnect(connection);
          }
        }}
      >
        <SvgIcon name="vnc" size={18} />
        <span>
          <strong>{connection.name}</strong>
          <small>
            {connection.host}:{connection.port}
          </small>
        </span>
      </button>
      <div className="vnc-row-actions">
        <button
          type="button"
          className="vnc-icon-button"
          disabled={busy}
          aria-label={zh ? "连接操作" : "Connection actions"}
          onClick={() =>
            setMenu(
              menu === `${prefix}-${connection.id}`
                ? null
                : `${prefix}-${connection.id}`,
            )
          }
        >
          <SvgIcon name="more" />
        </button>
        <PopupMenu open={menu === `${prefix}-${connection.id}`} width={150}>
          <PopupMenuItem
            onClick={() => {
              setMenu(null);
              onConnect(connection);
            }}
          >
            {zh ? "连接" : "Connect"}
          </PopupMenuItem>
          <PopupMenuItem
            disabled={!writable || busy}
            onClick={() => {
              void edit(connection);
            }}
          >
            {zh ? "编辑" : "Edit"}
          </PopupMenuItem>
          <PopupMenuItem
            danger
            disabled={!writable || busy}
            onClick={() => {
              setMenu(null);
              setDeleting(`${prefix}-${connection.id}`);
            }}
          >
            {zh ? "删除" : "Delete"}
          </PopupMenuItem>
        </PopupMenu>
      </div>
      {deleting === `${prefix}-${connection.id}` && (
        <div className="vnc-delete-confirm">
          <span>{zh ? "删除此连接？" : "Delete this connection?"}</span>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              void remove(connection);
            }}
          >
            {zh ? "删除" : "Delete"}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setDeleting(null)}
          >
            {zh ? "取消" : "Cancel"}
          </Button>
        </div>
      )}
    </div>
  );

  const query = search.trim().toLocaleLowerCase();
  const filtered = connections.filter((item) =>
    `${item.name}\n${item.host}\n${item.group}`
      .toLocaleLowerCase()
      .includes(query),
  );
  return (
    <aside
      ref={rootRef}
      className="vnc-connections"
      aria-label={zh ? "VNC 连接管理" : "VNC connections"}
    >
      <header>
        <strong>
          {draft
            ? connections.some((item) => item.id === draft.connection.id)
              ? zh
                ? "编辑连接"
                : "Edit connection"
              : zh
                ? "新建连接"
                : "New connection"
            : manage
              ? zh
                ? "分组排序"
                : "Group order"
              : zh
                ? "VNC 连接"
                : "VNC connections"}
        </strong>
        <div>
          {!draft && (
            <>
              <button
                type="button"
                className="vnc-icon-button"
                aria-label={zh ? "分组排序" : "Group order"}
                disabled={!writable || busy}
                onClick={() => setManage((value) => !value)}
              >
                <SvgIcon name="group" />
              </button>
              <button
                type="button"
                className="vnc-icon-button"
                aria-label={zh ? "新建连接" : "New connection"}
                disabled={!writable || busy}
                onClick={create}
              >
                <SvgIcon name="plus" />
              </button>
            </>
          )}
          <button
            type="button"
            className="vnc-icon-button"
            disabled={busy}
            aria-label={zh ? "关闭连接面板" : "Close connections"}
            onClick={onClose}
          >
            <SvgIcon name="close" />
          </button>
        </div>
      </header>
      {error && (
        <div className="vnc-error" role="alert">
          {error}
        </div>
      )}
      {draft ? (
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
          className="vnc-connection-form"
        >
          <VerticalScrollbar height="100%">
            <div className="vnc-fields">
              <label className="vnc-field">
                <span>{zh ? "名称" : "Name"}</span>
                <Input
                  autoFocus
                  maxLength={128}
                  value={draft.connection.name}
                  disabled={busy}
                  onChange={(event) =>
                    update("name", event.currentTarget.value)
                  }
                />
              </label>
              <label className="vnc-field">
                <span>{zh ? "分组" : "Group"}</span>
                <Input
                  maxLength={128}
                  value={draft.connection.group}
                  disabled={busy}
                  onChange={(event) =>
                    update("group", event.currentTarget.value)
                  }
                />
              </label>
              <div className="vnc-field-grid">
                <label className="vnc-field">
                  <span>{zh ? "主机" : "Host"}</span>
                  <Input
                    maxLength={255}
                    value={draft.connection.host}
                    disabled={busy}
                    onChange={(event) =>
                      update("host", event.currentTarget.value)
                    }
                  />
                </label>
                <label className="vnc-field">
                  <span>{zh ? "端口" : "Port"}</span>
                  <Input
                    inputMode="numeric"
                    maxLength={5}
                    value={draft.port}
                    disabled={busy}
                    onChange={(event) => {
                      const port = event.currentTarget.value;
                      setDraft((current) =>
                        current ? { ...current, port } : null,
                      );
                    }}
                  />
                </label>
              </div>
              <label className="vnc-field">
                <span>{zh ? "认证方式" : "Authentication"}</span>
                <Select
                  value={draft.connection.authType}
                  ariaLabel={zh ? "认证方式" : "Authentication"}
                  disabled={busy}
                  options={[
                    {
                      value: "password",
                      label: zh ? "VNC 密码" : "VNC password",
                    },
                    { value: "none", label: zh ? "无认证" : "None" },
                  ]}
                  onChange={(value) => update("authType", value)}
                />
              </label>
              {draft.connection.authType === "password" && (
                <>
                  <label className="vnc-field">
                    <span>{zh ? "密码" : "Password"}</span>
                    <Input
                      type="password"
                      autoComplete="off"
                      maxLength={8}
                      value={draft.password}
                      disabled={busy}
                      onChange={(event) => {
                        const password = event.currentTarget.value;
                        setDraft((current) =>
                          current ? { ...current, password } : null,
                        );
                      }}
                    />
                  </label>
                  <Checkbox
                    label={zh ? "保存密码" : "Save password"}
                    checked={draft.remember}
                    disabled={busy}
                    onChange={(event) => {
                      const remember = event.currentTarget.checked;
                      setDraft((current) =>
                        current ? { ...current, remember } : null,
                      );
                    }}
                  />
                </>
              )}
              <Checkbox
                label={zh ? "只读模式" : "View only"}
                checked={draft.connection.readOnly}
                disabled={busy}
                onChange={(event) =>
                  update("readOnly", event.currentTarget.checked)
                }
              />
              <p className="vnc-hint">
                {zh
                  ? "标准 VNC 连接未加密，请在可信网络使用。"
                  : "Standard VNC is unencrypted. Use a trusted network."}
              </p>
            </div>
          </VerticalScrollbar>
          <footer>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                generation.current += 1;
                setDraft(null);
                setError("");
              }}
            >
              {zh ? "取消" : "Cancel"}
            </Button>
            <Button type="submit" disabled={busy || !writable}>
              {busy ? (zh ? "保存中…" : "Saving…") : zh ? "保存" : "Save"}
            </Button>
          </footer>
        </form>
      ) : manage ? (
        <GroupManager
          items={groups.map((group) => ({
            id: group,
            name: group,
            count: connections.filter((item) => item.group === group).length,
          }))}
          ariaLabel={zh ? "VNC 分组" : "VNC groups"}
          emptyText={zh ? "暂无分组" : "No groups"}
          reorderLabel={zh ? "调整分组顺序" : "Reorder groups"}
          onOrderChange={onOrder}
        />
      ) : (
        <>
          <div className="vnc-search">
            <SearchInput
              onSearch={setSearch}
              placeholder={zh ? "搜索连接" : "Search connections"}
              buttonLabel={zh ? "搜索" : "Search"}
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          </div>
          <VerticalScrollbar height="100%" className="vnc-connection-list">
            {!query &&
              recent.some((id) =>
                connections.some((item) => item.id === id),
              ) && (
                <section>
                  <h3>{zh ? "最近连接" : "Recent"}</h3>
                  {recent.flatMap((id) => {
                    const connection = connections.find(
                      (item) => item.id === id,
                    );
                    return connection ? [row(connection, "recent")] : [];
                  })}
                </section>
              )}
            {groups.map((group) => {
              const items = filtered.filter((item) => item.group === group);
              if (!items.length) return null;
              return (
                <section key={group}>
                  <button
                    type="button"
                    className="vnc-group-heading"
                    aria-expanded={!collapsed.includes(group)}
                    onClick={() =>
                      setCollapsed((current) =>
                        current.includes(group)
                          ? current.filter((item) => item !== group)
                          : [...current, group],
                      )
                    }
                  >
                    <SvgIcon
                      name="chevron"
                      className={collapsed.includes(group) ? "" : "is-expanded"}
                      size={12}
                    />
                    <strong>{group}</strong>
                    <span>{items.length}</span>
                  </button>
                  {!collapsed.includes(group) &&
                    items.map((connection) => row(connection, "group"))}
                </section>
              );
            })}
            {!filtered.length && (
              <div className="vnc-panel-empty">
                {connections.length
                  ? zh
                    ? "没有匹配的连接"
                    : "No matching connections"
                  : zh
                    ? "暂无连接"
                    : "No connections"}
                {!connections.length && (
                  <Button
                    variant="secondary"
                    disabled={!writable}
                    onClick={create}
                  >
                    {zh ? "新建连接" : "New connection"}
                  </Button>
                )}
              </div>
            )}
          </VerticalScrollbar>
        </>
      )}
    </aside>
  );
}
