//! 串口配置边界：定义前端输入类型并校验驱动调用前的帧参数。

use serde::Deserialize;

/// 跨前后端传输的串口配置；波特率必须大于零，帧参数限定为硬件支持值。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortConfig {
    /// 操作系统串口路径，例如 Windows 的 COM3 或 Unix 的 /dev/ttyUSB0。
    pub path: String,
    /// 每秒传输的符号数，必须大于零。
    pub baud_rate: u32,
    /// 数据位数，仅接受 5、6、7 或 8。
    pub data_bits: u8,
    /// 停止位数，仅接受 1 或 2。
    pub stop_bits: u8,
    /// 校验模式：none、even 或 odd。
    pub parity: String,
    /// 流控模式：none（无）、hardware（RTS/CTS）或 software（XON/XOFF）。
    pub flow_control: String,
}

/// 拒绝空路径、零波特率、无效帧格式及不支持的流控值；流控仅接受 none、hardware 或 software。
pub fn validate_config(config: &PortConfig) -> Result<(), String> {
    if config.path.trim().is_empty() {
        return Err("请选择串口设备".to_string());
    }
    if config.baud_rate == 0 {
        return Err("波特率必须大于零".to_string());
    }
    if !matches!(config.data_bits, 5..=8) {
        return Err("数据位仅支持 5、6、7 或 8".to_string());
    }
    if !matches!(config.stop_bits, 1 | 2) {
        return Err("停止位仅支持 1 或 2".to_string());
    }
    if !matches!(config.parity.as_str(), "none" | "even" | "odd") {
        return Err("校验位参数无效".to_string());
    }
    if !matches!(
        config.flow_control.as_str(),
        "none" | "hardware" | "software"
    ) {
        return Err("流控参数无效".to_string());
    }
    Ok(())
}
