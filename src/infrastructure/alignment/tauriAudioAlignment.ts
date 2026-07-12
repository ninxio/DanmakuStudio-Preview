import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AlignmentProposal } from "../../domain/alignment/types";

export interface TauriAudioAlignmentRequest {
  completePath: string;
  sourcePath: string;
  ffmpegPath: string | null;
  ffprobePath?: string | null;
  completeAudioStreamIndex?: number | null;
  sourceAudioStreamIndex?: number | null;
  completeVideoStreamIndex?: number | null;
  sourceVideoStreamIndex?: number | null;
  sampleRate?: number;
  windowMs?: number;
  matchThreshold?: number;
  minGapMs?: number;
  maxCells?: number;
  enableVisualEvidence?: boolean;
  visualSampleIntervalMs?: number;
  localizationMode?: boolean;
}

export interface NormalizedTauriAudioAlignmentRequest extends Omit<
  TauriAudioAlignmentRequest,
  | "ffprobePath"
  | "completeAudioStreamIndex"
  | "sourceAudioStreamIndex"
  | "completeVideoStreamIndex"
  | "sourceVideoStreamIndex"
> {
  ffprobePath: string | null;
  completeAudioStreamIndex: number | null;
  sourceAudioStreamIndex: number | null;
  completeVideoStreamIndex: number | null;
  sourceVideoStreamIndex: number | null;
}

export type AudioAlignmentInvoker = (
  request: NormalizedTauriAudioAlignmentRequest
) => Promise<AlignmentProposal>;

export type AudioAlignmentJobStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";

export type AudioAlignmentStageKey =
  | "queued"
  | "validating"
  | "extracting-complete"
  | "extracting-source"
  | "extracting-visual"
  | "fingerprinting"
  | "matching"
  | "fitting"
  | "refining"
  | "reporting"
  | "completed"
  | "failed"
  | "cancelled";

export interface AudioAlignmentJobSnapshot {
  jobId: string;
  status: AudioAlignmentJobStatus;
  progress: number;
  message: string;
  stageKey?: AudioAlignmentStageKey;
  stageLabel?: string;
  stageIndex?: number;
  stageCount?: number;
  stageProgress?: number;
  logs: string[];
  proposal: AlignmentProposal | null;
  error: string | null;
  updatedAtMs: number;
}

export interface AudioAlignmentJobInvoker {
  start: (request: NormalizedTauriAudioAlignmentRequest) => Promise<AudioAlignmentJobSnapshot>;
  get: (jobId: string) => Promise<AudioAlignmentJobSnapshot>;
  cancel: (jobId: string) => Promise<AudioAlignmentJobSnapshot>;
}

export interface TauriAudioAlignmentBatchMedia {
  mediaId: string;
  path: string;
  audioStreamIndex?: number | null;
  videoStreamIndex?: number | null;
}

export interface TauriAudioAlignmentBatchPair {
  sourceMediaId: string;
  targetMediaId: string;
}

export interface TauriAudioAlignmentBatchRequest {
  sources: TauriAudioAlignmentBatchMedia[];
  targets: TauriAudioAlignmentBatchMedia[];
  pairs?: TauriAudioAlignmentBatchPair[];
  ffmpegPath: string | null;
  ffprobePath?: string | null;
  sampleRate?: number;
  windowMs?: number;
  matchThreshold?: number;
  minGapMs?: number;
  maxCells?: number;
  enableVisualEvidence?: boolean;
  visualSampleIntervalMs?: number;
  localizationMode?: boolean;
}

export interface NormalizedTauriAudioAlignmentBatchRequest extends Omit<
  TauriAudioAlignmentBatchRequest,
  "sources" | "targets" | "ffprobePath"
> {
  schemaVersion: 1;
  sources: Required<TauriAudioAlignmentBatchMedia>[];
  targets: Required<TauriAudioAlignmentBatchMedia>[];
  ffprobePath: string | null;
}

export interface AudioAlignmentBatchPairSnapshot {
  pairOrdinal: number;
  sourceMediaId: string;
  targetMediaId: string;
  status: AudioAlignmentJobStatus;
  progress: number;
  message: string;
  proposal: AlignmentProposal | null;
  error: string | null;
}

export interface AudioAlignmentBatchJobSnapshot {
  schemaVersion: 1;
  jobId: string;
  status: AudioAlignmentJobStatus;
  progress: number;
  message: string;
  totalPairCount: number;
  processedPairCount: number;
  failedPairCount: number;
  currentPairOrdinal: number | null;
  pairs: AudioAlignmentBatchPairSnapshot[];
  error: string | null;
  updatedAtMs: number;
}

export interface AudioAlignmentBatchJobInvoker {
  start: (
    request: NormalizedTauriAudioAlignmentBatchRequest
  ) => Promise<AudioAlignmentBatchJobSnapshot>;
  get: (jobId: string) => Promise<AudioAlignmentBatchJobSnapshot>;
  cancel: (jobId: string) => Promise<AudioAlignmentBatchJobSnapshot>;
}

export async function runTauriAudioAlignment(
  request: TauriAudioAlignmentRequest,
  invoker: AudioAlignmentInvoker = defaultAudioAlignmentInvoker
): Promise<AlignmentProposal> {
  if (invoker === defaultAudioAlignmentInvoker && !isTauri()) {
    throw new Error("本地音频对齐需要在 Tauri 桌面端运行。");
  }
  const normalizedRequest = normalizeAudioAlignmentRequest(request);
  try {
    return await invoker(normalizedRequest);
  } catch (error: unknown) {
    throw new Error(`本地音频对齐失败：${formatAudioAlignmentFailure(error)}`);
  }
}

export async function startTauriAudioAlignmentJob(
  request: TauriAudioAlignmentRequest,
  invoker: AudioAlignmentJobInvoker = defaultAudioAlignmentJobInvoker
): Promise<AudioAlignmentJobSnapshot> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentJobInvoker);
  const normalizedRequest = normalizeAudioAlignmentRequest(request);
  try {
    return await invoker.start(normalizedRequest);
  } catch (error: unknown) {
    throw new Error(`音频对齐任务启动失败：${formatAudioAlignmentFailure(error)}`);
  }
}

export async function getTauriAudioAlignmentJob(
  jobId: string,
  invoker: AudioAlignmentJobInvoker = defaultAudioAlignmentJobInvoker
): Promise<AudioAlignmentJobSnapshot> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentJobInvoker);
  try {
    return await invoker.get(jobId);
  } catch (error: unknown) {
    throw new Error(`音频对齐任务读取失败：${formatAudioAlignmentFailure(error)}`);
  }
}

export async function cancelTauriAudioAlignmentJob(
  jobId: string,
  invoker: AudioAlignmentJobInvoker = defaultAudioAlignmentJobInvoker
): Promise<AudioAlignmentJobSnapshot> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentJobInvoker);
  try {
    return await invoker.cancel(jobId);
  } catch (error: unknown) {
    throw new Error(`音频对齐任务取消失败：${formatAudioAlignmentFailure(error)}`);
  }
}

export function isAudioAlignmentJobFinished(status: AudioAlignmentJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export async function startTauriAudioAlignmentBatchJob(
  request: TauriAudioAlignmentBatchRequest,
  invoker: AudioAlignmentBatchJobInvoker = defaultAudioAlignmentBatchJobInvoker
): Promise<AudioAlignmentBatchJobSnapshot> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentBatchJobInvoker);
  const normalizedRequest = normalizeAudioAlignmentBatchRequest(request);
  try {
    return validateAudioAlignmentBatchJobSnapshot(await invoker.start(normalizedRequest));
  } catch (error: unknown) {
    throw new Error(`批量音频对齐任务启动失败：${formatAudioAlignmentFailure(error)}`);
  }
}

export async function getTauriAudioAlignmentBatchJob(
  jobId: string,
  invoker: AudioAlignmentBatchJobInvoker = defaultAudioAlignmentBatchJobInvoker
): Promise<AudioAlignmentBatchJobSnapshot> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentBatchJobInvoker);
  try {
    return validateAudioAlignmentBatchJobSnapshot(await invoker.get(jobId), jobId);
  } catch (error: unknown) {
    throw new Error(`批量音频对齐任务读取失败：${formatAudioAlignmentFailure(error)}`);
  }
}

export async function cancelTauriAudioAlignmentBatchJob(
  jobId: string,
  invoker: AudioAlignmentBatchJobInvoker = defaultAudioAlignmentBatchJobInvoker
): Promise<AudioAlignmentBatchJobSnapshot> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentBatchJobInvoker);
  try {
    return validateAudioAlignmentBatchJobSnapshot(await invoker.cancel(jobId), jobId);
  } catch (error: unknown) {
    throw new Error(`批量音频对齐任务取消失败：${formatAudioAlignmentFailure(error)}`);
  }
}

function defaultAudioAlignmentInvoker(
  request: NormalizedTauriAudioAlignmentRequest
): Promise<AlignmentProposal> {
  return invoke<AlignmentProposal>("align_audio_files", { request });
}

const defaultAudioAlignmentJobInvoker: AudioAlignmentJobInvoker = {
  start: (request) =>
    invoke<AudioAlignmentJobSnapshot>("start_audio_alignment_job", { request }),
  get: (jobId) => invoke<AudioAlignmentJobSnapshot>("get_audio_alignment_job", { jobId }),
  cancel: (jobId) => invoke<AudioAlignmentJobSnapshot>("cancel_audio_alignment_job", { jobId })
};

const defaultAudioAlignmentBatchJobInvoker: AudioAlignmentBatchJobInvoker = {
  start: (request) =>
    invoke<AudioAlignmentBatchJobSnapshot>("start_audio_alignment_batch_job", { request }),
  get: (jobId) =>
    invoke<AudioAlignmentBatchJobSnapshot>("get_audio_alignment_batch_job", { jobId }),
  cancel: (jobId) =>
    invoke<AudioAlignmentBatchJobSnapshot>("cancel_audio_alignment_batch_job", { jobId })
};

function ensureDesktopAudioAlignment(usesDefaultInvoker: boolean): void {
  if (usesDefaultInvoker && !isTauri()) {
    throw new Error("本地音频对齐需要在 Tauri 桌面端运行。");
  }
}

function normalizeAudioAlignmentRequest(
  request: TauriAudioAlignmentRequest
): NormalizedTauriAudioAlignmentRequest {
  return {
    ...request,
    ffprobePath: request.ffprobePath ?? null,
    completeAudioStreamIndex: normalizeAudioStreamIndex(
      request.completeAudioStreamIndex,
      "原片音轨索引"
    ),
    sourceAudioStreamIndex: normalizeAudioStreamIndex(
      request.sourceAudioStreamIndex,
      "参考视频音轨索引"
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

function normalizeAudioAlignmentBatchRequest(
  request: TauriAudioAlignmentBatchRequest
): NormalizedTauriAudioAlignmentBatchRequest {
  const sources = normalizeBatchMedia(request.sources, "B 站参考素材");
  const targets = normalizeBatchMedia(request.targets, "原片素材");
  const sourceIds = new Set(sources.map((item) => item.mediaId));
  const duplicateAcrossSides = targets.find((item) => sourceIds.has(item.mediaId));
  if (duplicateAcrossSides) {
    throw new Error(`批量音频对齐的媒体 ID 必须全局唯一：${duplicateAcrossSides.mediaId}`);
  }
  const pairs = request.pairs
    ? normalizeBatchPairs(
        request.pairs,
        sourceIds,
        new Set(targets.map((item) => item.mediaId))
      )
    : undefined;
  if ((pairs?.length ?? sources.length * targets.length) > 256) {
    throw new Error("批量音频对齐一次最多分析 256 个素材组合。");
  }
  return {
    ...request,
    schemaVersion: 1,
    sources,
    targets,
    ...(pairs ? { pairs } : {}),
    ffprobePath: request.ffprobePath ?? null
  };
}

function normalizeBatchPairs(
  pairs: readonly TauriAudioAlignmentBatchPair[],
  sourceIds: ReadonlySet<string>,
  targetIds: ReadonlySet<string>
): TauriAudioAlignmentBatchPair[] {
  if (pairs.length === 0) {
    throw new Error("批量音频对齐的显式素材组合不能为空。");
  }
  const seen = new Set<string>();
  return pairs.map((pair, index) => {
    const sourceMediaId = pair.sourceMediaId.trim();
    const targetMediaId = pair.targetMediaId.trim();
    if (!sourceIds.has(sourceMediaId) || !targetIds.has(targetMediaId)) {
      throw new Error(`第 ${index + 1} 个素材组合引用了未纳入批次的媒体。`);
    }
    const key = `${sourceMediaId}\u0000${targetMediaId}`;
    if (seen.has(key)) {
      throw new Error(`批量音频对齐包含重复素材组合：${sourceMediaId} → ${targetMediaId}`);
    }
    seen.add(key);
    return { sourceMediaId, targetMediaId };
  });
}

function normalizeBatchMedia(
  media: readonly TauriAudioAlignmentBatchMedia[],
  label: string
): Required<TauriAudioAlignmentBatchMedia>[] {
  if (media.length === 0) {
    throw new Error(`${label}不能为空。`);
  }
  if (media.length > 64) {
    throw new Error(`${label}一次最多选择 64 个。`);
  }
  const ids = new Set<string>();
  return media.map((item, index) => {
    const mediaId = item.mediaId.trim();
    if (!mediaId) {
      throw new Error(`${label}第 ${index + 1} 项的媒体 ID 不能为空。`);
    }
    if (ids.has(mediaId)) {
      throw new Error(`${label}包含重复媒体 ID：${mediaId}`);
    }
    ids.add(mediaId);
    if (!item.path.trim()) {
      throw new Error(`${label}第 ${index + 1} 项缺少本地路径。`);
    }
    return {
      mediaId,
      path: item.path,
      audioStreamIndex: normalizeStreamIndex(item.audioStreamIndex, `${label}音轨索引`),
      videoStreamIndex: normalizeStreamIndex(item.videoStreamIndex, `${label}视频流索引`)
    };
  });
}

const AUDIO_ALIGNMENT_JOB_STATUSES = new Set<AudioAlignmentJobStatus>([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled"
]);

function validateAudioAlignmentBatchJobSnapshot(
  value: unknown,
  expectedJobId?: string
): AudioAlignmentBatchJobSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("原生批任务返回了不支持的响应结构或 schemaVersion。");
  }
  const jobId = requireRuntimeText(value.jobId, "批任务 jobId");
  if (expectedJobId !== undefined && jobId !== expectedJobId) {
    throw new Error("原生批任务响应的 jobId 与请求不一致。");
  }
  const status = requireRuntimeJobStatus(value.status, "批任务状态");
  requireRuntimeProgress(value.progress, "批任务进度");
  requireRuntimeText(value.message, "批任务消息");
  const totalPairCount = requireRuntimeInteger(value.totalPairCount, "批任务 pair 总数", 1, 256);
  const processedPairCount = requireRuntimeInteger(
    value.processedPairCount,
    "批任务已处理 pair 数",
    0,
    totalPairCount
  );
  const failedPairCount = requireRuntimeInteger(
    value.failedPairCount,
    "批任务失败 pair 数",
    0,
    totalPairCount
  );
  if (!Array.isArray(value.pairs) || value.pairs.length !== totalPairCount) {
    throw new Error("原生批任务响应的 pairs 数量与 totalPairCount 不一致。");
  }
  const pairOrdinals = new Set<number>();
  const pairs = value.pairs.map((pair, index) =>
    validateAudioAlignmentBatchPairSnapshot(pair, index, totalPairCount, pairOrdinals)
  );
  const actualProcessed = pairs.filter(
    (pair) => pair.status === "completed" || pair.status === "failed"
  ).length;
  const actualFailed = pairs.filter((pair) => pair.status === "failed").length;
  if (processedPairCount !== actualProcessed || failedPairCount !== actualFailed) {
    throw new Error("原生批任务响应的 processed/failed 计数与 pair 状态不一致。");
  }
  const currentPairOrdinal = value.currentPairOrdinal;
  if (currentPairOrdinal !== null) {
    if (
      typeof currentPairOrdinal !== "number" ||
      !Number.isSafeInteger(currentPairOrdinal) ||
      currentPairOrdinal < 1 ||
      currentPairOrdinal > totalPairCount
    ) {
      throw new Error("原生批任务响应的 currentPairOrdinal 无效。");
    }
  }
  if (isAudioAlignmentJobFinished(status)) {
    if (
      currentPairOrdinal !== null ||
      pairs.some((pair) => !isAudioAlignmentJobFinished(pair.status))
    ) {
      throw new Error("原生批任务已结束，但仍包含运行中的 pair 或 currentPairOrdinal。");
    }
  }
  if (value.error !== null && typeof value.error !== "string") {
    throw new Error("原生批任务响应的 error 必须是字符串或 null。");
  }
  requireRuntimeInteger(value.updatedAtMs, "批任务更新时间", 0, Number.MAX_SAFE_INTEGER);
  return value as unknown as AudioAlignmentBatchJobSnapshot;
}

function validateAudioAlignmentBatchPairSnapshot(
  value: unknown,
  index: number,
  totalPairCount: number,
  pairOrdinals: Set<number>
): AudioAlignmentBatchPairSnapshot {
  if (!isRecord(value)) {
    throw new Error(`原生批任务第 ${index + 1} 个 pair 响应不是对象。`);
  }
  const pairOrdinal = requireRuntimeInteger(
    value.pairOrdinal,
    `第 ${index + 1} 个 pair 序号`,
    1,
    totalPairCount
  );
  if (pairOrdinals.has(pairOrdinal)) {
    throw new Error("原生批任务响应包含重复 pairOrdinal。");
  }
  pairOrdinals.add(pairOrdinal);
  requireRuntimeText(value.sourceMediaId, `第 ${index + 1} 个 pair 来源媒体 ID`);
  requireRuntimeText(value.targetMediaId, `第 ${index + 1} 个 pair 目标媒体 ID`);
  const status = requireRuntimeJobStatus(value.status, `第 ${index + 1} 个 pair 状态`);
  requireRuntimeProgress(value.progress, `第 ${index + 1} 个 pair 进度`);
  requireRuntimeText(value.message, `第 ${index + 1} 个 pair 消息`);
  if (status === "completed") {
    if (!isRecord(value.proposal) || value.error !== null) {
      throw new Error("已完成 pair 必须包含 proposal 且不能包含 error。");
    }
  } else if (status === "failed") {
    if (value.proposal !== null || typeof value.error !== "string" || !value.error.trim()) {
      throw new Error("失败 pair 必须包含 error 且不能包含 proposal。");
    }
  } else if (value.proposal !== null || value.error !== null) {
    throw new Error("未完成或已取消 pair 不能包含 proposal/error。");
  }
  return value as unknown as AudioAlignmentBatchPairSnapshot;
}

function requireRuntimeJobStatus(value: unknown, label: string): AudioAlignmentJobStatus {
  if (typeof value !== "string" || !AUDIO_ALIGNMENT_JOB_STATUSES.has(value as AudioAlignmentJobStatus)) {
    throw new Error(`${label}无效。`);
  }
  return value as AudioAlignmentJobStatus;
}

function requireRuntimeProgress(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label}必须位于 0 到 1。`);
  }
  return value;
}

function requireRuntimeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label}无效。`);
  }
  return value as number;
}

function requireRuntimeText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}不能为空。`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAudioStreamIndex(
  value: number | null | undefined,
  label: string
): number | null {
  return normalizeStreamIndex(value, label);
}

function normalizeStreamIndex(
  value: number | null | undefined,
  label: string
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}必须是非负安全整数或 null。`);
  }
  return value;
}

function formatAudioAlignmentFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
