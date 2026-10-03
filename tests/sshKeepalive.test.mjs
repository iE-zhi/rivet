/** 保活参数的边界、持久化和异常存储测试；不访问网络或真实用户配置。 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SSH_KEEPALIVE_SETTINGS, deserializeSshKeepaliveSettings, isSshKeepaliveSettings, MAX_SSH_KEEPALIVE_FAILURES, MAX_SSH_KEEPALIVE_INTERVAL_SECONDS, readSshKeepaliveSettings, serializeSshKeepaliveSettings } from "../src/preferences/sshKeepalive.ts";

/** 缺失、损坏、超长及字段不全均采用 30 秒和 3 次，不共享可变默认对象。 */
test("missing and invalid keepalive storage restores independent defaults", () => {
  for (const raw of [null, "{", "x".repeat(257), "{}", '{"intervalSeconds":30}', '{"intervalSeconds":30,"maxFailures":0}']) {
    const restored = deserializeSshKeepaliveSettings(raw);
    assert.deepEqual(restored, { intervalSeconds: 30, maxFailures: 3 });
    assert.notEqual(restored, DEFAULT_SSH_KEEPALIVE_SETTINGS);
  }
});

/** 合法最小值、最大值和自定义值保存后完整恢复。 */
test("keepalive settings round trip at both bounds", () => {
  for (const settings of [{ intervalSeconds: 1, maxFailures: 1 }, { intervalSeconds: 60, maxFailures: 5 }, { intervalSeconds: MAX_SSH_KEEPALIVE_INTERVAL_SECONDS, maxFailures: MAX_SSH_KEEPALIVE_FAILURES }]) {
    assert.equal(isSshKeepaliveSettings(settings), true);
    assert.deepEqual(deserializeSshKeepaliveSettings(serializeSshKeepaliveSettings(settings)), settings);
  }
});

/** 非整数、零、负数、越界、类型错误及未知字段拒绝写入。 */
test("keepalive validation rejects unsafe values without mutation", () => {
  for (const field of ["intervalSeconds", "maxFailures"]) {
    for (const value of [0, -1, 1.5, Infinity, NaN, "30", null, 3601]) {
      const settings = { ...DEFAULT_SSH_KEEPALIVE_SETTINGS, [field]: value };
      assert.equal(isSshKeepaliveSettings(settings), false);
      assert.throws(() => serializeSshKeepaliveSettings(settings), TypeError);
      assert.equal(settings[field], value);
    }
  }
  assert.equal(isSshKeepaliveSettings({ ...DEFAULT_SSH_KEEPALIVE_SETTINGS, maxFailures: 101 }), false);
  assert.equal(isSshKeepaliveSettings({ ...DEFAULT_SSH_KEEPALIVE_SETTINGS, extra: true }), false);
});

/** 使用可控存储替身模拟受限 WebView；读取失败产生诊断并返回默认值。 */
test("unavailable storage uses defaults and logs the read failure", () => {
  const previousWindow = globalThis.window;
  const previousWarn = console.warn;
  const warnings = [];
  try {
    globalThis.window = { localStorage: { /** 模拟 WebView 拒绝存储访问。 */ getItem() { throw new Error("storage denied"); } } };
    console.warn = /** 捕获诊断，测试结束恢复全局函数。 */ (...args) => warnings.push(args);
    assert.deepEqual(readSshKeepaliveSettings(), DEFAULT_SSH_KEEPALIVE_SETTINGS);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = previousWarn;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
