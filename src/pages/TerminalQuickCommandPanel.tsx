import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, SvgIcon, Textarea, VerticalScrollbar, useNotification } from "../components/ui";
import { persistSyncedStorage } from "../rivetSync";
import type { Locale } from "./SerialPage";
import {
  createTerminalQuickCommandId,
  deserializeTerminalQuickCommands,
  serializeTerminalQuickCommands,
  TERMINAL_QUICK_COMMANDS_STORAGE_KEY,
  type TerminalQuickCommand,
} from "./terminalQuickCommands";
import "./terminalQuickCommandPanel.css";

interface TerminalQuickCommandPanelProps {
  open: boolean;
  locale: Locale;
  canSend: boolean;
  onClose: () => void;
  onSend: (command: string) => Promise<void>;
}

interface CommandDraft {
  name: string;
  group: string;
  command: string;
}

interface PanelPosition {
  x: number;
  y: number;
}

type DeleteTarget =
  | { kind: "group"; group: string }
  | { kind: "command"; id: string };

const EMPTY_DRAFT: CommandDraft = {
  name: "",
  group: "",
  command: "",
};

const COPY = {
  zh: {
    title: "快捷命令",
    add: "添加命令",
    edit: "编辑命令",
    name: "命令名称",
    group: "分组",
    groupPlaceholder: "选择或输入分组",
    command: "命令",
    commandPlaceholder: "输入要发送到终端的命令",
    empty: "暂无快捷命令",
    save: "保存",
    cancel: "取消",
    close: "关闭",
    editAction: "编辑",
    delete: "删除",
    deleteGroup: "删除分组",
    send: "发送",
    copy: "复制",
    required: "请填写命令名称、分组和命令内容。",
    copied: "命令已复制",
    copyFailed: "复制命令失败：",
    sendFailed: "发送命令失败：",
    noTerminal: "当前没有可发送的活动终端",
  },
  en: {
    title: "Quick commands",
    add: "Add command",
    edit: "Edit command",
    name: "Name",
    group: "Group",
    groupPlaceholder: "Choose or enter a group",
    command: "Command",
    commandPlaceholder: "Enter a command to send to the terminal",
    empty: "No quick commands",
    save: "Save",
    cancel: "Cancel",
    close: "Close",
    editAction: "Edit",
    delete: "Delete",
    deleteGroup: "Delete group",
    send: "Send",
    copy: "Copy",
    required: "Enter a command name, group, and command.",
    copied: "Command copied",
    copyFailed: "Failed to copy command: ",
    sendFailed: "Failed to send command: ",
    noTerminal: "No active terminal is available",
  },
} as const;

/** 从浏览器存储恢复终端快捷命令。 */
function readCommands(): TerminalQuickCommand[] {
  try {
    return deserializeTerminalQuickCommands(
      window.localStorage.getItem(TERMINAL_QUICK_COMMANDS_STORAGE_KEY),
    );
  } catch {
    return [];
  }
}

/** 浏览器剪贴板不可用时使用临时 textarea 回退复制。 */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard API unavailable");
}

/** 终端快捷命令独立悬浮窗口；外部点击不会关闭窗口本身。 */
export default function TerminalQuickCommandPanel({
  open,
  locale,
  canSend,
  onClose,
  onSend,
}: TerminalQuickCommandPanelProps) {
  const copy = COPY[locale];
  const { notify } = useNotification();
  const [commands, setCommands] = useState<TerminalQuickCommand[]>(readCommands);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CommandDraft>(EMPTY_DRAFT);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const groupPickerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [panelPosition, setPanelPosition] = useState<PanelPosition | null>(null);

  useEffect(() => {
    try {
      persistSyncedStorage(
        TERMINAL_QUICK_COMMANDS_STORAGE_KEY,
        serializeTerminalQuickCommands(commands),
      );
    } catch {
      // 当前会话仍保留命令；存储失败不阻断操作。
    }
  }, [commands]);

  /** 只关闭窗口内部的下拉和菜单，不关闭快捷命令窗口。 */
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!groupPickerRef.current?.contains(target)) setGroupPickerOpen(false);
      if (!target.closest(".terminal-command-more-wrap")) setMenuKey(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  /** 窗口尺寸变化或表单高度变化时，将已拖动窗口限制在终端工作区可见范围内。 */
  useEffect(() => {
    if (!open || panelPosition === null) return;
    const panel = panelRef.current;
    const parent = panel?.offsetParent;
    if (!panel || !(parent instanceof HTMLElement)) return;

    const clampPosition = () => {
      const maxX = Math.max(0, parent.clientWidth - panel.offsetWidth);
      const maxY = Math.max(0, parent.clientHeight - panel.offsetHeight);
      setPanelPosition((current) => {
        if (!current) return current;
        const next = {
          x: Math.min(maxX, Math.max(0, current.x)),
          y: Math.min(maxY, Math.max(0, current.y)),
        };
        return next.x === current.x && next.y === current.y ? current : next;
      });
    };

    clampPosition();
    const observer = new ResizeObserver(clampPosition);
    observer.observe(parent);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [formOpen, open, panelPosition]);

  /** 拖动标题栏移动窗口；标题栏右侧操作按钮保持正常点击行为。 */
  const handleHeaderPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest(".terminal-command-header-actions")) return;

    const panel = panelRef.current;
    const parent = panel?.offsetParent;
    if (!panel || !(parent instanceof HTMLElement)) return;

    event.preventDefault();
    const pointerId = event.pointerId;
    const panelRect = panel.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const startPointerX = event.clientX;
    const startPointerY = event.clientY;
    const startX = panelRect.left - parentRect.left;
    const startY = panelRect.top - parentRect.top;

    setPanelPosition({ x: startX, y: startY });

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const maxX = Math.max(0, parent.clientWidth - panel.offsetWidth);
      const maxY = Math.max(0, parent.clientHeight - panel.offsetHeight);
      setPanelPosition({
        x: Math.min(maxX, Math.max(0, startX + moveEvent.clientX - startPointerX)),
        y: Math.min(maxY, Math.max(0, startY + moveEvent.clientY - startPointerY)),
      });
    };

    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const groups = useMemo(() => {
    const result = new Map<string, TerminalQuickCommand[]>();
    commands.forEach((command) => {
      const list = result.get(command.group) ?? [];
      list.push(command);
      result.set(command.group, list);
    });
    return result;
  }, [commands]);

  const groupNames = useMemo(() => Array.from(groups.keys()), [groups]);

  const resetForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setGroupPickerOpen(false);
  };

  const openCreate = () => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setFormOpen(true);
    setGroupPickerOpen(false);
    setMenuKey(null);
    setDeleteTarget(null);
  };

  const openEdit = (command: TerminalQuickCommand) => {
    setEditingId(command.id);
    setDraft({
      name: command.name,
      group: command.group,
      command: command.command,
    });
    setFormOpen(true);
    setGroupPickerOpen(false);
    setMenuKey(null);
    setDeleteTarget(null);
  };

  const saveCommand = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = draft.name.trim();
    const group = draft.group.trim();
    if (!name || !group || !draft.command.trim()) {
      notify({ kind: "warning", message: copy.required });
      return;
    }

    if (editingId) {
      setCommands((current) =>
        current.map((command) =>
          command.id === editingId
            ? { ...command, name, group, command: draft.command }
            : command,
        ),
      );
    } else {
      setCommands((current) => [
        ...current,
        {
          id: createTerminalQuickCommandId(),
          name,
          group,
          command: draft.command,
        },
      ]);
    }
    setCollapsedGroups((current) => {
      const next = new Set(current);
      next.delete(group);
      return next;
    });
    resetForm();
  };

  const toggleGroup = (group: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    if (deleteTarget.kind === "group") {
      setCommands((current) =>
        current.filter((command) => command.group !== deleteTarget.group),
      );
      setCollapsedGroups((current) => {
        const next = new Set(current);
        next.delete(deleteTarget.group);
        return next;
      });
    } else {
      setCommands((current) =>
        current.filter((command) => command.id !== deleteTarget.id),
      );
    }
    setDeleteTarget(null);
    setMenuKey(null);
  };

  const sendCommand = async (command: TerminalQuickCommand) => {
    if (!canSend) {
      notify({ kind: "warning", message: copy.noTerminal });
      return;
    }
    try {
      await onSend(command.command);
    } catch (error) {
      notify({ kind: "error", message: `${copy.sendFailed}${String(error)}` });
    }
  };

  const copyCommand = async (command: TerminalQuickCommand) => {
    try {
      await copyText(command.command);
      notify({ kind: "success", message: copy.copied });
    } catch (error) {
      notify({ kind: "error", message: `${copy.copyFailed}${String(error)}` });
    }
  };

  return (
    <aside
      ref={panelRef}
      className={`terminal-command-panel ${open ? "open" : ""}`}
      style={
        panelPosition
          ? { left: panelPosition.x, top: panelPosition.y, right: "auto", bottom: "auto" }
          : undefined
      }
      aria-hidden={!open}
      aria-label={copy.title}
    >
      <header
        className="terminal-connection-header terminal-command-header"
        onPointerDown={handleHeaderPointerDown}
      >
        <strong>{formOpen ? (editingId ? copy.editAction : copy.add) : copy.title}</strong>
        <div className="terminal-command-header-actions">
          {!formOpen && (
            <button
              type="button"
              className="terminal-icon-button"
              title={copy.add}
              aria-label={copy.add}
              onClick={openCreate}
            >
              <SvgIcon name="plus" size={16} />
            </button>
          )}
          <button
            type="button"
            className="terminal-icon-button"
            title={copy.close}
            aria-label={copy.close}
            onClick={onClose}
          >
            <SvgIcon name="close" size={14} />
          </button>
        </div>
      </header>

      {formOpen ? (
        <form className="terminal-command-form" onSubmit={saveCommand}>
          <VerticalScrollbar
            className="terminal-command-form-scroll"
            viewportClassName="terminal-command-form-viewport"
            height="100%"
            viewportLabel={editingId ? copy.edit : copy.add}
          >
            <label className="terminal-field">
              <span>{copy.name}</span>
              <Input
                value={draft.name}
                maxLength={128}
                autoFocus
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft((current) => ({ ...current, name: value }));
                }}
              />
            </label>

            <div className="terminal-field">
              <span>{copy.group}</span>
              <div className="quick-command-group-picker" ref={groupPickerRef}>
                <Input
                  className="quick-command-group-input"
                  value={draft.group}
                  maxLength={128}
                  autoComplete="off"
                  placeholder={copy.groupPlaceholder}
                  onFocus={() => setGroupPickerOpen(true)}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDraft((current) => ({ ...current, group: value }));
                    setGroupPickerOpen(true);
                  }}
                />
                <SvgIcon name="chevron" size={12} className="quick-command-group-chevron" />
                {groupPickerOpen && (
                  <div className="rivet-select-menu quick-command-group-menu" role="listbox">
                    {groupNames
                      .filter((group) =>
                        group.toLocaleLowerCase().includes(
                          draft.group.trim().toLocaleLowerCase(),
                        ),
                      )
                      .map((group) => (
                        <button
                          key={group}
                          type="button"
                          role="option"
                          aria-selected={draft.group === group}
                          className={
                            "rivet-select-option" +
                            (draft.group === group ? " is-selected" : "")
                          }
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setDraft((current) => ({ ...current, group }));
                            setGroupPickerOpen(false);
                          }}
                        >
                          {draft.group === group && (
                            <SvgIcon
                              name="check"
                              size={12}
                              className="rivet-select-check"
                            />
                          )}
                          {group}
                        </button>
                      ))}
                  </div>
                )}
              </div>
            </div>

            <label className="terminal-field terminal-command-payload-field">
              <span>{copy.command}</span>
              <Textarea
                value={draft.command}
                maxLength={16_384}
                placeholder={copy.commandPlaceholder}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft((current) => ({ ...current, command: value }));
                }}
              />
            </label>
          </VerticalScrollbar>

          <footer className="terminal-form-footer">
            <Button type="button" variant="secondary" onClick={resetForm}>
              {copy.cancel}
            </Button>
            <Button type="submit">{copy.save}</Button>
          </footer>
        </form>
      ) : (
        <VerticalScrollbar
          className="terminal-command-groups"
          viewportClassName="terminal-command-groups-viewport"
          height="100%"
          viewportLabel={copy.title}
        >
          {commands.length === 0 && (
            <div className="terminal-connection-empty">{copy.empty}</div>
          )}

          {Array.from(groups.entries()).map(([group, items]) => (
            <section
              key={group}
              className={`terminal-connection-group ${collapsedGroups.has(group) ? "collapsed" : ""}`}
            >
              <div className="terminal-group-header-row">
                <button
                  type="button"
                  className="terminal-group-header"
                  onClick={() => toggleGroup(group)}
                >
                  <SvgIcon name="chevron" size={11} />
                  <span>{group}</span>
                  <small>{items.length}</small>
                </button>
                <div className="terminal-more-wrap terminal-command-more-wrap terminal-group-more">
                  <button
                    type="button"
                    className="terminal-icon-button"
                    aria-label={copy.deleteGroup}
                    onClick={() => {
                      setMenuKey((current) =>
                        current === `group:${group}` ? null : `group:${group}`,
                      );
                      setDeleteTarget(null);
                    }}
                  >
                    <SvgIcon name="more" size={16} />
                  </button>
                  {menuKey === `group:${group}` && (
                    <div className="terminal-connection-menu">
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          setMenuKey(null);
                          setDeleteTarget({ kind: "group", group });
                        }}
                      >
                        {copy.deleteGroup}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {deleteTarget?.kind === "group" && deleteTarget.group === group && (
                <div className="terminal-delete-confirm terminal-group-delete-confirm">
                  <span>
                    {locale === "zh"
                      ? `删除“${group}”及其中 ${items.length} 条命令？`
                      : `Delete "${group}" and its ${items.length} command${items.length === 1 ? "" : "s"}?`}
                  </span>
                  <div className="terminal-delete-actions">
                    <button type="button" onClick={() => setDeleteTarget(null)}>
                      {copy.cancel}
                    </button>
                    <button type="button" className="danger" onClick={confirmDelete}>
                      {copy.delete}
                    </button>
                  </div>
                </div>
              )}

              <div className="terminal-group-items">
                {items.map((command) => (
                  <div key={command.id} className="terminal-command-item">
                    <div className="terminal-command-row">
                      <div className="terminal-command-main">
                        <strong>{command.name}</strong>
                        <small>{command.command}</small>
                      </div>

                      <button
                        type="button"
                        className="terminal-command-action"
                        title={copy.copy}
                        aria-label={copy.copy}
                        onClick={() => void copyCommand(command)}
                      >
                        <SvgIcon name="copy" size={16} />
                      </button>
                      <button
                        type="button"
                        className="terminal-command-action"
                        title={copy.send}
                        aria-label={copy.send}
                        disabled={!canSend}
                        onClick={() => void sendCommand(command)}
                      >
                        <SvgIcon name="send" size={14} />
                      </button>

                      <div className="terminal-more-wrap terminal-command-more-wrap">
                        <button
                          type="button"
                          className="terminal-icon-button"
                          aria-label={locale === "zh" ? "更多操作" : "More actions"}
                          onClick={() => {
                            setMenuKey((current) =>
                              current === `command:${command.id}`
                                ? null
                                : `command:${command.id}`,
                            );
                            setDeleteTarget(null);
                          }}
                        >
                          <SvgIcon name="more" size={16} />
                        </button>
                        {menuKey === `command:${command.id}` && (
                          <div className="terminal-connection-menu">
                            <button type="button" onClick={() => openEdit(command)}>
                              {copy.editAction}
                            </button>
                            <button
                              type="button"
                              className="danger"
                              onClick={() => {
                                setMenuKey(null);
                                setDeleteTarget({ kind: "command", id: command.id });
                              }}
                            >
                              {copy.delete}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {deleteTarget?.kind === "command" &&
                      deleteTarget.id === command.id && (
                        <div className="terminal-delete-confirm">
                          <span>
                            {locale === "zh"
                              ? `删除“${command.name}”？`
                              : `Delete "${command.name}"?`}
                          </span>
                          <div className="terminal-delete-actions">
                            <button type="button" onClick={() => setDeleteTarget(null)}>
                              {copy.cancel}
                            </button>
                            <button
                              type="button"
                              className="danger"
                              onClick={confirmDelete}
                            >
                              {copy.delete}
                            </button>
                          </div>
                        </div>
                      )}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </VerticalScrollbar>
      )}
    </aside>
  );
}
