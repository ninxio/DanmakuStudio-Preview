# 架构概览

Danmaku Timeline Studio 使用非破坏性编辑模型。原始 XML 解析为资源，资源放入时间轴后成为片段，所有时间调整、禁用、版本差异映射和单条微调都作为编辑状态保存，不修改 `DanmakuItem.sourceTimeMs`。

## 分层

- `src/domain`：纯领域逻辑，不依赖 React。包含弹幕模型、XML 无关的时间计算、时间桶索引、项目 schema、历史命令、对齐扩展接口。
- `src/infrastructure`：浏览器文件、媒体适配器、XML 解析/序列化、项目持久化。
- `src/stores`：Zustand 编辑器状态和命令入口。
- `src/features`：业务 UI，包含导入、导出、资源、预览、检查器和时间轴。
- `src/components`：通用 UI 组件。
- `src-tauri`：Tauri 2 桌面壳配置。当前 Web Demo 使用浏览器文件 API，桌面模式后续可替换为原生文件系统能力。

## 时间模型

内部统一使用整数毫秒。最终弹幕时间由纯函数计算：

```ts
clipRelative = item.sourceTimeMs - clip.sourceInMs
clipTime = clip.timelineStartMs + clipRelative + clip.localOffsetMs
adjusted = clipTime + itemAdjustments[item.id] + project.globalOffsetMs
resolved = applyCutMapping(adjusted, cutMarkers)
```

版本差异表示“当前视频播放到某点时，完整版额外存在或少了一段内容”。对于该点之后的弹幕，累计 `targetGapMs`。

## 历史模型

编辑历史使用命令快照模型。每次核心操作保存编辑前后的轻量项目状态，历史上限为 120 步。支持移动片段、移动弹幕、禁用/恢复、版本差异、同步锚点和全局偏移。

## 目标原片绑定

项目 schema v4 新增 `mediaBinding`，v5 新增 `seasonEpisodeBindings`，v6 新增 `danmakuSourceSegments`，v7 新增 `mediaLibrary` 和 `danmakuSourceBindings`，把多条媒体素材、XML 到 B 站参考素材的绑定、来源段到参考素材/目标原片的关系统一改为稳定 ID 引用。v9 新增批量 `mediaMatchCandidates`；v10 新增正式 `mediaTimeMaps`；v11 新增验证来源记录，防止项目 JSON 仅靠自报指标取得 `verified`。绑定、来源时间轴和时间图模型位于 `src/domain/project` 与 `src/domain/alignment`，不依赖 React。

`mediaLibrary` 是项目级媒体素材库，每条素材都有稳定 ID、角色、名称、文件名或媒体名、时长、引用类型、连接状态和来源摘要。当前角色包括：

- `targetOriginal`：原片素材，是弹幕最终要匹配到的标准时间轴。
- `bilibiliReference`：B 站参考素材，是 XML 原始弹幕时间轴的证据，不是最终输出目标。

持久关系不得依赖数组索引、文件名或 UI 顺序：`mediaBinding.mediaId`、`danmakuSourceBindings.sourceMediaId`、`danmakuSourceSegments.sourceMediaId` 和 `danmakuSourceSegments.targetMediaId` 都引用 `mediaLibrary` 中的稳定 ID。浏览器 `blob:` 对象 URL 只允许当前会话使用；保存项目时会清空对象 URL，并把浏览器文件素材标记为 `needsReconnect`，重新连接时更新原媒体 ID，不创建重复素材。

当前支持两类绑定：

- `localFile`：保存当前本地媒体引用的媒体 ID、显示名、文件名、运行时长，以及用户主动选择的本地路径引用。项目文件不保存浏览器对象 URL 或视频内容；如果只有浏览器对象 URL，重开项目后会由导出前检查提示需要重新连接。如果保存了真实本地路径，桌面端 mpv 后端可用该路径重新播放。
- `embyItem`：保存用户授权 Emby 媒体库中的条目 ID、标题、剧名、季集号、媒体源摘要、运行时长和服务器配置引用。项目文件不保存 Emby 密码、访问 token 或临时播放 URL。

Emby 绑定只代表“这个项目对应哪一集、哪个媒体源”，不等于已经具备播放授权流或下载能力。需要重新验证 Emby 条目时，UI 会通过当前应用设置和本次会话密码重新登录并读取条目元数据，失败时向用户提示需要重新连接。

`seasonEpisodeBindings` 的 key 由 `src/domain/project/seasonEpisodeBinding.ts` 根据批量输出的季集号或文件名生成。资源栏高级工具的“逐集目标绑定”只把当前项目级目标原片复制为某个输出集的目标引用；清除和更新都进入编辑历史。它不改变原始 XML，不影响批量导出的弹幕内容，也不保存 Emby 密码、token 或临时播放 URL。

`danmakuSourceBindings` 表达每个 XML 当前绑定的 B 站参考素材。XML 可以不绑定、绑定、更换或解除绑定；这些操作只修改项目关系，不修改原始 XML 或弹幕时间。未绑定 XML 仍可编辑，但来源段匹配会显示风险提示。

`danmakuSourceSegments` 由 `src/domain/project/sourceTimeline.ts` 维护。schema v7 后，每段明确记录所属 XML、B 站参考素材、来源起止时间、正片/忽略类型、目标原片和可选输出集 key。正片内容段可以指向目标原片；忽略范围不要求目标原片。新增、更新和删除都进入编辑历史。它不剪切视频、不改变原始 XML，后续弹幕投影和分集复核应读取这些虚拟范围作为证据边界。

schema v10/v11 下，自动候选先保存 candidate `MediaTimeMap`，接受后复制为独立 confirmed revision，来源段只通过 `timeMapId` 引用它。正式投影只读取 confirmed map：`matched` 使用整数端点有理插值，`sourceOnly` 明确舍弃参考独有弹幕，`targetOnly` 推动后续目标边界，`ambiguous` 阻断导出。旧 `targetStartMs + timingRules` 只用于迁移兼容，不能消费 V2 结果。

`verified` 需要 v11 verification record 精确绑定规范化 map SHA-256 摘要、revision、双端全文件 SHA-256 身份、复核证据摘要和签发来源；当前自动 calibration 白名单为空。规范化 map 摘要覆盖 spans、指标、非运行时 reasons/notes 和引擎 provenance。媒体身份由 Rust 从同一文件句柄流式计算，并在分析前后、导出预检和 native 写盘前重复核验。任何缺失、替换、竞态或 provenance 不一致都会安全降级或阻断。

### 人工播放证据与签发信任链

匹配页的双源 A/B 复核通过 `src/domain/alignment/timeMapPlaybackReviewEvidence.ts` 保存 `manual-playback-review:v2` token。token 只统计媒体适配器真实播放期间的进度，记录 span 索引、证据 mask、有效播放时长、覆盖时长和复核时间；其中 `spanDigest` 绑定双端媒体 ID、span kind 与四个整数毫秒边界。`matched` 要求 A/B 两轴各达到 2000 ms 有效播放与 1500 ms 覆盖，单侧差异的内容段同样要求 2000/1500 ms，并分别复核段首、段尾两侧边界各 1500/1000 ms；短于门槛的区间会按实际长度收敛要求。边界、kind 或媒体 ID 改变后读取函数不会承认旧 token，v1 token 也不会被迁移为有效证据。

人工签发入口位于 `src/domain/alignment/mediaTimeMap.ts`、`src/infrastructure/media/manualVerificationAuthority.ts` 和 `src-tauri/src/manual_verification.rs`。领域预检要求 confirmed map、完整媒体身份、每个 span 的当前播放 token、每个 `sourceOnly/targetOnly` 的对应人工分类、无 `ambiguous`，且中央实测质量达到 `verified` 门槛；`reviewEvidenceDigest` 由 map ID/revision、分类记录、播放证据、复核者和完成时间确定性重算，UI 不能自由传入摘要。只有匹配页的明确用户动作调用 native 签发，自动分析、接受候选、保存和打开项目均不会签发。

native 验证机构首次使用时在 Tauri 应用本地数据目录生成 256-bit 安装级 secret，以 HMAC-SHA256 签发规范化请求。签发和撤销使用递增序号写为不可变事件文件，先写临时文件并 `sync_all`，再原子 rename；项目 JSON 只保存 record v2 的 verification ID、issuer key ID、序号、请求摘要、签名和可读撤销回执，不保存 secret 或权威注册表。撤销后的项目即使删掉 JSON 内回执，本机注册表仍返回 revoked。

项目打开时，signed record 先确定性降为 `review`，再异步查询本机签发/撤销注册表；只有签名、请求摘要和 active 状态全部通过才恢复 `verified`。恢复结果按 map ID/revision/verification 输入合并，并受 `projectEpoch` 保护，不能覆盖项目切换或核验期间的其他编辑。项目换机、安装级 secret 丢失、注册表损坏或 issuer 不匹配一律 fail-closed；未受信的外机记录仍可随匹配关系撤销并保留为 superseded 审计，不能造成操作死锁。

这一信任边界防止只编辑 `.danmaku-project.json` 伪造、恢复或移植 `verified`，不等于操作系统级密钥保险箱：当前 secret 与事件注册表依赖应用本地数据目录及系统账户权限，不宣称抵抗能够读取并改写同一账户应用数据的恶意本地进程。

### Windows 媒体工具生命周期监管

`src-tauri/src/process_supervision.rs` 是一次性媒体工具的共同进程所有者。Windows 实现直接以 `CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT` 创建子进程，显式继承列表只包含 stdin/stdout/stderr；随后把仍处于挂起状态的直接子进程加入私有、启用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object，再恢复主线程。FFmpeg/FFprobe 的版本探测、音频/视觉提取、媒体 PTS 探测，以及受控的系统工具探测都使用这条链路；长驻 mpv sidecar 不属于这个一次性命令执行器。

stdout/stderr 由独立读取线程按调用方硬字节上限保留。正常返回必须同时观察到根进程退出、Job 的 `ActiveProcesses=0` 和两条输出流收尾；取消、超时、输出溢出、I/O/等待异常会 `TerminateJobObject` 并在有界期限内确认 Job 清空。读取线程若未在 drain deadline 内退出，会对其精确线程句柄调用 `CancelSynchronousIo` 后再次有界等待。任一 Job、进程或 reader 无法可信收尾都会转为粘性 `blocked:process-cleanup`；当前对齐结果作废，后续普通对齐和 benchmark session 也保持 fail-closed，benchmark lease 不会被误释放。

reader 状态机保留先完成的流，不会在 refutable tuple pattern 中提前取走 stdout/stderr；只有根进程 exit code、Job 空状态和两条完整 reader result 同时就绪时才一次性消费缓冲。这修复了并发媒体分析中“第一条流已完成、另一条仍在读取”时错误报告 channel disconnected 的竞态，并由 staggered stdout/stderr 与真实 FFmpeg 并发回归覆盖。

`align_audio_files_with_progress` 在任何媒体探测前为 source/target 各打开一个 Windows `FILE_SHARE_READ` 只读句柄，两个 media lease 贯穿 run-start identity、FFprobe、缓存、FFmpeg、视觉 fallback、TimeMap 生成和 run-final identity；持有期间写入、删除、rename 与路径替换均被 Windows sharing contract 拒绝。run-start 与 run-final 使用 `sha256-full-file-v2`，成功 proposal 若带 TimeMap，还必须让 TimeMap 内的 source/target identity 与这两个 run identity 严格相等。该 lease 关闭 A→B→A 路径替换绕过起止哈希的窗口；它是输入证据一致性边界，不是进程 Job 或性能 RSS sampler。

音频特征、V2 landmark 和 legacy/V2 视觉缓存键不再只依赖 path/size/mtime，而是强制绑定算法、大小和完整 SHA-256；缺失、旧算法或畸形摘要直接拒绝缓存。FFmpeg 音频/视觉命令成功后，PCM/帧解析前会再次以 expected identity 复核文件；缓存命中仍受 run-final gate 约束。音频成功后追加视觉验证时，新探测的 source/target visual identity 必须先等于既有 TimeMap 的双端音频 identity，视觉 cache/decode 后再复核一次，之后才允许写入 visual stream 和 evidence，避免跨媒体世代混证据。

FFprobe 普通媒体时间线探测的执行/输出边界为 30 秒、8 MiB stdout 和 256 KiB stderr。音频逐帧/packet PTS 探测允许 5 分钟、128 MiB 紧凑 stdout 和 1 MiB stderr，但只在整个 Job 退出后开始解析；调用方传入 stream snapshot 的 expected full-file identity，探测前、探测后身份都必须与 expected 及彼此严格相等。解析器另行拒绝超过 1 MiB 的单条 compact record，并把不同音频流限制为 256 条。这一设计避免未退出的 wrapper 后代持有 pipe 时产生无界 join，也避免把换代媒体或无限 FFprobe 输出交给解析器。

取消边界覆盖进程退出后的 CPU 解析。媒体 JSON 在 deserialize 前后、逐 stream 归一化和完成后检查；frame/packet compact 输出逐 record 检查；V2 i16 PCM 按 64 Ki samples 分块检查，legacy f32 PCM 与频谱内循环按 4 Ki samples 检查，视觉 raw frames 逐帧检查。任一检查命中取消都会丢弃未完成 snapshot、特征、缓存与 proposal，不会把“FFmpeg 已退出”误当成任务已经不可取消。

Windows PATH 中若命中 Chocolatey `ShimGen`，监管器不会启动 shim 再追踪它的后代。只有可执行文件位于规范化的 `%ChocolateyInstall%\bin`、其 Windows version resource 明确匹配 ShimGen，且在规范化的 Chocolatey `lib` 树中经有界、拒绝 reparse/symlink 的遍历恰好找到一个同名真实 exe 时，才固定并执行该真实二进制；路径规范化、reparse/version-resource 验证、遍历完整性或唯一性任一失败都会 fail-closed，要求用户显式提供真实路径。benchmark 的大小、mtime、文件索引与 SHA-256 指纹因此绑定真实 FFmpeg/FFprobe，而不是 .NET shim。

这个 Job Object 只提供子进程树的**生命周期所有权和清理**，不改变 performance raw 的采样器声明，也不构成正式 RSS 证据。当前工程 raw 仍由 `windows-toolhelp-working-set-v1` 通过 ToolHelp/PID 快照计算 working set，存储范围仍是 `system-volume`；正式 acceptance 继续要求另行实现 `windows-job-object-working-set-v1` 并覆盖 `workload-media-volumes`。

### 真实媒体 benchmark 治理

`src/domain/alignment/realMediaBenchmark.ts` 的 manifest schema v2 是准确率验收的唯一结构化入口。它强制 `datasetVersion`、许可说明、`development/frozen-test` split、`real/synthetic/placeholder` 类型、显式音视频流和场景；真实关系还必须绑定 `sha256-full-file-v2` 身份、40–100ms 标注容差、至少五个覆盖五等分区间的 matched anchors、两名不同复核者的独立 gold，以及超出容差时由第三人完成的仲裁。示例 manifest 标记 `isExample=true`，禁止把 placeholder 冒充 real。

`src/infrastructure/alignment/realMediaBenchmarkPreflight.ts` 在本地运行前对每个唯一路径重新执行媒体探测，核对全文件身份与指定音频/视频流；任何身份或流不一致都会在启动分析前阻断。探测器原始错误不会进入可分享结果，避免工具诊断回显本地路径、媒体摘要或授权信息。

`src/infrastructure/alignment/realMediaBenchmarkRunner.ts` 把真实媒体运行拆成 blind 执行和事后评估两个信任域：完整 manifest 先投影为只含 case ID、媒体引用、内容身份和显式流的 `RunManifest`，剥离 gold、split、场景、复核者与仲裁信息，并用 canonical JSON 的 SHA-256 形成执行摘要。通过 preflight 的摘要凭据后，blind runner 才逐 case 调用生产 `start/get/cancel_audio_alignment_job`，固定启用 Alignment V2 localization，并把 manifest 指定的参考/原片音轨和视频流贯穿到 Rust 请求。视觉 fallback/校验返回实际消费的 `sourceVisualStream`、`targetVisualStream`；runner 会与 blind manifest 复核，视觉特征缓存 key 也包含实际视频流索引，不能用“请求过某条流”代替“确实分析过该流”。

blind runner 的 sealed receipt 受 `RunManifest` SHA-256 约束，按 manifest 顺序保存每个真实关系的 `success/failed/cancelled`、单调时钟 wall elapsed、engine/feature 和无敏感信息的参数摘要；它是执行输入与输出的封口记录，不是外部审批签名。只有所有真实 case 都成功且 receipt 摘要、case 顺序与 prediction 身份一致时，协调器才把完整 manifest 的 gold 交给 evaluator。任一启动、读取、身份、流或 TimeMap 错误，以及任一取消，都会令 `evaluation=null`，不会伪装成 missing prediction 后继续计算质量；超时任务必须等待后端进入真实终态，无法在宽限期内安全退出时停止后续 case，避免残留 FFmpeg/CPU 任务与下一关系重叠。

组件级可分享报告有独立 schema、validator 和稳定 JSON 序列化，只保留 manifest/dataset ID、blind SHA-256、case 状态、wall elapsed、实际视觉流、engine/feature、参数摘要和评估指标；不包含媒体路径、媒体 SHA-256、生产 `parametersHash` 或原始 diagnostics。报告固定声明 `scope: "time-map-component"` 和 `releaseEligible: false`。匹配页的“高级：C137 精度基准”同时承载组件 runner 与下述原生性能工程采集；其中组件报告子区只做 TimeMap 组件开发/验收。组件子闸门即使显示通过，也不代表完整 release 验收，更不会授予项目时间图 `verified`。

`src/infrastructure/alignment/realMediaPerformanceRunner.ts` 和 `src-tauri/src/audio_alignment.rs` 已实现独立的性能工程采集链。runner 先取得 native exclusive session；有普通对齐任务、其他 benchmark session 或未退出后代时不会发放 lease。同一 session 内按预注册且不可选择性删减的 cold → warmup → hot → cancel 顺序运行与产品匹配相同的 Rust Alignment V2；cold 和 cancel 前对音频特征、landmark 与视觉特征三类应用缓存执行原子重置，hot 必须复用同 session 中完整 warmup 的结果。采集器以 Rust `Instant` 的 session-relative 整数纳秒 tick 记录真实阶段边界、缓存命中/未命中/写入/淘汰、进程树 working set 和从首次取消到真实终态的延迟。后代退出或缓存清理无法确认时，session 保持 `cleanup-blocked`，不会假装已释放。

`src/domain/alignment/c137PerformanceEvidence.ts` 将上述日志封装为 strict raw v1：它严格拒绝未知字段，重算 plan/environment/reset/evidence 摘要和 tick 差，核对完整 trial 顺序、cold/hot 缓存语义、输出一致性、采样覆盖/最大间隔、进程树残留和取消终态。该格式固定为 `releaseEligible: false` 和 `trustStatus: "untrusted-raw-evidence"`；结构完整只说明采集链自洽，不产生审批或信任。匹配页性能面板复用同一份已导入 manifest 及其媒体引用，没有另一个媒体选择器。组件 benchmark 报告中的前端/协调器 wall elapsed 不是性能证据，只有该 native session 中的单调 tick 和原生采样可进入 raw。

完整 release 判定由 `src/domain/alignment/c137Acceptance.ts` 的严格 `C137AcceptanceBundle` 单独负责。acceptance protocol v2 进一步绑定性能 plan 摘要、必需 cold/hot/cancel 次数、最大内存采样间隔和 `rust-std-instant-session-relative-v1` 单调时钟，并要求 `windows-job-object-working-set-v1` 进程归属与 `workload-media-volumes` 存储范围；performance report v2 直接携带 strict raw v1，不再接受手写耗时汇总。bundle 把 protocol、环境、runner、数据审批/preflight/prediction receipts，以及关系、TimeMap、校准、视觉 fallback、降级、北极星、性能、UI 和 release raw reports 绑定到 canonical SHA-256。bundle 内嵌的 evidence digest 不能自我担保：调用者还必须提供外部 `trustContext`，其中列出受信 protocol、receipts 和每类 raw report evidence 的摘要。release 默认不内置任何审批白名单；缺少 trust context、摘要不命中、证据缺项或严格 schema 不通过都会得到 `incomplete-evidence`，而不是 pass。

C137 数据闸门要求至少 150 组真实关系、30 组长参考、500 个 gold 编辑事件、至少 30% 永不参与参数选择的 frozen-test，并覆盖所有必需场景。当前领域层已有 bundle schema、摘要重算、硬门槛 evaluator 和性能工程 raw 生成器，但仓库仍没有采集/冻结合法真实媒体数据的生成器。虽然短命媒体进程已经由上述 lifecycle Job 无竞态接管并安全收尾，当前 Windows **RSS 采样**仍使用 `windows-toolhelp-working-set-v1` 的 ToolHelp 快照和 `GetProcessMemoryInfo`；采样证据没有按 Job membership 汇总，仍不能排除 session baseline 的 PID 复用。环境回执的 storage kind 也仍是通过 Windows 系统卷 seek-penalty 得到的 `system-volume`，未证明实际参考/原片媒体所在卷的存储类型。因此即使 strict raw v1 结构完整，当前采集结果也只能用于工程回归，不得晋升为正式发布性能证据。正式采集还必须实现独立的 `windows-job-object-working-set-v1` sampler、实际媒体卷探测、受信协议与独立 trust root，并在真实授权数据上重新生成和审批证据；不能用 lifecycle cleanup Job、UI 摘要或手写汇总替代。

当前仓库只有 manifest v2 的 placeholder 结构示例，真实媒体关系仍为 0；尚无统计概率校准、规定硬件性能报告或 20 套北极星长合集 5/5 验收。因此上述工程闸门不能被描述为已经通过，自动结果仍最高为 `review`。

## 匹配评分

`src/domain/project/matchAssessment.ts` 从项目状态生成可解释匹配评分，不依赖 React。评分输入包括目标原片绑定、项目和 XML 文件名、Emby 季集信息、目标运行时长、XML 弹幕时间范围、弹幕密度、已应用同步锚点、当前对齐提案，以及提案诊断中的音频/视觉线索。

评分结论只分三类：很可能匹配、需要确认、看起来不是同一集。没有运行音频或视觉分析时，评分器会把对应项标为“尚未运行”，不伪造媒体识别结果。总时长差只能作为风险证据；在没有定位删减点前，不会直接生成会影响导出时间的版本差异。

评分器可生成 `AlignmentProposal` 进入现有时间轴预览和复核流程。当前自动生成的同步线索只用于帮助用户核对片尾时间关系；会改变导出结果的版本差异仍必须来自人工标记、锚点校准、音频/视觉对齐提案，或其他可追溯规则。

## XML 策略

导入时解析 Bilibili XML 的 `<d p="">` 节点：

- 第一项秒数转换为整数毫秒；
- 保存完整原始 `p` 字段数组；
- 已知字段解析为结构化字段；
- 未知字段留在 `rawPFields`；
- 非法节点产生 `ImportWarning`，不阻断整个文件。

导出时按最终时间排序，相同时间按原始顺序排序，负时间限制为 0，并重新解析验证。

## 导出文件策略

导出服务根据本机应用设置中的默认目录和导出弹窗的本次选择决定去向。桌面端通过 Tauri 命令把单集 XML、分集 ZIP 和报告写入用户指定的已有目录；目录不存在、无权限或同名文件过多会返回普通用户可理解的错误。网页模式不能伪装成可写真实目录，因此回退为浏览器下载。

默认导出目录只保存在本机应用设置，不进入项目文件，也不会写入导出的 XML、ZIP 或报告内容。同名文件默认自动追加编号，避免覆盖用户已有文件。

## 媒体抽象

当前实现：

- `HtmlVideoMediaAdapter`：支持浏览器可播放的 MP4/WebM，作为轻量预览 fallback。预览区根据项目媒体引用和加载结果展示未导入、正在载入、可播放、格式不支持、需要重新连接等状态；加载失败会明确提示 HTML Video 限制和后续 mpv 方向。
- `TauriMpvMediaAdapter`：桌面端 mpv 后端，需要用户在设置中心配置 mpv 路径，并提供真实本地媒体路径或本次会话生成的 Emby 授权播放地址。前端通过 `src/infrastructure/media/tauriMpvPlayer.ts` 调用 Tauri 命令；后端 `src-tauri/src/media_tools.rs` 负责检测 FFmpeg/mpv 版本、启动/停止 mpv sidecar、查询状态和通过 mpv IPC 发送播放、暂停、seek、倍率和属性读取命令；状态轮询会读取 `track-list`，把真实音轨、字幕轨、编码、语言、选中状态和外部轨道标记返回前端。没有 mpv 路径、只有浏览器 blob URL 或未显式生成 Emby 授权流时不会启用该后端。

`src/domain/player/playerSession.ts` 是播放器化阶段的第一层领域模型，不依赖 React。它把当前项目、预览后端、加载状态、播放状态、错误、mpv 配置、播放器轨道和目标原片绑定整理成统一的播放器会话摘要：播放源、后端、播放状态、音轨、字幕轨、弹幕轨、缓存和下一步。预览面板只展示这份摘要，不在组件里重新解释播放器能力；后续接入双源对比、更多轨道控制和播放器缓存时应优先扩展该领域模型。

`src/domain/player/playerComparison.ts` 是双源对比的第一层摘要模型，也不依赖 React。它把当前编辑时间轴位置视为 B 站参考侧时间，通过已确认 `CutMarker` 计算目标原片时间和已应用补偿；预览面板展示参考源、目标源、参考时间、目标时间和下一步。它只是可复核的时间映射状态，不会假装已经具备双播放器同步；Emby 视频流必须由用户显式生成本次会话授权地址后交给 mpv。

`src/domain/player/playerReliability.ts` 是播放器可靠性摘要模型，不依赖 React。它把播放头同步目标、缓存策略和错误恢复路径固定为可测试输出；当前同步阈值为 `PLAYER_SEEK_SYNC_TOLERANCE_MS = 240`，预览面板的纠偏 seek 逻辑和用户可见“播放可靠性状态”共用同一个常量。缓存文案区分本地路径、浏览器对象 URL 和 Emby 本次会话授权流：本地音频特征按文件状态和参数复用，对象 URL 不写入项目文件，Emby 临时 URL 只留在本次会话内且缓存 key 会遮蔽 token。错误恢复只承诺可执行路径，例如换 MP4/WebM、绑定本地路径、启用 mpv 或重新生成授权流，不伪装自动重试。

预留：

- mpv 画面嵌入、Emby 授权流自动重试、截图/缩略图采样和更完整的硬解/字幕状态诊断仍属于后续播放器化阶段。

## 智能对齐扩展

`AlignmentProvider` 允许未来引入音频指纹、静音段、镜头切换、感知哈希、字幕时间、动态时间规整等算法。本阶段只有 `ManualAlignmentProvider`，不伪造自动匹配。

视频对齐实验室会把本地 FFmpeg 任务或导入的 JSON 解析为 `AlignmentProposal`，再进入同一套复核、阻断和非破坏性应用流程。音频候选版本差异不会直接写入时间轴；用户可以逐条定位到候选源时间，按不确定区间和实际试听结果修正毫秒时间与差异时长，然后把单条候选包装成最小 `AlignmentProposal` 走现有版本差异写入路径。被接受的候选只生成 `CutMarker` 等编辑规则，不改写原始 XML。

已绑定本地目标原片时，实验室会把 `mediaBinding.localPath` 作为完整版输入的默认值。已绑定 Emby 目标原片时，用户可显式点击“使用 Emby 授权输入”：前端用当前应用会话中的 Emby 密码重新登录，读取条目元数据确认条目仍可访问，再生成 `/Videos/{itemId}/stream` 临时播放地址交给 FFmpeg。密码、token 和临时播放 URL 只停留在当前内存状态，不写入项目文件、设置备份或 `mediaBinding`；如果会话密码缺失或 FFmpeg 无法读取服务器流，用户仍可改用本地路径。

音频特征缓存位于 Tauri 后端进程内，不写入 `.danmaku-project.json`。本地文件缓存 key 由规范化本地路径、文件大小、修改时间、FFmpeg 路径、采样率和特征窗口组成；远程 Emby 输入缓存 key 使用已遮蔽 token 的 URL 与同一组特征参数。匹配阈值和最小缺失时长变化时可复用同一组特征，换文件、换窗口或文件更新后会重新提取。任务日志和提案诊断会说明完整版/当前视频是缓存命中还是新提取。
