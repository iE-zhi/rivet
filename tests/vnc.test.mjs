import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeFrame,
  parseConnections,
  serializeConnections,
  VNC_CONNECTIONS_KEY,
  isVncPassword,
} from "../src/pages/vnc/model.ts";
import {
  keySymbol,
  keyTransitions,
  pointerButtons,
} from "../src/pages/vnc/keyboard.ts";
import { deserializeNavigationSettings } from "../src/preferences/navigationSettings.ts";

/** Apple 用户名独立持久化，秘密不进入配置；UTF-8 字节边界与旧认证分别校验。 */
test("Apple VNC configurations preserve usernames and enforce credential byte limits", () => {
  const connection = { id: "apple", name: "Mac", group: "Default", host: "localhost", port: 5900,
    authType: "apple", username: "viewer", readOnly: false, password: "hidden" };
  const saved = serializeConnections([connection]);
  assert.equal(saved.includes("hidden"), false);
  assert.equal(parseConnections(saved)[0].username, "viewer");
  assert.throws(() => serializeConnections([{ ...connection, username: "" }]));
  assert.throws(() => serializeConnections([{ ...connection, username: "中".repeat(22) }]));
  assert.equal(isVncPassword("abcdefghijklmno.", "apple"), true);
  assert.equal(isVncPassword("中".repeat(21), "apple"), true);
  assert.equal(isVncPassword("中".repeat(22), "apple"), false);
  assert.equal(isVncPassword("a\u0000b", "apple"), false);
  assert.equal(isVncPassword("", "apple"), false);
  assert.equal(isVncPassword("123456789", "password"), false);
  assert.equal(isVncPassword("12345678", "password"), true);
});

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
  assert.equal(frame.regions[0].data.length, 8);
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
  assert.equal(frame.regions.length, 0);
  assert.throws(
    () =>
      decodeFrame(
        new Uint8Array([...bytes.slice(0, 16), ...new Uint8Array(4097)]).buffer,
      ),
    /过大/,
  );
});

/** 使用两块相距很远的 1×1 RGBA 更新，验证多区域解码借用原缓冲且不扩成整屏。 */
test("VNC sparse regions retain coordinates and share the response buffer", () => {
  const buffer = new ArrayBuffer(40);
  const view = new DataView(buffer);
  view.setUint16(0, 1920, true);
  view.setUint16(2, 1080, true);
  view.setUint8(12, 1);
  view.setUint8(13, 1);
  view.setUint16(14, 2, true);
  for (const [offset, x, y] of [
    [16, 0, 0],
    [28, 1919, 1079],
  ]) {
    view.setUint16(offset, x, true);
    view.setUint16(offset + 2, y, true);
    view.setUint16(offset + 4, 1, true);
    view.setUint16(offset + 6, 1, true);
    new Uint8Array(buffer, offset + 8, 4).set([10, 20, 30, 255]);
  }
  const frame = decodeFrame(buffer);
  assert.equal(frame.regions.length, 2);
  assert.deepEqual(
    frame.regions.map(({ x, y }) => [x, y]),
    [
      [0, 0],
      [1919, 1079],
    ],
  );
  for (const region of frame.regions) {
    assert.equal(region.data.buffer, buffer);
    assert.deepEqual([...region.data], [10, 20, 30, 255]);
  }
  assert.throws(() => decodeFrame(buffer.slice(0, 39)), /长度/);
  assert.throws(() => decodeFrame(buffer.slice(0, 30)), /头不完整/);
  view.setUint16(28, 1920, true);
  assert.throws(() => decodeFrame(buffer), /区域/);
  view.setUint16(28, 1919, true);
  view.setUint16(14, 65, true);
  assert.throws(() => decodeFrame(buffer), /格式/);
  view.setUint16(14, 0, true);
  assert.throws(() => decodeFrame(buffer), /格式/);
  view.setUint16(14, 1, true);
  assert.throws(() => decodeFrame(buffer), /多余/);
  view.setUint8(13, 2);
  assert.throws(() => decodeFrame(buffer), /格式/);
});

/** 多区域帧不得用重叠矩形绕过总像素上限，空白普通帧仍能传达状态。 */
test("VNC region packets bound total pixel count and preserve empty snapshots", () => {
  const buffer = new ArrayBuffer(40);
  const view = new DataView(buffer);
  view.setUint16(0, 1, true);
  view.setUint16(2, 1, true);
  view.setUint8(12, 1);
  view.setUint8(13, 1);
  view.setUint16(14, 2, true);
  for (const offset of [16, 28]) {
    view.setUint16(offset + 4, 1, true);
    view.setUint16(offset + 6, 1, true);
  }
  assert.throws(() => decodeFrame(buffer), /区域/);
  view.setUint8(13, 0);
  view.setUint16(14, 0, true);
  const empty = decodeFrame(buffer.slice(0, 16));
  assert.equal(empty.state, "connected");
  assert.deepEqual(empty.regions, []);
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

/** 中文输入法的非组合句点键还原为英文句点，其他键位和独立 Unicode 文本保持原值。 */
test("VNC physical period bypasses local Chinese punctuation without changing Unicode text", () => {
  assert.equal(keySymbol("。", 0, "Period"), ".".charCodeAt(0));
  assert.equal(keySymbol(".", 0, "Period"), ".".charCodeAt(0));
  assert.equal(keySymbol(">", 0, "Period"), ">".charCodeAt(0));
  assert.equal(keySymbol("。"), 0x01003002);
  assert.equal(keySymbol("。", 0, "KeyA"), 0x01003002);
  assert.equal(keySymbol("中", 0, "KeyZ"), 0x01004e2d);
});

/** macOS 连续开启、关闭大写只有交替的 down/up 通知；每次均须切换且不留下按住状态。 */
test("macOS Caps Lock toggles on both state notifications without retaining a held key", () => {
  const pressed = new Map();
  const event = { key: "CapsLock", code: "CapsLock", location: 0, repeat: false };
  /** Caps Lock 的标准 X11 点击，每次仅切换一次锁定状态。 */
  const click = [
    { key: 0xffe5, down: true },
    { key: 0xffe5, down: false },
  ];
  for (const down of [true, false, true, false]) {
    assert.deepEqual(keyTransitions(event, down, pressed, true), click);
    assert.equal(pressed.size, 0);
  }
  assert.deepEqual(
    keyTransitions({ ...event, repeat: true }, true, pressed, true),
    [],
  );
});

/** 其他平台保留普通 Caps Lock 配对；自动重复和修饰键变化不改变原按键的释放目标。 */
test("non-macOS Caps Lock remains paired and character repeats retain the original symbol", () => {
  const pressed = new Map();
  const caps = { key: "CapsLock", code: "CapsLock", location: 0, repeat: false };
  assert.deepEqual(keyTransitions(caps, true, pressed, false), [
    { key: 0xffe5, down: true },
  ]);
  assert.equal(pressed.size, 1);
  assert.deepEqual(keyTransitions(caps, false, pressed, false), [
    { key: 0xffe5, down: false },
  ]);
  assert.equal(pressed.size, 0);
  const letter = { key: "a", code: "KeyA", location: 0, repeat: false };
  assert.deepEqual(keyTransitions(letter, true, pressed, true), [
    { key: 97, down: true },
  ]);
  assert.deepEqual(
    keyTransitions({ ...letter, key: "A", repeat: true }, true, pressed, true),
    [{ key: 97, down: true }],
  );
  assert.deepEqual(
    keyTransitions({ ...letter, key: "A" }, false, pressed, true),
    [{ key: 97, down: false }],
  );
  assert.deepEqual(keyTransitions(letter, false, pressed, true), []);
  assert.equal(pressed.size, 0);
});

/** macOS Command 组合缺少字符 keyup 时仍须释放字符，Command 本身保留正常配对。 */
test("macOS Command chords release characters even when their native keyup is absent", () => {
  const pressed = new Map();
  const command = { key: "Meta", code: "MetaLeft", location: 1, repeat: false, metaKey: true };
  keyTransitions(command, true, pressed, true);
  const letter = { key: "c", code: "KeyC", location: 0, repeat: false, metaKey: true };
  assert.deepEqual(keyTransitions(letter, true, pressed, true), [
    { key: 99, down: true }, { key: 99, down: false },
  ]);
  assert.equal(pressed.size, 1);
  assert.deepEqual(keyTransitions(command, false, pressed, true), [{ key: 0xffeb, down: false }]);
  assert.equal(pressed.size, 0);
  assert.deepEqual(keyTransitions(letter, false, pressed, true), []);
});

/** 旧版导航保留排序和隐藏状态，追加 VNC 与 Markdown；新配置可往返，重复项回退默认。 */
test("navigation migration appends VNC and Markdown without changing saved tool order", () => {
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
      { id: "markdown", visible: true },
    ],
  );
  const saved = [
    { id: "vnc", visible: false },
    { id: "serial", visible: true },
    { id: "terminal", visible: true },
    { id: "markdown", visible: true },
  ];
  assert.deepEqual(deserializeNavigationSettings(JSON.stringify(saved)), saved);
  assert.equal(
    deserializeNavigationSettings(
      JSON.stringify([saved[0], saved[0], saved[1]]),
    ).length,
    4,
  );
});
