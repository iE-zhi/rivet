import assert from "node:assert/strict";
import test from "node:test";
import {
  deserializeTerminalQuickCommands,
  serializeTerminalQuickCommands,
  TERMINAL_QUICK_COMMANDS_STORAGE_KEY,
} from "../src/pages/terminalQuickCommands.ts";

const COMMANDS = [
  {
    id: "cmd-1",
    name: "List files",
    group: "Common",
    command: "ls -la",
  },
  {
    id: "cmd-2",
    name: "Working directory",
    group: "Common",
    command: "pwd",
  },
];

/** 终端快捷命令必须完整往返并使用独立存储键。 */
test("terminal quick commands round trip", () => {
  assert.equal(TERMINAL_QUICK_COMMANDS_STORAGE_KEY, "rivet.terminal.quickCommands");
  const serialized = serializeTerminalQuickCommands(COMMANDS);
  assert.deepEqual(deserializeTerminalQuickCommands(serialized), COMMANDS);
});

/** 损坏结构、重复 ID 和空命令不得进入运行时。 */
test("terminal quick commands reject malformed data", () => {
  assert.deepEqual(deserializeTerminalQuickCommands("{"), []);
  assert.deepEqual(
    deserializeTerminalQuickCommands(
      JSON.stringify([{ ...COMMANDS[0], command: "" }]),
    ),
    [],
  );
  assert.deepEqual(
    deserializeTerminalQuickCommands(
      JSON.stringify([COMMANDS[0], { ...COMMANDS[1], id: COMMANDS[0].id }]),
    ),
    [],
  );
  assert.throws(() =>
    serializeTerminalQuickCommands([{ ...COMMANDS[0], group: " Common " }]),
  );
});
