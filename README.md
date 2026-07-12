# Danmaku Timeline Studio

Danmaku Studio 是一个把 B 站 XML 弹幕对齐到本地视频、处理不同视频版本时长差异，并导出新 XML 的桌面工具。它不会改写原始 XML，所有编辑都会以片段、偏移、版本差异、禁用和单条调整等非破坏性规则保存。

## 当前能力

- 在素材页一次多选导入多个 B 站参考视频、多个目标原片和一个或多个 Bilibili XML，并把每个 XML 绑定到对应参考素材。
- 匹配页直接对项目素材运行 1×N、N×1 或 N×M 批量匹配；项目级全局分配会阻止参考/原片区间冲突，并保留重复内容的竞争候选。
- 当前这条 N×M 主链会先展开所选参考素材与原片的笛卡尔积，逐 pair 串行运行 Alignment V2，再对每个 pair 的最佳候选做项目级全局分配；它不是并行任务，也不是 GPU 批处理。Alignment V2 对单个媒体仍有 60 分钟 PCM 硬上限，所以超过 60 分钟的单文件长合集尚不能作为完整参考直接进入当前 V2。
- Alignment V2.1 已把 PCM、landmark 和 50ms 细特征合并为同一媒体/音轨制品：冷 pair 的每个主音轨只调用一次 FFmpeg，landmark 与细特征共用一次声谱 FFT 遍历；进程内以 768 MiB 按字节 LRU 跨 pair 复用制品，自动多音轨超过 1 GiB 单任务预算会在首个解码前阻断，native 同时只允许一个重型普通对齐任务。这减少了重复解码和重复 FFT，但每个 pair 的全文件身份/FFprobe、笛卡尔积粗匹配、DP 与 60 分钟上限仍待 batch/流式索引阶段解决。
- 匹配评分：基于目标绑定、片名/季集、时长差、弹幕密度、同步线索和已有音频/视觉提案诊断，给出“很可能匹配 / 需要确认 / 看起来不是同一集”的可解释结论。
- 把 XML 弹幕素材放入时间轴，支持按顺序自动排列。
- 看视频预览和时间轴，移动片段、微调弹幕、禁用弹幕或调整全局偏移。
- 遇到当前视频和完整版时长不一致时，用“版本差异”说明哪里多了或少了多久。
- 导出前通过“导出前检查”确认是否可以导出、哪里需要处理、哪个按钮可以修。
- 导出合并后的 Bilibili XML；多分集导出会打包为按项目名命名的 ZIP，导出前会重新解析验证 XML。
- Canvas 2D 时间轴：播放头、缩放、横向滚动、片段、版本差异、同步线索、对齐候选、疑似版本差异文本候选、密度热力图和弹幕事件。
- 非破坏性编辑：移动片段、移动弹幕、禁用弹幕、全局偏移、版本差异映射、同步线索和单条时间调整。
- 高级工具默认收起：旧单对单路径实验室已经退役；只保留手工 JSON 的只读诊断、疑似版本差异扫描和锚点校准等兼容工具，自动媒体分析只有匹配页一个入口。
- Alignment Engine V2：在 Tauri 桌面端读取媒体 PTS 和候选音轨，使用声谱 landmark Top-K、仿射 offset/scale、edit-aware 分块 DP 与局部相关边界精修，输出 `matched/sourceOnly/targetOnly/ambiguous` 分段时间图；无共同音轨时可独立使用绑定视频流 PTS 的视觉 DCT/梯度回退。候选最高进入人工复核，不会静默写成已验证。
- 匹配页双源 A/B 复核：按 TimeMap 切换参考 A/原片 B、循环共同内容或差异边界，并把累计有效试听写成 `manual-playback-review:v2` 证据。共同内容要求 A/B 各有效推进 2.0 秒且唯一覆盖至少 1.5 秒；单侧差异的存在侧要求 2.0/1.5 秒，段首和段尾的 A/B 边界各要求 1.5/1.0 秒。短区间要求累计完整区间时长并唯一覆盖至少 80%。只有页面可见、1 倍速且媒体时间连续向前推进才计入；暂停、后台、停滞、seek、切轴和循环跳回均不计时。token 绑定策略版本、媒体、span、有效时长和覆盖摘要；旧 v1 token 只保留审计文本并 fail-closed。
- 可持久人工验证：只有用户显式点击“完成复核并签发”且每个 span 都有当前播放证据、所有单侧差异已分类、没有 `ambiguous`、实测质量达到中央门槛时，桌面端才用安装级 HMAC-SHA256 密钥签发 v11 verification record。签发、撤销和项目打开后的复核都查询本机不可变事件注册表；自动匹配、接受关系和保存项目不会自动签发。
- 真实媒体基准治理：benchmark manifest v2 区分 `development/frozen-test` 和 `real/synthetic/placeholder`，真实关系必须绑定全文件 SHA-256、显式音视频流、许可/版本说明、两份独立标注和必要的第三人仲裁。本地 preflight 会重新探测唯一媒体文件并核对身份与流索引；可分享结果移除本地路径和单媒体实测哈希等直接字段，但保留 manifest/dataset ID 与稳定摘要，因此同一数据集及其多次运行仍可被关联，不是匿名化产物。
- 匹配页底部默认收起“高级：C137 精度基准（开发与验收）”，这是唯一真实 benchmark 执行入口：只选择 manifest JSON，不重复选择媒体路径；桌面端可运行、取消并下载移除直接媒体标识的稳定报告。浏览器、example manifest 或 0 个 `mediaKind=real` 关系都会明确阻断。报告固定为 `scope=time-map-component`、`releaseEligible=false`，组件子闸门通过也绝不代表 release 通过；界面中的“协调器观测耗时”只是流程诊断，不是性能证据。
- 同一高级区复用已导入 manifest 和其媒体引用，不增加第二个文件或路径选择器；它可取得 native exclusive session，按预注册的 cold → warmup → hot → cancel 计划运行生产对齐核心，并导出 strict raw v2 性能工程证据。session 在任何工具探测前固定 blind manifest 中的全部真实媒体，只对每个 distinct 文件计算一次完整 SHA-256，并从固定句柄解析实际媒体卷；raw v2 保存不含路径、卷 GUID/serial 或单媒体 SHA 的 `workloadStorage` 回执。`runManifestDigest`、`mediaSetDigest` 等稳定摘要仍会保留，用于证据绑定，也允许关联同一数据集的多次运行。raw 同时包含原生单调时钟、显式阶段、缓存重置/命中、ToolHelp 进程树 RSS 和取消终态，但始终是 `releaseEligible=false` 的 `untrusted-raw-evidence`，不内置受信协议或 trust root。
- Windows 一次性媒体工具进程已统一进入 lifecycle Job Object：子进程以挂起状态创建，先加入私有 Job 再恢复执行，Job 启用 kill-on-close，且只继承显式标准流句柄。FFmpeg/FFprobe 的输出、执行、收尾均有硬上限；取消、超时、输出溢出、读取异常或后代未退出会终止并等待整个 Job 清空，无法可信清理时设置粘性 `blocked:process-cleanup`，使当前结果及后续媒体分析 fail-closed。该 Job 只负责生命周期安全，不是下述正式 RSS 采样器。
- FFprobe 普通媒体时间线探测限制为 30 秒、8 MiB stdout / 256 KiB stderr；音频逐帧/packet PTS 探测限制为 5 分钟、128 MiB 紧凑 stdout / 1 MiB stderr，并且只在 Job 全部退出后解析，单条记录上限 1 MiB、不同音频流上限 256。Chocolatey `ShimGen` 不会被当作 FFmpeg/FFprobe 真二进制执行或指纹化：只有规范 Chocolatey 路径、版本资源和候选树检查全部通过且恰好找到一个真实 exe 时才继续，并对该真实 exe 固定、哈希和执行；路径、reparse/symlink、版本资源或唯一性验证失败均关闭执行并要求显式配置真实路径。
- Windows 本地对齐还会为参考视频和目标原片各持有贯穿整个 run 的 `FILE_SHARE_READ` 只读 media lease，运行期间拒绝覆盖、删除、rename 和路径替换。lease 内先计算 run-start 全文件 SHA-256；FFprobe frame/packet PTS 的 expected / before / after 三份身份必须完全一致；音频、landmark 和视觉缓存键全部绑定 `sha256-full-file-v2`；FFmpeg 成功后会在解析 PCM/帧前复核身份；命中缓存也必须通过 run-final SHA 与 TimeMap 双端身份复核。视觉证据在读取缓存或解码前后都必须与音频 TimeMap 同一媒体世代，避免把音频 A 与视觉 B 混为一条结论。
- 有界输出 reader 状态机只在根进程已退出、Job 已空且 stdout/stderr 两份结果都就绪后消费缓冲，不再因轮询时过早 `take()` 丢失先完成的流。取消也覆盖工具退出后的 CPU 解析：媒体 JSON 在反序列化前后、逐流归一化时检查，frame/packet compact 输出逐记录检查，V2 PCM 每 64 Ki samples、legacy PCM/频谱每 4 Ki samples、视觉帧逐帧检查；取消后不会返回部分 snapshot、缓存或 proposal。
- Emby 时长辅助与目标绑定：通过设置中心保存非敏感连接项，桌面端优先写入 Tauri 应用配置目录，网页模式使用 localStorage fallback；资源栏搜索用户授权的 Emby 媒体条目、导入真实集时长规则，并可把条目绑定为当前项目目标原片，本次会话密码只保存在内存。
- 设置中心：支持保存、恢复默认、清除本地设置，管理默认导出目录、FFmpeg/mpv 路径、播放器后端偏好，以及导出/导入不含密码或 token 的版本化应用设置备份。
- 默认导出目录：设置中心可保存本机默认导出文件夹；导出弹窗可为本次导出临时选择其他目录。桌面端会把单集 XML、分集 ZIP 和报告写入指定目录，网页模式保留浏览器下载。
- 导出前检查：提示重复 ID、缺失资源引用、负最终时间、空片段、媒体重连、导入警告、低置信同步线索和失效编辑引用等保存/重开/导出前风险；技术指标默认放在“诊断详情”里，可下载按项目名命名的检查报告。
- 保存和打开 `.danmaku-project.json` 项目文件。
- 播放预览：HTML Video 作为 MP4/WebM 轻量 fallback；桌面端配置 mpv 且目标原片有真实本地路径时可切到 mpv sidecar，绑定 Emby 目标原片时也可显式生成本次会话授权流交给 mpv 预览。预览会显示未导入、正在载入、可播放、格式不支持和需要重新连接等状态，支持播放/暂停、seek、弹幕叠加、透明度调整，并可在当前播放点直接标记版本差异。播放器会话状态栏会统一展示播放源、后端、播放状态、真实 mpv 音轨/字幕轨、弹幕轨、缓存和下一步操作；双源对比状态会展示 B 站参考侧、目标原片侧、当前参考时间、映射后的目标时间和已应用补偿；播放可靠性状态会展示 240ms 内同步目标、当前缓存边界和可执行恢复动作，不把尚未接入的能力伪装成可用。
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
corepack pnpm lint
corepack pnpm audit:source
corepack pnpm verify
corepack pnpm verify:release
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

当前 `HtmlVideoMediaAdapter` 只可靠支持浏览器原生可播放的 MP4 和 WebM。`TauriMpvMediaAdapter` 需要 Tauri 桌面端、用户配置的 mpv 可执行文件路径，以及用户主动选择的真实本地媒体路径；满足这些条件时会启动 mpv sidecar，通过 IPC 同步播放、暂停、seek、倍率和播放位置。未配置 mpv 或只有浏览器 blob URL 时，不会宣称支持 MKV。

## 项目文件策略

`.danmaku-project.json` 保存项目 schema、媒体引用、目标原片绑定、逐集目标绑定、弹幕来源内容段、XML 资源元数据、解析后的弹幕数据、片段、版本差异、同步线索、禁用弹幕、单条时间调整、对齐提案、时间轴视图和预览设置。视频内容不会嵌入项目文件；用户主动选择的本地目标原片路径会作为媒体引用保存，用于桌面端 mpv 重连。

当前项目文件 schema 为 v11。v7 引入多媒体库与 XML→参考素材绑定，v9 引入批量媒体候选，v10 引入四类分段 `MediaTimeMap`，v11 为 `verified` 增加绑定时间图 SHA-256 核心摘要、revision、双端媒体身份、人工复核摘要和签发来源的验证记录。v11 的 record v2 保存 HMAC 签名元数据与撤销审计，但安装级 secret 和权威撤销注册表只保存在 Tauri 应用本地数据目录，不进入项目文件。打开 v1-v10 项目会确定性迁移；旧时间规则只会成为 `legacy-unverified/blocked`，v1 未签名人工记录和没有可信来源的旧 `verified` 会降为 `review`。保存前会再次做完整 schema 与反向引用校验。

`fixtures/projects/three-part-demo.danmaku-project.json` 有意保留为 v8 迁移回归样例，不代表当前保存格式。

`mediaBinding` 只保存恢复绑定所需的非敏感信息。本地绑定保存媒体 ID、文件名、显示名和用户主动选择的本地路径引用；Emby 绑定保存条目 ID、剧名、季集号、媒体源摘要、运行时长和服务器配置引用。Emby 密码、访问 token、临时播放 URL、本地视频对象 URL 和视频内容都不会写入项目文件。

`seasonEpisodeBindings` 复用同样的非敏感目标原片摘要，并按稳定分集 key 保存到项目文件；它用于恢复“这一集对应哪份目标原片”，不保存视频内容、密码、token 或 Emby 临时播放 URL。

`danmakuSourceSegments` 只描述弹幕来源时间轴：哪些 B 站/XML 时间范围对应正片输出集，哪些范围是前后无意义片段或空白。它不表示视频切割任务，不保存剪切结果，也不会改写视频文件。

打开项目时会校验弹幕资源、片段、版本差异、同步线索、目标原片绑定、整数毫秒时间字段、预览设置和时间轴视图，避免坏的非破坏性规则进入运行时状态。

资源栏“导出检查”会基于当前运行时状态生成导出前检查摘要，用于在保存、重开或导出前快速复核媒体重连、目标原片重连、空片段、导入警告、重复 ID、负最终时间和失效引用；重复 ID、缺失资源片段、未放入时间轴资源、全部禁用片段、空片段、0ms 版本差异、媒体重连、目标原片重连、导入警告、低置信同步线索、失效编辑引用与负最终时间会显示出现位置并写入可下载检查报告。缺失资源片段、失效禁用/单条微调引用可通过真实清理动作进入历史栈，仍可撤销。
导出 XML 前会复用导出前检查中的阻断项，避免结构错误项目静默导出不完整结果。

首版选择把解析后的 XML 数据嵌入项目文件，优点是重新打开项目不依赖原 XML 路径；缺点是大项目文件体积会增加。后续可增加“外部引用 + 缺失文件重连”模式。

## 常用操作

- 顶部工具栏：新建、打开、保存、素材/匹配/编辑/导出四页导航、撤销、重做、新手引导和设置；播放、暂停与缩放只在编辑页出现。视频、XML 的导入只在素材页操作，XML/ZIP 的实际导出只在导出页操作。
- 四页工作流：素材页分别管理原片素材、B 站参考素材和弹幕 XML 三类输入；匹配页负责 1×N、N×1、N×M 批量匹配、全局分配和双时间轴复核；编辑页负责精修；导出页只消费已保存、已完成复核且通过质量闸门的时间图。
- 右侧检查器：编辑当前弹幕、片段或版本差异；空白时会提示选中不同对象后能做什么。
- 底部时间轴：点击或拖动播放头，滚轮横向滚动，Ctrl/Command + 滚轮缩放，拖动片段或弹幕。
- 导出摘要：查看导出前检查、版本差异数量、累计调整时长、版本差异明细、负时间限制明细、验证状态，并在需要时下载检查报告和导出报告。
- 导出目录：设置中心保存默认目录；导出摘要里可选择本次目录、改回浏览器下载，并在导出完成后从状态栏打开目录。

## 推荐流程

1. 在素材页分别批量导入多个原片、一个或多个 B 站参考视频和对应弹幕 XML，再把每个 XML 绑定到它所属的参考素材；导入后不需要在后续页面重新选择路径。
2. 进入匹配页，按实际素材关系选择 1×N、N×1 或 N×M 组合并开始批量匹配；系统只生成候选，不会静默写成已验证关系。
3. 逐项复核候选的参考范围、原片范围、共同内容、双方独有内容和无法判断区间。未完成真实基准校准或人工复核的关系只能保存为待复核，不能用于正式导出。
4. 在编辑页预览已保存关系，并用片段、偏移、版本差异、锚点或单条调整精修弹幕投影；所有修改保持非破坏性。
5. 在导出页按原片分集检查来源范围、删减修正、弹幕数量和阻断原因；只有已验证且通过质量闸门的时间图才能进入正式分集导出。
6. 一键导出全部分集 XML 或 ZIP。每份导出 XML 都会重新解析验证，原始 XML 始终不被直接修改。

## 快捷键

- `Space`：播放或暂停。
- `Ctrl/Command + Z`：撤销。
- `Ctrl/Command + Shift + Z`：重做。
- `Delete`：禁用选择项。
- `ArrowLeft` / `ArrowRight`：微调 10ms。
- `Shift + ArrowLeft` / `Shift + ArrowRight`：微调 100ms。
- `M`：在播放头标记版本差异。
- `F`：缩放到全部内容。
- `+` / `-`：缩放时间轴。

## 已知限制

- 开发者构建桌面安装包依赖本机 Rust/Tauri 构建环境；最终用户运行安装包不需要这些开发工具。
- 当前 Windows 安装包未签名，首次安装或运行时可能出现 SmartScreen 提示。
- mpv 后端当前以桌面 sidecar 方式运行，不把 mpv 画面嵌入 React 预览区；未配置 mpv 或没有真实本地路径时，界面不会假装支持 MKV。HTML Video 播放失败时会明确提示改用 MP4/WebM 或启用 mpv 播放器。
- V2 媒体分析依赖用户主动导入且合法拥有/授权读取的本地媒体，以及本机 FFmpeg/FFprobe。网页模式不伪装为可执行高精度媒体分析或写盘前身份核验。
- 当前 V2 已有 PTS、多音轨、声谱 landmark、速度漂移、双向编辑、局部边界和独立视觉回退的工程实现，但真实冻结集样本数仍为 **0**，benchmark manifest v2 示例只有 placeholder。尚未完成统计概率校准、规定硬件性能报告或 20 套北极星长合集 5/5 验收。自动结果最高为 `review`；正式按原片分集导出只接受带可信验证来源的 `verified` 时间图。因此本阶段 release 是安全预览，不代表准确率或性能验收完成。
- 当前媒体匹配主链仍为 FFmpeg `-vn` 音频解码加 Rust CPU radix-2 FFT、landmark、edit-aware DP 与相关精修；上述共享声谱与制品 LRU 只是在 CPU 路径消除确定性的重复工作，安装包依然没有 CUDA/cuFFT 计算后端，NVIDIA GPU 不会参与主匹配。下一步把 PTS、粗特征和 landmark 改为每媒体一次的流式索引，用 Top-K 粗筛减少进入精对齐的 pair，再接入带 CPU 等价校验和自动回退的可选 CUDA/cuFFT 后端；NVDEC 只适合视觉回退的解码阶段，不能替代音频计算后端。
- 视觉回退目前只建立粗粒度全局仿射关系，不负责宣称局部删减边界；大幅裁切、极端调色、长静态或黑场会保守阻断。
- A/B 播放证据 v2 已累计最小时长与唯一覆盖，但它只证明完成了规定的有效试听过程，不能单独证明人工判断正确。签发仍同时要求逐段分类、无 ambiguous、媒体身份和中央质量门槛。
- 完整 C137 acceptance 还要求 `real-frozen` 证据包、固定协议、全部原始报告、UI/性能/release 回执及独立信任根。当前 `trustContext` 只是调用方提供的摘要快照，可发现内容变化但不能证明签发者身份；release 默认不内置审批白名单，`external-trust-authority` 会保持未完成，直到存在可独立验证的签名或受信封装。因此当前结果必为 `incomplete-evidence`、`verifiedEligible=false`，不能通过完整验收。
- C137 acceptance protocol v3 / performance report v3 明确要求 raw schema v2，并分别检查当前冻结 manifest、`workloadStorage`、Job 内存覆盖、终态清理和 native attestation。统计报告还必须逐项闭合：每个冻结 decision 恰好提供协议锁定的 Top-K，校准样本与全部冻结 decision 一对一并从排名重算 `correct`，dataset 的 gold 编辑数逐 case 等于 TimeMap 原始事件数，所有 frozen time-stretch case 均提供 45 分钟漂移；跨报告的 mediaKind/split/scenarios 不一致同样失败关闭。实际 workload 媒体卷现已由 native v2 固定句柄逐卷探测并形成可复算回执；旧 raw v1 即使改写 sampler/storage 字符串并重算所有自摘要也不能晋级。当前 RSS 仍是 `windows-toolhelp-working-set-v1`，raw v2 的 Job memory、terminal cleanup 与 attestation 三项 assurance 仍为空，所以正式门禁继续返回 `incomplete-evidence`。后续还需实现诚实限定覆盖范围的 Job working-set receipt、原生终态清理 receipt 与独立外部 attestation，再在受信协议和真实授权数据上采集。
- 人工签名的信任根是本机应用数据目录中的安装级 secret 与撤销注册表。仅篡改 `.danmaku-project.json` 不能伪造签名或恢复已撤销凭据；项目换机、secret 丢失、注册表损坏或签发来源不匹配时会 fail-closed 为 `review`。该设计不宣称抵抗能够读取并篡改同一系统账户应用数据目录的恶意本地进程。
- Emby 集成只处理用户配置且有权限访问的媒体库元数据，不实现视频下载、DRM 绕过、账号绕过、私有接口爬取或未授权媒体访问。
- Emby 密码和 token 不写入项目文件、Tauri 配置文件或 localStorage；本次会话密码关闭应用后失效。
- 默认导出目录只保存在本机应用设置里，不写入项目文件或导出的 XML/ZIP/报告内容。
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

- 完善音频对齐实用化：把进程内特征缓存扩展为可管理的持久缓存；用真实 Emby 服务器样本继续验证不同媒体源、转码策略和低码率采样兼容性。
- 把当前逐 pair 串行 N×M 改为“每媒体一次流式预处理/长参考索引 → 全部 pair 的低成本 Top-K 粗筛 → 只对候选关系运行精对齐”，取消单文件长参考的 60 分钟整段 PCM 依赖；随后增加可选 CUDA/cuFFT 声谱和批量相关后端，CPU 保留为确定性基线、等价复核与自动回退。
- 完善 mpv 体验：嵌入式窗口、自动重试、更多错误诊断，以及更多真实 Emby 服务器、转码策略和网络失败场景验证。
- 扩展播放器化能力：把当前会话级缓存状态升级为可管理的持久缓存，并补充更多剧集批量工作台自动化。
- 建立双人标注的真实冻结媒体集，完成关系、投影误差、删减边界、视觉回退、校准与性能门槛；门槛通过前不开放自动 `verified`。
- 用真实媒体继续审计 A/B 播放证据 v2 的时长/覆盖门槛与签发误用率，并根据审计结果版本化调整策略。
- 在现有 lifecycle Job Object 之上实现不虚报覆盖范围的 Job working-set receipt，替换性能 raw 中的 ToolHelp/PID 快照；补齐终态 cleanup receipt 与独立 native attestation，并在受信协议下使用真实授权数据生成可审批的正式性能证据。
- 完成 20 套北极星长合集的 5/5 定位、跨集零错配和完整导出验收，并发布规定硬件上的可重复性能报告。
- 扩展 Playwright E2E 覆盖导出 XML 后重新导入、复杂编辑撤销恢复和更多窄窗口截图。
- 评估系统凭证库保存敏感凭证，并在后续设置 schema 升级时补充迁移界面和冲突提示。
