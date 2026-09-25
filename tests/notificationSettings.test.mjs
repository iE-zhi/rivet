import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  deserializeNotificationSettings,
  isNotificationSettings,
  NOTIFICATION_SETTINGS_STORAGE_KEY,
  serializeNotificationSettings,
} from "../src/preferences/notificationSettings.ts";

/** 缺失、损坏和结构异常的持久化值均恢复为三类通知全部开启。 */
test("invalid notification settings fall back to all enabled", () => {
  assert.deepEqual(deserializeNotificationSettings(null), DEFAULT_NOTIFICATION_SETTINGS);
  assert.deepEqual(deserializeNotificationSettings("{"), DEFAULT_NOTIFICATION_SETTINGS);
  assert.deepEqual(deserializeNotificationSettings("x".repeat(257)), DEFAULT_NOTIFICATION_SETTINGS);
  assert.deepEqual(deserializeNotificationSettings(JSON.stringify({ general: true, warning: false })), DEFAULT_NOTIFICATION_SETTINGS);
  assert.deepEqual(deserializeNotificationSettings(JSON.stringify({ general: true, warning: false, error: true, extra: true })), DEFAULT_NOTIFICATION_SETTINGS);
});

/** 三个开关可独立持久化，并使用专用存储键。 */
test("notification settings round trip independently", () => {
  const settings = { general: false, warning: true, error: false };
  const serialized = serializeNotificationSettings(settings);

  assert.equal(NOTIFICATION_SETTINGS_STORAGE_KEY, "rivet.notificationSettings");
  assert.equal(serialized, JSON.stringify(settings));
  assert.deepEqual(deserializeNotificationSettings(serialized), settings);
  assert.equal(isNotificationSettings(settings), true);
});

/** 非布尔字段和额外字段不会被写入用户偏好。 */
test("notification settings reject malformed runtime values", () => {
  const invalidValues = [
    null,
    [],
    { general: true, warning: true, error: 1 },
    { general: true, warning: "true", error: true },
    { general: true, warning: true, error: true, unexpected: false },
  ];

  for (const value of invalidValues) {
    assert.equal(isNotificationSettings(value), false);
    assert.throws(() => serializeNotificationSettings(value), TypeError);
  }
});
