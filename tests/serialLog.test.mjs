import assert from "node:assert/strict";
import test from "node:test";
import {
  SERIAL_LOG_BYTE_LIMIT,
  appendSerialLogEntry,
  createSerialLogBuffer,
  flattenSerialRxBurst,
  formatSerialBytes,
  getSerialLogLines,
  appendSerialRxBurst,
  isSerialRxBurstIdle,
  SERIAL_RX_BURST_BYTE_LIMIT,
  SERIAL_RX_IDLE_MS,
  splitSerialRxBytes,
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

/** 验证不同长度的数据事件在 100ms 空闲窗口内合成一包，并按末块时间重新计时。 */
test("coalesces 1-byte and 3-byte RX events until the final 100ms idle window", () => {
  const first = appendSerialRxBurst(null, 10, "A", [0x41], "[00:00:01.000] RX");
  const second = appendSerialRxBurst(first.pending, 90, "BCD", [0x42, 0x43, 0x44], "later prefix");

  assert.equal(first.completed, null);
  assert.equal(second.completed, null);
  assert.equal(second.pending.prefix, "[00:00:01.000] RX");
  assert.equal(second.pending.lastReceivedAt, 90);
  const flattened = flattenSerialRxBurst(second.pending);
  assert.equal(flattened.text, "ABCD");
  assert.equal(formatSerialBytes(flattened.rawBytes), "41 42 43 44");
  assert.equal(isSerialRxBurstIdle(second.pending, 90 + SERIAL_RX_IDLE_MS - 1), false);
  assert.equal(isSerialRxBurstIdle(second.pending, 90 + SERIAL_RX_IDLE_MS), true);
});

/** 验证计时器延迟期间若新事件到达时已静默满 100ms，旧包先于新包完成。 */
test("starts a new RX burst when the prior burst already crossed the idle window", () => {
  const first = appendSerialRxBurst(null, 10, "A", [0x41], "RX");
  const next = appendSerialRxBurst(first.pending, 10 + SERIAL_RX_IDLE_MS, "B", [0x42], "RX");

  assert.equal(flattenSerialRxBurst(next.completed).text, "A");
  assert.equal(formatSerialBytes(flattenSerialRxBurst(next.completed).rawBytes), "41");
  assert.equal(flattenSerialRxBurst(next.pending).text, "B");
  assert.equal(formatSerialBytes(flattenSerialRxBurst(next.pending).rawBytes), "42");
});

/** 验证 UTF-8 字符可跨数据事件解码，合并后的文本、Hex 与保存视图均保留原始字节。 */
test("preserves split UTF-8 bytes across RX events and both saved views", () => {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const bytes = [[0xe4], [0xb8], [0xad]];
  let burst = null;
  for (let index = 0; index < bytes.length; index += 1) {
    const chunk = Uint8Array.from(bytes[index]);
    const merged = appendSerialRxBurst(
      burst,
      index * 20,
      decoder.decode(chunk, { stream: true }),
      chunk,
      `[00:00:02.000] RX`,
    );
    assert.equal(merged.completed, null);
    burst = merged.pending;
  }

  const buffer = createSerialLogBuffer();
  const flattened = flattenSerialRxBurst(burst);
  appendSerialLogEntry(buffer, { kind: "rx", prefix: burst.prefix, text: flattened.text, rawBytes: flattened.rawBytes });
  assert.deepEqual(getSerialLogLines(buffer, false).map((line) => line.text), ["中"]);
  assert.deepEqual(getSerialLogLines(buffer, true).map((line) => line.text), ["E4 B8 AD"]);
  assert.equal(serializeSerialLogLines(getSerialLogLines(buffer, false)), "[00:00:02.000] RX 中\n");
  assert.equal(serializeSerialLogLines(getSerialLogLines(buffer, true)), "[00:00:02.000] RX E4 B8 AD\n");
});

/** 验证包到达 4096 字节上限后先完成旧包，新包仅保留后续原始字节。 */
test("flushes before the 4096-byte RX aggregation cap", () => {
  const maximum = new Uint8Array(SERIAL_RX_BURST_BYTE_LIMIT).fill(0x41);
  const first = appendSerialRxBurst(null, 0, "A", maximum, "RX");
  const next = appendSerialRxBurst(first.pending, 1, "B", [0x42], "RX");

  assert.equal(first.pending.rawByteLength, SERIAL_RX_BURST_BYTE_LIMIT);
  assert.equal(next.completed.rawByteLength, SERIAL_RX_BURST_BYTE_LIMIT);
  assert.equal(next.pending.rawByteLength, 1);
  const flattened = flattenSerialRxBurst(next.pending);
  assert.equal(flattened.text, "B");
  assert.equal(flattened.rawBytes[0], 0x42);
  assert.throws(
    () => appendSerialRxBurst(null, 2, "", new Uint8Array(SERIAL_RX_BURST_BYTE_LIMIT + 1), "RX"),
    RangeError,
  );
  assert.throws(() => appendSerialRxBurst(null, 3, "", [], "RX"), RangeError);
});

/** 验证较短空闲窗口和低于 Rust 读取大小的自定义单包上限会影响聚合边界。 */
test("uses custom RX idle timeout and 256-byte packets below the backend read size", () => {
  const source = Uint8Array.from({ length: 600 }, (_, index) => index & 0xff);
  const chunks = [...splitSerialRxBytes(source, 256)];
  assert.deepEqual(chunks.map((chunk) => chunk.length), [256, 256, 88]);
  assert.equal(chunks[1][0], source[256]);

  const first = appendSerialRxBurst(null, 10, "A", chunks[0], "RX", 25, 256);
  const capacityFlush = appendSerialRxBurst(first.pending, 20, "B", chunks[1], "RX", 25, 256);
  assert.equal(capacityFlush.completed.rawByteLength, 256);
  assert.equal(flattenSerialRxBurst(capacityFlush.completed).text, "A");

  const idleFlush = appendSerialRxBurst(capacityFlush.pending, 45, "C", chunks[2], "RX", 25, 256);
  assert.equal(flattenSerialRxBurst(idleFlush.completed).text, "B");
  assert.equal(idleFlush.pending.rawByteLength, 88);
  assert.equal(isSerialRxBurstIdle(idleFlush.pending, 69, 25), false);
  assert.equal(isSerialRxBurstIdle(idleFlush.pending, 70, 25), true);
  assert.throws(() => appendSerialRxBurst(null, 80, "", source.subarray(0, 300), "RX", 25, 256), RangeError);
  assert.throws(() => [...splitSerialRxBytes(source, 255)], RangeError);
});
