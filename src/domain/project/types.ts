import type { CutMarker, DanmakuAsset, DanmakuClip, SyncAnchor } from "../danmaku/types";
import type { AlignmentProposal } from "../alignment/types";
import type { TimeMapSpan } from "../alignment/timeMap";
import type { Milliseconds } from "../shared/time";

export const CURRENT_SCHEMA_VERSION = 11;

export interface MediaReference {
  id: string;
  name: string;
  fileName: string;
  objectUrl: string | null;
  durationMs: Milliseconds | null;
}

export type ProjectMediaRole = "targetOriginal" | "bilibiliReference";
export type ProjectMediaReferenceKind = "browserFile" | "localPath" | "embyItem";
export type ProjectMediaConnectionState = "connected" | "needsReconnect" | "metadataOnly";

/**
 * Stable local-file snapshot used to invalidate a time map when the bytes behind a path change.
 * The digest is deliberately algorithm-versioned; equality always includes every field.
 */
export interface MediaContentIdentity {
  algorithm: string;
  sizeBytes: number;
  modifiedUnixMs: number;
  firstSampleDigest: string;
  middleSampleDigest: string;
  lastSampleDigest: string;
}

export interface ProjectMediaEmbyReference {
  itemId: string;
  itemName: string;
  itemType: string;
  seriesName: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  server: EmbyServerReference;
  mediaSources: EmbyMediaSourceSummary[];
}

export interface ProjectMediaReference {
  id: string;
  role: ProjectMediaRole;
  name: string;
  fileName: string;
  objectUrl: string | null;
  durationMs: Milliseconds | null;
  contentIdentity: MediaContentIdentity | null;
  referenceKind: ProjectMediaReferenceKind;
  connectionState: ProjectMediaConnectionState;
  sourceSummary: string;
  localPath: string | null;
  emby: ProjectMediaEmbyReference | null;
  episodeKey: string | null;
  episodeLabel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmbyServerReference {
  serverUrl: string;
  pathPrefix: string;
  username: string;
}

export interface EmbyMediaSourceSummary {
  id: string | null;
  name: string | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  sizeBytes: number | null;
  runtimeMs: Milliseconds | null;
}

interface MediaBindingBase {
  id: string;
  displayName: string;
  runtimeMs: Milliseconds | null;
  linkedAt: string;
}

export interface LocalFileMediaBinding extends MediaBindingBase {
  kind: "localFile";
  fileName: string;
  mediaId: string | null;
  localPath: string | null;
}

export interface EmbyItemMediaBinding extends MediaBindingBase {
  kind: "embyItem";
  itemId: string;
  itemName: string;
  itemType: string;
  seriesName: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  server: EmbyServerReference;
  mediaSources: EmbyMediaSourceSummary[];
}

export type MediaBinding = LocalFileMediaBinding | EmbyItemMediaBinding;

export interface SeasonEpisodeBinding {
  id: string;
  episodeKey: string;
  episodeLabel: string;
  targetBinding: MediaBinding;
  linkedAt: string;
}

export type DanmakuSourceSegmentKind = "content" | "ignored";

export interface DanmakuSourceBinding {
  id: string;
  assetId: string;
  sourceMediaId: string;
  linkedAt: string;
  updatedAt: string;
}

/**
 * 段内时间修正规则：参考时间轴（B 站/XML 时间）到达 sourceAtMs 之后，
 * 目标原片相对参考版累计多出 gapMs 内容（参考版在此处被删减）。
 * 投影时对该点之后的弹幕整体加上 gapMs。
 */
export interface SegmentTimingRule {
  id: string;
  sourceAtMs: Milliseconds;
  gapMs: Milliseconds;
  note: string;
}

export type MediaTimeMapState = "candidate" | "confirmed" | "superseded";
export type MediaTimeMapQualityLevel = "verified" | "review" | "blocked" | "legacy-unverified";
export type MediaTimeMapMetricSource = "measured" | "estimated" | "missing";
export type MediaTimeMapEvidenceType = "audio" | "visual" | "manual" | "danmaku" | "legacy";

/**
 * 已选择媒体流的紧凑身份。整个字段可为 null（旧项目或尚未探测），
 * 但一旦存在，所有身份字段都必须完整出现，不能用部分对象冒充已探测流。
 */
export interface MediaTimeMapStreamIdentity {
  type: "audio" | "video";
  index: number;
  codec: string | null;
  startMs: Milliseconds | null;
  timelineOffsetMs: Milliseconds | null;
  timeBase: string | null;
  sampleRate: number | null;
  channels: number | null;
  frameRate: number | null;
  language: string | null;
  title: string | null;
}

export interface MediaTimeMapQuality {
  level: MediaTimeMapQualityLevel;
  /** 经真实金标准校准后的概率；尚未校准时必须为 null。 */
  probability: number | null;
  metricSource: MediaTimeMapMetricSource;
  coverage: number | null;
  p50ResidualMs: Milliseconds | null;
  p95ResidualMs: Milliseconds | null;
  maxResidualMs: Milliseconds | null;
  boundaryUncertaintyMs: Milliseconds | null;
  alternativeMargin: number | null;
  anchorCount: number;
  heldOutAnchorCount: number;
  reasons: string[];
}

export interface CompactMediaTimeMapEvidence {
  types: MediaTimeMapEvidenceType[];
  audioAnchorCount: number;
  visualAnchorCount: number;
  heldOutAnchorCount: number;
  notes: string[];
}

export type MediaTimeMapVerificationMethod = "automatic-calibration" | "manual-review";

/**
 * 与时间图核心内容绑定的验证凭据。
 *
 * 该记录本身不是权限令牌：自动记录还必须命中应用内置的校准产物白名单；人工记录
 * 只有在本次运行中由明确的领域签发函数创建时才可信。这样不能靠导入任意 JSON
 * 把时间图提升为 verified。
 */
export interface MediaTimeMapVerificationRecord {
  recordVersion: 1;
  method: MediaTimeMapVerificationMethod;
  mapCoreDigest: string;
  mapRevision: number;
  sourceIdentity: MediaContentIdentity;
  targetIdentity: MediaContentIdentity;
  calibrationArtifactId: string;
  calibrationArtifactVersion: string;
  verifier: string;
  verifiedAt: string;
}

/** 来源（B 站/XML 时间轴）到目标原片时间轴的正式分段映射。 */
export interface MediaTimeMap {
  id: string;
  revision: number;
  sourceMediaId: string;
  targetMediaId: string;
  sourceStream: MediaTimeMapStreamIdentity | null;
  targetStream: MediaTimeMapStreamIdentity | null;
  /** Identity snapshots measured in the same analysis run that produced this map. */
  sourceIdentity: MediaContentIdentity | null;
  targetIdentity: MediaContentIdentity | null;
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetStartMs: Milliseconds;
  targetEndMs: Milliseconds;
  spans: TimeMapSpan[];
  quality: MediaTimeMapQuality;
  evidence: CompactMediaTimeMapEvidence;
  /** v11 验证凭据；null 表示尚无可信校准/人工复核闭环。 */
  verification: MediaTimeMapVerificationRecord | null;
  engineVersion: string;
  featureVersion: string;
  parametersHash: string;
  state: MediaTimeMapState;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
}

export type MediaMatchCandidateState = "pending" | "accepted" | "rejected" | "blocked";

/**
 * 媒体级匹配候选。候选只描述参考素材与目标原片之间的时间关系；
 * 用户接受后，才会按 XML 来源绑定展开为非破坏性的 DanmakuSourceSegment。
 */
export interface MediaMatchCandidate {
  id: string;
  batchId: string;
  sourceMediaId: string;
  targetMediaId: string;
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetStartMs: Milliseconds;
  targetEndMs: Milliseconds;
  timingRules: SegmentTimingRule[];
  confidence: number;
  proposal: AlignmentProposal;
  /** 始终指向 state=candidate 的候选时间图。 */
  timeMapId: string;
  /** 接受后指向独立的 state=confirmed 时间图；不能与 timeMapId 相同。 */
  confirmedTimeMapId: string | null;
  state: MediaMatchCandidateState;
  appliedSegmentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DanmakuSourceSegment {
  id: string;
  label: string;
  kind: DanmakuSourceSegmentKind;
  assetId: string | null;
  sourceMediaId: string | null;
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetMediaId: string | null;
  /** 该段开头对应目标原片时间轴上的时间；null 表示 0（段首对齐原片开头）。 */
  targetStartMs: Milliseconds | null;
  /** 段内删减修正规则，sourceAtMs 使用参考时间轴。 */
  timingRules: SegmentTimingRule[];
  /** v10 已确认分段时间图；旧兼容或 ignored 段可为 null。 */
  timeMapId: string | null;
  episodeKey: string | null;
  episodeLabel: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineViewState {
  pixelsPerSecond: number;
  scrollMs: Milliseconds;
  playheadMs: Milliseconds;
}

export interface PreviewSettings {
  danmakuVisible: boolean;
  safeAreaVisible: boolean;
  opacity: number;
}

export interface EditorProject {
  schemaVersion: number;
  id: string;
  name: string;
  media: MediaReference | null;
  mediaLibrary: ProjectMediaReference[];
  mediaBinding: MediaBinding | null;
  seasonEpisodeBindings: SeasonEpisodeBinding[];
  danmakuSourceBindings: DanmakuSourceBinding[];
  danmakuSourceSegments: DanmakuSourceSegment[];
  mediaMatchCandidates: MediaMatchCandidate[];
  mediaTimeMaps: MediaTimeMap[];
  assets: DanmakuAsset[];
  clips: DanmakuClip[];
  globalOffsetMs: Milliseconds;
  cutMarkers: CutMarker[];
  syncAnchors: SyncAnchor[];
  alignmentProposal: AlignmentProposal | null;
  itemTimeAdjustments: Record<string, Milliseconds>;
  disabledItemIds: string[];
  timeline: TimelineViewState;
  preview: PreviewSettings;
  createdAt: string;
  updatedAt: string;
}

export type SelectionKind = "none" | "danmaku" | "clip" | "cut" | "anchor";

export interface EditorSelection {
  kind: SelectionKind;
  ids: string[];
}

export interface ProjectValidationResult {
  ok: boolean;
  version: number | null;
  message: string;
}
