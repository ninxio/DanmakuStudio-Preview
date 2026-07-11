# C137：高精度分段时间映射与可信对齐引擎

## 状态与结论

本目标替代“继续调整现有音频匹配阈值”的方向，建设新的 Alignment Engine V2。

当前旧算法只能作为实验性线索生成器，不能称为“高可信”“精准对齐”或“已验证准确”：它以 1 秒音频窗、少量能量/频谱统计和 1 秒 offset 桶为主要表示，时间路径偏向只识别正向 offset 阶跃，数据模型也只能表达 `targetStartMs + 累计 gapMs`。这套结构无法完整表达连续时间伸缩、参考侧插入、双边替换和可靠的亚秒级边界；现有自动化测试又以合成特征为主，没有形成真实媒体准确率基准。

因此必须遵守两条硬规则：

1. 在真实媒体冻结测试集达到本目标门槛之前，不得对外宣称自动匹配或删减检测“精度通过”。
2. 算法的任何结论都先是候选；即使达到高质量门槛，也只能进入可批量人工确认状态，不能静默写入已确认映射。

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

## Schema v11：分段仿射 TimeMap 与验证来源

v10 首次新增 `mediaTimeMaps`，把时间关系从 `DanmakuSourceSegment.targetStartMs + timingRules` 升级为可表达双边编辑和连续伸缩的正式模型；v11 进一步新增验证来源记录，防止外部项目仅靠自报指标伪装成 `verified`。`MediaMatchCandidate` 保存候选 TimeMap；用户接受后生成不可变的已确认 revision，来源段通过 `timeMapId` 引用它。

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
  | MatchedTimeMapSpan
  | SourceOnlyTimeMapSpan
  | TargetOnlyTimeMapSpan
  | AmbiguousTimeMapSpan;

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
  reason: "repeatedContent" | "audioVisualConflict" | "replacement" | "insufficientEvidence" | "legacyRule";
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
- 拟合/保留验证锚点的 p50、p95、最大残差；
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

Audfprint 风格 landmark 可作为实现和准确率基线；Panako 可作为变速/变调研究基线，但任何第三方组件进入安装包前必须完成许可证、专利、体积和 Windows 打包评审。Chromaprint 可用于近重复筛查，不能单独承担精确时间图和删减边界。

### 阶段 2：长参考 Top-K 粗定位

1. 为长参考建立 landmark 倒排索引，目标原片作为查询。
2. 对重复率高的静音、黑场、OP/ED landmark 做 IDF 降权。
3. 从匹配点生成 offset/scale 假设，用 Hough 聚类与稳健 RANSAC 拟合 `target = scale * source + offset`。
4. scale 搜索至少覆盖 0.94–1.06，以容纳 23.976/24/25 fps 等常见版本差异；超出范围不直接否定，但降级复核。
5. 每对素材保留 Top-K 区间、内点分布和候选差距，不在重复内容处过早只选一个答案。

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

## v9 → v10 → v11 迁移

迁移必须保留数据且诚实表达信息损失：

1. v9 项目新增空 `mediaTimeMaps`，旧 `mediaMatchCandidates`、`danmakuSourceSegments` 和 `timingRules` 原样保留作兼容来源。
2. 对 `targetStartMs` 已知、规则均为正 gap 且顺序有效的旧内容段，可确定性生成斜率为 1 的 `matched + targetOnly` 兼容 TimeMap。
3. 兼容生成的 map 一律为 `legacy-unverified`，证据注明“由 v9 阶跃规则迁移，不代表重新分析或精度验证”。
4. 负 gap、零长度、越界、来源不明或无法恢复插入区间的旧规则不得伪造精确 `sourceOnly`；保留旧值并生成 `ambiguous:legacyRule` 或阻塞的兼容记录，要求重新分析/人工转换。
5. 已接受候选和已生成 segment 的引用关系保持幂等；迁移不得重复创建来源段。
6. 新 V2 候选被确认后，以新 revision 取代兼容 map，旧 revision 标记 `superseded`，用于撤销和审计。
7. 保存为 v11 前后必须进行 schema 验证；打开、保存、撤销、重做和再次打开后映射语义一致。
8. 旧投影器仅作为受控兼容路径存在，不能接收 V2 分段仿射结果，也不能成为新项目默认路径。
9. v10 中自报为 `verified` 但没有 v11 验证来源记录的时间图必须降为 `review`；迁移不得根据 JSON 内的概率、残差或证据字符串自行补签可信记录。

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

- [x] schema v11 可校验、保存、重开和迁移四类 TimeMap span 与验证来源记录。
- [x] matched span 可准确表达非 1.0 scale，长片投影不以累计浮点运算漂移。
- [x] source-only 弹幕进入未映射统计，target-only 正确推动后续映射。
- [x] ambiguous 不被静默插值，并能阻止默认导出。
- [x] 已确认 revision、撤销、重做、删除素材和重新连接后的引用一致。

### PTS 与多音轨

- [x] 容器/流起点、time_base 和解码 PTS 进入统一媒体时间。
- [x] 多音轨自动比较并保存被选流与备选证据。
- [x] 无共同音轨时音频正确降级，视觉路径可独立运行。

### 算法

- [x] landmark Top-K 能定位长参考后半段并抵抗重复 OP/ED。
- [x] 仿射拟合同时恢复 offset 和 scale。
- [x] edit-aware DP 对称识别 source-only、target-only 和替换区间。
- [ ] 局部精修输出双侧证据和边界不确定范围。
- [x] 音画冲突会降级或阻塞，不会被平均 confidence 掩盖。

### 质量、UX 与导出

- [x] `verified` / `review` / `blocked` / `legacy-unverified` 状态有可复现的质量门槛。
- [ ] 匹配页提供双时间轴、A/B 循环和四类差异人工分类。
- [x] 批量确认只包含达到全部门槛且无未解决事件的候选。
- [x] 导出页说明实际 TimeMap span 和验证误差，健康检查覆盖所有阻塞条件。

### 真实准确率与发布

- [ ] 真实媒体基准规模、双人标注和冻结集达到要求。
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
