/**
 * 验证串口默认参数的 JSON 持久化边界及损坏数据回退行为。
 * @module
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SERIAL_DEFAULTS,
  deserializeSerialDefaults,
  isSerialDefaults,
  serializeSerialDefaults,
} from "../src/pages/serialDefaults.ts";

/** 确认缺少配置、损坏 JSON 和非对象根节点都返回安全默认值。 */
test("缺少或损坏的串口默认参数回退到安全值", () => {
  assert.deepEqual(deserializeSerialDefaults(null), DEFAULT_SERIAL_DEFAULTS);
  assert.deepEqual(deserializeSerialDefaults("{"), DEFAULT_SERIAL_DEFAULTS);
  assert.deepEqual(deserializeSerialDefaults("null"), DEFAULT_SERIAL_DEFAULTS);
  assert.deepEqual(deserializeSerialDefaults("[]"), DEFAULT_SERIAL_DEFAULTS);
  assert.deepEqual(deserializeSerialDefaults(`${JSON.stringify(DEFAULT_SERIAL_DEFAULTS)}${" ".repeat(257)}`), DEFAULT_SERIAL_DEFAULTS);
});

/** 确认所有字段都由持久化数据恢复，且返回对象与默认常量隔离。 */
test("有效串口默认参数完成序列化往返", () => {
  const expected = {
    baudRate: 921600,
    dataBits: 6,
    parity: "even",
    stopBits: 2,
    flowControl: "software",
  };
  const restored = deserializeSerialDefaults(serializeSerialDefaults(expected));

  assert.deepEqual(restored, expected);
  assert.notEqual(restored, DEFAULT_SERIAL_DEFAULTS);
});

/** 确认波特率的 u32 边界及字段合法值均被接受。 */
test("u32 波特率与所有受支持枚举边界均有效", () => {
  for (const baudRate of [1, 4_294_967_295]) {
    for (const dataBits of [5, 6, 7, 8]) {
      for (const parity of ["none", "even", "odd"]) {
        for (const stopBits of [1, 2]) {
          for (const flowControl of ["none", "hardware", "software"]) {
            assert.equal(isSerialDefaults({ baudRate, dataBits, parity, stopBits, flowControl }), true);
          }
        }
      }
    }
  }
});

/** 确认每个损坏字段、遗漏字段及未知字段都会令整组配置安全回退。 */
test("任一字段无效时整组配置回退", () => {
  const valid = { ...DEFAULT_SERIAL_DEFAULTS };
  const invalidCases = [
    { ...valid, baudRate: 0 },
    { ...valid, baudRate: 4_294_967_296 },
    { ...valid, baudRate: 1.5 },
    { ...valid, baudRate: "115200" },
    { ...valid, dataBits: 4 },
    { ...valid, dataBits: "8" },
    { ...valid, parity: "mark" },
    { ...valid, stopBits: 0 },
    { ...valid, flowControl: "xonxoff" },
    { ...valid, flowControl: undefined },
    { ...valid, unexpected: true },
  ];

  for (const value of invalidCases) {
    assert.equal(isSerialDefaults(value), false);
    assert.deepEqual(deserializeSerialDefaults(JSON.stringify(value)), DEFAULT_SERIAL_DEFAULTS);
  }
});

/** 确认序列化入口不会把无效运行时对象写入用户配置。 */
test("序列化入口拒绝无效串口参数", () => {
  assert.throws(() => serializeSerialDefaults({ ...DEFAULT_SERIAL_DEFAULTS, baudRate: 0 }), TypeError);
});
