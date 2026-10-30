/** 独立 VNC Tauri 接口；凭据只经过内存和后端加密存储，不写浏览器存储。 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { VncConnection } from "./model";

/** 有序的键鼠输入批次；最大长度与后端保持一致。 */
export type VncInput =
  | { kind: "key"; key: number; down: boolean }
  | { kind: "pointer"; x: number; y: number; buttons: number };

/** 启动可取消的直连会话；浏览器预览明确拒绝网络连接。 */
export async function openSession(
  sessionId: string,
  connection: VncConnection,
  password?: string,
): Promise<void> {
  if (!isTauri())
    throw new Error(
      "VNC 连接需要在 Rivet 桌面应用中使用 / VNC requires the desktop app",
    );
  await invoke("open_vnc_session", {
    request: {
      sessionId,
      connectionId: connection.id,
      host: connection.host,
      port: connection.port,
      authType: connection.authType,
      readOnly: connection.readOnly,
      password: password ?? null,
    },
  });
}

/** 幂等关闭指定 VNC 会话；前端负责处理失败，禁止静默遗留 socket。 */
export async function closeSession(sessionId: string): Promise<void> {
  if (isTauri()) await invoke("close_vnc_session", { sessionId });
}

/** sessionId 指定已有会话；full 立即重建完整桌面，否则等待最新区域，最长 250ms。 */
export function pollFrame(
  sessionId: string,
  full = false,
): Promise<ArrayBuffer> {
  return invoke("vnc_poll_frame", { sessionId, full });
}

/** 顺序发送已限流的键鼠事件，队列满或只读时由后端拒绝。 */
export function sendInput(
  sessionId: string,
  events: VncInput[],
): Promise<void> {
  return invoke("vnc_send_input", { sessionId, events });
}

/** 读取本连接的加密密码；浏览器预览返回空值供填写，不模拟已保存凭据。 */
export async function loadPassword(connectionId: string): Promise<string> {
  return isTauri() ? invoke("load_vnc_password", { connectionId }) : "";
}

/** 保存或删除密码；空值删除，浏览器环境拒绝保存秘密。 */
export async function savePassword(
  connectionId: string,
  password: string,
): Promise<void> {
  if (!isTauri()) {
    if (password)
      throw new Error(
        "保存密码需要桌面应用 / Saving passwords requires the desktop app",
      );
    return;
  }
  await invoke("save_vnc_password", { connectionId, password });
}
