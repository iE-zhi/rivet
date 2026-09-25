import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { NotificationSettings } from "../../preferences/notificationSettings";

/**
 * 定义应用内通知的类型与访问上下文，供通知组件和页面共享。
 * 此模块不渲染界面，通知 Provider 负责提供上下文，Hook 负责读取通知 API。
 */

/** 通知严重程度控制图标、颜色和辅助技术播报优先级。 */
export type NotificationKind = "success" | "info" | "warning" | "error";

/** 全局通知的标题、正文、类型及可选自动关闭时长。 */
export interface NotificationOptions {
  /** 可选短标题；不提供时仅显示正文。 */
  title?: string;
  /** 必填正文；运行时会校验并截断超长内容。 */
  message: string;
  /** 通知语义类型；默认 info。 */
  kind?: NotificationKind;
  /** 自动关闭时长，单位毫秒；0 表示只手动关闭，默认 5000，最大 15000。 */
  durationMs?: number;
}

/** 全局通知 Provider 参数；children 与 Provider 生命周期一致。 */
export interface NotificationProviderProps {
  /** 当前界面语言，用于通知区域和关闭按钮的可访问名称。 */
  locale: "zh" | "en";
  /** 正式应用使用 fixed；组件预览可使用 absolute。 */
  viewportMode?: "fixed" | "absolute";
  /** 三类通知是否允许显示为弹窗；普通通知同时控制 success 与 info。 */
  visibility?: NotificationSettings;
  /** 可调用通知 API 的应用界面。 */
  children: ReactNode;
}

/** 页面通过 Provider 上下文调用全局通知 API。 */
interface NotificationContextValue {
  /** 新增一条全局通知；同一事件重复发生时每次都会创建独立提示。 */
  notify: (options: NotificationOptions) => void;
}

/** Provider 管理的应用内通知上下文；Provider 卸载后页面不得继续调用。 */
export const NotificationContext = createContext<NotificationContextValue | null>(null);

/**
 * 在 Provider 范围内返回全局通知函数。
 * @returns 用于在任意页面触发右上角通知的函数。
 * @throws 当前组件树没有 NotificationProvider 时抛出配置错误。
 */
export function useNotification(): NotificationContextValue {
  const context = useContext(NotificationContext);
  if (context === null) {
    throw new Error("useNotification 必须在 NotificationProvider 内调用。");
  }
  return context;
}
