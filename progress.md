# Danmaku Timeline Studio 项目进度

更新时间：2026-07-09

## 进度文档约定

- 根目录 `progress.md` 是唯一进度文档，用于新对话实时同步项目情况。
- 原 `docs/PROGRESS.md` 的阶段记录已合并到本文档，后续不再维护第二份进度文件。
- 每完成一个阶段都更新本文档，避免阶段信息分散。

## 2026-07-09 最新同步

- Emby 订阅库接入已在打包程序中验证成功：
  - 已支持用户名/密码登录、搜索、选择候选、读取下级剧集和获取精确剧集时长。
  - 已实现 Tauri 桌面代理 `emby_http_request`，解决订阅库 CORS 导致 WebView `Failed to fetch` 的问题。
  - 代理仅允许 `http/https`，仅转发 Emby 所需请求头，保留 HTTPS 证书校验。
- 多分集导出下载稳定性已修复：
  - 单文件仍直接下载 XML。
  - 多文件导出改为一个 `danmaku-exports.zip`，ZIP 内包含全部分集 XML。
  - 已修复连续触发多个 `<a download>` 时 WebView/浏览器只放行部分下载的问题。
- 当前桌面构建产物：
  - 裸 exe：`src-tauri/target/release/danmaku_timeline_studio.exe`
  - NSIS 安装包：`src-tauri/target/release/bundle/nsis/Danmaku Timeline Studio_0.1.0_x64-setup.exe`
- 最近已验证命令：
  - `corepack pnpm lint` 成功。
  - `corepack pnpm test` 成功，当前 20 个测试文件、55 个测试通过。
  - `corepack pnpm build` 成功。
  - `cargo test` 成功。
  - `corepack pnpm tauri:build` 成功。
- 已确认新的产品难题：
  - B 站源视频可能因删减导致弹幕时间轴缩短。
  - 在多集合集弹幕中，前序删减会让后续集数弹幕整体提前，单纯按 Emby 真实集时长切分仍可能错位。
- 后续优先产品路线：删减补偿 / 非线性时间轴对齐。
  - 先做手动 `insertGap` 补偿规则：在某个源时间点后插入缺失时长，所有编辑仍保持非破坏性。
  - 再把补偿后的时间轴用于合集切分，避免后续集数继续提前。
  - 增加“疑似删减点”弹幕文本扫描，例如“删了、剪了、跳了、和谐了”等聚类提示。
  - 增加锚点校准：用户标出源弹幕时间和完整片源时间的对应点，由系统推断缺失时长。
  - 中长期探索本地音频/视频对齐工具：用户提供合法的完整原片和被删减版视频，工具输出删减规则 JSON。
  - 对齐工具优先走低成本本地算法，不优先依赖多模态 API：FFmpeg 解码抽帧/抽音频、音频指纹或频谱特征、感知哈希/ORB、动态规划/DTW、候选区精扫。

## 近期阶段记录（2026-07-09）

### 阶段11：桌面打包准备与低风险问题修复

- 状态：完成。
- 已修复 Tauri 壳层半接入问题，移除未接通的 HTTP plugin 初始化和未使用的 `reqwest` 依赖。
- 已修复新建/打开项目时旧视频 `objectUrl` 释放问题。
- 已修复时间轴片段拖拽和新增片段时忽略 `localOffsetMs` 的问题。
- 已提取共享弹幕资源颜色常量。
- 已收紧 XML 秒数字段解析，按十进制字符串转换并舍入到整数毫秒。
- 已加强项目 JSON 打开前的轻量 schema 校验。
- 已补充 store、预览可见事件、预览面板、XML 和项目 schema 测试。
- 已新增 `corepack pnpm tauri:dev` 和 `corepack pnpm tauri:build` 脚本入口。

### 阶段12：Emby 桌面代理接入

- 状态：完成，并已由用户在打包程序中验证 Emby 功能成功。
- 已定位旧问题：前端 WebView 直接 `fetch` 订阅库时，订阅库未开放 CORS 或证书链不被 WebView 接受会导致 `Failed to fetch`。
- 已实现 Tauri 桌面代理：
  - 前端 Emby 客户端在 Tauri 环境自动调用 `emby_http_request`。
  - Rust 后端用 `reqwest` 代发 Emby 的 `GET` 和 `POST` JSON 请求。
  - 代理仅允许 `http/https` URL，仅转发 Emby 必要请求头，保留 TLS 校验。
- 已补充 Tauri 代理请求序列化、URL/方法/请求头边界和非 JSON 响应处理测试。

### 阶段13：多分集导出下载稳定性修复

- 状态：完成。
- 已定位旧问题：同一次用户操作中连续创建多个 `<a download>` 可能被 WebView/浏览器拦截或只放行部分下载。
- 已调整导出交付方式：
  - 单文件导出仍直接下载 XML。
  - 多文件导出改为生成 `danmaku-exports.zip`。
  - ZIP 内保留全部分集 XML，清理非法路径字符并避免重名覆盖。
- 已补充 `src/infrastructure/file-system/browserFiles.test.ts`，覆盖 ZIP 条目完整性、非法文件名清理和重名处理。
- 已重新生成裸 exe 和 NSIS 安装包。

### 阶段14：删减补偿与音频优先对齐路线梳理

- 状态：完成产品路线梳理，待后续实现。
- 已确认核心问题不是固定偏移，而是源视频删减导致的非线性时间轴收缩。
- 短期实现方向：
  - 新增手动删减补偿规则，例如在 `sourceAtMs` 后插入 `missingDurationMs`。
  - 在合集切分前先应用补偿映射，再按 Emby 真实集时长切分。
  - 为导出增加补偿报告，说明每集应用了哪些缺失时长规则。
- 中期智能方向：
  - 扫描弹幕文本中的“删了、剪了、跳了、和谐了、没了”等词，并按时间聚类成疑似删减点。
  - 支持锚点校准：用户标出源弹幕时间和完整片源时间的对应点，由系统推断缺失时长。
- 长期自动对齐方向：
  - 独立做一个本地对齐工具，输入用户合法提供的完整原片和删减版视频，输出删减规则 JSON。
  - 优先使用音频对齐，因为多数删减会同时剪掉画面和音频，音频特征通常比视觉逐帧对比更便宜。
  - 对齐流水线建议为：FFmpeg 抽音频/抽帧 → 粗采样特征 → 动态规划/DTW 对齐 → 候选删减区精扫 → 输出规则 → Danmaku Studio 复核应用。

## 早期新增记录（2026-07-03）

- 已完成第一个 Windows 桌面安装包：
  - 已安装 Rustup 和 Visual Studio 2022 Build Tools C++ 工具集。
  - 已修正 Tauri 构建命令，统一使用 `corepack pnpm ...`。
  - 已新增应用图标并生成 Tauri 图标资源。
  - 已新增 `docs/PACKAGING.md`。
  - 已成功运行 `corepack pnpm tauri build`。
  - 可运行程序：`src-tauri/target/release/danmaku_timeline_studio.exe`
  - NSIS 安装包：`src-tauri/target/release/bundle/nsis/Danmaku Timeline Studio_0.1.0_x64-setup.exe`
  - MSI 安装包：`src-tauri/target/release/bundle/msi/Danmaku Timeline Studio_0.1.0_x64_en-US.msi`

- 已优化无 ItemId 的 Emby 订阅库使用路径：
  - 新增 `Items?SearchTerm=...` 标准搜索能力，可按片名、剧名、`S01E02`、第几季第几集等信息搜索候选，并把季集号匹配项优先排序。
  - 资源栏“Emby 时长”面板新增搜索框和候选列表，选中候选后自动填入 ItemId。
  - 电影或单集候选如果带时长，可直接导入为一条人工整理规则。
  - 浏览器网络层失败不再裸显 `Failed to fetch`，会提示 CORS、证书、地址、路径前缀和桌面端代理方向。
  - 修正 `S01E01 51:20.123` 这类带毫秒 Emby 时长的人工规则解析。
- 已重新验证：
  - `corepack pnpm lint` 成功
  - `corepack pnpm build` 成功
  - `corepack pnpm test` 成功，当前 16 个测试文件、39 个测试通过

- 已新增 Emby 订阅库时长接入：
  - `src/infrastructure/metadata/embyClient.ts`
  - 通过 `POST /Users/AuthenticateByName` 登录获取 `UserId` 和 token。
  - 通过 `/Users/{UserId}/Items/{ItemId}` 读取单条条目。
  - 通过 `/Users/{UserId}/Items?ParentId=...&Recursive=true&IncludeItemTypes=Episode` 读取下级剧集。
  - 支持路径前缀，默认 UI 使用 `/emby`，适配 `/emby/Users/...` 订阅服务路径。
  - 将 Emby `RunTimeTicks` 转成毫秒，优先条目字段，回退到 `MediaSources[].RunTimeTicks`。
- 已在资源栏新增“Emby 时长”面板：
  - 输入服务器、路径、用户名、密码、ItemId。
  - 未导入 XML 时也可先使用该面板获取时长表。
  - 可读取条目时长。
  - 可读取下级剧集并生成 `S01E01 51:20.123` 形式的时长表。
  - 可一键导入到“按真实集时长”人工整理规则。
  - 凭证和 token 只保存在当前组件内存中，不写入项目文件。
- 已补充测试：
  - `src/infrastructure/metadata/embyClient.test.ts`
- 已重新验证：
  - `corepack pnpm lint` 成功
  - `corepack pnpm build` 成功
  - `corepack pnpm test` 成功，当前 16 个测试文件、37 个测试通过
  - `corepack pnpm test:e2e` 成功，当前 1 个 Chromium E2E 测试通过

- 已将弹幕整理方向调整为“人工规则优先”：
  - 暂不依赖视频内容识别、弹幕密度智能判断或自然语言指令。
  - 在资源栏新增“人工整理规则”面板，用少量下拉框和输入框控制整理计划。
- 已支持分 P 有效内容规则：
  - 完整保留。
  - 每个分 P 只取前 N 分钟。
  - 每个分 P 只取后 N 分钟。
  - 每个分 P 按统一开始/结束分钟截取。
- 已支持长合集切分规则：
  - 自动切分。
  - 按真实集时长切分。
  - 按人工切点切分。
- 已新增人工规则解析：
  - `S01E01 51:20`
  - 一行一个 `51:20`
  - `51:20, 1:42:05` 这类切点列表
  - `153:10` 会按 153 分 10 秒处理。
- 已补充测试：
  - `src/domain/danmaku/manualRules.test.ts`
  - `src/domain/danmaku/batchMerge.test.ts` 新增人工规则覆盖
- 已重新验证：
  - `corepack pnpm lint` 成功
  - `corepack pnpm build` 成功
  - `corepack pnpm test` 成功，当前 15 个测试文件、34 个测试通过
  - `corepack pnpm test:e2e` 成功，当前 1 个 Chromium E2E 测试通过

- 已补齐资源栏管理动作：删除视频引用、删除弹幕 XML 资源、将弹幕资源从时间轴移出。
- 已实现可拖拽调整的主工作区：资源栏宽度、检查器宽度、时间轴高度均可用鼠标或键盘方向键调整。
- 已新增批量分集合并草案与导出：
  - 支持识别 `01 - 1.1.xml`、`02 - 1.2.xml` 这类“集数.分 P”文件并追加式合并。
  - 支持识别 `第一季1-5.xml`、`S01E01-E05.xml`、`1-5集.xml` 这类多集范围文件并切分为单集输出。
  - 导出的每集 XML 会重新解析验证，原始导入 XML 不会被直接修改。
- 已补充测试：
  - `src/domain/danmaku/batchMerge.test.ts`
  - `src/features/assets/AssetPanel.test.tsx`
- 已重新验证：
  - `corepack pnpm lint` 成功
  - `corepack pnpm build` 成功
  - `corepack pnpm test` 成功，当前 14 个测试文件、29 个测试通过
  - `corepack pnpm test:e2e` 成功，当前 1 个 Chromium E2E 测试通过
- 已启动 Web Demo，实际地址为 `http://127.0.0.1:53175/`。

## 已完成的事项

- 已在当前目录初始化 Git 仓库。
- 已创建长期规则和文档：
  - `AGENTS.md`
  - `README.md`
  - `docs/PLAN.md`
  - `docs/ARCHITECTURE.md`
  - `progress.md`
  - `docs/REFERENCES.md`
- 已创建 React + TypeScript strict + Vite + Tailwind CSS 工程。
- 已创建 Tauri 2 桌面壳配置：
  - `src-tauri/Cargo.toml`
  - `src-tauri/tauri.conf.json`
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/main.rs`
- 已配置：
  - pnpm package scripts
  - Vitest
  - React Testing Library
  - Playwright
  - ESLint
  - Prettier
  - Tailwind/PostCSS
- 已实现基础产品界面：
  - 顶部工具栏
  - 左侧资源面板
  - 中央视频/弹幕预览区
  - 右侧检查器
  - 底部 Canvas 时间轴
  - 状态栏
  - 导出摘要弹窗
- 已实现领域模型：
  - `DanmakuItem`
  - `DanmakuAsset`
  - `DanmakuClip`
  - `CutMarker`
  - `SyncAnchor`
  - `EditorProject`
- 已实现 Bilibili XML 解析和序列化：
  - 秒转整数毫秒
  - 保留完整原始 `p` 字段
  - 解析已知字段
  - 保留未知字段
  - XML entity、多语言、Emoji 支持
  - 非法节点产生导入警告而不阻断导入
  - 导出按最终时间排序
  - 负时间导出时限制为 0
  - 导出后重新解析验证
- 已实现非破坏性时间映射：
  - 片段级偏移
  - 全局偏移
  - 单条弹幕时间调整
  - 多个删减标记累计
  - `getResolvedDanmakuTime`
- 已实现项目管理：
  - 多 XML 导入
  - 资源面板展示弹幕数量、最早/最晚时间、颜色、是否放入时间轴
  - 资源添加到时间轴
  - 按顺序自动排列分 P
  - `.danmaku-project.json` 保存和打开
  - schema 版本检查
- 已实现 Zustand 编辑器状态：
  - 导入 XML
  - 导入视频
  - 打开/保存项目
  - 添加/移动片段
  - 选择弹幕/片段/删减标记
  - 移动弹幕
  - 禁用/恢复弹幕
  - 添加/编辑/删除删减标记
  - 全局偏移
  - 预览设置
  - 导出摘要
  - 撤销/重做
- 已实现 Canvas 2D 时间轴：
  - 时间标尺
  - 播放头
  - 视频轨道
  - 删减标记轨道
  - 弹幕片段轨道
  - 弹幕密度热力图
  - 弹幕事件轨道
  - 点击/拖动播放头
  - 鼠标滚轮横向滚动
  - Ctrl/Command + 滚轮缩放，并保持鼠标指向时间稳定
  - 拖动片段
  - 单击选择弹幕
  - Shift 多选
  - 框选时间范围内弹幕
  - 拖动所选弹幕
  - 吸附到播放头/删减标记
  - 双击弹幕跳转播放头
  - 小时级时间线缩放
  - 达芬奇式对数缩放滑杆，范围覆盖 `0.01 px/s` 到 `1600 px/s`
  - `缩放到全部` 按当前时间轴可视宽度计算
  - 低缩放级别大跨度时间标尺
  - 播放头边缘自动滚动
  - 播放头到达真实开端/末端时的边界反馈
  - 选择工具
  - 剪刀工具
  - 在播放头剪切片段
  - 剪刀工具点击片段剪切
  - 连续片段合并
  - 片段/删减点 Shift 多选
  - 删除选中片段或删减标记
- 已实现预览区：
  - `MediaAdapter` 接口
  - `HtmlVideoMediaAdapter`
  - `NativeMpvMediaAdapter` 占位接口
  - MP4/WebM HTML Video 预览
  - 播放头和预览同步
  - 基础滚动/顶部/底部弹幕叠加
  - 字号、颜色、透明度、启用状态
  - 基础轨道分配
  - 安全区开关
- 已实现检查器：
  - 单条弹幕检查器
  - 片段检查器
  - 删减标记检查器
  - 多选弹幕操作
- 已实现快捷键：
  - Space 播放/暂停
  - Ctrl/Command + Z 撤销
  - Ctrl/Command + Shift + Z 重做
  - Delete / Backspace 删除选择项；弹幕删除以禁用表达
  - Ctrl/Command + A 选择全部片段
  - Ctrl/Command + K 在播放头剪切片段
  - Ctrl/Command + J 合并连续片段
  - V 选择工具
  - B / C 剪刀工具
  - Escape 清空选择
  - Home / End 跳转时间线开端/末端
  - 左右方向键 10ms 微调
  - Shift + 左右方向键 100ms 微调
  - Alt + 左右方向键 1s 微调
  - M 添加删减标记
  - F 缩放到全部
  - `+` / `-` 缩放时间轴
- 已实现智能对齐扩展接口：
  - `AlignmentProvider`
  - `AlignmentInput`
  - `AlignmentProposal`
  - `ManualAlignmentProvider`
  - proposal JSON 导入/导出
  - proposal 应用到项目
  - proposal JSON 严格校验
  - 时间轴同步锚点绘制
  - 候选锚点虚线绘制
  - 候选删减点虚线/半透明影响区绘制
  - proposal 应用前后状态区分
  - 时间轴“对齐候选 / 已应用”计数
- 已创建 fixtures：
  - `fixtures/bilibili/normal.xml`
  - `fixtures/bilibili/special-chars.xml`
  - `fixtures/bilibili/missing-fields.xml`
  - `fixtures/bilibili/multilingual.xml`
  - `fixtures/bilibili/part-1.xml`
  - `fixtures/bilibili/part-2.xml`
  - `fixtures/bilibili/part-3.xml`
  - `fixtures/bilibili/large-10000.xml`
  - `fixtures/bilibili/large-50000.xml`
- 已创建三分 P 示例项目：
  - `fixtures/projects/three-part-demo.danmaku-project.json`
- 已创建生成脚本：
  - `scripts/generate-fixtures.mjs`
  - `scripts/generate-example-project.mjs`
- 已完成并通过测试：
  - XML 解析/序列化
  - 特殊字符
  - 非法节点容错
  - 时间单位转换
  - 片段时间计算
  - 全局偏移
  - 多删减标记累计
  - 单条弹幕调整
  - 最终时间排序
  - 项目文件序列化
  - 项目版本检查
  - 撤销/重做
  - 时间桶聚合
  - 时间范围二分查找
  - 导入面板
  - 检查器
  - 导出摘要
  - 删减标记编辑
  - 快捷键
  - 时间轴工具切换
  - 片段剪切、合并、删除快捷键
  - 时间轴缩放对数映射
  - 对齐 proposal 解析校验
  - 对齐 proposal 时间轴预览模型
- 已验证命令：
  - `corepack pnpm install` 成功
  - `corepack pnpm lint` 成功
  - `corepack pnpm build` 成功
  - `corepack pnpm test` 成功，当前 12 个测试文件、26 个测试通过
  - `corepack pnpm test:e2e` 成功，当前 1 个 Chromium E2E 测试通过
- 已生成截图：
  - `artifacts/screenshots/empty-project.png`
  - `artifacts/screenshots/imported-project.png`
  - `artifacts/screenshots/timeline-editing.png`
  - `artifacts/screenshots/cut-marker.png`
  - `artifacts/screenshots/export-dialog.png`
- 已人工查看 `imported-project.png`、`cut-marker.png`、`export-dialog.png`，未发现明显空白、遮挡或布局崩坏。

## 关键决策

- 首版项目文件选择嵌入解析后的 XML 弹幕数据，不嵌入视频内容。
- 视频只保存本地媒体引用和文件名，浏览器对象 URL 不写入项目文件。
- 原始 XML 和 `DanmakuItem.sourceTimeMs` 不直接修改。
- 禁用弹幕使用 `disabledItemIds` 表达，保留原始 item。
- 单条弹幕时间调整使用 `itemTimeAdjustments` 表达。
- 内部时间统一使用整数毫秒。
- 导出 XML 前必须重新解析验证。
- 当前视频适配器为 `HtmlVideoMediaAdapter`，只承诺浏览器可播放 MP4/WebM。
- `NativeMpvMediaAdapter` 只是未来接口占位，不伪造 MKV 支持。
- 撤销/重做使用项目快照命令历史，历史上限 120。
- 时间轴主要内容使用 Canvas 2D 绘制，不为每条弹幕创建 DOM。
- pnpm 在当前环境使用 `corepack pnpm ...` 调用固定版本 `pnpm@9.15.4`，因为全局 pnpm 版本要求 Node 22.13。
- 当前 PowerShell 执行策略会拦截 `pnpm.ps1`，直接 `pnpm ...` 可能失败；`corepack pnpm ...` 可用。

## 已知的问题

- 当前全局 pnpm 版本可能仍要求更高 Node 版本；项目内建议继续使用 `corepack pnpm ...`。
- 安装包未签名，Windows 首次安装或运行时可能显示 SmartScreen 提示。
- Playwright E2E 仍主要覆盖核心冒烟流程；保存项目、重新打开项目、导出后重新导入、复杂编辑撤销等场景仍需扩展。
- 小窗口、文本溢出、弹窗遮挡等视觉适配仍需要持续截图检查。
- 当前项目只处理用户主动导入的本地文件和用户授权访问的 Emby 元数据；不实现视频下载、DRM 绕过、账号绕过或未授权媒体访问。
- 对 B 站删减导致的非线性时间轴错位，目前已有产品路线，尚未实现完整删减补偿和自动音频/视频对齐工具。

## 未完成的待办

1. 删减补偿基础能力：
   - 在领域层新增非破坏性 `insertGap` / 缺失时长规则。
   - 在批量分集合并前应用补偿后的时间映射。
   - 在 UI 中提供手动添加、编辑、删除补偿点的面板。
   - 导出时输出补偿报告，方便复核。
2. 疑似删减点辅助发现：
   - 扫描弹幕文本中的“删、剪、跳、和谐、没了”等词。
   - 按时间窗口聚类并展示候选删减点。
   - 支持一键把候选转换为待确认补偿规则。
3. 锚点校准：
   - 支持用户输入“源弹幕时间 -> 完整片源时间”的对应点。
   - 根据两个或多个锚点推断中间缺失时长。
   - 在时间轴上预览补偿影响区。
4. 本地音频/视频对齐原型：
   - 先做独立 CLI 或脚本，输入两个用户本地合法视频，输出删减规则 JSON。
   - 优先音频对齐：FFmpeg 抽音频特征，使用动态规划/DTW 找到缺失段。
   - 视觉对齐作为补充：抽帧、感知哈希/ORB、候选区精扫。
   - 后续再接入 Tauri UI，作为“视频对齐实验室”。
5. 验证与体验：
   - 扩展 Playwright E2E 覆盖保存/打开项目、导出后重新导入、撤销恢复、小窗口截图。
   - 持续检查打包程序中的 Emby、ZIP 导出、长合集切分和未来补偿规则交互。
   - 更新 README，把 Emby、ZIP 导出、删减补偿路线和当前限制写清楚。
