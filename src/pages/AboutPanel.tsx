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

  /** 桌面端通过后端打开白名单项目主页；Web 预览仍使用普通新窗口。 */
  const handleProjectLinkClick = (
    event: MouseEvent<HTMLAnchorElement>,
    project: "github" | "gitee",
    url: string,
  ) => {
    event.preventDefault();
    if ("__TAURI_INTERNALS__" in window) {
      void invoke("open_project_page", { project }).catch((error) => {
        console.error("Rivet 无法打开项目主页。", error);
      });
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="settings-about">
      <section className="settings-about-product" aria-labelledby="settings-about-title">
        <img className="settings-about-logo" src={appIcon} alt="" aria-hidden="true" />
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
                onClick={(event) => handleProjectLinkClick(event, "github", GITHUB_PROJECT_URL)}
              >
                GitHub
              </a>
              <a
                className="settings-about-link"
                href={GITEE_PROJECT_URL}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => handleProjectLinkClick(event, "gitee", GITEE_PROJECT_URL)}
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
