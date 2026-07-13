import type { AlignmentTimeMapProposal } from "../domain/alignment/types";
import { deriveLockedFineSpectralBackendIdentity } from "../domain/alignment/fineSpectralBackend";
import {
  AUDIO_ALIGNMENT_BATCH_FINE_FRONTIER_CONTRACT_VERSION,
  AUDIO_ALIGNMENT_BATCH_FINE_SCORE_VERSION,
  createAudioAlignmentBatchFineExecutionEvidenceDigest,
  createAudioAlignmentBatchFineFrontierReceiptDigest,
  createAudioAlignmentBatchFineParametersHash,
  createAudioAlignmentBatchProposalTimeMapDigest,
  type AudioAlignmentBatchExecutionIdentitySnapshot,
  type AudioAlignmentBatchFineCandidateIdSnapshot,
  type AudioAlignmentBatchFineExecutionEvidenceSnapshot,
  type AudioAlignmentBatchFineFrontierReceiptSnapshot,
  type AudioAlignmentBatchSpectralBackendIdentitySnapshot
} from "../infrastructure/alignment/tauriAudioAlignment";

const DIGEST_A = `sha256:${"a".repeat(64)}` as const;
const DIGEST_B = `sha256:${"b".repeat(64)}` as const;

export const TEST_CPU_SPECTRAL_BACKEND: AudioAlignmentBatchSpectralBackendIdentitySnapshot = {
  backendId: "cpu-radix2-f64-r2c-512-v1",
  requestedBackend: "cpu",
  backendDetail: "CPU radix-2 f64 FFT",
  fallbackReason: null
};

export function createTestFineExecutionEvidence(
  timeMap: AlignmentTimeMapProposal,
  options: {
    pairOrdinal?: number;
    candidateOrdinal?: number;
    sourceStreamIndex?: number;
    targetStreamIndex?: number;
    scoreMicros?: number;
    engineVersion?: string;
    featureVersion?: string;
    coarseBackend?: AudioAlignmentBatchSpectralBackendIdentitySnapshot;
    fineBackend?: AudioAlignmentBatchSpectralBackendIdentitySnapshot;
    sourceCoarseBackend?: AudioAlignmentBatchSpectralBackendIdentitySnapshot;
    targetCoarseBackend?: AudioAlignmentBatchSpectralBackendIdentitySnapshot;
    sourceFineBackend?: AudioAlignmentBatchSpectralBackendIdentitySnapshot;
    targetFineBackend?: AudioAlignmentBatchSpectralBackendIdentitySnapshot;
  } = {}
): AudioAlignmentBatchFineExecutionEvidenceSnapshot {
  const pairOrdinal = options.pairOrdinal ?? 1;
  const candidateOrdinal = options.candidateOrdinal ?? 1;
  const sourceStreamIndex = options.sourceStreamIndex ?? timeMap.sourceStream?.index ?? 0;
  const targetStreamIndex = options.targetStreamIndex ?? timeMap.targetStream?.index ?? 0;
  const sourceCoarseBackend =
    options.sourceCoarseBackend ?? options.coarseBackend ?? TEST_CPU_SPECTRAL_BACKEND;
  const targetCoarseBackend =
    options.targetCoarseBackend ?? options.coarseBackend ?? TEST_CPU_SPECTRAL_BACKEND;
  const sourceFineBackend =
    options.sourceFineBackend ??
    options.fineBackend ??
    requireTestLockedFineBackend(sourceCoarseBackend);
  const targetFineBackend =
    options.targetFineBackend ??
    options.fineBackend ??
    requireTestLockedFineBackend(targetCoarseBackend);
  const sourceRequestedWindow = createWindow(timeMap.sourceStartMs, timeMap.sourceEndMs, false);
  const targetRequestedWindow = createWindow(timeMap.targetStartMs, timeMap.targetEndMs, false);
  const draft: AudioAlignmentBatchFineExecutionEvidenceSnapshot = {
    candidateId: { pairOrdinal, candidateOrdinal },
    selectedMemberRank: 1,
    groupMemberRanks: [1],
    sourceStreamIndex,
    targetStreamIndex,
    sourceCoarseBackend: { ...sourceCoarseBackend },
    targetCoarseBackend: { ...targetCoarseBackend },
    sourceFineBackend: { ...sourceFineBackend },
    targetFineBackend: { ...targetFineBackend },
    sourceRequestedWindow,
    targetRequestedWindow,
    sourceEffectiveWindow: createWindow(timeMap.sourceStartMs, timeMap.sourceEndMs, true),
    targetEffectiveWindow: createWindow(timeMap.targetStartMs, timeMap.targetEndMs, true),
    parametersHash: createAudioAlignmentBatchFineParametersHash(
      options.engineVersion ?? timeMap.engineVersion,
      options.featureVersion ?? timeMap.featureVersion,
      timeMap.parametersHash
    ),
    occupancyDigest: DIGEST_B,
    proposalTimeMapDigest: createAudioAlignmentBatchProposalTimeMapDigest(timeMap),
    scoreMicros: options.scoreMicros ?? 900_000,
    evidenceDigest: DIGEST_A
  };
  return {
    ...draft,
    evidenceDigest: createAudioAlignmentBatchFineExecutionEvidenceDigest(draft)
  };
}

function requireTestLockedFineBackend(
  coarse: AudioAlignmentBatchSpectralBackendIdentitySnapshot
): AudioAlignmentBatchSpectralBackendIdentitySnapshot {
  const locked = deriveLockedFineSpectralBackendIdentity(coarse);
  if (locked === null) throw new Error(`测试 coarse backend 无法锁定 fine：${coarse.backendId}`);
  return locked;
}

export function createTestFineFrontierReceipt(
  componentPairOrdinals: number[],
  selectedCandidateIds: AudioAlignmentBatchFineCandidateIdSnapshot[],
  options: {
    componentOrdinal?: number;
    scoreByCandidate?: ReadonlyMap<string, number>;
    inventoryCandidateCount?: number;
    finalState?: "resolved" | "noEligibleCandidate" | "unresolved" | "failed";
  } = {}
): AudioAlignmentBatchFineFrontierReceiptSnapshot {
  const selectedTotalScoreMicros = selectedCandidateIds.reduce(
    (sum, candidate) =>
      sum +
      (options.scoreByCandidate?.get(`${candidate.pairOrdinal}:${candidate.candidateOrdinal}`) ??
        900_000),
    0
  );
  const inventoryCandidateCount = Math.max(
    options.inventoryCandidateCount ?? componentPairOrdinals.length,
    selectedCandidateIds.length
  );
  const finalState = options.finalState ??
    (selectedCandidateIds.length > 0 ? "resolved" : "noEligibleCandidate");
  const resolved = finalState === "resolved";
  if (resolved !== (selectedCandidateIds.length > 0)) {
    throw new Error("测试 fine frontier 的 resolved 状态与选择集合不一致。");
  }
  const draft: AudioAlignmentBatchFineFrontierReceiptSnapshot = {
    contractVersion: AUDIO_ALIGNMENT_BATCH_FINE_FRONTIER_CONTRACT_VERSION,
    scoreVersion: AUDIO_ALIGNMENT_BATCH_FINE_SCORE_VERSION,
    inventoryDigest: DIGEST_A,
    receiptDigest: DIGEST_B,
    componentOrdinal: options.componentOrdinal ?? 1,
    componentPairOrdinals: [...componentPairOrdinals],
    inventoryCandidateCount,
    resolutionMarginMicros: 1,
    overlapToleranceMs: 250,
    limits: {
      maxCandidates: 32_768,
      maxSearchStates: 2_000_000,
      maxSearchExpansions: 8_000_000,
      maxIntervalComparisons: 32_000_000,
      maxIntervalsPerAxis: 4_096,
      maxTotalIntervals: 262_144,
      refinementBatchSize: 16
    },
    inventoryStateCounts: {
      unresolved: finalState === "unresolved" ? inventoryCandidateCount : 0,
      scored: resolved ? inventoryCandidateCount : 0,
      evaluatedIneligible:
        finalState === "noEligibleCandidate"
          ? inventoryCandidateCount - selectedCandidateIds.length
          : 0,
      evidenceBlocked: 0,
      resourceBlocked: 0,
      infrastructureFailed: finalState === "failed" ? inventoryCandidateCount : 0,
      cancelled: 0
    },
    refinementRoundCount: resolved ? 1 : 0,
    evaluatedCandidateCount: inventoryCandidateCount,
    finalState,
    resolved,
    selectedCandidateIds: structuredClone(selectedCandidateIds),
    selectedTotalScoreMicros: resolved ? selectedTotalScoreMicros : null,
    bestCompleted: {
      candidateIds: structuredClone(selectedCandidateIds),
      totalScoreMicros: selectedTotalScoreMicros
    },
    runnerUpCompleted: null,
    optimisticOmitted: null,
    nextRefinementCandidateIds: [],
    deferredCandidateCount: 0,
    proof: {
      beatsRunnerUpWithMargin: resolved,
      beatsOptimisticOmittedWithMargin: resolved
    },
    search: {
      statesVisited: inventoryCandidateCount,
      expansionsConsidered: inventoryCandidateCount,
      intervalComparisons: 0
    }
  };
  return {
    ...draft,
    receiptDigest: createAudioAlignmentBatchFineFrontierReceiptDigest(draft)
  };
}

export function createTestExecutionIdentity(
  engineVersion = "alignment-v2.3-rust",
  featureVersion = "fine-frontier-fixture-v3"
): AudioAlignmentBatchExecutionIdentitySnapshot {
  return {
    schemaVersion: 1,
    engineVersion,
    featureVersion,
    relationScoreVersion: "alignment-v2-pair-intrinsic-global-weight-v1",
    nativeExecutableDigest: DIGEST_A,
    ffmpegBinaryDigest: DIGEST_A,
    ffprobeBinaryDigest: DIGEST_A,
    sourceSpectralBackends: [{ ...TEST_CPU_SPECTRAL_BACKEND }],
    targetSpectralBackends: [{ ...TEST_CPU_SPECTRAL_BACKEND }]
  };
}

function createWindow(
  startMs: number,
  endMs: number,
  effective: boolean
): AudioAlignmentBatchFineExecutionEvidenceSnapshot["sourceRequestedWindow"] {
  const expectedSampleCount = Math.ceil(((endMs - startMs) * 16_000) / 1_000);
  return {
    startMs,
    endMs,
    presentationOffsetMs: startMs,
    sampleRate: 16_000,
    expectedSampleCount,
    actualDecodedSampleCount: effective ? expectedSampleCount : null
  };
}
