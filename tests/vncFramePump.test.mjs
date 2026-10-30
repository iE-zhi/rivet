/** 使用手动绘制时钟和可控 Promise 验证取帧背压、暂停、恢复及卸载；不访问真实桌面。 */
import assert from "node:assert/strict";
import test from "node:test";
import { VncFramePump } from "../src/pages/vnc/framePump.ts";

/** 为单项测试安装确定性绘制时钟；t 负责结束后恢复原始全局函数。 */
function clock(t) {
  const pending = new Map();
  let id = 0;
  t.mock.method(globalThis, "requestAnimationFrame", (callback) => {
    pending.set(++id, callback);
    return id;
  });
  t.mock.method(globalThis, "cancelAnimationFrame", (key) =>
    pending.delete(key),
  );
  return {
    pending,
    /** 触发当前绘制回调并清空确定性微任务，不依赖计时 sleep。 */
    async tick() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(0);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

// Node 没有浏览器绘制时钟；各测试用 mock 替换，不创建真实定时器。
globalThis.requestAnimationFrame ??= () => {
  throw new Error("missing test clock");
};
globalThis.cancelAnimationFrame ??= () => {
  throw new Error("missing test clock");
};

/** 在途请求跨暂停/恢复保持唯一，迟到像素仍绘制，恢复后下一次读取必须请求完整桌面。 */
test("frame pump keeps one request during rapid hide/show and rebuilds on resume", async (t) => {
  const timer = clock(t);
  const requests = [],
    presented = [];
  let resolve;
  const pump = new VncFramePump(
    (full) => {
      requests.push(full);
      return new Promise((done) => {
        resolve = done;
      });
    },
    (buffer) => presented.push(buffer),
    (error) => assert.fail(String(error)),
  );
  pump.setActive(true);
  await timer.tick();
  assert.deepEqual(requests, [true]);
  pump.setActive(false);
  pump.setActive(true);
  await timer.tick();
  assert.equal(requests.length, 1);
  const frame = new ArrayBuffer(16);
  resolve(frame);
  await timer.tick();
  assert.deepEqual(presented, [frame]);
  await timer.tick();
  assert.deepEqual(requests, [true, true]);
  pump.dispose();
  resolve(frame);
  await timer.tick();
  assert.equal(presented.length, 1);
  assert.equal(timer.pending.size, 0);
});

/** 快速响应只在绘制时钟到来时继续读取，不附加 60ms 等待，也不让重复激活产生完整帧。 */
test("frame pump reads incremental frames on every available animation tick", async (t) => {
  const timer = clock(t),
    requests = [];
  const pump = new VncFramePump(
    async (full) => {
      requests.push(full);
      return new ArrayBuffer(16);
    },
    () => {},
    (error) => assert.fail(String(error)),
  );
  pump.setActive(true);
  for (let index = 0; index < 120; index++) {
    pump.setActive(true);
    await timer.tick();
  }
  assert.equal(requests.length, 120);
  assert.equal(requests[0], true);
  assert.ok(requests.slice(1).every((full) => full === false));
  pump.setActive(false);
  assert.equal(timer.pending.size, 0);
  pump.dispose();
});

/** 读取或同步绘制异常只上报一次；停止后没有自动重试，避免错误循环与无界请求。 */
test("frame pump reports read and paint failures once and stops scheduling", async (t) => {
  const timer = clock(t);
  for (const paintFails of [false, true]) {
    const errors = [];
    const failure = new Error(paintFails ? "paint" : "read");
    const pump = new VncFramePump(
      async () => {
        if (!paintFails) throw failure;
        return new ArrayBuffer(16);
      },
      () => {
        throw failure;
      },
      (error) => errors.push(error),
    );
    pump.setActive(true);
    await timer.tick();
    await timer.tick();
    pump.setActive(true);
    await timer.tick();
    assert.deepEqual(errors, [failure]);
    assert.equal(timer.pending.size, 0);
    pump.dispose();
  }
});
