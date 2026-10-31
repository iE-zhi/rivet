# 第三方许可

桌面分发中包含以下锁定运行时依赖：

- MIT：`mermaid@12.2.0`，附 `licenses/MIT-Mermaid.txt`；[源码](https://github.com/mermaid-js/mermaid)。
- Apache-2.0：`dompurify@3.4.17`，附 `licenses/Apache-2.0-DOMPurify.txt`；[源码](https://github.com/cure53/DOMPurify)。
- MIT：`khroma@2.1.0`，附 `licenses/MIT-Khroma.txt`；以包内许可文本为准。
- EPL-2.0：`elkjs@0.9.3`，附 `licenses/EPL-2.0-elkjs.txt`；[对应版本源码](https://github.com/kieler/elkjs/tree/v0.9.3)，库未修改。
- Unlicense：`robust-predicates@3.0.3`，附 `licenses/Unlicense-robust-predicates.txt`；[源码](https://github.com/mourner/robust-predicates)。
- MIT：`@milkdown/crepe@7.23.0`、`@milkdown/kit@7.23.0`；随安装包附带 `licenses/MIT-Milkdown.txt`。对应源码：[Milkdown/milkdown](https://github.com/Milkdown/milkdown)。
- MIT：`@codemirror/theme-one-dark@6.1.3`；随安装包附带 `licenses/MIT-CodeMirror.txt`。对应源码：[codemirror/theme-one-dark](https://github.com/codemirror/theme-one-dark)。
- MIT：`@floating-ui/dom@1.8.0`；随安装包附带 `licenses/MIT-Floating-UI.txt`。对应源码：[floating-ui/floating-ui](https://github.com/floating-ui/floating-ui)。
- MIT：`remark-highlight-mark@1.4.0` 及新增间接依赖，许可文本见 `licenses/MIT-Markdown-Highlight.txt`；[源码](https://github.com/shlroland/remark-highlight-mark)。
- GPL-3.0：Hao 代码块顶栏样式及复制、折叠图标，已适配 Milkdown，附 `licenses/GPL-3.0-Hao.txt`；[样式源码](https://github.com/chengzhongxue/halo-theme-hao/blob/main/templates/assets/libs/prism/code.css)、[图标源码](https://github.com/chengzhongxue/halo-theme-hao/blob/main/templates/assets/icon/iconfont.svg)。

- MIT：`vnc-rs@0.6.0`；随安装包附带 `licenses/MIT-vnc-rs.txt`。对应源码：[HsuJv/vnc-rs](https://github.com/HsuJv/vnc-rs)。
- Unlicense：`async_io_stream@0.3.3`（VNC 间接依赖）。对应源码：[crates.io async_io_stream 0.3.3](https://crates.io/crates/async_io_stream/0.3.3)。

- MPL-2.0：`option-ext@0.2.0`；随安装包附带 `licenses/MPL-2.0.txt`。对应源码：[crates.io option-ext 0.2.0](https://crates.io/crates/option-ext/0.2.0)。
- MIT：`lxgw-wenkai-webfont@1.7.0` 的 webfont 样式代码；随安装包附带 `licenses/MIT-LXGW-Webfont.txt`。对应源码：[chawyehsu/lxgw-wenkai-webfont](https://github.com/chawyehsu/lxgw-wenkai-webfont)。
- SIL OFL-1.1：LXGW WenKai 字体（`lxgw-wenkai-webfont@1.7.0`）；随安装包附带 `licenses/OFL-1.1-LXGW.txt`。对应源码：[lxgw/LxgwWenKai](https://github.com/lxgw/LxgwWenKai)。
- SIL OFL-1.1：JetBrains Mono 字体（`@fontsource-variable/jetbrains-mono@5.3.0`）；随安装包附带 `licenses/OFL-1.1-JetBrains.txt`。对应源码：[JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono)。
- Unicode-3.0：`icu_collections@2.3.0`、`icu_locale_core@2.3.0`、`icu_normalizer@2.3.0`、`icu_normalizer_data@2.3.0`、`icu_properties@2.3.0`、`icu_properties_data@2.3.0`、`icu_provider@2.3.1`、`litemap@0.8.3`、`potential_utf@0.1.6`、`tinystr@0.8.4`、`writeable@0.6.4`、`yoke@0.8.3`、`yoke-derive@0.8.3`、`zerofrom@0.1.8`、`zerofrom-derive@0.1.8`、`zerotrie@0.2.5`、`zerovec@0.11.8`、`zerovec-derive@0.11.6`；随安装包附带 `licenses/Unicode-3.0.txt`。

其余对应源码版本由 `src-tauri/Cargo.lock` 固定；从 Rivet 源码包获取 Cargo.lock 后运行 `cargo fetch --locked --manifest-path src-tauri/Cargo.toml`，源码位于 Cargo registry 缓存中。Unicode 许可全文见随包文件及 [Unicode 官方文本](https://www.unicode.org/license.txt)。
