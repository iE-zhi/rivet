import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent } from "react";
import { Input, Select, SvgIcon, Switch, type SelectOption } from "../components/ui";
import { MAX_SERIAL_BAUD_RATE, SERIAL_DATA_BITS, SERIAL_STOP_BITS, type SerialDefaults, type SerialFlowControl, type SerialParity } from "./serialDefaults";
import type { Locale } from "./SerialPage";

/** 支持的主题模式；system 会随操作系统外观变化。 */
export type ThemeMode = "system" | "light" | "dark";

/** 字体显示模式；builtin 使用随应用打包的字体，system 使用平台界面字体。 */
export type FontMode = "builtin" | "system";

/** 设置页在当前语言下展示的栏目、分组与下拉选项。 */
interface SettingsPageCopy {
  /** 设置侧栏的可访问名称。 */
  navigation: string;
  /** 显示设置栏目名称。 */
  display: string;
  /** 串口设置栏目名称。 */
  serial: string;
  /** 显示设置组标题，呈现在设置列表容器之外。 */
  groupTitle: string;
  /** 串口默认参数组标题，呈现在设置列表容器之外。 */
  serialGroupTitle: string;
  /** 是否在启动串口页时采用默认通信参数的设置项。 */
  useSerialDefaults: string;
  /** 语言设置行标题。 */
  language: string;
  /** 主题设置行标题。 */
  theme: string;
  /** 字体设置行标题。 */
  font: string;
  /** 串口默认通信参数的行标题。 */
  baud: string;
  /** 数据位设置行标题。 */
  dataBits: string;
  /** 奇偶校验设置行标题。 */
  parity: string;
  /** 停止位设置行标题。 */
  stopBits: string;
  /** 流控设置行标题。 */
  flowControl: string;
  /** 波特率输入无效时说明约束的反馈。 */
  invalidBaud: string;
  /** 语言下拉选项。 */
  languageOptions: SelectOption[];
  /** 主题下拉选项。 */
  themeOptions: SelectOption[];
  /** 字体下拉选项。 */
  fontOptions: SelectOption[];
  /** 串口数据位下拉选项。 */
  dataBitOptions: SelectOption[];
  /** 串口校验位下拉选项。 */
  parityOptions: SelectOption[];
  /** 串口停止位下拉选项。 */
  stopBitOptions: SelectOption[];
  /** 串口流控下拉选项。 */
  flowControlOptions: SelectOption[];
}

/** 设置页中英文文案；默认语言为中文，主题名随界面语言切换。 */
const SETTINGS_PAGE_COPY: Record<Locale, SettingsPageCopy> = {
  zh: {
    navigation: "设置分类",
    display: "显示",
    serial: "串口",
    groupTitle: "界面偏好",
    serialGroupTitle: "默认通信参数",
    useSerialDefaults: "启用默认通信参数",
    language: "语言",
    theme: "主题",
    font: "字体",
    baud: "波特率",
    dataBits: "数据位",
    parity: "校验位",
    stopBits: "停止位",
    flowControl: "流控",
    invalidBaud: "请输入 1 到 4,294,967,295 之间的整数。",
    languageOptions: [
      { value: "zh", label: "中文 (简体)" },
      { value: "en", label: "English" },
    ],
    themeOptions: [
      { value: "system", label: "跟随系统" },
      { value: "light", label: "浅色" },
      { value: "dark", label: "深色" },
    ],
    fontOptions: [
      { value: "builtin", label: "应用内置" },
      { value: "system", label: "系统" },
    ],
    dataBitOptions: SERIAL_DATA_BITS.map((value) => ({ value: String(value), label: `${value} 位` })),
    parityOptions: [
      { value: "none", label: "无校验" },
      { value: "even", label: "偶校验" },
      { value: "odd", label: "奇校验" },
    ],
    stopBitOptions: SERIAL_STOP_BITS.map((value) => ({ value: String(value), label: `${value} 位` })),
    flowControlOptions: [
      { value: "none", label: "无" },
      { value: "hardware", label: "硬件 RTS/CTS" },
      { value: "software", label: "软件 XON/XOFF" },
    ],
  },
  en: {
    navigation: "Settings sections",
    display: "Display",
    serial: "Serial",
    groupTitle: "Appearance",
    serialGroupTitle: "Default communication parameters",
    useSerialDefaults: "Use default communication parameters",
    language: "Language",
    theme: "Theme",
    font: "Font",
    baud: "Baud rate",
    dataBits: "Data bits",
    parity: "Parity",
    stopBits: "Stop bits",
    flowControl: "Flow control",
    invalidBaud: "Enter an integer from 1 to 4,294,967,295.",
    languageOptions: [
      { value: "zh", label: "Chinese (Simplified)" },
      { value: "en", label: "English" },
    ],
    themeOptions: [
      { value: "system", label: "System" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
    fontOptions: [
      { value: "builtin", label: "Built-in" },
      { value: "system", label: "System" },
    ],
    dataBitOptions: SERIAL_DATA_BITS.map((value) => ({ value: String(value), label: `${value} bits` })),
    parityOptions: [
      { value: "none", label: "None" },
      { value: "even", label: "Even" },
      { value: "odd", label: "Odd" },
    ],
    stopBitOptions: SERIAL_STOP_BITS.map((value) => ({ value: String(value), label: `${value} ${value === SERIAL_STOP_BITS[0] ? "bit" : "bits"}` })),
    flowControlOptions: [
      { value: "none", label: "None" },
      { value: "hardware", label: "Hardware RTS/CTS" },
      { value: "software", label: "Software XON/XOFF" },
    ],
  },
};

/** 显示设置页参数；父级持有语言和主题状态以同步整个应用。 */
export interface SettingsPageProps {
  /** 当前应用语言。 */
  locale: Locale;
  /** 修改全局应用语言的回调。 */
  onLocaleChange: (locale: Locale) => void;
  /** 用户偏好的主题模式。 */
  theme: ThemeMode;
  /** 修改全局主题模式的回调。 */
  onThemeChange: (theme: ThemeMode) => void;
  /** 当前字体模式。 */
  font: FontMode;
  /** 修改全局字体模式的回调。 */
  onFontChange: (font: FontMode) => void;
  /** 当前由应用外壳持有并持久化的串口默认参数。 */
  serialDefaults: SerialDefaults;
  /** 更新经过界面校验的串口默认参数。 */
  onSerialDefaultsChange: (defaults: SerialDefaults) => void;
  /** 当前启动时是否采用设置页默认通信参数。 */
  useSerialDefaults: boolean;
  /** 更新默认通信参数开关；新状态会持久化并影响后续启动。 */
  onUseSerialDefaultsChange: (enabled: boolean) => void;
}

/** 设置页右侧当前展示的分组。 */
type SettingsCategory = "display" | "serial";

/**
 * 判断下拉组件提供的值是否是可用的语言。
 * @param value 下拉组件当前返回的字符串值。
 * @returns 值是受支持语言时为 true。
 */
function isLocale(value: string): value is Locale {
  return value === "zh" || value === "en";
}

/**
 * 判断下拉组件提供的值是否是可用的主题模式。
 * @param value 下拉组件当前返回的字符串值。
 * @returns 值是受支持主题模式时为 true。
 */
function isThemeMode(value: string): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * 判断下拉组件提供的值是否是可用的字体模式。
 * @param value 下拉组件当前返回的字符串值。
 * @returns 值是受支持字体模式时为 true。
 */
function isFontMode(value: string): value is FontMode {
  return value === "builtin" || value === "system";
}

/**
 * 将十进制波特率草稿解析为受支持的 u32 值。
 * @param value 输入框中的原始字符串。
 * @returns 有效波特率；空白、非十进制、零或越界值返回 null。
 */
function parseBaudRate(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const baudRate = Number(value);
  return Number.isInteger(baudRate) && baudRate >= 1 && baudRate <= MAX_SERIAL_BAUD_RATE ? baudRate : null;
}

/**
 * 显示界面语言、主题和字体选择，并保留设置分类导航入口。
 * @param locale 当前应用语言。
 * @param onLocaleChange 用户选择新语言后的回调。
 * @param theme 当前主题模式。
 * @param onThemeChange 用户选择新主题后的回调。
 * @param font 当前字体模式。
 * @param onFontChange 用户选择新字体模式后的回调。
 * @param serialDefaults 当前应用级串口默认通信参数。
 * @param onSerialDefaultsChange 用户修改串口默认参数后的回调。
 * @param useSerialDefaults 启动串口页时是否采用设置页默认通信参数。
 * @param onUseSerialDefaultsChange 用户切换默认通信参数开关后的回调。
 * @returns 设置侧栏和显示偏好分组。
 */
export default function SettingsPage({ locale, onLocaleChange, theme, onThemeChange, font, onFontChange, serialDefaults, onSerialDefaultsChange, useSerialDefaults, onUseSerialDefaultsChange }: SettingsPageProps) {
  /** 取当前界面语言的文案和选项列表。 */
  const copy = SETTINGS_PAGE_COPY[locale];
  /** 设置页默认展示显示偏好；栏目切换只影响右侧当前分组。 */
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("display");
  /** 文本草稿允许编辑期间显示无效内容，持久化状态始终只保存有效整数。 */
  const [baudDraft, setBaudDraft] = useState(String(serialDefaults.baudRate));
  /** 波特率无效时保留草稿并给出即时反馈，失焦后恢复最后一个有效值。 */
  const [baudInvalid, setBaudInvalid] = useState(false);
  /** 开关指针激活造成输入框失焦时，阻止草稿提交到默认通信参数。 */
  const suppressBaudBlurCommitRef = useRef(false);

  useEffect(() => {
    /** 外部默认值变化时同步波特率输入，避免显示陈旧草稿。 */
    setBaudDraft(String(serialDefaults.baudRate));
    setBaudInvalid(false);
  }, [serialDefaults.baudRate]);

  /**
   * 只把受支持的语言值转交给外层状态。
   * @param value 下拉组件返回的候选语言值。
   * @returns 无；无效候选值不会更新应用语言。
   */
  const handleLocaleChange = (value: string) => {
    if (isLocale(value)) {
      onLocaleChange(value);
    }
  };

  /**
   * 只把受支持的主题模式转交给外层状态。
   * @param value 下拉组件返回的候选主题值。
   * @returns 无；无效候选值不会更新应用主题。
   */
  const handleThemeChange = (value: string) => {
    if (isThemeMode(value)) {
      onThemeChange(value);
    }
  };

  /**
   * 只把受支持的字体模式转交给外层状态。
   * @param value 下拉组件返回的候选字体值。
   * @returns 无；无效候选值不会更新应用字体。
   */
  const handleFontChange = (value: string) => {
    if (isFontMode(value)) {
      onFontChange(value);
    }
  };

  /**
   * 只显示显示偏好分组，并更新设置侧栏的当前栏目。
   * @returns 无；更新设置页当前栏目状态。
   */
  const showDisplaySettings = () => setActiveCategory("display");

  /**
   * 只显示串口默认通信参数分组，并更新设置侧栏的当前栏目。
   * @returns 无；更新设置页当前栏目状态。
   */
  const showSerialSettings = () => setActiveCategory("serial");

  /**
   * 校验十进制波特率草稿并即时显示错误；持久化在失焦时提交。
   * @param event 波特率输入框的文本变化事件。
   * @returns 无；只保存草稿和有效状态提示。
   */
  const handleBaudRateChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.value;
    setBaudDraft(value);
    setBaudInvalid(parseBaudRate(value) === null);
  };

  /** 记录指针是否正在点击开关，以识别关闭操作触发的波特率失焦。 */
  const handleUseSerialDefaultsPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('[role="switch"]')) {
      suppressBaudBlurCommitRef.current = useSerialDefaults;
    }
  };

  /** 切换默认参数开关，并在关闭时恢复未提交波特率草稿为已保存值并清除错误。 */
  const handleUseSerialDefaultsChange = (enabled: boolean) => {
    suppressBaudBlurCommitRef.current = false;
    if (!enabled) {
      setBaudDraft(String(serialDefaults.baudRate));
      setBaudInvalid(false);
    }
    onUseSerialDefaultsChange(enabled);
  };

  /**
   * 有效波特率离开输入框时提交；无效草稿回退到最近一次已保存值。
   * @returns 无；有效值更新应用默认参数，无效值只恢复显示草稿。
   */
  const handleBaudRateBlur = () => {
    if (suppressBaudBlurCommitRef.current || !useSerialDefaults) {
      suppressBaudBlurCommitRef.current = false;
      return;
    }
    const baudRate = parseBaudRate(baudDraft);
    if (baudRate === null) {
      setBaudDraft(String(serialDefaults.baudRate));
      setBaudInvalid(false);
      return;
    }
    setBaudDraft(String(baudRate));
    setBaudInvalid(false);
    if (baudRate !== serialDefaults.baudRate) {
      onSerialDefaultsChange({ ...serialDefaults, baudRate });
    }
  };

  /**
   * 仅接收支持的数据位选项并更新默认参数。
   * @param value 下拉组件返回的候选数据位字符串。
   * @returns 无；无效候选值不改变默认参数。
   */
  const handleDataBitsChange = (value: string) => {
    const dataBits = Number(value);
    if (SERIAL_DATA_BITS.includes(dataBits as (typeof SERIAL_DATA_BITS)[number])) {
      onSerialDefaultsChange({ ...serialDefaults, dataBits });
    }
  };

  /**
   * 仅接收支持的奇偶校验选项并更新默认参数。
   * @param value 下拉组件返回的候选校验值。
   * @returns 无；无效候选值不改变默认参数。
   */
  const handleParityChange = (value: string) => {
    if (value === "none" || value === "even" || value === "odd") {
      onSerialDefaultsChange({ ...serialDefaults, parity: value as SerialParity });
    }
  };

  /**
   * 仅接收支持的停止位选项并更新默认参数。
   * @param value 下拉组件返回的候选停止位字符串。
   * @returns 无；无效候选值不改变默认参数。
   */
  const handleStopBitsChange = (value: string) => {
    const stopBits = Number(value);
    if (SERIAL_STOP_BITS.includes(stopBits as (typeof SERIAL_STOP_BITS)[number])) {
      onSerialDefaultsChange({ ...serialDefaults, stopBits });
    }
  };

  /**
   * 仅接收支持的流控选项并更新默认参数。
   * @param value 下拉组件返回的候选流控值。
   * @returns 无；无效候选值不改变默认参数。
   */
  const handleFlowControlChange = (value: string) => {
    if (value === "none" || value === "hardware" || value === "software") {
      onSerialDefaultsChange({ ...serialDefaults, flowControl: value as SerialFlowControl });
    }
  };

  return (
    <div className="settings-page">
      <nav className="settings-sidebar" aria-label={copy.navigation}>
        <button className="settings-nav-item" type="button" aria-current={activeCategory === "display" ? "page" : undefined} onClick={showDisplaySettings}>
          <SvgIcon name="display" size={18} />
          <span>{copy.display}</span>
        </button>
        <button className="settings-nav-item" type="button" aria-current={activeCategory === "serial" ? "page" : undefined} onClick={showSerialSettings}>
          <SvgIcon name="serial" size={18} />
          <span>{copy.serial}</span>
        </button>
      </nav>
      <main className="settings-main" id="settings-display" aria-labelledby="settings-group-title">
        <div className="settings-main-content">
          {activeCategory === "display" ? (
            <section className="settings-section" aria-labelledby="settings-group-title">
              <h1 className="settings-section-title" id="settings-group-title">{copy.groupTitle}</h1>
              <div className="settings-list">
                <div className="settings-row">
                  <span className="settings-row-label">{copy.language}</span>
                  <Select className="settings-select" ariaLabel={copy.language} options={copy.languageOptions} value={locale} onChange={handleLocaleChange} />
                </div>
                <div className="settings-row">
                  <span className="settings-row-label">{copy.theme}</span>
                  <Select className="settings-select" ariaLabel={copy.theme} options={copy.themeOptions} value={theme} onChange={handleThemeChange} />
                </div>
                <div className="settings-row">
                  <span className="settings-row-label">{copy.font}</span>
                  <Select className="settings-select" ariaLabel={copy.font} options={copy.fontOptions} value={font} onChange={handleFontChange} />
                </div>
              </div>
            </section>
          ) : (
            <section className="settings-section" aria-labelledby="settings-group-title">
              <h1 className="settings-section-title" id="settings-group-title">{copy.serialGroupTitle}</h1>
              <div className="settings-list">
                <div className="settings-row" onPointerDown={handleUseSerialDefaultsPointerDown}>
                  <span className="settings-row-label">{copy.useSerialDefaults}</span>
                  <Switch checked={useSerialDefaults} onCheckedChange={handleUseSerialDefaultsChange} ariaLabel={copy.useSerialDefaults} />
                </div>
                <div className={`settings-row${baudInvalid ? " has-feedback" : ""}`}>
                  <span className="settings-row-label">{copy.baud}</span>
                  <div className="settings-row-control">
                    <Input
                      aria-label={copy.baud}
                      aria-invalid={baudInvalid}
                      aria-describedby={baudInvalid ? "serial-baud-error" : undefined}
                      className="settings-input"
                      disabled={!useSerialDefaults}
                      inputMode="numeric"
                      maxLength={10}
                      value={baudDraft}
                      onChange={handleBaudRateChange}
                      onBlur={handleBaudRateBlur}
                    />
                    {baudInvalid && <span className="settings-row-feedback" id="serial-baud-error" role="alert">{copy.invalidBaud}</span>}
                  </div>
                </div>
                <div className="settings-row">
                  <span className="settings-row-label">{copy.dataBits}</span>
                  <Select className="settings-select" ariaLabel={copy.dataBits} options={copy.dataBitOptions} value={String(serialDefaults.dataBits)} onChange={handleDataBitsChange} disabled={!useSerialDefaults} />
                </div>
                <div className="settings-row">
                  <span className="settings-row-label">{copy.parity}</span>
                  <Select className="settings-select" ariaLabel={copy.parity} options={copy.parityOptions} value={serialDefaults.parity} onChange={handleParityChange} disabled={!useSerialDefaults} />
                </div>
                <div className="settings-row">
                  <span className="settings-row-label">{copy.stopBits}</span>
                  <Select className="settings-select" ariaLabel={copy.stopBits} options={copy.stopBitOptions} value={String(serialDefaults.stopBits)} onChange={handleStopBitsChange} disabled={!useSerialDefaults} />
                </div>
                <div className="settings-row">
                  <span className="settings-row-label">{copy.flowControl}</span>
                  <Select className="settings-select" ariaLabel={copy.flowControl} options={copy.flowControlOptions} value={serialDefaults.flowControl} onChange={handleFlowControlChange} disabled={!useSerialDefaults} />
                </div>
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
