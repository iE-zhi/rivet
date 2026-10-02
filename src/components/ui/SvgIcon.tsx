import type { CSSProperties } from "react";
import backIcon from "../../assets/svg/back.svg?url";
import portIcon from "../../assets/svg/port.svg?url";
import checkIcon from "../../assets/svg/check.svg?url";
import chevronIcon from "../../assets/svg/chevron.svg?url";
import closeIcon from "../../assets/svg/close.svg?url";
import cmdIcon from "../../assets/svg/cmd.svg?url";
import copyIcon from "../../assets/svg/copy.svg?url";
import displayIcon from "../../assets/svg/display.svg?url";
import downloadIcon from "../../assets/svg/download.svg?url";
import fileIcon from "../../assets/svg/file.svg?url";
import folderIcon from "../../assets/svg/folder.svg?url";
import globeIcon from "../../assets/svg/globe.svg?url";
import groupIcon from "../../assets/svg/group.svg?url";
import infoIcon from "../../assets/svg/info.svg?url";
import listIcon from "../../assets/svg/list.svg?url";
import moreIcon from "../../assets/svg/more.svg?url";
import plusIcon from "../../assets/svg/plus.svg?url";
import plugIcon from "../../assets/svg/plug.svg?url";
import refreshIcon from "../../assets/svg/refresh.svg?url";
import retryIcon from "../../assets/svg/retry.svg?url";
import searchIcon from "../../assets/svg/search.svg?url";
import showIcon from "../../assets/svg/show.svg?url";
import settingIcon from "../../assets/svg/setting.svg?url";
import sendIcon from "../../assets/svg/send.svg?url";
import serialIcon from "../../assets/svg/serial.svg?url";
import splitHorizontalIcon from "../../assets/svg/split-horizontal.svg?url";
import splitVerticalIcon from "../../assets/svg/split-vertical.svg?url";
import terminalIcon from "../../assets/svg/terminal.svg?url";
import uploadIcon from "../../assets/svg/upload.svg?url";
import unshowIcon from "../../assets/svg/unshow.svg?url";
import unplugIcon from "../../assets/svg/unplug.svg?url";
import waveIcon from "../../assets/svg/wave.svg?url";

/** 可共用的单色图标标识；SVG 通过 CSS mask 继承所在位置的文字颜色。 */
export type SvgIconName = "back" | "port" | "check" | "chevron" | "close" | "cmd" | "copy" | "display" | "download" | "file" | "folder" | "globe" | "group" | "info" | "list" | "more" | "plus" | "plug" | "refresh" | "retry" | "search" | "send" | "serial" | "setting" | "show" | "split-horizontal" | "split-vertical" | "terminal" | "unplug" | "unshow" | "upload" | "wave";

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
  back: backIcon,
  port: portIcon,
  check: checkIcon,
  chevron: chevronIcon,
  close: closeIcon,
  cmd: cmdIcon,
  copy: copyIcon,
  display: displayIcon,
  download: downloadIcon,
  file: fileIcon,
  folder: folderIcon,
  globe: globeIcon,
  group: groupIcon,
  info: infoIcon,
  list: listIcon,
  more: moreIcon,
  plus: plusIcon,
  plug: plugIcon,
  refresh: refreshIcon,
  retry: retryIcon,
  search: searchIcon,
  show: showIcon,
  send: sendIcon,
  serial: serialIcon,
  setting: settingIcon,
  "split-horizontal": splitHorizontalIcon,
  "split-vertical": splitVerticalIcon,
  terminal: terminalIcon,
  upload: uploadIcon,
  unplug: unplugIcon,
  unshow: unshowIcon,
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
