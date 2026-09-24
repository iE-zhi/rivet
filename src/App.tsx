import { useState } from "react";
import appIcon from "../src-tauri/icons/128x128.png";
import { SvgIcon } from "./components/ui";
import SerialPage, { type Locale } from "./pages/SerialPage";

/** 串口工作台外壳所需的导航、品牌和语言切换文案。 */
const SHELL_COPY = {
  zh: { brand: "Rivet 串口工作台", navigation: "主导航", serial: "串口", locale: "切换语言", language: "English" },
  en: { brand: "Rivet serial console", navigation: "Main navigation", serial: "Serial", locale: "Switch language", language: "中文" },
} as const;

/**
 * 提供应用品牌、当前功能页导航和语言切换。
 * @returns 应用外壳、共享 SVG 导航图标及串口页面。
 */
export default function App() {
  const [locale, setLocale] = useState<Locale>("zh");
  const copy = SHELL_COPY[locale];

  /** 在中英文界面间切换；SerialPage 保持挂载以保留串口会话状态。 */
  const toggleLocale = () => setLocale((current) => current === "zh" ? "en" : "zh");

  return (
    <div className="app-shell rivet-ui">
      <nav className="rail" aria-label={copy.navigation}>
        <a className="brand-mark" href="#serial-page" aria-label={copy.brand} title="Rivet">
          <img src={appIcon} alt="" aria-hidden="true" />
        </a>
        <span className="rail-divider" aria-hidden="true" />
        <a className="rail-link active" href="#serial-page" aria-current="page" aria-label={copy.serial} title={copy.serial}>
          <SvgIcon name="serial" size={24} className="serial-icon" />
        </a>
        <span className="rail-spacer" />
        <button className="rail-link locale-button" aria-label={`${copy.locale}: ${copy.language}`} title={copy.locale} onClick={toggleLocale}>
          <SvgIcon name="globe" />
        </button>
      </nav>
      <SerialPage locale={locale} />
    </div>
  );
}
