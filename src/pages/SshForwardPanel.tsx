/** SSH 转发列表与编辑子面板；操作仅更新父连接草稿，连接保存前不创建监听。 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Input, PopupMenu, PopupMenuItem, Select, SvgIcon, VerticalScrollbar, useNotification } from "../components/ui";
import { areSshForwardRules, MAX_SSH_FORWARD_RULES, MAX_SSH_HOST_LENGTH, type SshForwardKind, type SshForwardRule } from "./sshAdvanced";
import type { Locale } from "./SerialPage";
import "./sshAdvanced.css";

/** 转发编辑草稿，端口以文本保存以保留未完成输入。 */
interface ForwardDraft {
  /** 编辑已有规则时保留标识，新增时为空。 */
  id: string;
  /** 转发方向。 */
  kind: SshForwardKind;
  /** 本机或远端监听地址。 */
  bindAddress: string;
  /** 尚未校验的监听端口文本。 */
  bindPort: string;
  /** 非动态方向的目标主机。 */
  targetHost: string;
  /** 尚未校验的目标端口文本。 */
  targetPort: string;
}

/** 新规则默认仅监听回环，不默认开放网络访问。 */
const EMPTY_DRAFT: ForwardDraft = {
  id: "", kind: "local", bindAddress: "127.0.0.1", bindPort: "", targetHost: "", targetPort: "",
};
/** 固定 TCP 端口文本最多五位十进制数字。 */
const MAX_PORT_DIGITS = 5;

/** 父表单拥有规则数组；返回保留所有未提交的连接字段。 */
interface SshForwardPanelProps {
  /** 当前语言。 */
  locale: Locale;
  /** 当前连接草稿中的规则。 */
  rules: SshForwardRule[];
  /** 替换父草稿的规则数组，不写持久化存储。 */
  onChange: (rules: SshForwardRule[]) => void;
  /** 返回父连接表单。 */
  onBack: () => void;
}

/** 按参考页的列表行、行内删除确认、双列端点字段和底部按钮渲染。 */
export default function SshForwardPanel({ locale, rules, onChange, onBack }: SshForwardPanelProps) {
  const zh = locale === "zh";
  const { notify } = useNotification();
  /** 非空时显示编辑器；返回列表后丢弃未保存规则字段。 */
  const [draft, setDraft] = useState<ForwardDraft | null>(null);
  /** 当前展开菜单的规则 ID。 */
  const [menuId, setMenuId] = useState<string | null>(null);
  /** 当前等待删除确认的规则 ID。 */
  const [deleteId, setDeleteId] = useState<string | null>(null);
  /** 用于菜单外点击边界判定。 */
  const panelRef = useRef<HTMLDivElement>(null);
  /** 收起菜单；外点击和 Escape 不修改规则。 */
  useEffect(() => {
    /** 点击规则菜单以外时关闭。 */
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".terminal-more-wrap") || !panelRef.current?.contains(event.target)) {
        setMenuId(null);
      }
    };
    /** Escape 收起已展开菜单。 */
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuId(null); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    /** 组件卸载时释放全局事件监听。 */
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  /** 根据方向生成列表标题。 */
  const kindLabel = (kind: SshForwardKind) => {
    if (kind === "local") return zh ? "本地转发" : "Local forwarding";
    if (kind === "remote") return zh ? "远程转发" : "Remote forwarding";
    return zh ? "动态转发" : "Dynamic forwarding";
  };
  /** 打开新增草稿；达到上限时入口禁用。 */
  const add = () => {
    setDraft({ ...EMPTY_DRAFT });
    setMenuId(null);
    setDeleteId(null);
  };
  /** 打开规则编辑副本；未保存的字段不影响父草稿。 */
  const edit = (rule: SshForwardRule) => {
    setDraft({ ...rule, bindPort: String(rule.bindPort), targetPort: rule.targetPort ? String(rule.targetPort) : "" });
    setMenuId(null);
    setDeleteId(null);
  };
  /** 编辑器返回列表；列表返回连接表单。 */
  const back = () => { if (draft) setDraft(null); else onBack(); };
  /** 修改单个字段，允许临时空端口。 */
  const update = (field: keyof ForwardDraft, value: string) => setDraft(/** 保留其余草稿字段。 */ (current) => current ? { ...current, [field]: value } : null);
  /** 保存合法规则到父草稿；冲突或非法端口保持编辑器打开。 */
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    const rule: SshForwardRule = {
      id: draft.id || `forward-${crypto.randomUUID()}`,
      kind: draft.kind,
      bindAddress: draft.bindAddress.trim(),
      bindPort: Number(draft.bindPort),
      targetHost: draft.kind === "dynamic" ? "" : draft.targetHost.trim(),
      targetPort: draft.kind === "dynamic" ? 0 : Number(draft.targetPort),
    };
    const next = draft.id ? rules.map(/** 替换当前规则，保留顺序。 */ (item) => item.id === draft.id ? rule : item) : [...rules, rule];
    if (!/^\d+$/.test(draft.bindPort) || (draft.kind !== "dynamic" && !/^\d+$/.test(draft.targetPort)) || !areSshForwardRules(next)) {
      notify({ kind: "warning", message: zh ? "转发参数无效或监听端口重复" : "Invalid forwarding settings or duplicate listener" });
      return;
    }
    onChange(next);
    setDraft(null);
  };
  return <div className="ssh-forward-panel" ref={panelRef}>
    <header className="terminal-connection-header">
      <div className="ssh-subpage-title"><button type="button" className="terminal-icon-button" onClick={back} aria-label={zh ? "返回" : "Back"}><SvgIcon name="back" size={14} /></button><strong>{draft ? (draft.id ? (zh ? "编辑端口转发" : "Edit port forwarding") : (zh ? "添加端口转发" : "Add port forwarding")) : (zh ? "端口转发" : "Port forwarding")}</strong></div>
      {!draft && <div className="terminal-connection-header-actions"><button type="button" className="terminal-icon-button" onClick={add} disabled={rules.length >= MAX_SSH_FORWARD_RULES} aria-label={zh ? "添加端口转发" : "Add port forwarding"}><SvgIcon name="plus" size={16} /></button></div>}
    </header>
    {draft ? <form className="ssh-forward-form" onSubmit={save}>
      <VerticalScrollbar className="terminal-connection-form-scroll" viewportClassName="ssh-forward-form-viewport" height="100%" viewportLabel={zh ? "端口转发参数" : "Forwarding settings"}>
        <label className="terminal-field"><span>{zh ? "类型" : "Type"}</span><Select ariaLabel={zh ? "类型" : "Type"} value={draft.kind} onChange={/** 修改转发方向。 */ (value) => update("kind", value)} options={[
          { value: "local", label: zh ? "本地转发（Local）" : "Local forwarding" }, { value: "remote", label: zh ? "远程转发（Remote）" : "Remote forwarding" }, { value: "dynamic", label: zh ? "动态转发（Dynamic）" : "Dynamic forwarding" },
        ]} /></label>
        <div className="ssh-forward-field-grid">
          <label className="terminal-field"><span>{zh ? "监听地址" : "Listen address"}</span><Input value={draft.bindAddress} maxLength={MAX_SSH_HOST_LENGTH} onChange={/** 保存监听地址输入。 */ (event) => update("bindAddress", event.currentTarget.value)} /></label>
          <label className="terminal-field"><span>{zh ? "端口" : "Port"}</span><Input value={draft.bindPort} inputMode="numeric" maxLength={MAX_PORT_DIGITS} onChange={/** 保留监听端口草稿。 */ (event) => update("bindPort", event.currentTarget.value)} /></label>
        </div>
        {draft.kind !== "dynamic" && <div className="ssh-forward-field-grid">
          <label className="terminal-field"><span>{zh ? "目标主机" : "Target host"}</span><Input value={draft.targetHost} maxLength={MAX_SSH_HOST_LENGTH} onChange={/** 保存固定目标输入。 */ (event) => update("targetHost", event.currentTarget.value)} /></label>
          <label className="terminal-field"><span>{zh ? "端口" : "Port"}</span><Input value={draft.targetPort} inputMode="numeric" maxLength={MAX_PORT_DIGITS} onChange={/** 保留目标端口草稿。 */ (event) => update("targetPort", event.currentTarget.value)} /></label>
        </div>}
      </VerticalScrollbar>
      <footer className="terminal-form-footer"><Button type="button" variant="secondary" onClick={back}>{zh ? "取消" : "Cancel"}</Button><Button type="submit">{zh ? "保存" : "Save"}</Button></footer>
    </form> : <VerticalScrollbar className="ssh-forward-list" height="100%" viewportLabel={zh ? "端口转发" : "Port forwarding"}>
      {rules.length === 0 && <div className="terminal-empty">{zh ? "暂无端口转发" : "No port forwards"}</div>}
      {rules.map(/** 每行保持规则 ID 及其菜单、删除确认状态。 */ (rule) => <div className="terminal-connection-item" key={rule.id}>
        <div className="terminal-connection-row">
          <button type="button" className="terminal-connection-main" onClick={/** 编辑选中规则。 */ () => edit(rule)}><span className="terminal-connection-type">{rule.kind === "local" ? "L" : rule.kind === "remote" ? "R" : "D"}</span><span><strong>{kindLabel(rule.kind)}</strong><small>{rule.bindAddress}:{rule.bindPort}{rule.kind === "dynamic" ? " · SOCKS5" : ` → ${rule.targetHost}:${rule.targetPort}`}</small></span></button>
          <div className="terminal-more-wrap"><button type="button" className="terminal-icon-button" aria-label={zh ? "更多操作" : "More actions"} aria-expanded={menuId === rule.id} onClick={/** 切换此行操作菜单。 */ () => setMenuId(menuId === rule.id ? null : rule.id)}><SvgIcon name="more" size={16} /></button>
            <PopupMenu open={menuId === rule.id} align="end"><PopupMenuItem onClick={/** 从菜单编辑当前规则。 */ () => edit(rule)}>{zh ? "编辑" : "Edit"}</PopupMenuItem><PopupMenuItem danger onClick={/** 展示行内删除确认。 */ () => { setDeleteId(rule.id); setMenuId(null); }}>{zh ? "删除" : "Delete"}</PopupMenuItem></PopupMenu>
          </div>
        </div>
        {deleteId === rule.id && <div className="terminal-delete-confirm"><span>{zh ? `删除“${kindLabel(rule.kind)}”？` : `Delete “${kindLabel(rule.kind)}”?`}</span><div className="terminal-delete-actions"><button type="button" onClick={/** 取消删除，不修改规则。 */ () => setDeleteId(null)}>{zh ? "取消" : "Cancel"}</button><button type="button" className="danger" onClick={/** 仅移除确认的规则。 */ () => { onChange(rules.filter(/** 保留其他规则。 */ (item) => item.id !== rule.id)); setDeleteId(null); }}>{zh ? "删除" : "Delete"}</button></div></div>}
      </div>)}
    </VerticalScrollbar>}
  </div>;
}
