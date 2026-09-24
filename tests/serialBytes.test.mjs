import assert from "node:assert/strict";
import test from "node:test";
import { buildSerialBytes } from "../src/pages/serialBytes.ts";

/** 验证连续偶数位 Hex、行尾追加顺序和返回的字节内容。 */
test("builds bytes from continuous hex and appends CR before LF", () => {
  assert.deepEqual(
    buildSerialBytes("0aFF", { hex: true, appendCR: true, appendLF: true }),
    { ok: true, bytes: [0x0a, 0xff, 0x0d, 0x0a] },
  );
});

/** 验证空白分隔的 Hex 字节可解析，且不会额外插入数据。 */
test("parses whitespace-separated hex bytes", () => {
  assert.deepEqual(
    buildSerialBytes("\t00 ab \nCd", { hex: true, appendCR: false, appendLF: false }),
    { ok: true, bytes: [0x00, 0xab, 0xcd] },
  );
});

/** 验证 CR 与 LF 可独立选择，未选中的行尾不会追加。 */
test("appends CR and LF independently", () => {
  assert.deepEqual(
    buildSerialBytes("AA", { hex: true, appendCR: true, appendLF: false }),
    { ok: true, bytes: [0xaa, 0x0d] },
  );
  assert.deepEqual(
    buildSerialBytes("AA", { hex: true, appendCR: false, appendLF: true }),
    { ok: true, bytes: [0xaa, 0x0a] },
  );
});

/** 验证空 Hex 数据即使勾选行尾也会被拒绝。 */
test("rejects empty hex payload before appending line endings", () => {
  assert.deepEqual(
    buildSerialBytes(" \n ", { hex: true, appendCR: true, appendLF: true }),
    { ok: false, error: "empty" },
  );
});

/** 验证非十六进制字符不会产生可发送字节。 */
test("rejects non-hexadecimal characters", () => {
  assert.deepEqual(
    buildSerialBytes("AA:BB", { hex: true, appendCR: false, appendLF: false }),
    { ok: false, error: "invalid" },
  );
});

/** 验证未成对的半字节会被拒绝。 */
test("rejects odd hexadecimal digit counts", () => {
  assert.deepEqual(
    buildSerialBytes("AA B", { hex: true, appendCR: false, appendLF: false }),
    { ok: false, error: "odd" },
  );
});

/** 验证文本模式使用 UTF-8 编码并按 CR、LF 顺序追加行尾。 */
test("encodes text as UTF-8 and appends selected line endings", () => {
  assert.deepEqual(
    buildSerialBytes("中A", { hex: false, appendCR: true, appendLF: true }),
    { ok: true, bytes: [0xe4, 0xb8, 0xad, 0x41, 0x0d, 0x0a] },
  );
});
