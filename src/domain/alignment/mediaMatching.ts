import type { AlignmentProposal, CutCandidate } from "./types";
import { createDanmakuSourceSegment } from "../project/sourceTimeline";
import type {
  EditorProject,
  MediaMatchCandidate,
  ProjectMediaReference,
  SegmentTimingRule
} from "../project/types";
import type { Milliseconds } from "../shared/time";

export interface CreateMediaMatchCandidateInput {
  id: string;
  batchId: string;
  sourceMediaId: string;
  targetMediaId: string;
  proposal: AlignmentProposal;
}

export interface MediaMatchRangePatch {
  sourceStartMs?: Milliseconds;
  sourceEndMs?: Milliseconds;
  targetStartMs?: Milliseconds;
  targetEndMs?: Milliseconds;
}

type MediaMatchProjectContext = Pick<
  EditorProject,
  "assets" | "mediaLibrary" | "danmakuSourceBindings"
>;

/**
 * 把带 matchRange 的单素材对齐提案转成可持久化的媒体级候选。
 * 提案和段内规则 ID 会进入候选命名空间，避免批量任务之间发生碰撞。
 */
export function createMediaMatchCandidate(
  project: MediaMatchProjectContext,
  input: CreateMediaMatchCandidateInput,
  timestamp = new Date().toISOString()
): MediaMatchCandidate {
  const id = requireIdentifier(input.id, "匹配候选 ID");
  const batchId = requireIdentifier(input.batchId, "匹配批次 ID");
  const sourceMediaId = requireIdentifier(input.sourceMediaId, "参考素材 ID");
  const targetMediaId = requireIdentifier(input.targetMediaId, "目标原片 ID");
  if (sourceMediaId === targetMediaId) {
    throw new Error("参考素材和目标原片不能是同一个媒体记录。");
  }
  const { source, target } = requireMediaPair(
    project.mediaLibrary,
    sourceMediaId,
    targetMediaId
  );
  const range = input.proposal.matchRange;
  if (!range) {
    throw new Error("对齐提案缺少 matchRange，无法创建媒体匹配候选。");
  }
  validateMediaMatchRange(range, source, target);
  validateProposalItemsInRange(input.proposal, range);

  const proposal = namespaceProposal(input.proposal, id);
  const timingRules = createTimingRules(
    proposal.cutCandidates,
    id,
    range.sourceStartMs,
    range.sourceEndMs
  );
  const hasBoundAsset = project.danmakuSourceBindings.some(
    (binding) =>
      binding.sourceMediaId === sourceMediaId &&
      project.assets.some((asset) => asset.id === binding.assetId)
  );
  return {
    id,
    batchId,
    sourceMediaId,
    targetMediaId,
    sourceStartMs: range.sourceStartMs,
    sourceEndMs: range.sourceEndMs,
    targetStartMs: range.targetStartMs,
    targetEndMs: range.targetEndMs,
    timingRules,
    confidence: proposal.confidence,
    proposal,
    state: hasBoundAsset ? "pending" : "blocked",
    appliedSegmentIds: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

/** 更新待复核候选的区间；接受或拒绝后的候选不可静默改写。 */
export function updateMediaMatchCandidateRange(
  project: EditorProject,
  candidateId: string,
  patch: MediaMatchRangePatch,
  timestamp = new Date().toISOString()
): EditorProject {
  const candidate = requireCandidate(project, candidateId);
  if (candidate.state === "accepted" || candidate.state === "rejected") {
    throw new Error(
      candidate.state === "accepted"
        ? "已接受的匹配候选不能修改区间。"
        : "已拒绝的匹配候选不能修改区间。"
    );
  }
  const { source, target } = requireMediaPair(
    project.mediaLibrary,
    candidate.sourceMediaId,
    candidate.targetMediaId
  );
  const range = {
    sourceStartMs: patch.sourceStartMs ?? candidate.sourceStartMs,
    sourceEndMs: patch.sourceEndMs ?? candidate.sourceEndMs,
    targetStartMs: patch.targetStartMs ?? candidate.targetStartMs,
    targetEndMs: patch.targetEndMs ?? candidate.targetEndMs,
    coverage: candidate.proposal.matchRange?.coverage ?? candidate.confidence
  };
  const sourceTranslationMs = getWholeRangeTranslation(
    candidate.sourceStartMs,
    candidate.sourceEndMs,
    patch.sourceStartMs,
    patch.sourceEndMs
  );
  const targetTranslationMs = getWholeRangeTranslation(
    candidate.targetStartMs,
    candidate.targetEndMs,
    patch.targetStartMs,
    patch.targetEndMs
  );
  const translatedProposal = translateProposalCoordinates(
    candidate.proposal,
    sourceTranslationMs,
    targetTranslationMs
  );
  const adjustedProposal = clipProposalToRange(translatedProposal, range);
  const adjustedTimingRules = candidate.timingRules
    .map((rule) => ({
      ...rule,
      sourceAtMs: rule.sourceAtMs + sourceTranslationMs
    }))
    .filter(
      (rule) => rule.sourceAtMs >= range.sourceStartMs && rule.sourceAtMs < range.sourceEndMs
    );
  validateMediaMatchRange(range, source, target);
  validateTimingRulesInRange(adjustedTimingRules, range.sourceStartMs, range.sourceEndMs);
  validateProposalItemsInRange(adjustedProposal, range);
  const hasBoundAsset = project.danmakuSourceBindings.some(
    (binding) =>
      binding.sourceMediaId === candidate.sourceMediaId &&
      project.assets.some((asset) => asset.id === binding.assetId)
  );
  const updated: MediaMatchCandidate = {
    ...candidate,
    sourceStartMs: range.sourceStartMs,
    sourceEndMs: range.sourceEndMs,
    targetStartMs: range.targetStartMs,
    targetEndMs: range.targetEndMs,
    timingRules: adjustedTimingRules,
    proposal: {
      ...adjustedProposal,
      matchRange: range
    },
    state: hasBoundAsset ? "pending" : "blocked",
    updatedAt: timestamp
  };
  return replaceCandidate(project, updated);
}

/**
 * 清理匹配候选与已应用来源段之间的派生引用。
 * 已应用段全部失效时，候选回到可复核状态；媒体已删除时，候选本身也随之移除。
 */
export function reconcileMediaMatchCandidates(
  project: EditorProject,
  timestamp = new Date().toISOString()
): EditorProject {
  const mediaIds = new Set(project.mediaLibrary.map((media) => media.id));
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const bindingsByAssetId = new Map(
    project.danmakuSourceBindings.map((binding) => [binding.assetId, binding])
  );
  const segmentsById = new Map(
    project.danmakuSourceSegments.map((segment) => [segment.id, segment])
  );
  let changed = false;
  const mediaMatchCandidates = project.mediaMatchCandidates.flatMap((candidate) => {
    if (!mediaIds.has(candidate.sourceMediaId) || !mediaIds.has(candidate.targetMediaId)) {
      changed = true;
      return [];
    }
    const appliedSegmentIds = candidate.appliedSegmentIds.filter((segmentId) => {
      const segment = segmentsById.get(segmentId);
      if (!segment || segment.kind !== "content" || !segment.assetId) {
        return false;
      }
      const binding = bindingsByAssetId.get(segment.assetId);
      return (
        assetsById.has(segment.assetId) &&
        binding?.sourceMediaId === candidate.sourceMediaId &&
        segmentId === createAppliedSegmentId(candidate.id, segment.assetId) &&
        segment.sourceMediaId === candidate.sourceMediaId &&
        segment.targetMediaId === candidate.targetMediaId
      );
    });
    const hasBoundAsset = project.danmakuSourceBindings.some(
      (binding) =>
        binding.sourceMediaId === candidate.sourceMediaId && assetsById.has(binding.assetId)
    );
    const state: MediaMatchCandidate["state"] =
      candidate.state === "rejected"
        ? "rejected"
        : appliedSegmentIds.length > 0
          ? "accepted"
          : hasBoundAsset
            ? "pending"
            : "blocked";
    const normalizedAppliedSegmentIds = state === "accepted" ? appliedSegmentIds : [];
    if (
      state === candidate.state &&
      normalizedAppliedSegmentIds.length === candidate.appliedSegmentIds.length &&
      normalizedAppliedSegmentIds.every(
        (id, index) => id === candidate.appliedSegmentIds[index]
      )
    ) {
      return [candidate];
    }
    changed = true;
    return [
      {
        ...candidate,
        state,
        appliedSegmentIds: normalizedAppliedSegmentIds,
        updatedAt: timestamp
      }
    ];
  });
  return changed ? { ...project, mediaMatchCandidates } : project;
}

/** 拒绝待复核候选；不会修改任何已确认来源段。 */
export function rejectMediaMatchCandidate(
  project: EditorProject,
  candidateId: string,
  timestamp = new Date().toISOString()
): EditorProject {
  const candidate = requireCandidate(project, candidateId);
  if (candidate.state === "accepted") {
    throw new Error("已接受的匹配候选不能直接拒绝，请先删除对应来源段。");
  }
  if (candidate.state === "rejected") {
    return project;
  }
  return replaceCandidate(project, {
    ...candidate,
    state: "rejected",
    appliedSegmentIds: [],
    updatedAt: timestamp
  });
}

/** 撤销已确认候选，只删除该候选生成的来源段，并把候选恢复为待复核或阻塞状态。 */
export function revokeMediaMatchCandidateAcceptance(
  project: EditorProject,
  candidateId: string,
  timestamp = new Date().toISOString()
): EditorProject {
  const candidate = requireCandidate(project, candidateId);
  if (candidate.state !== "accepted") {
    throw new Error("只有已确认的匹配候选可以撤销确认。");
  }
  const appliedSegmentIds = new Set(candidate.appliedSegmentIds);
  return reconcileMediaMatchCandidates(
    {
      ...project,
      danmakuSourceSegments: project.danmakuSourceSegments.filter(
        (segment) => !appliedSegmentIds.has(segment.id)
      )
    },
    timestamp
  );
}

/**
 * 接受媒体级候选，并仅为用户选中的、确实绑定到该参考素材的 XML 创建来源段。
 * 确定性 segment ID 让重复接受保持幂等；本函数不会写入全局 anchors/cutMarkers。
 */
export function acceptMediaMatchCandidate(
  project: EditorProject,
  candidateId: string,
  assetIds: readonly string[],
  timestamp = new Date().toISOString()
): EditorProject {
  const candidate = requireCandidate(project, candidateId);
  if (candidate.state === "rejected") {
    throw new Error("已拒绝的匹配候选不能直接接受。");
  }
  const { target } = requireMediaPair(
    project.mediaLibrary,
    candidate.sourceMediaId,
    candidate.targetMediaId
  );
  validateCandidateRange(candidate, project.mediaLibrary);
  const selectedAssetIds = [
    ...new Set(assetIds.map((assetId) => assetId.trim()).filter(Boolean))
  ];
  if (selectedAssetIds.length === 0) {
    throw new Error("请至少选择一个绑定到该参考素材的 XML。");
  }
  const selectedAssets = selectedAssetIds.map((assetId) => {
    const asset = project.assets.find((candidateAsset) => candidateAsset.id === assetId);
    if (!asset) {
      throw new Error(`XML 资源不存在：${assetId}`);
    }
    const binding = project.danmakuSourceBindings.find((item) => item.assetId === assetId);
    if (!binding) {
      throw new Error(`${asset.fileName} 尚未绑定 B 站参考素材。`);
    }
    if (binding.sourceMediaId !== candidate.sourceMediaId) {
      throw new Error(`${asset.fileName} 绑定的参考素材与当前匹配候选不一致。`);
    }
    return asset;
  });

  const segments = [...project.danmakuSourceSegments];
  const appliedSegmentIds = new Set(candidate.appliedSegmentIds);
  for (const asset of selectedAssets) {
    const segmentId = createAppliedSegmentId(candidate.id, asset.id);
    const existing = segments.find((segment) => segment.id === segmentId);
    if (existing) {
      if (!isSegmentForCandidate(existing, candidate, asset.id)) {
        throw new Error(`来源段 ID 冲突：${segmentId}`);
      }
      appliedSegmentIds.add(segmentId);
      continue;
    }
    const overlappingSegment = segments.find(
      (segment) =>
        segment.assetId === asset.id &&
        segment.sourceMediaId === candidate.sourceMediaId &&
        segment.sourceStartMs < candidate.sourceEndMs &&
        candidate.sourceStartMs < segment.sourceEndMs &&
        (segment.kind === "ignored" || segment.targetMediaId === candidate.targetMediaId)
    );
    if (overlappingSegment) {
      throw new Error(
        `${asset.fileName} 已有与当前候选范围冲突的来源段“${overlappingSegment.label}”，不能重复确认。`
      );
    }
    segments.push(
      createDanmakuSourceSegment(
        segmentId,
        {
          label: createAppliedSegmentLabel(target, asset.fileName),
          kind: "content",
          assetId: asset.id,
          sourceMediaId: candidate.sourceMediaId,
          sourceStartMs: candidate.sourceStartMs,
          sourceEndMs: candidate.sourceEndMs,
          targetMediaId: candidate.targetMediaId,
          targetStartMs: candidate.targetStartMs,
          timingRules: candidate.timingRules,
          episodeKey: target.episodeKey,
          episodeLabel: target.episodeLabel,
          note: `由媒体匹配候选 ${candidate.id} 确认`
        },
        timestamp
      )
    );
    appliedSegmentIds.add(segmentId);
  }

  const updatedCandidate: MediaMatchCandidate = {
    ...candidate,
    state: "accepted",
    appliedSegmentIds: [...appliedSegmentIds],
    updatedAt:
      candidate.state === "accepted" &&
      selectedAssets.every((asset) =>
        candidate.appliedSegmentIds.includes(createAppliedSegmentId(candidate.id, asset.id))
      )
        ? candidate.updatedAt
        : timestamp
  };
  const nextProject = replaceCandidate(project, updatedCandidate);
  if (segments.length === project.danmakuSourceSegments.length && nextProject === project) {
    return project;
  }
  return {
    ...nextProject,
    danmakuSourceSegments: segments
  };
}

export function createAppliedSegmentId(candidateId: string, assetId: string): string {
  return `${candidateId}:segment:${assetId}`;
}

function getWholeRangeTranslation(
  previousStartMs: Milliseconds,
  previousEndMs: Milliseconds,
  nextStartMs: Milliseconds | undefined,
  nextEndMs: Milliseconds | undefined
): Milliseconds {
  if (nextStartMs === undefined || nextEndMs === undefined) {
    return 0;
  }
  const startDeltaMs = nextStartMs - previousStartMs;
  return nextEndMs - previousEndMs === startDeltaMs ? startDeltaMs : 0;
}

function translateProposalCoordinates(
  proposal: AlignmentProposal,
  sourceDeltaMs: Milliseconds,
  targetDeltaMs: Milliseconds
): AlignmentProposal {
  if (sourceDeltaMs === 0 && targetDeltaMs === 0) {
    return proposal;
  }
  return {
    ...proposal,
    anchors: proposal.anchors.map((anchor) => ({
      ...anchor,
      sourceMs: anchor.sourceMs + sourceDeltaMs,
      targetMs: anchor.targetMs + targetDeltaMs
    })),
    cutCandidates: proposal.cutCandidates.map((cut) => ({
      ...cut,
      sourceAtMs: cut.sourceAtMs + sourceDeltaMs,
      sourceRangeStartMs:
        cut.sourceRangeStartMs === undefined
          ? undefined
          : cut.sourceRangeStartMs + sourceDeltaMs,
      sourceRangeEndMs:
        cut.sourceRangeEndMs === undefined ? undefined : cut.sourceRangeEndMs + sourceDeltaMs
    }))
  };
}

function clipProposalToRange(
  proposal: AlignmentProposal,
  range: {
    sourceStartMs: Milliseconds;
    sourceEndMs: Milliseconds;
    targetStartMs: Milliseconds;
    targetEndMs: Milliseconds;
  }
): AlignmentProposal {
  const anchors = proposal.anchors.filter(
    (anchor) =>
      anchor.sourceMs >= range.sourceStartMs &&
      anchor.sourceMs < range.sourceEndMs &&
      anchor.targetMs >= range.targetStartMs &&
      anchor.targetMs < range.targetEndMs
  );
  const cutCandidates = proposal.cutCandidates
    .filter(
      (cut) => cut.sourceAtMs >= range.sourceStartMs && cut.sourceAtMs < range.sourceEndMs
    )
    .map((cut) => ({
      ...cut,
      sourceRangeStartMs:
        cut.sourceRangeStartMs === undefined
          ? undefined
          : Math.min(cut.sourceAtMs, Math.max(range.sourceStartMs, cut.sourceRangeStartMs)),
      sourceRangeEndMs:
        cut.sourceRangeEndMs === undefined
          ? undefined
          : Math.max(cut.sourceAtMs, Math.min(range.sourceEndMs, cut.sourceRangeEndMs))
    }));
  const removedCount =
    proposal.anchors.length -
    anchors.length +
    proposal.cutCandidates.length -
    cutCandidates.length;
  return {
    ...proposal,
    anchors,
    cutCandidates,
    diagnostics:
      removedCount > 0
        ? [...proposal.diagnostics, `人工调整范围后排除了 ${removedCount} 条范围外匹配证据。`]
        : proposal.diagnostics
  };
}

function namespaceProposal(
  proposal: AlignmentProposal,
  candidateId: string
): AlignmentProposal {
  const cloned = structuredClone(proposal);
  return {
    ...cloned,
    anchors: cloned.anchors.map((anchor, index) => ({
      ...anchor,
      id: createNamespacedId(candidateId, "anchor", anchor.id, index)
    })),
    cutCandidates: cloned.cutCandidates.map((cut, index) => ({
      ...cut,
      id: createNamespacedId(candidateId, "cut", cut.id, index)
    }))
  };
}

function createTimingRules(
  cuts: readonly CutCandidate[],
  candidateId: string,
  sourceStartMs: Milliseconds,
  sourceEndMs: Milliseconds
): SegmentTimingRule[] {
  const rules = cuts.map((cut, index) => ({
    id: createNamespacedId(candidateId, "rule", cut.id, index),
    sourceAtMs: cut.sourceAtMs,
    gapMs: cut.targetGapMs,
    note: cut.note
  }));
  validateTimingRulesInRange(rules, sourceStartMs, sourceEndMs);
  return rules.sort(
    (left, right) => left.sourceAtMs - right.sourceAtMs || left.id.localeCompare(right.id)
  );
}

function createNamespacedId(
  candidateId: string,
  kind: string,
  originalId: string,
  index: number
): string {
  return `${candidateId}:${kind}:${index}:${originalId}`;
}

function validateCandidateRange(
  candidate: MediaMatchCandidate,
  mediaLibrary: readonly ProjectMediaReference[]
): void {
  const { source, target } = requireMediaPair(
    mediaLibrary,
    candidate.sourceMediaId,
    candidate.targetMediaId
  );
  validateMediaMatchRange(candidate, source, target);
  validateTimingRulesInRange(
    candidate.timingRules,
    candidate.sourceStartMs,
    candidate.sourceEndMs
  );
}

function validateMediaMatchRange(
  range: {
    sourceStartMs: Milliseconds;
    sourceEndMs: Milliseconds;
    targetStartMs: Milliseconds;
    targetEndMs: Milliseconds;
    coverage?: number;
  },
  source: ProjectMediaReference,
  target: ProjectMediaReference
): void {
  validateHalfOpenRange(range.sourceStartMs, range.sourceEndMs, "参考素材匹配区间");
  validateHalfOpenRange(range.targetStartMs, range.targetEndMs, "目标原片匹配区间");
  if (
    range.coverage !== undefined &&
    (!Number.isFinite(range.coverage) || range.coverage < 0 || range.coverage > 1)
  ) {
    throw new Error("匹配覆盖率必须位于 0 到 1 之间。");
  }
  if (source.durationMs !== null && range.sourceEndMs > source.durationMs) {
    throw new Error("参考素材匹配区间超出素材已知时长。");
  }
  if (target.durationMs !== null && range.targetEndMs > target.durationMs) {
    throw new Error("目标原片匹配区间超出素材已知时长。");
  }
}

function validateHalfOpenRange(
  startMs: Milliseconds,
  endMs: Milliseconds,
  label: string
): void {
  if (
    !Number.isSafeInteger(startMs) ||
    startMs < 0 ||
    !Number.isSafeInteger(endMs) ||
    endMs <= startMs
  ) {
    throw new Error(`${label}无效，必须是开始早于结束的非负整数毫秒半开区间。`);
  }
}

function validateTimingRulesInRange(
  rules: readonly SegmentTimingRule[],
  sourceStartMs: Milliseconds,
  sourceEndMs: Milliseconds
): void {
  const ids = new Set<string>();
  for (const rule of rules) {
    if (rule.id.trim().length === 0 || ids.has(rule.id)) {
      throw new Error("段内删减修正规则 ID 为空或重复。");
    }
    ids.add(rule.id);
    if (
      !Number.isSafeInteger(rule.sourceAtMs) ||
      rule.sourceAtMs < sourceStartMs ||
      rule.sourceAtMs >= sourceEndMs
    ) {
      throw new Error("段内删减修正点必须位于参考素材匹配区间内。");
    }
    if (!Number.isSafeInteger(rule.gapMs)) {
      throw new Error("段内删减修正时长必须是整数毫秒。");
    }
  }
}

function validateProposalItemsInRange(
  proposal: AlignmentProposal,
  range: {
    sourceStartMs: Milliseconds;
    sourceEndMs: Milliseconds;
    targetStartMs: Milliseconds;
    targetEndMs: Milliseconds;
  }
): void {
  for (const anchor of proposal.anchors) {
    if (
      !Number.isSafeInteger(anchor.sourceMs) ||
      anchor.sourceMs < range.sourceStartMs ||
      anchor.sourceMs >= range.sourceEndMs ||
      !Number.isSafeInteger(anchor.targetMs) ||
      anchor.targetMs < range.targetStartMs ||
      anchor.targetMs >= range.targetEndMs
    ) {
      throw new Error("对齐提案中的同步锚点超出 matchRange。");
    }
  }
  for (const cut of proposal.cutCandidates) {
    if (
      !Number.isSafeInteger(cut.sourceAtMs) ||
      cut.sourceAtMs < range.sourceStartMs ||
      cut.sourceAtMs >= range.sourceEndMs
    ) {
      throw new Error("对齐提案中的版本差异候选超出 matchRange。");
    }
    if (
      cut.sourceRangeStartMs !== undefined &&
      (!Number.isSafeInteger(cut.sourceRangeStartMs) ||
        cut.sourceRangeStartMs < range.sourceStartMs)
    ) {
      throw new Error("版本差异候选的不确定区间超出 matchRange。");
    }
    if (
      cut.sourceRangeEndMs !== undefined &&
      (!Number.isSafeInteger(cut.sourceRangeEndMs) || cut.sourceRangeEndMs > range.sourceEndMs)
    ) {
      throw new Error("版本差异候选的不确定区间超出 matchRange。");
    }
    if (
      cut.sourceRangeStartMs !== undefined &&
      cut.sourceRangeEndMs !== undefined &&
      cut.sourceRangeEndMs <= cut.sourceRangeStartMs
    ) {
      throw new Error("版本差异候选的不确定区间无效。");
    }
  }
}

function requireMediaPair(
  mediaLibrary: readonly ProjectMediaReference[],
  sourceMediaId: string,
  targetMediaId: string
): { source: ProjectMediaReference; target: ProjectMediaReference } {
  const source = mediaLibrary.find((media) => media.id === sourceMediaId);
  if (!source) {
    throw new Error("匹配候选引用的 B 站参考素材不存在。");
  }
  if (source.role !== "bilibiliReference") {
    throw new Error("匹配候选的来源必须是 B 站参考素材。");
  }
  const target = mediaLibrary.find((media) => media.id === targetMediaId);
  if (!target) {
    throw new Error("匹配候选引用的目标原片不存在。");
  }
  if (target.role !== "targetOriginal") {
    throw new Error("匹配候选的目标必须是原片素材。");
  }
  return { source, target };
}

function requireCandidate(project: EditorProject, candidateId: string): MediaMatchCandidate {
  const candidate = project.mediaMatchCandidates.find((item) => item.id === candidateId);
  if (!candidate) {
    throw new Error("媒体匹配候选不存在。");
  }
  return candidate;
}

function replaceCandidate(
  project: EditorProject,
  candidate: MediaMatchCandidate
): EditorProject {
  const existing = project.mediaMatchCandidates.find((item) => item.id === candidate.id);
  if (existing === candidate) {
    return project;
  }
  return {
    ...project,
    mediaMatchCandidates: project.mediaMatchCandidates.map((item) =>
      item.id === candidate.id ? candidate : item
    )
  };
}

function isSegmentForCandidate(
  segment: EditorProject["danmakuSourceSegments"][number],
  candidate: MediaMatchCandidate,
  assetId: string
): boolean {
  return (
    segment.kind === "content" &&
    segment.assetId === assetId &&
    segment.sourceMediaId === candidate.sourceMediaId &&
    segment.sourceStartMs === candidate.sourceStartMs &&
    segment.sourceEndMs === candidate.sourceEndMs &&
    segment.targetMediaId === candidate.targetMediaId &&
    (segment.targetStartMs ?? 0) === candidate.targetStartMs &&
    areTimingRulesEqual(segment.timingRules, candidate.timingRules)
  );
}

function areTimingRulesEqual(
  left: readonly SegmentTimingRule[],
  right: readonly SegmentTimingRule[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (rule, index) =>
        rule.id === right[index]?.id &&
        rule.sourceAtMs === right[index]?.sourceAtMs &&
        rule.gapMs === right[index]?.gapMs &&
        rule.note === right[index]?.note
    )
  );
}

function createAppliedSegmentLabel(
  target: ProjectMediaReference,
  assetFileName: string
): string {
  const targetLabel = target.episodeLabel?.trim() || target.name.trim() || target.fileName;
  return `${targetLabel} · ${assetFileName}`;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label}不能为空。`);
  }
  return normalized;
}
