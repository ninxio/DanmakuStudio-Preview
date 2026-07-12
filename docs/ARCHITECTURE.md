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

匹配页的双源 A/B 复核通过 `src/domain/alignment/timeMapPlaybackReviewEvidence.ts` 保存 `manual-playback-review:v1` token。token 只在媒体适配器的真实播放调用开始后写入，记录 span 索引、证据 mask 和复核时间；其中 `spanDigest` 绑定双端媒体 ID、span kind 与四个整数毫秒边界。`matched` 要求播放 A/B 两轴，单侧差异要求播放有内容的一轴并分别复核段首、段尾两侧边界；边界、kind 或媒体 ID 改变后读取函数不会承认旧 token。当前证据没有累计播放时长，因此只证明所需播放调用实际开始，不证明用户已经观看某个最小时长。

人工签发入口位于 `src/domain/alignment/mediaTimeMap.ts`、`src/infrastructure/media/manualVerificationAuthority.ts` 和 `src-tauri/src/manual_verification.rs`。领域预检要求 confirmed map、完整媒体身份、每个 span 的当前播放 token、每个 `sourceOnly/targetOnly` 的对应人工分类、无 `ambiguous`，且中央实测质量达到 `verified` 门槛；`reviewEvidenceDigest` 由 map ID/revision、分类记录、播放证据、复核者和完成时间确定性重算，UI 不能自由传入摘要。只有匹配页的明确用户动作调用 native 签发，自动分析、接受候选、保存和打开项目均不会签发。

native 验证机构首次使用时在 Tauri 应用本地数据目录生成 256-bit 安装级 secret，以 HMAC-SHA256 签发规范化请求。签发和撤销使用递增序号写为不可变事件文件，先写临时文件并 `sync_all`，再原子 rename；项目 JSON 只保存 record v2 的 verification ID、issuer key ID、序号、请求摘要、签名和可读撤销回执，不保存 secret 或权威注册表。撤销后的项目即使删掉 JSON 内回执，本机注册表仍返回 revoked。

项目打开时，signed record 先确定性降为 `review`，再异步查询本机签发/撤销注册表；只有签名、请求摘要和 active 状态全部通过才恢复 `verified`。恢复结果按 map ID/revision/verification 输入合并，并受 `projectEpoch` 保护，不能覆盖项目切换或核验期间的其他编辑。项目换机、安装级 secret 丢失、注册表损坏或 issuer 不匹配一律 fail-closed；未受信的外机记录仍可随匹配关系撤销并保留为 superseded 审计，不能造成操作死锁。

这一信任边界防止只编辑 `.danmaku-project.json` 伪造、恢复或移植 `verified`，不等于操作系统级密钥保险箱：当前 secret 与事件注册表依赖应用本地数据目录及系统账户权限，不宣称抵抗能够读取并改写同一账户应用数据的恶意本地进程。

### 真实媒体 benchmark 治理

`src/domain/alignment/realMediaBenchmark.ts` 的 manifest schema v2 是准确率验收的唯一结构化入口。它强制 `datasetVersion`、许可说明、`development/frozen-test` split、`real/synthetic/placeholder` 类型、显式音视频流和场景；真实关系还必须绑定 `sha256-full-file-v2` 身份、40–100ms 标注容差、至少五个覆盖五等分区间的 matched anchors、两名不同复核者的独立 gold，以及超出容差时由第三人完成的仲裁。示例 manifest 标记 `isExample=true`，禁止把 placeholder 冒充 real。

`src/infrastructure/alignment/realMediaBenchmarkPreflight.ts` 在本地运行前对每个唯一路径重新执行媒体探测，核对全文件身份与指定音频/视频流；失败关系不能进入评测。媒体路径只存在于本地 manifest 和运行输入，分享结果只保留 case ID、dataset version、场景和聚合指标，不带路径或实测哈希。C137 数据闸门要求至少 150 组真实关系、30 组长参考、500 个 gold 编辑事件、至少 30% 永不参与参数选择的 frozen-test，并覆盖所有必需场景；质量闸门在数据不足时不会执行或取得 `verifiedEligible`。

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
