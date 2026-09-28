/** Windows 本地终端默认 PowerShell 选择，仅保存在当前设备。 */
export const WINDOWS_POWERSHELL_MODE_STORAGE_KEY = "rivet.terminal.windowsPowerShellMode";

/** Windows 本地终端 PowerShell 选择策略。 */
export type WindowsPowerShellMode = "auto" | "ps7" | "ps5";

/** 校验未知值是否为支持的 PowerShell 选择策略。 */
export function isWindowsPowerShellMode(value: unknown): value is WindowsPowerShellMode {
  return value === "auto" || value === "ps7" || value === "ps5";
}

/** 判断当前 WebView 是否运行在 Windows。 */
export function isWindowsPlatform(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

/** 读取当前设备的 PowerShell 选择；缺失或损坏时使用自动切换。 */
export function readWindowsPowerShellMode(): WindowsPowerShellMode {
  try {
    const value = window.localStorage.getItem(WINDOWS_POWERSHELL_MODE_STORAGE_KEY);
    return isWindowsPowerShellMode(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

/** 保存当前设备的 PowerShell 选择，不进入跨设备同步。 */
export function setWindowsPowerShellMode(mode: WindowsPowerShellMode): boolean {
  try {
    window.localStorage.setItem(WINDOWS_POWERSHELL_MODE_STORAGE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}
