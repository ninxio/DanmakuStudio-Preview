import type { DanmakuItem } from "../danmaku/types";
import type {
  DanmakuSourceSegment,
  EditorProject,
  ProjectMediaReference,
  SegmentTimingRule
} from "../project/types";
import type { Milliseconds } from "../shared/time";

/**
 * 来源段投影：把"B 站参考时间轴上的弹幕"投影到"目标原片时间轴"。
 *
 * 坐标系说明：
 * - 输入时间：弹幕 XML 原始时间（即 B 站参考素材时间轴，二者强关联）。
 * - 输出时间：目标原片时间轴。
 *
 * 投影规则（针对每个 content 来源段）：
 *   targetTime = (itemSourceTime - segment.sourceStartMs)
 *              + (segment.targetStartMs ?? 0)
 *              + Σ gapMs（所有 sourceAtMs <= itemSourceTime 的段内删减修正规则）
 *              + itemTimeAdjustment（单条弹幕非破坏性调整）
 *
 * ignored 段内的弹幕不投影；未被任何段覆盖的弹幕计入 unmappedItemCount。
 * 本模块不修改原始 XML 数据，仅产出投影结果。
 */

export interface ProjectionEntry {
  item: DanmakuItem;
  finalTimeMs: Milliseconds;
  segmentId: string;
}

export interface ProjectionAppliedRule {
  segmentId: string;
  segmentLabel: string;
  ruleId: string;
  sourceAtMs: Milliseconds;
  gapMs: Milliseconds;
  affectedCount: number;
  note: string;
}

export interface TargetProjectionGroup {
  targetMediaId: string;
  targetName: string;
  targetFileName: string;
  episodeLabel: string | null;
  exportFileName: string;
  segments: DanmakuSourceSegment[];
  entries: ProjectionEntry[];
  disabledCount: number;
  appliedRules: ProjectionAppliedRule[];
  warnings: string[];
}

export type ProjectionIssueSeverity = "warning" | "error";

export interface ProjectionIssue {
  id: string;
  severity: ProjectionIssueSeverity;
  segmentId: string | null;
  message: string;
}

export type SourceProjectionStatus = "empty" | "blocked" | "ready" | "readyWithWarnings";

export interface SourceProjectionResult {
  status: SourceProjectionStatus;
  groups: TargetProjectionGroup[];
  issues: ProjectionIssue[];
  contentSegmentCount: number;
  ignoredSegmentCount: number;
  projectedItemCount: number;
  ignoredItemCount: number;
  unmappedItemCount: number;
}

export function projectDanmakuToTargets(project: EditorProject): SourceProjectionResult {
  const issues: ProjectionIssue[] = [];
  const mediaById = new Map(project.mediaLibrary.map((media) => [media.id, media]));
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const sourceBindingByAssetId = new Map(
    project.danmakuSourceBindings.map((binding) => [binding.assetId, binding.sourceMediaId])
  );
  const disabled = new Set(project.disabledItemIds);

  const contentSegments = project.danmakuSourceSegments.filter(
    (segment) => segment.kind === "content"
  );
  const ignoredSegments = project.danmakuSourceSegments.filter(
    (segment) => segment.kind === "ignored"
  );

  if (contentSegments.length === 0) {
    return {
      status: "empty",
      groups: [],
      issues: [
        {
          id: "no-content-segments",
          severity: "warning",
          segmentId: null,
          message: "还没有可投影的正片来源段。请先在匹配页标出参考视频与原片的对应关系。"
        }
      ],
      contentSegmentCount: 0,
      ignoredSegmentCount: ignoredSegments.length,
      projectedItemCount: 0,
      ignoredItemCount: 0,
      unmappedItemCount: project.assets.reduce((count, asset) => count + asset.items.length, 0)
    };
  }

  const overlappingSegmentIds = new Set<string>();
  findOverlappingProjectionSegments([...contentSegments, ...ignoredSegments]).forEach(
    ([left, right]) => {
      overlappingSegmentIds.add(left.id);
      overlappingSegmentIds.add(right.id);
      issues.push({
        id: `segment-overlap-${left.id}-${right.id}`,
        severity: "error",
        segmentId: right.id,
        message: `${left.label} 与 ${right.label} 的来源范围冲突，继续投影会产生重复弹幕或覆盖已标记的忽略范围。`
      });
    }
  );

  const usableSegments: DanmakuSourceSegment[] = [];
  for (const segment of contentSegments) {
    if (overlappingSegmentIds.has(segment.id)) {
      continue;
    }
    const problem = findSegmentBlocker(segment, assetsById, mediaById, sourceBindingByAssetId);
    if (problem) {
      issues.push({
        id: `segment-blocked-${segment.id}`,
        severity: "error",
        segmentId: segment.id,
        message: problem
      });
      continue;
    }
    usableSegments.push(segment);
  }

  const usableIgnoredSegments: DanmakuSourceSegment[] = [];
  for (const segment of ignoredSegments) {
    const problem = findSourceSegmentBlocker(
      segment,
      assetsById,
      mediaById,
      sourceBindingByAssetId
    );
    if (problem) {
      issues.push({
        id: `ignored-segment-blocked-${segment.id}`,
        severity: "error",
        segmentId: segment.id,
        message: problem
      });
      continue;
    }
    if (!overlappingSegmentIds.has(segment.id)) {
      usableIgnoredSegments.push(segment);
    }
  }

  const groupsByTarget = new Map<string, TargetProjectionGroup>();
  let projectedItemCount = 0;
  let disabledTotal = 0;

  for (const segment of usableSegments) {
    const asset = assetsById.get(segment.assetId as string);
    const target = mediaById.get(segment.targetMediaId as string);
    if (!asset || !target) {
      continue;
    }
    const group = ensureGroup(groupsByTarget, target);
    group.segments.push(segment);

    const sortedRules = [...segment.timingRules].sort(
      (left, right) => left.sourceAtMs - right.sourceAtMs
    );
    const ruleHits = new Map<string, number>();
    let disabledCount = 0;

    for (const item of asset.items) {
      if (
        item.sourceTimeMs < segment.sourceStartMs ||
        item.sourceTimeMs >= segment.sourceEndMs
      ) {
        continue;
      }
      if (!item.enabled || disabled.has(item.id)) {
        disabledCount += 1;
        continue;
      }
      const gapMs = accumulateGap(sortedRules, item.sourceTimeMs, ruleHits);
      const adjustmentMs = project.itemTimeAdjustments[item.id] ?? 0;
      const finalTimeMs =
        item.sourceTimeMs -
        segment.sourceStartMs +
        (segment.targetStartMs ?? 0) +
        gapMs +
        adjustmentMs;
      group.entries.push({ item, finalTimeMs, segmentId: segment.id });
      projectedItemCount += 1;
    }

    group.disabledCount += disabledCount;
    disabledTotal += disabledCount;
    for (const rule of sortedRules) {
      group.appliedRules.push({
        segmentId: segment.id,
        segmentLabel: segment.label,
        ruleId: rule.id,
        sourceAtMs: rule.sourceAtMs,
        gapMs: rule.gapMs,
        affectedCount: ruleHits.get(rule.id) ?? 0,
        note: rule.note
      });
    }
  }

  const groups = Array.from(groupsByTarget.values());
  ensureUniqueExportFileNames(groups);
  for (const group of groups) {
    group.entries.sort(
      (left, right) =>
        left.finalTimeMs - right.finalTimeMs ||
        left.item.originalIndex - right.item.originalIndex
    );
    if (group.entries.length === 0) {
      group.warnings.push(`${group.targetName} 的来源段内没有可导出的弹幕。`);
      issues.push({
        id: `target-empty-${group.targetMediaId}`,
        severity: "warning",
        segmentId: null,
        message: `${group.targetName} 的来源段内没有可导出的弹幕。`
      });
    }
    const negativeCount = group.entries.filter((entry) => entry.finalTimeMs < 0).length;
    if (negativeCount > 0) {
      group.warnings.push(`${negativeCount} 条弹幕投影后时间为负，导出时会被限制为 0。`);
    }
    const targetDurationMs = mediaById.get(group.targetMediaId)?.durationMs ?? null;
    if (targetDurationMs !== null) {
      const overflowCount = group.entries.filter(
        (entry) => entry.finalTimeMs > targetDurationMs
      ).length;
      if (overflowCount > 0) {
        const message = `${group.targetName} 有 ${overflowCount} 条弹幕投影后超出原片时长，请复核来源范围或目标起点。`;
        group.warnings.push(message);
        issues.push({
          id: `target-overflow-${group.targetMediaId}`,
          severity: "warning",
          segmentId: null,
          message
        });
      }
    }
  }
  groups.sort((left, right) => compareGroupOrder(left, right));

  const ignoredItemCount = countItemsInSegments(usableIgnoredSegments, assetsById);
  const unmappedItemCount = countUnmappedItems(
    project,
    usableSegments,
    usableIgnoredSegments,
    assetsById
  );
  if (unmappedItemCount > 0) {
    issues.push({
      id: "unmapped-items",
      severity: "warning",
      segmentId: null,
      message: `${unmappedItemCount} 条弹幕不在任何来源段内，不会被导出。如需保留，请补充正片来源段。`
    });
  }

  const hasBlocker = issues.some((issue) => issue.severity === "error");
  const status: SourceProjectionStatus = hasBlocker
    ? "blocked"
    : issues.length > 0 || disabledTotal > 0
      ? "readyWithWarnings"
      : "ready";

  return {
    status: groups.length === 0 && hasBlocker ? "blocked" : status,
    groups,
    issues,
    contentSegmentCount: contentSegments.length,
    ignoredSegmentCount: ignoredSegments.length,
    projectedItemCount,
    ignoredItemCount,
    unmappedItemCount
  };
}

function findOverlappingProjectionSegments(
  segments: readonly DanmakuSourceSegment[]
): Array<[DanmakuSourceSegment, DanmakuSourceSegment]> {
  const groups = new Map<string, DanmakuSourceSegment[]>();
  segments.forEach((segment) => {
    if (!segment.assetId || !segment.sourceMediaId) {
      return;
    }
    const key = `${segment.assetId}\u0000${segment.sourceMediaId}`;
    groups.set(key, [...(groups.get(key) ?? []), segment]);
  });
  const overlaps: Array<[DanmakuSourceSegment, DanmakuSourceSegment]> = [];
  groups.forEach((group) => {
    const sorted = [...group].sort(
      (left, right) =>
        left.sourceStartMs - right.sourceStartMs || left.sourceEndMs - right.sourceEndMs
    );
    for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
      const left = sorted[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
        const right = sorted[rightIndex];
        if (right.sourceStartMs >= left.sourceEndMs) {
          break;
        }
        const conflictsWithIgnored = left.kind === "ignored" || right.kind === "ignored";
        const duplicatesSameTarget =
          left.kind === "content" &&
          right.kind === "content" &&
          Boolean(left.targetMediaId) &&
          left.targetMediaId === right.targetMediaId;
        if (conflictsWithIgnored || duplicatesSameTarget) {
          overlaps.push([left, right]);
        }
      }
    }
  });
  return overlaps;
}

function findSegmentBlocker(
  segment: DanmakuSourceSegment,
  assetsById: Map<string, EditorProject["assets"][number]>,
  mediaById: Map<string, ProjectMediaReference>,
  sourceBindingByAssetId: Map<string, string>
): string | null {
  const sourceProblem = findSourceSegmentBlocker(
    segment,
    assetsById,
    mediaById,
    sourceBindingByAssetId
  );
  if (sourceProblem) {
    return sourceProblem;
  }
  if (!segment.targetMediaId) {
    return `${segment.label} 还没有选择目标原片，无法投影。`;
  }
  if (mediaById.get(segment.targetMediaId)?.role !== "targetOriginal") {
    return `${segment.label} 的目标素材不是原片角色，无法投影。`;
  }
  return null;
}

function findSourceSegmentBlocker(
  segment: DanmakuSourceSegment,
  assetsById: Map<string, EditorProject["assets"][number]>,
  mediaById: Map<string, ProjectMediaReference>,
  sourceBindingByAssetId: Map<string, string>
): string | null {
  if (!segment.assetId || !assetsById.has(segment.assetId)) {
    return `${segment.label} 还没有关联弹幕 XML，无法投影。`;
  }
  if (
    !segment.sourceMediaId ||
    mediaById.get(segment.sourceMediaId)?.role !== "bilibiliReference"
  ) {
    return `${segment.label} 还没有关联 B 站参考素材，无法投影。`;
  }
  const boundSourceMediaId = sourceBindingByAssetId.get(segment.assetId);
  if (!boundSourceMediaId) {
    return `${segment.label} 所属 XML 尚未在素材页绑定 B 站参考素材，无法投影。`;
  }
  if (boundSourceMediaId !== segment.sourceMediaId) {
    return `${segment.label} 使用的参考素材与所属 XML 在素材页的绑定不一致，无法投影。`;
  }
  return null;
}

function ensureGroup(
  groups: Map<string, TargetProjectionGroup>,
  target: ProjectMediaReference
): TargetProjectionGroup {
  const existing = groups.get(target.id);
  if (existing) {
    return existing;
  }
  const group: TargetProjectionGroup = {
    targetMediaId: target.id,
    targetName: target.name,
    targetFileName: target.fileName,
    episodeLabel: target.episodeLabel,
    exportFileName: createExportFileName(target),
    segments: [],
    entries: [],
    disabledCount: 0,
    appliedRules: [],
    warnings: []
  };
  groups.set(target.id, group);
  return group;
}

function createExportFileName(target: ProjectMediaReference): string {
  const base = stripVideoExtension(target.fileName.trim()) || target.name.trim() || target.id;
  const sanitized = base.replace(/[\\/:*?"<>|]+/g, "_");
  return `${sanitized}.xml`;
}

function ensureUniqueExportFileNames(groups: TargetProjectionGroup[]): void {
  const groupsByName = new Map<string, TargetProjectionGroup[]>();
  groups.forEach((group) => {
    const key = group.exportFileName.toLocaleLowerCase("en-US");
    groupsByName.set(key, [...(groupsByName.get(key) ?? []), group]);
  });
  const usedNames = new Set(
    [...groupsByName.entries()]
      .filter(([, sameNameGroups]) => sameNameGroups.length === 1)
      .map(([name]) => name)
  );
  groupsByName.forEach((duplicates) => {
    if (duplicates.length < 2) {
      return;
    }
    duplicates
      .sort((left, right) => left.targetMediaId.localeCompare(right.targetMediaId))
      .forEach((group) => {
        const base = group.exportFileName.replace(/\.xml$/i, "");
        let sequence = 1;
        let nextName = `${base}-${sequence}.xml`;
        while (usedNames.has(nextName.toLocaleLowerCase("en-US"))) {
          sequence += 1;
          nextName = `${base}-${sequence}.xml`;
        }
        group.exportFileName = nextName;
        usedNames.add(nextName.toLocaleLowerCase("en-US"));
        group.warnings.push("存在同名原片，导出文件名已自动添加序号以避免覆盖。");
      });
  });
}

function stripVideoExtension(fileName: string): string {
  return fileName.replace(/\.(mp4|webm|mkv|avi|mov|m4v|ts|flv|m2ts)$/i, "");
}

function accumulateGap(
  sortedRules: readonly SegmentTimingRule[],
  itemSourceTimeMs: Milliseconds,
  ruleHits: Map<string, number>
): Milliseconds {
  let total = 0;
  for (const rule of sortedRules) {
    if (itemSourceTimeMs >= rule.sourceAtMs) {
      total += rule.gapMs;
      ruleHits.set(rule.id, (ruleHits.get(rule.id) ?? 0) + 1);
    }
  }
  return total;
}

function countItemsInSegments(
  segments: readonly DanmakuSourceSegment[],
  assetsById: Map<string, EditorProject["assets"][number]>
): number {
  let count = 0;
  for (const segment of segments) {
    if (!segment.assetId) {
      continue;
    }
    const asset = assetsById.get(segment.assetId);
    if (!asset) {
      continue;
    }
    count += asset.items.filter(
      (item) =>
        item.sourceTimeMs >= segment.sourceStartMs && item.sourceTimeMs < segment.sourceEndMs
    ).length;
  }
  return count;
}

function countUnmappedItems(
  project: EditorProject,
  contentSegments: readonly DanmakuSourceSegment[],
  ignoredSegments: readonly DanmakuSourceSegment[],
  assetsById: Map<string, EditorProject["assets"][number]>
): number {
  let unmapped = 0;
  for (const asset of assetsById.values()) {
    const assetId = asset.id;
    const assetSegments = [...contentSegments, ...ignoredSegments].filter(
      (segment) => segment.assetId === assetId
    );
    for (const item of asset.items) {
      const covered = assetSegments.some(
        (segment) =>
          item.sourceTimeMs >= segment.sourceStartMs && item.sourceTimeMs < segment.sourceEndMs
      );
      if (!covered) {
        unmapped += 1;
      }
    }
  }
  return unmapped;
}

function compareGroupOrder(left: TargetProjectionGroup, right: TargetProjectionGroup): number {
  const leftLabel = left.episodeLabel ?? left.targetName;
  const rightLabel = right.episodeLabel ?? right.targetName;
  return leftLabel.localeCompare(rightLabel, "zh-CN", { numeric: true });
}
