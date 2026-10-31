/** 浏览器键盘到 RFB/X11 keysym 的独立映射，不访问终端输入处理。 */

/** 控制键和导航键的标准 X11 keysym。 */
const KEY_SYMBOLS: Readonly<Record<string, number>> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Insert: 0xff63,
  Delete: 0xffff,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffeb,
  CapsLock: 0xffe5,
  NumLock: 0xff7f,
};

/**
 * 将浏览器键值转换为 X11 keysym；不支持的键返回 null，不访问或保存输入状态。
 * location 为 DOM 键盘位置，默认 0；code 为物理键位，缺省时保留原始 Unicode。
 * 调用方须先排除输入法组合事件；物理句点键不采用本地输入法的中文标点转换。
 */
export function keySymbol(key: string, location = 0, code = ""): number | null {
  // 非组合的 Period 按键发送英文句点；没有对应物理键位的中文文本仍按 Unicode 转发。
  if (code === "Period" && key === "。") key = ".";
  if (Object.hasOwn(KEY_SYMBOLS, key)) {
    // DOM location=2 表示右侧修饰键；X11 左右修饰键相邻。
    return (
      KEY_SYMBOLS[key] +
      (location === 2 && ["Shift", "Control", "Alt", "Meta"].includes(key)
        ? 1
        : 0)
    );
  }
  if (/^F(?:[1-9]|[12]\d|3[0-5])$/u.test(key))
    return 0xffbd + Number(key.slice(1));
  const characters = [...key];
  if (characters.length !== 1) return null;
  const point = characters[0].codePointAt(0);
  if (point === undefined) return null;
  // Latin-1 直接使用字符值，其余字符使用 X11 Unicode 标记位。
  return point <= 0xff ? point : 0x0100_0000 | point;
}

/**
 * 将一次 DOM 按下/释放转换为有序 RFB 键事件，并更新本会话独占的按键表。
 * macOS 的 Caps Lock 两种状态通知均转换为完整点击，不保留为持续按下的键。
 * 重复按下沿用首个 keysym；未知键和未记录的释放不产生事件。
 */
export function keyTransitions(
  event: Pick<KeyboardEvent, "key" | "code" | "location" | "repeat"> & {
    metaKey?: boolean;
  },
  down: boolean,
  pressed: Map<string, number>,
  macOS: boolean,
): { key: number; down: boolean }[] {
  if (macOS && event.code === "CapsLock") {
    if (event.repeat) return [];
    const key = KEY_SYMBOLS.CapsLock;
    pressed.delete(event.code);
    // macOS 开启锁定发送 keydown，关闭发送 keyup；每次通知都需再次触发远端锁定键。
    return [
      { key, down: true },
      { key, down: false },
    ];
  }
  const key =
    pressed.get(event.code) ??
    (down ? keySymbol(event.key, event.location, event.code) : null);
  if (key === null) return [];
  // macOS 的 Command 组合可能没有字符 keyup；立即释放字符，修饰键仍独立配对。
  if (
    macOS && down && event.metaKey &&
    event.code !== "MetaLeft" && event.code !== "MetaRight"
  ) {
    pressed.delete(event.code);
    return [
      { key, down: true },
      { key, down: false },
    ];
  }
  if (down) pressed.set(event.code, key);
  else pressed.delete(event.code);
  return [{ key, down }];
}

/** DOM buttons 的左右中顺序转为 RFB 的左中右顺序，忽略额外鼠标键。 */
export function pointerButtons(buttons: number): number {
  return (buttons & 1) | ((buttons & 4) >> 1) | ((buttons & 2) << 1);
}
