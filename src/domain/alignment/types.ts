import type { CutMarker, SyncAnchor } from "../danmaku/types";
import type { MediaContentIdentity } from "../project/types";
import { clampMilliseconds } from "../shared/time";
import type { TimeMapSpan, TimeMapQualityLevel } from "./timeMap";

export interface AlignmentInput {
  projectId: string;
  mediaName: string | null;
  notes: string;
}

export interface CutCandidate {
  id: string;
  name: string;
  sourceAtMs: number;
  sourceRangeStartMs?: number;
  sourceRangeEndMs?: number;
  targetGapMs: number;
  confidence: number;
  note: string;
}

export type AlignmentEvidenceQuality = "high" | "medium" | "low" | "blocked";

export type AlignmentEvidenceAlgorithm =
  | "alignment-v2-edit-map"
  | "time-map-audio"
  | "offset-path"
  | "sparse-fingerprint"
  | "sparse-fingerprint-fallback"
  | "dense-dp";

export type AlignmentEvidenceSignalKind = "audio" | "visual" | "danmaku";

export type AlignmentEvidenceSignalStatus = "used" | "notConfigured" | "blocked";

export interface AlignmentEvidenceSignalSummary {
  kind: AlignmentEvidenceSignalKind;
  status: AlignmentEvidenceSignalStatus;
  label: string;
  observations: number;
  weight: number;
  note: string;
}

export interface AlignmentEvidenceSummary {
  algorithm: AlignmentEvidenceAlgorithm;
  completeFingerprintCount: number;
  sourceFingerprintCount: number;
  fingerprintMatchCount: number;
  monotonicMatchCount: number;
  strongAnchorCount: number;
  weakAnchorCount: number;
  offsetClusterCount: number;
  refinedCandidateCount: number;
  lowConfidenceRegionCount: number;
  quality: AlignmentEvidenceQuality;
  timeMappingSegmentCount?: number;
  confirmedChangeCount?: number;
  signals?: AlignmentEvidenceSignalSummary[];
}

export interface AlignmentMatchRange {
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  targetEndMs: number;
  coverage: number;
}

export interface AlignmentTimeMapStreamIdentity {
  type: "audio" | "video";
  index: number;
  codec: string | null;
  startMs: number | null;
  timelineOffsetMs: number | null;
  timeBase: string | null;
  sampleRate: number | null;
  channels: number | null;
  frameRate: number | null;
  language: string | null;
  title: string | null;
}

export interface AlignmentTimeMapQuality {
  level: TimeMapQualityLevel;
  probability: number | null;
  metricSource: "measured" | "estimated" | "missing";
  coverage: number | null;
  /** v12 图级独特内容覆盖率，必须与 evidence 中同值。 */
  uniqueContentCoverage?: number | null;
  p50ResidualMs: number | null;
  p95ResidualMs: number | null;
  /** Alignment V2 v12 响应必填；旧夹具省略时按缺失处理。 */
  p99ResidualMs?: number | null;
  maxResidualMs: number | null;
  boundaryUncertaintyMs: number | null;
  alternativeMargin: number | null;
  anchorCount: number;
  /** Alignment V2 v12 响应必填；0..3 个时间区域。 */
  anchorRegionCount?: number;
  heldOutAnchorCount: number;
  reasons: string[];
}

export interface AlignmentTrackAlternative {
  sourceStreamIndex: number;
  targetStreamIndex: number;
  score: number;
  scale?: number;
  offsetMs?: number;
  inlierCount?: number;
}

export interface AlignmentTimeMapEvidence {
  types: Array<"audio" | "visual" | "manual" | "danmaku" | "legacy">;
  audioAnchorCount: number;
  visualAnchorCount: number;
  heldOutAnchorCount: number;
  top1Top2Margin: number | null;
  /** Source-axis support backed by content-unique observations, not just mapped duration. */
  uniqueContentCoverage?: number | null;
  /** True when another well-supported, temporally distinct occurrence competes with Top-1. */
  repeatedContentOnly?: boolean;
  selectedTrackReason?: string;
  alternativeTrackScores?: AlignmentTrackAlternative[];
  notes: string[];
}

/** Rust Alignment V2 返回的候选快照；持久化 ID、媒体 ID 和 revision 由项目层生成。 */
export interface AlignmentTimeMapProposal {
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  targetEndMs: number;
  spans: TimeMapSpan[];
  quality: AlignmentTimeMapQuality;
  evidence: AlignmentTimeMapEvidence;
  sourceStream: AlignmentTimeMapStreamIdentity | null;
  targetStream: AlignmentTimeMapStreamIdentity | null;
  /** Explicit visual streams actually consumed by V2 validation/fallback, independent of audio. */
  sourceVisualStream?: AlignmentTimeMapStreamIdentity | null;
  targetVisualStream?: AlignmentTimeMapStreamIdentity | null;
  sourceIdentity: MediaContentIdentity | null;
  targetIdentity: MediaContentIdentity | null;
  engineVersion: string;
  featureVersion: string;
  parametersHash: string;
}

export interface AlignmentProposal {
  anchors: SyncAnchor[];
  cutCandidates: CutCandidate[];
  confidence: number;
  diagnostics: string[];
  evidence?: AlignmentEvidenceSummary;
  matchRange?: AlignmentMatchRange;
  timeMap?: AlignmentTimeMapProposal;
}

export interface AlignmentProvider {
  analyze(input: AlignmentInput): Promise<AlignmentProposal>;
}

export function cutCandidateToMarker(candidate: CutCandidate): CutMarker {
  return {
    id: candidate.id,
    name: candidate.name,
    sourceAtMs: clampMilliseconds(candidate.sourceAtMs),
    targetGapMs: Math.round(candidate.targetGapMs),
    note: candidate.note
  };
}
