import {
  CheckCircle2,
  Circle,
  CircleAlert,
  Clock3,
  FileDown,
  FileUp,
  Save,
  Shuffle,
  Sparkles,
  Trash2,
  Video,
  X
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";
import { TextButton } from "../../components/TextButton";
import {
  createWorkflowOverview,
  type WorkflowActionDescriptor,
  type WorkflowActionId,
  type WorkflowCapability,
  type WorkflowStage,
  type WorkflowStageState
} from "../../domain/project/workflowOverview";
import { useEditorStore } from "../../stores/editorStore";

interface WorkflowOverviewDialogProps {
  onClose: () => void;
  onImportVideo: () => void;
  onImportXml: () => void;
  onSaveProject: () => void;
  onExportXml: () => void;
}

export function WorkflowOverviewDialog({
  onClose,
  onImportVideo,
  onImportXml,
  onSaveProject,
  onExportXml
}: WorkflowOverviewDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const project = useEditorStore((state) => state.project);
  const alignmentProposal = useEditorStore((state) => state.alignmentProposal);
  const autoArrangeClips = useEditorStore((state) => state.autoArrangeClips);
  const applyAlignmentProposal = useEditorStore((state) => state.applyAlignmentProposal);
  const cleanupProjectEditReferences = useEditorStore((state) => state.cleanupProjectEditReferences);
  const cleanupProjectMissingAssetClips = useEditorStore((state) => state.cleanupProjectMissingAssetClips);
  const overview = useMemo(
    () => createWorkflowOverview(project, alignmentProposal ?? project.alignmentProposal),
    [alignmentProposal, project]
  );
  const actionHandlers: Record<WorkflowActionId, () => void> = {
    "import-video": onImportVideo,
    "import-xml": onImportXml,
    "auto-arrange": autoArrangeClips,
    "apply-alignment": applyAlignmentProposal,
    "cleanup-edit-references": cleanupProjectEditReferences,
    "cleanup-missing-clips": cleanupProjectMissingAssetClips,
    "save-project": onSaveProject,
    "export-xml": () => {
      onClose();
      onExportXml();
    }
  };

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const nextAction = overview.actions.find((action) => action.id === overview.nextActionId) ?? overview.actions[0];
  const visibleCapabilities = overview.capabilities;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6" data-testid="workflow-overview-dialog">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-overview-title"
        className="flex max-h-[calc(100vh-48px)] w-[min(1180px,calc(100vw-48px))] min-h-0 flex-col rounded border border-panel-line bg-panel-base shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-panel-line bg-[#111318] px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded border border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan">
                <Sparkles size={16} />
              </span>
              <div className="min-w-0">
                <h2 id="workflow-overview-title" className="truncate text-base font-semibold text-slate-100">
                  入门引导 / 工作流总览
                </h2>
                <p className="mt-1 truncate text-xs text-slate-500" title={overview.projectName}>
                  {overview.projectName} · {overview.liveSummary}
                </p>
              </div>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="关闭工作流总览"
            title="关闭工作流总览"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-panel-line bg-panel-soft text-slate-200 transition hover:border-slate-500 hover:bg-slate-700"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="thin-scrollbar min-h-0 flex-1 overflow-auto">
          <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section className="grid gap-4">
              <div className="rounded border border-panel-line bg-panel-soft p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs text-slate-500">当前阶段</p>
                    <p className="mt-1 text-sm font-medium text-slate-100">
                      {overview.completeStageCount} / {overview.totalStageCount} 个阶段已完成
                    </p>
                  </div>
                  <div className="min-w-44">
                    <div className="flex items-center justify-between text-xs text-slate-400">
                      <span>同步进度</span>
                      <span>{overview.progressPercent}%</span>
                    </div>
                    <div className="mt-2 h-2 rounded bg-black/40">
                      <div
                        className="h-2 rounded bg-accent-cyan"
                        style={{ width: `${overview.progressPercent}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <ol className="grid gap-3" aria-label="工作流阶段">
                {overview.stages.map((stage) => (
                  <WorkflowStageCard key={stage.id} stage={stage} capabilities={overview.capabilities} />
                ))}
              </ol>

              <section className="rounded border border-panel-line bg-panel-soft p-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-slate-100">能力地图</h3>
                  <span className="text-xs text-slate-500">{visibleCapabilities.length} 项已显性化</span>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {visibleCapabilities.map((capability) => (
                    <CapabilityRow key={capability.id} capability={capability} />
                  ))}
                </div>
              </section>
            </section>

            <aside className="grid content-start gap-4">
              <section className="rounded border border-accent-cyan/40 bg-accent-cyan/10 p-4">
                <p className="text-xs text-cyan-100/80">建议下一步</p>
                <h3 className="mt-1 text-sm font-semibold text-slate-100">{overview.nextActionLabel}</h3>
                <p className="mt-2 text-xs leading-5 text-slate-300">{nextAction.detail}</p>
                <ActionButton
                  action={nextAction}
                  onClick={() => actionHandlers[nextAction.id]()}
                  className="mt-3 w-full"
                />
              </section>

              <section className="rounded border border-panel-line bg-panel-soft p-4">
                <h3 className="text-sm font-semibold text-slate-100">真实操作入口</h3>
                <div className="mt-3 grid gap-2">
                  {overview.actions.map((action) => (
                    <ActionButton
                      key={action.id}
                      action={action}
                      onClick={() => actionHandlers[action.id]()}
                      className="w-full justify-start"
                    />
                  ))}
                </div>
              </section>

              <section className="rounded border border-panel-line bg-black/20 p-4">
                <h3 className="text-sm font-semibold text-slate-100">同步说明</h3>
                <p className="mt-2 text-xs leading-5 text-slate-400">
                  这里的阶段、计数、阻断和按钮状态来自当前项目状态，会随着导入、排布、清理、对齐和导出动作即时刷新。
                </p>
              </section>
            </aside>
          </div>
        </div>
      </section>
    </div>
  );
}

function WorkflowStageCard({
  stage,
  capabilities
}: {
  stage: WorkflowStage;
  capabilities: WorkflowCapability[];
}) {
  const capabilityMap = new Map(capabilities.map((capability) => [capability.id, capability]));
  const StageIcon = getStageIcon(stage.state);
  return (
    <li className="rounded border border-panel-line bg-panel-soft p-4">
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border ${stageStateIconClass(
            stage.state
          )}`}
        >
          <StageIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">0{stage.order}</span>
            <h3 className="text-sm font-semibold text-slate-100">{stage.title}</h3>
            <span className={`rounded border px-2 py-0.5 text-[11px] ${stageStateBadgeClass(stage.state)}`}>
              {stage.stateText}
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-200">{stage.headline}</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">{stage.detail}</p>
          <dl className="mt-3 grid gap-2 sm:grid-cols-3">
            {stage.metrics.map((metric) => (
              <div key={metric.label} className="min-w-0 rounded border border-panel-line/70 bg-black/15 px-2 py-1.5">
                <dt className="truncate text-[11px] text-slate-500">{metric.label}</dt>
                <dd className="truncate text-xs font-medium text-slate-200" title={metric.value}>
                  {metric.value}
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {stage.capabilityIds.map((capabilityId) => {
              const capability = capabilityMap.get(capabilityId);
              return capability ? (
                <span
                  key={capability.id}
                  className="rounded border border-panel-line bg-[#111318] px-2 py-1 text-[11px] text-slate-300"
                  title={capability.detail}
                >
                  {capability.title}
                </span>
              ) : null;
            })}
          </div>
        </div>
      </div>
    </li>
  );
}

function CapabilityRow({ capability }: { capability: WorkflowCapability }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 rounded border border-panel-line/70 bg-black/15 p-2">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-slate-200" title={capability.title}>
          {capability.title}
        </p>
        <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-slate-500">{capability.detail}</p>
      </div>
      <span className={`h-6 rounded border px-2 py-1 text-[11px] ${capability.active ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : "border-panel-line bg-[#111318] text-slate-400"}`}>
        {capability.stateText}
      </span>
    </div>
  );
}

function ActionButton({
  action,
  onClick,
  className = ""
}: {
  action: WorkflowActionDescriptor;
  onClick: () => void;
  className?: string;
}) {
  return (
    <TextButton
      tone={action.tone}
      disabled={!action.enabled}
      title={action.reason ?? action.detail}
      onClick={onClick}
      className={className}
    >
      {actionIcon(action.id)}
      <span className="truncate">{action.label}</span>
    </TextButton>
  );
}

function actionIcon(actionId: WorkflowActionId): ReactNode {
  if (actionId === "import-video") {
    return <Video size={14} />;
  }
  if (actionId === "import-xml") {
    return <FileUp size={14} />;
  }
  if (actionId === "auto-arrange") {
    return <Shuffle size={14} />;
  }
  if (actionId === "apply-alignment") {
    return <Sparkles size={14} />;
  }
  if (actionId === "cleanup-edit-references" || actionId === "cleanup-missing-clips") {
    return <Trash2 size={14} />;
  }
  if (actionId === "save-project") {
    return <Save size={14} />;
  }
  return <FileDown size={14} />;
}

function getStageIcon(state: WorkflowStageState) {
  if (state === "complete") {
    return CheckCircle2;
  }
  if (state === "active") {
    return Clock3;
  }
  if (state === "blocked") {
    return CircleAlert;
  }
  return Circle;
}

function stageStateIconClass(state: WorkflowStageState): string {
  if (state === "complete") {
    return "border-emerald-400/40 bg-emerald-400/10 text-emerald-200";
  }
  if (state === "active") {
    return "border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan";
  }
  if (state === "blocked") {
    return "border-amber-400/40 bg-amber-400/10 text-amber-200";
  }
  return "border-panel-line bg-[#111318] text-slate-400";
}

function stageStateBadgeClass(state: WorkflowStageState): string {
  if (state === "complete") {
    return "border-emerald-400/40 bg-emerald-400/10 text-emerald-200";
  }
  if (state === "active") {
    return "border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan";
  }
  if (state === "blocked") {
    return "border-amber-400/40 bg-amber-400/10 text-amber-200";
  }
  return "border-panel-line bg-[#111318] text-slate-400";
}
