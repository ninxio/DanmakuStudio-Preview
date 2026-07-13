import { isAlignmentTimeMapProposal } from "../../domain/alignment/timeMapProposal";
import type { AlignmentTimeMapProposal } from "../../domain/alignment/types";
import {
  assertRealMediaBlindBatchDecisionCandidateMatchesTimeMap,
  assertRealMediaBlindBatchReceiptIsPathFree,
  createRealMediaBlindBatchExecutionDigest,
  createRealMediaBlindBatchRunReceiptDigest,
  createRealMediaBlindBatchSourceRanking,
  createRealMediaBlindBatchTargetRanking,
  REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION,
  REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION,
  REAL_MEDIA_BLIND_BATCH_RUNNER_VERSION,
  validateRealMediaBlindBatchExecutionSuite,
  validateRealMediaBlindBatchGlobalSelectionEvidence,
  validateRealMediaBlindBatchProposalBinding
} from "../../domain/alignment/realMediaBlindBatchContract";
import type {
  NativeBatchGlobalSelectionEvidence,
  NativeBatchPairingMode,
  RealMediaBlindBatchExecutionSuite,
  RealMediaBlindBatchPairOutcome,
  RealMediaBlindBatchRunReceipt,
  RealMediaBlindBatchRunStatus
} from "../../domain/alignment/realMediaBlindBatchContract";
import {
  cancelTauriAudioAlignmentBatchJob,
  getTauriAudioAlignmentBatchJob,
  isAudioAlignmentJobFinished,
  startTauriAudioAlignmentBatchJob,
  type AudioAlignmentBatchJobInvoker,
  type AudioAlignmentBatchJobSnapshot,
  type AudioAlignmentBatchPairSnapshot,
  type AudioAlignmentJobStatus,
  type TauriAudioAlignmentBatchRequest
} from "./tauriAudioAlignment";

export {
  createRealMediaBlindBatchExecutionDigest,
  createRealMediaBlindBatchRunReceiptDigest,
  REAL_MEDIA_BLIND_BATCH_EXECUTION_SCHEMA_VERSION,
  REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION,
  REAL_MEDIA_BLIND_BATCH_RUNNER_VERSION,
  validateRealMediaBlindBatchExecutionSuite,
  validateRealMediaBlindBatchRunReceipt
} from "../../domain/alignment/realMediaBlindBatchContract";
export type {
  NativeBatchGlobalCandidateEvidence,
  NativeBatchGlobalSelectionEvidence,
  NativeBatchGlobalSelectionState,
  NativeBatchPairingMode,
  RealMediaBlindBatchAlignmentParameters,
  RealMediaBlindBatchExecutionMedia,
  RealMediaBlindBatchExecutionSuite,
  RealMediaBlindBatchPairFailureCode,
  RealMediaBlindBatchPairOutcome,
  RealMediaBlindBatchPairRegistration,
  RealMediaBlindBatchRankedCandidate,
  RealMediaBlindBatchRunReceipt,
  RealMediaBlindBatchRunStatus,
  RealMediaBlindBatchSourceRanking,
  RealMediaBlindBatchTargetRankedCandidate,
  RealMediaBlindBatchTargetRanking
} from "../../domain/alignment/realMediaBlindBatchContract";

const NATIVE_BATCH_EVIDENCE_VERSION = REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_JOB_WALL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_CANCELLATION_GRACE_MS = 30_000;

export interface RealMediaBlindBatchRunnerOptions {
  pollIntervalMs?: number;
  maxJobWallMs?: number;
  cancellationGraceMs?: number;
  signal?: AbortSignal;
  alignmentInvoker?: AudioAlignmentBatchJobInvoker;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

interface NativeBatchEvidenceSnapshot extends AudioAlignmentBatchJobSnapshot {
  evidenceVersion: 1;
  pairingMode: NativeBatchPairingMode;
  sourceMediaIds: string[];
  targetMediaIds: string[];
  pairs: NativeBatchEvidencePairSnapshot[];
}

interface NativeBatchEvidencePairSnapshot extends AudioAlignmentBatchPairSnapshot {
  pairIndex: number;
  globalSelection: NativeBatchGlobalSelectionEvidence;
}

interface ValidatedRunnerOptions {
  pollIntervalMs: number;
  maxJobWallMs: number;
  cancellationGraceMs: number;
  signal: AbortSignal | undefined;
  alignmentInvoker: AudioAlignmentBatchJobInvoker | undefined;
  now: () => number;
  wait: (milliseconds: number) => Promise<void>;
}

interface TerminalObservation {
  snapshot: NativeBatchEvidenceSnapshot;
  terminationReason: "native-terminal" | "abort-signal" | "job-timeout";
}

export async function runRealMediaBlindBatchSuite(
  value: unknown,
  options: RealMediaBlindBatchRunnerOptions = {}
): Promise<RealMediaBlindBatchRunReceipt> {
  const suite = validateRealMediaBlindBatchExecutionSuite(value);
  const executionDigest = createRealMediaBlindBatchExecutionDigest(suite);
  const runnerOptions = validateRunnerOptions(options);
  if (runnerOptions.signal?.aborted) {
    throw new Error("blind batch execution suite 已在启动前取消。");
  }
  const startedAt = runnerOptions.now();
  const request = createNativeBatchRequest(suite);
  let snapshot: NativeBatchEvidenceSnapshot | null = null;
  let startedSnapshot: AudioAlignmentBatchJobSnapshot | null = null;
  let cancellationAttempted = false;
  try {
    startedSnapshot = await startTauriAudioAlignmentBatchJob(
      request,
      runnerOptions.alignmentInvoker
    );
    snapshot = validateNativeBatchEvidenceSnapshot(startedSnapshot, suite);
    const terminal = await waitForTerminalSnapshot(
      snapshot,
      suite,
      runnerOptions,
      startedAt,
      () => {
        cancellationAttempted = true;
      }
    );
    snapshot = terminal.snapshot;
    cancellationAttempted = terminal.terminationReason !== "native-terminal";
    const withoutDigest = createReceiptWithoutDigest(
      suite,
      executionDigest,
      terminal,
      Math.max(0, Math.round(runnerOptions.now() - startedAt))
    );
    const receipt: RealMediaBlindBatchRunReceipt = {
      ...withoutDigest,
      receiptDigest: createRealMediaBlindBatchRunReceiptDigest(withoutDigest)
    };
    assertRealMediaBlindBatchReceiptIsPathFree(receipt, suite);
    return receipt;
  } catch (error: unknown) {
    if (
      startedSnapshot !== null &&
      !cancellationAttempted &&
      !isAudioAlignmentJobFinished(startedSnapshot.status)
    ) {
      await bestEffortCancel(startedSnapshot.jobId, runnerOptions.alignmentInvoker);
    }
    throw error;
  }
}

async function waitForTerminalSnapshot(
  initial: NativeBatchEvidenceSnapshot,
  suite: RealMediaBlindBatchExecutionSuite,
  options: ValidatedRunnerOptions,
  startedAt: number,
  onCancellationRequested: () => void
): Promise<TerminalObservation> {
  let snapshot = initial;
  while (!isAudioAlignmentJobFinished(snapshot.status)) {
    if (options.signal?.aborted) {
      onCancellationRequested();
      return cancelAndWaitForTerminal(snapshot, suite, options, "abort-signal");
    }
    if (options.now() - startedAt >= options.maxJobWallMs) {
      onCancellationRequested();
      return cancelAndWaitForTerminal(snapshot, suite, options, "job-timeout");
    }
    await options.wait(options.pollIntervalMs);
    snapshot = validateNativeBatchEvidenceSnapshot(
      await getTauriAudioAlignmentBatchJob(snapshot.jobId, options.alignmentInvoker),
      suite,
      snapshot.jobId
    );
  }
  return { snapshot, terminationReason: "native-terminal" };
}

async function cancelAndWaitForTerminal(
  current: NativeBatchEvidenceSnapshot,
  suite: RealMediaBlindBatchExecutionSuite,
  options: ValidatedRunnerOptions,
  reason: "abort-signal" | "job-timeout"
): Promise<TerminalObservation> {
  let snapshot = validateNativeBatchEvidenceSnapshot(
    await cancelTauriAudioAlignmentBatchJob(current.jobId, options.alignmentInvoker),
    suite,
    current.jobId
  );
  const cancellationStartedAt = options.now();
  while (!isAudioAlignmentJobFinished(snapshot.status)) {
    if (options.now() - cancellationStartedAt >= options.cancellationGraceMs) {
      throw new Error("blind batch native 任务在取消宽限期内没有进入终态。");
    }
    await options.wait(options.pollIntervalMs);
    snapshot = validateNativeBatchEvidenceSnapshot(
      await getTauriAudioAlignmentBatchJob(snapshot.jobId, options.alignmentInvoker),
      suite,
      current.jobId
    );
  }
  return { snapshot, terminationReason: reason };
}

async function bestEffortCancel(
  jobId: string,
  invoker: AudioAlignmentBatchJobInvoker | undefined
): Promise<void> {
  try {
    await cancelTauriAudioAlignmentBatchJob(jobId, invoker);
  } catch {
    // Preserve the binding/transport failure that triggered cleanup. Cancellation is best-effort.
  }
}

function createNativeBatchRequest(
  suite: RealMediaBlindBatchExecutionSuite
): TauriAudioAlignmentBatchRequest {
  const parameters = suite.parameters;
  return {
    sources: suite.sources.map((media) => ({
      mediaId: media.mediaId,
      path: media.path,
      audioStreamIndex: media.audioStreamIndex,
      videoStreamIndex: media.videoStreamIndex
    })),
    targets: suite.targets.map((media) => ({
      mediaId: media.mediaId,
      path: media.path,
      audioStreamIndex: media.audioStreamIndex,
      videoStreamIndex: media.videoStreamIndex
    })),
    // Deliberately omit `pairs`: only the native fullCartesian planner can produce accepted proof.
    ffmpegPath: parameters.ffmpegPath,
    ffprobePath: parameters.ffprobePath,
    ...(parameters.sampleRate === null ? {} : { sampleRate: parameters.sampleRate }),
    ...(parameters.windowMs === null ? {} : { windowMs: parameters.windowMs }),
    ...(parameters.matchThreshold === null
      ? {}
      : { matchThreshold: parameters.matchThreshold }),
    ...(parameters.minGapMs === null ? {} : { minGapMs: parameters.minGapMs }),
    ...(parameters.maxCells === null ? {} : { maxCells: parameters.maxCells }),
    enableVisualEvidence: parameters.enableVisualEvidence,
    ...(parameters.visualSampleIntervalMs === null
      ? {}
      : { visualSampleIntervalMs: parameters.visualSampleIntervalMs }),
    localizationMode: true
  };
}

function validateNativeBatchEvidenceSnapshot(
  value: AudioAlignmentBatchJobSnapshot,
  suite: RealMediaBlindBatchExecutionSuite,
  expectedJobId?: string
): NativeBatchEvidenceSnapshot {
  const snapshot = value as unknown as Record<string, unknown>;
  if (snapshot.evidenceVersion !== NATIVE_BATCH_EVIDENCE_VERSION) {
    throw new Error("native batch 缺少受支持的 evidenceVersion=1 结构化证据。");
  }
  if (snapshot.pairingMode !== "fullCartesian") {
    throw new Error("native batch pairingMode 不是 fullCartesian，拒绝 blind receipt。");
  }
  if (expectedJobId !== undefined && value.jobId !== expectedJobId) {
    throw new Error("native batch jobId 在轮询期间发生变化。");
  }
  const sourceMediaIds = requireStringArray(snapshot.sourceMediaIds, "native sourceMediaIds");
  const targetMediaIds = requireStringArray(snapshot.targetMediaIds, "native targetMediaIds");
  assertStringArraysEqual(
    sourceMediaIds,
    suite.sources.map((media) => media.mediaId),
    "native sourceMediaIds"
  );
  assertStringArraysEqual(
    targetMediaIds,
    suite.targets.map((media) => media.mediaId),
    "native targetMediaIds"
  );
  if (
    value.totalPairCount !== suite.pairs.length ||
    value.pairs.length !== suite.pairs.length
  ) {
    throw new Error("native batch 回包缺少或多出了 full-Cartesian pair。");
  }
  const pairs = value.pairs.map((pair, index) =>
    validateNativePairEvidence(pair, index, suite)
  );
  return {
    ...value,
    evidenceVersion: NATIVE_BATCH_EVIDENCE_VERSION,
    pairingMode: "fullCartesian",
    sourceMediaIds,
    targetMediaIds,
    pairs
  };
}

function validateNativePairEvidence(
  value: AudioAlignmentBatchPairSnapshot,
  pairIndex: number,
  suite: RealMediaBlindBatchExecutionSuite
): NativeBatchEvidencePairSnapshot {
  const pair = value as unknown as Record<string, unknown>;
  const expected = suite.pairs[pairIndex];
  if (!expected) throw new Error("native batch pair 索引超过 execution suite。");
  if (pair.pairIndex !== pairIndex) {
    throw new Error(`native pairIndex 与 source-major 数组索引错配：${pairIndex}。`);
  }
  if (
    value.pairOrdinal !== expected.pairOrdinal ||
    value.sourceMediaId !== expected.sourceMediaId ||
    value.targetMediaId !== expected.targetMediaId
  ) {
    throw new Error(`native pair #${expected.pairOrdinal} 的 ordinal/媒体身份错配。`);
  }
  const source = suite.sources.find((media) => media.mediaId === expected.sourceMediaId);
  const target = suite.targets.find((media) => media.mediaId === expected.targetMediaId);
  if (!source || !target) throw new Error("execution suite pair 引用了缺失媒体。");
  const globalSelection = validateRealMediaBlindBatchGlobalSelectionEvidence(
    pair.globalSelection,
    value.status,
    source,
    target,
    `native pair #${expected.pairOrdinal}`
  );
  if (value.status === "completed") {
    const proposal = value.proposal;
    if (!proposal?.timeMap || !isAlignmentTimeMapProposal(proposal.timeMap, true)) {
      throw new Error(
        `native pair #${expected.pairOrdinal} 返回了非完整 V2 proposal TimeMap。`
      );
    }
    validateRealMediaBlindBatchProposalBinding(
      proposal.timeMap,
      source,
      target,
      suite.parameters,
      expected.pairOrdinal
    );
    if (globalSelection.state !== "selected" && globalSelection.state !== "blocked") {
      throw new Error("completed native pair 的 globalSelection 必须为 selected 或 blocked。");
    }
    if (globalSelection.decisionCandidate) {
      assertRealMediaBlindBatchDecisionCandidateMatchesTimeMap(
        globalSelection.decisionCandidate,
        proposal.timeMap,
        expected.pairOrdinal
      );
    }
  } else if (value.status === "failed") {
    if (globalSelection.state !== "failed") {
      throw new Error("failed native pair 的 globalSelection.state 必须为 failed。");
    }
  } else if (value.status === "cancelled") {
    if (globalSelection.state !== "cancelled") {
      throw new Error("cancelled native pair 的 globalSelection.state 必须为 cancelled。");
    }
  } else if (globalSelection.state !== "pending") {
    throw new Error("非终态 native pair 的 globalSelection.state 必须为 pending。");
  }
  return {
    ...value,
    pairIndex,
    globalSelection
  };
}

function createReceiptWithoutDigest(
  suite: RealMediaBlindBatchExecutionSuite,
  executionDigest: `sha256:${string}`,
  terminal: TerminalObservation,
  wallElapsedMs: number
): Omit<RealMediaBlindBatchRunReceipt, "receiptDigest"> {
  const pairOutcomes = terminal.snapshot.pairs.map((pair) => createPairOutcome(pair));
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
  return {
    schemaVersion: REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION,
    receiptKind: "c137-real-media-blind-batch-run",
    runnerVersion: REAL_MEDIA_BLIND_BATCH_RUNNER_VERSION,
    suiteId: suite.suiteId,
    datasetVersion: suite.datasetVersion,
    executionDigest,
    nativeJobId: terminal.snapshot.jobId,
    nativeEvidenceVersion: NATIVE_BATCH_EVIDENCE_VERSION,
    pairingMode: "fullCartesian",
    status: deriveRunStatus(terminal),
    terminationReason: terminal.terminationReason,
    wallElapsedMs,
    sourceCount: suite.sources.length,
    targetCount: suite.targets.length,
    pairCount: suite.pairs.length,
    topK: suite.topK,
    pairOutcomes,
    sourceRankings,
    targetRankings
  };
}

function createPairOutcome(
  pair: NativeBatchEvidencePairSnapshot
): RealMediaBlindBatchPairOutcome {
  const nativeStatus = requireTerminalPairStatus(pair.status);
  return {
    pairIndex: pair.pairIndex,
    pairOrdinal: pair.pairOrdinal,
    sourceMediaId: pair.sourceMediaId,
    targetMediaId: pair.targetMediaId,
    nativeStatus,
    failureCode:
      nativeStatus === "failed"
        ? "native-pair-failed"
        : nativeStatus === "cancelled"
          ? "native-pair-cancelled"
          : null,
    globalSelected: pair.globalSelection.selected,
    globalSelection: cloneGlobalSelection(pair.globalSelection),
    proposalTimeMap: pair.proposal?.timeMap ? cloneTimeMap(pair.proposal.timeMap) : null
  };
}

function deriveRunStatus(terminal: TerminalObservation): RealMediaBlindBatchRunStatus {
  if (terminal.terminationReason === "job-timeout") return "timed-out";
  if (terminal.terminationReason === "abort-signal") return "cancelled";
  if (terminal.snapshot.status === "failed") return "failed";
  if (terminal.snapshot.status === "cancelled") return "cancelled";
  return terminal.snapshot.pairs.some((pair) => pair.status === "failed")
    ? "completed-with-errors"
    : "completed";
}

function validateRunnerOptions(
  options: RealMediaBlindBatchRunnerOptions
): ValidatedRunnerOptions {
  return {
    pollIntervalMs: requireNonNegativeOption(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs"
    ),
    maxJobWallMs: requirePositiveOption(
      options.maxJobWallMs ?? DEFAULT_MAX_JOB_WALL_MS,
      "maxJobWallMs"
    ),
    cancellationGraceMs: requirePositiveOption(
      options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS,
      "cancellationGraceMs"
    ),
    signal: options.signal,
    alignmentInvoker: options.alignmentInvoker,
    now: options.now ?? Date.now,
    wait:
      options.wait ??
      ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  };
}

function cloneGlobalSelection(
  selection: NativeBatchGlobalSelectionEvidence
): NativeBatchGlobalSelectionEvidence {
  return {
    ...selection,
    topK: selection.topK.map((candidate) => ({ ...candidate })),
    decisionCandidate: selection.decisionCandidate ? { ...selection.decisionCandidate } : null
  };
}

function cloneTimeMap(timeMap: AlignmentTimeMapProposal): AlignmentTimeMapProposal {
  return structuredClone(timeMap);
}

function requireTerminalPairStatus(
  status: AudioAlignmentJobStatus
): "completed" | "failed" | "cancelled" {
  if (status !== "completed" && status !== "failed" && status !== "cancelled") {
    throw new Error("blind batch receipt 只能从全终态 pair 创建。");
  }
  return status;
}

function assertStringArraysEqual(actual: string[], expected: string[], label: string): void {
  if (
    actual.length !== expected.length ||
    actual.some((item, index) => item !== expected[index])
  ) {
    throw new Error(`${label} 与 execution suite 顺序/身份不一致。`);
  }
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是非空字符串数组。`);
  return value.map((item: unknown) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`${label} 必须是非空字符串数组。`);
    }
    return item;
  });
}

function requirePositiveOption(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} 必须大于 0。`);
  return value;
}

function requireNonNegativeOption(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} 必须大于等于 0。`);
  return value;
}
