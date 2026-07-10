import type { DanmakuAsset, DanmakuClip } from "../danmaku/types";
import { formatTimecode, type Milliseconds } from "../shared/time";
import type { EditorProject } from "./types";

export type ProjectHealthStatus = "ready" | "attention" | "blocked";
export type ProjectHealthFindingSeverity = "info" | "warning" | "error";

export interface ProjectHealthFinding {
  id: string;
  severity: ProjectHealthFindingSeverity;
  title: string;
  detail: string;
  evidence?: string[];
}

export interface ProjectHealthMetrics {
  assetCount: number;
  itemCount: number;
  enabledItemCount: number;
  disabledItemCount: number;
  clipCount: number;
  activeClipCount: number;
  cutMarkerCount: number;
  totalCutGapMs: Milliseconds;
  syncAnchorCount: number;
  importWarningCount: number;
  itemAdjustmentCount: number;
  orphanedEditReferenceCount: number;
  missingAssetClipCount: number;
  duplicateIdCount: number;
  mediaNeedsReconnect: boolean;
}

export interface ProjectHealthSummary {
  status: ProjectHealthStatus;
  statusLabel: string;
  statusDetail: string;
  metrics: ProjectHealthMetrics;
  findings: ProjectHealthFinding[];
}

export interface ProjectEditReferenceCleanup {
  project: EditorProject;
  removedDisabledItemIds: number;
  removedItemAdjustments: number;
  changed: boolean;
}

export interface ProjectMissingAssetClipCleanup {
  project: EditorProject;
  removedClipIds: string[];
  removedClipCount: number;
  changed: boolean;
}

interface DuplicateIdEntry {
  value: string;
  label: string;
}

interface DuplicateIdGroup {
  value: string;
  labels: string[];
}

export function createProjectHealthSummary(project: EditorProject): ProjectHealthSummary {
  const itemIds = collectProjectItemIds(project);
  const disabledIdSet = new Set(project.disabledItemIds);
  const orphanedDisabledIds = project.disabledItemIds.filter((id) => !itemIds.has(id));
  const adjustedItemIds = Object.keys(project.itemTimeAdjustments);
  const orphanedAdjustmentIds = adjustedItemIds.filter((id) => !itemIds.has(id));
  const itemCount = project.assets.reduce((total, asset) => total + asset.items.length, 0);
  const enabledItemCount = project.assets.reduce(
    (total, asset) => total + asset.items.filter((item) => item.enabled && !disabledIdSet.has(item.id)).length,
    0
  );
  const importWarningCount = project.assets.reduce((total, asset) => total + asset.warnings.length, 0);
  const totalCutGapMs = project.cutMarkers.reduce((total, marker) => total + marker.targetGapMs, 0);
  const missingAssetClipCount = project.clips.filter((clip) => !project.assets.some((asset) => asset.id === clip.assetId))
    .length;
  const emptyClipCount = project.clips.filter((clip) => {
    const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
    return asset ? !clipHasVisibleItem(asset, clip) : false;
  }).length;
  const activeClipCount = project.clips.filter((clip) => clip.enabled).length;
  const lowConfidenceAnchorCount = project.syncAnchors.filter(
    (anchor) => anchor.confidence !== undefined && anchor.confidence < 0.75
  ).length;
  const duplicateAssetIdGroups = findDuplicateGroups(
    project.assets.map((asset, index) => ({
      value: asset.id,
      label: `资源 ${index + 1}（${asset.fileName}）`
    }))
  );
  const duplicateItemIdGroups = findDuplicateGroups(
    project.assets.flatMap((asset) =>
      asset.items.map((item) => ({
        value: item.id,
        label: `资源 ${asset.fileName} 的第 ${item.originalIndex + 1} 条弹幕`
      }))
    )
  );
  const duplicateClipIdGroups = findDuplicateGroups(
    project.clips.map((clip, index) => ({
      value: clip.id,
      label: `片段 ${index + 1}（${clip.name}）`
    }))
  );
  const duplicateCutIdGroups = findDuplicateGroups(
    project.cutMarkers.map((marker, index) => ({
      value: marker.id,
      label: `补偿点 ${index + 1}（${marker.name} @ ${formatTimecode(marker.sourceAtMs)}）`
    }))
  );
  const duplicateAnchorIdGroups = findDuplicateGroups(
    project.syncAnchors.map((anchor, index) => ({
      value: anchor.id,
      label: `同步锚点 ${index + 1}（${formatTimecode(anchor.sourceMs)} -> ${formatTimecode(anchor.targetMs)}）`
    }))
  );
  const duplicateIdCount =
    duplicateAssetIdGroups.length +
    duplicateItemIdGroups.length +
    duplicateClipIdGroups.length +
    duplicateCutIdGroups.length +
    duplicateAnchorIdGroups.length;

  const findings: ProjectHealthFinding[] = [];
  appendDuplicateFinding(findings, "asset-id", "资源 ID 重复", duplicateAssetIdGroups);
  appendDuplicateFinding(findings, "item-id", "弹幕 ID 重复", duplicateItemIdGroups);
  appendDuplicateFinding(findings, "clip-id", "片段 ID 重复", duplicateClipIdGroups);
  appendDuplicateFinding(findings, "cut-id", "补偿点 ID 重复", duplicateCutIdGroups);
  appendDuplicateFinding(findings, "anchor-id", "同步锚点 ID 重复", duplicateAnchorIdGroups);

  if (project.assets.length === 0) {
    findings.push({
      id: "no-assets",
      severity: "warning",
      title: "尚未导入 XML",
      detail: "项目还没有弹幕资源，保存后可恢复项目壳，但无法导出有效弹幕。"
    });
  }
  if (project.assets.length > 0 && project.clips.length === 0) {
    findings.push({
      id: "no-clips",
      severity: "warning",
      title: "没有时间轴片段",
      detail: "已导入的 XML 还没有放入时间轴，导出前请至少放入一个片段。"
    });
  }
  if (missingAssetClipCount > 0) {
    findings.push({
      id: "clip-missing-asset",
      severity: "error",
      title: "片段引用了缺失资源",
      detail: `${missingAssetClipCount.toLocaleString("zh-CN")} 个时间轴片段找不到对应弹幕资源，建议重新打开上一个 checkpoint 或删除这些片段。`
    });
  }
  if (emptyClipCount > 0) {
    findings.push({
      id: "empty-clips",
      severity: "warning",
      title: "存在空片段",
      detail: `${emptyClipCount.toLocaleString("zh-CN")} 个时间轴片段当前源区间内没有弹幕，导出前建议确认片段裁剪范围。`
    });
  }
  if (project.clips.length > 0 && activeClipCount === 0) {
    findings.push({
      id: "all-clips-disabled",
      severity: "warning",
      title: "所有片段都已禁用",
      detail: "时间轴上没有启用片段，导出结果可能为空。"
    });
  }
  if (orphanedDisabledIds.length > 0 || orphanedAdjustmentIds.length > 0) {
    findings.push({
      id: "orphaned-edits",
      severity: "warning",
      title: "存在失效编辑引用",
      detail: `有 ${(orphanedDisabledIds.length + orphanedAdjustmentIds.length).toLocaleString(
        "zh-CN"
      )} 条禁用或单条微调引用已不存在的弹幕，保存前建议清理。`
    });
  }
  if (project.media && project.media.objectUrl === null) {
    findings.push({
      id: "media-needs-reconnect",
      severity: "warning",
      title: "视频引用需要重新连接",
      detail: "项目文件不会嵌入视频内容，重新打开后需要再次导入本地视频才能恢复预览。"
    });
  }
  if (project.media && project.media.durationMs === null) {
    findings.push({
      id: "media-duration-missing",
      severity: "warning",
      title: "视频时长未知",
      detail: "预览视频尚未读取到时长，时间轴总长会更多依赖片段和弹幕范围。"
    });
  }
  if (importWarningCount > 0) {
    findings.push({
      id: "import-warnings",
      severity: "warning",
      title: "导入时存在警告",
      detail: `${importWarningCount.toLocaleString("zh-CN")} 条 XML 导入警告会保存在项目中，导出前建议抽样复核。`
    });
  }
  if (lowConfidenceAnchorCount > 0) {
    findings.push({
      id: "low-confidence-anchors",
      severity: "warning",
      title: "存在低置信同步锚点",
      detail: `${lowConfidenceAnchorCount.toLocaleString("zh-CN")} 个自动锚点置信度低于 75%，应用补偿前建议人工复核。`
    });
  }
  if (project.cutMarkers.some((marker) => marker.targetGapMs === 0)) {
    findings.push({
      id: "zero-gap-markers",
      severity: "info",
      title: "存在 0ms 补偿点",
      detail: "0ms 补偿点不会改变时间轴，可保留作标记，也可在确认后删除。"
    });
  }
  if (findings.length === 0) {
    findings.push({
      id: "ready",
      severity: "info",
      title: "项目结构健康",
      detail: "当前没有发现保存、重开或导出前需要优先处理的结构问题。"
    });
  }

  const status = createStatus(findings);
  return {
    status,
    statusLabel: statusToLabel(status),
    statusDetail: statusToDetail(status),
    metrics: {
      assetCount: project.assets.length,
      itemCount,
      enabledItemCount,
      disabledItemCount: itemCount - enabledItemCount,
      clipCount: project.clips.length,
      activeClipCount,
      cutMarkerCount: project.cutMarkers.length,
      totalCutGapMs,
      syncAnchorCount: project.syncAnchors.length,
      importWarningCount,
      itemAdjustmentCount: adjustedItemIds.length,
      orphanedEditReferenceCount: orphanedDisabledIds.length + orphanedAdjustmentIds.length,
      missingAssetClipCount,
      duplicateIdCount,
      mediaNeedsReconnect: Boolean(project.media && project.media.objectUrl === null)
    },
    findings
  };
}

export function cleanupProjectMissingAssetClips(project: EditorProject): ProjectMissingAssetClipCleanup {
  const assetIds = new Set(project.assets.map((asset) => asset.id));
  const removedClipIds = project.clips.filter((clip) => !assetIds.has(clip.assetId)).map((clip) => clip.id);
  const removedClipIdSet = new Set(removedClipIds);
  const changed = removedClipIds.length > 0;
  return {
    project: changed
      ? {
          ...project,
          clips: project.clips.filter((clip) => !removedClipIdSet.has(clip.id))
        }
      : project,
    removedClipIds,
    removedClipCount: removedClipIds.length,
    changed
  };
}

export function cleanupProjectEditReferences(project: EditorProject): ProjectEditReferenceCleanup {
  const itemIds = collectProjectItemIds(project);
  const disabledItemIds = project.disabledItemIds.filter((id) => itemIds.has(id));
  const itemTimeAdjustments: Record<string, Milliseconds> = {};
  for (const [itemId, adjustmentMs] of Object.entries(project.itemTimeAdjustments)) {
    if (itemIds.has(itemId)) {
      itemTimeAdjustments[itemId] = adjustmentMs;
    }
  }
  const removedDisabledItemIds = project.disabledItemIds.length - disabledItemIds.length;
  const removedItemAdjustments = Object.keys(project.itemTimeAdjustments).length - Object.keys(itemTimeAdjustments).length;
  const changed = removedDisabledItemIds > 0 || removedItemAdjustments > 0;
  return {
    project: changed
      ? {
          ...project,
          disabledItemIds,
          itemTimeAdjustments
        }
      : project,
    removedDisabledItemIds,
    removedItemAdjustments,
    changed
  };
}

export function createProjectHealthReport(projectName: string, summary: ProjectHealthSummary): string {
  const lines = [
    "项目健康报告",
    `项目：${projectName.trim().length > 0 ? projectName : "未命名项目"}`,
    `状态：${summary.statusLabel}`,
    `说明：${summary.statusDetail}`,
    "",
    "关键计数：",
    `资源：${summary.metrics.assetCount.toLocaleString("zh-CN")} 个`,
    `弹幕：${summary.metrics.enabledItemCount.toLocaleString("zh-CN")} / ${summary.metrics.itemCount.toLocaleString(
      "zh-CN"
    )} 条启用`,
    `片段：${summary.metrics.activeClipCount.toLocaleString("zh-CN")} / ${summary.metrics.clipCount.toLocaleString(
      "zh-CN"
    )} 个启用`,
    `补偿点：${summary.metrics.cutMarkerCount.toLocaleString("zh-CN")} 个`,
    `总补偿：${formatSignedDuration(summary.metrics.totalCutGapMs)}`,
    `同步锚点：${summary.metrics.syncAnchorCount.toLocaleString("zh-CN")} 个`,
    `导入警告：${summary.metrics.importWarningCount.toLocaleString("zh-CN")} 条`,
    `单条微调：${summary.metrics.itemAdjustmentCount.toLocaleString("zh-CN")} 条`,
    `失效编辑引用：${summary.metrics.orphanedEditReferenceCount.toLocaleString("zh-CN")} 条`,
    `缺失资源片段：${summary.metrics.missingAssetClipCount.toLocaleString("zh-CN")} 个`,
    `重复 ID：${summary.metrics.duplicateIdCount.toLocaleString("zh-CN")} 个`,
    `媒体重连：${summary.metrics.mediaNeedsReconnect ? "需要" : "不需要"}`,
    "",
    "复核清单："
  ];
  summary.findings.forEach((finding, index) => {
    lines.push(
      `${index + 1}. [${severityLabel(finding.severity)}] ${finding.title}`,
      `   ${finding.detail}`
    );
    finding.evidence?.forEach((item) => {
      lines.push(`   - ${item}`);
    });
  });
  return `${lines.join("\n")}\n`;
}

function collectProjectItemIds(project: EditorProject): Set<string> {
  return new Set(project.assets.flatMap((asset) => asset.items.map((item) => item.id)));
}

function clipHasVisibleItem(asset: DanmakuAsset, clip: DanmakuClip): boolean {
  return asset.items.some((item) => item.sourceTimeMs >= clip.sourceInMs && item.sourceTimeMs <= clip.sourceOutMs);
}

function appendDuplicateFinding(
  findings: ProjectHealthFinding[],
  id: string,
  title: string,
  groups: DuplicateIdGroup[]
) {
  if (groups.length === 0) {
    return;
  }
  findings.push({
    id,
    severity: "error",
    title,
    detail: `发现 ${groups.length.toLocaleString("zh-CN")} 个重复 ID：${formatLimitedList(
      groups.map((group) => group.value)
    )}。重复 ID 会影响选择、编辑、撤销和项目恢复。`,
    evidence: formatDuplicateEvidence(groups)
  });
}

function findDuplicateGroups(entries: DuplicateIdEntry[]): DuplicateIdGroup[] {
  const labelsByValue = new Map<string, string[]>();
  entries.forEach((entry) => {
    const labels = labelsByValue.get(entry.value);
    if (labels) {
      labels.push(entry.label);
    } else {
      labelsByValue.set(entry.value, [entry.label]);
    }
  });
  return [...labelsByValue.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([value, labels]) => ({ value, labels }))
    .sort((left, right) => left.value.localeCompare(right.value));
}

function formatDuplicateEvidence(groups: DuplicateIdGroup[]): string[] {
  return groups.slice(0, 5).map((group) => {
    const suffix =
      group.labels.length > 3 ? `；另有 ${group.labels.length - 3} 处` : "";
    return `${group.value}：${group.labels.slice(0, 3).join("；")}${suffix}`;
  });
}

function formatLimitedList(values: string[]): string {
  if (values.length <= 3) {
    return values.join("、");
  }
  return `${values.slice(0, 3).join("、")} 等 ${values.length.toLocaleString("zh-CN")} 项`;
}

function createStatus(findings: ProjectHealthFinding[]): ProjectHealthStatus {
  if (findings.some((finding) => finding.severity === "error")) {
    return "blocked";
  }
  if (findings.some((finding) => finding.severity === "warning")) {
    return "attention";
  }
  return "ready";
}

function statusToLabel(status: ProjectHealthStatus): string {
  if (status === "blocked") {
    return "需处理";
  }
  if (status === "attention") {
    return "需复核";
  }
  return "健康";
}

function statusToDetail(status: ProjectHealthStatus): string {
  if (status === "blocked") {
    return "发现引用或 ID 层面的结构问题，建议先处理后再导出。";
  }
  if (status === "attention") {
    return "项目可继续编辑，但保存、重开或导出前建议复核提示项。";
  }
  return "项目结构健康，可继续保存、重开和导出。";
}

function severityLabel(severity: ProjectHealthFindingSeverity): string {
  if (severity === "error") {
    return "需处理";
  }
  if (severity === "warning") {
    return "需复核";
  }
  return "信息";
}

function formatSignedDuration(milliseconds: Milliseconds): string {
  const sign = milliseconds < 0 ? "-" : "+";
  return `${sign}${formatTimecode(Math.abs(milliseconds))}`;
}
