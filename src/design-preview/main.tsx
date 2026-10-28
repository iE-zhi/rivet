import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  Checkbox,
  ConfirmDialog,
  GroupManager,
  HorizontalScrollbar,
  Input,
  NotificationProvider,
  PopupMenu,
  PopupMenuItem,
  Radio,
  SearchInput,
  Select,
  Slider,
  Switch,
  Terminal,
  Textarea,
  VerticalScrollbar,
  useNotification,
  type PopupMenuPoint,
} from "../components/ui";
import "./preview.css";
import { APP_VERSION } from "../appVersion";

const terminalLines = [
  { kind: "info" as const, prefix: "[12:00:01] INFO", text: "串口已打开 COM3 115200 8N1" },
  { kind: "rx" as const, prefix: "[12:00:02] RX", text: "48 65 6C 6C 6F 20 52 69 76 65 74" },
  { kind: "tx" as const, prefix: "[12:00:03] TX", text: "AT+VERSION\\r\\n" },
  { kind: "ok" as const, prefix: "[12:00:03] OK", text: `Rivet v${APP_VERSION}` },
];

function Row({ label, children, open = false }: { label: string; children: ReactNode; open?: boolean }) {
  return (
    <div className={`preview-row ${open ? "preview-row-open" : ""}`.trim()}>
      <span className="preview-label">{label}</span>
      {children}
    </div>
  );
}

/** 将正式通知组件的浅色/深色示例保持为静态可操作状态。 */
function NotificationPreviewSamples() {
  const { notify } = useNotification();

  /** 预览只在挂载时添加三种语义示例，并设为手动关闭以便检查样式。 */
  useEffect(() => {
    notify({ kind: "success", title: "连接成功", message: "已连接到 COM3 · 115200 8N1", durationMs: 0 });
    notify({ kind: "info", title: "日志已保存", message: "串口日志已保存到本地文件。", durationMs: 0 });
    notify({ kind: "warning", title: "检查设置", message: "无效输入已恢复到上次有效值。", durationMs: 0 });
  }, [notify]);

  return <div className="preview-notification-note">成功、信息与警告通知示例；卡片可手动关闭。</div>;
}

/** 展示正式分组管理器，并让预览中的拖拽和键盘排序真实可用。 */
function GroupManagerPreviewSamples() {
  const [items, setItems] = useState([
    { id: "x11", name: "X11", count: 4 },
    { id: "ssh", name: "ssh", count: 2 },
    { id: "pnpm", name: "pnpm", count: 1 },
  ]);

  return (
    <div className="preview-group-manager">
      <GroupManager
        items={items}
        ariaLabel="分组管理预览"
        emptyText="暂无分组"
        reorderLabel="调整分组顺序"
        onOrderChange={(orderedIds) => {
          const byId = new Map(items.map((item) => [item.id, item]));
          setItems(orderedIds.map((id) => byId.get(id)).filter((item): item is (typeof items)[number] => item !== undefined));
        }}
      />
    </div>
  );
}

/** 直接渲染正式右键菜单，支持指针打开、键盘关闭与边缘定位检查。 */
function PointMenuPreview() {
  const [point, setPoint] = useState<PopupMenuPoint | null>(null);
  /** 清理预览菜单，不改变其他组件示例。 */
  const close = useCallback(() => setPoint(null), []);
  return <div className="preview-context-menu" onContextMenu={/** 预览区域的鼠标位置就是菜单锚点。 */ (event) => { event.preventDefault(); setPoint({ x: event.clientX, y: event.clientY }); }}>
    <Button variant="secondary" onClick={/** 点击也能在按钮下方打开，便于键盘检查。 */ (event) => { const rect = event.currentTarget.getBoundingClientRect(); setPoint({ x: rect.left, y: rect.bottom }); }}>右键菜单</Button>
    <PopupMenu open={!!point} point={point ?? undefined} onClose={close} width={200} ariaLabel="右键菜单预览"><PopupMenuItem onClick={close}>保存</PopupMenuItem><PopupMenuItem onClick={close}>另存为</PopupMenuItem><PopupMenuItem disabled>不可用</PopupMenuItem></PopupMenu>
  </div>;
}

/** 预览直接使用正式确认框，取消和确认均关闭；不执行任何删除操作。 */
function ConfirmDialogPreview() {
  const [open, setOpen] = useState(false);
  /** 清理演示浮层，不修改任何用户数据。 */
  const close = useCallback(() => setOpen(false), []);
  return <><Button onClick={/** 由用户打开浮层，避免多个主题示例同时抢占焦点。 */ () => setOpen(true)}>打开确认弹窗</Button><ConfirmDialog open={open} title="丢弃未保存修改？" message="关闭后将丢失这份文档的未保存修改。" cancelLabel="取消" confirmLabel="丢弃" onCancel={close} onConfirm={close} /></>;
}

/** 根据组件标识渲染带可访问名称的交互预览控件。 */
function ComponentPreview({ id, dark }: { id: string; dark: boolean }) {
  switch (id) {
    case "confirm-dialog":
      return <ConfirmDialogPreview />;
    case "button":
      return (
        <>
          <Row label="Default">
            <Button>Primary</Button><Button variant="secondary">Secondary</Button>
            <Button variant="success">Success</Button><Button variant="danger">Danger</Button>
          </Row>
          <Row label="Focus"><Button className="is-focus">Primary</Button></Row>
          <Row label="Disabled"><Button disabled>Primary</Button><Button variant="secondary" disabled>Secondary</Button></Row>
        </>
      );
    case "input":
      return (
        <>
          <Row label="Default"><Input className="preview-wide" placeholder="输入内容..." /></Row>
          <Row label="Focus"><Input className="preview-wide is-focus" defaultValue="COM3" /></Row>
          <Row label="Disabled"><Input className="preview-wide" defaultValue="不可编辑" disabled /></Row>
        </>
      );
    case "search-input":
      return (
        <>
          <Row label="Default"><div className="preview-search"><SearchInput placeholder="搜索..." /></div></Row>
          <Row label="Focus"><div className="preview-search"><SearchInput className="is-focus" defaultValue="ttyUSB" /></div></Row>
        </>
      );
    case "textarea":
      return (
        <>
          <Row label="Default"><Textarea className="preview-wide" placeholder="输入发送内容..." /></Row>
          <Row label="Focus"><Textarea className="preview-wide is-focus" defaultValue={"AT+VERSION\\r\\n"} /></Row>
        </>
      );
    case "select":
      return (
        <>
          <Row label="Default">
            <Select ariaLabel="串口设备" className="preview-select" options={[{ value: "com", label: "串口 (COM)" }]} />
            <Select ariaLabel="波特率" className="preview-select" options={[{ value: "115200", label: "115200" }]} />
          </Row>
          <Row label="Open" open>
            <Select
              className="preview-select is-focus"
              ariaLabel="数据位和校验位"
              defaultValue="8n1"
              defaultOpen
              options={[
                { value: "8n1", label: "8N1" },
                { value: "8e1", label: "8E1" },
                { value: "8o1", label: "8O1" },
              ]}
            />
          </Row>
        </>
      );
    case "popup-menu":
      return (
        <>
        <Row label="Open" open>
          <div className="preview-popup-menu-anchor">
            <Button variant="secondary">更多</Button>
            <PopupMenu open minWidth={104} ariaLabel="更多操作">
              <PopupMenuItem>编辑</PopupMenuItem>
              <PopupMenuItem disabled>详情</PopupMenuItem>
              <PopupMenuItem danger>删除</PopupMenuItem>
            </PopupMenu>
          </div>
        </Row>
        <Row label="Context"><PointMenuPreview /></Row>
        </>
      );
    case "group-manager":
      return <GroupManagerPreviewSamples />;
    case "checkbox":
      return (
        <>
          <Row label="Default"><Checkbox label="未选中" /><Checkbox label="已选中" defaultChecked /></Row>
          <Row label="Disabled"><Checkbox label="不可用" defaultChecked disabled /></Row>
        </>
      );
    case "radio":
      return (
        <>
          <Row label="Default">
            <Radio name={dark ? "dark-radio" : "light-radio"} label="单选项" defaultChecked />
            <Radio name={dark ? "dark-radio" : "light-radio"} label="未选中" />
          </Row>
          <Row label="Disabled"><Radio label="不可用" defaultChecked disabled /></Row>
        </>
      );
    case "switch":
      return (
        <>
          <Row label="Default"><Switch /><span>关闭</span><Switch defaultChecked /><span>开启</span></Row>
          <Row label="Disabled"><Switch defaultChecked disabled /><span>不可用</span></Row>
        </>
      );
    case "slider":
      return (
        <>
          <Row label="Default"><Slider defaultValue={64} /></Row>
          <Row label="Disabled"><Slider defaultValue={64} disabled /></Row>
        </>
      );
    case "vertical-scrollbar":
      return (
        <Row label="Default">
          <div className="preview-scroll">
            <VerticalScrollbar height={320}>
              <div className="preview-scroll-content">
                {Array.from({ length: 24 }, (_, index) => (
                  <div className="preview-scroll-line" key={index}>
                    第 {String(index + 1).padStart(2, "0")} 行 · Rivet scroll content
                  </div>
                ))}
              </div>
            </VerticalScrollbar>
          </div>
        </Row>
      );
    case "horizontal-scrollbar":
      return (
        <Row label="Default">
          <div className="preview-horizontal-scroll">
            <HorizontalScrollbar height={64} viewportLabel="水平滚动条预览">
              <div className="preview-horizontal-scroll-content">
                {Array.from({ length: 10 }, (_, index) => (
                  <span className="preview-horizontal-scroll-item" key={index}>
                    Tab {String(index + 1).padStart(2, "0")}
                  </span>
                ))}
              </div>
            </HorizontalScrollbar>
          </div>
        </Row>
      );
    case "terminal":
      return <div className="preview-terminal"><Terminal lines={terminalLines} /></div>;
    case "notification":
      return <NotificationPreviewSamples />;
    default:
      return <p>未知组件：{id}</p>;
  }
}

function ThemePreview({ id, dark }: { id: string; dark: boolean }) {
  const title = document.body.dataset.title ?? id;
  return (
    <section className={`preview-theme rivet-ui ${dark ? "rivet-theme-dark" : "rivet-theme-light"}`}>
      <NotificationProvider locale="zh" viewportMode="absolute">
        <h1 className="preview-title">{title}</h1>
        <p className="preview-subtitle">{dark ? "Dark" : "Light"} · Rivet component preview</p>
        <div className="preview-demo">
          <ComponentPreview id={id} dark={dark} />
        </div>
      </NotificationProvider>
    </section>
  );
}

const id = document.body.dataset.component ?? "";
createRoot(document.getElementById("root")!).render(
  <main className="preview-root">
    <ThemePreview id={id} dark={false} />
    <ThemePreview id={id} dark />
  </main>
);
