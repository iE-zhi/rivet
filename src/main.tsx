import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./App.css";

/** 挂载桌面端串口工作台；组件预览仍使用独立的 Vite 入口。 */
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
