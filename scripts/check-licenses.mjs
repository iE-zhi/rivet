import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** 允许的宽松 SPDX 许可证集合，新增未识别许可证时校验失败。 */
const allowed = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Zlib"]);
/** 用户已批准的精确包版本例外；许可证标识也必须与审查时一致。 */
const approvedExceptions = new Map([
  ["lightningcss@1.33.0", "MPL-2.0"],
  ["lightningcss-win32-x64-msvc@1.33.0", "MPL-2.0"],
  ["cssparser@0.36.0", "MPL-2.0"],
  ["cssparser-macros@0.6.1", "MPL-2.0"],
  ["dtoa-short@0.3.5", "MPL-2.0"],
  ["option-ext@0.2.0", "MPL-2.0"],
  ["selectors@0.36.1", "MPL-2.0"],
  ["icu_collections@2.3.0", "Unicode-3.0"],
  ["icu_locale_core@2.3.0", "Unicode-3.0"],
  ["icu_normalizer@2.3.0", "Unicode-3.0"],
  ["icu_normalizer_data@2.3.0", "Unicode-3.0"],
  ["icu_properties@2.3.0", "Unicode-3.0"],
  ["icu_properties_data@2.3.0", "Unicode-3.0"],
  ["icu_provider@2.3.1", "Unicode-3.0"],
  ["litemap@0.8.3", "Unicode-3.0"],
  ["potential_utf@0.1.6", "Unicode-3.0"],
  ["tinystr@0.8.4", "Unicode-3.0"],
  ["writeable@0.6.4", "Unicode-3.0"],
  ["yoke@0.8.3", "Unicode-3.0"],
  ["yoke-derive@0.8.3", "Unicode-3.0"],
  ["zerofrom@0.1.8", "Unicode-3.0"],
  ["zerofrom-derive@0.1.8", "Unicode-3.0"],
  ["zerotrie@0.2.5", "Unicode-3.0"],
  ["zerovec@0.11.8", "Unicode-3.0"],
  ["zerovec-derive@0.11.6", "Unicode-3.0"],
  ["target-lexicon@0.12.16", "Apache-2.0 WITH LLVM-exception"],
  ["unicode-ident@1.0.26", "(MIT OR Apache-2.0) AND Unicode-3.0"],
]);
/** pnpm 虚拟存储中的每个目录代表锁文件中的一个已安装依赖实例。 */
const virtualStore = join(process.cwd(), "node_modules", ".pnpm");

/** 仅放行明确批准的包版本及其审查过的原始许可证表达式。 */
function hasApprovedLicense(packageId, license) {
  return isAllowedExpression(license) || approvedExceptions.get(packageId) === license;
}

/** 读取 npm 依赖包清单中的许可证标识；未知/缺失标识必须人工审查。 */
function readNpmLicense(packageJsonPath) {
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const raw = typeof manifest.license === "string" ? manifest.license : manifest.license?.type;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return raw;
}

/** 判断 SPDX 表达式是否存在一条完全由允许许可证组成的授权路径。 */
function isAllowedExpression(expression) {
  const normalized = expression.replace(/\s*\/\s*/g, " OR ");
  // 仅接受许可证操作符、括号和 SPDX 标识，未知字符将导致校验失败。
  const tokenPattern = /\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9.+-]+/gi;
  const tokens = normalized.match(tokenPattern) ?? [];
  if (normalized.replace(tokenPattern, "").trim() !== "") return false;
  let cursor = 0;
  /** 解析括号和许可证项；WITH 例外从严视为未审查。 */
  function parsePrimary() {
    if (tokens[cursor] === "(") {
      cursor += 1;
      const value = parseOr();
      if (tokens[cursor] !== ")") throw new Error(`无效 SPDX 表达式：${expression}`);
      cursor += 1;
      return value;
    }
    const license = tokens[cursor++];
    if (!license || ["AND", "OR", "WITH", ")"].includes(license.toUpperCase())) throw new Error(`无效 SPDX 表达式：${expression}`);
    if (tokens[cursor]?.toUpperCase() === "WITH") {
      cursor += 2;
      return false;
    }
    return allowed.has(license);
  }
  /** AND 优先于 OR，任何 AND 子项不允许即拒绝该路径。 */
  function parseAnd() {
    let value = parsePrimary();
    while (tokens[cursor]?.toUpperCase() === "AND") {
      cursor += 1;
      value = parsePrimary() && value;
    }
    return value;
  }
  /** OR 分支中至少有一条完整允许路径即可。 */
  function parseOr() {
    let value = parseAnd();
    while (tokens[cursor]?.toUpperCase() === "OR") {
      cursor += 1;
      value = parseAnd() || value;
    }
    return value;
  }
  // 无法解析的 SPDX 表达式按不允许处理，避免不完整扫描放行依赖。
  try {
    const accepted = parseOr();
    return accepted && cursor === tokens.length;
  } catch {
    return false;
  }
}

/** 遍历 pnpm 虚拟存储中的所有解析 npm 包并列出未允许许可证。 */
function collectNpmLicenses() {
  const violations = [];
  const seen = new Set();
  for (const snapshot of readdirSync(virtualStore, { withFileTypes: true })) {
    const packageRoot = join(virtualStore, snapshot.name, "node_modules");
    let entries;
    try {
      entries = readdirSync(packageRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const packageDirs = entry.name.startsWith("@")
        ? readdirSync(join(packageRoot, entry.name), { withFileTypes: true }).map((item) => join(packageRoot, entry.name, item.name))
        : [join(packageRoot, entry.name)];
      for (const packageDir of packageDirs) {
        const manifestPath = join(packageDir, "package.json");
        try {
          if (!statSync(manifestPath).isFile() || seen.has(manifestPath)) continue;
          const license = readNpmLicense(manifestPath);
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
          const packageId = `${manifest.name}@${manifest.version}`;
          if (seen.has(packageId)) continue;
          seen.add(packageId);
          if (!license || !hasApprovedLicense(packageId, license)) {
            violations.push(`${packageId}: ${license ?? "missing license"}`);
          }
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    }
  }
  return violations;
}

/** 通过 Cargo 锁定的完整依赖图读取包许可证并检查 SPDX 表达式。 */
function collectCargoLicenses() {
  const result = spawnSync("cargo", ["metadata", "--locked", "--format-version", "1"], {
    cwd: join(process.cwd(), "src-tauri"),
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error([result.stderr, result.error?.message, "cargo metadata 失败"].filter(Boolean).join("\n"));
  const metadata = JSON.parse(result.stdout);
  return metadata.packages.flatMap((pkg) => {
    if (pkg.source === null) return [];
    const packageId = `${pkg.name}@${pkg.version}`;
    if (!pkg.license || !hasApprovedLicense(packageId, pkg.license)) return [`${packageId}: ${pkg.license ?? "missing license"}`];
    return [];
  });
}

/** 阻止依赖树新增未审查许可证；退出码供 CI 和本地构建门禁使用。 */
function main() {
  let violations;
  try { violations = [...collectNpmLicenses(), ...collectCargoLicenses()]; } catch (error) {
    console.error(`许可证检查无法读取依赖图：${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (violations.length) {
    console.error(`发现 ${violations.length} 个未允许的依赖许可证：\n${violations.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log("依赖许可证均已获准（白名单或精确锁定版本例外）。");
}

main();
