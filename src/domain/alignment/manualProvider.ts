import type { SyncAnchor } from "../danmaku/types";
import type { AlignmentInput, AlignmentProposal, AlignmentProvider, CutCandidate } from "./types";

export class ManualAlignmentProvider implements AlignmentProvider {
  private proposal: AlignmentProposal;

  constructor(proposal: AlignmentProposal) {
    this.proposal = proposal;
  }

  analyze(input: AlignmentInput): Promise<AlignmentProposal> {
    void input;
    return Promise.resolve(this.proposal);
  }
}

export function serializeAlignmentProposal(proposal: AlignmentProposal): string {
  return `${JSON.stringify(proposal, null, 2)}\n`;
}

export function parseAlignmentProposal(json: string): AlignmentProposal {
  const parsed = JSON.parse(json) as unknown;
  if (!isProposal(parsed)) {
    throw new Error("对齐提案 JSON 格式不正确。");
  }
  return parsed;
}

function isProposal(value: unknown): value is AlignmentProposal {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.anchors) &&
    record.anchors.every(isSyncAnchor) &&
    Array.isArray(record.cutCandidates) &&
    record.cutCandidates.every(isCutCandidate) &&
    typeof record.confidence === "number" &&
    Number.isFinite(record.confidence) &&
    Array.isArray(record.diagnostics) &&
    record.diagnostics.every((diagnostic) => typeof diagnostic === "string") &&
    (record.evidence === undefined || isAlignmentEvidence(record.evidence))
  );
}

function isAlignmentEvidence(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.algorithm === "sparse-fingerprint" ||
      record.algorithm === "sparse-fingerprint-fallback" ||
      record.algorithm === "dense-dp") &&
    isNonNegativeInteger(record.completeFingerprintCount) &&
    isNonNegativeInteger(record.sourceFingerprintCount) &&
    isNonNegativeInteger(record.fingerprintMatchCount) &&
    isNonNegativeInteger(record.monotonicMatchCount) &&
    isNonNegativeInteger(record.strongAnchorCount) &&
    isNonNegativeInteger(record.weakAnchorCount) &&
    isNonNegativeInteger(record.offsetClusterCount) &&
    isNonNegativeInteger(record.refinedCandidateCount) &&
    isNonNegativeInteger(record.lowConfidenceRegionCount) &&
    (record.quality === "high" || record.quality === "medium" || record.quality === "low" || record.quality === "blocked")
  );
}

function isSyncAnchor(value: unknown): value is SyncAnchor {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    isFiniteNumber(record.sourceMs) &&
    isFiniteNumber(record.targetMs) &&
    (record.origin === "manual" || record.origin === "automatic") &&
    (record.confidence === undefined || isFiniteNumber(record.confidence))
  );
}

function isCutCandidate(value: unknown): value is CutCandidate {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    isFiniteNumber(record.sourceAtMs) &&
    (record.sourceRangeStartMs === undefined || isFiniteNumber(record.sourceRangeStartMs)) &&
    (record.sourceRangeEndMs === undefined || isFiniteNumber(record.sourceRangeEndMs)) &&
    isFiniteNumber(record.targetGapMs) &&
    isFiniteNumber(record.confidence) &&
    typeof record.note === "string"
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
