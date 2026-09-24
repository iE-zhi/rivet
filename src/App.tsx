import { useState } from "react";
import appIcon from "../src-tauri/icons/128x128.png";
import SerialPage, { type Locale } from "./pages/SerialPage";

/** 串口工作台外壳所需的导航、品牌和语言切换文案。 */
const SHELL_COPY = {
  zh: { brand: "Rivet 串口工作台", navigation: "主导航", serial: "串口", locale: "切换语言", language: "English" },
  en: { brand: "Rivet serial console", navigation: "Main navigation", serial: "Serial", locale: "Switch language", language: "中文" },
} as const;

/** 提供应用品牌、当前功能页导航和语言切换。 */
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
        <a className="rail-link active" href="#serial-page" aria-current="page" aria-label={copy.serial} title={copy.serial}>
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6l6 6-6 6M12 18h8" /></svg>
        </a>
        <span className="rail-spacer" />
        <button className="rail-link locale-button" aria-label={`${copy.locale}: ${copy.language}`} title={copy.locale} onClick={toggleLocale}>
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12a10 10 0 1 0 20 0 10 10 0 0 0-20 0zm0 0h20M12 2a15 15 0 0 1 0 20m0-20a15 15 0 0 0 0 20" /></svg>
        </button>
      </nav>
      <SerialPage locale={locale} />
    </div>
  );
}
