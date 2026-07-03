# 进度记录

## 2026-07-03

### 阶段1：基础工程

- 状态：完成。
- 已确认当前目录原本不是 Git 仓库，已初始化 Git。
- 已确认 Node 可用。
- 已确认初始环境中 `pnpm` 和 Rust 工具链未在 PATH 中；用户随后安装了全局 pnpm，但该版本要求 Node 22.13。当前使用 Corepack 固定调用 `pnpm@9.15.4`，适配 Node 20.11.1。
- 已创建 React、TypeScript strict、Vite、Tailwind、Tauri 2、Vitest、Playwright、ESLint、Prettier 配置。
- 已创建基础编辑器布局：顶部工具栏、资源面板、预览区、检查器、Canvas 时间轴、状态栏和导出摘要弹窗。
- 已运行 `corepack pnpm install`，成功。
- 已运行 `corepack pnpm build`，成功。

### 环境注意事项

- 当前 Demo 不依赖后端服务器或云数据库。
- Tauri 桌面模式需要本机安装 Rust 和平台构建依赖。
- 在当前 PowerShell 执行策略下，直接运行 `pnpm` 会命中 `pnpm.ps1` 策略限制；本环境验证使用 `corepack pnpm ...`。若用户调整执行策略或使用 `pnpm.cmd`，也可执行同等命令。

### 阶段2：XML 领域逻辑

- 状态：完成。
- 已实现 Bilibili XML 解析、导出序列化、导出重新解析验证和导出摘要统计。
- 已创建 XML fixtures：正常 XML、特殊字符 XML、字段缺失 XML、多语言 XML、多分 P XML。
- 已通过脚本生成 `large-10000.xml` 和 `large-50000.xml` 合成弹幕数据。
- 已运行 `corepack pnpm test`，15 个单元测试通过，覆盖 XML 解析、序列化、特殊字符、非法节点、时间转换、时间映射、删减累计、单条调整、排序、项目 schema、撤销重做、密度桶和二分范围查找。

### 阶段3：项目与资源管理

- 状态：完成。
- 已实现多 XML 导入、资源面板、分 P 自动排列、项目 JSON 保存/打开和 schema 版本检查。
- 已创建 `fixtures/projects/three-part-demo.danmaku-project.json`，展示三个分 P XML 依次排列并可合并导出。
- 已运行 `corepack pnpm test`，20 个测试通过，包含导入面板、检查器、导出摘要、删减标记编辑和快捷键组件测试。

### 阶段4：时间轴

- 状态：完成（功能实现与 E2E 冒烟验证已通过）。
- 已实现 Canvas 2D 时间轴、标尺、播放头、视频轨、删减轨、弹幕片段轨、密度热力图和事件轨。
- 已实现点击/拖动播放头、滚轮平移、Ctrl/Command + 滚轮缩放、拖动片段、框选弹幕、拖动所选弹幕、吸附播放头和删减标记。
- 已修正小时级时间线缩放：`缩放到全部` 不再被 8px/s 下限卡住，可缩放到多小时范围。
- 已将时间轴缩放控件改为对数比例尺，范围覆盖 `0.01 px/s` 到 `1600 px/s`，兼顾 1-5 小时以上 XML 和精细编辑。
- 时间轴面板内的 `缩放到全部` 现在按当前画布实际可视宽度计算，不再使用固定 1200px 估算。
- 已扩展时间标尺刻度，在低缩放级别支持 10 分钟、30 分钟、1 小时、6 小时等级别。
- 已为播放头拖动增加边缘行为：
  - 贴近视野左右边缘时自动滚动后续/前序时间轴。
  - 到达真实开端或末端时限制播放头继续越界，并绘制红色边界反馈。
- 已新增时间轴工具模式：
  - 选择工具。
  - 剪刀工具。
  - 工具条显示当前选中工具状态。
- 已实现时间轴片段级非破坏性剪辑：
  - 在播放头剪切片段。
  - 剪刀工具点击片段剪切。
  - 同一 XML 且源时间、时间轴连续的相邻片段合并。
  - 删除选中片段。
  - Shift 点击片段/删减点多选。
- 已补全 AlignmentProposal 时间轴预览：
  - 项目已有同步锚点使用实线标记。
  - 未应用候选锚点使用绿色虚线和标签标记。
  - 未应用候选删减点使用橙色虚线、菱形点位、偏移箭头和半透明影响区标记。
  - 已应用 proposal 项使用降噪样式标记，避免应用后仍像新候选。
  - 时间轴工具条显示“对齐候选 / 已应用”计数。
- 已新增 `src/domain/alignment/preview.ts`，将对齐预览状态计算放在非 React 领域层。
- 已收紧手动对齐 proposal JSON 校验，拒绝字段缺失或数值非法的候选项。
- 已为对齐 proposal 解析与预览模型补充单元测试。

### 阶段5：验证、截图与 E2E

- 状态：进行中。
- 已修复 ESLint 配置，让 `corepack pnpm lint` 聚焦当前 TS/TSX 编译边界，并忽略构建产物、截图和 Playwright 结果目录。
- 已清理导入组件测试中的 React `act(...)` 警告，当前单元测试输出干净。
- 已新增 Playwright E2E：`tests/e2e/editor-workflow.spec.ts`。
- 已修复 Playwright 本地端口配置：当前使用 `127.0.0.1:53173`，避开 Windows 拒绝的 `4173/5173` 端口。
- 已安装 Playwright Chromium，并成功运行 `corepack pnpm test:e2e`。
- 已生成并检查存在以下截图：
  - `artifacts/screenshots/empty-project.png`
  - `artifacts/screenshots/imported-project.png`
  - `artifacts/screenshots/timeline-editing.png`
  - `artifacts/screenshots/cut-marker.png`
  - `artifacts/screenshots/export-dialog.png`
- 已人工查看 `imported-project.png`、`cut-marker.png`、`export-dialog.png`，未发现明显空白、遮挡或布局崩坏。
- 已验证命令：
  - `corepack pnpm lint` 成功。
  - `corepack pnpm build` 成功。
  - `corepack pnpm test` 成功，当前 12 个测试文件、26 个测试通过。
  - `corepack pnpm test:e2e` 成功，当前 1 个 Chromium E2E 测试通过。
- 剩余验证工作：
  - 扩展 E2E 覆盖保存项目、重新打开项目、导出 XML 后重新导入、选择并移动弹幕、撤销后状态恢复。
  - 继续 Web Demo 人工视觉检查，重点看小窗口、文本溢出、弹窗遮挡、时间轴标签密度和批量分集下载行为。
  - Rust 工具链仍未验证，Tauri 桌面模式待后续环境具备后执行。

### 阶段6：资源栏补洞、可调整工作区与批量分集合并

- 状态：完成。
- 已补齐资源栏基础管理操作：
  - 视频资源可从左侧媒体栏删除，并释放浏览器对象 URL。
  - 弹幕 XML 资源可从左侧资源栏删除；删除时同步移除关联时间轴片段、禁用弹幕记录和单条时间调整。
  - 已放入时间轴的弹幕资源可单独“移出”，保留原始导入资源。
- 已将主工作区从固定 grid 改为可调整尺寸布局：
  - 左侧资源栏宽度可拖拽调整。
  - 右侧检查器宽度可拖拽调整。
  - 底部时间轴高度可拖拽调整。
  - 分隔条支持键盘方向键调整，并保留焦点样式。
- 已新增批量分集合并领域逻辑 `src/domain/danmaku/batchMerge.ts`：
  - 支持识别 `01 - 1.1.xml`、`02 - 1.2.xml` 这类“集数.分 P”命名，并按集数归组。
  - 支持识别 `第一季1-5.xml`、`S01E01-E05.xml`、`1-5集.xml` 这类范围命名。
  - 多个分 P 采用追加式合并：后一段时间整体接到前一段最后一条弹幕之后。
  - 多集范围文件优先按集间大空隙切分，找不到明显空隙时按总时长均分，并在草案中提示需要复核。
  - 生成的每集 XML 导出前会重新解析验证，不直接修改原始导入 XML。
- 已在资源栏新增“分集合并草案”和“导出分集”按钮：
  - 展示识别到的输出集数、来源 XML 数、置信度和前几项输出。
  - 一键触发多个分集 XML 下载，默认文件名类似 `1 - 1.xml`；多季混合时使用 `S01E01.xml`。
- 已补充测试：
  - `src/domain/danmaku/batchMerge.test.ts` 覆盖分 P 追加合并和范围文件切分。
  - `src/features/assets/AssetPanel.test.tsx` 覆盖资源栏删除已导入弹幕文件。
- 已验证命令：
  - `corepack pnpm lint` 成功。
  - `corepack pnpm build` 成功。
  - `corepack pnpm test` 成功，当前 14 个测试文件、29 个测试通过。
  - `corepack pnpm test:e2e` 成功，当前 1 个 Chromium E2E 测试通过。
- 已启动 Web Demo：
  - 实际可访问地址：`http://127.0.0.1:53175/`
  - `53174` 已被占用，Vite 自动切换到 `53175`。

### 阶段7：人工规则优先的弹幕整理器

- 状态：完成。
- 已调整产品路线：暂不依赖视频内容识别、弹幕密度智能判断或自然语言指令；优先实现低输入成本的人工规则。
- 已扩展批量分集合并领域逻辑 `src/domain/danmaku/batchMerge.ts`：
  - 支持 `segmentWindow` 人工截取规则：
    - 完整保留。
    - 每个分 P 只取前 N 分钟。
    - 每个分 P 只取后 N 分钟。
    - 每个分 P 统一按开始/结束分钟截取。
  - 支持 `rangeSplit` 长合集切分规则：
    - 自动切分。
    - 按真实集时长切分。
    - 按人工切点切分。
  - 使用固定有效时长截取分 P 时，追加合并会按固定窗口长度推进，避免因为尾部没有弹幕而把下一分 P 提前。
  - 按真实集时长切分长合集时，超出真实总时长的尾部内容会被丢弃并产生提示。
- 已新增人工规则解析器 `src/domain/danmaku/manualRules.ts`：
  - 支持粘贴 `S01E01 51:20`、`S01E02 50:45` 这类真实集时长。
  - 支持一行一个 `51:20`，按行序号映射到集数。
  - 支持人工切点输入，如 `51:20, 1:42:05`。
  - 两段式 `153:10` 按 153 分 10 秒处理，适合长合集切点。
- 已在资源栏新增“人工整理规则”面板：
  - 分 P 规则用下拉框和少量数字输入完成。
  - 长合集规则用下拉框和一个文本框完成。
  - 修改规则后即时重算“分集合并草案”，导出仍走 XML 重新解析验证。
- 已补充测试：
  - `src/domain/danmaku/batchMerge.test.ts` 新增前 N 分钟截取、真实集时长切分测试。
  - `src/domain/danmaku/manualRules.test.ts` 覆盖真实集时长、人工切点和分钟输入解析。
- 已验证命令：
  - `corepack pnpm lint` 成功。
  - `corepack pnpm build` 成功。
  - `corepack pnpm test` 成功，当前 15 个测试文件、34 个测试通过。
  - `corepack pnpm test:e2e` 成功，当前 1 个 Chromium E2E 测试通过。

### 阶段8：Emby 订阅库时长接入

- 状态：完成。
- 已新增 Emby 客户端 `src/infrastructure/metadata/embyClient.ts`：
  - 使用 `POST /Users/AuthenticateByName` 通过用户名/密码登录。
  - 使用 token 请求 `/Users/{UserId}/Items/{ItemId}` 读取单条媒体元数据。
  - 使用 `/Users/{UserId}/Items?ParentId=...&Recursive=true&IncludeItemTypes=Episode` 读取剧集、季或合集下的 Episode 子项。
  - 支持反代路径前缀，默认 UI 填写 `/emby`，适配 `/emby/Users/...` 这类订阅服务路径。
  - 将 Emby `RunTimeTicks` 转为毫秒：`milliseconds = RunTimeTicks / 10000`。
  - 优先读取条目自身 `RunTimeTicks`，读不到时回退到 `MediaSources[].RunTimeTicks`。
- 已在资源栏新增“Emby 时长”面板：
  - 输入服务器、路径前缀、用户名、密码、ItemId。
  - 面板可在尚未导入 XML 时使用，便于先获取剧集时长表。
  - 登录后可读取单条条目，显示名称、类型、精确时长。
  - 可读取下级剧集并生成 `S01E01 51:20.123` 形式的真实集时长表。
  - 可一键把时长表导入现有“按真实集时长”人工整理规则。
  - 用户名、密码和 token 只保存在当前页面组件内存中，不写入项目文件。
- 已补充测试：
  - `src/infrastructure/metadata/embyClient.test.ts` 覆盖登录、读取条目、读取下级剧集和时长表格式化。
- 已知限制：
  - 当前实现是浏览器前端直连 Emby；如果订阅服务没有开放 CORS，需要后续通过 Tauri 后端命令代理请求。
  - 本轮未使用用户提供的真实凭证做在线请求验证，避免凭证进入日志或测试输出。
- 已验证命令：
  - `corepack pnpm lint` 成功。
  - `corepack pnpm build` 成功。
  - `corepack pnpm test` 成功，当前 16 个测试文件、37 个测试通过。
  - `corepack pnpm test:e2e` 成功，当前 1 个 Chromium E2E 测试通过。

### 阶段9：无 ItemId 的 Emby 搜索与登录失败诊断

- 状态：完成。
- 已根据订阅库无法通过网页或官方应用拿到 ItemId 的场景，调整开发思路：
  - 保留已有 ItemId 精确读取能力，作为高确定性路径。
  - 新增标准 Emby `Items?SearchTerm=...` 搜索路径，允许按片名、剧名、季集号等信息搜索候选。
  - 搜索文本会拆出 `S02E03`、`第2季第3集`、`2x03` 这类季集号，用片名发起搜索，再把季集号匹配的候选排到前面。
  - 搜索结果只作为当前面板内存状态，用户选中候选后再填入 ItemId、读取单条或读取下级剧集，不写入项目文件。
  - 电影或单集候选若带时长，可直接导入一条 `S01E01 duration` 形式的人工整理规则。
  - 后续若要解决订阅服务不开放 CORS 的场景，应走 Tauri 桌面端代理，而不是伪装成 VidHub/Hills 等特定客户端。
- 已优化 Emby 登录失败体验：
  - 浏览器网络层失败不再裸显 `Failed to fetch`。
  - 现在会提示检查服务器地址、路径前缀、HTTPS 证书、网络连通性，以及第三方 App 可用但网页不可用时常见的 CORS 限制。
- 已修正人工规则解析：
  - `S01E01 51:20.123` 这类 Emby 精确毫秒时长现在会按完整时长解析。
- 已补充测试：
  - `src/infrastructure/metadata/embyClient.test.ts` 新增搜索和网络失败诊断覆盖。
  - `src/domain/danmaku/manualRules.test.ts` 新增 Emby 毫秒时长解析覆盖。
- 已验证命令：
  - `corepack pnpm lint` 成功。
  - `corepack pnpm build` 成功。
  - `corepack pnpm test` 成功，当前 16 个测试文件、39 个测试通过。

### 阶段10：第一个 Windows 桌面安装包

- 状态：完成。
- 已安装本机 Tauri Windows 打包环境：
  - 通过 `winget` 安装 Rustup。
  - 通过 `winget` 安装 Visual Studio 2022 Build Tools C++ 工具集，补齐 MSVC `link.exe`。
- 已修正 Tauri 构建配置：
  - `beforeBuildCommand` 改为 `corepack pnpm build`，避免调用全局 pnpm 导致 Node 版本不兼容。
  - `beforeDevCommand` 改为 `corepack pnpm dev -- --port 1420`，与 Tauri `devUrl` 对齐。
  - 新增应用图标源 `src-tauri/app-icon.svg` 并生成 `src-tauri/icons`。
  - 在 `tauri.conf.json` 中配置 Windows/macOS/Linux 图标路径。
- 已新增打包说明：
  - `docs/PACKAGING.md`
- 已生成首个可安装 Windows 桌面包：
  - `src-tauri/target/release/danmaku_timeline_studio.exe`
  - `src-tauri/target/release/bundle/nsis/Danmaku Timeline Studio_0.1.0_x64-setup.exe`
  - `src-tauri/target/release/bundle/msi/Danmaku Timeline Studio_0.1.0_x64_en-US.msi`
- 已验证命令：
  - `corepack pnpm build` 成功。
  - `corepack pnpm tauri build` 成功。
- 已知限制：
  - 当前安装包未签名，Windows 首次安装或运行时可能显示 SmartScreen 提示。
  - 桌面壳尚未实现 Tauri 后端 Emby 代理，订阅库 CORS 问题仍待后续阶段解决。
