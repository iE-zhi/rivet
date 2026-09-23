# 第三方许可

桌面分发中包含以下锁定运行时依赖：

- MPL-2.0：`option-ext@0.2.0`；随安装包附带 `licenses/MPL-2.0.txt`。对应源码：[crates.io option-ext 0.2.0](https://crates.io/crates/option-ext/0.2.0)。
- Unicode-3.0：`icu_collections@2.3.0`、`icu_locale_core@2.3.0`、`icu_normalizer@2.3.0`、`icu_normalizer_data@2.3.0`、`icu_properties@2.3.0`、`icu_properties_data@2.3.0`、`icu_provider@2.3.1`、`litemap@0.8.3`、`potential_utf@0.1.6`、`tinystr@0.8.4`、`writeable@0.6.4`、`yoke@0.8.3`、`yoke-derive@0.8.3`、`zerofrom@0.1.8`、`zerofrom-derive@0.1.8`、`zerotrie@0.2.5`、`zerovec@0.11.8`、`zerovec-derive@0.11.6`；随安装包附带 `licenses/Unicode-3.0.txt`。

其余对应源码版本由 `src-tauri/Cargo.lock` 固定；从 Rivet 源码包获取 Cargo.lock 后运行 `cargo fetch --locked --manifest-path src-tauri/Cargo.toml`，源码位于 Cargo registry 缓存中。Unicode 许可全文见随包文件及 [Unicode 官方文本](https://www.unicode.org/license.txt)。
