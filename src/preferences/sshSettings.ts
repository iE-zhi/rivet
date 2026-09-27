/** X11 Server 地址在浏览器存储中的稳定键。 */
export const X11_SERVER_ADDRESS_STORAGE_KEY = "rivet.ssh.x11ServerAddress";
/** Linux xauth 可执行文件路径，仅保存在本机。 */
export const LINUX_XAUTH_PATH_STORAGE_KEY = "rivet.ssh.linuxXauthPath";
/** macOS xauth 可执行文件路径，仅保存在本机。 */
export const MACOS_XAUTH_PATH_STORAGE_KEY = "rivet.ssh.macosXauthPath";

/** 未配置时默认连接本机 display 0 的 TCP 端口。 */
export const DEFAULT_X11_SERVER_ADDRESS = "127.0.0.1:6000";
/** Linux 常见 xauth 安装路径。 */
export const DEFAULT_LINUX_XAUTH_PATH = "/usr/bin/xauth";
/** XQuartz 提供的 macOS xauth 安装路径。 */
export const DEFAULT_MACOS_XAUTH_PATH = "/opt/X11/bin/xauth";

/** 限制异常存储值和无界输入占用。 */
export const MAX_X11_SERVER_ADDRESS_LENGTH = 255;
/** 本机 xauth 路径最大长度。 */
export const MAX_XAUTH_PATH_LENGTH = 4_096;

/** 校验严格的点分十进制 IPv4 地址。 */
function isValidIpv4(host: string): boolean {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** 校验普通 DNS 主机名或 localhost。 */
function isValidHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (/^[0-9.]+$/.test(host)) return isValidIpv4(host);
  return host.split(".").every((label) =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
  );
}

/** 使用标准 URL 解析器校验方括号内的 IPv6 地址。 */
function isValidIpv6(host: string): boolean {
  try {
    const parsed = new URL(`http://[${host}]/`);
    return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]");
  } catch {
    return false;
  }
}

/**
 * 校验 X11 Server 地址，支持 hostname:port、IPv4:port 与 [IPv6]:port。
 * @param value 用户输入或持久化的地址。
 * @returns 地址结构、主机和 1~65535 端口均有效时为 true。
 */
export function isValidX11ServerAddress(value: string): boolean {
  const address = value.trim();
  if (address.length === 0 || address.length > MAX_X11_SERVER_ADDRESS_LENGTH || /\s/.test(address)) return false;

  let host = "";
  let portText = "";
  if (address.startsWith("[")) {
    const closingBracket = address.indexOf("]");
    if (closingBracket <= 1 || address[closingBracket + 1] !== ":") return false;
    host = address.slice(1, closingBracket);
    portText = address.slice(closingBracket + 2);
    if (!isValidIpv6(host)) return false;
  } else {
    const separator = address.lastIndexOf(":");
    if (separator <= 0 || separator !== address.indexOf(":")) return false;
    host = address.slice(0, separator);
    portText = address.slice(separator + 1);
    if (!isValidHostname(host)) return false;
  }

  if (!/^\d{1,5}$/.test(portText)) return false;
  const port = Number(portText);
  return port >= 1 && port <= 65535;
}

/** 校验本机 xauth 可执行文件的绝对 Unix 路径。 */
export function isValidXauthPath(value: string): boolean {
  const path = value.trim();
  return path.length > 0
    && path.length <= MAX_XAUTH_PATH_LENGTH
    && path.startsWith("/")
    && !Array.from(path).some((character) => character.charCodeAt(0) < 0x20 || character === "");
}

/** 从本机持久化文本恢复 xauth 路径；异常值回退到对应平台默认值。 */
export function deserializeXauthPath(value: string | null, fallback: string): string {
  return value !== null && isValidXauthPath(value) ? value.trim() : fallback;
}

/**
 * 从持久化文本恢复 X11 Server 地址。
 * @param value localStorage 中的原始值。
 * @returns 长度有效的已保存地址；缺失或异常值回退到本机默认地址。
 */
export function deserializeX11ServerAddress(value: string | null): string {
  return value !== null && isValidX11ServerAddress(value)
    ? value.trim()
    : DEFAULT_X11_SERVER_ADDRESS;
}
