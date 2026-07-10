# Danmaku Timeline Studio

弹幕时间轴工作台是一个面向 Bilibili XML 弹幕文件的可视化时间轴编辑器 Demo。它把多个分 P XML 作为可移动片段放入时间轴，并通过全局偏移、局部调整和删减标记把弹幕重新同步到目标视频版本。

## 当前能力

- 导入一个或多个本地 Bilibili XML 弹幕文件。
- 将 XML 资源添加到时间轴，支持按顺序自动排列。
- Canvas 2D 时间轴：播放头、缩放、横向滚动、片段、补偿点、同步锚点、对齐候选、疑似删减文本候选、密度热力图和弹幕事件。
- 非破坏性编辑：移动片段、移动弹幕、禁用弹幕、全局偏移、补偿点映射、同步锚点和单条时间调整。
- 删减补偿工作流：手动补偿点管理、疑似删减弹幕文本扫描、锚点校准推断补偿、时间轴影响区预览、导出前补偿明细和可下载补偿报告。
- 本地音频对齐实验室：在 Tauri 桌面端调用用户本机 FFmpeg 抽取音频特征，生成 `AlignmentProposal`，支持后台进度、取消、任务日志、调参、音频候选边界细化和不确定区间展示、导入/导出提案、应用前复核提示、异常提案应用阻断、导出复核报告和一键应用。
- Emby 时长辅助：通过设置中心保存非敏感连接项，桌面端优先写入 Tauri 应用配置目录，网页模式使用 localStorage fallback；资源栏搜索用户授权的 Emby 媒体条目并导入真实集时长规则，本次会话密码只保存在内存。
- 设置中心：支持保存、恢复默认、清除本地设置，以及导出/导入不含密码或 token 的版本化应用设置备份。
- 项目信息页：提供项目健康摘要，提示重复 ID、缺失资源引用、空片段、媒体重连、导入警告、低置信锚点和失效编辑引用等保存/重开/导出前风险，并可一键清理指向不存在弹幕的失效禁用/微调引用。
- 保存和打开 `.danmaku-project.json` 项目文件。
- 导出合并后的 Bilibili XML，并在导出前重新解析验证；多分集导出会打包为 ZIP。
- HTML Video 预览和基础弹幕叠加。
- 撤销、重做和常用快捷键。
- Tauri 2 桌面壳、原生路径选择器、Windows release 打包和 NSIS 安装包。

## 安装与运行

开发者本地运行和构建：

```bash
corepack pnpm install
corepack pnpm dev
corepack pnpm build
corepack pnpm test
corepack pnpm test:e2e
corepack pnpm tauri:dev
corepack pnpm tauri:build
```

如果本机尚未安装 pnpm，可先运行：

```bash
corepack enable
corepack prepare pnpm@9.15.4 --activate
```

`corepack pnpm tauri:dev` 和 `corepack pnpm tauri:build` 还需要 Rust、MSVC 和 Tauri 平台依赖。最终用户不需要安装 Node.js、pnpm、Rust 或 Visual Studio Build Tools，只需要运行 Windows NSIS 安装包；详见 `docs/PACKAGING.md`。

## 视频格式限制

当前 `HtmlVideoMediaAdapter` 只可靠支持浏览器原生可播放的 MP4 和 WebM。`NativeMpvMediaAdapter` 已保留接口占位，但本阶段没有声明或伪造 MKV 支持。

## 项目文件策略

`.danmaku-project.json` 保存项目 schema、媒体引用、XML 资源元数据、解析后的弹幕数据、片段、删减标记、同步锚点、禁用弹幕、单条时间调整、时间轴视图和预览设置。视频内容不会嵌入项目文件。

打开项目时会校验弹幕资源、片段、删减补偿点、同步锚点、整数毫秒时间字段、预览设置和时间轴视图，避免坏的非破坏性规则进入运行时状态。

资源栏“项目信息”会基于当前运行时状态生成项目健康摘要，用于在保存、重开或导出前快速复核媒体重连、空片段、导入警告和失效引用；其中失效禁用/单条微调引用可通过真实清理动作进入历史栈，仍可撤销。

首版选择把解析后的 XML 数据嵌入项目文件，优点是重新打开项目不依赖原 XML 路径；缺点是大项目文件体积会增加。后续可增加“外部引用 + 缺失文件重连”模式。

## 常用操作

- 顶部工具栏：新建、打开、保存、导入视频、导入 XML、导出 XML、撤销、重做、播放暂停、缩放和设置。
- 左侧资源面板：查看媒体、弹幕文件、项目统计、Emby 时长、人工整理规则、补偿点管理、疑似删减点、锚点校准、同步锚点管理和视频对齐实验室。
- 右侧检查器：编辑当前弹幕、片段或补偿点。
- 底部时间轴：点击或拖动播放头，滚轮横向滚动，Ctrl/Command + 滚轮缩放，拖动片段或弹幕。
- 导出摘要：查看补偿点数量、总补偿时长、补偿明细、验证状态，并在需要时下载补偿报告。

## 删减补偿与对齐工作流

1. 导入本地 XML，把需要复核的弹幕资源放入时间轴。
2. 使用“疑似删减点”扫描弹幕文本，或在“锚点校准”中输入“源弹幕时间 -> 完整片源时间”。
3. 将候选发送到时间轴预览，确认下游影响区后应用为补偿点。
4. 在“补偿点管理”和“同步锚点管理”中复核、微调或删除规则。
5. 导出 XML 前查看摘要、补偿报告和对齐复核报告；导出的 XML 会重新解析验证，原始 XML 不会被直接修改。

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

- 开发者构建桌面安装包依赖本机 Rust/Tauri 构建环境；最终用户运行安装包不需要这些开发工具。
- 当前 Windows 安装包未签名，首次安装或运行时可能出现 SmartScreen 提示。
- 当前没有接入 mpv，因此不承诺 MKV、外挂字幕高级渲染或硬解能力。
- 本地音频对齐依赖用户提供合法拥有或授权读取的完整片源、删减版视频和本机 FFmpeg；网页模式不会伪装成本地桌面能力。
- 当前对齐算法是本地音频特征和动态规划候选生成，已对音频候选使用相邻匹配区间中点作为初始边界，并展示不确定区间，可导出复核报告；仍需要人工确认，视觉对齐和更细粒度局部重匹配仍是后续增强。
- Emby 集成只处理用户配置且有权限访问的媒体库元数据，不实现视频下载、DRM 绕过、账号绕过、私有接口爬取或未授权媒体访问。
- Emby 密码和 token 不写入项目文件、Tauri 配置文件或 localStorage；本次会话密码关闭应用后失效。
- ASS 导出仅保留扩展接口，不属于本阶段强制能力。

## 验证与打包

常用验证命令：

```bash
corepack pnpm test
corepack pnpm lint
corepack pnpm build
corepack pnpm test:e2e
corepack pnpm tauri:build
```

最近成熟度提升阶段持续生成 Windows release 产物：

- `src-tauri/target/release/danmaku_timeline_studio.exe`
- `src-tauri/target/release/bundle/nsis/Danmaku Timeline Studio_0.1.0_x64-setup.exe`

## 后续路线

- 接入 mpv sidecar，提供更完整的容器和编码支持。
- 增加视觉对齐和更细粒度局部重匹配，提高真实视频删减点边界精度。
- 扩展 Playwright E2E 覆盖导出 XML 后重新导入、复杂编辑撤销恢复和更多窄窗口截图。
- 评估系统凭证库保存敏感凭证，并在后续设置 schema 升级时补充迁移界面和冲突提示。
