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
/** 项目锁定版本的 Tauri CLI 入口；通过当前 Node 运行时调用，避免依赖全局 PATH。 */
const tauriCliPath = join(projectRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

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

/** Windows 资源文件清单；不包含 macOS ICNS 和未列入 Tauri bundle 配置的通用 icon.png。 */
const windowsIconNames = desktopIconNames.filter(
  (fileName) => fileName !== 'icon.icns' && fileName !== 'icon.png',
);
/** 任务栏常用小尺寸采用光学放大，36px 覆盖 Windows 11 在 150% 缩放下的尺寸。 */
const windowsOpticalIconSizes = [16, 24, 32, 36, 48, 64];
/** Tauri 2.6.3 读取 ICO 首帧作为默认窗口图标；48px 帧适配 150% DPI 的 32px 任务栏尺寸。 */
const windowsDefaultIconSize = 48;
/** 小尺寸中前景图形相对画布中心额外放大 20%，再由临时视口缩放整个图标。 */
const windowsMarkScale = 1.2;
/** 临时缩小 SVG 视口以将小尺寸 ICO 帧整体放大约 18.5%，保留原始源图和 256px 帧。 */
const windowsOpticalViewBox = '40 40 432 432';
/** 规范 SVG 画布中心坐标，单位为 SVG 用户坐标。 */
const svgCanvasCenter = 256;
/** ICO 文件头含 6 字节目录信息。 */
const icoHeaderLength = 6;
/** ICO 每个图像目录项固定占用 16 字节。 */
const icoDirectoryEntryLength = 16;
/** ICO 头和目录字段偏移均以字节计，帧目录中的 0 尺寸编码 256px。 */
const icoFields = {
  reservedOffset: 0, // 头部保留字段偏移。
  typeOffset: 2, // 图标类型字段偏移。
  countOffset: 4, // 图像帧数量字段偏移。
  zeroValue: 0, // ICO 中保留字段和 256px 尺寸编码使用零值。
  iconType: 1, // 图标资源类型编号。
  minDimension: 1, // ICO 帧最小边长。
  widthOffset: 0, // 目录项宽度字节偏移。
  heightOffset: 1, // 目录项高度字节偏移。
  reservedEntryOffset: 3, // 目录项保留字节偏移。
  planesOffset: 4, // 目录项颜色平面字段偏移。
  bitCountOffset: 6, // 目录项位深字段偏移。
  payloadLengthOffset: 8, // 图像载荷长度字段偏移。
  payloadOffsetOffset: 12, // 图像载荷文件偏移字段偏移。
  maxDimension: 256, // ICO 单帧边长上限。
  defaultPlanes: 1, // 新增帧的默认颜色平面数。
  defaultBitCount: 32, // 新增 PNG 帧的默认颜色位深。
};
/** Tauri 可从该 1024px 母版重采样生成 ICNS 小尺寸帧。 */
const macosMasterIconSize = 1024;
/** ICNS 现代 PNG chunk 标识与规范边长的对应关系。 */
const icnsPngFrameSizes = new Map([
  ['ic07', 128], // 1x 128px 图标帧。
  ['ic08', 256], // 1x 256px 图标帧。
  ['ic09', 512], // 1x 512px 图标帧。
  ['ic10', 1024], // 1x 1024px 图标帧。
  ['ic11', 32], // 2x 16px 图标帧。
  ['ic12', 64], // 2x 32px 图标帧。
  ['ic13', 256], // 2x 128px 图标帧。
  ['ic14', 512], // 2x 256px 图标帧。
]);
/** Tauri 同时生成的旧式 RGB 与 alpha mask chunk，规范化时原样保留。 */
const icnsLegacyFrameTypes = new Set(['il32', 'is32', 'l8mk', 's8mk']);
/** PNG 签名、IHDR 首块及其尺寸字段偏移均以字节计。 */
const pngFields = {
  signatureLength: 8, // PNG 固定签名长度。
  ihdrLengthOffset: 8, // IHDR 数据长度字段偏移。
  ihdrTypeOffset: 12, // IHDR 块类型字段偏移。
  chunkTypeLength: 4, // PNG 块类型长度。
  ihdrDataOffset: 16, // IHDR 图像数据起始偏移。
  dimensionFieldLength: 4, // PNG 宽度和高度字段各占 4 字节。
  ihdrDataLength: 13, // PNG 规范规定 IHDR 数据长度为 13 字节。
  minimumFileLength: 33, // PNG 签名、IHDR 长度、类型、数据及 CRC 的最短长度。
};
/** ICO 中 PNG 载荷必须以标准 8 字节 PNG 签名开头。 */
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 调用仓库锁定的 Tauri CLI 从指定 SVG 或 PNG 生成图标；CLI 非零退出时抛出错误。
 * @param {string} inputPath 输入图稿的绝对路径。
 * @param {string} outputDirectory 生成文件的临时目录。
 * @param {number[]} [pngSizes] 仅生成指定 PNG 边长（1 到 1024）；省略时生成 Tauri 默认平台图标。
 */
function generateWithTauri(inputPath, outputDirectory, pngSizes) {
  // CLI 参数分开传递，避免路径或自定义尺寸被 shell 重新解释。
  const args = ['icon', inputPath, '--output', outputDirectory];
  if (pngSizes) {
    if (
      pngSizes.length === 0 ||
      pngSizes.some(
        (size) =>
          !Number.isInteger(size) ||
          size < icoFields.minDimension ||
          size > macosMasterIconSize,
      )
    ) {
      throw new Error(`自定义 PNG 边长必须是 1 到 ${macosMasterIconSize} 之间的正整数。`);
    }
    args.push('--png', pngSizes.join(','));
  }
  if (!existsSync(tauriCliPath)) {
    throw new Error(`项目内 Tauri CLI 不存在：${tauriCliPath}`);
  }
  execFileSync(
    process.execPath,
    [tauriCliPath, ...args],
    { cwd: projectRoot, stdio: 'inherit' },
  );
}

/**
 * 从唯一 SVG 源写出小尺寸 ICO 临时图稿，整体缩放图标并额外光学放大 app-mark 前景组。
 * @param {string} svgPath 唯一源 SVG 的绝对路径。
 * @param {string} outputPath 临时光学调整 SVG 的绝对路径。
 * @throws {Error} 源图缺少唯一规范 viewBox 或 app-mark 分组时抛出错误。
 */
function writeOpticalSvg(svgPath, outputPath) {
  const source = readFileSync(svgPath, 'utf8');
  // 根视口按画布中心裁去四边各 40 个用户单位，使底板、渐变和前景整体放大。
  const viewBoxMarker = 'viewBox="0 0 512 512"';
  if (source.split(viewBoxMarker).length !== 2) {
    throw new Error(`SVG 必须且只能包含一个规范根 viewBox：${svgPath}`);
  }
  // 只匹配规范 SVG 中的前景组，避免缩放背景底板和其渐变。
  const groupMarker = '<g id="app-mark">';
  if (source.split(groupMarker).length !== 2) {
    throw new Error(`SVG 必须且只能包含一个 app-mark 分组：${svgPath}`);
  }
  const opticalSource = source.replace(viewBoxMarker, `viewBox="${windowsOpticalViewBox}"`);
  // 以 512×512 画布中心为固定缩放原点。
  const opticalTransform =
    `translate(${svgCanvasCenter} ${svgCanvasCenter}) ` +
    `scale(${windowsMarkScale}) ` +
    `translate(-${svgCanvasCenter} -${svgCanvasCenter})`;
  writeFileSync(
    outputPath,
    opticalSource.replace(groupMarker, `<g id="app-mark" transform="${opticalTransform}">`),
  );
}

/**
 * 校验 PNG 签名、IHDR 头及方形边长，返回已验证的图像帧数据。
 * @param {Buffer} png PNG 图像数据。
 * @param {number} [expectedSize] 期望边长；未提供时采用 PNG 自身尺寸。
 * @param {number} [maximumSize=256] 允许的最大边长；ICO 调用保留 256px 上限，ICNS 可用 1024px。
 * @returns {{width: number, height: number, png: Buffer}} 已验证的方形 PNG 帧。
 * @throws {Error} PNG 损坏、不是方形或尺寸与预期不符时抛出错误。
 */
function readPngFrame(png, expectedSize, maximumSize = icoFields.maxDimension) {
  const minimumPngLength = pngFields.minimumFileLength;
  if (
    png.length < minimumPngLength ||
    !png.subarray(0, pngFields.signatureLength).equals(pngSignature) ||
    png.readUInt32BE(pngFields.ihdrLengthOffset) !== pngFields.ihdrDataLength ||
    png.toString(
      'ascii',
      pngFields.ihdrTypeOffset,
      pngFields.ihdrTypeOffset + pngFields.chunkTypeLength,
    ) !== 'IHDR'
  ) {
    throw new Error('生成的图标不是有效 PNG 文件。');
  }

  const width = png.readUInt32BE(pngFields.ihdrDataOffset);
  const height = png.readUInt32BE(pngFields.ihdrDataOffset + pngFields.dimensionFieldLength);
  if (
    width < icoFields.minDimension ||
    width > maximumSize ||
    width !== height ||
    (expectedSize !== undefined && width !== expectedSize)
  ) {
    throw new Error(`PNG 图标尺寸无效：${width}x${height}，期望边长 ${expectedSize ?? '任意'}。`);
  }
  return { width, height, png };
}

/**
 * 解析并校验 Windows ICO 目录及其嵌入 PNG 帧，拒绝越界、重叠或重复尺寸。
 * @param {string} icoPath 待解析的 ICO 绝对路径。
 * @returns {Array<{width: number, height: number, png: Buffer, planes: number, bitCount: number}>} 有效图标帧。
 * @throws {Error} ICO 头、目录项或 PNG 帧格式无效时抛出错误。
 */
function readIcoFrames(icoPath) {
  const ico = readFileSync(icoPath);
  if (
    ico.length < icoHeaderLength ||
    ico.readUInt16LE(icoFields.reservedOffset) !== icoFields.zeroValue ||
    ico.readUInt16LE(icoFields.typeOffset) !== icoFields.iconType
  ) {
    throw new Error(`ICO 文件头无效：${icoPath}`);
  }

  const frameCount = ico.readUInt16LE(icoFields.countOffset);
  const directoryEnd = icoHeaderLength + frameCount * icoDirectoryEntryLength;
  if (frameCount === 0 || directoryEnd > ico.length) {
    throw new Error(`ICO 目录被截断或没有图像帧：${icoPath}`);
  }

  const frames = [];
  const occupiedRanges = [];
  const seenSizes = new Set();
  for (let index = 0; index < frameCount; index += 1) {
    const entryOffset = icoHeaderLength + index * icoDirectoryEntryLength;
    const width = ico[entryOffset + icoFields.widthOffset] || icoFields.maxDimension;
    const height = ico[entryOffset + icoFields.heightOffset] || icoFields.maxDimension;
    const dataLength = ico.readUInt32LE(entryOffset + icoFields.payloadLengthOffset);
    const dataOffset = ico.readUInt32LE(entryOffset + icoFields.payloadOffsetOffset);
    const dataEnd = dataOffset + dataLength;
    if (
      ico[entryOffset + icoFields.reservedEntryOffset] !== icoFields.zeroValue ||
      width !== height ||
      dataLength < pngFields.minimumFileLength ||
      dataOffset < directoryEnd ||
      dataEnd > ico.length ||
      seenSizes.has(width)
    ) {
      throw new Error(`ICO 目录项无效或尺寸重复：${width}x${height} (${icoPath})`);
    }

    const png = ico.subarray(dataOffset, dataEnd);
    const frame = readPngFrame(png, width);
    seenSizes.add(width);
    occupiedRanges.push({ start: dataOffset, end: dataEnd });
    frames.push({
      ...frame,
      planes: ico.readUInt16LE(entryOffset + icoFields.planesOffset),
      bitCount: ico.readUInt16LE(entryOffset + icoFields.bitCountOffset),
    });
  }

  occupiedRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < occupiedRanges.length; index += 1) {
    if (occupiedRanges[index].start < occupiedRanges[index - 1].end) {
      throw new Error(`ICO 图像帧数据相互重叠：${icoPath}`);
    }
  }
  return frames;
}

/**
 * 将校验过的 PNG 帧编码为标准 ICO 目录和连续载荷。
 * @param {Array<{
 *   width: number, height: number, png: Buffer, planes?: number, bitCount?: number
 * }>} frames 待写入的帧。
 * @returns {Buffer} 生成的 ICO 文件字节。
 * @throws {Error} 帧尺寸重复、数据不匹配或 ICO 32 位偏移上限溢出时抛出错误。
 */
function encodeIcoFrames(frames) {
  /** ICO 目录帧数使用 16 位无符号整数表示。 */
  const maxFrameCount = 0xffff;
  /** ICO 图像偏移和载荷长度使用 32 位无符号整数表示。 */
  const maxPayloadOffset = 0xffffffff;
  if (frames.length === 0 || frames.length > maxFrameCount) {
    throw new Error(`ICO 图像帧数量无效：${frames.length}`);
  }

  const frameSizes = new Set();
  for (const frame of frames) {
    readPngFrame(frame.png, frame.width);
    if (frame.height !== frame.width || frameSizes.has(frame.width)) {
      throw new Error(`ICO 帧尺寸无效或重复：${frame.width}x${frame.height}`);
    }
    frameSizes.add(frame.width);
  }

  const directoryLength = frames.length * icoDirectoryEntryLength;
  const totalLength =
    icoHeaderLength +
    directoryLength +
    frames.reduce((sum, frame) => sum + frame.png.length, 0);
  if (totalLength > maxPayloadOffset) {
    throw new Error(`ICO 文件超出 32 位偏移范围：${totalLength}`);
  }

  const directory = Buffer.alloc(icoHeaderLength + directoryLength);
  directory.writeUInt16LE(icoFields.iconType, icoFields.typeOffset);
  directory.writeUInt16LE(frames.length, icoFields.countOffset);
  let payloadOffset = directory.length;
  frames.forEach((frame, index) => {
    const entryOffset = icoHeaderLength + index * icoDirectoryEntryLength;
    directory[entryOffset + icoFields.widthOffset] =
      frame.width === icoFields.maxDimension ? icoFields.zeroValue : frame.width;
    directory[entryOffset + icoFields.heightOffset] =
      frame.height === icoFields.maxDimension ? icoFields.zeroValue : frame.height;
    directory.writeUInt16LE(frame.planes ?? icoFields.defaultPlanes, entryOffset + icoFields.planesOffset);
    directory.writeUInt16LE(
      frame.bitCount ?? icoFields.defaultBitCount,
      entryOffset + icoFields.bitCountOffset,
    );
    directory.writeUInt32LE(frame.png.length, entryOffset + icoFields.payloadLengthOffset);
    directory.writeUInt32LE(payloadOffset, entryOffset + icoFields.payloadOffsetOffset);
    payloadOffset += frame.png.length;
  });
  return Buffer.concat([directory, ...frames.map((frame) => frame.png)]);
}

/**
 * 保留规范 ICO 的大尺寸帧，替换小帧并将 Tauri 使用的 48px 默认窗口帧置于首位。
 * @param {string} canonicalIcoPath 由未变换规范 SVG 生成的 ICO 路径。
 * @param {string} opticalPngDirectory 光学 SVG 的自定义 PNG 输出目录。
 * @param {string} outputIcoPath 合并后 ICO 的临时输出路径。
 * @returns {void}
 * @throws {Error} 缺少所需帧、PNG 无效或合并结果未保留规范 256px 帧时抛出错误。
 */
function createWindowsOpticalIco(canonicalIcoPath, opticalPngDirectory, outputIcoPath) {
  const canonicalFrames = readIcoFrames(canonicalIcoPath);
  const canonicalBySize = new Map(canonicalFrames.map((frame) => [frame.width, frame]));
  const opticalFrames = new Map();
  for (const size of windowsOpticalIconSizes) {
    const pngPath = join(opticalPngDirectory, `${size}x${size}.png`);
    opticalFrames.set(size, readPngFrame(readFileSync(pngPath), size));
  }

  if (!canonicalBySize.has(256)) {
    throw new Error(`规范 ICO 缺少 256px 原图帧：${canonicalIcoPath}`);
  }
  const outputFrames = canonicalFrames.map((frame) => opticalFrames.get(frame.width) ?? frame);
  for (const [size, frame] of opticalFrames) {
    if (!canonicalBySize.has(size)) {
      outputFrames.push(frame);
    }
  }
  outputFrames.sort((left, right) => left.width - right.width);
  const defaultWindowFrameIndex = outputFrames.findIndex(
    (frame) => frame.width === windowsDefaultIconSize,
  );
  if (defaultWindowFrameIndex < 0) {
    throw new Error(`规范 ICO 缺少 Tauri 默认窗口图标帧：${windowsDefaultIconSize}px`);
  }
  outputFrames.unshift(...outputFrames.splice(defaultWindowFrameIndex, 1));

  const canonicalLargeFrame = canonicalBySize.get(256);
  const outputLargeFrame = outputFrames.find((frame) => frame.width === 256);
  if (!outputLargeFrame?.png.equals(canonicalLargeFrame.png)) {
    throw new Error('合并 ICO 未保留规范 SVG 生成的 256px PNG 帧。');
  }
  writeFileSync(outputIcoPath, encodeIcoFrames(outputFrames));
}

/**
 * 校验并按 ICNS chunk 类型排序 macOS 图标，保留旧式帧并消除 Tauri CLI 的随机排列。
 * @param {string} icnsPath 待规范化的 ICNS 文件路径，会原位覆盖。
 * @throws {Error} ICNS 头、chunk 类型/长度、PNG 帧尺寸或必需帧缺失时抛出错误。
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
  // 分别跟踪现代 PNG 帧与旧式兼容帧，以拒绝缺帧或不支持的 chunk。
  const pngFrameTypes = new Set();
  const legacyFrameTypes = new Set();
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
    const chunkBody = icnsData.subarray(offset + chunkHeaderLength, offset + chunkLength);
    if (icnsPngFrameSizes.has(chunkType)) {
      // PNG 帧的 chunk 类型必须与 IHDR 中的宽高一致。
      readPngFrame(
        chunkBody,
        icnsPngFrameSizes.get(chunkType),
        macosMasterIconSize,
      );
      pngFrameTypes.add(chunkType);
    } else if (icnsLegacyFrameTypes.has(chunkType) && chunkBody.length > 0) {
      legacyFrameTypes.add(chunkType);
    } else {
      throw new Error(`ICNS chunk 类型未知或 legacy 数据为空：${chunkType}`);
    }
    chunkTypes.add(chunkType);
    chunks.push({
      type: chunkType,
      data: icnsData.subarray(offset, offset + chunkLength),
    });
    offset += chunkLength;
  }

  const missingPngFrameTypes = [...icnsPngFrameSizes.keys()].filter(
    (chunkType) => !pngFrameTypes.has(chunkType),
  );
  const missingLegacyFrameTypes = [...icnsLegacyFrameTypes].filter(
    (chunkType) => !legacyFrameTypes.has(chunkType),
  );
  if (missingPngFrameTypes.length > 0 || missingLegacyFrameTypes.length > 0) {
    throw new Error(
      `ICNS 缺少图标帧：${[...missingPngFrameTypes, ...missingLegacyFrameTypes].join(', ')}`,
    );
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
 * 生成并校验平台图标后事务式替换文件；macOS ICNS 从 1024px PNG 重采样，Windows ICO 使用光学帧。
 * @param {boolean} [windowsOnly=false] 为 true 时只替换 Windows 使用的 PNG 和 ICO 文件。
 * @throws {Error} 源文件、生成文件或目标文件缺失，或 Tauri CLI 失败时抛出错误。
 */
function generateIcons(windowsOnly = false) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'rivet-icons-'));
  try {
    const outputDirectory = join(temporaryDirectory, 'generated');
    const opticalDirectory = join(temporaryDirectory, 'optical-png');
    const opticalSvgPath = join(temporaryDirectory, 'app-icon-optical.svg');
    const opticalIcoPath = join(temporaryDirectory, 'icon-optical.ico');
    /** Tauri 以 1024px SVG 渲染得到的临时母版目录。 */
    const macosMasterDirectory = join(temporaryDirectory, 'macos-master');
    /** Tauri 从母版派生 ICNS 的临时输出目录。 */
    const macosDerivedDirectory = join(temporaryDirectory, 'macos-derived');
    /** 由唯一 SVG 渲染得到的 1024px PNG 母版路径。 */
    const macosMasterPngPath = join(
      macosMasterDirectory,
      `${macosMasterIconSize}x${macosMasterIconSize}.png`,
    );
    generateWithTauri(sourceSvgPath, outputDirectory);
    if (!windowsOnly) {
      // 先从同一 SVG 栅格化 1024px 母版，再由 Tauri CLI 统一缩小 ICNS 各帧。
      generateWithTauri(sourceSvgPath, macosMasterDirectory, [macosMasterIconSize]);
      generateWithTauri(macosMasterPngPath, macosDerivedDirectory);
      normalizeIcns(join(macosDerivedDirectory, 'icon.icns'));
    }
    writeOpticalSvg(sourceSvgPath, opticalSvgPath);
    generateWithTauri(opticalSvgPath, opticalDirectory, windowsOpticalIconSizes);
    createWindowsOpticalIco(join(outputDirectory, 'icon.ico'), opticalDirectory, opticalIcoPath);

    // 先验证全部源产物和目标文件，再复制，避免生成失败时留下半套图标。
    const outputNames = windowsOnly ? windowsIconNames : desktopIconNames;
    const copyPlan = outputNames.map((fileName) => ({
      sourcePath:
        fileName === 'icon.ico'
          ? opticalIcoPath
          : fileName === 'icon.icns'
            ? join(macosDerivedDirectory, fileName)
            : join(outputDirectory, fileName),
      targetPath: join(iconDirectory, fileName),
    }));
    for (const { sourcePath, targetPath } of copyPlan) {
      if (!existsSync(sourcePath) || !existsSync(targetPath)) {
        throw new Error(`图标源产物或现有目标文件缺失：${sourcePath} -> ${targetPath}`);
      }
    }
    replaceIcons(copyPlan);
    // 日志标注本次替换的平台范围，便于区分完整生成和 Windows-only 生成。
    const platformDescription = windowsOnly ? 'Windows' : '桌面平台';
    console.log(`已从 src/assets/svg/app-icon.svg 生成 ${copyPlan.length} 个${platformDescription}图标。`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

try {
  /** 本次生成模式参数；仅支持通过 --windows-only 限定为 Windows 资产。 */
  const modeArguments = process.argv.slice(2);
  if (modeArguments.length > 1 || modeArguments.some((argument) => argument !== '--windows-only')) {
    throw new Error('用法：node scripts/generate-icons.mjs [--windows-only]');
  }
  generateIcons(modeArguments.includes('--windows-only'));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
