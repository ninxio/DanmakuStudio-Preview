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
  targetGapMs: number;
  confidence: number;
  note: string;
}

export interface AlignmentProposal {
  anchors: SyncAnchor[];
  cutCandidates: CutCandidate[];
  confidence: number;
  diagnostics: string[];
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
