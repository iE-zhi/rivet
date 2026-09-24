import type { TerminalLine } from "../components/ui";
import {
  DEFAULT_SERIAL_RX_SETTINGS,
  SERIAL_RX_IDLE_MS_MAX,
  SERIAL_RX_IDLE_MS_MIN,
  SERIAL_RX_PACKET_BYTES_MAX,
  SERIAL_RX_PACKET_BYTES_MIN,
} from "./serialRxSettings.ts";

/** 原始字节及任一日志视图最多保留的 UTF-8 字节数。 */
export const SERIAL_LOG_BYTE_LIMIT = 64 * 1024;

/** 默认 RX 空闲判定窗口；具体会话值来自持久化的前端分包设置。 */
export const SERIAL_RX_IDLE_MS = DEFAULT_SERIAL_RX_SETTINGS.idleMs;
/** 默认单包字节数；这是前端显示分组上限，不改变 Rust 读取缓冲区。 */
export const SERIAL_RX_BURST_BYTE_LIMIT = DEFAULT_SERIAL_RX_SETTINGS.maxPacketBytes;

/** 十六进制展示所用的大写数字表。 */
const HEX_DIGITS = "0123456789ABCDEF";
/** 每个 Hex 字节包含两位数字和一个分隔空格，末尾空格会省略。 */
const HEX_BYTES_PER_BYTE = 3;

/** 额外保存原始串口字节的日志行；原始数组在写入缓冲区时会复制并裁剪。 */
export interface SerialLogEntry extends TerminalLine {
  /** RX/TX 行对应的串口原始字节；INFO/OK 行不设置此字段。 */
  rawBytes?: ArrayLike<number>;
}

/** 不可变的反向接收块节点；追加时仅复制新块，提交时再按顺序扁平化。 */
interface SerialRxChunk {
  /** 本次串口事件分块的独立字节副本。 */
  readonly bytes: Uint8Array;
  /** 此分块在持续 TextDecoder 下产生的文本增量。 */
  readonly text: string;
  /** 前一个到达的数据块；链节点总量受当前单包字节上限限制。 */
  readonly previous: SerialRxChunk | null;
}

/** 以首块显示前缀和末块单调时刻标记的有界接收包。 */
export interface SerialRxBurst {
  /** 最近一个数据事件的单调时钟值，供空闲窗口比较。 */
  readonly lastReceivedAt: number;
  /** 已累计的原始字节数，严格限制在用户配置的单包上限内。 */
  readonly rawByteLength: number;
  /** 最新事件节点；previous 链从新到旧，展示时按原顺序复制。 */
  readonly tail: SerialRxChunk;
  /** 接收类别及首块时刻生成的显示前缀。 */
  readonly prefix: string;
}

/** 聚合一块 RX 数据后的新包及因空闲或容量边界完成的旧包。 */
export interface SerialRxAppendResult {
  /** 已空闲或达到配置容量边界前完成的旧包；无需收尾时为 null。 */
  completed: SerialRxBurst | null;
  /** 包含最新数据的新待处理包。 */
  pending: SerialRxBurst;
}

/** 完成聚合后一次扁平化得到的显示文本与原始字节。 */
export interface FlattenedSerialRxBurst {
  /** 按事件到达顺序拼接的解码文本。 */
  text: string;
  /** 精确长度且顺序与文本事件一致的原始串口字节。 */
  rawBytes: Uint8Array;
}

/** 有界串口日志；headIndex 之前的数组槽位会置空并定期压缩。 */
export interface SerialLogBuffer {
  /** 按追加顺序保存的日志行，已淘汰槽位为 undefined 以释放原始数组。 */
  entries: Array<SerialLogEntry | undefined>;
  /** 当前第一条有效行在 entries 中的下标。 */
  headIndex: number;
  /** 当前文本视图中的 UTF-8 字节总数。 */
  textViewByteLength: number;
  /** 当前 Hex 视图中的 UTF-8 字节总数。 */
  hexViewByteLength: number;
  /** 当前日志实际保留的原始串口字节总数。 */
  rawByteLength: number;
}

/**
 * 创建一个没有日志且三个字节计数均为零的有界缓冲区。
 * @returns 可供后续追加的空串口日志缓冲区。
 */
export function createSerialLogBuffer(): SerialLogBuffer {
  return { entries: [], headIndex: 0, textViewByteLength: 0, hexViewByteLength: 0, rawByteLength: 0 };
}

/**
 * 计算 JavaScript 文本按 UTF-8 编码后的字节数，不分配编码结果数组。
 * @param value 待计量的文本；孤立代理项按 UTF-8 替换字符计量。
 * @returns 编码后的字节数。
 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  // UTF-8 使用 1、2、3 或 4 字节表示不同范围的 Unicode 码点。
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * 从字符串尾部保留完整 Unicode 字符。
 * @param value 待裁剪文本。
 * @param maxBytes 保留上限，单位为 UTF-8 字节且小于零时视为零。
 * @returns 不超过上限且不会截断有效代理对的字符串后缀。
 */
function retainUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(value) <= maxBytes) return value;

  let start = value.length;
  let retainedBytes = 0;
  while (start > 0) {
    let characterStart = start - 1;
    const lastCodeUnit = value.charCodeAt(characterStart);
    let characterBytes: number;
    // UTF-16 高代理 D800–DBFF 与低代理 DC00–DFFF 配对后按 4 字节保留；孤立项按替换字符的 3 字节计。
    if (lastCodeUnit >= 0xdc00 && lastCodeUnit <= 0xdfff && characterStart > 0) {
      const previousCodeUnit = value.charCodeAt(characterStart - 1);
      if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff) {
        characterStart -= 1;
        characterBytes = 4;
      } else {
        characterBytes = 3;
      }
    } else if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdfff) {
      characterBytes = 3;
    } else if (lastCodeUnit <= 0x7f) {
      characterBytes = 1;
    } else if (lastCodeUnit <= 0x7ff) {
      characterBytes = 2;
    } else {
      characterBytes = 3;
    }

    if (retainedBytes + characterBytes > maxBytes) break;
    retainedBytes += characterBytes;
    start = characterStart;
  }
  return value.slice(start);
}

/**
 * 计算 Terminal 中一行前缀、可见分隔空格和正文的 UTF-8 长度。
 * @param prefix 行前缀；未提供时不计分隔空格。
 * @param textBytes 正文的 UTF-8 字节数。
 * @returns 实际显示的 UTF-8 字节总数。
 */
function displayedLineByteLength(prefix: string | undefined, textBytes: number): number {
  const visiblePrefix = prefix ?? "";
  return utf8ByteLength(visiblePrefix) + (visiblePrefix ? 1 : 0) + textBytes;
}

/**
 * 返回一条行在 Hex 视图中的正文长度；Hex 字符均为单字节 ASCII。
 * @param entry 含原始字节或纯文本的日志行。
 * @returns 此行 Hex 模式正文的字节数。
 */
function hexViewTextByteLength(entry: SerialLogEntry): number {
  if ((entry.kind === "rx" || entry.kind === "tx") && entry.rawBytes !== undefined) {
    return entry.rawBytes.length ? entry.rawBytes.length * HEX_BYTES_PER_BYTE - 1 : 0;
  }
  return utf8ByteLength(entry.text);
}

/**
 * 计算文本视图中的行长；解码尚无文本的 RX 原始块在此视图中不可见。
 * @param entry 当前有界日志行。
 * @returns 实际文本视图占用的 UTF-8 字节数。
 */
function textViewLineByteLength(entry: SerialLogEntry): number {
  if (entry.kind === "rx" && entry.rawBytes !== undefined && entry.text === "") return 0;
  return displayedLineByteLength(entry.prefix, utf8ByteLength(entry.text));
}

/**
 * 裁剪单行前缀、正文和原始字节，使该行在所有视图下均不超过 64 KiB。
 * @param entry 新日志；其原始数据可以是数组或 TypedArray。
 * @returns 字符完整且原始字节已独立复制的有界日志行。
 */
function fitSerialLogEntry(entry: SerialLogEntry): SerialLogEntry {
  // 有前缀时为 Terminal 分隔空格预留一个 ASCII 字节。
  const prefix = entry.prefix === undefined
    ? undefined
    : retainUtf8Tail(entry.prefix, SERIAL_LOG_BYTE_LIMIT - 1);
  const prefixBytes = displayedLineByteLength(prefix, 0);
  const text = retainUtf8Tail(entry.text, Math.max(0, SERIAL_LOG_BYTE_LIMIT - prefixBytes));
  // 每字节 Hex 有两位数字，除最后一字节外才有空格。
  const rawCapacity = Math.max(0, Math.floor((SERIAL_LOG_BYTE_LIMIT - prefixBytes + 1) / HEX_BYTES_PER_BYTE));
  let rawBytes: Uint8Array | undefined;
  if (entry.rawBytes !== undefined) {
    const sourceLength = entry.rawBytes.length;
    const retainedLength = Math.min(sourceLength, rawCapacity);
    const sourceStart = sourceLength - retainedLength;
    rawBytes = new Uint8Array(retainedLength);
    for (let index = 0; index < retainedLength; index += 1) {
      rawBytes[index] = entry.rawBytes[sourceStart + index] & 0xff;
    }
  }
  return { ...entry, prefix, text, ...(rawBytes === undefined ? {} : { rawBytes }) };
}

/**
 * 把串口字节转换为大写两位 Hex，并用空格分隔每个字节。
 * @param bytes 一个串口字节数组或其他定长字节序列。
 * @returns 大写两位 Hex 文本；空序列返回空字符串。
 */
export function formatSerialBytes(bytes: ArrayLike<number>): string {
  const formatted = new Array<string>(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] & 0xff;
    // 每个输入限制到 8 位，再拆成两个 4 位半字节，避免创建临时子串。
    formatted[index] = `${HEX_DIGITS[byte >>> 4]}${HEX_DIGITS[byte & 0x0f]}`;
  }
  return formatted.join(" ");
}

/**
 * 追加日志并淘汰最早行，保证原始字节、文本视图和 Hex 视图各自不超限。
 * @param buffer 可变日志缓冲区；函数会更新其中的行与字节计数。
 * @param addition 新增日志；其原始数组会复制并按尾部裁剪。
 * @returns 无；结果保存在 buffer 内。
 */
export function appendSerialLogEntry(buffer: SerialLogBuffer, addition: SerialLogEntry): void {
  const entry = fitSerialLogEntry(addition);
  buffer.entries.push(entry);
  buffer.rawByteLength += entry.rawBytes?.length ?? 0;
  buffer.textViewByteLength += textViewLineByteLength(entry);
  buffer.hexViewByteLength += displayedLineByteLength(entry.prefix, hexViewTextByteLength(entry));

  while (
    buffer.headIndex < buffer.entries.length
    && (buffer.rawByteLength > SERIAL_LOG_BYTE_LIMIT
      || buffer.textViewByteLength > SERIAL_LOG_BYTE_LIMIT
      || buffer.hexViewByteLength > SERIAL_LOG_BYTE_LIMIT)
  ) {
    const oldest = buffer.entries[buffer.headIndex];
    if (oldest) {
      buffer.rawByteLength -= oldest.rawBytes?.length ?? 0;
      buffer.textViewByteLength -= textViewLineByteLength(oldest);
      buffer.hexViewByteLength -= displayedLineByteLength(oldest.prefix, hexViewTextByteLength(oldest));
      buffer.entries[buffer.headIndex] = undefined;
    }
    buffer.headIndex += 1;
  }

  // 压缩只复制有效行；被淘汰槽位已置空，不会隐式保留原始日志字节。
  if (buffer.headIndex > 0 && buffer.headIndex * 2 >= buffer.entries.length) {
    buffer.entries = buffer.entries.slice(buffer.headIndex);
    buffer.headIndex = 0;
  }
}

/**
 * 追加一个已解码 RX 块；旧包已空闲或达到配置容量时先完成旧包。
 * @param current 当前尚未提交的接收包。
 * @param lastReceivedAt 当前事件到达时的单调时刻，单位为毫秒。
 * @param text 由持续复用的 TextDecoder 解码出的本事件文本增量。
 * @param rawBytes 当前分块的原始字节，不得超过配置的单包上限。
 * @param prefix 首块数据对应的 RX 显示前缀；旧包完成后此值归新包。
 * @param idleMs 判定前后两个事件属于同一包的空闲窗口，单位为毫秒。
 * @param maxPacketBytes 单包原始字节上限，单位为字节；较大的事件由调用方预先拆分。
 * @returns 空闲/容量边界完成的旧包和复制输入后的新待处理包。
 * @throws RangeError 分块为空、超过包上限或配置值不在允许范围内时。
 */
export function appendSerialRxBurst(
  current: SerialRxBurst | null,
  lastReceivedAt: number,
  text: string,
  rawBytes: ArrayLike<number>,
  prefix: string,
  idleMs = SERIAL_RX_IDLE_MS,
  maxPacketBytes = SERIAL_RX_BURST_BYTE_LIMIT,
): SerialRxAppendResult {
  if (!Number.isSafeInteger(idleMs) || idleMs < SERIAL_RX_IDLE_MS_MIN || idleMs > SERIAL_RX_IDLE_MS_MAX) {
    throw new RangeError(`RX 空闲时间必须是 ${SERIAL_RX_IDLE_MS_MIN} 到 ${SERIAL_RX_IDLE_MS_MAX} 毫秒之间的整数`);
  }
  if (!Number.isSafeInteger(maxPacketBytes) || maxPacketBytes < SERIAL_RX_PACKET_BYTES_MIN || maxPacketBytes > SERIAL_RX_PACKET_BYTES_MAX) {
    throw new RangeError(`RX 单包上限必须是 ${SERIAL_RX_PACKET_BYTES_MIN} 到 ${SERIAL_RX_PACKET_BYTES_MAX} 字节之间的整数`);
  }
  if (rawBytes.length === 0 || rawBytes.length > maxPacketBytes) {
    throw new RangeError(`单个 RX 分块必须包含 1 到 ${maxPacketBytes} 字节`);
  }
  const completed = current && (isSerialRxBurstIdle(current, lastReceivedAt, idleMs)
    || current.rawByteLength + rawBytes.length > maxPacketBytes)
    ? current
    : null;
  const base = completed ? null : current;
  const bytes = Uint8Array.from(rawBytes);
  return {
    completed,
    pending: {
      lastReceivedAt,
      rawByteLength: (base?.rawByteLength ?? 0) + bytes.length,
      tail: { bytes, text, previous: base?.tail ?? null },
      prefix: base?.prefix ?? prefix,
    },
  };
}

/**
 * 按前端单包字节上限惰性拆分一次 serial:data 事件。
 * @param bytes 已复制的串口事件字节；为空时产生零个分块。
 * @param maxPacketBytes 每个分块最多包含的原始字节数，范围为 256 到 16384。
 * @returns 按输入顺序产生的原数组视图；调用方应避免在迭代期间修改源数组。
 * @throws RangeError 单包上限不是受支持的安全整数时。
 */
export function* splitSerialRxBytes(bytes: Uint8Array, maxPacketBytes: number): IterableIterator<Uint8Array> {
  if (!Number.isSafeInteger(maxPacketBytes) || maxPacketBytes < SERIAL_RX_PACKET_BYTES_MIN || maxPacketBytes > SERIAL_RX_PACKET_BYTES_MAX) {
    throw new RangeError(`RX 单包上限必须是 ${SERIAL_RX_PACKET_BYTES_MIN} 到 ${SERIAL_RX_PACKET_BYTES_MAX} 字节之间的整数`);
  }
  for (let offset = 0; offset < bytes.length; offset += maxPacketBytes) {
    yield bytes.subarray(offset, Math.min(offset + maxPacketBytes, bytes.length));
  }
}

/**
 * 将反向链接的 RX 数据块按原到达顺序一次复制字节并拼接文本增量。
 * @param burst 已完成或待显示的接收包；累计长度不超过当前配置的单包上限。
 * @returns 精确长度的原始字节及解码文本，供 Hex、显示和保存视图共用。
 */
export function flattenSerialRxBurst(burst: SerialRxBurst): FlattenedSerialRxBurst {
  const chunks: SerialRxChunk[] = [];
  let chunk: SerialRxChunk | null = burst.tail;
  while (chunk) {
    chunks.push(chunk);
    chunk = chunk.previous;
  }

  const rawBytes = new Uint8Array(burst.rawByteLength);
  const textParts = new Array<string>(chunks.length);
  let offset = 0;
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const orderedChunk = chunks[index];
    rawBytes.set(orderedChunk.bytes, offset);
    offset += orderedChunk.bytes.length;
    textParts[chunks.length - index - 1] = orderedChunk.text;
  }
  return { rawBytes, text: textParts.join("") };
}

/**
 * 检查一个 RX 包是否已在最后数据到达后静默达到配置窗口。
 * @param burst 当前待处理接收包；空包由调用方直接跳过。
 * @param now 当前单调时刻，单位为毫秒。
 * @param idleMs 空闲窗口，默认使用前端设置的 100 毫秒初始值。
 * @returns 仅在经过时间大于或等于窗口时返回 true。
 */
export function isSerialRxBurstIdle(
  burst: SerialRxBurst,
  now: number,
  idleMs = SERIAL_RX_IDLE_MS,
): boolean {
  return now - burst.lastReceivedAt >= idleMs;
}

/**
 * 从保留的原始日志生成当前展示行；Hex 切换不改写缓存中的原始文本。
 * @param buffer 只读使用的有界日志缓冲区。
 * @param hexDisplay true 时仅将 RX/TX 正文替换为原始字节 Hex。
 * @returns 可直接传给 Terminal 或保存序列化器的当前可见行快照。
 */
export function getSerialLogLines(buffer: SerialLogBuffer, hexDisplay: boolean): TerminalLine[] {
  const lines: TerminalLine[] = [];
  for (let index = buffer.headIndex; index < buffer.entries.length; index += 1) {
    const entry = buffer.entries[index];
    if (!entry) continue;
    if (!hexDisplay && entry.kind === "rx" && entry.rawBytes !== undefined && entry.text === "") continue;
    const displayHex = hexDisplay && (entry.kind === "rx" || entry.kind === "tx") && entry.rawBytes !== undefined;
    lines.push({
      ...(entry.kind === undefined ? {} : { kind: entry.kind }),
      ...(entry.prefix === undefined ? {} : { prefix: entry.prefix }),
      text: displayHex ? formatSerialBytes(entry.rawBytes!) : entry.text,
    });
  }
  return lines;
}

/**
 * 按 Terminal 可见行序列化当前视图，供后端写为 UTF-8 文本。
 * @param lines 点击保存时的日志行快照；只在前缀存在时添加分隔空格。
 * @returns 每行含一个结尾换行符的完整文本。
 */
export function serializeSerialLogLines(lines: readonly TerminalLine[]): string {
  return lines.map((line) => `${line.prefix ? `${line.prefix} ` : ""}${line.text}\n`).join("");
}
