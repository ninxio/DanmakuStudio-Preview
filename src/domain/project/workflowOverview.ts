import {
  createAlignmentApplyBlockers,
  createAlignmentReviewItemStatuses,
  createAlignmentReviewStatusSummary
} from "../alignment/alignmentReport";
import type { AlignmentProposal } from "../alignment/types";
import { resolveProjectDanmakuEvents } from "../timeline/mapping";
import { createProjectHealthSummary } from "./health";
import type { EditorProject } from "./types";

export type WorkflowStageId = "source" | "timeline" | "alignment" | "review" | "export";
export type WorkflowStageState = "complete" | "active" | "blocked" | "idle";
export type WorkflowActionId =
  | "import-video"
  | "import-xml"
  | "auto-arrange"
  | "apply-alignment"
  | "cleanup-edit-references"
  | "cleanup-missing-clips"
  | "save-project"
  | "export-xml";

export interface WorkflowMetric {
  label: string;
  value: string;
}

export interface WorkflowActionDescriptor {
  id: WorkflowActionId;
  label: string;
  detail: string;
  enabled: boolean;
  reason: string | null;
  tone: "primary" | "neutral" | "danger";
}

export interface WorkflowCapability {
  id: string;
  title: string;
  detail: string;
  visibleWhen: "always" | "with-source" | "with-timeline" | "with-alignment-proposal";
  stateText: string;
  active: boolean;
}

export interface WorkflowStage {
  id: WorkflowStageId;
  order: number;
  title: string;
  state: WorkflowStageState;
  stateText: string;
  headline: string;
  detail: string;
  metrics: WorkflowMetric[];
  capabilityIds: string[];
  actionIds: WorkflowActionId[];
}

export interface WorkflowOverview {
  projectName: string;
  updatedAt: string;
  totalStageCount: number;
  completeStageCount: number;
  progressPercent: number;
  nextActionId: WorkflowActionId;
  nextActionLabel: string;
  liveSummary: string;
  stages: WorkflowStage[];
  actions: WorkflowActionDescriptor[];
  capabilities: WorkflowCapability[];
}

export function createWorkflowOverview(
  project: EditorProject,
  alignmentProposal: AlignmentProposal | null
): WorkflowOverview {
  const assetCount = project.assets.length;
  const clipCount = project.clips.length;
  const enabledEvents = resolveProjectDanmakuEvents(project).filter((event) => event.enabled);
  const itemCount = project.assets.reduce((sum, asset) => sum + asset.items.length, 0);
  const health = createProjectHealthSummary(project);
  const alignmentContext = {
    existingAnchors: project.syncAnchors,
    existingCutMarkers: project.cutMarkers
  };
  const alignmentItemStatuses = alignmentProposal
    ? createAlignmentReviewItemStatuses(alignmentProposal, alignmentContext)
    : [];
  const alignmentStatus = createAlignmentReviewStatusSummary(alignmentItemStatuses);
  const alignmentBlockers = alignmentProposal
    ? createAlignmentApplyBlockers(alignmentProposal, alignmentContext)
    : [];
  const canApplyAlignment =
    Boolean(alignmentProposal) && alignmentStatus.pendingCount > 0 && alignmentBlockers.length === 0;
  const canExportXml = enabledEvents.length > 0 && health.status !== "blocked";
  const hasTimeline = clipCount > 0;
  const hasAlignmentWork =
    project.syncAnchors.length > 0 ||
    project.cutMarkers.length > 0 ||
    Boolean(alignmentProposal);
  const actions: WorkflowActionDescriptor[] = [
    {
      id: "import-video",
      label: "导入视频",
      detail: project.media ? `当前引用：${project.media.fileName}` : "选择本地 MP4 或 WebM 作为预览参照。",
      enabled: true,
      reason: null,
      tone: "neutral"
    },
    {
      id: "import-xml",
      label: "导入 XML",
      detail: assetCount > 0 ? `已导入 ${formatCount(assetCount)} 个 XML。` : "选择一个或多个 Bilibili XML 文件。",
      enabled: true,
      reason: null,
      tone: "primary"
    },
    {
      id: "auto-arrange",
      label: "按顺序排列",
      detail: "把已导入弹幕按分 P 顺序放入时间轴。",
      enabled: assetCount > 0,
      reason: assetCount > 0 ? null : "需要先导入 XML。",
      tone: "primary"
    },
    {
      id: "apply-alignment",
      label: "应用对齐候选",
      detail: alignmentProposal
        ? `待应用 ${alignmentStatus.pendingCount} 项，已落点 ${alignmentStatus.appliedCount} 项。`
        : "导入或生成对齐提案后可应用锚点与补偿。",
      enabled: canApplyAlignment,
      reason: createAlignmentActionReason(alignmentProposal, alignmentStatus.pendingCount, alignmentBlockers),
      tone: "primary"
    },
    {
      id: "cleanup-edit-references",
      label: "清理失效引用",
      detail: "移除已不存在弹幕的禁用和微调引用。",
      enabled: health.metrics.orphanedEditReferenceCount > 0,
      reason:
        health.metrics.orphanedEditReferenceCount > 0
          ? null
          : "当前没有失效编辑引用。",
      tone: "neutral"
    },
    {
      id: "cleanup-missing-clips",
      label: "清理缺失片段",
      detail: "移除引用缺失资源的时间轴片段。",
      enabled: health.metrics.missingAssetClipCount > 0,
      reason: health.metrics.missingAssetClipCount > 0 ? null : "当前没有缺失资源片段。",
      tone: "danger"
    },
    {
      id: "save-project",
      label: "保存项目",
      detail: "导出项目 JSON，只保存媒体引用和编辑状态。",
      enabled: true,
      reason: null,
      tone: "neutral"
    },
    {
      id: "export-xml",
      label: "导出 XML",
      detail: canExportXml
        ? `可导出 ${formatCount(enabledEvents.length)} 条启用弹幕。`
        : "需要可用时间轴片段，并通过阻断级健康检查。",
      enabled: canExportXml,
      reason: createExportReason(enabledEvents.length, health.status),
      tone: "primary"
    }
  ];
  const stages: WorkflowStage[] = [
    {
      id: "source",
      order: 1,
      title: "导入源数据",
      state: assetCount > 0 ? "complete" : "active",
      stateText: assetCount > 0 ? "已就绪" : "从这里开始",
      headline: assetCount > 0 ? "弹幕源已经进入项目" : "先把本地文件带进工作台",
      detail: "视频只作为本地引用，XML 会解析成可编辑弹幕资源；原始 XML 不会被改写。",
      metrics: [
        { label: "视频", value: project.media ? project.media.fileName : "未导入" },
        { label: "XML", value: `${formatCount(assetCount)} 个` },
        { label: "弹幕", value: `${formatCount(itemCount)} 条` }
      ],
      capabilityIds: ["local-media", "multi-xml", "raw-xml-safe"],
      actionIds: ["import-xml", "import-video"]
    },
    {
      id: "timeline",
      order: 2,
      title: "整理时间轴",
      state: hasTimeline ? "complete" : assetCount > 0 ? "active" : "blocked",
      stateText: hasTimeline ? "已有片段" : assetCount > 0 ? "可排布" : "等待 XML",
      headline: hasTimeline ? "时间轴已有可编辑片段" : "把弹幕资源放入时间轴",
      detail: "片段、单条微调、禁用、切割和合并都会进入项目历史，便于撤销和重做。",
      metrics: [
        { label: "片段", value: `${formatCount(clipCount)} 个` },
        { label: "启用弹幕", value: `${formatCount(enabledEvents.length)} 条` },
        { label: "全局偏移", value: `${project.globalOffsetMs} ms` }
      ],
      capabilityIds: ["timeline-edit", "item-adjustment", "history"],
      actionIds: ["auto-arrange"]
    },
    {
      id: "alignment",
      order: 3,
      title: "对齐与补偿",
      state: hasAlignmentWork ? "complete" : assetCount > 0 ? "active" : "idle",
      stateText: hasAlignmentWork ? "已有对齐线索" : assetCount > 0 ? "可开始复核" : "稍后处理",
      headline: hasAlignmentWork ? "已有锚点、补偿或候选提案" : "显式处理删减和版本差异",
      detail: "可用疑似删减扫描、人工锚点、音频对齐提案和复核队列，把差异表达成非破坏性规则。",
      metrics: [
        { label: "锚点", value: `${formatCount(project.syncAnchors.length)} 个` },
        { label: "补偿点", value: `${formatCount(project.cutMarkers.length)} 个` },
        { label: "候选提案", value: alignmentProposal ? `${formatCount(alignmentStatus.pendingCount)} 项待应用` : "无" }
      ],
      capabilityIds: ["cut-hints", "anchor-calibration", "alignment-proposal", "alignment-review"],
      actionIds: ["apply-alignment"]
    },
    {
      id: "review",
      order: 4,
      title: "项目复核",
      state: health.status === "blocked" ? "blocked" : health.status === "attention" ? "active" : "complete",
      stateText: health.statusLabel,
      headline: health.status === "ready" ? "健康检查通过" : health.statusDetail,
      detail: "项目健康会汇总缺失资源、失效编辑引用、重复 ID、负最终时间和媒体重连状态。",
      metrics: [
        { label: "状态", value: health.statusLabel },
        { label: "问题", value: `${formatCount(health.findings.length)} 项` },
        { label: "媒体重连", value: health.metrics.mediaNeedsReconnect ? "需要" : "不需要" }
      ],
      capabilityIds: ["project-health", "cleanup", "settings-privacy"],
      actionIds: ["cleanup-edit-references", "cleanup-missing-clips"]
    },
    {
      id: "export",
      order: 5,
      title: "保存与导出",
      state: canExportXml ? "active" : hasTimeline ? "blocked" : "idle",
      stateText: canExportXml ? "可导出" : hasTimeline ? "需先处理" : "等待时间轴",
      headline: canExportXml ? "可以生成验证后的 XML" : "完成时间轴和健康检查后再导出",
      detail: "导出前会重新序列化并验证 XML；项目文件只保存媒体引用和编辑状态，不嵌入视频内容。",
      metrics: [
        { label: "可导出弹幕", value: `${formatCount(enabledEvents.length)} 条` },
        { label: "项目文件", value: "JSON" },
        { label: "导出验证", value: "重新解析 XML" }
      ],
      capabilityIds: ["project-save", "xml-export", "export-report"],
      actionIds: ["export-xml", "save-project"]
    }
  ];
  const completeStageCount = stages.filter((stage) => stage.state === "complete").length;
  const nextAction = pickNextAction(stages, actions);
  return {
    projectName: project.name,
    updatedAt: project.updatedAt,
    totalStageCount: stages.length,
    completeStageCount,
    progressPercent: Math.round((completeStageCount / stages.length) * 100),
    nextActionId: nextAction.id,
    nextActionLabel: nextAction.label,
    liveSummary: `${formatCount(assetCount)} 个 XML / ${formatCount(clipCount)} 个片段 / ${health.statusLabel}`,
    stages,
    actions,
    capabilities: createCapabilities({
      hasAssets: assetCount > 0,
      hasTimeline,
      hasAlignmentProposal: Boolean(alignmentProposal),
      mediaLoaded: Boolean(project.media),
      project
    })
  };
}

function pickNextAction(
  stages: WorkflowStage[],
  actions: WorkflowActionDescriptor[]
): WorkflowActionDescriptor {
  const actionMap = new Map(actions.map((action) => [action.id, action]));
  for (const stage of stages) {
    if (stage.state === "complete") {
      continue;
    }
    const enabledAction = stage.actionIds
      .map((actionId) => actionMap.get(actionId))
      .find((action): action is WorkflowActionDescriptor => Boolean(action?.enabled));
    if (enabledAction) {
      return enabledAction;
    }
  }
  return actionMap.get("save-project") ?? actions[0];
}

function createAlignmentActionReason(
  proposal: AlignmentProposal | null,
  pendingCount: number,
  blockers: string[]
): string | null {
  if (!proposal) {
    return "当前没有对齐提案。";
  }
  if (blockers.length > 0) {
    return blockers[0];
  }
  if (pendingCount === 0) {
    return "当前对齐提案没有新的待应用项。";
  }
  return null;
}

function createExportReason(enabledEventCount: number, healthStatus: "ready" | "attention" | "blocked"): string | null {
  if (enabledEventCount === 0) {
    return "需要先把 XML 放入时间轴。";
  }
  if (healthStatus === "blocked") {
    return "项目健康存在阻断项。";
  }
  return null;
}

function createCapabilities({
  hasAssets,
  hasTimeline,
  hasAlignmentProposal,
  mediaLoaded,
  project
}: {
  hasAssets: boolean;
  hasTimeline: boolean;
  hasAlignmentProposal: boolean;
  mediaLoaded: boolean;
  project: EditorProject;
}): WorkflowCapability[] {
  return [
    {
      id: "local-media",
      title: "本地视频预览",
      detail: "引用本地视频文件，项目内不嵌入媒体内容。",
      visibleWhen: "always",
      stateText: mediaLoaded ? "已连接" : "可导入",
      active: mediaLoaded
    },
    {
      id: "multi-xml",
      title: "多 XML 导入",
      detail: "支持一次导入多个 Bilibili XML，并保留导入警告。",
      visibleWhen: "always",
      stateText: hasAssets ? `${formatCount(project.assets.length)} 个` : "等待导入",
      active: hasAssets
    },
    {
      id: "raw-xml-safe",
      title: "原始 XML 安全",
      detail: "所有修改通过项目状态和导出结果表达，不直接改写源文件。",
      visibleWhen: "always",
      stateText: "始终启用",
      active: true
    },
    {
      id: "timeline-edit",
      title: "时间轴片段编辑",
      detail: "支持排布、切割、合并、移动片段和缩放查看。",
      visibleWhen: "with-source",
      stateText: hasTimeline ? `${formatCount(project.clips.length)} 个片段` : "可开始",
      active: hasTimeline
    },
    {
      id: "item-adjustment",
      title: "单条弹幕微调",
      detail: "可禁用弹幕或以毫秒调整单条最终时间。",
      visibleWhen: "with-timeline",
      stateText: `${formatCount(Object.keys(project.itemTimeAdjustments).length)} 条微调`,
      active: Object.keys(project.itemTimeAdjustments).length > 0
    },
    {
      id: "history",
      title: "撤销 / 重做历史",
      detail: "片段、锚点、补偿、清理和对齐提案预览会进入历史。",
      visibleWhen: "always",
      stateText: "可用",
      active: true
    },
    {
      id: "cut-hints",
      title: "疑似删减扫描",
      detail: "按关键词和时间窗口查找可能需要补偿的位置。",
      visibleWhen: "with-source",
      stateText: hasAssets ? "可扫描" : "等待 XML",
      active: hasAssets
    },
    {
      id: "anchor-calibration",
      title: "人工锚点校准",
      detail: "用对应点文本生成同步锚点和补偿候选。",
      visibleWhen: "with-source",
      stateText: project.syncAnchors.length > 0 ? `${formatCount(project.syncAnchors.length)} 个锚点` : "可录入",
      active: project.syncAnchors.length > 0
    },
    {
      id: "alignment-proposal",
      title: "视频 / 音频对齐提案",
      detail: "可导入 JSON 提案，复核后应用锚点和补偿。",
      visibleWhen: "with-source",
      stateText: hasAlignmentProposal ? "有候选" : "可导入",
      active: hasAlignmentProposal
    },
    {
      id: "alignment-review",
      title: "对齐复核队列",
      detail: "显式标出待应用、已落点、低置信和阻断项。",
      visibleWhen: "with-alignment-proposal",
      stateText: hasAlignmentProposal ? "实时更新" : "等待提案",
      active: hasAlignmentProposal
    },
    {
      id: "project-health",
      title: "项目健康检查",
      detail: "汇总导出阻断、负时间、重复 ID 和媒体重连风险。",
      visibleWhen: "always",
      stateText: "实时计算",
      active: true
    },
    {
      id: "cleanup",
      title: "清理工具",
      detail: "可清理失效编辑引用和缺失资源片段。",
      visibleWhen: "with-source",
      stateText: "按需启用",
      active: false
    },
    {
      id: "settings-privacy",
      title: "设置与隐私导出",
      detail: "设置备份会跳过密码和令牌等敏感字段。",
      visibleWhen: "always",
      stateText: "可用",
      active: true
    },
    {
      id: "project-save",
      title: "项目保存",
      detail: "保存项目 JSON，便于回退和继续编辑。",
      visibleWhen: "always",
      stateText: "可用",
      active: true
    },
    {
      id: "xml-export",
      title: "XML 导出验证",
      detail: "导出前重新序列化并解析验证生成的 XML。",
      visibleWhen: "with-timeline",
      stateText: hasTimeline ? "导出前执行" : "等待时间轴",
      active: hasTimeline
    },
    {
      id: "export-report",
      title: "导出报告",
      detail: "导出健康报告和补偿明细，辅助验收。",
      visibleWhen: "with-timeline",
      stateText: "随导出生成",
      active: hasTimeline
    }
  ];
}

function formatCount(value: number): string {
  return value.toLocaleString("zh-CN");
}
