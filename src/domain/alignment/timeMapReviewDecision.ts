import type { EditorProject, MediaTimeMap } from "../project/types";
import {
  invalidateTimeMapSpanEvidenceForManualReview,
  isCompleteTimeMapSpanEvidence,
  normalizeLegacyUnverifiedTimeMapSpanEvidence,
  validateTimeMap,
  type TimeMapSpan,
  type TimeMapSpanKind
} from "./timeMap";

export type TimeMapSpanReviewDecision =
  "source-extra" | "target-extra" | "replacement" | "unresolved";

export const TIME_MAP_SPAN_REVIEW_LABELS: Record<TimeMapSpanReviewDecision, string> = {
  "source-extra": "参考多出",
  "target-extra": "原片多出",
  replacement: "版本替换",
  unresolved: "无法判断"
};

export interface TimeMapSpanReviewAvailability {
  allowed: boolean;
  desiredKind: TimeMapSpanKind;
  reason: string;
}

export interface RecordedTimeMapSpanReview {
  spanIndex: number;
  decision: TimeMapSpanReviewDecision;
  reviewedAt: string;
}

const REVIEW_NOTE_PREFIX = "manual-span-review:v1:";
const PLAYBACK_REVIEW_PREFIX = "manual-playback-review:v2:";
const LEGACY_PLAYBACK_REVIEW_PREFIX = "manual-playback-review:v1:";
const MANUAL_TAKEOVER_NOTE_PREFIX = "manual-takeover:v1:";
const MANUAL_REVIEW_STATE_REASON_PREFIX = "逐段人工复核状态：";

export class TimeMapSpanReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeMapSpanReviewError";
  }
}

export function suggestTimeMapSpanReviewDecision(
  span: TimeMapSpan
): TimeMapSpanReviewDecision | null {
  if (span.kind === "matched") return null;
  const sourceDurationMs = span.sourceEndMs - span.sourceStartMs;
  const targetDurationMs = span.targetEndMs - span.targetStartMs;
  if (sourceDurationMs > 0 && targetDurationMs === 0) return "source-extra";
  if (sourceDurationMs === 0 && targetDurationMs > 0) return "target-extra";
  if (sourceDurationMs > 0 && targetDurationMs > 0) return "replacement";
  return "unresolved";
}

export function applySystemSuggestedTimeMapReviews(
  timeMap: MediaTimeMap,
  reviewedAt: string
): MediaTimeMap {
  return timeMap.spans.reduce((current, span, spanIndex) => {
    const suggestion = suggestTimeMapSpanReviewDecision(span);
    return suggestion && suggestion !== "unresolved"
      ? applyTimeMapSpanReviewDecision(current, spanIndex, suggestion, reviewedAt)
      : current;
  }, timeMap);
}

export function applyCandidateTimeMapManualTakeover(
  timeMap: MediaTimeMap,
  reviewedAt: string
): MediaTimeMap {
  if (timeMap.state !== "candidate") {
    throw new TimeMapSpanReviewError("只能接管尚未确认的候选时间图。");
  }
  if (!isIsoTimestamp(reviewedAt)) {
    throw new TimeMapSpanReviewError("人工接管时间必须是有效的 ISO 时间戳。");
  }
  if (!timeMap.sourceIdentity || !timeMap.targetIdentity) {
    throw new TimeMapSpanReviewError("人工接管前必须保留参考与原片的内容身份快照。");
  }
  const validation = validateTimeMap(timeMap.spans);
  if (!validation.valid || timeMap.spans.length === 0) {
    throw new TimeMapSpanReviewError(
      `候选时间图结构无效，不能人工接管：${validation.issues[0]?.message ?? "没有可用分段"}`
    );
  }
  const unresolved = timeMap.spans.flatMap((span, spanIndex) => {
    const suggestion = suggestTimeMapSpanReviewDecision(span);
    if (!suggestion) return [];
    const recorded = readTimeMapSpanReviewDecision(timeMap, spanIndex)?.decision;
    return recorded === suggestion
      ? []
      : [`第 ${spanIndex + 1} 段尚未采用系统建议“${TIME_MAP_SPAN_REVIEW_LABELS[suggestion]}”`];
  });
  if (unresolved.length > 0) {
    throw new TimeMapSpanReviewError(`人工接管前仍有未定区间：${unresolved.slice(0, 3).join("；")}。`);
  }
  const spans = timeMap.spans.map((span, spanIndex) => {
    const complete = isCompleteTimeMapSpanEvidence(span)
      ? { ...span }
      : normalizeLegacyUnverifiedTimeMapSpanEvidence(span, {
          id: span.id ?? `${timeMap.id}:span:${String(spanIndex + 1).padStart(4, "0")}`,
          blocked: true
        });
    return {
      ...complete,
      quality: {
        ...complete.quality,
        level: "review" as const,
        reasons: [
          `第 ${spanIndex + 1} 段由用户采用系统建议并明确接管；算法阻断仍保留在整图诊断中，导出需安装级签名。`
        ]
      }
    };
  });
  return {
    ...timeMap,
    revision: timeMap.revision + 1,
    spans,
    quality: {
      ...timeMap.quality,
      level: "review",
      reasons: uniqueStrings([
        ...timeMap.quality.reasons,
        "用户已采用系统最高可能性建议并接管该候选；允许保存关系，但正式导出仍需明确签发人工方案。"
      ])
    },
    evidence: {
      ...timeMap.evidence,
      types: appendUnique(timeMap.evidence.types, "manual"),
      notes: [
        ...timeMap.evidence.notes.filter(
          (note) => !note.startsWith(MANUAL_TAKEOVER_NOTE_PREFIX)
        ),
        `${MANUAL_TAKEOVER_NOTE_PREFIX}${reviewedAt}`
      ]
    },
    verification: null,
    updatedAt: reviewedAt
  };
}

export function readTimeMapManualTakeover(timeMap: MediaTimeMap): string | null {
  for (let index = timeMap.evidence.notes.length - 1; index >= 0; index -= 1) {
    const note = timeMap.evidence.notes[index] ?? "";
    if (!note.startsWith(MANUAL_TAKEOVER_NOTE_PREFIX)) continue;
    const reviewedAt = note.slice(MANUAL_TAKEOVER_NOTE_PREFIX.length);
    return isIsoTimestamp(reviewedAt) ? reviewedAt : null;
  }
  return null;
}

/**
 * 根据双方区间形状判断一个人工分类是否可写回。分类不会暗改边界；形状不兼容时
 * 必须先做边界编辑，因此这里 fail-closed。
 */
export function describeTimeMapSpanReviewAvailability(
  span: TimeMapSpan,
  decision: TimeMapSpanReviewDecision
): TimeMapSpanReviewAvailability {
  const sourceDurationMs = span.sourceEndMs - span.sourceStartMs;
  const targetDurationMs = span.targetEndMs - span.targetStartMs;
  const desiredKind = decisionToSpanKind(decision);
  if (decision === "source-extra") {
    return sourceDurationMs > 0 && targetDurationMs === 0
      ? { allowed: true, desiredKind, reason: "双方边界形状支持“参考多出”。" }
      : {
          allowed: false,
          desiredKind,
          reason: "要判定为“参考多出”，原片侧必须先收敛为同一个边界点。"
        };
  }
  if (decision === "target-extra") {
    return sourceDurationMs === 0 && targetDurationMs > 0
      ? { allowed: true, desiredKind, reason: "双方边界形状支持“原片多出”。" }
      : {
          allowed: false,
          desiredKind,
          reason: "要判定为“原片多出”，参考侧必须先收敛为同一个边界点。"
        };
  }
  if (decision === "replacement") {
    return sourceDurationMs > 0 && targetDurationMs > 0
      ? { allowed: true, desiredKind, reason: "双方都有内容，可记录为版本替换。" }
      : {
          allowed: false,
          desiredKind,
          reason: "版本替换要求参考和原片两侧都有正长度内容；请先编辑边界。"
        };
  }
  return sourceDurationMs > 0 || targetDurationMs > 0
    ? { allowed: true, desiredKind, reason: "保留为无法判断，继续阻断导出。" }
    : {
        allowed: false,
        desiredKind,
        reason: "空边界点不能记录为差异区间。"
      };
}

/**
 * 在候选时间图内持久记录人工分类。记录复用 evidence.notes，避免新增一个与
 * schema 并行的临时状态；项目保存和重开后仍可恢复。任何人工改动都会清除旧验证、
 * 增加 revision 且不提升质量等级。
 */
export function applyTimeMapSpanReviewDecision(
  timeMap: MediaTimeMap,
  spanIndex: number,
  decision: TimeMapSpanReviewDecision,
  reviewedAt: string
): MediaTimeMap {
  if (timeMap.state !== "candidate") {
    throw new TimeMapSpanReviewError("只能修改尚未确认的候选时间图；请先撤销已确认关系。");
  }
  if (!Number.isSafeInteger(spanIndex) || spanIndex < 0 || spanIndex >= timeMap.spans.length) {
    throw new TimeMapSpanReviewError("要分类的时间图片段不存在。");
  }
  if (!isIsoTimestamp(reviewedAt)) {
    throw new TimeMapSpanReviewError("人工分类时间必须是有效的 ISO 时间戳。");
  }
  const span = timeMap.spans[spanIndex];
  const availability = describeTimeMapSpanReviewAvailability(span, decision);
  if (!availability.allowed) {
    throw new TimeMapSpanReviewError(`${availability.reason} 当前分类未写入。`);
  }
  const spans = timeMap.spans.map((current, index) => {
    const complete = isCompleteTimeMapSpanEvidence(current)
      ? { ...current }
      : normalizeLegacyUnverifiedTimeMapSpanEvidence(current, {
          id: current.id ?? `${timeMap.id}:span:${String(index + 1).padStart(4, "0")}`,
          blocked: timeMap.quality.level === "blocked"
        });
    if (index !== spanIndex) {
      return complete;
    }
    return invalidateTimeMapSpanEvidenceForManualReview(
      { ...complete, kind: availability.desiredKind },
      decision === "unresolved",
      `第 ${spanIndex + 1} 段由人工分类为“${TIME_MAP_SPAN_REVIEW_LABELS[decision]}”，原算法为旧分类生成的逐段证据已失效。`
    );
  });
  const validation = validateTimeMap(spans);
  if (!validation.valid) {
    throw new TimeMapSpanReviewError(
      `分类后的时间图结构无效，未写入：${validation.issues[0]?.message ?? "未知结构错误"}`
    );
  }
  const reviewNote = serializeTimeMapSpanReview({ spanIndex, decision, reviewedAt });
  const retainedNotes = timeMap.evidence.notes.filter(
    (note) =>
      !note.startsWith(`${REVIEW_NOTE_PREFIX}${spanIndex}:`) &&
      !note.startsWith(`${PLAYBACK_REVIEW_PREFIX}${spanIndex}:`) &&
      !note.startsWith(`${LEGACY_PLAYBACK_REVIEW_PREFIX}${spanIndex}:`)
  );
  const evidence = {
    ...timeMap.evidence,
    types: appendUnique(timeMap.evidence.types, "manual"),
    notes: [...retainedNotes, reviewNote]
  };
  const reviewedMap: MediaTimeMap = {
    ...timeMap,
    revision: timeMap.revision + 1,
    spans,
    quality: {
      ...timeMap.quality,
      level: "blocked",
      reasons: uniqueStrings([
        ...timeMap.quality.reasons,
        `第 ${spanIndex + 1} 段已人工分类为“${TIME_MAP_SPAN_REVIEW_LABELS[decision]}”；分类会使该段旧播放证据失效，必须重新完成 A/B 复核。`
      ])
    },
    evidence,
    verification: null,
    updatedAt: reviewedAt
  };
  return reconcileCandidateTimeMapManualReview(readinessWithoutPlayback(reviewedMap));
}

export function reviewCandidateTimeMapSpan(
  project: EditorProject,
  timeMapId: string,
  spanIndex: number,
  decision: TimeMapSpanReviewDecision,
  reviewedAt: string
): EditorProject {
  const timeMap = project.mediaTimeMaps.find((item) => item.id === timeMapId);
  if (!timeMap) {
    throw new TimeMapSpanReviewError("候选时间图不存在，无法保存人工分类。");
  }
  const candidate = project.mediaMatchCandidates.find(
    (item) =>
      item.timeMapId === timeMapId && (item.state === "pending" || item.state === "blocked")
  );
  if (!candidate) {
    throw new TimeMapSpanReviewError("该时间图不再属于待复核候选，无法保存人工分类。");
  }
  const reviewedMap = applyTimeMapSpanReviewDecision(timeMap, spanIndex, decision, reviewedAt);
  const hasBoundAsset = project.danmakuSourceBindings.some(
    (binding) =>
      binding.sourceMediaId === candidate.sourceMediaId &&
      project.assets.some((asset) => asset.id === binding.assetId)
  );
  const reviewedProposalTimeMap = candidate.proposal.timeMap
    ? {
        ...candidate.proposal.timeMap,
        spans: structuredClone(reviewedMap.spans),
        quality: structuredClone(reviewedMap.quality),
        evidence: {
          ...candidate.proposal.timeMap.evidence,
          types: [...reviewedMap.evidence.types],
          audioAnchorCount: reviewedMap.evidence.audioAnchorCount,
          visualAnchorCount: reviewedMap.evidence.visualAnchorCount,
          heldOutAnchorCount: reviewedMap.evidence.heldOutAnchorCount,
          notes: [...reviewedMap.evidence.notes]
        }
      }
    : undefined;
  const reviewedCandidate = {
    ...candidate,
    state: hasBoundAsset && reviewedMap.quality.level !== "blocked" ? "pending" : "blocked",
    proposal: reviewedProposalTimeMap
      ? { ...candidate.proposal, timeMap: reviewedProposalTimeMap }
      : candidate.proposal,
    updatedAt: reviewedAt
  } satisfies typeof candidate;
  return {
    ...project,
    mediaMatchCandidates: project.mediaMatchCandidates.map((item) =>
      item.id === candidate.id ? reviewedCandidate : item
    ),
    mediaTimeMaps: project.mediaTimeMaps.map((item) =>
      item.id === timeMapId ? reviewedMap : item
    )
  };
}

export function readTimeMapSpanReviewDecision(
  timeMap: MediaTimeMap,
  spanIndex: number
): RecordedTimeMapSpanReview | null {
  return readReviewDecisionFromNotes(timeMap.evidence.notes, spanIndex);
}

export interface CandidateTimeMapManualReviewReadiness {
  timeMap: MediaTimeMap;
  playbackReviewedSpanIndexes: ReadonlySet<number>;
}

/**
 * 只有每一段都完成了与当前边界绑定的 A/B 播放，且所有差异段都有明确人工分类时，
 * blocked 候选才可降为 review。这里不修改算法指标，也不签发 verified。
 */
export function reconcileCandidateTimeMapManualReview(
  input: CandidateTimeMapManualReviewReadiness
): MediaTimeMap {
  const { timeMap, playbackReviewedSpanIndexes } = input;
  const validation = validateTimeMap(timeMap.spans);
  const issues: string[] = [];
  if (!validation.valid) {
    issues.push(validation.issues[0]?.message ?? "时间图结构无效。");
  }
  if (!timeMap.sourceIdentity || !timeMap.targetIdentity) {
    issues.push("源文件或目标文件缺少内容身份快照。");
  }
  timeMap.spans.forEach((span, spanIndex) => {
    if (!isCompleteTimeMapSpanEvidence(span)) {
      issues.push(`第 ${spanIndex + 1} 段缺少完整逐段证据。`);
      return;
    }
    if (
      span.quality.level === "blocked" ||
      span.quality.level === "legacy-unverified"
    ) {
      issues.push(`第 ${spanIndex + 1} 段仍为 ${span.quality.level}。`);
    }
    if (!playbackReviewedSpanIndexes.has(spanIndex)) {
      issues.push(`第 ${spanIndex + 1} 段尚未完成 A/B 播放复核。`);
    }
    const decision = readReviewDecisionFromNotes(timeMap.evidence.notes, spanIndex)?.decision;
    if (span.kind === "sourceOnly" && decision !== "source-extra") {
      issues.push(`第 ${spanIndex + 1} 段尚未确认为“参考多出”。`);
    } else if (span.kind === "targetOnly" && decision !== "target-extra") {
      issues.push(`第 ${spanIndex + 1} 段尚未确认为“原片多出”。`);
    } else if (span.kind === "ambiguous" && decision !== "replacement") {
      issues.push(`第 ${spanIndex + 1} 段仍未确认为“版本替换”。`);
    }
  });

  const retainedReasons = timeMap.quality.reasons.filter(
    (reason) => !reason.startsWith(MANUAL_REVIEW_STATE_REASON_PREFIX)
  );
  const stateReason =
    issues.length === 0
      ? `${MANUAL_REVIEW_STATE_REASON_PREFIX}全部 ${timeMap.spans.length} 段均已完成 A/B 播放与必要分类，可进入确认；算法质量指标保持原值。`
      : `${MANUAL_REVIEW_STATE_REASON_PREFIX}尚有 ${issues.length} 项未完成：${issues
          .slice(0, 3)
          .join("；")}${issues.length > 3 ? "；其余请逐段检查。" : ""}`;
  return {
    ...timeMap,
    quality: {
      ...timeMap.quality,
      level: issues.length === 0 ? "review" : "blocked",
      reasons: uniqueStrings([...retainedReasons, stateReason])
    }
  };
}

function readinessWithoutPlayback(
  timeMap: MediaTimeMap
): CandidateTimeMapManualReviewReadiness {
  return { timeMap, playbackReviewedSpanIndexes: new Set<number>() };
}

function readReviewDecisionFromNotes(
  notes: readonly string[],
  spanIndex: number
): RecordedTimeMapSpanReview | null {
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const parsed = parseTimeMapSpanReview(notes[index] ?? "");
    if (parsed?.spanIndex === spanIndex) {
      return parsed;
    }
  }
  return null;
}

function decisionToSpanKind(decision: TimeMapSpanReviewDecision): TimeMapSpanKind {
  if (decision === "source-extra") return "sourceOnly";
  if (decision === "target-extra") return "targetOnly";
  return "ambiguous";
}

function serializeTimeMapSpanReview(review: RecordedTimeMapSpanReview): string {
  return `${REVIEW_NOTE_PREFIX}${review.spanIndex}:${review.decision}:${review.reviewedAt}`;
}

function parseTimeMapSpanReview(note: string): RecordedTimeMapSpanReview | null {
  if (!note.startsWith(REVIEW_NOTE_PREFIX)) {
    return null;
  }
  const fields = note.slice(REVIEW_NOTE_PREFIX.length).split(":");
  if (fields.length < 4) {
    return null;
  }
  const spanIndex = Number(fields[0]);
  const decision = fields[1];
  const reviewedAt = fields.slice(2).join(":");
  if (
    !Number.isSafeInteger(spanIndex) ||
    spanIndex < 0 ||
    !isTimeMapSpanReviewDecision(decision) ||
    !isIsoTimestamp(reviewedAt)
  ) {
    return null;
  }
  return { spanIndex, decision, reviewedAt };
}

function isTimeMapSpanReviewDecision(value: string): value is TimeMapSpanReviewDecision {
  return (
    value === "source-extra" ||
    value === "target-extra" ||
    value === "replacement" ||
    value === "unresolved"
  );
}

function isIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function appendUnique<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
