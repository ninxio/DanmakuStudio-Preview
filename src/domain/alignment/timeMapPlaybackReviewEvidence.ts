import type { EditorProject, MediaTimeMap } from "../project/types";
import { sha256Hex } from "../shared/sha256";
import type { TimeMapSpan } from "./timeMap";
import type { TimeMapPlaybackAxis } from "./timeMapPlayback";

export interface TimeMapSpanPlaybackEvidence {
  spanAxes: TimeMapPlaybackAxis[];
  startBoundaryAxes: TimeMapPlaybackAxis[];
  endBoundaryAxes: TimeMapPlaybackAxis[];
}

export interface RecordedTimeMapSpanPlaybackReview extends TimeMapSpanPlaybackEvidence {
  spanIndex: number;
  spanDigest: string;
  reviewedAt: string;
  token: string;
}

const PLAYBACK_REVIEW_PREFIX = "manual-playback-review:v1:";
const SOURCE_SPAN = 1 << 0;
const TARGET_SPAN = 1 << 1;
const SOURCE_START = 1 << 2;
const TARGET_START = 1 << 3;
const SOURCE_END = 1 << 4;
const TARGET_END = 1 << 5;

export function createEmptyTimeMapSpanPlaybackEvidence(): TimeMapSpanPlaybackEvidence {
  return { spanAxes: [], startBoundaryAxes: [], endBoundaryAxes: [] };
}

export function markTimeMapSpanPlaybackStarted(
  evidence: TimeMapSpanPlaybackEvidence,
  scope: "span" | "startBoundary" | "endBoundary",
  axis: TimeMapPlaybackAxis
): TimeMapSpanPlaybackEvidence {
  const key =
    scope === "span"
      ? "spanAxes"
      : scope === "startBoundary"
        ? "startBoundaryAxes"
        : "endBoundaryAxes";
  return {
    spanAxes: [...evidence.spanAxes],
    startBoundaryAxes: [...evidence.startBoundaryAxes],
    endBoundaryAxes: [...evidence.endBoundaryAxes],
    [key]: appendAxis(evidence[key], axis)
  };
}

export function describeMissingTimeMapSpanPlaybackEvidence(
  span: TimeMapSpan,
  evidence: TimeMapSpanPlaybackEvidence
): string[] {
  const missing: string[] = [];
  if (span.kind === "matched") {
    if (!evidence.spanAxes.includes("source")) missing.push("播放参考 A");
    if (!evidence.spanAxes.includes("target")) missing.push("播放原片 B");
    return missing;
  }
  if (span.kind === "sourceOnly") {
    if (!evidence.spanAxes.includes("source")) missing.push("播放参考独有内容");
  } else if (span.kind === "targetOnly") {
    if (!evidence.spanAxes.includes("target")) missing.push("播放原片独有内容");
  } else {
    if (!evidence.spanAxes.includes("source")) missing.push("播放参考 A");
    if (!evidence.spanAxes.includes("target")) missing.push("播放原片 B");
  }
  for (const [axes, label] of [
    [evidence.startBoundaryAxes, "段首"],
    [evidence.endBoundaryAxes, "段尾"]
  ] as const) {
    if (!axes.includes("source")) missing.push(`${label}边界播放参考 A`);
    if (!axes.includes("target")) missing.push(`${label}边界播放原片 B`);
  }
  return missing;
}

export function recordCandidateTimeMapSpanPlaybackReview(
  project: EditorProject,
  timeMapId: string,
  spanIndex: number,
  evidence: TimeMapSpanPlaybackEvidence,
  reviewedAt: string
): EditorProject {
  const timeMap = project.mediaTimeMaps.find((item) => item.id === timeMapId);
  const candidate = project.mediaMatchCandidates.find(
    (item) =>
      item.timeMapId === timeMapId && (item.state === "pending" || item.state === "blocked")
  );
  if (!timeMap || timeMap.state !== "candidate" || !candidate) {
    throw new Error("只能为待复核候选记录播放证据；已确认关系请先撤销后重新复核。");
  }
  const span = timeMap.spans[spanIndex];
  if (!span) throw new Error("要记录播放复核的时间图片段不存在。");
  const token = createTimeMapSpanPlaybackReviewToken(
    timeMap,
    spanIndex,
    evidence,
    reviewedAt
  );
  const notes = timeMap.evidence.notes.filter(
    (note) => !note.startsWith(`${PLAYBACK_REVIEW_PREFIX}${spanIndex}:`)
  );
  const reviewedMap: MediaTimeMap = {
    ...timeMap,
    revision: timeMap.revision + 1,
    evidence: {
      ...timeMap.evidence,
      types: timeMap.evidence.types.includes("manual")
        ? [...timeMap.evidence.types]
        : [...timeMap.evidence.types, "manual"],
      notes: [...notes, token]
    },
    verification: null,
    updatedAt: reviewedAt
  };
  const proposalTimeMap = candidate.proposal.timeMap
    ? {
        ...candidate.proposal.timeMap,
        evidence: {
          ...candidate.proposal.timeMap.evidence,
          types: [...reviewedMap.evidence.types],
          notes: [...reviewedMap.evidence.notes]
        }
      }
    : undefined;
  return {
    ...project,
    mediaTimeMaps: project.mediaTimeMaps.map((item) =>
      item.id === timeMapId ? reviewedMap : item
    ),
    mediaMatchCandidates: project.mediaMatchCandidates.map((item) =>
      item.id === candidate.id
        ? {
            ...item,
            proposal: proposalTimeMap
              ? { ...item.proposal, timeMap: proposalTimeMap }
              : item.proposal,
            updatedAt: reviewedAt
          }
        : item
    )
  };
}

export function createTimeMapSpanPlaybackReviewToken(
  timeMap: MediaTimeMap,
  spanIndex: number,
  evidence: TimeMapSpanPlaybackEvidence,
  reviewedAt: string
): string {
  const span = timeMap.spans[spanIndex];
  if (!span) throw new Error("要记录播放复核的时间图片段不存在。");
  const missing = describeMissingTimeMapSpanPlaybackEvidence(span, evidence);
  if (missing.length > 0) throw new Error(`播放复核尚未完成：${missing.join("、")}。`);
  if (!isIsoTimestamp(reviewedAt)) throw new Error("播放复核时间必须是规范 ISO 时间戳。");
  return serializePlaybackReview(timeMap, spanIndex, evidence, reviewedAt);
}

/** 只返回与当前媒体关系、span kind 和四个边界完全一致的持久播放证据。 */
export function readTimeMapSpanPlaybackReview(
  timeMap: MediaTimeMap,
  spanIndex: number
): RecordedTimeMapSpanPlaybackReview | null {
  const span = timeMap.spans[spanIndex];
  if (!span) return null;
  for (let index = timeMap.evidence.notes.length - 1; index >= 0; index -= 1) {
    const parsed = parsePlaybackReview(timeMap.evidence.notes[index] ?? "");
    if (
      parsed &&
      parsed.spanIndex === spanIndex &&
      parsed.spanDigest === computeSpanDigest(timeMap, spanIndex) &&
      describeMissingTimeMapSpanPlaybackEvidence(span, parsed).length === 0
    ) {
      return parsed;
    }
  }
  return null;
}

function serializePlaybackReview(
  timeMap: MediaTimeMap,
  spanIndex: number,
  evidence: TimeMapSpanPlaybackEvidence,
  reviewedAt: string
): string {
  const mask = evidenceMask(evidence);
  return `${PLAYBACK_REVIEW_PREFIX}${spanIndex}:${computeSpanDigest(timeMap, spanIndex).slice(7)}:${mask}:${reviewedAt}`;
}

function parsePlaybackReview(note: string): RecordedTimeMapSpanPlaybackReview | null {
  if (!note.startsWith(PLAYBACK_REVIEW_PREFIX)) return null;
  const fields = note.slice(PLAYBACK_REVIEW_PREFIX.length).split(":");
  if (fields.length < 4) return null;
  const spanIndex = Number(fields[0]);
  const spanDigest = `sha256:${fields[1] ?? ""}`;
  const mask = Number(fields[2]);
  const reviewedAt = fields.slice(3).join(":");
  if (
    !Number.isSafeInteger(spanIndex) ||
    spanIndex < 0 ||
    !/^sha256:[0-9a-f]{64}$/.test(spanDigest) ||
    !Number.isSafeInteger(mask) ||
    mask < 0 ||
    mask > 63 ||
    !isIsoTimestamp(reviewedAt)
  ) {
    return null;
  }
  const evidence = evidenceFromMask(mask);
  return { spanIndex, spanDigest, reviewedAt, token: note, ...evidence };
}

function computeSpanDigest(timeMap: MediaTimeMap, spanIndex: number): string {
  const span = timeMap.spans[spanIndex];
  if (!span) return "sha256:";
  return `sha256:${sha256Hex(
    JSON.stringify([
      "manual-playback-review-span-v1",
      timeMap.sourceMediaId,
      timeMap.targetMediaId,
      span.kind,
      span.sourceStartMs,
      span.sourceEndMs,
      span.targetStartMs,
      span.targetEndMs
    ])
  )}`;
}

function evidenceMask(evidence: TimeMapSpanPlaybackEvidence): number {
  return (
    (evidence.spanAxes.includes("source") ? SOURCE_SPAN : 0) |
    (evidence.spanAxes.includes("target") ? TARGET_SPAN : 0) |
    (evidence.startBoundaryAxes.includes("source") ? SOURCE_START : 0) |
    (evidence.startBoundaryAxes.includes("target") ? TARGET_START : 0) |
    (evidence.endBoundaryAxes.includes("source") ? SOURCE_END : 0) |
    (evidence.endBoundaryAxes.includes("target") ? TARGET_END : 0)
  );
}

function evidenceFromMask(mask: number): TimeMapSpanPlaybackEvidence {
  return {
    spanAxes: axesFromBits(mask, SOURCE_SPAN, TARGET_SPAN),
    startBoundaryAxes: axesFromBits(mask, SOURCE_START, TARGET_START),
    endBoundaryAxes: axesFromBits(mask, SOURCE_END, TARGET_END)
  };
}

function axesFromBits(
  mask: number,
  sourceBit: number,
  targetBit: number
): TimeMapPlaybackAxis[] {
  const axes: TimeMapPlaybackAxis[] = [];
  if ((mask & sourceBit) !== 0) axes.push("source");
  if ((mask & targetBit) !== 0) axes.push("target");
  return axes;
}

function appendAxis(
  axes: readonly TimeMapPlaybackAxis[],
  axis: TimeMapPlaybackAxis
): TimeMapPlaybackAxis[] {
  return axes.includes(axis) ? [...axes] : [...axes, axis];
}

function isIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
