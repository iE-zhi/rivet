import { invoke } from "@tauri-apps/api/core";
import type { MouseEvent } from "react";
import appIcon from "../assets/svg/app-icon.svg";
import { APP_VERSION } from "../appVersion";
import type { Locale } from "./SerialPage";

const GITHUB_PROJECT_URL = "https://github.com/iE-zhi/rivet";
const GITEE_PROJECT_URL = "https://gitee.com/boo0ood/rivet";

/** 单日 Git 提交汇总后的关于页时间线条目。 */
interface AboutTimelineItem {
  date: string;
  title: string;
  description: string;
}

/** 关于页中英文文案；时间线内容来自当前仓库 Git 历史并按自然日归并。 */
const ABOUT_COPY: Record<Locale, {
  description: string;
  platform: string;
  core: string;
  project: string;
  timeline: AboutTimelineItem[];
}> = {
  zh: {
    description: "面向开发、调试与设备连接场景的跨平台工具箱。",
    platform: "平台",
    core: "核心",
    project: "项目地址",
    timeline: [
      {
        date: "2026.11.06",
        title: "终端首次打开时的字距修复",
        description: "修复首次打开终端时因内置字体尚未加载而导致的字符拥挤。",
      },
      {
        date: "2026.11.05",
        title: "VNC 剪贴板与画面刷新",
        description: "支持双向文本剪贴板同步，鼠标移至顶部可唤出远程工具栏，并优化画面批量更新。",
      },
      {
        date: "2026.10.31",
        title: "Markdown 数学公式与 VNC 账户认证",
        description: "Markdown 支持公式渲染、双击编辑和命令补全，并改进目录与代码块交互。VNC 支持 macOS 账户认证，并改进键盘输入和浮动工具栏。",
      },
      {
        date: "2026.10.30",
        title: "VNC 刷新优化与 Linux 启动修复",
        description: "优化 VNC 增量刷新并简化连接界面，修复 Linux 启动窗口不显示和图标模糊问题，以及终端中 nmtui 选项的颜色显示。",
      },
      {
        date: "2026.10.28",
        title: "VNC 远程桌面与 Markdown 工作区",
        description: "新增独立 VNC 远程桌面，以及支持本地和远程文件、文件树与图表预览的 Markdown 块编辑器。",
      },
      {
        date: "2026.10.09",
        title: "终端连接失败后可重连",
        description: "修复终端连接失败后重连按钮缺失的问题。",
      },
      {
        date: "2026.10.05",
        title: "版本更新至 0.2.3",
        description: "0.2.3 纳入 SSH 高级连接、保活设置及终端历史候选布局修复。",
      },
      {
        date: "2026.10.03",
        title: "SSH 保活与终端候选布局",
        description: "支持配置 SSH 保活并跨设备同步，修复历史命令候选遮挡当前输入行的问题。",
      },
      {
        date: "2026.10.02",
        title: "SSH 高级连接",
        description: "支持本地、远程和动态端口转发、多级跳板机、SSH Agent 认证与交互式双因素认证。",
      },
      {
        date: "2026.09.30",
        title: "0.2.2 与多行命令历史",
        description: "更新至 0.2.2，完善多行命令的记录、搜索和回填。",
      },
      {
        date: "2026.09.29",
        title: "0.2.1 与终端会话改进",
        description: "更新至 0.2.1，完善历史候选匹配、Shell Integration 和输入法交互，新增 SSH/串口重试、快捷命令过滤与活动栏滚动条设置。",
      },
      {
        date: "2026.09.28",
        title: "0.2.0 与终端历史体系",
        description: "升级至 0.2.0，加入终端历史命令补全和 Windows PowerShell/PowerShell 7 支持，新增默认 PowerShell 选择、分组管理与拖拽排序，并完善自定义标题栏与浮层体验。",
      },
      {
        date: "2026.09.27",
        title: "X11 与快捷命令体验完善",
        description: "完善 Windows、Linux 与 macOS 的 X11 转发链路和 X Server 下载入口，同步改为无感热更新，并为终端快捷命令增加详情与展开查看。",
      },
      {
        date: "2026.09.26",
        title: "SSH、同步与终端能力完善",
        description: "新增 X11 Server 设置、多平台配置同步和离线备份，完善 SSH 会话、SFTP 传输及终端快捷命令。",
      },
      {
        date: "2026.09.25",
        title: "快捷命令与桌面体验优化",
        description: "串口快捷命令支持管理和重新编辑，同时优化通知开关、窗口标题与 Windows 应用图标。",
      },
      {
        date: "2026.09.24",
        title: "串口工作台与设置体系成型",
        description: "建立串口工作台，完善日志导出、接收分包、默认参数、设置页布局、滚动条和全局字体。",
      },
      {
        date: "2026.09.23",
        title: "项目与设计系统初始化",
        description: "初始化 Rivet UI 组件与设计系统，并补充工程协作与验收规则。",
      },
    ],
  },
  en: {
    description: "A cross-platform toolbox for development, debugging, and device connectivity.",
    platform: "Platforms",
    core: "Core",
    project: "Project",
    timeline: [
      {
        date: "2026.11.06",
        title: "Terminal spacing fix on first open",
        description: "Fixed crowded characters when opening the terminal before its bundled font had loaded.",
      },
      {
        date: "2026.11.05",
        title: "VNC clipboard and display updates",
        description: "Added two-way text clipboard sync, made the toolbar appear when hovering at the top, and improved batched display updates.",
      },
      {
        date: "2026.10.31",
        title: "Markdown math and VNC account authentication",
        description: "Added math rendering, double-click editing, and command completion in Markdown, and improved its outline and code blocks. VNC gained macOS account authentication and improved keyboard input and floating toolbar controls.",
      },
      {
        date: "2026.10.30",
        title: "VNC refresh and Linux startup fixes",
        description: "Improved incremental VNC updates and simplified connection setup. Fixed the missing startup window and blurry icons on Linux, along with terminal colors for nmtui options.",
      },
      {
        date: "2026.10.28",
        title: "VNC remote desktop and Markdown workspace",
        description: "Added a dedicated VNC remote desktop and a Markdown block editor for local and remote files, with a file tree and diagram previews.",
      },
      {
        date: "2026.10.09",
        title: "Terminal reconnect after connection failure",
        description: "Restored the reconnect button after a terminal connection fails.",
      },
      {
        date: "2026.10.05",
        title: "Version updated to 0.2.3",
        description: "Version 0.2.3 includes advanced SSH connections, keepalive settings, and a fix for the terminal history suggestion layout.",
      },
      {
        date: "2026.10.03",
        title: "SSH keepalive and terminal suggestions",
        description: "Added configurable SSH keepalive with cross-device sync and fixed history suggestions obscuring the active input line.",
      },
      {
        date: "2026.10.02",
        title: "Advanced SSH connections",
        description: "Added local, remote, and dynamic port forwarding, multi-hop jump hosts, SSH agent authentication, and interactive two-factor authentication.",
      },
      {
        date: "2026.09.30",
        title: "0.2.2 and multiline command history",
        description: "Updated to 0.2.2 with better recording, search, and insertion of multiline commands.",
      },
      {
        date: "2026.09.29",
        title: "0.2.1 and terminal session improvements",
        description: "Updated to 0.2.1, improved history matching, Shell Integration, and IME handling, and added SSH/serial retry actions, quick command filtering, and activity-bar scrollbar settings.",
      },
      {
        date: "2026.09.28",
        title: "0.2.0 and terminal history foundation",
        description: "Upgraded to 0.2.0 with terminal history completion and Windows PowerShell/PowerShell 7 support, added default PowerShell selection, group management with drag sorting, and refined the custom title bar and popup experience.",
      },
      {
        date: "2026.09.27",
        title: "X11 and quick command improvements",
        description: "Improved X11 forwarding across Windows, Linux, and macOS with X Server download links, switched sync to hot updates without reloads, and added details with inline expansion for terminal quick commands.",
      },
      {
        date: "2026.09.26",
        title: "SSH, sync, and terminal improvements",
        description: "Added X11 Server settings, multi-platform configuration sync and offline backup, while extending SSH sessions, SFTP transfers, and terminal quick commands.",
      },
      {
        date: "2026.09.25",
        title: "Quick commands and desktop polish",
        description: "Added management and re-editing for serial quick commands, plus notification settings, window title cleanup, and sharper Windows app icons.",
      },
      {
        date: "2026.09.24",
        title: "Serial workspace and settings foundation",
        description: "Built the serial workspace and improved log export, receive grouping, default parameters, settings layout, scrollbars, and bundled fonts.",
      },
      {
        date: "2026.09.23",
        title: "Project and design system initialized",
        description: "Initialized the Rivet UI component system and added project collaboration and acceptance rules.",
      },
    ],
  },
};

export interface AboutPanelProps {
  locale: Locale;
}

/** 展示 Rivet 产品信息和按天汇总的 Git 开发时间线。 */
export default function AboutPanel({ locale }: AboutPanelProps) {
  const copy = ABOUT_COPY[locale];

  /** 桌面端通过后端打开白名单外部页面；Web 预览仍使用普通新窗口。 */
  const handleProjectLinkClick = (
    event: MouseEvent<HTMLAnchorElement>,
    page: "rivet-github" | "rivet-gitee",
    url: string,
  ) => {
    event.preventDefault();
    if ("__TAURI_INTERNALS__" in window) {
      void invoke("open_external_page", { page }).catch((error) => {
        console.error("Rivet 无法打开项目主页。", error);
      });
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="settings-about">
      <section className="settings-about-product" aria-labelledby="settings-about-title">
        <div className="settings-about-logo-wrap" aria-hidden="true">
          <img className="settings-about-logo" src={appIcon} alt="" />
        </div>
        <h1 className="settings-about-name" id="settings-about-title">Rivet</h1>
        <div className="settings-about-version">Version {APP_VERSION}</div>
        <p className="settings-about-description">{copy.description}</p>
        <div className="settings-about-meta">
          <div className="settings-about-meta-row">
            <span>{copy.platform}</span>
            <strong>Windows · Linux · macOS</strong>
          </div>
          <div className="settings-about-meta-row">
            <span>{copy.core}</span>
            <strong>Tauri 2 · React · Rust</strong>
          </div>
          <div className="settings-about-meta-row">
            <span>{copy.project}</span>
            <span className="settings-about-project-links">
              <a
                className="settings-about-link"
                href={GITHUB_PROJECT_URL}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => handleProjectLinkClick(event, "rivet-github", GITHUB_PROJECT_URL)}
              >
                GitHub
              </a>
              <a
                className="settings-about-link"
                href={GITEE_PROJECT_URL}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => handleProjectLinkClick(event, "rivet-gitee", GITEE_PROJECT_URL)}
              >
                Gitee
              </a>
            </span>
          </div>
        </div>
      </section>

      <div className="settings-about-divider" aria-hidden="true" />

      <section className="settings-about-timeline" aria-label={locale === "zh" ? "开发时间线" : "Development timeline"}>
        <div className="settings-about-timeline-content">
          {copy.timeline.map((item, index) => (
            <article
              className={`settings-about-timeline-item ${index % 2 === 0 ? "is-left" : "is-right"} tone-${index % 4}`}
              key={item.date}
            >
              <div className="settings-about-timeline-card">
                <time className="settings-about-timeline-date">{item.date}</time>
                <div className="settings-about-timeline-title">{item.title}</div>
                <div className="settings-about-timeline-description">{item.description}</div>
              </div>
              <div className="settings-about-timeline-center">
                <span className="settings-about-timeline-dot" />
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
