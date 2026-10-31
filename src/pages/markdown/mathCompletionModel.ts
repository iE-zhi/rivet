/** 公式补全的完整命令目录与光标范围计算；数据来自 KaTeX 0.19.1 官方支持表，离线使用。 */
import catalogue from "./mathCommands.json" with { type: "json" };

/** 官方命令与完整示例；禁用项需要当前编辑器不允许的外部资源权限。 */
export interface MathCommand {
  readonly name: string;
  readonly code: string;
  readonly preview: string;
  readonly disabled?: boolean;
}

/** 输入中的反斜杠命令及替换范围，偏移均为当前公式源码的 UTF-16 单元。 */
export interface MathQuery { from: number; to: number; text: string }

/** 官方 994 条支持记录去重为 992 个命令/环境；优先展示常用命令，其余均保留。 */
export const mathCommands: readonly MathCommand[] = catalogue.entries;
/** 无筛选时排在前面的公式结构，不影响完整目录和搜索结果。 */
const COMMON_COMMANDS = ["\\frac", "\\sqrt", "\\sum", "\\int", "\\alpha", "\\beta", "\\begin{pmatrix}", "\\begin{cases}"];

/** 只补全折叠光标前的命令；换行、转义双反斜杠和文字选区不触发。 */
export function mathQuery(source: string, from: number, to: number): MathQuery | null {
  if (from !== to || from < 0 || from > source.length) return null;
  const match = source.slice(0, from).match(/\\(?:begin\{[A-Za-z*]*\}?|[A-Za-z]*|[^\w\\\s])$/);
  if (!match) return null;
  const start = from - match[0].length;
  let preceding = start;
  while (preceding > 0 && source[preceding - 1] === "\\") preceding -= 1;
  if ((start - preceding) % 2) return null;
  // 光标在命令中间时也替换完整命令，不把原有后缀遗留在插入模板后面。
  const suffix = source.slice(from).match(match[0].startsWith("\\begin{") ? /^[A-Za-z*]*\}?/ : /^[A-Za-z]*/)?.[0] ?? "";
  return { from: start, to: from + suffix.length, text: match[0] };
}

/** 只提供当前可用命令；代码可检索，大小写精确前缀优先，完整目录仍保留供版本审计。 */
export function matchingMathCommands(query: string): readonly MathCommand[] {
  const normalized = query.toLowerCase();
  return mathCommands.filter(/** 不展示需要外部资源权限的命令，避免把错误预览当成公式候选。 */ (item) => !item.disabled && (item.name.toLowerCase().includes(normalized) || item.code.toLowerCase().includes(normalized))).sort(/** 同分时保留官方目录顺序，区分大小写的命令不合并。 */ (a, b) => {
    if (query === "\\") {
      const left = COMMON_COMMANDS.indexOf(a.name);
      const right = COMMON_COMMANDS.indexOf(b.name);
      return (left < 0 ? COMMON_COMMANDS.length : left) - (right < 0 ? COMMON_COMMANDS.length : right);
    }
    return Number(b.name.startsWith(query)) - Number(a.name.startsWith(query));
  });
}

/** 插入后选中首个普通参数供直接改写；环境名不选中，没有参数时停在模板末尾。 */
export function mathTemplateSelection(code: string): { from: number; to: number } {
  const parameter = /\{([^{}]+)\}/g;
  for (const match of code.matchAll(parameter)) {
    if (/\\(?:begin|end)$/.test(code.slice(0, match.index))) continue;
    return { from: match.index + 1, to: match.index + 1 + match[1].length };
  }
  // TeX 也允许单字符参数不加花括号，例如官方示例中的 \frac a b。
  const bare = code.match(/^\\[A-Za-z]+\s+([^\\{}\s])/);
  if (bare) return { from: bare[0].length - 1, to: bare[0].length };
  return { from: code.length, to: code.length };
}
