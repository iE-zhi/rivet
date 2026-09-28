/**
 * 按给定分组顺序重排扁平集合，并保持每个分组内部项目的原有顺序。
 * 未出现在 orderedGroups 中的现存分组会按原顺序追加，避免并发更新丢失数据。
 */
export function reorderGroupedCollection<T>(
  items: readonly T[],
  orderedGroups: readonly string[],
  getGroup: (item: T) => string,
): T[] {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const group = getGroup(item);
    const bucket = buckets.get(group);
    if (bucket) bucket.push(item);
    else buckets.set(group, [item]);
  }

  const result: T[] = [];
  const emitted = new Set<string>();
  for (const group of orderedGroups) {
    const bucket = buckets.get(group);
    if (!bucket || emitted.has(group)) continue;
    result.push(...bucket);
    emitted.add(group);
  }

  for (const [group, bucket] of buckets) {
    if (!emitted.has(group)) result.push(...bucket);
  }
  return result;
}
