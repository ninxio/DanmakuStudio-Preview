import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AlignmentProposal } from "../../domain/alignment/types";

export interface TauriAudioAlignmentRequest {
  completePath: string;
  sourcePath: string;
  ffmpegPath: string | null;
  sampleRate?: number;
  windowMs?: number;
  matchThreshold?: number;
  minGapMs?: number;
  maxCells?: number;
}

export type AudioAlignmentInvoker = (
  request: TauriAudioAlignmentRequest
) => Promise<AlignmentProposal>;

export type AudioAlignmentJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type AudioAlignmentStageKey =
  | "queued"
  | "validating"
  | "extracting-complete"
  | "extracting-source"
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
  start: (request: TauriAudioAlignmentRequest) => Promise<AudioAlignmentJobSnapshot>;
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
  return invoker(request);
}

export async function startTauriAudioAlignmentJob(
  request: TauriAudioAlignmentRequest,
  invoker: AudioAlignmentJobInvoker = defaultAudioAlignmentJobInvoker
): Promise<AudioAlignmentJobSnapshot> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentJobInvoker);
  return invoker.start(request);
}

export async function getTauriAudioAlignmentJob(
  jobId: string,
  invoker: AudioAlignmentJobInvoker = defaultAudioAlignmentJobInvoker
): Promise<AudioAlignmentJobSnapshot> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentJobInvoker);
  return invoker.get(jobId);
}

export async function cancelTauriAudioAlignmentJob(
  jobId: string,
  invoker: AudioAlignmentJobInvoker = defaultAudioAlignmentJobInvoker
): Promise<AudioAlignmentJobSnapshot> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentJobInvoker);
  return invoker.cancel(jobId);
}

export function isAudioAlignmentJobFinished(status: AudioAlignmentJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function defaultAudioAlignmentInvoker(request: TauriAudioAlignmentRequest): Promise<AlignmentProposal> {
  return invoke<AlignmentProposal>("align_audio_files", { request });
}

const defaultAudioAlignmentJobInvoker: AudioAlignmentJobInvoker = {
  start: (request) => invoke<AudioAlignmentJobSnapshot>("start_audio_alignment_job", { request }),
  get: (jobId) => invoke<AudioAlignmentJobSnapshot>("get_audio_alignment_job", { jobId }),
  cancel: (jobId) => invoke<AudioAlignmentJobSnapshot>("cancel_audio_alignment_job", { jobId })
};

function ensureDesktopAudioAlignment(usesDefaultInvoker: boolean): void {
  if (usesDefaultInvoker && !isTauri()) {
    throw new Error("本地音频对齐需要在 Tauri 桌面端运行。");
  }
}
