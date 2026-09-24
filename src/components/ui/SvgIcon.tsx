import type { CSSProperties } from "react";
import checkIcon from "../../assets/svg/check.svg?url";
import chevronIcon from "../../assets/svg/chevron.svg?url";
import globeIcon from "../../assets/svg/globe.svg?url";
import infoIcon from "../../assets/svg/info.svg?url";
import plugIcon from "../../assets/svg/plug.svg?url";
import refreshIcon from "../../assets/svg/refresh.svg?url";
import searchIcon from "../../assets/svg/search.svg?url";
import sendIcon from "../../assets/svg/send.svg?url";
import serialIcon from "../../assets/svg/serial.svg?url";
import unplugIcon from "../../assets/svg/unplug.svg?url";
import waveIcon from "../../assets/svg/wave.svg?url";

/** 可共用的单色图标标识；SVG 通过 CSS mask 继承所在位置的文字颜色。 */
export type SvgIconName = "check" | "chevron" | "globe" | "info" | "plug" | "refresh" | "search" | "send" | "serial" | "unplug" | "wave";

/** SVG 图标组件参数；尺寸以 CSS 像素计，默认 17px。 */
export interface SvgIconProps {
  /** 对应 assets/svg 中的单色图标文件。 */
  name: SvgIconName;
  /** 图标宽高，单位为 CSS 像素；不传时为 17。 */
  size?: number;
  /** 附加样式类，用于原位布局和颜色控制。 */
  className?: string;
}

/** 图标标识到 Vite 资源 URL 的映射，供组件以 CSS mask 共享着色。 */
const SVG_ICON_SOURCES: Record<SvgIconName, string> = {
  check: checkIcon,
  chevron: chevronIcon,
  globe: globeIcon,
  info: infoIcon,
  plug: plugIcon,
  refresh: refreshIcon,
  search: searchIcon,
  send: sendIcon,
  serial: serialIcon,
  unplug: unplugIcon,
  wave: waveIcon,
};

/**
 * 绘制可继承 currentColor 的 SVG 图标；图标仅作装饰并从辅助技术树隐藏。
 * @param name 图标标识，必须对应共享 SVG 资源表中的条目。
 * @param size 图标宽高，单位为 CSS 像素，默认 17。
 * @param className 可选布局或颜色样式类。
 * @returns 包含 CSS mask 的装饰性 span。
 */
export function SvgIcon({ name, size = 17, className = "" }: SvgIconProps) {
  const source = SVG_ICON_SOURCES[name];
  const style: CSSProperties = {
    width: size,
    height: size,
    backgroundColor: "currentColor",
    maskImage: `url("${source}")`,
    maskPosition: "center",
    maskRepeat: "no-repeat",
    maskSize: "contain",
    WebkitMaskImage: `url("${source}")`,
    WebkitMaskPosition: "center",
    WebkitMaskRepeat: "no-repeat",
    WebkitMaskSize: "contain",
  };

  return <span className={`rivet-svg-icon ${className}`.trim()} aria-hidden="true" style={style} />;
}
