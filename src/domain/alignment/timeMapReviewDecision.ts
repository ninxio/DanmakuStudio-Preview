import type { EditorProject, MediaTimeMap } from "../project/types";
import {
  assessTimeMapQuality,
  invalidateTimeMapSpanEvidenceForManualReview,
  isCompleteTimeMapSpanEvidence,
  normalizeLegacyUnverifiedTimeMapSpanEvidence,
  validateTimeMap,
  type TimeMapQualityInput,
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

export class TimeMapSpanReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeMapSpanReviewError";
  }
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
    (note) => !note.startsWith(`${REVIEW_NOTE_PREFIX}${spanIndex}:`)
  );
  const evidence = {
    ...timeMap.evidence,
    types: appendUnique(timeMap.evidence.types, "manual"),
    notes: [...retainedNotes, reviewNote]
  };
  const reviewReason = `第 ${spanIndex + 1} 段已人工分类为“${TIME_MAP_SPAN_REVIEW_LABELS[decision]}”；整张时间图仍需完成验证后才能导出。`;
  const hasUnresolvedAmbiguousSpan = spans.some(
    (current, index) =>
      current.kind === "ambiguous" &&
      readReviewDecisionFromNotes(evidence.notes, index)?.decision !== "replacement"
  );
  const hasBlockedSpanEvidence = spans.some(
    (current) => current.quality.level === "blocked"
  );
  const assessment = assessTimeMapQuality(
    toReviewQualityInput(timeMap, evidence.types, evidence.heldOutAnchorCount)
  );
  const persistentBlockers =
    timeMap.quality.level === "blocked"
      ? timeMap.quality.reasons.filter((reason) => !isReviewResolvableOrDerivedReason(reason))
      : [];
  const remainsBlocked =
    hasUnresolvedAmbiguousSpan ||
    hasBlockedSpanEvidence ||
    assessment.level === "blocked" ||
    persistentBlockers.length > 0;
  const reasons = uniqueStrings([
    ...persistentBlockers,
    reviewReason,
    ...assessment.reasons,
    ...(hasUnresolvedAmbiguousSpan
      ? ["仍有尚未分类或被标记为“无法判断”的 ambiguous 分段，继续阻断候选确认。"]
      : []),
    ...(hasBlockedSpanEvidence
      ? ["仍有逐段质量为 blocked 的分段，必须分别处理后才能解除阻断。"]
      : [])
  ]);
  return {
    ...timeMap,
    revision: timeMap.revision + 1,
    spans,
    quality: {
      ...timeMap.quality,
      level: remainsBlocked ? "blocked" : "review",
      // 这是原算法经金标准校准的测量值；人工分类不会把它当作人工结论概率，
      // 但也不应抹掉后续中央签发门槛所需的原始校准证据。
      probability: timeMap.quality.probability,
      reasons
    },
    evidence,
    verification: null,
    updatedAt: reviewedAt
  };
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

function toReviewQualityInput(
  timeMap: MediaTimeMap,
  evidenceTypes: MediaTimeMap["evidence"]["types"],
  evidenceHeldOutAnchorCount: number
): TimeMapQualityInput {
  return {
    probability: timeMap.quality.probability,
    metricSource: timeMap.quality.metricSource,
    coverage: timeMap.quality.coverage,
    uniqueContentCoverage: timeMap.quality.uniqueContentCoverage,
    p50ResidualMs: timeMap.quality.p50ResidualMs,
    p95ResidualMs: timeMap.quality.p95ResidualMs,
    p99ResidualMs: timeMap.quality.p99ResidualMs,
    maxResidualMs: timeMap.quality.maxResidualMs,
    boundaryUncertaintyMs: timeMap.quality.boundaryUncertaintyMs,
    alternativeMargin: timeMap.quality.alternativeMargin,
    anchorCount: timeMap.quality.anchorCount,
    anchorRegionCount: timeMap.quality.anchorRegionCount,
    heldOutAnchorCount: timeMap.quality.heldOutAnchorCount,
    evidenceTypes,
    audioAnchorCount: timeMap.evidence.audioAnchorCount,
    visualAnchorCount: timeMap.evidence.visualAnchorCount,
    evidenceHeldOutAnchorCount,
    sourceStreamType: timeMap.sourceStream?.type ?? null,
    targetStreamType: timeMap.targetStream?.type ?? null
  };
}

function isReviewResolvableOrDerivedReason(reason: string): boolean {
  return (
    /无法唯一解释的歧义区间|ambiguous steps?/iu.test(reason) ||
    reason.includes("已人工分类为") ||
    reason.includes("仍有尚未分类") ||
    reason.includes("质量指标不完整") ||
    reason.includes("映射尚未达到已验证门槛") ||
    reason.includes("指标可用于复核") ||
    reason.includes("只有单一主要证据") ||
    reason.includes("金标准校准概率低于") ||
    reason.includes("完整实测指标和独立证据") ||
    reason.includes("保留外部的保守质量声明") ||
    reason.includes("逐段质量为 blocked") ||
    reason.includes("Pairwise 时间图已被质量闸门阻断，未进入全局组合")
  );
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
