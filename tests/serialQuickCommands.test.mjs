/**
 * 验证快捷命令持久化结构的严格校验、往返和损坏数据回退。
 * @module
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  deserializeSerialQuickCommands,
  isSerialQuickCommandGroups,
  serializeSerialQuickCommands,
} from "../src/pages/serialQuickCommands.ts";

/** 一组覆盖文本、Hex 和行尾选项的有效样例。 */
const VALID_GROUPS = [
  {
    id: "group-1",
    name: "常用",
    commands: [
      {
        id: "command-1",
        name: "查询状态",
        payload: "AT+STATUS",
        mode: "text",
        appendCR: true,
        appendLF: true,
      },
      {
        id: "command-2",
        name: "复位",
        payload: "EB 90 01",
        mode: "hex",
        appendCR: false,
        appendLF: false,
      },
    ],
  },
];

/** 缺失、损坏、非数组及过大内容均安全回退为空列表。 */
test("快捷命令缺失或损坏时回退为空列表", () => {
  assert.deepEqual(deserializeSerialQuickCommands(null), []);
  assert.deepEqual(deserializeSerialQuickCommands("{"), []);
  assert.deepEqual(deserializeSerialQuickCommands("{}"), []);
  assert.deepEqual(deserializeSerialQuickCommands("x".repeat(262_145)), []);
});

/** 有效配置完成 JSON 往返，并返回与输入隔离的深拷贝。 */
test("有效快捷命令完成序列化往返", () => {
  const restored = deserializeSerialQuickCommands(serializeSerialQuickCommands(VALID_GROUPS));

  assert.deepEqual(restored, VALID_GROUPS);
  assert.notEqual(restored, VALID_GROUPS);
  assert.notEqual(restored[0], VALID_GROUPS[0]);
  assert.notEqual(restored[0].commands[0], VALID_GROUPS[0].commands[0]);
});

/** 未知字段、重复标识、重复分组名、非法格式及空内容全部被拒绝。 */
test("快捷命令严格拒绝损坏结构", () => {
  const invalidCases = [
    [{ ...VALID_GROUPS[0], unexpected: true }],
    [
      ...VALID_GROUPS,
      { id: "group-1", name: "其他", commands: [] },
    ],
    [
      ...VALID_GROUPS,
      { id: "group-2", name: "常用", commands: [] },
    ],
    [{
      ...VALID_GROUPS[0],
      commands: [
        VALID_GROUPS[0].commands[0],
        { ...VALID_GROUPS[0].commands[1], id: "command-1" },
      ],
    }],
    [{
      ...VALID_GROUPS[0],
      commands: [{ ...VALID_GROUPS[0].commands[0], mode: "binary" }],
    }],
    [{
      ...VALID_GROUPS[0],
      commands: [{ ...VALID_GROUPS[0].commands[0], payload: "" }],
    }],
    [{
      ...VALID_GROUPS[0],
      name: " 常用",
    }],
  ];

  for (const value of invalidCases) {
    assert.equal(isSerialQuickCommandGroups(value), false);
    assert.deepEqual(deserializeSerialQuickCommands(JSON.stringify(value)), []);
  }
});

/** 序列化入口拒绝无效运行时对象，避免把损坏状态持久化。 */
test("序列化入口拒绝无效快捷命令", () => {
  assert.throws(
    () => serializeSerialQuickCommands([{ ...VALID_GROUPS[0], commands: [] }, { id: "group-2", name: "常用", commands: [] }]),
    TypeError,
  );
});
