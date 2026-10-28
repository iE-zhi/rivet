import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeFrame,
  parseConnections,
  serializeConnections,
  VNC_CONNECTIONS_KEY,
} from "../src/pages/vnc/model.ts";
import { keySymbol, pointerButtons } from "../src/pages/vnc/keyboard.ts";
import { deserializeNavigationSettings } from "../src/preferences/navigationSettings.ts";

/** 合法 VNC 配置不含秘密；附加 password 字段不能进入序列化结果。 */
test("VNC configuration uses an independent key and strips credentials", () => {
  const connection = {
    id: "vnc-1",
    name: "Desktop",
    group: "Default",
    host: "::1",
    port: 5900,
    authType: "password",
    readOnly: false,
    password: "secret",
  };
  assert.equal(VNC_CONNECTIONS_KEY, "rivet.vnc.connections");
  const serialized = serializeConnections([connection]);
  assert.equal(serialized.includes("secret"), false);
  assert.deepEqual(parseConnections(serialized), [
    {
      id: "vnc-1",
      name: "Desktop",
      group: "Default",
      host: "::1",
      port: 5900,
      authType: "password",
      readOnly: false,
    },
  ]);
  assert.throws(() =>
    parseConnections(JSON.stringify([connection, connection])),
  );
  for (const host of ["", "http://host", "user@host", "host\n", "[::1]"])
    assert.throws(() => serializeConnections([{ ...connection, host }]));
  for (const port of [0, 1.5, 65536])
    assert.throws(() => serializeConnections([{ ...connection, port }]));
});

/** 二进制载荷使用真实 2×1 RGBA；截断、越界和异常桌面尺寸必须在 Canvas 前拒绝。 */
test("VNC binary snapshots validate bounds and exact pixel length", () => {
  const bytes = new ArrayBuffer(24);
  const view = new DataView(bytes);
  view.setUint16(0, 2, true);
  view.setUint16(2, 1, true);
  view.setUint16(8, 2, true);
  view.setUint16(10, 1, true);
  view.setUint8(12, 1);
  const frame = decodeFrame(bytes);
  assert.equal(frame.state, "connected");
  assert.equal(frame.data.length, 8);
  assert.throws(() => decodeFrame(bytes.slice(0, 23)));
  view.setUint16(4, 1, true);
  assert.throws(() => decodeFrame(bytes));
  view.setUint16(0, 8192, true);
  view.setUint16(2, 8192, true);
  assert.throws(() => decodeFrame(bytes));
});

/** 错误帧将 UTF-8 原因保留给 UI，无像素载荷或扩展尺寸分配。 */
test("VNC error snapshots preserve the visible UTF-8 failure", () => {
  const message = new TextEncoder().encode("认证失败");
  const bytes = new Uint8Array(16 + message.length);
  bytes[12] = 3;
  bytes.set(message, 16);
  const frame = decodeFrame(bytes.buffer);
  assert.equal(frame.state, "error");
  assert.equal(frame.error, "认证失败");
  assert.equal(frame.data.length, 0);
});

/** 控制键、左右修饰键、Unicode 和三键鼠标映射符合 RFB/X11 顺序。 */
test("VNC key and mouse mappings preserve modifier sides and button order", () => {
  assert.equal(keySymbol("a"), 97);
  assert.equal(keySymbol("Control"), 0xffe3);
  assert.equal(keySymbol("Control", 2), 0xffe4);
  assert.equal(keySymbol("中"), 0x01004e2d);
  assert.equal(keySymbol("F1"), 0xffbe);
  assert.equal(keySymbol("F35"), 0xffe0);
  assert.equal(keySymbol("Dead"), null);
  assert.equal(keySymbol("toString"), null);
  assert.equal(keySymbol("Process"), null);
  assert.equal(pointerButtons(1), 1);
  assert.equal(pointerButtons(2), 4);
  assert.equal(pointerButtons(4), 2);
  assert.equal(pointerButtons(7), 7);
});

/** 旧版导航保留排序和隐藏状态，只追加 VNC；新配置可往返，重复项回退默认。 */
test("navigation migration appends VNC without changing saved tool order", () => {
  assert.deepEqual(
    deserializeNavigationSettings(
      JSON.stringify([
        { id: "terminal", visible: false },
        { id: "serial", visible: true },
      ]),
    ),
    [
      { id: "terminal", visible: false },
      { id: "serial", visible: true },
      { id: "vnc", visible: true },
    ],
  );
  const saved = [
    { id: "vnc", visible: false },
    { id: "serial", visible: true },
    { id: "terminal", visible: true },
  ];
  assert.deepEqual(deserializeNavigationSettings(JSON.stringify(saved)), saved);
  assert.equal(
    deserializeNavigationSettings(
      JSON.stringify([saved[0], saved[0], saved[1]]),
    ).length,
    3,
  );
});
