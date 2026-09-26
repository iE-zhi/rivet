# Rivet

Rivet 是一个面向开发、调试与设备连接场景的跨平台桌面工具，基于 **Tauri 2 + React + TypeScript + Rust** 开发，目标平台为 Windows、Linux 和 macOS。

项目地址：<https://gitee.com/boo0ood/rivet>

## 功能

- 串口：参数配置、收发、日志、快捷命令。
- 终端：本地终端、SSH、SFTP、X11 转发、标签页与分屏、终端快捷命令。
- 设置：语言、主题、字体、串口默认参数、SSH/X11 配置。
- 同步与备份：支持 GitHub、Gitee、GitLab 配置同步，以及本地导入/导出备份。

## 开发环境

需要预先安装：

- Node.js
- pnpm 11
- Rust 工具链
- Tauri 2 对应平台的系统依赖

安装项目依赖：

```bash
pnpm install
```

## 编译

前端编译检查：

```bash
pnpm build
```

Rust 后端检查：

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

## 启动

启动 Tauri 开发环境：

```bash
pnpm tauri dev
```

仅启动前端开发服务器：

```bash
pnpm dev
```

## 打包

生成当前平台的安装包：

```bash
pnpm tauri build
```

Windows 构建产物默认位于：

```text
src-tauri/target/release/bundle/msi/
src-tauri/target/release/bundle/nsis/
```

## 许可证检查

项目提供依赖许可证检查脚本：

```bash
pnpm license:check
```

第三方许可证及随包许可文件说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 致谢

Rivet 的实现使用并受益于以下开源项目：

- [Tauri](https://tauri.app/) — 跨平台桌面应用框架。
- [React](https://react.dev/) — 前端界面框架。
- [xterm.js](https://xtermjs.org/) — 终端渲染组件。
- [russh](https://github.com/Eugeny/russh) / [russh-sftp](https://github.com/AspectUnk/russh-sftp) — SSH 与 SFTP 支持。
- [serial2](https://docs.rs/serial2/) — 串口通信支持。
- [Tokio](https://tokio.rs/) — Rust 异步运行时。
- [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) — 等宽字体。
- [LXGW WenKai](https://github.com/lxgw/LxgwWenKai) / [lxgw-wenkai-webfont](https://github.com/chawyehsu/lxgw-wenkai-webfont) — 中文界面字体。

同时感谢项目使用的 serde、reqwest、ring、keyring、portable-pty、sysinfo 等开源项目及其维护者。
