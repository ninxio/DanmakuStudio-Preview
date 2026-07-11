import type { CutMarker, SyncAnchor } from "../danmaku/types";
import { clampMilliseconds } from "../shared/time";

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

export interface AlignmentProposal {
  anchors: SyncAnchor[];
  cutCandidates: CutCandidate[];
  confidence: number;
  diagnostics: string[];
  evidence?: AlignmentEvidenceSummary;
  matchRange?: AlignmentMatchRange;
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
