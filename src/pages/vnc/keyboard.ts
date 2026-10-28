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

/** 把浏览器 key/location 转为 keysym；不支持的组合、IME 中间态返回 null。 */
export function keySymbol(key: string, location = 0): number | null {
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

/** DOM buttons 的左右中顺序转为 RFB 的左中右顺序，忽略额外鼠标键。 */
export function pointerButtons(buttons: number): number {
  return (buttons & 1) | ((buttons & 4) >> 1) | ((buttons & 2) << 1);
}
