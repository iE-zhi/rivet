import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SERIAL_RX_SETTINGS,
  deserializeSerialRxSettings,
  isSerialRxSettings,
  SERIAL_RX_IDLE_MS_MAX,
  SERIAL_RX_IDLE_MS_MIN,
  SERIAL_RX_PACKET_BYTES_MAX,
  SERIAL_RX_PACKET_BYTES_MIN,
  SERIAL_RX_SETTINGS_STORAGE_KEY,
  serializeSerialRxSettings,
} from "../src/pages/serialRxSettings.ts";

/** 验证缺少、损坏或字段越界的持久化内容都安全回退到默认 RX 参数。 */
test("defaults invalid or missing persisted RX settings", () => {
  assert.deepEqual(DEFAULT_SERIAL_RX_SETTINGS, { idleMs: 100, maxPacketBytes: 4096 });
  assert.deepEqual(deserializeSerialRxSettings(null), { idleMs: 100, maxPacketBytes: 4096 });
  assert.deepEqual(deserializeSerialRxSettings("{"), { idleMs: 100, maxPacketBytes: 4096 });
  assert.deepEqual(deserializeSerialRxSettings("x".repeat(257)), { idleMs: 100, maxPacketBytes: 4096 });
  assert.deepEqual(deserializeSerialRxSettings(JSON.stringify({ idleMs: 0, maxPacketBytes: 4096 })), { idleMs: 100, maxPacketBytes: 4096 });
  assert.deepEqual(deserializeSerialRxSettings(JSON.stringify({ idleMs: 100, maxPacketBytes: SERIAL_RX_PACKET_BYTES_MAX + 1 })), { idleMs: 100, maxPacketBytes: 4096 });
  assert.deepEqual(deserializeSerialRxSettings(JSON.stringify({ idleMs: 100, maxPacketBytes: 4096, unexpected: true })), { idleMs: 100, maxPacketBytes: 4096 });
});

/** 验证有效边界值与自定义参数可以通过 JSON 持久化往返且使用独立存储键。 */
test("round-trips bounded RX settings through the dedicated storage payload", () => {
  const settings = { idleMs: SERIAL_RX_IDLE_MS_MAX, maxPacketBytes: SERIAL_RX_PACKET_BYTES_MAX };
  const serialized = serializeSerialRxSettings(settings);

  assert.equal(SERIAL_RX_SETTINGS_STORAGE_KEY, "rivet.serialRxSettings");
  assert.equal(serialized, JSON.stringify(settings));
  assert.deepEqual(deserializeSerialRxSettings(serialized), settings);
  assert.equal(isSerialRxSettings({ idleMs: SERIAL_RX_IDLE_MS_MIN, maxPacketBytes: SERIAL_RX_PACKET_BYTES_MIN }), true);
});

/** 验证严格字段、整数和范围校验拒绝扩展字段及不安全候选值。 */
test("rejects malformed runtime RX settings and serialization candidates", () => {
  const invalidValues = [
    null,
    [],
    { idleMs: 100 },
    { idleMs: 100, maxPacketBytes: 4096, extra: 1 },
    { idleMs: 1.5, maxPacketBytes: 4096 },
    { idleMs: SERIAL_RX_IDLE_MS_MIN - 1, maxPacketBytes: 4096 },
    { idleMs: SERIAL_RX_IDLE_MS_MAX + 1, maxPacketBytes: 4096 },
    { idleMs: 100, maxPacketBytes: SERIAL_RX_PACKET_BYTES_MIN - 1 },
    { idleMs: 100, maxPacketBytes: SERIAL_RX_PACKET_BYTES_MAX + 1 },
    { idleMs: Number.MAX_SAFE_INTEGER + 1, maxPacketBytes: 4096 },
  ];

  for (const value of invalidValues) {
    assert.equal(isSerialRxSettings(value), false);
    assert.throws(() => serializeSerialRxSettings(value), TypeError);
  }
});
