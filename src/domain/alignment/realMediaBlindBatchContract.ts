import { isAlignmentTimeMapProposal } from "./timeMapProposal";
import type { AlignmentTimeMapProposal } from "./types";
import {
  areMediaContentIdentitiesEqual,
  cloneMediaContentIdentity,
  isMediaContentIdentity
} from "../project/mediaIdentity";
import type { MediaContentIdentity } from "../project/types";
import { sha256Hex } from "../shared/sha256";

export const REAL_MEDIA_BLIND_BATCH_EXECUTION_SCHEMA_VERSION = 1 as const;
export const REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION = 1 as const;
export const REAL_MEDIA_BLIND_BATCH_RUNNER_VERSION =
  "c137-real-media-blind-full-cartesian-batch-v1" as const;
export const REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION = 1 as const;

const NATIVE_BATCH_TOP_K_LIMIT = 10;

export interface RealMediaBlindBatchExecutionMedia {
  mediaId: string;
  path: string;
  contentIdentity: MediaContentIdentity;
  audioStreamIndex: number;
  videoStreamIndex: number | null;
}

export interface RealMediaBlindBatchPairRegistration {
  pairOrdinal: number;
  sourceMediaId: string;
  targetMediaId: string;
}

export interface RealMediaBlindBatchAlignmentParameters {
  ffmpegPath: string | null;
  ffprobePath: string | null;
  sampleRate: number | null;
  windowMs: number | null;
  matchThreshold: number | null;
  minGapMs: number | null;
  maxCells: number | null;
  enableVisualEvidence: boolean;
  visualSampleIntervalMs: number | null;
}

/**
 * Execution-only suite. Its exact-key schema deliberately has no gold, reviewer, split, label,
 * expected relation or expected TimeMap field. Gold evaluation must happen after a path-free
 * native receipt has crossed this contract boundary.
 */
export interface RealMediaBlindBatchExecutionSuite {
  schemaVersion: typeof REAL_MEDIA_BLIND_BATCH_EXECUTION_SCHEMA_VERSION;
  suiteId: string;
  datasetVersion: string;
  topK: number;
  sources: RealMediaBlindBatchExecutionMedia[];
  targets: RealMediaBlindBatchExecutionMedia[];
  pairs: RealMediaBlindBatchPairRegistration[];
  parameters: RealMediaBlindBatchAlignmentParameters;
}

export type NativeBatchPairingMode = "fullCartesian" | "explicit";
export type NativeBatchGlobalSelectionState =
  "pending" | "selected" | "blocked" | "failed" | "cancelled";

export interface NativeBatchGlobalCandidateEvidence {
  rank: number;
  sourceStreamIndex: number;
  targetStreamIndex: number;
  score: number;
  globalScore: number;
  scale: number;
  offsetMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  targetEndMs: number;
  inlierCount: number;
  temporalCoverage: number;
  uniqueSourceCoverage: number;
  eligible: boolean;
  globalSelected: boolean;
}

export interface NativeBatchGlobalSelectionEvidence {
  state: NativeBatchGlobalSelectionState;
  selected: boolean;
  selectedRank: number | null;
  selectedScore: number | null;
  decisionRank: number | null;
  decisionScore: number | null;
  margin: number | null;
  candidateCount: number;
  eligibleCandidateCount: number;
  topK: NativeBatchGlobalCandidateEvidence[];
  decisionCandidate: NativeBatchGlobalCandidateEvidence | null;
}

export type RealMediaBlindBatchPairFailureCode = "native-pair-failed" | "native-pair-cancelled";

export interface RealMediaBlindBatchPairOutcome {
  pairIndex: number;
  pairOrdinal: number;
  sourceMediaId: string;
  targetMediaId: string;
  nativeStatus: "completed" | "failed" | "cancelled";
  failureCode: RealMediaBlindBatchPairFailureCode | null;
  /** Native N×M coarse shortlist membership only; never a gold-aware relationship verdict. */
  globalSelected: boolean;
  globalSelection: NativeBatchGlobalSelectionEvidence;
  proposalTimeMap: AlignmentTimeMapProposal | null;
}

export interface RealMediaBlindBatchRankedCandidate {
  relationRank: number;
  pairOrdinal: number;
  targetMediaId: string;
  nativeStatus: "completed" | "failed" | "cancelled";
  /** Mirrors native coarse shortlist membership, not final relation truth. */
  globalSelected: boolean;
  decisionScore: number | null;
  pairLocalScore: number | null;
  margin: number | null;
  qualityLevel: string | null;
}

export interface RealMediaBlindBatchSourceRanking {
  sourceMediaId: string;
  candidates: RealMediaBlindBatchRankedCandidate[];
  topK: RealMediaBlindBatchRankedCandidate[];
}

export interface RealMediaBlindBatchTargetRankedCandidate {
  relationRank: number;
  pairOrdinal: number;
  sourceMediaId: string;
  nativeStatus: "completed" | "failed" | "cancelled";
  /** Mirrors native coarse shortlist membership, not final relation truth. */
  globalSelected: boolean;
  decisionScore: number | null;
  pairLocalScore: number | null;
  margin: number | null;
  qualityLevel: string | null;
}

export interface RealMediaBlindBatchTargetRanking {
  targetMediaId: string;
  candidates: RealMediaBlindBatchTargetRankedCandidate[];
  topK: RealMediaBlindBatchTargetRankedCandidate[];
}

export type RealMediaBlindBatchRunStatus =
  "completed" | "completed-with-errors" | "failed" | "cancelled" | "timed-out";

export interface RealMediaBlindBatchRunReceipt {
  schemaVersion: typeof REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION;
  receiptKind: "c137-real-media-blind-batch-run";
  runnerVersion: typeof REAL_MEDIA_BLIND_BATCH_RUNNER_VERSION;
  suiteId: string;
  datasetVersion: string;
  executionDigest: `sha256:${string}`;
  nativeJobId: string;
  nativeEvidenceVersion: typeof REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION;
  pairingMode: "fullCartesian";
  status: RealMediaBlindBatchRunStatus;
  terminationReason: "native-terminal" | "abort-signal" | "job-timeout";
  wallElapsedMs: number;
  sourceCount: number;
  targetCount: number;
  pairCount: number;
  topK: number;
  /**
   * Complete source-major partition of the execution space. Every pair retains native selection
   * evidence and its V2 TimeMap, so a later gold-aware domain compiler can reproduce relation
   * decisions without treating the native coarse `selected` bit as the final relationship label.
   */
  pairOutcomes: RealMediaBlindBatchPairOutcome[];
  sourceRankings: RealMediaBlindBatchSourceRanking[];
  targetRankings: RealMediaBlindBatchTargetRanking[];
  /** Public, unkeyed self-consistency checksum. This is not a signature or native authority. */
  receiptDigest: `sha256:${string}`;
}

export function createRealMediaBlindBatchExecutionDigest(value: unknown): `sha256:${string}` {
  const suite = validateRealMediaBlindBatchExecutionSuite(value);
  return `sha256:${sha256Hex(canonicalJson(suite))}`;
}

/**
 * Public, unkeyed integrity checksum only. Anyone who can construct a receipt can recompute this
 * digest, so it proves canonical self-consistency but never native origin or release authority.
 */
export function createRealMediaBlindBatchRunReceiptDigest(
  receipt: Omit<RealMediaBlindBatchRunReceipt, "receiptDigest">
): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalJson(receipt))}`;
}

/**
 * Strict injection boundary for a later gold-aware compiler. Validation deliberately recomputes
 * all derived rankings from complete pair outcomes instead of trusting serialized ranking arrays.
 * A passing receipt remains untrusted self-consistent evidence: this validator does not attest
 * that `nativeJobId` existed and the public digest is not a signature or trust root.
 */
export function validateRealMediaBlindBatchRunReceipt(
  value: unknown,
  executionSuite: unknown
): RealMediaBlindBatchRunReceipt {
  const suite = validateRealMediaBlindBatchExecutionSuite(executionSuite);
  const receipt = requireExactRecord(
    value,
    [
      "schemaVersion",
      "receiptKind",
      "runnerVersion",
      "suiteId",
      "datasetVersion",
      "executionDigest",
      "nativeJobId",
      "nativeEvidenceVersion",
      "pairingMode",
      "status",
      "terminationReason",
      "wallElapsedMs",
      "sourceCount",
      "targetCount",
      "pairCount",
      "topK",
      "pairOutcomes",
      "sourceRankings",
      "targetRankings",
      "receiptDigest"
    ],
    "blind batch run receipt"
  );
  if (
    receipt.schemaVersion !== REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION ||
    receipt.receiptKind !== "c137-real-media-blind-batch-run" ||
    receipt.runnerVersion !== REAL_MEDIA_BLIND_BATCH_RUNNER_VERSION
  ) {
    throw new Error("blind batch run receipt schema/kind/runnerVersion 无效。");
  }
  if (receipt.suiteId !== suite.suiteId || receipt.datasetVersion !== suite.datasetVersion) {
    throw new Error("blind batch run receipt 与 execution suite 身份不一致。");
  }
  const executionDigest = requireSha256Digest(receipt.executionDigest, "executionDigest");
  if (executionDigest !== createRealMediaBlindBatchExecutionDigest(suite)) {
    throw new Error("blind batch run receipt executionDigest 与 canonical suite 不一致。");
  }
  const nativeJobId = requireNonBlankString(receipt.nativeJobId, "nativeJobId");
  if (
    receipt.nativeEvidenceVersion !== REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION ||
    receipt.pairingMode !== "fullCartesian"
  ) {
    throw new Error("blind batch run receipt 缺少 fullCartesian native evidence v1 绑定。");
  }
  const status = validateReceiptRunStatus(receipt.status);
  const terminationReason = validateReceiptTerminationReason(receipt.terminationReason);
  validateReceiptStatusTerminationCoherence(status, terminationReason);
  const wallElapsedMs = requireNonNegativeSafeInteger(receipt.wallElapsedMs, "wallElapsedMs");
  if (
    receipt.sourceCount !== suite.sources.length ||
    receipt.targetCount !== suite.targets.length ||
    receipt.pairCount !== suite.pairs.length ||
    receipt.topK !== suite.topK
  ) {
    throw new Error("blind batch run receipt 的 source/target/pair/topK 计数与 suite 不一致。");
  }
  if (
    !Array.isArray(receipt.pairOutcomes) ||
    receipt.pairOutcomes.length !== suite.pairs.length
  ) {
    throw new Error("blind batch run receipt pairOutcomes 不完整。");
  }
  const pairOutcomes = receipt.pairOutcomes.map((outcome, index) =>
    validateReceiptPairOutcome(outcome, index, suite)
  );
  validateReceiptRunOutcomeCoherence(status, pairOutcomes);
  const sourceRankings = suite.sources.map((source) =>
    createRealMediaBlindBatchSourceRanking(source.mediaId, pairOutcomes, suite.topK)
  );
  const targetRankings = suite.targets.map((target) =>
    createRealMediaBlindBatchTargetRanking(
      target.mediaId,
      pairOutcomes,
      Math.min(suite.topK, suite.sources.length)
    )
  );
  assertCanonicalEqual(
    receipt.sourceRankings,
    sourceRankings,
    "blind batch run receipt sourceRankings 顺序、字段或内容不闭合。"
  );
  assertCanonicalEqual(
    receipt.targetRankings,
    targetRankings,
    "blind batch run receipt targetRankings 顺序、字段或内容不闭合。"
  );
  const receiptDigest = requireSha256Digest(receipt.receiptDigest, "receiptDigest");
  const withoutDigest: Omit<RealMediaBlindBatchRunReceipt, "receiptDigest"> = {
    schemaVersion: REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION,
    receiptKind: "c137-real-media-blind-batch-run",
    runnerVersion: REAL_MEDIA_BLIND_BATCH_RUNNER_VERSION,
    suiteId: suite.suiteId,
    datasetVersion: suite.datasetVersion,
    executionDigest,
    nativeJobId,
    nativeEvidenceVersion: REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION,
    pairingMode: "fullCartesian",
    status,
    terminationReason,
    wallElapsedMs,
    sourceCount: suite.sources.length,
    targetCount: suite.targets.length,
    pairCount: suite.pairs.length,
    topK: suite.topK,
    pairOutcomes,
    sourceRankings,
    targetRankings
  };
  if (receiptDigest !== createRealMediaBlindBatchRunReceiptDigest(withoutDigest)) {
    throw new Error("blind batch run receiptDigest 与 canonical receipt 内容不一致。");
  }
  const validated: RealMediaBlindBatchRunReceipt = { ...withoutDigest, receiptDigest };
  assertRealMediaBlindBatchReceiptIsPathFree(validated, suite);
  return validated;
}

export function validateRealMediaBlindBatchExecutionSuite(
  value: unknown
): RealMediaBlindBatchExecutionSuite {
  const suite = requireExactRecord(
    value,
    [
      "schemaVersion",
      "suiteId",
      "datasetVersion",
      "topK",
      "sources",
      "targets",
      "pairs",
      "parameters"
    ],
    "blind batch execution suite"
  );
  if (suite.schemaVersion !== REAL_MEDIA_BLIND_BATCH_EXECUTION_SCHEMA_VERSION) {
    throw new Error("blind batch execution suite schemaVersion 无效。");
  }
  const suiteId = requireIdentifier(suite.suiteId, "suiteId");
  const datasetVersion = requireIdentifier(suite.datasetVersion, "datasetVersion");
  const sources = validateExecutionMediaArray(suite.sources, "sources");
  const targets = validateExecutionMediaArray(suite.targets, "targets");
  const pairCount = sources.length * targets.length;
  if (pairCount <= 1) {
    throw new Error("blind batch execution suite 必须包含多个 pair，拒绝 single-pair suite。");
  }
  if (pairCount > 256) {
    throw new Error("blind batch execution suite 最多允许 256 个全笛卡尔 pair。");
  }
  const topK = requirePositiveSafeInteger(suite.topK, "topK");
  if (topK > Math.max(sources.length, targets.length)) {
    throw new Error("blind batch execution suite.topK 不能超过任一关系查询轴的最大候选数。");
  }
  const parameters = validateAlignmentParameters(suite.parameters);
  ensureDistinctExecutionMedia(sources, targets, parameters.enableVisualEvidence);
  const pairs = validateFullCartesianPairs(suite.pairs, sources, targets);
  return {
    schemaVersion: REAL_MEDIA_BLIND_BATCH_EXECUTION_SCHEMA_VERSION,
    suiteId,
    datasetVersion,
    topK,
    sources,
    targets,
    pairs,
    parameters
  };
}

/** Shared strict parser used both at the native snapshot boundary and receipt reinjection. */
export function validateRealMediaBlindBatchGlobalSelectionEvidence(
  value: unknown,
  pairStatus: "queued" | "running" | "completed" | "failed" | "cancelled",
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  label: string
): NativeBatchGlobalSelectionEvidence {
  const evidence = requireExactRecord(
    value,
    [
      "state",
      "selected",
      "selectedRank",
      "selectedScore",
      "decisionRank",
      "decisionScore",
      "margin",
      "candidateCount",
      "eligibleCandidateCount",
      "topK",
      "decisionCandidate"
    ],
    `${label}.globalSelection`
  );
  if (
    evidence.state !== "pending" &&
    evidence.state !== "selected" &&
    evidence.state !== "blocked" &&
    evidence.state !== "failed" &&
    evidence.state !== "cancelled"
  ) {
    throw new Error(`${label}.globalSelection.state 无效。`);
  }
  if (typeof evidence.selected !== "boolean") {
    throw new Error(`${label}.globalSelection.selected 必须是 boolean。`);
  }
  const selectedRank = requirePositiveSafeIntegerOrNull(
    evidence.selectedRank,
    `${label}.selectedRank`
  );
  const selectedScore = requireFiniteNumberOrNull(
    evidence.selectedScore,
    `${label}.selectedScore`
  );
  const decisionRank = requirePositiveSafeIntegerOrNull(
    evidence.decisionRank,
    `${label}.decisionRank`
  );
  const decisionScore = requireFiniteNumberOrNull(
    evidence.decisionScore,
    `${label}.decisionScore`
  );
  const margin = requireUnitNumberOrNull(evidence.margin, `${label}.margin`);
  const candidateCount = requireNonNegativeSafeInteger(
    evidence.candidateCount,
    `${label}.candidateCount`
  );
  const eligibleCandidateCount = requireNonNegativeSafeInteger(
    evidence.eligibleCandidateCount,
    `${label}.eligibleCandidateCount`
  );
  if (eligibleCandidateCount > candidateCount) {
    throw new Error(`${label}.eligibleCandidateCount 超过 candidateCount。`);
  }
  if (!Array.isArray(evidence.topK)) throw new Error(`${label}.topK 必须是数组。`);
  if (evidence.topK.length !== Math.min(NATIVE_BATCH_TOP_K_LIMIT, candidateCount)) {
    throw new Error(`${label}.topK 数量没有覆盖 native 确定性 Top-K。`);
  }
  const topK = evidence.topK.map((candidate, index) =>
    validateGlobalCandidateEvidence(candidate, index + 1, candidateCount, source, target, label)
  );
  const decisionCandidate =
    evidence.decisionCandidate === null
      ? null
      : validateGlobalCandidateEvidence(
          evidence.decisionCandidate,
          decisionRank,
          candidateCount,
          source,
          target,
          `${label}.decisionCandidate`
        );
  const state = evidence.state;
  if (state === "selected") {
    if (
      !evidence.selected ||
      selectedRank === null ||
      selectedScore === null ||
      decisionRank !== selectedRank ||
      decisionScore !== selectedScore ||
      decisionCandidate === null ||
      decisionCandidate.rank !== selectedRank ||
      decisionCandidate.globalScore !== selectedScore ||
      !decisionCandidate.eligible ||
      !decisionCandidate.globalSelected
    ) {
      throw new Error(`${label} selected globalSelection 内部不自洽。`);
    }
  } else if (evidence.selected || selectedRank !== null || selectedScore !== null) {
    throw new Error(
      `${label} 非 selected globalSelection 不得声明 selectedRank/selectedScore。`
    );
  }
  if (
    (decisionRank === null) !== (decisionScore === null) ||
    (decisionRank === null) !== (decisionCandidate === null)
  ) {
    throw new Error(
      `${label} decisionRank/decisionScore/decisionCandidate 必须同时存在或同时为空。`
    );
  }
  if (decisionCandidate) {
    if (
      decisionCandidate.rank !== decisionRank ||
      decisionCandidate.globalScore !== decisionScore
    ) {
      throw new Error(`${label} decisionCandidate 与 decision rank/score 不一致。`);
    }
    if (decisionCandidate.rank <= topK.length) {
      assertCanonicalEqual(
        decisionCandidate,
        topK[decisionCandidate.rank - 1],
        `${label} decisionCandidate 与 Top-K 同 rank 候选不一致。`
      );
    }
  }
  const selectedTopK = topK.filter((candidate) => candidate.globalSelected);
  if (
    state === "selected" && selectedRank !== null && selectedRank <= topK.length
      ? selectedTopK.length !== 1 || selectedTopK[0]?.rank !== selectedRank
      : selectedTopK.length !== 0
  ) {
    throw new Error(`${label}.topK 的 globalSelected 标记不自洽。`);
  }
  if (
    (state === "pending" || state === "cancelled") &&
    (candidateCount !== 0 ||
      eligibleCandidateCount !== 0 ||
      topK.length !== 0 ||
      decisionCandidate !== null ||
      decisionRank !== null ||
      decisionScore !== null ||
      margin !== null)
  ) {
    throw new Error(`${label} ${state} evidence 不得公开候选证据。`);
  }
  if (pairStatus === "completed" && state !== "selected" && state !== "blocked") {
    throw new Error(`${label} completed pair 的 selection state 无效。`);
  }
  return {
    state,
    selected: evidence.selected,
    selectedRank,
    selectedScore,
    decisionRank,
    decisionScore,
    margin,
    candidateCount,
    eligibleCandidateCount,
    topK,
    decisionCandidate
  };
}

export function validateRealMediaBlindBatchProposalBinding(
  timeMap: AlignmentTimeMapProposal,
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  parameters: RealMediaBlindBatchAlignmentParameters,
  pairOrdinal: number
): void {
  if (
    !timeMap.engineVersion.toLowerCase().includes("alignment-v2") ||
    !timeMap.featureVersion.trim() ||
    !timeMap.parametersHash.trim()
  ) {
    throw new Error(`native pair #${pairOrdinal} proposal 不是可复核的 Alignment V2 工件。`);
  }
  if (
    !areMediaContentIdentitiesEqual(source.contentIdentity, timeMap.sourceIdentity) ||
    !areMediaContentIdentitiesEqual(target.contentIdentity, timeMap.targetIdentity)
  ) {
    throw new Error(`native pair #${pairOrdinal} proposal 媒体身份错配。`);
  }
  if (
    timeMap.sourceStream?.type !== "audio" ||
    timeMap.sourceStream.index !== source.audioStreamIndex ||
    timeMap.targetStream?.type !== "audio" ||
    timeMap.targetStream.index !== target.audioStreamIndex
  ) {
    throw new Error(`native pair #${pairOrdinal} proposal 音轨索引错配。`);
  }
  validateVisualStreamBinding(
    timeMap.sourceVisualStream,
    source.videoStreamIndex,
    parameters.enableVisualEvidence,
    `native pair #${pairOrdinal} source visual stream`
  );
  validateVisualStreamBinding(
    timeMap.targetVisualStream,
    target.videoStreamIndex,
    parameters.enableVisualEvidence,
    `native pair #${pairOrdinal} target visual stream`
  );
}

export function assertRealMediaBlindBatchDecisionCandidateMatchesTimeMap(
  candidate: NativeBatchGlobalCandidateEvidence,
  timeMap: AlignmentTimeMapProposal,
  pairOrdinal: number
): void {
  if (
    timeMap.sourceStream?.index !== candidate.sourceStreamIndex ||
    timeMap.targetStream?.index !== candidate.targetStreamIndex
  ) {
    throw new Error(`native pair #${pairOrdinal} decision candidate 与 proposal 音轨错配。`);
  }
}

function validateGlobalCandidateEvidence(
  value: unknown,
  expectedRank: number | null,
  candidateCount: number,
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  label: string
): NativeBatchGlobalCandidateEvidence {
  const candidate = requireExactRecord(
    value,
    [
      "rank",
      "sourceStreamIndex",
      "targetStreamIndex",
      "score",
      "globalScore",
      "scale",
      "offsetMs",
      "sourceStartMs",
      "sourceEndMs",
      "targetStartMs",
      "targetEndMs",
      "inlierCount",
      "temporalCoverage",
      "uniqueSourceCoverage",
      "eligible",
      "globalSelected"
    ],
    label
  );
  const rank = requirePositiveSafeInteger(candidate.rank, `${label}.rank`);
  if (expectedRank !== null && rank !== expectedRank) {
    throw new Error(`${label}.rank 不是连续的确定性候选序号。`);
  }
  if (rank > candidateCount) throw new Error(`${label}.rank 超过 candidateCount。`);
  const sourceStreamIndex = requireNonNegativeSafeInteger(
    candidate.sourceStreamIndex,
    `${label}.sourceStreamIndex`
  );
  const targetStreamIndex = requireNonNegativeSafeInteger(
    candidate.targetStreamIndex,
    `${label}.targetStreamIndex`
  );
  if (
    sourceStreamIndex !== source.audioStreamIndex ||
    targetStreamIndex !== target.audioStreamIndex
  ) {
    throw new Error(`${label} 的音轨索引与 execution suite 错配。`);
  }
  const score = requireFiniteNumber(candidate.score, `${label}.score`);
  const globalScore = requireFiniteNumber(candidate.globalScore, `${label}.globalScore`);
  const scale = requirePositiveFiniteNumber(candidate.scale, `${label}.scale`);
  const offsetMs = requireSafeInteger(candidate.offsetMs, `${label}.offsetMs`);
  const sourceStartMs = requireSafeInteger(candidate.sourceStartMs, `${label}.sourceStartMs`);
  const sourceEndMs = requireSafeInteger(candidate.sourceEndMs, `${label}.sourceEndMs`);
  const targetStartMs = requireSafeInteger(candidate.targetStartMs, `${label}.targetStartMs`);
  const targetEndMs = requireSafeInteger(candidate.targetEndMs, `${label}.targetEndMs`);
  if (sourceEndMs <= sourceStartMs || targetEndMs <= targetStartMs) {
    throw new Error(`${label} 的内容区间无效。`);
  }
  const inlierCount = requireNonNegativeSafeInteger(
    candidate.inlierCount,
    `${label}.inlierCount`
  );
  const temporalCoverage = requireUnitNumber(
    candidate.temporalCoverage,
    `${label}.temporalCoverage`
  );
  const uniqueSourceCoverage = requireUnitNumber(
    candidate.uniqueSourceCoverage,
    `${label}.uniqueSourceCoverage`
  );
  if (
    typeof candidate.eligible !== "boolean" ||
    typeof candidate.globalSelected !== "boolean"
  ) {
    throw new Error(`${label} eligible/globalSelected 必须是 boolean。`);
  }
  if (candidate.globalSelected && !candidate.eligible) {
    throw new Error(`${label} globalSelected candidate 必须 eligible。`);
  }
  return {
    rank,
    sourceStreamIndex,
    targetStreamIndex,
    score,
    globalScore,
    scale,
    offsetMs,
    sourceStartMs,
    sourceEndMs,
    targetStartMs,
    targetEndMs,
    inlierCount,
    temporalCoverage,
    uniqueSourceCoverage,
    eligible: candidate.eligible,
    globalSelected: candidate.globalSelected
  };
}

function validateReceiptPairOutcome(
  value: unknown,
  pairIndex: number,
  suite: RealMediaBlindBatchExecutionSuite
): RealMediaBlindBatchPairOutcome {
  const outcome = requireExactRecord(
    value,
    [
      "pairIndex",
      "pairOrdinal",
      "sourceMediaId",
      "targetMediaId",
      "nativeStatus",
      "failureCode",
      "globalSelected",
      "globalSelection",
      "proposalTimeMap"
    ],
    `pairOutcomes[${pairIndex}]`
  );
  const expected = suite.pairs[pairIndex];
  if (!expected) throw new Error("receipt pairOutcomes 索引超过 execution suite。");
  if (
    outcome.pairIndex !== pairIndex ||
    outcome.pairOrdinal !== expected.pairOrdinal ||
    outcome.sourceMediaId !== expected.sourceMediaId ||
    outcome.targetMediaId !== expected.targetMediaId
  ) {
    throw new Error("receipt pairOutcomes 未按 source-major canonical 顺序完整绑定 suite。");
  }
  const source = suite.sources.find((media) => media.mediaId === expected.sourceMediaId);
  const target = suite.targets.find((media) => media.mediaId === expected.targetMediaId);
  if (!source || !target) throw new Error("receipt pair outcome 引用了缺失媒体。");
  const nativeStatus = validateReceiptNativePairStatus(outcome.nativeStatus);
  const globalSelection = validateRealMediaBlindBatchGlobalSelectionEvidence(
    outcome.globalSelection,
    nativeStatus,
    source,
    target,
    `receipt pair #${expected.pairOrdinal}`
  );
  if (
    typeof outcome.globalSelected !== "boolean" ||
    outcome.globalSelected !== globalSelection.selected
  ) {
    throw new Error("receipt pair outcome 的 globalSelected 与 native evidence 不一致。");
  }
  let failureCode: RealMediaBlindBatchPairFailureCode | null;
  let proposalTimeMap: AlignmentTimeMapProposal | null;
  if (nativeStatus === "completed") {
    if (outcome.failureCode !== null) {
      throw new Error("completed receipt pair 不得包含 failureCode。");
    }
    assertAlignmentTimeMapExactKeys(
      outcome.proposalTimeMap,
      `receipt pair #${expected.pairOrdinal}`
    );
    if (!isAlignmentTimeMapProposal(outcome.proposalTimeMap, true)) {
      throw new Error("completed receipt pair 的 proposalTimeMap 不是完整 V2 TimeMap。");
    }
    proposalTimeMap = structuredClone(outcome.proposalTimeMap);
    validateRealMediaBlindBatchProposalBinding(
      proposalTimeMap,
      source,
      target,
      suite.parameters,
      expected.pairOrdinal
    );
    if (globalSelection.decisionCandidate) {
      assertRealMediaBlindBatchDecisionCandidateMatchesTimeMap(
        globalSelection.decisionCandidate,
        proposalTimeMap,
        expected.pairOrdinal
      );
    }
    failureCode = null;
  } else {
    const expectedFailureCode =
      nativeStatus === "failed" ? "native-pair-failed" : "native-pair-cancelled";
    if (outcome.failureCode !== expectedFailureCode || outcome.proposalTimeMap !== null) {
      throw new Error("failed/cancelled receipt pair 的 failureCode/TimeMap 不闭合。");
    }
    failureCode = expectedFailureCode;
    proposalTimeMap = null;
  }
  return {
    pairIndex,
    pairOrdinal: expected.pairOrdinal,
    sourceMediaId: expected.sourceMediaId,
    targetMediaId: expected.targetMediaId,
    nativeStatus,
    failureCode,
    globalSelected: globalSelection.selected,
    globalSelection,
    proposalTimeMap
  };
}

function validateReceiptRunStatus(value: unknown): RealMediaBlindBatchRunStatus {
  if (
    value !== "completed" &&
    value !== "completed-with-errors" &&
    value !== "failed" &&
    value !== "cancelled" &&
    value !== "timed-out"
  ) {
    throw new Error("blind batch run receipt status 无效。");
  }
  return value;
}

function validateReceiptTerminationReason(
  value: unknown
): "native-terminal" | "abort-signal" | "job-timeout" {
  if (value !== "native-terminal" && value !== "abort-signal" && value !== "job-timeout") {
    throw new Error("blind batch run receipt terminationReason 无效。");
  }
  return value;
}

function validateReceiptStatusTerminationCoherence(
  status: RealMediaBlindBatchRunStatus,
  terminationReason: "native-terminal" | "abort-signal" | "job-timeout"
): void {
  if (
    (terminationReason === "job-timeout" && status !== "timed-out") ||
    (terminationReason === "abort-signal" && status !== "cancelled") ||
    (terminationReason !== "job-timeout" && status === "timed-out")
  ) {
    throw new Error("blind batch run receipt status 与 terminationReason 不一致。");
  }
}

function validateReceiptRunOutcomeCoherence(
  status: RealMediaBlindBatchRunStatus,
  outcomes: readonly RealMediaBlindBatchPairOutcome[]
): void {
  const failed = outcomes.filter((outcome) => outcome.nativeStatus === "failed").length;
  const cancelled = outcomes.filter((outcome) => outcome.nativeStatus === "cancelled").length;
  if (
    (status === "completed" && (failed !== 0 || cancelled !== 0)) ||
    (status === "completed-with-errors" && (failed === 0 || cancelled !== 0)) ||
    (status === "failed" && failed === 0) ||
    ((status === "cancelled" || status === "timed-out") && cancelled === 0)
  ) {
    throw new Error("blind batch run receipt status 与完整 pair outcomes 不一致。");
  }
}

function validateReceiptNativePairStatus(value: unknown): "completed" | "failed" | "cancelled" {
  if (value !== "completed" && value !== "failed" && value !== "cancelled") {
    throw new Error("receipt nativeStatus 必须是 completed/failed/cancelled。");
  }
  return value;
}

function assertAlignmentTimeMapExactKeys(value: unknown, label: string): void {
  const timeMap = requireExactRecord(
    value,
    [
      "sourceStartMs",
      "sourceEndMs",
      "targetStartMs",
      "targetEndMs",
      "spans",
      "quality",
      "evidence",
      "sourceStream",
      "targetStream",
      "sourceVisualStream",
      "targetVisualStream",
      "sourceIdentity",
      "targetIdentity",
      "engineVersion",
      "featureVersion",
      "parametersHash"
    ],
    `${label}.proposalTimeMap`
  );
  requireExactRecord(
    timeMap.quality,
    [
      "level",
      "probability",
      "metricSource",
      "coverage",
      "uniqueContentCoverage",
      "p50ResidualMs",
      "p95ResidualMs",
      "p99ResidualMs",
      "maxResidualMs",
      "boundaryUncertaintyMs",
      "alternativeMargin",
      "anchorCount",
      "anchorRegionCount",
      "heldOutAnchorCount",
      "reasons"
    ],
    `${label}.proposalTimeMap.quality`
  );
  const evidence = requireExactRecord(
    timeMap.evidence,
    [
      "types",
      "audioAnchorCount",
      "visualAnchorCount",
      "heldOutAnchorCount",
      "top1Top2Margin",
      "uniqueContentCoverage",
      "repeatedContentOnly",
      "selectedTrackReason",
      "alternativeTrackScores",
      "notes"
    ],
    `${label}.proposalTimeMap.evidence`
  );
  if (!Array.isArray(evidence.alternativeTrackScores)) {
    throw new Error(`${label}.proposalTimeMap.evidence.alternativeTrackScores 必须是数组。`);
  }
  evidence.alternativeTrackScores.forEach((alternative, index) => {
    requireExactRecord(
      alternative,
      ["sourceStreamIndex", "targetStreamIndex", "score", "scale", "offsetMs", "inlierCount"],
      `${label}.proposalTimeMap.evidence.alternativeTrackScores[${index}]`
    );
  });
  assertStreamExactKeys(timeMap.sourceStream, `${label}.sourceStream`, false);
  assertStreamExactKeys(timeMap.targetStream, `${label}.targetStream`, false);
  assertStreamExactKeys(timeMap.sourceVisualStream, `${label}.sourceVisualStream`, true);
  assertStreamExactKeys(timeMap.targetVisualStream, `${label}.targetVisualStream`, true);
  assertIdentityExactKeys(timeMap.sourceIdentity, `${label}.sourceIdentity`);
  assertIdentityExactKeys(timeMap.targetIdentity, `${label}.targetIdentity`);
  if (!Array.isArray(timeMap.spans)) {
    throw new Error(`${label}.proposalTimeMap.spans 必须是数组。`);
  }
  timeMap.spans.forEach((span, index) =>
    assertCompleteSpanExactKeys(span, `${label}.spans[${index}]`)
  );
}

function assertStreamExactKeys(value: unknown, label: string, nullable: boolean): void {
  if (value === null && nullable) return;
  requireExactRecord(
    value,
    [
      "type",
      "index",
      "codec",
      "startMs",
      "timelineOffsetMs",
      "timeBase",
      "sampleRate",
      "channels",
      "frameRate",
      "language",
      "title"
    ],
    label
  );
}

function assertIdentityExactKeys(value: unknown, label: string): void {
  requireExactRecord(
    value,
    [
      "algorithm",
      "sizeBytes",
      "modifiedUnixMs",
      "firstSampleDigest",
      "middleSampleDigest",
      "lastSampleDigest"
    ],
    label
  );
}

function assertCompleteSpanExactKeys(value: unknown, label: string): void {
  const span = requireExactRecord(
    value,
    [
      "kind",
      "sourceStartMs",
      "sourceEndMs",
      "targetStartMs",
      "targetEndMs",
      "id",
      "reason",
      "quality",
      "boundaries",
      "alternatives"
    ],
    label
  );
  const quality = requireExactRecord(
    span.quality,
    [
      "level",
      "metricSource",
      "probability",
      "coverage",
      "uniqueContentCoverage",
      "alternativeMargin",
      "anchorCount",
      "heldOutAnchorCount",
      "p50ResidualMs",
      "p95ResidualMs",
      "p99ResidualMs",
      "maxResidualMs",
      "boundaryUncertaintyMs",
      "leftSupport",
      "rightSupport",
      "signals",
      "reasons"
    ],
    `${label}.quality`
  );
  requireExactRecord(
    quality.signals,
    ["audio", "visual", "danmaku"],
    `${label}.quality.signals`
  );
  const boundaries = requireExactRecord(
    span.boundaries,
    ["start", "end"],
    `${label}.boundaries`
  );
  assertBoundaryExactKeys(boundaries.start, `${label}.boundaries.start`);
  assertBoundaryExactKeys(boundaries.end, `${label}.boundaries.end`);
  if (!Array.isArray(span.alternatives)) {
    throw new Error(`${label}.alternatives 必须是数组。`);
  }
  span.alternatives.forEach((alternative, index) => {
    requireExactRecord(
      alternative,
      [
        "kind",
        "score",
        "sourceStartMs",
        "sourceEndMs",
        "targetStartMs",
        "targetEndMs",
        "reason"
      ],
      `${label}.alternatives[${index}]`
    );
  });
}

function assertBoundaryExactKeys(value: unknown, label: string): void {
  requireExactRecord(
    value,
    [
      "status",
      "axis",
      "contextSide",
      "coarseMs",
      "refinedMs",
      "uncertaintyStartMs",
      "uncertaintyEndMs",
      "supportDurationMs",
      "correlation",
      "alternativeMargin",
      "reason"
    ],
    label
  );
}

function validateVisualStreamBinding(
  stream: AlignmentTimeMapProposal["sourceVisualStream"],
  expectedIndex: number | null,
  visualRequired: boolean,
  label: string
): void {
  if (!visualRequired) {
    if (stream !== undefined && stream !== null) {
      throw new Error(`${label} 在关闭视觉证据时意外存在，拒绝混入未请求的视觉结果。`);
    }
    return;
  }
  if (stream === undefined || stream === null) {
    throw new Error(`${label} 未证明视觉证据实际消费了视频流。`);
  }
  if (stream.type !== "video" || (expectedIndex !== null && stream.index !== expectedIndex)) {
    throw new Error(`${label} 索引错配。`);
  }
}

export function createRealMediaBlindBatchSourceRanking(
  sourceMediaId: string,
  outcomes: readonly RealMediaBlindBatchPairOutcome[],
  topK: number
): RealMediaBlindBatchSourceRanking {
  const candidates = outcomes
    .filter((outcome) => outcome.sourceMediaId === sourceMediaId)
    .map((outcome) => {
      const decision = outcome.globalSelection.decisionCandidate;
      return {
        relationRank: 0,
        pairOrdinal: outcome.pairOrdinal,
        targetMediaId: outcome.targetMediaId,
        nativeStatus: outcome.nativeStatus,
        globalSelected: outcome.globalSelected,
        decisionScore: outcome.globalSelection.decisionScore,
        pairLocalScore: decision?.score ?? null,
        margin: outcome.globalSelection.margin,
        qualityLevel: outcome.proposalTimeMap?.quality.level ?? null
      } satisfies RealMediaBlindBatchRankedCandidate;
    })
    .sort(compareRankedCandidates)
    .map((candidate, index) => ({ ...candidate, relationRank: index + 1 }));
  return {
    sourceMediaId,
    candidates,
    topK: candidates.slice(0, topK).map((candidate) => ({ ...candidate }))
  };
}

export function createRealMediaBlindBatchTargetRanking(
  targetMediaId: string,
  outcomes: readonly RealMediaBlindBatchPairOutcome[],
  topK: number
): RealMediaBlindBatchTargetRanking {
  const candidates = outcomes
    .filter((outcome) => outcome.targetMediaId === targetMediaId)
    .map((outcome) => {
      const decision = outcome.globalSelection.decisionCandidate;
      return {
        relationRank: 0,
        pairOrdinal: outcome.pairOrdinal,
        sourceMediaId: outcome.sourceMediaId,
        nativeStatus: outcome.nativeStatus,
        globalSelected: outcome.globalSelected,
        decisionScore: outcome.globalSelection.decisionScore,
        pairLocalScore: decision?.score ?? null,
        margin: outcome.globalSelection.margin,
        qualityLevel: outcome.proposalTimeMap?.quality.level ?? null
      } satisfies RealMediaBlindBatchTargetRankedCandidate;
    })
    .sort(compareTargetRankedCandidates)
    .map((candidate, index) => ({ ...candidate, relationRank: index + 1 }));
  return {
    targetMediaId,
    candidates,
    topK: candidates.slice(0, topK).map((candidate) => ({ ...candidate }))
  };
}

function compareRankedCandidates(
  left: RealMediaBlindBatchRankedCandidate,
  right: RealMediaBlindBatchRankedCandidate
): number {
  if (left.decisionScore === null && right.decisionScore !== null) return 1;
  if (left.decisionScore !== null && right.decisionScore === null) return -1;
  if (left.decisionScore !== null && right.decisionScore !== null) {
    const scoreOrder = right.decisionScore - left.decisionScore;
    if (scoreOrder !== 0) return scoreOrder;
  }
  if (left.pairLocalScore === null && right.pairLocalScore !== null) return 1;
  if (left.pairLocalScore !== null && right.pairLocalScore === null) return -1;
  if (left.pairLocalScore !== null && right.pairLocalScore !== null) {
    const pairScoreOrder = right.pairLocalScore - left.pairLocalScore;
    if (pairScoreOrder !== 0) return pairScoreOrder;
  }
  return left.pairOrdinal - right.pairOrdinal;
}

function compareTargetRankedCandidates(
  left: RealMediaBlindBatchTargetRankedCandidate,
  right: RealMediaBlindBatchTargetRankedCandidate
): number {
  if (left.decisionScore === null && right.decisionScore !== null) return 1;
  if (left.decisionScore !== null && right.decisionScore === null) return -1;
  if (left.decisionScore !== null && right.decisionScore !== null) {
    const scoreOrder = right.decisionScore - left.decisionScore;
    if (scoreOrder !== 0) return scoreOrder;
  }
  if (left.pairLocalScore === null && right.pairLocalScore !== null) return 1;
  if (left.pairLocalScore !== null && right.pairLocalScore === null) return -1;
  if (left.pairLocalScore !== null && right.pairLocalScore !== null) {
    const pairScoreOrder = right.pairLocalScore - left.pairLocalScore;
    if (pairScoreOrder !== 0) return pairScoreOrder;
  }
  return left.pairOrdinal - right.pairOrdinal;
}

function validateExecutionMediaArray(
  value: unknown,
  label: "sources" | "targets"
): RealMediaBlindBatchExecutionMedia[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error(`${label} 必须包含 1–64 个 distinct media。`);
  }
  return value.map((item, index) => {
    const media = requireExactRecord(
      item,
      ["mediaId", "path", "contentIdentity", "audioStreamIndex", "videoStreamIndex"],
      `${label}[${index}]`
    );
    const mediaId = requireIdentifier(media.mediaId, `${label}[${index}].mediaId`);
    const path = requireCanonicalPath(media.path, `${label}[${index}].path`);
    if (path.includes("\u0000")) throw new Error(`${label}[${index}].path 含 NUL。`);
    const contentIdentity = requireExactRecord(
      media.contentIdentity,
      [
        "algorithm",
        "sizeBytes",
        "modifiedUnixMs",
        "firstSampleDigest",
        "middleSampleDigest",
        "lastSampleDigest"
      ],
      `${label}[${index}].contentIdentity`
    );
    if (!isMediaContentIdentity(contentIdentity)) {
      throw new Error(`${label}[${index}].contentIdentity 无效。`);
    }
    if (contentIdentity.algorithm !== "sha256-full-file-v2") {
      throw new Error(`${label}[${index}].contentIdentity 必须是完整文件 SHA-256 v2 身份。`);
    }
    const audioStreamIndex = requireNonNegativeSafeInteger(
      media.audioStreamIndex,
      `${label}[${index}].audioStreamIndex`
    );
    const videoStreamIndex = requireNonNegativeSafeIntegerOrNull(
      media.videoStreamIndex,
      `${label}[${index}].videoStreamIndex`
    );
    return {
      mediaId,
      path,
      contentIdentity: cloneMediaContentIdentity(contentIdentity)!,
      audioStreamIndex,
      videoStreamIndex
    };
  });
}

function ensureDistinctExecutionMedia(
  sources: readonly RealMediaBlindBatchExecutionMedia[],
  targets: readonly RealMediaBlindBatchExecutionMedia[],
  enableVisualEvidence: boolean
): void {
  const ids = new Set<string>();
  const identityByPath = new Map<string, string>();
  const mediaViews = new Set<string>();
  for (const media of [...sources, ...targets]) {
    if (ids.has(media.mediaId)) throw new Error(`execution media ID 重复：${media.mediaId}`);
    ids.add(media.mediaId);
    const pathKey = normalizePathForDistinctness(media.path);
    const identityKey = contentIdentityDistinctnessKey(media.contentIdentity);
    const knownIdentity = identityByPath.get(pathKey);
    if (knownIdentity !== undefined && knownIdentity !== identityKey) {
      throw new Error("execution suite 的同一本地路径声明了不同内容身份。");
    }
    identityByPath.set(pathKey, identityKey);
    // A video stream is part of the effective evidence view only when the native V2 request will
    // actually execute visual validation. Otherwise differing video indices would create duplicate
    // logical candidates backed by the exact same physical content and audio evidence.
    const effectiveVideoStreamIndex = enableVisualEvidence ? media.videoStreamIndex : null;
    const viewKey = JSON.stringify([
      identityKey,
      media.audioStreamIndex,
      effectiveVideoStreamIndex
    ]);
    if (mediaViews.has(viewKey)) {
      throw new Error(
        enableVisualEvidence
          ? "execution suite 包含重复的内容身份与有效流视图：音轨和实际消费的视频流均相同。"
          : "execution suite 包含重复的内容身份与有效流视图：关闭视觉证据时，仅视频流不同不能形成独立候选。"
      );
    }
    mediaViews.add(viewKey);
  }
}

function validateFullCartesianPairs(
  value: unknown,
  sources: readonly RealMediaBlindBatchExecutionMedia[],
  targets: readonly RealMediaBlindBatchExecutionMedia[]
): RealMediaBlindBatchPairRegistration[] {
  if (!Array.isArray(value) || value.length !== sources.length * targets.length) {
    throw new Error("execution suite.pairs 必须完整注册 source×target 全笛卡尔积。");
  }
  return value.map((item, index) => {
    const pair = requireExactRecord(
      item,
      ["pairOrdinal", "sourceMediaId", "targetMediaId"],
      `pairs[${index}]`
    );
    const expectedSource = sources[Math.floor(index / targets.length)];
    const expectedTarget = targets[index % targets.length];
    if (!expectedSource || !expectedTarget) throw new Error("全笛卡尔 pair 计划索引越界。");
    if (
      pair.pairOrdinal !== index + 1 ||
      pair.sourceMediaId !== expectedSource.mediaId ||
      pair.targetMediaId !== expectedTarget.mediaId
    ) {
      throw new Error(
        "execution suite.pairs 必须按 source-major/target-minor 完整且无重复注册。"
      );
    }
    return {
      pairOrdinal: index + 1,
      sourceMediaId: expectedSource.mediaId,
      targetMediaId: expectedTarget.mediaId
    };
  });
}

function validateAlignmentParameters(value: unknown): RealMediaBlindBatchAlignmentParameters {
  const parameters = requireExactRecord(
    value,
    [
      "ffmpegPath",
      "ffprobePath",
      "sampleRate",
      "windowMs",
      "matchThreshold",
      "minGapMs",
      "maxCells",
      "enableVisualEvidence",
      "visualSampleIntervalMs"
    ],
    "parameters"
  );
  const ffmpegPath = requireCanonicalPathOrNull(parameters.ffmpegPath, "parameters.ffmpegPath");
  const ffprobePath = requireCanonicalPathOrNull(
    parameters.ffprobePath,
    "parameters.ffprobePath"
  );
  const sampleRate = requirePositiveSafeIntegerOrNull(
    parameters.sampleRate,
    "parameters.sampleRate"
  );
  const windowMs = requirePositiveSafeIntegerOrNull(parameters.windowMs, "parameters.windowMs");
  const matchThreshold = requireUnitNumberOrNull(
    parameters.matchThreshold,
    "parameters.matchThreshold"
  );
  const minGapMs = requireNonNegativeSafeIntegerOrNull(
    parameters.minGapMs,
    "parameters.minGapMs"
  );
  const maxCells = requirePositiveSafeIntegerOrNull(parameters.maxCells, "parameters.maxCells");
  if (typeof parameters.enableVisualEvidence !== "boolean") {
    throw new Error("parameters.enableVisualEvidence 必须是 boolean。");
  }
  const visualSampleIntervalMs = requirePositiveSafeIntegerOrNull(
    parameters.visualSampleIntervalMs,
    "parameters.visualSampleIntervalMs"
  );
  return {
    ffmpegPath,
    ffprobePath,
    sampleRate,
    windowMs,
    matchThreshold,
    minGapMs,
    maxCells,
    enableVisualEvidence: parameters.enableVisualEvidence,
    visualSampleIntervalMs
  };
}

export function assertRealMediaBlindBatchReceiptIsPathFree(
  receipt: RealMediaBlindBatchRunReceipt,
  suite: RealMediaBlindBatchExecutionSuite
): void {
  const receiptStrings: string[] = [];
  collectStringValues(receipt, receiptStrings);
  for (const path of [
    ...suite.sources.map((media) => media.path),
    ...suite.targets.map((media) => media.path),
    suite.parameters.ffmpegPath,
    suite.parameters.ffprobePath
  ]) {
    if (!path) continue;
    const normalized = normalizePathForDistinctness(path);
    if (
      receiptStrings.some((value) => normalizePathForDistinctness(value).includes(normalized))
    ) {
      throw new Error("blind batch receipt 意外包含本地路径，已拒绝返回。");
    }
  }
}

function collectStringValues(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item: unknown) => collectStringValues(item, output));
    return;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((item) => collectStringValues(item, output));
  }
}

function requireExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象。`);
  const actualKeys = Object.keys(value).sort();
  const canonicalExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== canonicalExpectedKeys.length ||
    actualKeys.some((key, index) => key !== canonicalExpectedKeys[index])
  ) {
    throw new Error(`${label} 字段不完整或含 gold/额外字段。`);
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  const text = requireNonBlankString(value, label);
  if (
    text !== text.trim() ||
    text.length > 512 ||
    [...text].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) ||
    text.includes("/") ||
    text.includes("\\")
  ) {
    throw new Error(`${label} 无效。`);
  }
  return text;
}

function requireNonBlankString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 不能为空。`);
  return value;
}

function requireCanonicalPath(value: unknown, label: string): string {
  const path = requireNonBlankString(value, label);
  if (
    path !== path.trim() ||
    path.includes("\u0000") ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(path)
  ) {
    throw new Error(`${label} 必须是 canonical 本地路径。`);
  }
  return path;
}

function requireCanonicalPathOrNull(value: unknown, label: string): string | null {
  return value === null ? null : requireCanonicalPath(value, label);
}

function requireSha256Digest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} 必须是 canonical sha256 digest。`);
  }
  return value as `sha256:${string}`;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  const number = requireNonNegativeSafeInteger(value, label);
  if (number === 0) throw new Error(`${label} 必须是正安全整数。`);
  return number;
}

function requirePositiveSafeIntegerOrNull(value: unknown, label: string): number | null {
  return value === null ? null : requirePositiveSafeInteger(value, label);
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负安全整数。`);
  }
  return value;
}

function requireNonNegativeSafeIntegerOrNull(value: unknown, label: string): number | null {
  return value === null ? null : requireNonNegativeSafeInteger(value, label);
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} 必须是安全整数。`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} 必须是有限数值。`);
  }
  return value;
}

function requireFiniteNumberOrNull(value: unknown, label: string): number | null {
  return value === null ? null : requireFiniteNumber(value, label);
}

function requirePositiveFiniteNumber(value: unknown, label: string): number {
  const number = requireFiniteNumber(value, label);
  if (number <= 0) throw new Error(`${label} 必须大于 0。`);
  return number;
}

function requireUnitNumber(value: unknown, label: string): number {
  const number = requireFiniteNumber(value, label);
  if (number < 0 || number > 1) throw new Error(`${label} 必须位于 0 到 1。`);
  return number;
}

function requireUnitNumberOrNull(value: unknown, label: string): number | null {
  return value === null ? null : requireUnitNumber(value, label);
}

function contentIdentityDistinctnessKey(identity: MediaContentIdentity): string {
  return canonicalJson([
    identity.algorithm,
    identity.sizeBytes,
    identity.firstSampleDigest,
    identity.middleSampleDigest,
    identity.lastSampleDigest,
    identity.algorithm === "sha256-full-file-v2" ? null : identity.modifiedUnixMs
  ]);
}

function normalizePathForDistinctness(path: string): string {
  return path.trim().split("/").join("\\").toLocaleLowerCase("en-US");
}

function assertCanonicalEqual(left: unknown, right: unknown, message: string): void {
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error(message);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON 不接受非有限数值。");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("canonical JSON 不接受 undefined、函数或 symbol。");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
