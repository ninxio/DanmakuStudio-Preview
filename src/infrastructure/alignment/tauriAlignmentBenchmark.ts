import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AlignmentProposal } from "../../domain/alignment/types";
import type {
  AudioAlignmentJobStatus,
  AudioAlignmentStageKey,
  NormalizedTauriAudioAlignmentRequest,
  TauriAudioAlignmentRequest
} from "./tauriAudioAlignment";

export const ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION = 1 as const;
export const ALIGNMENT_BENCHMARK_MIN_SAMPLE_INTERVAL_MS = 10;
export const ALIGNMENT_BENCHMARK_MAX_SAMPLE_INTERVAL_MS = 1_000;

export interface AlignmentBenchmarkSessionRequest {
  ffmpegPath: string | null;
  ffprobePath: string | null;
  memorySampleIntervalMs: number;
}

export interface AlignmentBenchmarkToolFingerprint {
  version: string;
  binaryDigest: `sha256:${string}`;
}

export interface AlignmentBenchmarkEnvironmentReceipt {
  schemaVersion: typeof ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION;
  collectorVersion: string;
  measurementStatus: "complete" | "incomplete";
  issues: string[];
  operatingSystem: string;
  operatingSystemVersion: string;
  architecture: string;
  cpuModel: string;
  physicalCoreCount: number;
  logicalCoreCount: number;
  totalMemoryBytes: number;
  storageScope: "system-volume" | "workload-media-volumes";
  storageKind: string;
  powerProfile: string;
  ffmpeg: AlignmentBenchmarkToolFingerprint;
  ffprobe: AlignmentBenchmarkToolFingerprint;
}

export type AlignmentBenchmarkSessionStatus = "active" | "cleanup-blocked" | "released";

export interface AlignmentBenchmarkSessionSnapshot {
  schemaVersion: typeof ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION;
  sessionId: string;
  status: AlignmentBenchmarkSessionStatus;
  sessionOriginTickNs: "0";
  cacheGeneration: number;
  memoryScope: "application-process-tree";
  memorySampleIntervalMs: number;
  environment: AlignmentBenchmarkEnvironmentReceipt;
  activeJobId: string | null;
  cleanupIssue: string | null;
}

export interface AlignmentBenchmarkCacheCounts {
  audioFeatureEntries: number;
  landmarkEntries: number;
  visualFeatureEntries: number;
}

export interface AlignmentBenchmarkCacheResetReceipt {
  schemaVersion: typeof ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION;
  sessionId: string;
  resetTickNs: string;
  previousGeneration: number;
  cacheGeneration: number;
  before: AlignmentBenchmarkCacheCounts;
  after: AlignmentBenchmarkCacheCounts;
  allCachesEmpty: boolean;
}

export interface AlignmentBenchmarkCacheCounter {
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
}

export interface AlignmentBenchmarkCacheTelemetry {
  generation: number;
  before: AlignmentBenchmarkCacheCounts;
  after: AlignmentBenchmarkCacheCounts;
  audioFeatures: AlignmentBenchmarkCacheCounter;
  landmarks: AlignmentBenchmarkCacheCounter;
  visualFeatures: AlignmentBenchmarkCacheCounter;
}

export interface AlignmentBenchmarkStageTiming {
  stageKey: AudioAlignmentStageKey;
  occurrence: number;
  startTickNs: string;
  endTickNs: string;
  elapsedMs: number;
  status: "completed" | "failed" | "cancelled";
}

export interface AlignmentBenchmarkMemoryTelemetry {
  scope: "application-process-tree";
  sampler:
    | "windows-toolhelp-working-set-v1"
    | "windows-job-object-working-set-v1"
    | "unsupported";
  sampleIntervalMs: number;
  sampleCount: number;
  failedSampleCount: number;
  maximumSampleGapMs: number;
  peakProcessTreeRssBytes: number | null;
  coverageComplete: boolean;
  processTreeEmptyAtTerminal: boolean;
  residualProcessCount: number;
}

export interface AlignmentBenchmarkCancellationTelemetry {
  requestTickNs: string;
  terminalTickNs: string;
  latencyMs: number;
  commandAccepted: boolean;
}

export interface AlignmentBenchmarkJobTelemetry {
  schemaVersion: typeof ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION;
  clock: "rust-std-instant-session-relative-v1";
  startTickNs: string;
  endTickNs: string | null;
  elapsedMs: number;
  stages: AlignmentBenchmarkStageTiming[];
  cache: AlignmentBenchmarkCacheTelemetry;
  memory: AlignmentBenchmarkMemoryTelemetry;
  cancellation: AlignmentBenchmarkCancellationTelemetry | null;
}

export interface AlignmentBenchmarkJobSnapshot {
  schemaVersion: typeof ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION;
  sessionId: string;
  jobId: string;
  status: AudioAlignmentJobStatus;
  stageKey: AudioAlignmentStageKey;
  stageLabel: string;
  proposal: AlignmentProposal | null;
  errorCode: string | null;
  telemetry: AlignmentBenchmarkJobTelemetry;
}

export interface AlignmentBenchmarkInvoker {
  begin: (
    request: AlignmentBenchmarkSessionRequest
  ) => Promise<AlignmentBenchmarkSessionSnapshot>;
  getActive: () => Promise<AlignmentBenchmarkSessionSnapshot | null>;
  resetCaches: (sessionId: string) => Promise<AlignmentBenchmarkCacheResetReceipt>;
  startJob: (
    sessionId: string,
    request: NormalizedTauriAudioAlignmentRequest
  ) => Promise<AlignmentBenchmarkJobSnapshot>;
  getJob: (sessionId: string, jobId: string) => Promise<AlignmentBenchmarkJobSnapshot>;
  cancelJob: (sessionId: string, jobId: string) => Promise<AlignmentBenchmarkJobSnapshot>;
  finish: (sessionId: string) => Promise<AlignmentBenchmarkSessionSnapshot>;
}

export async function beginAlignmentBenchmarkSession(
  request: AlignmentBenchmarkSessionRequest,
  invoker: AlignmentBenchmarkInvoker = defaultAlignmentBenchmarkInvoker
): Promise<AlignmentBenchmarkSessionSnapshot> {
  ensureDesktopBenchmark(invoker === defaultAlignmentBenchmarkInvoker);
  const normalized = normalizeSessionRequest(request);
  try {
    return assertSessionSnapshot(await invoker.begin(normalized));
  } catch {
    throw new Error("无法取得原生性能独占会话；详细系统信息未进入可分享错误。");
  }
}

export async function getActiveAlignmentBenchmarkSession(
  invoker: AlignmentBenchmarkInvoker = defaultAlignmentBenchmarkInvoker
): Promise<AlignmentBenchmarkSessionSnapshot | null> {
  ensureDesktopBenchmark(invoker === defaultAlignmentBenchmarkInvoker);
  try {
    const snapshot = await invoker.getActive();
    return snapshot === null ? null : assertSessionSnapshot(snapshot);
  } catch {
    throw new Error("无法读取原生性能会话；详细系统信息未进入可分享错误。");
  }
}

export async function resetAlignmentBenchmarkCaches(
  sessionId: string,
  invoker: AlignmentBenchmarkInvoker = defaultAlignmentBenchmarkInvoker
): Promise<AlignmentBenchmarkCacheResetReceipt> {
  ensureDesktopBenchmark(invoker === defaultAlignmentBenchmarkInvoker);
  const normalizedSessionId = normalizeOpaqueId(sessionId, "性能会话 ID");
  try {
    const receipt = assertCacheResetReceipt(await invoker.resetCaches(normalizedSessionId));
    assertMatchingId(receipt.sessionId, normalizedSessionId);
    return receipt;
  } catch {
    throw new Error("原生性能缓存重置失败；缓存键和本地路径未进入错误。");
  }
}

export async function startAlignmentBenchmarkJob(
  sessionId: string,
  request: TauriAudioAlignmentRequest,
  invoker: AlignmentBenchmarkInvoker = defaultAlignmentBenchmarkInvoker
): Promise<AlignmentBenchmarkJobSnapshot> {
  ensureDesktopBenchmark(invoker === defaultAlignmentBenchmarkInvoker);
  const normalizedSessionId = normalizeOpaqueId(sessionId, "性能会话 ID");
  const normalizedRequest = normalizeAlignmentRequest(request);
  try {
    const snapshot = assertJobSnapshot(
      await invoker.startJob(normalizedSessionId, normalizedRequest)
    );
    assertMatchingId(snapshot.sessionId, normalizedSessionId);
    return snapshot;
  } catch {
    throw new Error("原生性能任务启动失败；媒体路径和工具输出未进入错误。");
  }
}

export async function getAlignmentBenchmarkJob(
  sessionId: string,
  jobId: string,
  invoker: AlignmentBenchmarkInvoker = defaultAlignmentBenchmarkInvoker
): Promise<AlignmentBenchmarkJobSnapshot> {
  ensureDesktopBenchmark(invoker === defaultAlignmentBenchmarkInvoker);
  const normalizedSessionId = normalizeOpaqueId(sessionId, "性能会话 ID");
  const normalizedJobId = normalizeOpaqueId(jobId, "性能任务 ID");
  try {
    const snapshot = assertJobSnapshot(
      await invoker.getJob(normalizedSessionId, normalizedJobId)
    );
    assertMatchingId(snapshot.sessionId, normalizedSessionId);
    assertMatchingId(snapshot.jobId, normalizedJobId);
    return snapshot;
  } catch {
    throw new Error("原生性能任务状态读取失败；详细系统信息未进入可分享错误。");
  }
}

export async function cancelAlignmentBenchmarkJob(
  sessionId: string,
  jobId: string,
  invoker: AlignmentBenchmarkInvoker = defaultAlignmentBenchmarkInvoker
): Promise<AlignmentBenchmarkJobSnapshot> {
  ensureDesktopBenchmark(invoker === defaultAlignmentBenchmarkInvoker);
  const normalizedSessionId = normalizeOpaqueId(sessionId, "性能会话 ID");
  const normalizedJobId = normalizeOpaqueId(jobId, "性能任务 ID");
  try {
    const snapshot = assertJobSnapshot(
      await invoker.cancelJob(normalizedSessionId, normalizedJobId)
    );
    assertMatchingId(snapshot.sessionId, normalizedSessionId);
    assertMatchingId(snapshot.jobId, normalizedJobId);
    return snapshot;
  } catch {
    throw new Error("原生性能任务取消失败；详细系统信息未进入可分享错误。");
  }
}

export async function finishAlignmentBenchmarkSession(
  sessionId: string,
  invoker: AlignmentBenchmarkInvoker = defaultAlignmentBenchmarkInvoker
): Promise<AlignmentBenchmarkSessionSnapshot> {
  ensureDesktopBenchmark(invoker === defaultAlignmentBenchmarkInvoker);
  const normalizedSessionId = normalizeOpaqueId(sessionId, "性能会话 ID");
  try {
    const snapshot = assertSessionSnapshot(await invoker.finish(normalizedSessionId));
    assertMatchingId(snapshot.sessionId, normalizedSessionId);
    if (snapshot.status !== "released" && snapshot.status !== "cleanup-blocked") {
      throw new Error("invalid terminal session status");
    }
    return snapshot;
  } catch {
    throw new Error("原生性能会话清理未得到可信终态；请重启应用后再运行。");
  }
}

export function isAlignmentBenchmarkJobFinished(status: AudioAlignmentJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

const defaultAlignmentBenchmarkInvoker: AlignmentBenchmarkInvoker = {
  begin: (request) =>
    invoke<AlignmentBenchmarkSessionSnapshot>("begin_alignment_benchmark_session", { request }),
  getActive: () =>
    invoke<AlignmentBenchmarkSessionSnapshot | null>("get_active_alignment_benchmark_session"),
  resetCaches: (sessionId) =>
    invoke<AlignmentBenchmarkCacheResetReceipt>("reset_alignment_benchmark_caches", {
      sessionId
    }),
  startJob: (sessionId, request) =>
    invoke<AlignmentBenchmarkJobSnapshot>("start_alignment_benchmark_job", {
      sessionId,
      request
    }),
  getJob: (sessionId, jobId) =>
    invoke<AlignmentBenchmarkJobSnapshot>("get_alignment_benchmark_job", {
      sessionId,
      jobId
    }),
  cancelJob: (sessionId, jobId) =>
    invoke<AlignmentBenchmarkJobSnapshot>("cancel_alignment_benchmark_job", {
      sessionId,
      jobId
    }),
  finish: (sessionId) =>
    invoke<AlignmentBenchmarkSessionSnapshot>("finish_alignment_benchmark_session", {
      sessionId
    })
};

function normalizeSessionRequest(
  request: AlignmentBenchmarkSessionRequest
): AlignmentBenchmarkSessionRequest {
  if (
    !Number.isSafeInteger(request.memorySampleIntervalMs) ||
    request.memorySampleIntervalMs < ALIGNMENT_BENCHMARK_MIN_SAMPLE_INTERVAL_MS ||
    request.memorySampleIntervalMs > ALIGNMENT_BENCHMARK_MAX_SAMPLE_INTERVAL_MS
  ) {
    throw new Error(
      `内存采样间隔必须是 ${ALIGNMENT_BENCHMARK_MIN_SAMPLE_INTERVAL_MS}–${ALIGNMENT_BENCHMARK_MAX_SAMPLE_INTERVAL_MS}ms 的安全整数。`
    );
  }
  return {
    ffmpegPath: normalizeOptionalPath(request.ffmpegPath),
    ffprobePath: normalizeOptionalPath(request.ffprobePath),
    memorySampleIntervalMs: request.memorySampleIntervalMs
  };
}

function normalizeAlignmentRequest(
  request: TauriAudioAlignmentRequest
): NormalizedTauriAudioAlignmentRequest {
  return {
    ...request,
    ffprobePath: request.ffprobePath ?? null,
    completeAudioStreamIndex: normalizeStreamIndex(
      request.completeAudioStreamIndex,
      "原片音轨索引"
    ),
    sourceAudioStreamIndex: normalizeStreamIndex(
      request.sourceAudioStreamIndex,
      "参考音轨索引"
    ),
    completeVideoStreamIndex: normalizeStreamIndex(
      request.completeVideoStreamIndex,
      "原片视频流索引"
    ),
    sourceVideoStreamIndex: normalizeStreamIndex(
      request.sourceVideoStreamIndex,
      "参考视频流索引"
    )
  };
}

function normalizeStreamIndex(
  value: number | null | undefined,
  label: string
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}必须是非负安全整数或 null。`);
  }
  return value;
}

function normalizeOptionalPath(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOpaqueId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(trimmed)) {
    throw new Error(`${label}格式无效。`);
  }
  return trimmed;
}

function ensureDesktopBenchmark(usesDefaultInvoker: boolean): void {
  if (usesDefaultInvoker && !isTauri()) {
    throw new Error("原生性能证据只能在 Tauri 桌面端采集。");
  }
}

const SESSION_STATUSES = ["active", "cleanup-blocked", "released"] as const;
const JOB_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
const TERMINAL_JOB_STATUSES = ["completed", "failed", "cancelled"] as const;
const STAGE_KEYS = [
  "queued",
  "validating",
  "extracting-complete",
  "extracting-source",
  "extracting-visual",
  "fingerprinting",
  "matching",
  "fitting",
  "refining",
  "reporting",
  "completed",
  "failed",
  "cancelled"
] as const;
const ERROR_CODES = [
  "memory-sampler-start-failed",
  "toolchain-integrity-failed",
  "cache-telemetry-incomplete",
  "alignment-failed",
  "cleanup-blocked"
] as const;
const MEMORY_SAMPLERS = [
  "windows-toolhelp-working-set-v1",
  "windows-job-object-working-set-v1",
  "unsupported"
] as const;
const STORAGE_SCOPES = ["system-volume", "workload-media-volumes"] as const;
const MAX_ENVIRONMENT_ISSUES = 128;
const MAX_STAGE_TIMINGS = 512;
const MAX_TEXT_LENGTH = 4_096;
const MAX_SHORT_TEXT_LENGTH = 512;
const MAX_CACHE_ENTRY_COUNT = 1_000_000;
const MAX_U128 = 340_282_366_920_938_463_463_374_607_431_768_211_455n;

function assertSessionSnapshot(value: unknown): AlignmentBenchmarkSessionSnapshot {
  const snapshot = requireRecord(value, "session snapshot");
  requireSchemaVersion(snapshot.schemaVersion, "session snapshot.schemaVersion");
  const sessionId = requireOpaqueResponseId(snapshot.sessionId, "session snapshot.sessionId");
  const status = requireEnum(snapshot.status, SESSION_STATUSES, "session snapshot.status");
  if (snapshot.sessionOriginTickNs !== "0") {
    throw new Error("invalid session snapshot.sessionOriginTickNs");
  }
  const cacheGeneration = requireNonNegativeSafeInteger(
    snapshot.cacheGeneration,
    "session snapshot.cacheGeneration"
  );
  if (snapshot.memoryScope !== "application-process-tree") {
    throw new Error("invalid session snapshot.memoryScope");
  }
  const memorySampleIntervalMs = requireSampleInterval(
    snapshot.memorySampleIntervalMs,
    "session snapshot.memorySampleIntervalMs"
  );
  const environment = assertEnvironmentReceipt(snapshot.environment);
  const activeJobId =
    snapshot.activeJobId === null
      ? null
      : requireOpaqueResponseId(snapshot.activeJobId, "session snapshot.activeJobId");
  const cleanupIssue =
    snapshot.cleanupIssue === null
      ? null
      : requireBoundedString(
          snapshot.cleanupIssue,
          "session snapshot.cleanupIssue",
          1,
          MAX_TEXT_LENGTH
        );
  if (status === "released" && activeJobId !== null) {
    throw new Error("invalid released session active job");
  }
  if (status === "cleanup-blocked" && cleanupIssue === null) {
    throw new Error("invalid cleanup-blocked session issue");
  }
  if (status !== "cleanup-blocked" && cleanupIssue !== null) {
    throw new Error("invalid non-blocked session issue");
  }
  return {
    schemaVersion: ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION,
    sessionId,
    status,
    sessionOriginTickNs: "0",
    cacheGeneration,
    memoryScope: "application-process-tree",
    memorySampleIntervalMs,
    environment,
    activeJobId,
    cleanupIssue
  };
}

function assertEnvironmentReceipt(value: unknown): AlignmentBenchmarkEnvironmentReceipt {
  const environment = requireRecord(value, "environment receipt");
  requireSchemaVersion(environment.schemaVersion, "environment.schemaVersion");
  const issues = requireBoundedStringArray(
    environment.issues,
    "environment.issues",
    MAX_ENVIRONMENT_ISSUES,
    MAX_SHORT_TEXT_LENGTH
  );
  const measurementStatus = requireEnum(
    environment.measurementStatus,
    ["complete", "incomplete"] as const,
    "environment.measurementStatus"
  );
  if (measurementStatus === "complete" && issues.length !== 0) {
    throw new Error("invalid complete environment issues");
  }
  if (measurementStatus === "incomplete" && issues.length === 0) {
    throw new Error("invalid incomplete environment issues");
  }
  const physicalCoreCount = requirePositiveSafeInteger(
    environment.physicalCoreCount,
    "environment.physicalCoreCount"
  );
  const logicalCoreCount = requirePositiveSafeInteger(
    environment.logicalCoreCount,
    "environment.logicalCoreCount"
  );
  if (physicalCoreCount > logicalCoreCount) {
    throw new Error("invalid environment core topology");
  }
  return {
    schemaVersion: ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION,
    collectorVersion: requireBoundedString(
      environment.collectorVersion,
      "environment.collectorVersion",
      1,
      MAX_SHORT_TEXT_LENGTH
    ),
    measurementStatus,
    issues,
    operatingSystem: requireBoundedString(
      environment.operatingSystem,
      "environment.operatingSystem",
      1,
      MAX_SHORT_TEXT_LENGTH
    ),
    operatingSystemVersion: requireBoundedString(
      environment.operatingSystemVersion,
      "environment.operatingSystemVersion",
      1,
      MAX_SHORT_TEXT_LENGTH
    ),
    architecture: requireBoundedString(
      environment.architecture,
      "environment.architecture",
      1,
      MAX_SHORT_TEXT_LENGTH
    ),
    cpuModel: requireBoundedString(
      environment.cpuModel,
      "environment.cpuModel",
      1,
      MAX_SHORT_TEXT_LENGTH
    ),
    physicalCoreCount,
    logicalCoreCount,
    totalMemoryBytes: requirePositiveSafeInteger(
      environment.totalMemoryBytes,
      "environment.totalMemoryBytes"
    ),
    storageScope: requireEnum(
      environment.storageScope,
      STORAGE_SCOPES,
      "environment.storageScope"
    ),
    storageKind: requireBoundedString(
      environment.storageKind,
      "environment.storageKind",
      1,
      MAX_SHORT_TEXT_LENGTH
    ),
    powerProfile: requireBoundedString(
      environment.powerProfile,
      "environment.powerProfile",
      1,
      MAX_SHORT_TEXT_LENGTH
    ),
    ffmpeg: assertToolFingerprint(environment.ffmpeg, "environment.ffmpeg"),
    ffprobe: assertToolFingerprint(environment.ffprobe, "environment.ffprobe")
  };
}

function assertToolFingerprint(
  value: unknown,
  path: string
): AlignmentBenchmarkToolFingerprint {
  const fingerprint = requireRecord(value, path);
  return {
    version: requireBoundedString(
      fingerprint.version,
      `${path}.version`,
      1,
      MAX_TEXT_LENGTH
    ),
    binaryDigest: requireSha256Digest(fingerprint.binaryDigest, `${path}.binaryDigest`)
  };
}

function assertCacheResetReceipt(value: unknown): AlignmentBenchmarkCacheResetReceipt {
  const receipt = requireRecord(value, "cache reset receipt");
  requireSchemaVersion(receipt.schemaVersion, "cache reset receipt.schemaVersion");
  const sessionId = requireOpaqueResponseId(
    receipt.sessionId,
    "cache reset receipt.sessionId"
  );
  const resetTickNs = requireCanonicalDecimalTick(
    receipt.resetTickNs,
    "cache reset receipt.resetTickNs"
  );
  const previousGeneration = requireNonNegativeSafeInteger(
    receipt.previousGeneration,
    "cache reset receipt.previousGeneration"
  );
  const cacheGeneration = requireNonNegativeSafeInteger(
    receipt.cacheGeneration,
    "cache reset receipt.cacheGeneration"
  );
  if (cacheGeneration !== previousGeneration + 1) {
    throw new Error("invalid cache reset generation transition");
  }
  const before = assertCacheCounts(receipt.before, "cache reset receipt.before");
  const after = assertCacheCounts(receipt.after, "cache reset receipt.after");
  if (receipt.allCachesEmpty !== true || !areCachesEmpty(after)) {
    throw new Error("invalid cache reset empty state");
  }
  return {
    schemaVersion: ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION,
    sessionId,
    resetTickNs,
    previousGeneration,
    cacheGeneration,
    before,
    after,
    allCachesEmpty: true
  };
}

function assertJobSnapshot(value: unknown): AlignmentBenchmarkJobSnapshot {
  const snapshot = requireRecord(value, "benchmark job snapshot");
  requireSchemaVersion(snapshot.schemaVersion, "benchmark job snapshot.schemaVersion");
  const sessionId = requireOpaqueResponseId(
    snapshot.sessionId,
    "benchmark job snapshot.sessionId"
  );
  const jobId = requireOpaqueResponseId(snapshot.jobId, "benchmark job snapshot.jobId");
  const status = requireEnum(snapshot.status, JOB_STATUSES, "benchmark job snapshot.status");
  const stageKey = requireEnum(
    snapshot.stageKey,
    STAGE_KEYS,
    "benchmark job snapshot.stageKey"
  );
  const stageLabel = requireBoundedString(
    snapshot.stageLabel,
    "benchmark job snapshot.stageLabel",
    1,
    MAX_SHORT_TEXT_LENGTH
  );
  const proposal = assertProposalRecord(snapshot.proposal);
  const errorCode =
    snapshot.errorCode === null
      ? null
      : requireEnum(snapshot.errorCode, ERROR_CODES, "benchmark job snapshot.errorCode");
  const telemetry = assertJobTelemetry(snapshot.telemetry, status);
  assertJobStageConsistency(status, stageKey);
  return {
    schemaVersion: ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION,
    sessionId,
    jobId,
    status,
    stageKey,
    stageLabel,
    proposal,
    errorCode,
    telemetry
  };
}

function assertJobTelemetry(
  value: unknown,
  jobStatus: AudioAlignmentJobStatus
): AlignmentBenchmarkJobTelemetry {
  const telemetry = requireRecord(value, "benchmark job telemetry");
  requireSchemaVersion(telemetry.schemaVersion, "benchmark job telemetry.schemaVersion");
  if (telemetry.clock !== "rust-std-instant-session-relative-v1") {
    throw new Error("invalid benchmark job telemetry.clock");
  }
  const startTickNs = requireCanonicalDecimalTick(
    telemetry.startTickNs,
    "benchmark job telemetry.startTickNs"
  );
  const terminal = isAlignmentBenchmarkJobFinished(jobStatus);
  const endTickNs =
    telemetry.endTickNs === null
      ? null
      : requireCanonicalDecimalTick(
          telemetry.endTickNs,
          "benchmark job telemetry.endTickNs"
        );
  if (terminal !== (endTickNs !== null)) {
    throw new Error("invalid benchmark job terminal tick state");
  }
  if (endTickNs !== null) requireTickOrder(startTickNs, endTickNs, "benchmark job telemetry");
  const elapsedMs = requireNonNegativeFiniteNumber(
    telemetry.elapsedMs,
    "benchmark job telemetry.elapsedMs"
  );
  if (endTickNs !== null) {
    requireElapsedMatchesTicks(startTickNs, endTickNs, elapsedMs, "benchmark job telemetry");
  }
  const stages = assertStageTimings(
    telemetry.stages,
    startTickNs,
    endTickNs,
    jobStatus
  );
  const cache = assertCacheTelemetry(telemetry.cache);
  const memory = assertMemoryTelemetry(telemetry.memory, terminal);
  const cancellation = assertCancellationTelemetry(
    telemetry.cancellation,
    startTickNs,
    endTickNs,
    jobStatus
  );
  if (jobStatus === "cancelled" && cancellation === null) {
    throw new Error("invalid cancelled job without cancellation telemetry");
  }
  return {
    schemaVersion: ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION,
    clock: "rust-std-instant-session-relative-v1",
    startTickNs,
    endTickNs,
    elapsedMs,
    stages,
    cache,
    memory,
    cancellation
  };
}

function assertStageTimings(
  value: unknown,
  jobStartTickNs: string,
  jobEndTickNs: string | null,
  jobStatus: AudioAlignmentJobStatus
): AlignmentBenchmarkStageTiming[] {
  if (!Array.isArray(value) || value.length > MAX_STAGE_TIMINGS) {
    throw new Error("invalid benchmark job telemetry.stages");
  }
  const stages = value.map((stage, index) => assertStageTiming(stage, index));
  const occurrenceByStage = new Map<AudioAlignmentStageKey, number>();
  let previousEnd = jobStartTickNs;
  stages.forEach((stage, index) => {
    requireTickOrder(jobStartTickNs, stage.startTickNs, `stage ${index} job range`);
    requireTickOrder(previousEnd, stage.startTickNs, `stage ${index} ordering`);
    if (jobEndTickNs !== null) {
      requireTickOrder(stage.endTickNs, jobEndTickNs, `stage ${index} job range`);
    }
    const expectedOccurrence = (occurrenceByStage.get(stage.stageKey) ?? 0) + 1;
    if (stage.occurrence !== expectedOccurrence) {
      throw new Error(`invalid stage ${index} occurrence`);
    }
    occurrenceByStage.set(stage.stageKey, stage.occurrence);
    if (index < stages.length - 1 && stage.status !== "completed") {
      throw new Error(`invalid non-final stage ${index} status`);
    }
    previousEnd = stage.endTickNs;
  });
  const lastStage = stages.at(-1);
  if (lastStage) {
    if (isAlignmentBenchmarkJobFinished(jobStatus)) {
      if (lastStage.status !== jobStatus) throw new Error("invalid terminal stage status");
    } else if (lastStage.status !== "completed") {
      throw new Error("invalid in-flight stage status");
    }
  }
  return stages;
}

function assertStageTiming(value: unknown, index: number): AlignmentBenchmarkStageTiming {
  const path = `benchmark job telemetry.stages[${index}]`;
  const stage = requireRecord(value, path);
  const stageKey = requireEnum(stage.stageKey, STAGE_KEYS, `${path}.stageKey`);
  const occurrence = requirePositiveSafeInteger(stage.occurrence, `${path}.occurrence`);
  const startTickNs = requireCanonicalDecimalTick(stage.startTickNs, `${path}.startTickNs`);
  const endTickNs = requireCanonicalDecimalTick(stage.endTickNs, `${path}.endTickNs`);
  requireTickOrder(startTickNs, endTickNs, path);
  const elapsedMs = requireNonNegativeFiniteNumber(stage.elapsedMs, `${path}.elapsedMs`);
  requireElapsedMatchesTicks(startTickNs, endTickNs, elapsedMs, path);
  return {
    stageKey,
    occurrence,
    startTickNs,
    endTickNs,
    elapsedMs,
    status: requireEnum(stage.status, TERMINAL_JOB_STATUSES, `${path}.status`)
  };
}

function assertCacheTelemetry(value: unknown): AlignmentBenchmarkCacheTelemetry {
  const cache = requireRecord(value, "benchmark job telemetry.cache");
  return {
    generation: requireNonNegativeSafeInteger(
      cache.generation,
      "benchmark job telemetry.cache.generation"
    ),
    before: assertCacheCounts(cache.before, "benchmark job telemetry.cache.before"),
    after: assertCacheCounts(cache.after, "benchmark job telemetry.cache.after"),
    audioFeatures: assertCacheCounter(
      cache.audioFeatures,
      "benchmark job telemetry.cache.audioFeatures"
    ),
    landmarks: assertCacheCounter(
      cache.landmarks,
      "benchmark job telemetry.cache.landmarks"
    ),
    visualFeatures: assertCacheCounter(
      cache.visualFeatures,
      "benchmark job telemetry.cache.visualFeatures"
    )
  };
}

function assertCacheCounts(value: unknown, path: string): AlignmentBenchmarkCacheCounts {
  const counts = requireRecord(value, path);
  return {
    audioFeatureEntries: requireBoundedNonNegativeSafeInteger(
      counts.audioFeatureEntries,
      `${path}.audioFeatureEntries`,
      MAX_CACHE_ENTRY_COUNT
    ),
    landmarkEntries: requireBoundedNonNegativeSafeInteger(
      counts.landmarkEntries,
      `${path}.landmarkEntries`,
      MAX_CACHE_ENTRY_COUNT
    ),
    visualFeatureEntries: requireBoundedNonNegativeSafeInteger(
      counts.visualFeatureEntries,
      `${path}.visualFeatureEntries`,
      MAX_CACHE_ENTRY_COUNT
    )
  };
}

function assertCacheCounter(value: unknown, path: string): AlignmentBenchmarkCacheCounter {
  const counter = requireRecord(value, path);
  return {
    hits: requireNonNegativeSafeInteger(counter.hits, `${path}.hits`),
    misses: requireNonNegativeSafeInteger(counter.misses, `${path}.misses`),
    writes: requireNonNegativeSafeInteger(counter.writes, `${path}.writes`),
    evictions: requireNonNegativeSafeInteger(counter.evictions, `${path}.evictions`)
  };
}

function assertMemoryTelemetry(
  value: unknown,
  terminal: boolean
): AlignmentBenchmarkMemoryTelemetry {
  const memory = requireRecord(value, "benchmark job telemetry.memory");
  if (memory.scope !== "application-process-tree") {
    throw new Error("invalid benchmark job telemetry.memory.scope");
  }
  const sampler = requireEnum(
    memory.sampler,
    MEMORY_SAMPLERS,
    "benchmark job telemetry.memory.sampler"
  );
  const sampleCount = requireNonNegativeSafeInteger(
    memory.sampleCount,
    "benchmark job telemetry.memory.sampleCount"
  );
  const failedSampleCount = requireNonNegativeSafeInteger(
    memory.failedSampleCount,
    "benchmark job telemetry.memory.failedSampleCount"
  );
  const peakProcessTreeRssBytes =
    memory.peakProcessTreeRssBytes === null
      ? null
      : requireNonNegativeSafeInteger(
          memory.peakProcessTreeRssBytes,
          "benchmark job telemetry.memory.peakProcessTreeRssBytes"
        );
  if ((sampleCount === 0) !== (peakProcessTreeRssBytes === null)) {
    throw new Error("invalid benchmark memory sample/peak relation");
  }
  const coverageComplete = requireBoolean(
    memory.coverageComplete,
    "benchmark job telemetry.memory.coverageComplete"
  );
  if (coverageComplete && (failedSampleCount !== 0 || sampler === "unsupported")) {
    throw new Error("invalid benchmark memory coverage state");
  }
  const processTreeEmptyAtTerminal = requireBoolean(
    memory.processTreeEmptyAtTerminal,
    "benchmark job telemetry.memory.processTreeEmptyAtTerminal"
  );
  const residualProcessCount = requireNonNegativeSafeInteger(
    memory.residualProcessCount,
    "benchmark job telemetry.memory.residualProcessCount"
  );
  if (terminal && processTreeEmptyAtTerminal !== (residualProcessCount === 0)) {
    throw new Error("invalid terminal process tree state");
  }
  return {
    scope: "application-process-tree",
    sampler,
    sampleIntervalMs: requireSampleInterval(
      memory.sampleIntervalMs,
      "benchmark job telemetry.memory.sampleIntervalMs"
    ),
    sampleCount,
    failedSampleCount,
    maximumSampleGapMs: requireNonNegativeFiniteNumber(
      memory.maximumSampleGapMs,
      "benchmark job telemetry.memory.maximumSampleGapMs"
    ),
    peakProcessTreeRssBytes,
    coverageComplete,
    processTreeEmptyAtTerminal,
    residualProcessCount
  };
}

function assertCancellationTelemetry(
  value: unknown,
  jobStartTickNs: string,
  jobEndTickNs: string | null,
  jobStatus: AudioAlignmentJobStatus
): AlignmentBenchmarkCancellationTelemetry | null {
  if (value === null) return null;
  const cancellation = requireRecord(value, "benchmark job telemetry.cancellation");
  const requestTickNs = requireCanonicalDecimalTick(
    cancellation.requestTickNs,
    "benchmark job telemetry.cancellation.requestTickNs"
  );
  requireTickOrder(jobStartTickNs, requestTickNs, "benchmark cancellation request");
  const latencyMs = requireNonNegativeFiniteNumber(
    cancellation.latencyMs,
    "benchmark job telemetry.cancellation.latencyMs"
  );
  const commandAccepted = requireBoolean(
    cancellation.commandAccepted,
    "benchmark job telemetry.cancellation.commandAccepted"
  );
  if (cancellation.terminalTickNs === "") {
    if (isAlignmentBenchmarkJobFinished(jobStatus) || jobEndTickNs !== null || latencyMs !== 0) {
      throw new Error("invalid pending cancellation sentinel");
    }
    return { requestTickNs, terminalTickNs: "", latencyMs, commandAccepted };
  }
  const terminalTickNs = requireCanonicalDecimalTick(
    cancellation.terminalTickNs,
    "benchmark job telemetry.cancellation.terminalTickNs"
  );
  if (jobEndTickNs === null || terminalTickNs !== jobEndTickNs) {
    throw new Error("invalid cancellation terminal binding");
  }
  requireTickOrder(requestTickNs, terminalTickNs, "benchmark cancellation");
  requireElapsedMatchesTicks(requestTickNs, terminalTickNs, latencyMs, "benchmark cancellation");
  return { requestTickNs, terminalTickNs, latencyMs, commandAccepted };
}

function assertProposalRecord(value: unknown): AlignmentProposal | null {
  if (value === null) return null;
  if (!isAlignmentProposalRecord(value)) throw new Error("invalid benchmark job proposal");
  return value;
}

function assertJobStageConsistency(
  status: AudioAlignmentJobStatus,
  stageKey: AudioAlignmentStageKey
): void {
  const expectedTerminalStage =
    status === "completed" || status === "failed" || status === "cancelled" ? status : null;
  if (expectedTerminalStage !== null && stageKey !== expectedTerminalStage) {
    throw new Error("invalid benchmark job terminal stage");
  }
  if (status === "queued" && stageKey !== "queued") {
    throw new Error("invalid queued benchmark job stage");
  }
}

function assertMatchingId(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("mismatched native response identifier");
}

function requireSchemaVersion(value: unknown, path: string): void {
  if (value !== ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION) {
    throw new Error(`invalid ${path}`);
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`invalid ${path}`);
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string
): T {
  if (!isOneOf(value, allowed)) throw new Error(`invalid ${path}`);
  return value;
}

function requireBoundedString(
  value: unknown,
  path: string,
  minimumLength: number,
  maximumLength: number
): string {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    value.trim() !== value
  ) {
    throw new Error(`invalid ${path}`);
  }
  return value;
}

function requireBoundedStringArray(
  value: unknown,
  path: string,
  maximumItems: number,
  maximumItemLength: number
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`invalid ${path}`);
  }
  return value.map((item, index) =>
    requireBoundedString(item, `${path}[${index}]`, 1, maximumItemLength)
  );
}

function requireOpaqueResponseId(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,160}$/.test(value)) {
    throw new Error(`invalid ${path}`);
  }
  return value;
}

function requireSha256Digest(value: unknown, path: string): `sha256:${string}` {
  if (!isSha256Digest(value)) throw new Error(`invalid ${path}`);
  return value;
}

function requireCanonicalDecimalTick(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,38})$/.test(value) ||
    BigInt(value) > MAX_U128
  ) {
    throw new Error(`invalid ${path}`);
  }
  return value;
}

function requireTickOrder(startTickNs: string, endTickNs: string, path: string): void {
  if (BigInt(endTickNs) < BigInt(startTickNs)) throw new Error(`invalid ${path} tick order`);
}

function requireElapsedMatchesTicks(
  startTickNs: string,
  endTickNs: string,
  elapsedMs: number,
  path: string
): void {
  const elapsedNanoseconds = BigInt(endTickNs) - BigInt(startTickNs);
  const wholeMilliseconds = elapsedNanoseconds / 1_000_000n;
  if (wholeMilliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`invalid ${path} elapsed range`);
  }
  const expectedElapsedMs =
    Number(wholeMilliseconds) + Number(elapsedNanoseconds % 1_000_000n) / 1_000_000;
  const tolerance = Math.max(0.000_001, expectedElapsedMs * Number.EPSILON * 8);
  if (Math.abs(elapsedMs - expectedElapsedMs) > tolerance) {
    throw new Error(`invalid ${path} elapsed value`);
  }
}

function requireSampleInterval(value: unknown, path: string): number {
  const interval = requireNonNegativeSafeInteger(value, path);
  if (
    interval < ALIGNMENT_BENCHMARK_MIN_SAMPLE_INTERVAL_MS ||
    interval > ALIGNMENT_BENCHMARK_MAX_SAMPLE_INTERVAL_MS
  ) {
    throw new Error(`invalid ${path}`);
  }
  return interval;
}

function requirePositiveSafeInteger(value: unknown, path: string): number {
  const integer = requireNonNegativeSafeInteger(value, path);
  if (integer === 0) throw new Error(`invalid ${path}`);
  return integer;
}

function requireNonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${path}`);
  }
  return value;
}

function requireBoundedNonNegativeSafeInteger(
  value: unknown,
  path: string,
  maximum: number
): number {
  const integer = requireNonNegativeSafeInteger(value, path);
  if (integer > maximum) throw new Error(`invalid ${path}`);
  return integer;
}

function requireNonNegativeFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`invalid ${path}`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid ${path}`);
  return value;
}

function areCachesEmpty(counts: AlignmentBenchmarkCacheCounts): boolean {
  return (
    counts.audioFeatureEntries === 0 &&
    counts.landmarkEntries === 0 &&
    counts.visualFeatureEntries === 0
  );
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.some((candidate) => candidate === value);
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isAlignmentProposalRecord(value: unknown): value is AlignmentProposal {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
