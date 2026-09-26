/** 主导航顺序与可见性的持久化键；该项参与跨设备同步。 */
export const NAVIGATION_SETTINGS_STORAGE_KEY = "rivet.navigationSettings";

/** 当前允许用户排序和隐藏的主导航工具页；设置入口固定保留。 */
export type NavigationItemId = "serial" | "terminal";

/** 单个主导航工具页的顺序项与可见状态。 */
export interface NavigationItemSetting {
  id: NavigationItemId;
  visible: boolean;
}

/** 主导航自定义列表；数组顺序即导航栏显示顺序。 */
export type NavigationSettings = NavigationItemSetting[];

/** 首次启动或持久化内容损坏时的默认导航布局。 */
export const DEFAULT_NAVIGATION_SETTINGS: ReadonlyArray<Readonly<NavigationItemSetting>> = [
  { id: "serial", visible: true },
  { id: "terminal", visible: true },
];

const NAVIGATION_ITEM_IDS: readonly NavigationItemId[] = ["serial", "terminal"];
const MAX_SERIALIZED_NAVIGATION_SETTINGS_LENGTH = 512;

/** 判断未知值是否是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 严格校验主导航设置，要求所有已支持页面各出现一次且没有扩展字段。
 * @param value 未信任的运行时值。
 * @returns 顺序、页面标识和可见状态均有效时为 true。
 */
export function isNavigationSettings(value: unknown): value is NavigationSettings {
  if (!Array.isArray(value) || value.length !== NAVIGATION_ITEM_IDS.length) {
    return false;
  }

  const seen = new Set<NavigationItemId>();
  for (const item of value) {
    if (!isRecord(item)) {
      return false;
    }
    const keys = Object.keys(item);
    if (keys.length !== 2 || !keys.includes("id") || !keys.includes("visible")) {
      return false;
    }
    if ((item.id !== "serial" && item.id !== "terminal") || typeof item.visible !== "boolean" || seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
  }

  return NAVIGATION_ITEM_IDS.every((id) => seen.has(id));
}

/** 返回默认导航设置的独立副本。 */
function createDefaultNavigationSettings(): NavigationSettings {
  return DEFAULT_NAVIGATION_SETTINGS.map((item) => ({ ...item }));
}

/**
 * 从 localStorage JSON 恢复主导航顺序和可见状态。
 * @param serialized localStorage 中的原始字符串。
 * @returns 已校验的独立导航设置；缺失或非法内容回退到默认值。
 */
export function deserializeNavigationSettings(serialized: string | null): NavigationSettings {
  if (serialized === null || serialized.length > MAX_SERIALIZED_NAVIGATION_SETTINGS_LENGTH) {
    return createDefaultNavigationSettings();
  }

  try {
    const parsed: unknown = JSON.parse(serialized);
    return isNavigationSettings(parsed) ? parsed.map((item) => ({ ...item })) : createDefaultNavigationSettings();
  } catch {
    return createDefaultNavigationSettings();
  }
}

/**
 * 将严格校验后的主导航设置编码为 JSON。
 * @param settings 待持久化的候选设置。
 * @returns 可写入 localStorage 的 JSON。
 * @throws 候选设置结构无效时抛出 TypeError。
 */
export function serializeNavigationSettings(settings: unknown): string {
  if (!isNavigationSettings(settings)) {
    throw new TypeError("无效的主导航设置。");
  }
  return JSON.stringify(settings);
}
