/** SSH 连接表单的高级选项入口；复用正式控件，数据由父连接草稿拥有。 */
import { Select, SvgIcon, Switch } from "../components/ui";
import type { SavedSshConnection } from "./terminalConnections";
import type { Locale } from "./SerialPage";
import "./sshAdvanced.css";

/** 高级选项的受控属性；所有配置只在父表单保存时持久化。 */
interface SshAdvancedOptionsProps {
  /** 当前应用语言。 */
  locale: Locale;
  /** 高级分区是否展开。 */
  expanded: boolean;
  /** 切换分区展开状态。 */
  onExpandedChange: (expanded: boolean) => void;
  /** 跳板开关独立于未选定的连接。 */
  jumpEnabled: boolean;
  /** 切换跳板启用状态。 */
  onJumpEnabledChange: (enabled: boolean) => void;
  /** 当前引用的跳板 ID；未选择为空。 */
  jumpConnectionId: string;
  /** 可选的已保存 SSH 连接，不含自身或循环引用。 */
  jumpConnections: SavedSshConnection[];
  /** 修改父表单中的跳板引用。 */
  onJumpConnectionChange: (id: string) => void;
  /** 当前草稿的转发数量。 */
  forwardCount: number;
  /** 打开转发列表子面板。 */
  onOpenForwards: () => void;
}

/** 按参考页顺序渲染高级分区、跳板行与转发入口。 */
export default function SshAdvancedOptions(props: SshAdvancedOptionsProps) {
  const zh = props.locale === "zh";
  /** 切换折叠状态，不修改连接配置。 */
  const toggleExpanded = () => props.onExpandedChange(!props.expanded);
  return <>
    <button type="button" className={`ssh-advanced-toggle${props.expanded ? "" : " is-collapsed"}`} onClick={toggleExpanded} aria-expanded={props.expanded}>
      <SvgIcon name="chevron" size={11} className="ssh-advanced-chevron" />
      <strong>{zh ? "高级选项" : "Advanced options"}</strong>
      <small>{zh ? "跳板机 · 端口转发" : "Jump host · Port forwarding"}</small>
    </button>
    <div className="ssh-advanced-body" hidden={!props.expanded}>
      <div className="ssh-jump-row">
        <span className="ssh-jump-copy"><strong>{zh ? "跳板机" : "Jump host"}</strong><small>{zh ? "通过已保存的 SSH 连接访问目标主机" : "Connect through a saved SSH connection"}</small></span>
        <Switch checked={props.jumpEnabled} onCheckedChange={props.onJumpEnabledChange} ariaLabel={zh ? "启用跳板机" : "Enable jump host"} />
      </div>
      <label className="terminal-field ssh-jump-field" hidden={!props.jumpEnabled}>
        <span>{zh ? "跳板连接" : "Jump connection"}</span>
        <Select value={props.jumpConnectionId} ariaLabel={zh ? "跳板连接" : "Jump connection"} onChange={props.onJumpConnectionChange} options={[
          { value: "", label: zh ? "选择 SSH 连接" : "Select SSH connection" },
          ...props.jumpConnections.map(/** 展示跳板身份，不访问秘密。 */ (connection) => ({ value: connection.id, label: `${connection.name} · ${connection.username}@${connection.host}:${connection.port}` })),
        ]} />
      </label>
      <button type="button" className="ssh-forward-entry" onClick={props.onOpenForwards}>
        <span className="terminal-connection-type"><SvgIcon name="port" size={15} /></span>
        <span className="ssh-forward-entry-copy"><strong>{zh ? "端口转发" : "Port forwarding"}</strong></span>
        <span className="ssh-forward-entry-count">{props.forwardCount}</span>
        <SvgIcon name="chevron" size={11} className="ssh-forward-entry-chevron" />
      </button>
    </div>
  </>;
}
