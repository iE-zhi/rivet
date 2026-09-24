/** 串口前端发送字节构造器：负责文本/Hex 校验与行尾追加，仅产出字节供后端发送，不管理设备或重试。 */
/** Hex 输入校验失败的分类，用于显示对应语言的错误提示。 */
export type HexInputError = "empty" | "invalid" | "odd";

/** 串口发送字节构造结果；成功分支包含完整字节，失败分支只包含可本地化错误分类。 */
export type SerialBytesResult = { ok: true; bytes: number[] } | { ok: false; error: HexInputError };

/** 发送选项快照；行尾字节固定按 CR、LF 顺序追加。 */
export type SerialBytesOptions = {
  /** true 时按十六进制字节解析 message，否则使用 UTF-8 文本字节。 */
  hex: boolean;
  /** true 时在正文后追加一个 CR 字节。 */
  appendCR: boolean;
  /** true 时在正文后追加一个 LF 字节。 */
  appendLF: boolean;
};

/** CR 行尾对应的协议字节 0D。 */
const CR_BYTE = 0x0d;
/** LF 行尾对应的协议字节 0A。 */
const LF_BYTE = 0x0a;

/**
 * 校验并构造串口发送字节；Hex 支持空白分组或连续偶数位，空负载始终拒绝。
 * @param message 输入框中的文本或十六进制数据。
 * @param options 本次发送的模式和行尾选项快照。
 * @returns 可发送字节或可本地化的输入错误分类；不访问外部状态。
 */
export function buildSerialBytes(message: string, options: SerialBytesOptions): SerialBytesResult {
  const payload: number[] = [];

  if (options.hex) {
    const normalized = message.trim();
    if (!normalized) return { ok: false, error: "empty" };

    // 先按空白切分并校验每组完整字节，再逐对转换，避免返回部分解析结果。
    const groups = normalized.split(/\s+/);
    for (const group of groups) {
      if (!/^[0-9a-f]+$/i.test(group)) return { ok: false, error: "invalid" };
      if (group.length % 2 !== 0) return { ok: false, error: "odd" };

      for (let index = 0; index < group.length; index += 2) {
        payload.push(Number.parseInt(group.slice(index, index + 2), 16));
      }
    }
  } else {
    if (!message.length) return { ok: false, error: "empty" };
    for (const byte of new TextEncoder().encode(message)) payload.push(byte);
  }

  if (options.appendCR) payload.push(CR_BYTE);
  if (options.appendLF) payload.push(LF_BYTE);
  return { ok: true, bytes: payload };
}
