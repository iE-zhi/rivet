import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  Checkbox,
  Input,
  Radio,
  SearchInput,
  Select,
  Slider,
  Switch,
  Terminal,
  Textarea,
  VerticalScrollbar,
} from "../components/ui";
import "./preview.css";

const terminalLines = [
  { kind: "info" as const, prefix: "[12:00:01] INFO", text: "串口已打开 COM3 115200 8N1" },
  { kind: "rx" as const, prefix: "[12:00:02] RX", text: "48 65 6C 6C 6F 20 52 69 76 65 74" },
  { kind: "tx" as const, prefix: "[12:00:03] TX", text: "AT+VERSION\\r\\n" },
  { kind: "ok" as const, prefix: "[12:00:03] OK", text: "Rivet v0.1.0" },
];

function Row({ label, children, open = false }: { label: string; children: ReactNode; open?: boolean }) {
  return (
    <div className={`preview-row ${open ? "preview-row-open" : ""}`.trim()}>
      <span className="preview-label">{label}</span>
      {children}
    </div>
  );
}

function ComponentPreview({ id, dark }: { id: string; dark: boolean }) {
  switch (id) {
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
            <Select className="preview-select" options={[{ value: "com", label: "串口 (COM)" }]} />
            <Select className="preview-select" options={[{ value: "115200", label: "115200" }]} />
          </Row>
          <Row label="Open" open>
            <Select
              className="preview-select is-focus"
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
    case "terminal":
      return <div className="preview-terminal"><Terminal lines={terminalLines} /></div>;
    default:
      return <p>未知组件：{id}</p>;
  }
}

function ThemePreview({ id, dark }: { id: string; dark: boolean }) {
  const title = document.body.dataset.title ?? id;
  return (
    <section className={`preview-theme rivet-ui ${dark ? "rivet-theme-dark" : "rivet-theme-light"}`}>
      <h1 className="preview-title">{title}</h1>
      <p className="preview-subtitle">{dark ? "Dark" : "Light"} · Rivet component preview</p>
      <div className="preview-demo">
        <ComponentPreview id={id} dark={dark} />
      </div>
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
