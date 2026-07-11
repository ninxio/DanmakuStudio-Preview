import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AlignmentProposal } from "../../domain/alignment/types";

export interface TauriAudioAlignmentRequest {
  completePath: string;
  sourcePath: string;
  ffmpegPath: string | null;
  ffprobePath?: string | null;
  completeAudioStreamIndex?: number | null;
  sourceAudioStreamIndex?: number | null;
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
  "ffprobePath" | "completeAudioStreamIndex" | "sourceAudioStreamIndex"
> {
  ffprobePath: string | null;
  completeAudioStreamIndex: number | null;
  sourceAudioStreamIndex: number | null;
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
    )
  };
}

function normalizeAudioStreamIndex(
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
