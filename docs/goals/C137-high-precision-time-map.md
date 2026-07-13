# C137：高精度分段时间映射与可信对齐引擎

## 状态与结论

本目标替代“继续调整现有音频匹配阈值”的方向，建设新的 Alignment Engine V2。

当前旧算法只能作为实验性线索生成器，不能称为“高可信”“精准对齐”或“已验证准确”：它以 1 秒音频窗、少量能量/频谱统计和 1 秒 offset 桶为主要表示，时间路径偏向只识别正向 offset 阶跃，数据模型也只能表达 `targetStartMs + 累计 gapMs`。这套结构无法完整表达连续时间伸缩、参考侧插入、双边替换和可靠的亚秒级边界；现有自动化测试又以合成特征为主，没有形成真实媒体准确率基准。

因此必须遵守两条硬规则：

1. 在真实媒体冻结测试集达到本目标门槛之前，不得对外宣称自动匹配或删减检测“精度通过”。
2. 算法的任何结论都先是候选；即使达到高质量门槛，也只能进入可批量人工确认状态，不能静默写入已确认映射。

当前已完成 production blind benchmark runner、组件级 TimeMap 评测降权、完整 C137 acceptance bundle 的 fail-closed 聚合器、A/B 播放复核证据 v2，以及 native/raw/acceptance 性能证据链第五阶段。性能链现已具备原生独占 session、strict performance raw evidence v2、acceptance protocol v3 / performance report v3、匹配页工程采集入口与 manifest 工作负载绑定；它能从生产调用链记录 session-relative 单调时钟、真实阶段边界、冷/热缓存、取消终态和应用进程树 working set，并在任何工具探测前固定全部 workload media、逐 distinct 文件完整哈希、按实际卷生成 path-free storage receipt。Windows 一次性媒体工具仍由独立 lifecycle Job Object 挂起创建、入 Job 后恢复并有界清理；普通对齐 run 的 source/target media lease、run-start/run-final SHA、TimeMap identity、frame/packet PTS、缓存和音画证据继续绑定同一全文件身份。

当前生产工程模型已升级为 schema v13 / `media-time-map-core-v2`：每个 span 保存稳定 ID、独立训练/真实留出锚点统计、p50/p95/p99/max 残差、独特内容覆盖、左右支持、结构化边界不确定区间、失败原因和备选路径。留出观测在 seed、拟合、排序和 refit 前分区，逐段证据缺失或 blocked 时投影与 verified export 失败关闭；旧项目只会保守补成 `legacy-unverified`，不会从图级平均值伪造逐段测量。桌面 XML 导入同时由 native 固定并读取精确字节、独立解析、写入内容寻址存储并签发安装级 HMAC 收据；`verified-export-manifest-v3` 会绑定收据、完整投影 derivation、项目投影摘要和输出摘要，native 在写盘前重读 CAS 并重算不可变弹幕库存。普通原生 writer 只接受有界 `.txt` 报告，投影 `.xml/.zip` 只能走 verified writer。

`projectSnapshotDigest` 当前是 native 可重算的 canonical 投影摘要，不是带单调 revision/head 的 native 项目意图签名。它和 XML 收据足以阻止“修改原始弹幕并同步重算输出/manifest”的项目 JSON 伪造，但仍不能把已完全控制 Tauri invoke 的 renderer 所提交的 routes、ignored、disabled 或 adjustment 证明为用户原始意图；该更强边界仍需 native project snapshot authority、单调 head 和明确 user-gesture capability，不能在当前阶段冒充已解决。

这些能力解决的是“怎样盲跑生产算法、怎样安全拥有和清理媒体进程树、怎样把实际媒体卷绑定到性能记录、怎样防止改字符串/自摘要/跨 workload 复用冒充完整验收”，不代表真实准确率或正式性能验收已经通过。实际 `workload-media-volumes` 回执已经完成，但 lifecycle Job 只负责执行与清理；当前 raw v2 仍如实声明 `windows-toolhelp-working-set-v1`，`assurance` 中的 Job memory、terminal cleanup 与 native attestation 仍为空。故该产物继续固定为 `releaseEligible=false` 的 engineering raw。当前获授权且完成运行的真实冻结关系数仍为 0；实测校准、批准协议与外部信任根、规定目标机的正式性能测量、20 套北极星长合集和真实媒体回归均未完成。

## 产品目标

让用户在北极星场景中得到可复核、可解释、真实进入弹幕投影链路的时间映射：导入 5 集原片、1 个首尾相连且随机删减的 B 站长参考和对应 XML 后，软件应定位每集、区分全局延迟与时间伸缩、识别双方独有或替换内容，并给出带不确定范围的候选；用户确认后，分别导出与 5 集原片同步的弹幕 XML。

本阶段必须解决：

1. 全局 offset，包括容器、音频流和视频流 presentation 起点差异；
2. 分段 offset，以及一次或多次剪辑后累计偏移的变化；
3. 轻微时钟漂移和 23.976/24/25 fps 等版本造成的连续时间伸缩；
4. B 站参考缺少原片内容、B 站参考多出片头/广告，以及双边替换内容；
5. 多音轨、不同语言或不同混音造成的音频证据不可比；
6. 多集长参考中的 Top-K 定位和全局非冲突分配，避免重复片头片尾导致跨集错配；
7. 每段映射和每个版本差异的独立质量结论、证据和失败原因；
8. 低置信、证据冲突和无法判断场景的人工复核闭环；
9. 已确认时间图直接驱动弹幕投影，不能再把精确结果压扁为只支持阶跃的旧规则。

## 非目标

- 不剪切、转码、重封装或导出视频。
- 不下载 B 站视频，不绕过授权，不把视频内容嵌入项目文件。
- 不承诺在音轨和画面都没有共同可识别内容时自动恢复真实时间关系。
- 不把语义相似、同一剧集或相似画面误称为逐帧时间对应。
- 不在没有真实标注样本的情况下用合成单测数量代替准确率。
- 不让低置信候选、高置信候选或旧算法结果绕过用户确认。
- 不把算法参数、哈希桶和 DP 状态暴露为普通用户主界面概念。
- 不在本阶段引入云端上传或依赖在线视频服务；用户本地主动导入的媒体仍是唯一数据来源。

## UX 归置

- **素材页**：继续作为媒体和 XML 的唯一导入入口；显示可用流、路径连接状态和基础媒体探测异常，不出现对齐参数。
- **匹配页**：承载自动定位、候选质量、双时间轴复核、A/B 循环试听和版本差异分类，是 C137 的主要界面。
- **编辑页**：对已确认映射做片段级和单条弹幕精修，不承担重新选择媒体或批量配对。
- **导出页**：只消费已确认且通过导出闸门的时间图；按目标原片说明映射范围、时间伸缩、已确认差异和仍阻塞的问题。

主界面只使用结果语言，例如：“整体起点相差 +8.431 秒”“参考速度比原片快 0.041%”“原片在这里多出约 12.36 秒”“边界只能确定在 18:42.120–18:42.380，请复核”。算法名称、特征距离、RANSAC 内点和 DP 代价只放在高级诊断。

## P0：旧算法安全降级

在 V2 精度完成前先阻止错误结果继续以高可信形式扩散：

1. 旧引擎产出的候选统一标记为 `legacy-experimental` / “旧实验算法，未经真实媒体精度验证”。
2. 旧引擎不得显示“高可信”“精准”“已确认无删减”等结论；覆盖率高也不能等价为时间准确。
3. 禁止旧引擎候选进入“一键确认全部”；用户只能逐条查看并明确确认。
4. 旧引擎没有发现差异时，只能显示“未发现可确认差异”，不能显示“没有删减”。
5. 旧候选若缺少真实媒体 PTS、音轨身份、双侧边界证据或独立验证残差，导出健康检查必须提示“映射未验证”。
6. 已存在项目状态不被静默删除或改写；打开项目时保留旧映射，但明确标为 `legacy-unverified`，默认建议重新分析。
7. 若用户坚持按旧规则导出，必须通过单独的显式风险确认；不能把该操作计入 C137 精度通过。
8. 新旧引擎结果必须带不同 `engineVersion` 和 `featureVersion`，缓存与证据不可混用。

P0 的完成不代表对齐变准确，只代表产品不再把未经验证的结果包装成可靠结论。

## 坐标定义与核心不变量

统一定义：

- `source`：B 站参考视频及其 XML 所在时间轴；
- `target`：原片时间轴；
- 所有时间字段均为整数毫秒；
- 映射回答 `sourceMs -> targetMs | unmapped`，不修改原始 XML；
- 斜率是由整数端点推导出的诊断量，投影以整数端点做有理数插值，避免长片浮点累计漂移。

核心不变量：

1. 同一关系内 span 按来源/目标时间单调有序，不得交叉或倒退。
2. `matched` 的来源和目标区间都必须为正长度。
3. 相邻 `matched` 若不连续，间隙必须由显式 `sourceOnly`、`targetOnly` 或 `ambiguous` 解释。
4. 不得跨越 `sourceOnly` 或 `ambiguous` 进行隐式插值。
5. 一个来源时间在同一已确认关系中最多映射到一个目标时间。
6. 自动候选与已确认映射严格分离；候选变化不得静默改写已确认映射。
7. 原始高体积音视频特征只保存在可重建缓存中；项目文件只保存紧凑时间图、证据摘要、素材签名和算法版本。

## Schema v12：分段仿射 TimeMap、验证来源与逐段证据

v10 首次新增 `mediaTimeMaps`，把时间关系从 `DanmakuSourceSegment.targetStartMs + timingRules` 升级为可表达双边编辑和连续伸缩的正式模型；v11 进一步新增验证来源记录，防止外部项目仅靠自报指标伪装成 `verified`；v12 为每个 span 增加稳定身份、独立质量、边界与 alternatives，禁止用图级平均值掩盖局部失败。`MediaMatchCandidate` 保存候选 TimeMap；用户接受后生成不可变的已确认 revision，来源段通过 `timeMapId` 引用它。

`verified` 不是一个可由项目 JSON 自由填写的标签。v11 的验证记录必须绑定规范化时间图摘要、revision、双端媒体身份、验证方式和校准产物版本；摘要或身份不匹配、自动校准产物不在内置受信清单、人工记录不是由当前运行时明确签发时，一律降为 `review`。在真实冻结集和受信校准产物尚未形成前，自动校准白名单保持为空。

建议模型如下，最终字段名可在实现阶段按现有 TypeScript 规范调整，但语义不得收缩：

```ts
type TimeMapState = "candidate" | "confirmed" | "superseded";
type TimeMapQualityLevel = "verified" | "review" | "blocked" | "legacy-unverified";

interface MediaTimeMap {
  id: string;
  revision: number;
  sourceMediaId: string;
  targetMediaId: string;
  sourceStream: MediaStreamIdentity;
  targetStream: MediaStreamIdentity;
  sourceRangeStartMs: Milliseconds;
  sourceRangeEndMs: Milliseconds;
  targetRangeStartMs: Milliseconds;
  targetRangeEndMs: Milliseconds;
  spans: TimeMapSpan[];
  quality: TimeMapQuality;
  evidence: CompactAlignmentEvidence;
  engineVersion: string;
  featureVersion: string;
  parametersHash: string;
  state: TimeMapState;
  createdAt: string;
  confirmedAt: string | null;
}

type TimeMapSpan =
  MatchedTimeMapSpan | SourceOnlyTimeMapSpan | TargetOnlyTimeMapSpan | AmbiguousTimeMapSpan;

interface MatchedTimeMapSpan {
  id: string;
  kind: "matched";
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetStartMs: Milliseconds;
  targetEndMs: Milliseconds;
  residualP50Ms: Milliseconds;
  residualP95Ms: Milliseconds;
  anchorCount: number;
  quality: SpanQuality;
}

interface SourceOnlyTimeMapSpan {
  id: string;
  kind: "sourceOnly";
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetAtMs: Milliseconds;
  reason: "intro" | "ad" | "insertion" | "versionDifference" | "unknown";
  boundaryUncertaintyMs: Milliseconds;
  quality: SpanQuality;
}

interface TargetOnlyTimeMapSpan {
  id: string;
  kind: "targetOnly";
  sourceAtMs: Milliseconds;
  targetStartMs: Milliseconds;
  targetEndMs: Milliseconds;
  reason: "referenceCut" | "versionDifference" | "unknown";
  boundaryUncertaintyMs: Milliseconds;
  quality: SpanQuality;
}

interface AmbiguousTimeMapSpan {
  id: string;
  kind: "ambiguous";
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetStartMs: Milliseconds;
  targetEndMs: Milliseconds;
  alternatives: AlignmentAlternative[];
  reason:
    | "repeatedContent"
    | "audioVisualConflict"
    | "replacement"
    | "insufficientEvidence"
    | "legacyRule";
  quality: SpanQuality;
}
```

各类 span 的产品语义：

- `matched`：来源与目标内容对应，允许 `targetDuration / sourceDuration != 1`；弹幕按整数端点线性插值。
- `sourceOnly`：B 站参考中存在、原片中不存在的内容；其中弹幕默认不投影，并进入未映射统计。
- `targetOnly`：原片存在、B 站参考被删掉的内容；该 span 本身没有来源弹幕，但后续 `matched` 自动体现时间跳变。
- `ambiguous`：证据不足、音画冲突或双边替换，自动投影在该范围停止，必须人工分类或修正。

`TimeMapQuality` 和 `SpanQuality` 至少包含：

- 校准后的质量等级和概率；
- Top-1/Top-2 候选差距；
- 锚点数量、时间覆盖率和独特内容覆盖率；
- 训练/真实留出锚点数量，以及留出观测的 p50、p95、p99、最大残差；
- 边界左右支持时长和不确定范围；
- 音频、视觉、弹幕辅助信号各自的 `used` / `blocked` / `conflict`；
- 阻塞原因码，不以一个平均 confidence 掩盖局部失败。

## PTS、流身份与多音轨

### 媒体探测

每个媒体先经 FFprobe 建立 `MediaProbeSnapshot`：

- 容器 `start_time`、duration；
- 每条音频/视频流的 index、codec、语言、声道布局、采样率；
- 流 `start_time`、`time_base`、duration、disposition；
- VFR、时间戳不连续、负时间戳、encoder delay/skip samples 等可观测信息；
- 文件内容签名、大小、mtime 和探测工具版本。

特征时间必须从解码帧/包 PTS 转换到统一媒体 presentation time。不能再仅按 PCM 样本序号或视觉采样序号生成时间；若 FFmpeg 过滤链重置了 PTS，必须保存并恢复输入流到媒体时间轴的变换。

### 音轨选择

1. 不把 `a:0` 永久视为正确音轨。
2. 语言和 disposition 只用于缩小候选，不能代替实际内容评分。
3. 先对所有合理音轨组合运行低成本 landmark 评分，保留最佳组合和次佳组合。
4. 同一视频内若存在与参考同源的原声轨，应优先选择该轨，而不是拿不同配音强行对齐。
5. 若没有共同音轨，音频信号状态为 `blocked:no-common-audio`，切换到独立视觉路径；不能用低音频分数证明“没有对应内容”。
6. 选中的流身份、选择理由和备选分数必须写入候选证据；重开项目后流变化需使旧候选失效。

## Alignment Engine V2 流水线

### 阶段 1：多分辨率特征与缓存

- 低成本粗定位特征：声谱局部峰值组成的 landmark hashes，时间分辨率约 20–50ms。
- 精对齐特征：log-mel、PCEN、chroma、onset envelope，hop 约 20–50ms。
- 视觉特征：遮罩水印、字幕带和黑边后的分块 pHash/DCT hash；候选边界附近补充 ORB/AKAZE 局部特征和场景切换点。
- 特征缓存键至少包含媒体内容签名、流身份、PTS 变换、解码参数、`featureVersion`；不同引擎版本不得错误复用。
- 多素材执行必须按媒体而不是按 pair 预处理：每个 distinct 媒体及候选流只生成一次 PTS、landmark 和粗特征索引，长参考以流式/分块形式处理，不要求把整段 PCM 常驻内存，也不能保留当前 60 分钟单媒体上限作为产品能力边界。

Audfprint 风格 landmark 可作为实现和准确率基线；Panako 可作为变速/变调研究基线，但任何第三方组件进入安装包前必须完成许可证、专利、体积和 Windows 打包评审。Chromaprint 可用于近重复筛查，不能单独承担精确时间图和删减边界。

### 阶段 2：长参考 Top-K 粗定位

1. 为长参考建立 landmark 倒排索引，目标原片作为查询。
2. 对重复率高的静音、黑场、OP/ED landmark 做 IDF 降权。
3. 从匹配点生成 offset/scale 假设，用 Hough 聚类与稳健 RANSAC 拟合 `target = scale * source + offset`。
4. scale 搜索至少覆盖 0.94–1.06，以容纳 23.976/24/25 fps 等常见版本差异；超出范围不直接否定，但降级复核。
5. 每对素材保留 Top-K 区间、内点分布和候选差距，不在重复内容处过早只选一个答案。
6. N×M 先只运行索引查询和低成本粗筛；只有进入项目级 Top-K 的 pair/区间才解码必要精特征、运行 edit-aware DP 和边界精修，禁止继续对整个笛卡尔积逐 pair 做完整分析。

### 阶段 3：项目级全局分配

对 1×N、N×1 和 N×M 的 Top-K 候选做全局优化：

- 参考区间默认不互相冲突；确有多个 XML/版本复用时允许显式例外；
- 已知集序仅作为软单调先验，不通过文件名或列表顺序硬猜关系；
- 奖励跨片头、中段、片尾均匀分布的独特锚点；
- 惩罚只由 OP、ED、静音或短重复片段支持的关系；
- 输出最优组合、次优组合和歧义原因。

### 阶段 4：edit-aware 局部动态规划

先用粗仿射变换把搜索空间压缩到窄带，再运行具有 affine gap penalty 的局部序列对齐。动态规划必须显式建模：

- `M`：共同内容匹配；
- `S`：跳过来源，即 `sourceOnly`；
- `T`：跳过目标，即 `targetOnly`；
- `U`：证据不足或双边替换，进入 `ambiguous`。

标准 DTW 只能扭曲时间，容易把插入/删减硬拉成错误路径；V2 应采用 segmental pair-HMM、带丢弃代价的 Drop-DTW 思路或等价的 edit-aware DP。gap open 与 gap extend 分离，避免把一个持续删减拆成大量随机小缺口。

### 阶段 5：分段仿射拟合与变点分类

对 DP 路径运行稳健分段回归：

- 稳定截距对应全局或分段 offset；
- 持续线性残差趋势对应 scale/时钟漂移；
- 目标时间跳跃对应 `targetOnly`；
- 来源持续前进而目标无对应内容对应 `sourceOnly`；
- 两边均出现不匹配内容对应 `ambiguous/replacement`。

正负变化必须对称处理，不得再使用“只接受 offset 增大”的稳定器。变点数量需有复杂度惩罚，防止过拟合。

### 阶段 6：多分辨率局部精修

每个候选差异必须先证明左右两侧分别恢复稳定匹配，再做边界精修：

1. 500ms 粒度确定候选窗口；
2. 100ms 粒度用 onset、log-mel、chroma 局部相关收窄；
3. 同源音轨在 10–20ms hop 上用归一化互相关或 GCC-PHAT 精修；
4. 用 100–250ms 视觉帧、场景切换和局部特征独立确认或否决；
5. 输出来源边界、目标缺失/独有区间和边界不确定范围，不能只输出一个无误差说明的时间点。

视觉证据必须能独立形成路径、确认、否决或声明冲突；不能继续采用“仅检查已有音频锚点并统一小幅加分”的模式。

### 阶段 7：保留验证与质量校准

- 拟合时预留一部分分布在全片的锚点，不参与模型求解，只用于验证。
- 检查单调性、span 连续性、全片覆盖、p50/p95 残差和局部最大误差。
- 对 Top-K 歧义、重复内容、音画冲突和无共同音轨分别给出失败原因。
- confidence 必须在冻结真实媒体集上做概率校准；未经校准的启发式分数不能决定批量确认资格。

## 候选质量和人工复核

质量等级不改变“候选必须人工确认”的原则：

- `verified`：达到全部硬门槛，可进入“批量确认候选”，但仍需用户执行确认。
- `review`：关系可能正确，但存在低覆盖、边界不确定、单模态或局部差异，必须逐条 A/B 复核。
- `blocked`：证据冲突、PTS 不可信、没有共同内容或路径非单调，禁止应用。
- `legacy-unverified`：旧模型或旧算法结果，未经过 V2 真实媒体门槛。

单个候选暂定进入 `verified` 的全部条件：

1. 校准后的关系正确概率不低于 99.5%，且 Top-1 与 Top-2 差距达到冻结集校准阈值；
2. 至少 30 个独特锚点，覆盖目标有效内容的至少 80%，并分布在至少 3 个时间区域；
3. 保留验证锚点残差 p95 不高于 200ms，p99 不高于 500ms；
4. PTS、流身份、素材签名和缓存版本全部有效；
5. 每个差异事件左右至少各有 10 秒稳定匹配证据；
6. 每个边界不确定范围不超过 250ms；
7. 所有已启用模态不存在冲突；
8. 没有 `ambiguous` span，没有未分类 source-only/target-only span。

阈值在真实基准完成后可以收紧，但不得为了让更多候选显示绿色而放宽准确率门槛。

匹配页对 `review` 候选提供：

- 来源/目标双时间轴和映射连线；
- 同步 A/B 播放、单侧静音、边界前后循环；
- 波形、简化声谱和关键帧；
- “参考多出一段”“原片多出一段”“版本替换”“无法判断”分类；
- 可拖动边界与实时投影预览；
- 不确定范围、音画一致性和为什么不能批量确认的结果说明。

### A/B 播放复核证据 v2

A/B 复核不再以“用户点过播放按钮”作为完成证据，而是按来源/目标轴分别累计实际有效播放时长和去重后的时间覆盖范围：

- matched 与差异 span 的每个适用轴默认至少需要 2 秒有效播放、覆盖至少 1.5 秒；
- 非 matched 差异的段首、段尾边界在来源 A、原片 B 两侧分别至少需要 1.5 秒有效播放、覆盖至少 1 秒；
- 当实际可复核区间短于上述基准时，有效时长上限收缩到区间长度，覆盖要求收缩到区间长度的 80%，避免短片段永远无法完成；
- 正常 UI 采集只累计连续、前向且速率合理的播放观测；暂停、后台、倒退、seek、大幅跳跃和只试听同一小段不会转化为足额覆盖；
- v2 证据 token 绑定当前 span 摘要、策略版本、各证据槽和复核时间，span 变化后旧证据失效。

这只证明规定的人工试听覆盖已完成；在 20 套北极星 UI 走查和真实媒体回归完成前，不能把该机制本身计作发布验收通过。

## 投影和导出闸门

弹幕投影必须直接消费已确认 TimeMap：

- `matched` 使用整数端点插值；
- `sourceOnly` 内弹幕不投影，并计入未映射；
- `targetOnly` 无来源弹幕，后续 matched span 自然体现跳变；
- `ambiguous` 不做隐式猜测。

默认阻止导出的条件：

1. TimeMap 尚未确认或引用已失效；
2. 存在未解决的 `ambiguous` span；
3. 来源 XML 绑定与 TimeMap 的 `sourceMediaId` 不一致；
4. 素材签名、流身份或 PTS 探测相对确认时发生变化；
5. span 非单调、重叠、断裂却没有显式差异 span；
6. 候选仍为 `blocked`、`legacy-unverified`，或用户未完成规定的旧规则风险确认；
7. 投影结果超出目标时长或大段来源内容未映射。

导出页需按目标显示：“使用 4 个 matched span、2 处原片多出内容、1 处参考片头已忽略，验证残差 p95 126ms”，而不是只显示累计补偿秒数。

## v9 → v10 → v11 → v12 迁移

迁移必须保留数据且诚实表达信息损失：

1. v9 项目新增空 `mediaTimeMaps`，旧 `mediaMatchCandidates`、`danmakuSourceSegments` 和 `timingRules` 原样保留作兼容来源。
2. 对 `targetStartMs` 已知、规则均为正 gap 且顺序有效的旧内容段，可确定性生成斜率为 1 的 `matched + targetOnly` 兼容 TimeMap。
3. 兼容生成的 map 一律为 `legacy-unverified`，证据注明“由 v9 阶跃规则迁移，不代表重新分析或精度验证”。
4. 负 gap、零长度、越界、来源不明或无法恢复插入区间的旧规则不得伪造精确 `sourceOnly`；保留旧值并生成 `ambiguous:legacyRule` 或阻塞的兼容记录，要求重新分析/人工转换。
5. 已接受候选和已生成 segment 的引用关系保持幂等；迁移不得重复创建来源段。
6. 新 V2 候选被确认后，以新 revision 取代兼容 map，旧 revision 标记 `superseded`，用于撤销和审计。
7. 保存为 v12 前后必须进行 schema 验证；打开、保存、撤销、重做和再次打开后映射语义一致。
8. 旧投影器仅作为受控兼容路径存在，不能接收 V2 分段仿射结果，也不能成为新项目默认路径。
9. v10 中自报为 `verified` 但没有 v11 验证来源记录的时间图必须降为 `review`；迁移不得根据 JSON 内的概率、残差或证据字符串自行补签可信记录。
10. v11 及更早项目没有逐段实测证据；v12 迁移必须生成稳定 span ID，但质量、边界和 alternatives 只能标记为 `legacy-unverified` / `blocked`，不得复制图级指标冒充逐段测量。

## 真实媒体基准

### 基准集组成

在宣称精度前至少建立：

- 150–200 组真实媒体关系；
- 30 组多集长参考，覆盖 1×N、N×1、N×M；
- 至少 500 个双人复核的删减、插入或替换事件；
- 同源 AAC/Opus、不同码率、增益、采样率和声道混合；
- 音视频流起点不同、开头静音、负时间戳、VFR 和时间戳不连续；
- ±1000ppm 时钟漂移以及 23.976/24/25 fps 版本；
- 0.2–120 秒单处/多处删减、片头、广告、审核替换；
- 多语言、多混音、多音轨；
- 水印、字幕、黑边、缩放、裁剪、调色；
- 重复 OP/ED、静音、黑场和相似回顾镜头；
- 没有共同音轨但画面相同，以及音画均存在版本差异的负样本。

真实媒体可位于本地受控基准库，不提交受版权限制的视频；仓库保存素材哈希、标注、许可信息和运行清单。CI 使用许可开放或程序生成的短媒体覆盖确定性回归，但合成集不得代替真实冻结集。

### 标注

- Ground truth 保存来源/目标媒体签名、流身份、matched 端点、source-only/target-only/替换区间。
- 边界由两名标注者独立复核，目标分歧不超过 40–100ms；超出时仲裁。
- 至少 30% 关系和事件冻结为从不参与参数选择的测试集。
- 每次算法、特征或默认参数变化都生成按场景分层的差异报告，不只报告总平均值。

### 已完成的 blind runner 与门禁基础设施

production blind benchmark runner 已能执行以下闭环：

1. 从治理 manifest 投影出以 case ID 和来源/目标 media input 为核心的执行清单；执行进程看不到 gold、development/frozen split、场景标签、复核者或仲裁结果。
2. 对执行清单生成规范化 SHA-256，preflight 必须先验证真实媒体身份和显式音视频流，清单或 preflight receipt 不一致时禁止启动。
3. 每个 real case 通过与产品相同的 Tauri Alignment V2 job API 启动、轮询和取消；结果还会复核 V2 引擎、媒体身份和流身份。synthetic/placeholder 不进入真实关系执行。
4. 只有所有 real case 均成功并形成 blind run receipt 后，评测层才重新接触 gold；失败、超时或取消会使 evaluation 保持 `null`，不能伪装成普通 missing prediction。
5. 可分享报告保存总/单 case wall time、参数摘要、状态和失败码，并移除本地路径、媒体 SHA 和原始工具错误；当前 wall time 不是规定硬件性能报告。

现有 `evaluateRealMediaBenchmark` 只评估“已知正确媒体 pair 的 TimeMap 组件”，其 gate 明确为 `time-map-component`。即使 150 个已知 pair 的组件指标全部通过，`verifiedEligible` 仍恒为 `false`，也不能替代 Top-1/Top-K、全局 N×M 分配、校准、性能、北极星、UI 或 release 验收。

完整 C137 acceptance bundle 已定义 versioned protocol、数据审批/preflight/prediction receipts，以及 dataset、关系排名、TimeMap、校准、视觉回退、安全降级、北极星、性能、UI 和 release 原始报告。acceptance protocol 与 performance report 已升级到 v3：正式性能只接受 raw schema v2，并分别检查当前 bundle manifest、实际媒体卷 receipt 的结构与工作负载绑定、Job memory receipt、terminal cleanup receipt 与 native attestation；storage 自摘要不单独证明原生来源。统计报告必须让每个 frozen decision 恰好提供协议 Top-K、calibration 与所有 frozen decision 一对一且重算 correct、dataset gold 编辑数逐 case 与 TimeMap 事件相等、全部 frozen time-stretch case 上报漂移，并让跨报告 case metadata/scenarios 一致。旧 raw v1 即使改写 sampler/storage、自摘要并自建 trustContext 也不能通过；raw v2 即使 storage 闭合且改写为 Job sampler，后三项缺失时仍只能得到 `incomplete-evidence`。

acceptance 不内置可自行放行的非空白名单。当前 `trustContext` 只保存调用方提供的 protocol、三类 receipt 和每份 raw report 的 canonical SHA-256；报告摘要从原始内容重算并排除自身 `evidenceDigest`，所以它可发现快照后的内容变化，却不能证明摘要由独立信任根签发。门禁因此另设固定未完成的 `external-trust-authority` 检查，只有未来验证独立 authority 的签名或受信封装后才可解除。当前 release 尚无正式批准的协议摘要、数据审批 receipt 或外部信任根，因此不存在可用于真实发布放行的 production authority envelope。

第四、第五阶段已完成原生性能**工程**原始测量生成器及工作负载媒体卷绑定：

1. 原生独占 benchmark session 会阻止普通对齐任务并串行执行预注册的冷缓存、warmup、热缓存和取消试验；缓存重置带 generation 与单次 receipt，session 只有在任务终止且未残留新子进程时才释放。
2. Windows 一次性 FFmpeg/FFprobe、版本探测和受控系统探测以挂起状态创建，先加入私有 kill-on-close Job Object 后才恢复；显式继承列表只含标准流。取消、超时、输出溢出、I/O/等待异常会终止整个 Job 并有界等待；reader drain 超时会针对精确线程句柄取消同步 I/O 后再次等待。任何清理失败都会把当前结果作废、把 benchmark session 固定为 `cleanup-blocked` 并保持 lease。
3. FFprobe 普通时间线探测限制为 30 秒、8 MiB stdout / 256 KiB stderr；逐帧/packet 音频 PTS 探测限制为 5 分钟、128 MiB 紧凑 stdout / 1 MiB stderr，并只在整个 Job 退出后解析，另限制单条 compact record 为 1 MiB、不同音频流为 256 条。
4. 性能计划绑定由治理 manifest 投影得到的 workload digest 与真实 case 数；匹配页复核 runner 返回结果时再次校验 manifest binding，示例清单或空真实清单不能启动。
5. raw evidence v2 严格拒绝未知字段、v1/v2 混搭、试验删改、tick/elapsed 不一致、错误缓存命中、输出不一致、内存覆盖缺口、跨 workload 摘要和 storage binding/volume 计数不闭合；历史 raw v1 只读兼容且永不自动升级，报告恒为 `releaseEligible=false` / `untrusted-raw-evidence`。
6. 耗时由 Rust `Instant` 的 session-relative 纳秒 tick 和真实阶段边界生成；缓存记录 hits/misses/writes/evictions；取消记录请求 tick 到真实终态；内存按默认 20ms 采样应用及发现的 FFmpeg 子进程树 working set，并保存覆盖率、失败样本、最大间隔和残留进程数。
7. native v2 在首个工具 probe 前解析 canonical blind manifest、固定全部 distinct media，并从固定句柄解析盘符或 mounted-folder 实际卷；UNC、remote、removable、unknown、身份或 seek-penalty 探测异常均在 session 发布前失败。可下载 `workloadStorage` 只保存 case/side→volume ordinal、固定介质与 seek-penalty，不保存路径、卷 GUID/serial 或单媒体 SHA。环境同时记录物理/逻辑核心、内存、OS/架构、电源方案及 FFmpeg/FFprobe 数值版本和完整二进制 SHA。
8. 每个 Windows 本地对齐 run 在任何媒体探测前取得 source/target `FILE_SHARE_READ` lease，持有到最终 proposal gate；写入、删除、rename 和路径替换在 lease 期间被拒绝。run-start 与 run-final 全文件 SHA 必须一致，TimeMap 的双端 identity 还必须严格等于本次 run identity，关闭 A→B→A 替换窗口。
9. frame/packet PTS 探测同时绑定 stream snapshot expected identity、FFprobe 前 identity 与 Job 退出后 identity；音频、landmark、legacy/V2 视觉 cache key 都强制绑定 `sha256-full-file-v2`。FFmpeg 成功后、PCM/视觉帧解析前再次核验；视觉证据必须在 cache/decode 前后均与音频 TimeMap 属于同一双端媒体世代，之后才允许附加 visual stream/evidence。
10. reader 状态机只在 root exit、Job empty、stdout/stderr 全就绪时消费缓冲，修复先完成流在轮询中被提前丢弃的竞态。取消检查延伸到工具退出后的 JSON deserialize 前后、逐 stream/record 归一化、V2 PCM 分块、legacy PCM/频谱分块和视觉逐帧解析；取消后不返回部分 snapshot、缓存或 proposal。

但实际媒体卷回执不会自动把采样器升级为正式性能证据。raw v2 的采样器仍是 `windows-toolhelp-working-set-v1`；它没有按 Job membership 汇总 working set，也不能彻底规避 session baseline 的 PID 复用。acceptance v3 因而把 storage、Job memory、terminal cleanup 和 native attestation 拆成独立检查；当前只有 storage 通过，其余三项保持 incomplete。在诚实限定覆盖范围的 Job receipt、终态清理 receipt、独立 attestation、获批协议和规定 4 核目标机重复运行完成前，当前 raw 只能用于工程诊断。blind runner 和组件面板的协调器 wall time 同样不能替代正式性能证据。

### 指标

- 媒体关系 Top-1、Top-K 准确率和高置信错误率；
- 长参考定位区间 IoU 和跨集错配率；
- 在 matched span 全片均匀采样的映射误差 p50/p95/p99/max；
- 全局 offset 误差、scale/ppm 误差和片尾累计漂移；
- 删减/插入事件 precision、recall、F1；
- 左右边界误差、持续时长误差；
- source-only/target-only/replacement 分类 F1；
- 最终弹幕投影时间误差及 200ms/500ms 内比例；
- 置信度 ECE/Brier、`verified` 误报率和人工复核率；
- 冷/热缓存耗时、峰值内存、取消响应和缓存命中一致性。

## 上线验收门槛

以下是 V2 成为默认匹配引擎的最低门槛：

1. 同源音轨关系 Top-1 准确率不低于 99.5%。
2. 冻结集至少 1000 个关系判断中，`verified` 错误关系为 0；样本不足时只能报告当前观察结果，不能外推“零错误”。
3. matched span 投影误差 p95 ≤ 200ms、p99 ≤ 500ms。
4. 45 分钟素材由 scale 估计造成的片尾累计漂移 ≤ 250ms。
5. 对持续时间 ≥1 秒的删减/插入事件，F1 ≥ 0.97。
6. 边界误差 p95 ≤ 250ms，持续时长误差 p95 ≤ 250ms。
7. source-only/target-only/replacement 分类 F1 ≥ 0.95。
8. 独立视觉回退关系 Top-1 ≥ 99%，投影误差 p95 ≤ 500ms；仅靠稀疏视觉证据不得把差异事件升级为可批量确认。
9. 至少 20 套北极星长合集全部 5/5 定位正确，跨集错配为 0。
10. 在规定 4 核目标桌面机上，北极星冷缓存完成时间 ≤10 分钟、热缓存 ≤2 分钟、峰值内存 ≤1GB；若实际基准证明目标不合理，必须先记录硬件和测量数据再调整，不能无说明降低门槛。
11. 所有无法判断、音画冲突、PTS 不可信和低覆盖样本均正确降级，不能用“少报差异”换取表面 precision。
12. 从空项目到 5 集导出的北极星 UI 走查通过，用户始终能理解“已确认什么、哪里不确定、为什么被阻止”。

“源码审计、单测、Rust 测试、E2E、构建和打包通过”仍是工程发布条件，但不能替代上述真实媒体准确率指标。只要真实冻结集尚未建立或尚未运行，本目标的精度验收项就必须保持未完成。

## 验收清单

### P0 安全

- [x] 旧算法明确显示为未经真实媒体验证的实验结果。
- [x] 旧结果不能进入批量确认，未发现差异不再表述为“没有删减”。
- [x] 旧项目数据保留但标记 `legacy-unverified`，默认建议重新分析。

### 数据与投影

- [x] schema v13 可校验、保存、重开和迁移四类 TimeMap span、验证来源、逐段证据与可空 XML 原生内容收据；v1-v12 只迁移为 `sourceReceipt:null`。
- [x] 桌面批量 XML 导入由 native 精确字节解析、CAS 与安装级 HMAC 收据闭合；旧资源只有在不可变库存唯一完全一致时才能认领原 asset ID。
- [x] `verified-export-manifest-v3` 绑定 XML 收据、项目投影摘要和完整 derivation；投影 XML/ZIP 不得使用普通 raw writer。
- [x] matched span 可准确表达非 1.0 scale，长片投影不以累计浮点运算漂移。
- [x] source-only 弹幕进入未映射统计，target-only 正确推动后续映射。
- [x] ambiguous 不被静默插值，并能阻止默认导出。
- [x] 已确认 revision、撤销、重做、删除素材和重新连接后的引用一致。

### PTS 与多音轨

- [x] 容器/流起点、time_base 和解码 PTS 进入统一媒体时间。
- [x] 多音轨自动比较并保存被选流与备选证据。
- [x] 无共同音轨时音频正确降级，视觉路径可独立运行。

### 算法工程组件（不等于真实冻结集精度通过）

- [x] landmark Top-K 能定位长参考后半段并抵抗重复 OP/ED。
- [x] 仿射拟合同时恢复 offset 和 scale。
- [x] edit-aware DP 对称识别 source-only、target-only 和替换区间。
- [x] 局部精修输出双侧证据和边界不确定范围。
- [x] 音画冲突会降级或阻塞，不会被平均 confidence 掩盖。
- [x] 生产 landmark 在拟合前做确定性真实留出，并按 span 输出 p50/p95/p99/max、覆盖、边界支持、原因和 alternatives；同一时间帧不得跨训练/留出分区。

### 质量、UX 与导出

- [x] `verified` / `review` / `blocked` / `legacy-unverified` 状态有可复现的质量门槛。
- [x] 匹配页提供双时间轴、A/B 循环和四类差异人工分类。
- [x] 批量确认只包含达到全部门槛且无未解决事件的候选。
- [x] 导出页说明实际 TimeMap span 和验证误差，健康检查覆盖所有阻塞条件。

### 评测与信任门禁工程基础

- [x] production blind runner 在不暴露 gold/split/复核信息的执行清单上调用真实 Tauri Alignment V2 job，并在全部成功后才允许组件评测。
- [x] 已知 pair 的 TimeMap component gate 不再授予 `verifiedEligible`，组件通过不能冒充完整 C137 通过。
- [x] 完整 acceptance bundle 能从 frozen 原始 evidence 重算固定门槛；缺证据、非 real-frozen、digest 不一致或无外部 trust 时 fail closed。
- [x] A/B 播放复核证据 v2 按轴记录有效时长和覆盖范围，并执行 span、边界两级最小时长要求。
- [x] 原生独占性能 session 复用生产对齐核心，并记录 session-relative tick、真实阶段、缓存 generation/命中、取消终态和 ToolHelp 进程树 RSS；清理失败时保留 lease 并 fail closed。
- [x] Windows 一次性媒体工具使用挂起创建 → Job 归属 → 恢复执行的 lifecycle supervisor；取消、超时、输出异常和 reader 收尾均有界，无法可信清理时设置粘性故障并禁止结果降级。
- [x] FFprobe 时间线/逐帧 PTS 输出与解析均有硬上限；Chocolatey ShimGen 只允许解析到唯一、规范、非 reparse 的真实二进制，并把工具指纹绑定该真实文件。
- [x] Windows source/target media lease 贯穿完整 run；run-start/run-final SHA、TimeMap 双端 identity 与 frame/packet expected/before/after 身份严格闭环，缓存命中不能绕过最终复核。
- [x] 音频/landmark/视觉缓存全部绑定完整 SHA-256；视觉验证在消费前后都与音频 TimeMap 绑定同一媒体世代，身份缺失、变化或探测失败不产生混合证据。
- [x] reader 就绪状态不再过早消费单侧输出；JSON、compact PTS、V2/legacy PCM 与视觉 CPU 解析均有可测试的取消检查粒度。
- [x] strict performance raw evidence v2 绑定不可删改的冷/热/取消计划、manifest workload、实际媒体卷 receipt、工具链摘要、输出一致性与内存采样覆盖；历史 v1 只读兼容，二者均恒为 `releaseEligible=false`。
- [x] acceptance protocol v3 与 performance report v3 只接受 formal raw schema v2，并独立检查当前 manifest、storage 结构/绑定、Job memory、terminal cleanup 与 native attestation；Top-K、calibration、gold 编辑计数、全量 drift 与 case metadata 跨报告闭合，改字符串、自摘要、选择性漏报、自建 trustContext 或跨 workload 重签均不能通过。
- [x] native benchmark v2 在任何工具探测前会话级固定全部 workload media、distinct 文件只完整哈希一次、支持 mounted-folder 实际卷去重，并拒绝未注册/跨 case/流错配 job。
- [x] 匹配页高级诊断提供工程性能采集与取消入口，复用同一 manifest、二次校验 workload/case binding，并在下载前执行路径与媒体秘密扫描。

当前剩余限制：逐段真实留出证据、双侧边界不确定范围、A/B 人工复核、blind runner、lifecycle Job、工程 raw v2、实际媒体卷回执和 fail-closed acceptance v3 虽已落地，但获授权且实际运行的真实冻结关系数仍为 0；概率仍必须保持 null，实测校准、批准的 production protocol / trust root、Job working-set/terminal cleanup/native attestation 正式证据和 20 套北极星长合集均未完成，不能据此宣称准确率或性能达标。

性能执行已完成新的生产切片：匹配页把 1×N、N×1、N×M 一次提交为原生批任务；worker 按 distinct media 只建立一次媒体 lease、全文件身份、timeline/逐帧 PTS、候选音轨与 coarse landmark，再让全部 pair 完成 coarse scoring。每个合理音轨组合的去重 Top-K 会先经过有界 fine-window 与活动内存检查，然后由不使用文件名、数组顺序或剧集号先验的 exact branch-and-bound 选择项目级非冲突组合；搜索超过确定性硬上限时整批失败关闭，未入选或全批 coarse 不完整的候选不会进入 fine。长媒体以有界 CPU 流建立 coarse 索引；候选只有在至少一侧能提供完整的分集级查询轴，并且完整候选逆投影、全部 coarse inlier support、edit-aware DP 与边界精修所需 guard 都能同时装入两侧各自不超过 60 分钟的精解码窗口、活动内存预算也允许时，才会按仿射窗口进入 fine。双侧都超过 60 分钟且没有完整短轴只是其中一个明确阻断分支；任何窗口内容、必需 guard 或内存预算不满足的候选也会 fail-closed，不会截断后冒充完整时间图。批次 proposal 在最终媒体身份复核前只存在于 worker 私有 staging，完成或取消都必须复核后才原子发布。

本机 RTX 4090 已接入可选 CUDA/cuFFT 声谱后端：capability probe 会验证 CUDA driver、cuFFT、context 和真实 R2C 计算，短媒体与长媒体 streaming coarse 均可按 4096 帧有界 batch 执行 FFT，失败自动完整重算 CPU；强制 CUDA 模式则失败关闭。普通产品 batch 已在整批执行前固定 FFmpeg/FFprobe 二进制并把 tool digest 纳入缓存身份，同一物理文件的路径/hard-link 别名也按 FileId 合并。FFmpeg 音频解码、全文件 SHA-256、landmark 配对、edit-aware DP、边界精修与项目级搜索仍使用 CPU；这些剩余 CPU 阶段和真实冻结集缺口意味着当前只能宣称工程能力与资源边界，不能宣称准确率或正式性能达标。视觉 NVDEC 只可作为视觉帧解码优化，不得冒充音频计算加速。

### 真实准确率与发布

- [ ] 真实媒体基准规模、双人标注和冻结集达到要求。
- [ ] 正式批准 versioned 验收协议、校准/取消阈值、数据审批 receipts 与独立 production trust root。
- [x] 工程性能 raw v2 可在原生独占 session 中输出硬件/工具链、实际 workload media volumes、阶段耗时、冷/热缓存、ToolHelp 进程树峰值内存、取消响应和一致性证据，并保持不可晋级状态。
- [x] V2.1 中间性能层将 PCM/landmark/fine 合并为 768 MiB 字节 LRU 制品，同一主音轨冷路径只解码一次、landmark/fine 每帧只做一次 FFT；以 1 GiB 单任务预算和 native 并发 1 保持总资源有界，并用 exact/FFmpeg 回归证明语义不变。
- [x] N×M 产品执行已改为 distinct-media 一次预处理、全 pair coarse-before-fine、精确且资源有界的项目级 Top-K 非冲突选择，并只让入选候选进入 fine；长参考不再要求整段 PCM，但仿射窗口 fine 是条件能力：必须存在完整分集级查询轴，完整逆投影、全部 coarse support、DP/边界 guard 均装入每侧不超过 60 分钟的窗口且活动内存预算通过，否则明确阻断。
- [x] 可选 CUDA/cuFFT 声谱后端、4090 能力诊断、CPU 容差等价校验和失败自动回退已落地；安装包在 runtime 或真实 smoke 不可用时不会报告 GPU ready。
- [x] 长媒体 streaming coarse 使用有界 CUDA/cuFFT batch；普通产品 batch 完成 FFmpeg/FFprobe 整批只读 pin、tool digest 缓存绑定与同物理媒体别名合并，CPU 保持确定性基线。
- [ ] 正式性能采集在现有 lifecycle Job 之上实现诚实限定覆盖范围的 Job working-set receipt、终态 cleanup receipt 与独立 attestation；在规定 4 核目标机按获批协议重复运行并形成受信原始报告。
- [ ] 所有上线准确率、校准和性能门槛通过并有可重复报告。
- [ ] 北极星 20 套长合集 5/5 定位和完整导出通过。
- [ ] 源码审计、lint、前端/Rust 单测、真实媒体回归、E2E、构建和 Tauri release 通过。
- [ ] `progress.md` 记录真实样本规模、失败分层、测试命令、产物和仍未覆盖的风险。

## 执行顺序

1. **P0 安全降级**：先修正文案、批量确认资格和导出健康检查，停止错误高可信表达。
2. **基准先行**：定义 ground truth 格式、真实媒体清单、评测工具和冻结集；V2 开发以报告驱动。
3. **schema v11 与投影内核**：实现四类 span、revision、验证来源、迁移、整数端点插值和导出闸门。
4. **PTS 与多音轨基础设施**：建立可靠媒体 presentation time、流身份和版本化特征缓存。
5. **landmark 粗定位**：Top-K、offset/scale RANSAC 和项目级全局分配。
6. **edit-aware 精对齐**：带状 DP、分段仿射拟合和双边差异分类。
7. **局部边界与独立视觉**：多分辨率精修、音画交叉验证和无共同音轨回退。
8. **复核工作台**：双时间轴、A/B 循环、边界编辑、差异分类和结果语言。
9. **shadow 评测**：V2 只生成报告、不自动替换项目状态，与旧路径和 ground truth 对照。
10. **门槛审计与默认切换**：真实冻结集全部达到门槛后，V2 才成为默认引擎；旧引擎保留为兼容诊断，不能继续作为可信主路径。

## 完成定义

C137 只有在真实媒体冻结集、时间映射投影、人工复核、导出闭环和 release 全部通过后才能完成。若只完成数据结构、算法演示、合成测试或 UI，即使工程测试全绿，也只能记录为阶段进展，不能标记“高精度时间映射已完成”。
