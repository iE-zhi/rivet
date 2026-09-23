//! 串口配置边界的独立集成测试，不将测试代码编入生产模块。

#[path = "../src/config.rs"]
mod config;

#[cfg(test)]
mod tests {
    use super::config::{validate_config, PortConfig};

    /// 构造边界内配置，供参数校验场景共用。
    fn valid_config() -> PortConfig {
        PortConfig {
            path: "COM1".into(),
            baud_rate: 115_200,
            data_bits: 8,
            stop_bits: 1,
            parity: "none".into(),
            flow_control: "none".into(),
        }
    }

    /// 验证常见 8N1 与完整帧参数均被接受。
    #[test]
    fn accepts_supported_serial_frames() {
        assert!(validate_config(&valid_config()).is_ok());
        let mut config = valid_config();
        config.data_bits = 7;
        config.stop_bits = 2;
        config.parity = "even".into();
        config.flow_control = "hardware".into();
        assert!(validate_config(&config).is_ok());
    }

    /// 验证空路径、零波特率、非法帧长度和未支持流控均被拒绝。
    #[test]
    fn rejects_invalid_serial_configuration() {
        let mut config = valid_config();
        config.path.clear();
        assert!(validate_config(&config).is_err());
        let mut config = valid_config();
        config.baud_rate = 0;
        assert!(validate_config(&config).is_err());
        let mut config = valid_config();
        config.data_bits = 9;
        assert!(validate_config(&config).is_err());
        let mut config = valid_config();
        config.flow_control = "software".into();
        assert!(validate_config(&config).is_err());
    }
}
