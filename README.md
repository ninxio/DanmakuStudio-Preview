# Danmaku Timeline Studio

弹幕时间轴工作台是一个面向 Bilibili XML 弹幕文件的可视化时间轴编辑器 Demo。它把多个分 P XML 作为可移动片段放入时间轴，并通过全局偏移、局部调整和删减标记把弹幕重新同步到目标视频版本。

## 当前能力

- 导入一个或多个本地 Bilibili XML 弹幕文件。
- 将 XML 资源添加到时间轴，支持按顺序自动排列。
- Canvas 2D 时间轴：播放头、缩放、横向滚动、片段、删减标记、密度热力图、弹幕事件。
- 非破坏性编辑：移动片段、移动弹幕、禁用弹幕、全局偏移、删减映射。
- 保存和打开 `.danmaku-project.json` 项目文件。
- 导出合并后的 Bilibili XML，并在导出前重新解析验证。
- HTML Video 预览和基础弹幕叠加。
- 撤销、重做和常用快捷键。
- Tauri 2 桌面壳配置。

## 安装与运行

```bash
pnpm install
pnpm dev
pnpm build
pnpm test
pnpm test:e2e
pnpm tauri dev
```

如果本机尚未安装 pnpm，可先运行：

```bash
corepack enable
corepack prepare pnpm@9.15.4 --activate
```

`pnpm tauri dev` 还需要 Rust 和 Tauri 平台依赖。当前环境如果缺少 Rust，Web Demo 仍可通过 `pnpm dev` 完整运行。

## 视频格式限制

当前 `HtmlVideoMediaAdapter` 只可靠支持浏览器原生可播放的 MP4 和 WebM。`NativeMpvMediaAdapter` 已保留接口占位，但本阶段没有声明或伪造 MKV 支持。

## 项目文件策略

`.danmaku-project.json` 保存项目 schema、媒体引用、XML 资源元数据、解析后的弹幕数据、片段、删减标记、同步锚点、禁用弹幕、单条时间调整、时间轴视图和预览设置。视频内容不会嵌入项目文件。

首版选择把解析后的 XML 数据嵌入项目文件，优点是重新打开项目不依赖原 XML 路径；缺点是大项目文件体积会增加。后续可增加“外部引用 + 缺失文件重连”模式。

## 常用操作

- 顶部工具栏：新建、打开、保存、导入视频、导入 XML、导出 XML、撤销、重做、播放暂停、缩放和设置。
- 左侧资源面板：查看媒体、弹幕文件和项目统计。
- 右侧检查器：编辑当前弹幕、片段或删减标记。
- 底部时间轴：点击或拖动播放头，滚轮横向滚动，Ctrl/Command + 滚轮缩放，拖动片段或弹幕。

## 快捷键

- `Space`：播放或暂停。
- `Ctrl/Command + Z`：撤销。
- `Ctrl/Command + Shift + Z`：重做。
- `Delete`：禁用选择项。
- `ArrowLeft` / `ArrowRight`：微调 10ms。
- `Shift + ArrowLeft` / `Shift + ArrowRight`：微调 100ms。
- `M`：在播放头添加删减标记。
- `F`：缩放到全部内容。
- `+` / `-`：缩放时间轴。

## 已知限制

- 桌面模式依赖本机 Rust/Tauri 构建环境。
- 当前没有接入 mpv，因此不承诺 MKV、外挂字幕高级渲染或硬解能力。
- 智能对齐当前只有手动 proposal 导入导出和应用，不包含大型机器学习模型。
- ASS 导出仅保留扩展接口，不属于本阶段强制能力。

## 后续路线

- 接入 mpv sidecar，提供更完整的容器和编码支持。
- 接入 Emby 时仅处理用户配置且有权限访问的本地/私有媒体库，不爬取私有接口。
- 实现音频指纹、静音段、镜头切换序列、感知哈希、字幕时间匹配和动态时间规整的多阶段智能对齐。
