/**
 * 从桌面应用 SVG 图稿生成 Tauri 桌面图标，并固定 ICNS chunk 顺序以保证生成稳定。
 * 输出限于 src-tauri/icons 中已有的桌面图标；临时目录中的移动端产物会清理。
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 桌面图标的唯一 SVG 源图保存在共享图标目录中。 */
const sourceSvgPath = join(projectRoot, 'src', 'assets', 'svg', 'app-icon.svg');
const iconDirectory = join(projectRoot, 'src-tauri', 'icons');

// 仅复制 Tauri 配置和仓库中已有的桌面端图标，不带入移动端生成文件。
const desktopIconNames = [
  '32x32.png',
  '64x64.png',
  '128x128.png',
  '128x128@2x.png',
  'icon.png',
  'icon.ico',
  'icon.icns',
  'Square30x30Logo.png',
  'Square44x44Logo.png',
  'Square71x71Logo.png',
  'Square89x89Logo.png',
  'Square107x107Logo.png',
  'Square142x142Logo.png',
  'Square150x150Logo.png',
  'Square284x284Logo.png',
  'Square310x310Logo.png',
  'StoreLogo.png',
];

/**
 * 调用仓库锁定的 Tauri CLI 从唯一 SVG 源生成完整平台图标；CLI 非零退出时抛出错误。
 * @param {string} svgPath 规范图稿的绝对路径。
 * @param {string} outputDirectory 生成文件的临时目录。
 */
function generateWithTauri(svgPath, outputDirectory) {
  execFileSync(
    'pnpm',
    ['exec', 'tauri', 'icon', svgPath, '--output', outputDirectory],
    { cwd: projectRoot, stdio: 'inherit' },
  );
}

/**
 * 按 ICNS chunk 类型排序 macOS 图标数据，消除 Tauri CLI 每次生成时的随机排列。
 * @param {string} icnsPath 待规范化的 ICNS 文件路径，会原位覆盖。
 * @throws {Error} ICNS 头、chunk 边界或 chunk 类型无效或重复时抛出错误。
 */
function normalizeIcns(icnsPath) {
  const icnsData = readFileSync(icnsPath);
  const headerLength = 8; // ICNS 文件头固定包含 4 字节签名和 4 字节总长度。
  if (
    icnsData.length < headerLength ||
    icnsData.toString('ascii', 0, 4) !== 'icns' ||
    icnsData.readUInt32BE(4) !== icnsData.length
  ) {
    throw new Error(`Tauri 生成了无效 ICNS 文件：${icnsPath}`);
  }

  const chunks = [];
  const chunkTypes = new Set();
  let offset = headerLength;
  while (offset < icnsData.length) {
    const chunkHeaderLength = 8; // 每个 chunk 由 4 字节类型和 4 字节长度组成。
    if (offset + chunkHeaderLength > icnsData.length) {
      throw new Error(`ICNS chunk 头部被截断：${icnsPath}`);
    }
    const chunkType = icnsData.toString('ascii', offset, offset + 4);
    const chunkLength = icnsData.readUInt32BE(offset + 4);
    if (
      !/^[\x20-\x7e]{4}$/.test(chunkType) ||
      chunkLength < chunkHeaderLength ||
      offset + chunkLength > icnsData.length ||
      chunkTypes.has(chunkType)
    ) {
      throw new Error(`ICNS chunk 格式无效或重复：${chunkType}`);
    }
    chunkTypes.add(chunkType);
    chunks.push({
      type: chunkType,
      data: icnsData.subarray(offset, offset + chunkLength),
    });
    offset += chunkLength;
  }

  // 稳定按 ASCII chunk 类型排序；ICNS 读取器按类型识别图像，与排列顺序无关。
  chunks.sort((left, right) => (left.type < right.type ? -1 : left.type > right.type ? 1 : 0));
  writeFileSync(icnsPath, Buffer.concat([icnsData.subarray(0, headerLength), ...chunks.map(({ data }) => data)]));
}

/**
 * 以原文件字节备份后替换整组图标；写入失败时回滚所有目标并保留原始错误。
 * @param {Array<{sourcePath: string, targetPath: string}>} copyPlan 已验证的源文件和目标文件清单。
 * @throws {Error|AggregateError} 替换失败时抛出原错误；回滚也失败时聚合原错误与回滚错误。
 */
function replaceIcons(copyPlan) {
  const backups = copyPlan.map(({ targetPath }) => ({
    targetPath,
    contents: readFileSync(targetPath),
  }));

  try {
    for (const { sourcePath, targetPath } of copyPlan) {
      copyFileSync(sourcePath, targetPath);
    }
  } catch (writeError) {
    // 即使当前文件只写入了一部分，也恢复全部备份，避免留下混合版本。
    const rollbackErrors = [];
    for (const { targetPath, contents } of backups) {
      try {
        writeFileSync(targetPath, contents);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [writeError, ...rollbackErrors],
        '图标替换失败且回滚不完整；首个错误为原始写入错误。',
      );
    }
    throw writeError;
  }
}

/**
 * 生成并校验桌面图标后事务式替换 Tauri 图标，始终清理中间文件。
 * @throws {Error} 源文件、生成文件或目标文件缺失，或 Tauri CLI 失败时抛出错误。
 */
function generateIcons() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'rivet-icons-'));
  try {
    const outputDirectory = join(temporaryDirectory, 'generated');
    generateWithTauri(sourceSvgPath, outputDirectory);
    normalizeIcns(join(outputDirectory, 'icon.icns'));

    // 先验证全部源产物和目标文件，再复制，避免生成失败时留下半套图标。
    const copyPlan = desktopIconNames.map((fileName) => ({
      sourcePath: join(outputDirectory, fileName),
      targetPath: join(iconDirectory, fileName),
    }));
    for (const { sourcePath, targetPath } of copyPlan) {
      if (!existsSync(sourcePath) || !existsSync(targetPath)) {
        throw new Error(`图标源产物或现有目标文件缺失：${sourcePath} -> ${targetPath}`);
      }
    }
    replaceIcons(copyPlan);
    console.log(`已从 src/assets/svg/app-icon.svg 生成 ${copyPlan.length} 个桌面图标。`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

try {
  generateIcons();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
