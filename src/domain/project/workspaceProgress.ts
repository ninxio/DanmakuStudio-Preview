import { findDanmakuSourceBinding } from "./mediaLibrary";
import type { EditorProject } from "./types";
import { projectDanmakuToTargets, type SourceProjectionResult } from "../timeline/sourceProjection";

export type WorkspacePageId = "materials" | "matching" | "editing" | "export";
export type WorkspaceStepState = "complete" | "active" | "blocked" | "idle";

export interface WorkspacePageStep {
  id: WorkspacePageId;
  order: number;
  label: string;
  state: WorkspaceStepState;
  stateText: string;
  headline: string;
  detail: string;
  blockers: string[];
}

export interface WorkspaceProgress {
  steps: WorkspacePageStep[];
  completeStepCount: number;
  totalStepCount: number;
  progressPercent: number;
  recommendedPage: WorkspacePageId;
  recommendedAction: string;
  liveSummary: string;
  projection: SourceProjectionResult;
  exportableEpisodeCount: number;
  confirmedTargetCount: number;
  pendingMatchCandidateCount: number;
}

export function createWorkspaceProgress(project: EditorProject): WorkspaceProgress {
  const projection = projectDanmakuToTargets(project);
  const targetMedia = project.mediaLibrary.filter((media) => media.role === "targetOriginal");
  const referenceMedia = project.mediaLibrary.filter((media) => media.role === "bilibiliReference");
  const assetCount = project.assets.length;
  const unboundXmlCount = project.assets.filter(
    (asset) => !findDanmakuSourceBinding(project.danmakuSourceBindings, asset.id)
  ).length;
  const contentSegments = project.danmakuSourceSegments.filter((segment) => segment.kind === "content");
  const confirmedTargetIds = new Set(
    contentSegments
      .map((segment) => segment.targetMediaId)
      .filter((mediaId): mediaId is string => targetMedia.some((media) => media.id === mediaId))
  );
  const confirmedTargetCount = confirmedTargetIds.size;
  const pendingMatchCandidateCount = project.mediaMatchCandidates.filter(
    (candidate) => candidate.state === "pending" || candidate.state === "blocked"
  ).length;
  const exportableEpisodeCount = projection.groups.filter((group) => group.entries.length > 0).length;

  const materialsBlockers = createMaterialsBlockers({
    assetCount,
    targetCount: targetMedia.length,
    referenceCount: referenceMedia.length,
    unboundXmlCount
  });
  const matchingBlockers = createMatchingBlockers({
    materialsComplete: materialsBlockers.length === 0 && assetCount > 0,
    contentSegmentCount: contentSegments.length,
    confirmedTargetCount,
    targetCount: targetMedia.length,
    projection
  });

  const materialsState = resolveStepState(materialsBlockers, assetCount > 0);
  const matchingState = resolveMatchingState(materialsState, matchingBlockers, contentSegments.length, projection);
  const editingState = resolveEditingState(materialsState, matchingState, project.clips.length);
  const exportState = resolveExportState(matchingState, projection, exportableEpisodeCount);

  const steps: WorkspacePageStep[] = [
    {
      id: "materials",
      order: 1,
      label: "素材",
      state: materialsState,
      stateText: materialsState === "complete" ? "已就绪" : materialsState === "active" ? "进行中" : "待开始",
      headline:
        materialsState === "complete"
          ? "素材和绑定关系已齐备"
          : assetCount === 0
            ? "先导入原片、参考视频和弹幕 XML"
            : "补齐素材或完成 XML 绑定",
      detail: "导入原片素材、B 站参考素材和弹幕 XML，并把每个 XML 关联到对应的参考视频。",
      blockers: materialsBlockers
    },
    {
      id: "matching",
      order: 2,
      label: "匹配",
      state: matchingState,
      stateText:
        matchingState === "complete"
          ? `${confirmedTargetCount} / ${targetMedia.length} 个原片已有保存关系`
          : matchingState === "active"
            ? `${confirmedTargetCount} / ${targetMedia.length} 个原片已有保存关系`
            : matchingState === "blocked"
              ? "需处理"
              : "等待素材",
      headline:
        matchingState === "complete"
          ? "参考视频与原片的对应关系已建立"
          : "标出参考视频的哪一段对应哪个原片",
      detail: "创建正片来源段和忽略范围，必要时运行音频对齐辅助发现删减点。",
      blockers: matchingBlockers
    },
    {
      id: "editing",
      order: 3,
      label: "编辑",
      state: editingState,
      stateText:
        editingState === "complete"
          ? `${project.clips.length} 个片段`
          : editingState === "active"
            ? "可微调"
            : "按需",
      headline:
        project.clips.length > 0
          ? "可在时间轴上预览和精细修正"
          : "需要时再进入时间轴微调弹幕",
      detail: "把弹幕放入时间轴后可预览、移动片段、标记版本差异或调整单条弹幕。投影导出不强制要求此步。",
      blockers: []
    },
    {
      id: "export",
      order: 4,
      label: "导出",
      state: exportState,
      stateText:
        exportState === "active"
          ? `${exportableEpisodeCount} 集可导出`
          : exportState === "blocked"
            ? "暂不可导出"
            : "等待匹配",
      headline:
        exportState === "active"
          ? "可以按原片分集导出修正后的弹幕 XML"
          : "完成匹配并确认来源段后再导出",
      detail: "按目标原片分组投影弹幕时间，为每集生成一个可重新解析验证的 XML 文件。",
      blockers: createExportBlockers(projection, exportableEpisodeCount)
    }
  ];

  const completeStepCount = steps.filter((step) => step.state === "complete").length;
  const recommended = pickRecommendedPage(steps);

  return {
    steps,
    completeStepCount,
    totalStepCount: steps.length,
    progressPercent: Math.round((completeStepCount / steps.length) * 100),
    recommendedPage: recommended.page,
    recommendedAction: recommended.action,
    liveSummary: `${assetCount} 个 XML · ${confirmedTargetCount}/${targetMedia.length} 个原片已有保存关系 · ${pendingMatchCandidateCount} 个候选待复核`,
    projection,
    exportableEpisodeCount,
    confirmedTargetCount,
    pendingMatchCandidateCount
  };
}

function createMaterialsBlockers(input: {
  assetCount: number;
  targetCount: number;
  referenceCount: number;
  unboundXmlCount: number;
}): string[] {
  const blockers: string[] = [];
  if (input.assetCount === 0) {
    blockers.push("还没有导入弹幕 XML。");
  }
  if (input.targetCount === 0) {
    blockers.push("还没有导入原片素材。");
  }
  if (input.referenceCount === 0) {
    blockers.push("还没有导入 B 站参考素材。");
  }
  if (input.assetCount > 0 && input.unboundXmlCount > 0) {
    blockers.push(`还有 ${input.unboundXmlCount} 个 XML 未关联参考视频。`);
  }
  return blockers;
}

function createMatchingBlockers(input: {
  materialsComplete: boolean;
  contentSegmentCount: number;
  confirmedTargetCount: number;
  targetCount: number;
  projection: SourceProjectionResult;
}): string[] {
  if (!input.materialsComplete) {
    return ["请先在素材页补齐导入和 XML 绑定。"];
  }
  const blockers: string[] = [];
  if (input.contentSegmentCount === 0) {
    blockers.push("还没有正片来源段，无法投影到原片。");
  }
  if (input.targetCount > 0 && input.confirmedTargetCount < input.targetCount) {
    blockers.push(`还有 ${input.targetCount - input.confirmedTargetCount} 个原片没有保存匹配关系。`);
  }
  for (const issue of input.projection.issues) {
    if (issue.severity === "error") {
      blockers.push(issue.message);
    }
  }
  return blockers;
}

function createExportBlockers(projection: SourceProjectionResult, exportableEpisodeCount: number): string[] {
  if (projection.status === "blocked") {
    return projection.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message);
  }
  if (exportableEpisodeCount === 0) {
    return ["还没有可导出的分集弹幕，请先在匹配页完成来源段。"];
  }
  return [];
}

function resolveStepState(blockers: string[], hasStarted: boolean): WorkspaceStepState {
  if (blockers.length === 0 && hasStarted) {
    return "complete";
  }
  if (hasStarted || blockers.length > 0) {
    return blockers.length > 0 ? "active" : "complete";
  }
  return "active";
}

function resolveMatchingState(
  materialsState: WorkspaceStepState,
  blockers: string[],
  contentSegmentCount: number,
  projection: SourceProjectionResult
): WorkspaceStepState {
  if (materialsState !== "complete") {
    return materialsState === "active" ? "idle" : "idle";
  }
  if (blockers.length === 0 && contentSegmentCount > 0 && projection.status !== "empty" && projection.status !== "blocked") {
    return "complete";
  }
  if (projection.status === "blocked") {
    return "blocked";
  }
  return "active";
}

function resolveEditingState(
  materialsState: WorkspaceStepState,
  matchingState: WorkspaceStepState,
  clipCount: number
): WorkspaceStepState {
  if (materialsState !== "complete") {
    return "idle";
  }
  if (clipCount > 0) {
    return "complete";
  }
  if (matchingState === "complete" || matchingState === "active") {
    return "active";
  }
  return "idle";
}

function resolveExportState(
  matchingState: WorkspaceStepState,
  projection: SourceProjectionResult,
  exportableEpisodeCount: number
): WorkspaceStepState {
  if (matchingState !== "complete" && matchingState !== "active") {
    return "idle";
  }
  if (projection.status === "blocked") {
    return "blocked";
  }
  if (exportableEpisodeCount > 0 && (projection.status === "ready" || projection.status === "readyWithWarnings")) {
    return "active";
  }
  if (matchingState === "complete" && exportableEpisodeCount === 0) {
    return "blocked";
  }
  return "idle";
}

function pickRecommendedPage(steps: WorkspacePageStep[]): { page: WorkspacePageId; action: string } {
  const priority: WorkspacePageId[] = ["materials", "matching", "export", "editing"];
  for (const pageId of priority) {
    const step = steps.find((candidate) => candidate.id === pageId);
    if (!step) {
      continue;
    }
    if (step.state === "active" || step.state === "blocked") {
      const blocker = step.blockers[0];
      return {
        page: pageId,
        action: blocker ?? step.headline
      };
    }
  }
  const exportStep = steps.find((step) => step.id === "export");
  if (exportStep?.state === "active") {
    return { page: "export", action: "导出全部分集 XML" };
  }
  return { page: "editing", action: "按需进入时间轴微调" };
}

export function createPageProgressHint(pageId: WorkspacePageId, progress: WorkspaceProgress): string {
  const step = progress.steps.find((candidate) => candidate.id === pageId);
  if (!step) {
    return "";
  }
  if (step.blockers.length > 0) {
    return step.blockers[0];
  }
  if (step.state === "complete") {
    return step.headline;
  }
  return step.detail;
}
