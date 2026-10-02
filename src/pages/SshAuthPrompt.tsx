/** 服务端自动触发的认证输入；一次性响应不进入连接草稿、浏览器存储或日志。 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Input, VerticalScrollbar, useNotification } from "../components/ui";
import type { Locale } from "./SerialPage";
import "./sshAdvanced.css";

/** 单轮用户响应的字符上限；后端另按 UTF-8 字节验证。 */
const MAX_AUTH_RESPONSE_LENGTH = 4096;

/** 后端发出的单轮认证请求；requestId 在响应、超时或取消后失效。 */
export interface SshAuthRequest {
  /** 所属终端会话。 */
  sessionId: string;
  /** 一次性请求标识。 */
  requestId: string;
  /** 当前目标或跳板身份。 */
  host: string;
  /** 服务端提供的认证标题。 */
  name: string;
  /** 服务端本轮说明，仅作为纯文本渲染。 */
  instructions: string;
  /** 按服务端顺序输入，echo 为 false 时使用密码控件。 */
  prompts: { prompt: string; echo: boolean }[];
}

/** 请求归属后端；父终端只负责撤销对应一次性 UI 状态。 */
interface SshAuthPromptProps {
  /** 当前轮次的不可变请求。 */
  request: SshAuthRequest;
  /** 当前语言。 */
  locale: Locale;
  /** 仅在当前可见活动终端获得输入焦点。 */
  active: boolean;
  /** 提交或取消完成后清空本轮状态。 */
  onComplete: (requestId: string) => void;
}

/** 在终端内逐字段输入；末字段 Enter 提交整轮，Escape 取消，不进入终端历史。 */
export default function SshAuthPrompt({ request, locale, active, onComplete }: SshAuthPromptProps) {
  const zh = locale === "zh";
  const { notify } = useNotification();
  /** 仅组件生命周期内保存本轮响应，后端结束事件会卸载组件。 */
  const [responses, setResponses] = useState(() => request.prompts.map(/** 每个字段初始为空，不自动填充保存的密码。 */ () => ""));
  /** 同步防止双击及 Enter 重复提交。 */
  const pendingRef = useRef(false);
  /** 提交中禁用表单。 */
  const [pending, setPending] = useState(false);
  /** 当前轮次的终端行内表单。 */
  const formRef = useRef<HTMLFormElement>(null);
  /** 只传送本轮响应；失败保留输入并展示错误，不输出秘密。 */
  const respond = async (values: string[] | null) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await invoke("ssh_auth_respond", { sessionId: request.sessionId, requestId: request.requestId, responses: values });
      setResponses([]);
      onComplete(request.requestId);
    } catch (error) {
      notify({ kind: "error", message: `${zh ? "提交 SSH 认证失败：" : "SSH authentication response failed: "}${String(error)}` });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  /** Enter 默认提交仅适用于最后字段；提交期间禁用整轮输入。 */
  const submit = (event: FormEvent) => { event.preventDefault(); void respond(responses); };
  /** 自动聚焦当前活动终端，其他标签中的认证等待不抢占焦点。 */
  useEffect(() => {
    if (active) formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [request.requestId, active]);
  /** Escape 取消，Enter 依服务端字段顺序移动或提交，不向 PTY 传递认证输入。 */
  const keydown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (pendingRef.current) { event.preventDefault(); return; }
    if (event.key === "Escape") { event.preventDefault(); void respond(null); return; }
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const inputs = Array.from(formRef.current?.querySelectorAll<HTMLInputElement>("input") ?? []);
    const current = inputs.indexOf(event.target as HTMLInputElement);
    if (current >= 0 && current < inputs.length - 1) inputs[current + 1].focus();
    else void respond(responses);
  };
  return <form className="ssh-auth-prompt" ref={formRef} onSubmit={submit} onKeyDown={keydown} aria-label={zh ? "SSH 身份验证" : "SSH verification"} aria-busy={pending}>
    <VerticalScrollbar height="100%" viewportLabel={zh ? "认证字段" : "Authentication fields"}>
      <div className="ssh-auth-heading">{zh ? "正在连接 " : "Connecting to "}{request.host}...</div>
      {request.name && <div className="ssh-auth-heading">{request.name}</div>}
      {request.instructions && <div className="ssh-auth-instructions">{request.instructions}</div>}
      {request.prompts.map(/** 服务端文本仅以纯文本显示，无回显字段使用密码输入。 */ (prompt, index) => <label className="ssh-auth-line" key={index}>
        <span>{prompt.prompt || (zh ? "认证输入：" : "Authentication input: ")}</span>
        <Input className="ssh-auth-input" aria-label={prompt.prompt || (zh ? "认证输入" : "Authentication input")} type={prompt.echo ? "text" : "password"} value={responses[index] ?? ""} disabled={pending} autoComplete="off" maxLength={MAX_AUTH_RESPONSE_LENGTH} onChange={/** 只保留当前轮次的响应，不保存到历史或连接。 */ (event) => {
          const value = event.currentTarget.value;
          setResponses(/** 替换单个字段并保留服务端顺序。 */ (current) => current.map(/** 保留其他字段。 */ (item, field) => field === index ? value : item));
        }} />
      </label>)}
    </VerticalScrollbar>
  </form>;
}
