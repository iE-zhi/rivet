import assert from "node:assert/strict";
import test from "node:test";
import {
  SERIAL_LOG_BYTE_LIMIT,
  appendSerialLogEntry,
  createSerialLogBuffer,
  formatSerialBytes,
  getSerialLogLines,
  serializeSerialLogLines,
} from "../src/pages/serialLog.ts";

/** 验证字节按大写两位 Hex 显示并使用单个空格分隔。 */
test("formats bytes as uppercase two-digit hex", () => {
  assert.equal(formatSerialBytes([0x00, 0x0a, 0xab, 0xff]), "00 0A AB FF");
  assert.equal(formatSerialBytes([]), "");
});

/** 验证已有 RX/TX 行可切换视图并恢复文本，INFO/OK 始终保留文本。 */
test("switches existing RX and TX rows without changing text or INFO/OK", () => {
  const buffer = createSerialLogBuffer();
  appendSerialLogEntry(buffer, { kind: "rx", prefix: "RX", text: "AB", rawBytes: [0x41, 0x42] });
  appendSerialLogEntry(buffer, { kind: "tx", prefix: "TX", text: "\\r\\n", rawBytes: [0x0d, 0x0a] });
  appendSerialLogEntry(buffer, { kind: "info", prefix: "INFO", text: "已断开" });
  appendSerialLogEntry(buffer, { kind: "ok", prefix: "OK", text: "设备已连接" });

  assert.deepEqual(getSerialLogLines(buffer, false).map((line) => line.text), ["AB", "\\r\\n", "已断开", "设备已连接"]);
  assert.deepEqual(getSerialLogLines(buffer, true).map((line) => line.text), ["41 42", "0D 0A", "已断开", "设备已连接"]);
  assert.deepEqual(getSerialLogLines(buffer, false).map((line) => line.text), ["AB", "\\r\\n", "已断开", "设备已连接"]);
});

/** 验证解码器尚未产生文字的接收字节仍会保留并显示为 Hex。 */
test("retains receive bytes when the decoder has produced no text", () => {
  const buffer = createSerialLogBuffer();
  appendSerialLogEntry(buffer, { kind: "rx", prefix: "RX", text: "", rawBytes: [0xe2] });

  assert.deepEqual(getSerialLogLines(buffer, false), []);
  assert.equal(serializeSerialLogLines(getSerialLogLines(buffer, false)), "");
  assert.deepEqual(getSerialLogLines(buffer, true), [{ kind: "rx", prefix: "RX", text: "E2" }]);
  assert.equal(serializeSerialLogLines(getSerialLogLines(buffer, true)), "RX E2\n");
  assert.deepEqual(getSerialLogLines(buffer, false), []);
  assert.equal(buffer.rawByteLength, 1);
  assert.equal(buffer.textViewByteLength, 0);
  assert.equal(buffer.hexViewByteLength, 5);
});

/** 验证大包尾部保留、UTF-8 字符完整，且原始和两种显示视图均不超 64 KiB。 */
test("bounds raw bytes and both views while preserving complete UTF-8 tail characters", () => {
  const buffer = createSerialLogBuffer();
  const incoming = Uint8Array.from({ length: SERIAL_LOG_BYTE_LIMIT * 2 }, (_, index) => index & 0xff);
  appendSerialLogEntry(buffer, {
    kind: "rx",
    prefix: "RX",
    text: "😀".repeat(SERIAL_LOG_BYTE_LIMIT),
    rawBytes: incoming,
  });

  const textLines = getSerialLogLines(buffer, false);
  const hexLines = getSerialLogLines(buffer, true);
  const encoder = new TextEncoder();
  /** 按 Terminal 实际前缀间距计算一组行的 UTF-8 显示长度。 */
  const viewBytes = (lines) => lines.reduce(
    (total, line) => total + encoder.encode(`${line.prefix ? `${line.prefix} ` : ""}${line.text}`).length,
    0,
  );
  const retained = buffer.entries[buffer.headIndex];

  assert.ok(buffer.rawByteLength <= SERIAL_LOG_BYTE_LIMIT);
  assert.ok(buffer.textViewByteLength <= SERIAL_LOG_BYTE_LIMIT);
  assert.ok(buffer.hexViewByteLength <= SERIAL_LOG_BYTE_LIMIT);
  assert.ok(viewBytes(textLines) <= SERIAL_LOG_BYTE_LIMIT);
  assert.ok(viewBytes(hexLines) <= SERIAL_LOG_BYTE_LIMIT);
  assert.equal(textLines[0].text.slice(-2), "😀");
  assert.equal(retained.rawBytes.at(-1), incoming.at(-1));
  assert.equal(retained.rawBytes.length, buffer.rawByteLength);
});

/** 验证保存序列化按当前可见正文逐行输出，并只在有前缀时加入分隔空格。 */
test("serializes the current visible lines with one newline per row", () => {
  assert.equal(
    serializeSerialLogLines([
      { kind: "rx", prefix: "RX", text: "00 0A" },
      { kind: "info", text: "ready" },
    ]),
    "RX 00 0A\nready\n",
  );
});
