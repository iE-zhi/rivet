# Rivet 项目规则

## 技术栈

- 使用 Tauri 2 + React + TypeScript + Rust。
- Rust 负责串口、SSH、文件系统、格式转换等底层与业务能力；React/TypeScript 负责界面层。
- 项目按可扩展工具箱设计，当前首先实现串口工具，后续可扩展 SSH、格式转换等模块。

## 跨平台 UI

- 目标平台为 Windows、Linux、macOS，主界面必须优先保证三端视觉与交互一致。
- 所有长期可见的主界面组件均使用 Web UI 自绘，包括按钮、输入框、下拉框、Tab、菜单、弹窗、右键菜单、滚动条、主题、间距、圆角等。
- 不依赖系统默认原生控件样式；必须统一 reset 和项目样式。
- 窗口标题栏如需保证一致性，使用 Tauri 自定义标题栏实现。
- 系统原生能力仅用于确有必要的底层能力，例如文件/目录选择、系统托盘、剪贴板、窗口管理、串口、SSH、文件系统等；不得因为实现方便而把主界面改成系统原生 UI。

## 视觉与配色

- 普通业务页面采用扁平布局、分割线和面板分区，不使用卡片堆叠风格，不使用背景蓝色渐变；设置页面允许采用 Codex 风格的轻量分组卡片布局。
- 蓝色只作为主色、交互强调色或状态色，不得用于给深色背景染蓝；深色主题背景必须保持中性偏黑/灰。
- 浅色主题：`bg #FFFFFF`、`surface #F8FAFC`、`surface-2 #F1F5F9`、`border #E2E8F0`、`muted #94A3B8`、`subtle #475569`、`text #0F172A`。
- 深色主题：`bg #09090A`、`surface #111113`、`surface-2 #18181B`、`border #2A2A2E`、`muted #6B6B73`、`subtle #A1A1AA`、`text #E7E7EA`。
- 品牌色固定为：`primary #2563EB`、`primary-light #3B82F6`、`primary-deep #1D4ED8`、`accent #22C5C7`、`secondary #8B5CF6`。
- 语义色固定为：`success #10B981`、`danger #EF4444`、`warning #F59E0B`、`info #3B82F6`。
- 终端区域必须跟随深浅主题，禁止始终使用深色背景。
- 浅色终端：`background #F8FAFC`、`text #0F172A`、`info #2563EB`、`rx #059669`、`tx #D97706`。
- 深色终端：`background #050506`、`text #E7E7EA`、`info #60A5FA`、`rx #34D399`、`tx #FBBF24`。

## 组件实现与预览

- 正式组件代码是唯一实现与唯一事实来源，统一放在 `src/components/ui/`，由 Tauri 2 的 React 页面直接 import 和复用。
- 禁止为参考页面复制一套独立 HTML/CSS 组件实现；参考页面必须渲染正式组件本身，确保预览效果与实际应用完全一致。
- `design/components/` 仅作为组件预览入口目录，不作为运行时依赖，也不保存另一套组件样式实现。
- 每个基础组件保留一个独立 HTML 预览入口；该 HTML 只负责加载 Vite/React 预览入口并挂载对应的 `src/components/ui/` 正式组件。
- 当前组件包括：Button、Input、SearchInput、Textarea、Select、PopupMenu、Checkbox、Radio、Switch、Slider、Terminal、VerticalScrollbar；正式实现分别放入 `src/components/ui/`。
- 每个组件应提供统一的浅色、深色以及 Hover、Active、Focus、Disabled 等状态；预览页调用同一组件展示这些状态。
- 新增通用组件时，先在 `src/components/ui/` 实现正式组件，再增加对应预览入口；禁止先做一套孤立 HTML 再人工照抄到正式组件。
- 修改组件样式时只修改正式组件及共享 design token；预览页面应自动反映变化，不允许双份维护。
- 普通页面布局仍采用扁平分区与分割线，不因组件自身有轻微圆角而演变为大圆角卡片堆叠；设置页面例外：左侧使用 `SVG 图标 + 设置栏目` 导航，右侧按设置组纵向排列，组标题放在卡片外，具体设置项放在轻量卡片内。
- 所有图标必须使用 SVG 实现；禁止使用 Emoji、Unicode 符号或系统字体图标充当界面图标。SVG 图标必须跟随项目统一尺寸、描边、颜色和深浅主题规范。
- 界面图标使用 SVG；应用程序安装/启动图标唯一源文件为 `design/app-icon.svg`，Windows/macOS/Linux 所需 PNG、ICO、ICNS 均由该源文件生成，禁止单独维护不同版本。
- 所有正式组件禁止依赖浏览器或操作系统默认样式；图标、Focus、Hover、Active、Disabled 等状态均由项目统一实现。

## 依赖与许可

- 项目必须以商业闭源可安全使用、尽量降低第三方版权和开源许可风险为前提选择依赖。
- 第三方依赖优先仅接受 MIT、Apache-2.0、BSD-2-Clause、BSD-3-Clause、ISC、Zlib 等宽松许可证。
- 默认禁止引入 GPL、AGPL、LGPL 或其他可能对发布、链接、源码开放产生额外义务的依赖；确有必要时必须先明确说明许可影响并获得确认。
- 新增 Rust、npm 或其他第三方依赖前必须检查许可证，不得只依据包名或经验判断。
- 项目应配置自动化许可证检查，防止后续依赖间接引入不符合要求的许可证。
