import assert from "node:assert/strict";
import test from "node:test";
import {
  deserializeRecentConnectionIds,
  deserializeTerminalConnections,
  pruneRecentConnectionIds,
  serializeRecentConnectionIds,
  serializeTerminalConnections,
  SSH_CONNECTIONS_STORAGE_KEY,
  TERMINAL_CONNECTIONS_STORAGE_KEY,
  TERMINAL_RECENT_CONNECTIONS_STORAGE_KEY,
  touchRecentConnectionId,
} from "../src/pages/terminalConnections.ts";

const LEGACY_SSH_CONNECTION = {
  id: "n305",
  name: "N305",
  group: "开发板",
  host: "10.28.228.244",
  port: 22,
  username: "agile",
  authType: "password",
  keyPath: "",
};

/** 旧版没有 kind/x11 字段的 SSH 记录应迁移为 SSH 且默认关闭 X11。 */
test("terminal connections migrate legacy SSH records", () => {
  const [restored] = deserializeTerminalConnections(JSON.stringify([LEGACY_SSH_CONNECTION]));
  assert.deepEqual(restored, {
    ...LEGACY_SSH_CONNECTION,
    kind: "ssh",
    x11: false,
  });
});

/** SSH 与串口连接均可持久化，认证秘密不会进入 JSON。 */
test("terminal connections persist SSH and serial records without secrets", () => {
  const ssh = {
    ...LEGACY_SSH_CONNECTION,
    kind: "ssh",
    authType: "privateKey",
    keyPath: "C:\\Users\\zhi\\.ssh\\id_ed25519",
    x11: true,
  };
  const serial = {
    kind: "serial",
    id: "serial-com5",
    name: "COM5",
    group: "串口",
    path: "COM5",
    baudRate: 115200,
    dataBits: 7,
    parity: "even",
    stopBits: 2,
    flowControl: "hardware",
  };
  const serialized = serializeTerminalConnections([ssh, serial]);
  const restored = deserializeTerminalConnections(serialized);

  assert.equal(TERMINAL_CONNECTIONS_STORAGE_KEY, "rivet.terminal.connections");
  assert.equal(SSH_CONNECTIONS_STORAGE_KEY, "rivet.ssh.connections");
  assert.deepEqual(restored, [ssh, serial]);
  assert.equal("password" in JSON.parse(serialized)[0], false);
  assert.equal("keyPassphrase" in JSON.parse(serialized)[0], false);
});

/** 旧版串口连接缺少帧格式时迁移为 8N1、无流控。 */
test("terminal connections migrate legacy serial frame settings", () => {
  const [restored] = deserializeTerminalConnections(JSON.stringify([{
    kind: "serial",
    id: "legacy-serial",
    name: "COM7",
    group: "串口",
    path: "COM7",
    baudRate: 115200,
  }]));
  assert.deepEqual(restored, {
    kind: "serial",
    id: "legacy-serial",
    name: "COM7",
    group: "串口",
    path: "COM7",
    baudRate: 115200,
    dataBits: 8,
    parity: "none",
    stopBits: 1,
    flowControl: "none",
  });
});

/** 非法类型、越界端口和越界波特率不能进入连接列表。 */
test("terminal connection persistence rejects malformed records", () => {
  assert.deepEqual(
    deserializeTerminalConnections(
      JSON.stringify([{ ...LEGACY_SSH_CONNECTION, kind: "ssh", x11: "true" }]),
    ),
    [],
  );
  assert.deepEqual(
    deserializeTerminalConnections(
      JSON.stringify([{ ...LEGACY_SSH_CONNECTION, kind: "ssh", port: 0, x11: false }]),
    ),
    [],
  );
  assert.deepEqual(
    deserializeTerminalConnections(
      JSON.stringify([
        {
          kind: "serial",
          id: "bad",
          name: "bad",
          group: "串口",
          path: "COM1",
          baudRate: 0,
        },
      ]),
    ),
    [],
  );
  assert.deepEqual(
    deserializeTerminalConnections(
      JSON.stringify([{
        kind: "serial",
        id: "bad-frame",
        name: "bad-frame",
        group: "串口",
        path: "COM2",
        baudRate: 115200,
        dataBits: 9,
        parity: "none",
        stopBits: 1,
        flowControl: "none",
      }]),
    ),
    [],
  );
  assert.deepEqual(deserializeTerminalConnections("{"), []);
});

/** 最近使用连接按最近优先去重，并且最多只保留 20 条。 */
test("recent terminal connections dedupe and keep only 20 ids", () => {
  const ids = Array.from({ length: 25 }, (_, index) => `connection-${index}`);
  const touched = touchRecentConnectionId(ids, "connection-10");

  assert.equal(TERMINAL_RECENT_CONNECTIONS_STORAGE_KEY, "rivet.terminal.recentConnections");
  assert.equal(touched.length, 20);
  assert.equal(touched[0], "connection-10");
  assert.equal(touched.filter((id) => id === "connection-10").length, 1);

  const restored = deserializeRecentConnectionIds(
    JSON.stringify(["a", "b", "a", "", 42, ...ids]),
  );
  assert.equal(restored[0], "a");
  assert.equal(restored[1], "b");
  assert.equal(restored.filter((id) => id === "a").length, 1);
  assert.equal(restored.length, 20);
  assert.deepEqual(JSON.parse(serializeRecentConnectionIds(restored)), restored);
});

/** 已删除连接必须从最近使用历史中清理。 */
test("recent terminal connections prune missing saved connections", () => {
  const connections = [
    { ...LEGACY_SSH_CONNECTION, id: "a", kind: "ssh", x11: false },
    { ...LEGACY_SSH_CONNECTION, id: "c", kind: "ssh", x11: false },
  ];
  assert.deepEqual(pruneRecentConnectionIds(["a", "b", "c", "a"], connections), ["a", "c"]);
});
