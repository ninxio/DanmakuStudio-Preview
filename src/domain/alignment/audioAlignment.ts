import type { SyncAnchor } from "../danmaku/types";
import type { Milliseconds } from "../shared/time";
import { clampMilliseconds } from "../shared/time";
import type { AlignmentProposal, CutCandidate } from "./types";

export interface AudioFeatureFrame {
  timeMs: Milliseconds;
  values: number[];
}

export interface AudioFeatureMatch {
  completeIndex: number;
  sourceIndex: number;
  completeTimeMs: Milliseconds;
  sourceTimeMs: Milliseconds;
  distance: number;
}

export interface AudioAlignmentOptions {
  matchThreshold?: number;
  minGapMs?: Milliseconds;
  maxCells?: number;
  anchorStride?: number;
}

const DEFAULT_MATCH_THRESHOLD = 0.18;
const DEFAULT_MIN_GAP_MS = 1000;
const DEFAULT_MAX_CELLS = 16_000_000;
const DEFAULT_ANCHOR_STRIDE = 8;

const DIRECTION_SKIP_COMPLETE = 1;
const DIRECTION_SKIP_SOURCE = 2;
const DIRECTION_MATCH = 3;

export function createAudioAlignmentProposal(
  completeFrames: AudioFeatureFrame[],
  sourceFrames: AudioFeatureFrame[],
  options: AudioAlignmentOptions = {}
): AlignmentProposal {
  if (completeFrames.length === 0 || sourceFrames.length === 0) {
    return {
      anchors: [],
      cutCandidates: [],
      confidence: 0,
      diagnostics: ["音频特征为空，无法对齐。"]
    };
  }

  const matchThreshold = options.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
  const matches = alignAudioFeatureSequences(completeFrames, sourceFrames, options);
  const cutCandidates = inferAudioCutCandidates(matches, {
    matchThreshold,
    minGapMs: options.minGapMs ?? DEFAULT_MIN_GAP_MS
  });
  const anchors = createAnchorsFromMatches(matches, options.anchorStride ?? DEFAULT_ANCHOR_STRIDE, matchThreshold);
  const coverage = matches.length / Math.max(1, sourceFrames.length);
  const diagnostics = [
    `音频特征匹配 ${matches.length} / ${sourceFrames.length} 帧，覆盖率 ${Math.round(coverage * 100)}%。`,
    cutCandidates.length > 0
      ? `已推断 ${cutCandidates.length} 个候选缺失段。`
      : "未发现超过阈值的候选缺失段。"
  ];

  return {
    anchors,
    cutCandidates,
    confidence: clampNumber(coverage, 0, 1),
    diagnostics
  };
}

export function alignAudioFeatureSequences(
  completeFrames: AudioFeatureFrame[],
  sourceFrames: AudioFeatureFrame[],
  options: AudioAlignmentOptions = {}
): AudioFeatureMatch[] {
  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;
  const cellCount = (completeFrames.length + 1) * (sourceFrames.length + 1);
  if (cellCount > maxCells) {
    throw new Error(`音频特征数量过多：${cellCount} 个 DP 单元，请增大采样窗口或提高 maxCells。`);
  }

  const matchThreshold = options.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
  const width = sourceFrames.length + 1;
  let previous = new Float64Array(width);
  let current = new Float64Array(width);
  const directions = new Uint8Array(cellCount);

  for (let completeIndex = 1; completeIndex <= completeFrames.length; completeIndex += 1) {
    current = new Float64Array(width);
    for (let sourceIndex = 1; sourceIndex <= sourceFrames.length; sourceIndex += 1) {
      const distance = getFeatureDistance(completeFrames[completeIndex - 1], sourceFrames[sourceIndex - 1]);
      const matchScore = distance <= matchThreshold ? 1 - distance / matchThreshold : Number.NEGATIVE_INFINITY;
      const skipCompleteScore = previous[sourceIndex];
      const skipSourceScore = current[sourceIndex - 1];
      const matchedScore = previous[sourceIndex - 1] + matchScore;
      const cellOffset = completeIndex * width + sourceIndex;
      if (matchedScore >= skipCompleteScore && matchedScore >= skipSourceScore) {
        current[sourceIndex] = matchedScore;
        directions[cellOffset] = DIRECTION_MATCH;
      } else if (skipCompleteScore >= skipSourceScore) {
        current[sourceIndex] = skipCompleteScore;
        directions[cellOffset] = DIRECTION_SKIP_COMPLETE;
      } else {
        current[sourceIndex] = skipSourceScore;
        directions[cellOffset] = DIRECTION_SKIP_SOURCE;
      }
    }
    previous = current;
  }

  return backtrackMatches(completeFrames, sourceFrames, directions);
}

export function inferAudioCutCandidates(
  matches: AudioFeatureMatch[],
  options: Required<Pick<AudioAlignmentOptions, "matchThreshold" | "minGapMs">>
): CutCandidate[] {
  const candidates: CutCandidate[] = [];
  for (let index = 1; index < matches.length; index += 1) {
    const previous = matches[index - 1];
    const current = matches[index];
    const completeDeltaMs = current.completeTimeMs - previous.completeTimeMs;
    const sourceDeltaMs = current.sourceTimeMs - previous.sourceTimeMs;
    const missingDurationMs = Math.round(completeDeltaMs - sourceDeltaMs);
    if (missingDurationMs < options.minGapMs) {
      continue;
    }
    const sourceAtMs = estimateCutBoundaryMs(previous, current);
    const confidence = clampNumber(
      1 - (previous.distance + current.distance) / (2 * options.matchThreshold),
      0.1,
      0.95
    );
    candidates.push({
      id: `audio-gap-${candidates.length + 1}`,
      name: `音频推断补偿 ${candidates.length + 1}`,
      sourceAtMs,
      sourceRangeStartMs: clampMilliseconds(previous.sourceTimeMs),
      sourceRangeEndMs: clampMilliseconds(current.sourceTimeMs),
      targetGapMs: missingDurationMs,
      confidence,
      note: `音频对齐显示完整片源在 ${formatDuration(previous.completeTimeMs)} 到 ${formatDuration(current.completeTimeMs)} 之间比删减版多出约 ${formatDuration(missingDurationMs)}，候选边界约在删减版 ${formatDuration(sourceAtMs)}。`
    });
  }
  return mergeNearbyCandidates(candidates);
}

function estimateCutBoundaryMs(previous: AudioFeatureMatch, current: AudioFeatureMatch): Milliseconds {
  const sourceDeltaMs = Math.max(0, current.sourceTimeMs - previous.sourceTimeMs);
  return clampMilliseconds(previous.sourceTimeMs + Math.round(sourceDeltaMs / 2));
}

function backtrackMatches(
  completeFrames: AudioFeatureFrame[],
  sourceFrames: AudioFeatureFrame[],
  directions: Uint8Array
): AudioFeatureMatch[] {
  const width = sourceFrames.length + 1;
  const matches: AudioFeatureMatch[] = [];
  let completeIndex = completeFrames.length;
  let sourceIndex = sourceFrames.length;
  while (completeIndex > 0 && sourceIndex > 0) {
    const direction = directions[completeIndex * width + sourceIndex];
    if (direction === DIRECTION_MATCH) {
      const completeFrame = completeFrames[completeIndex - 1];
      const sourceFrame = sourceFrames[sourceIndex - 1];
      matches.push({
        completeIndex: completeIndex - 1,
        sourceIndex: sourceIndex - 1,
        completeTimeMs: completeFrame.timeMs,
        sourceTimeMs: sourceFrame.timeMs,
        distance: getFeatureDistance(completeFrame, sourceFrame)
      });
      completeIndex -= 1;
      sourceIndex -= 1;
    } else if (direction === DIRECTION_SKIP_COMPLETE) {
      completeIndex -= 1;
    } else {
      sourceIndex -= 1;
    }
  }
  return matches.reverse();
}

function createAnchorsFromMatches(
  matches: AudioFeatureMatch[],
  anchorStride: number,
  matchThreshold: number
): SyncAnchor[] {
  const stride = Math.max(1, Math.round(anchorStride));
  return matches
    .filter((_, index) => index % stride === 0 || index === matches.length - 1)
    .map((match, index) => ({
      id: `audio-anchor-${index + 1}`,
      sourceMs: match.sourceTimeMs,
      targetMs: match.completeTimeMs,
      confidence: clampNumber(1 - match.distance / matchThreshold, 0, 1),
      origin: "automatic"
    }));
}

function mergeNearbyCandidates(candidates: CutCandidate[]): CutCandidate[] {
  const merged: CutCandidate[] = [];
  for (const candidate of candidates) {
    const previous = merged.at(-1);
    if (previous && Math.abs(candidate.sourceAtMs - previous.sourceAtMs) <= 2000) {
      previous.targetGapMs += candidate.targetGapMs;
      previous.confidence = Math.min(previous.confidence, candidate.confidence);
      previous.sourceRangeStartMs = Math.min(
        previous.sourceRangeStartMs ?? previous.sourceAtMs,
        candidate.sourceRangeStartMs ?? candidate.sourceAtMs
      );
      previous.sourceRangeEndMs = Math.max(
        previous.sourceRangeEndMs ?? previous.sourceAtMs,
        candidate.sourceRangeEndMs ?? candidate.sourceAtMs
      );
      previous.note = `${previous.note} ${candidate.note}`;
    } else {
      merged.push({ ...candidate });
    }
  }
  return merged.map((candidate, index) => ({
    ...candidate,
    id: `audio-gap-${index + 1}`,
    name: `音频推断补偿 ${index + 1}`
  }));
}

function getFeatureDistance(left: AudioFeatureFrame, right: AudioFeatureFrame): number {
  const width = Math.max(left.values.length, right.values.length);
  if (width === 0) {
    return 1;
  }
  let total = 0;
  for (let index = 0; index < width; index += 1) {
    const delta = (left.values[index] ?? 0) - (right.values[index] ?? 0);
    total += delta * delta;
  }
  return Math.sqrt(total / width);
}

function formatDuration(milliseconds: Milliseconds): string {
  const safe = clampMilliseconds(milliseconds);
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
