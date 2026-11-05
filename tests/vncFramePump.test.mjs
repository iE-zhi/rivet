/** 使用手动绘制时钟和可控 Promise 验证取帧背压、暂停、恢复及卸载；不访问真实桌面。 */
import assert from "node:assert/strict";
import test from "node:test";
import { VncFramePump } from "../src/pages/vnc/framePump.ts";
import { pollFrame } from "../src/pages/vnc/api.ts";

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
      await Promise.resolve();
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

/** 在途请求跨快速暂停/恢复保持唯一，旧响应在绘制时钟消费后立刻请求完整桌面。 */
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
  assert.deepEqual(requests, [true]);
  pump.setActive(false);
  pump.setActive(true);
  await timer.tick();
  assert.equal(requests.length, 1);
  const frame = new ArrayBuffer(16);
  resolve(frame);
  await timer.tick();
  assert.deepEqual(presented, [frame]);
  assert.deepEqual(requests, [true, true]);
  pump.dispose();
  resolve(frame);
  await timer.tick();
  assert.equal(presented.length, 1);
  assert.equal(timer.pending.size, 0);
});

/** 每个时钟只绘制一次，下一次 IPC 从本次绘制开始，重复激活不请求完整帧。 */
test("frame pump starts the next IPC before the next animation tick", async (t) => {
  const timer = clock(t),
    requests = [];
  let paints = 0;
  const pump = new VncFramePump(
    async (full) => {
      requests.push(full);
      return new ArrayBuffer(16);
    },
    /** 用计数替代 Canvas，断言每次时钟只消费一次。 */ () => paints++,
    (error) => assert.fail(String(error)),
  );
  pump.setActive(true);
  assert.deepEqual(requests, [true]);
  for (let index = 0; index < 120; index++) {
    pump.setActive(true);
    await timer.tick();
  }
  assert.equal(paints, 120);
  assert.equal(requests.length, 121);
  assert.equal(requests[0], true);
  assert.ok(requests.slice(1).every((full) => full === false));
  pump.setActive(false);
  assert.equal(timer.pending.size, 0);
  pump.dispose();
});

/** 响应已到达但画布隐藏时取消待绘制内容；重新显示用完整帧恢复已经消费的变化。 */
test("frame pump drops a queued paint while hidden and reads a full frame on return", async (t) => {
  const timer = clock(t);
  const requests = [];
  let paints = 0;
  const pump = new VncFramePump(
    /** full 记录重建请求；响应只有帧头，不依赖真实 IPC。 */
    async (full) => {
      requests.push(full);
      return new ArrayBuffer(16);
    },
    /** 用计数验证隐藏时没有绘制。 */ () => paints++,
    /** error 为非预期调度错误，立即使测试失败。 */ (error) => assert.fail(String(error)),
  );
  pump.setActive(true);
  await Promise.resolve();
  assert.equal(timer.pending.size, 1);
  pump.setActive(false);
  await timer.tick();
  assert.equal(paints, 0);
  assert.deepEqual(requests, [true]);
  pump.setActive(true);
  await timer.tick();
  assert.equal(paints, 1);
  assert.deepEqual(requests, [true, true, false]);
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

/** 模拟视图重挂载。旧 IPC 即使失败也先结束，新视图再用自己的完整帧请求恢复。 */
test("VNC IPC serializes reads across view remount even after the previous request fails", async (t) => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests = [];
  let rejectPrevious;
  const frame = new ArrayBuffer(16);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        /** command/args 记录真实调用；第一条挂起，第二条返回新快照。 */
        invoke(command, args) {
          requests.push([command, args]);
          if (requests.length === 2) return Promise.resolve(frame);
          return new Promise(/** 让测试显式结束第一条 IPC。 */ (_, reject) => {
            rejectPrevious = reject;
          });
        },
      },
    },
  });
  t.after(/** 还原原有窗口对象，避免其他测试看到模拟 IPC。 */ () => {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else delete globalThis.window;
  });
  const previous = pollFrame("remount");
  const replacement = pollFrame("remount", true);
  assert.equal(requests.length, 1);
  const failure = new Error("old IPC failed");
  rejectPrevious(failure);
  await assert.rejects(previous, failure);
  assert.equal(await replacement, frame);
  assert.deepEqual(requests, [
    ["vnc_poll_frame", { sessionId: "remount", full: false }],
    ["vnc_poll_frame", { sessionId: "remount", full: true }],
  ]);
});
