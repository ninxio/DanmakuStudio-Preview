import { ArrowRight, CheckCircle2, Circle, CircleAlert, Clock3 } from "lucide-react";
import { TextButton } from "../../components/TextButton";
import {
  createPageProgressHint,
  createWorkspaceProgress,
  type WorkspaceStepState
} from "../../domain/project/workspaceProgress";
import type { WorkspacePage } from "../../stores/editorStore";
import { useEditorStore } from "../../stores/editorStore";

interface WorkspaceProgressBannerProps {
  pageId: WorkspacePage;
}

export function WorkspaceProgressBanner({ pageId }: WorkspaceProgressBannerProps) {
  const project = useEditorStore((state) => state.project);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const progress = createWorkspaceProgress(project);
  const currentStep = progress.steps.find((step) => step.id === pageId);
  const hint = createPageProgressHint(pageId, progress);

  if (!currentStep) {
    return null;
  }

  const nextStep = progress.steps.find((step) => step.id === progress.recommendedPage);
  const showNextAction = progress.recommendedPage !== pageId && nextStep !== undefined;

  return (
    <section
      className="rounded border border-panel-line bg-[#111318] p-3 text-xs text-slate-300"
      aria-label="工作流进度"
      data-testid="workspace-progress-banner"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">工作流</span>
        <span className="rounded border border-panel-line bg-black/25 px-1.5 py-0.5 text-[11px] text-slate-400">
          {progress.completeStepCount}/{progress.totalStepCount} 步完成
        </span>
        <span className="ml-auto text-[11px] text-slate-500">{progress.liveSummary}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1">
        {progress.steps.map((step, index) => (
          <div key={step.id} className="flex items-center gap-1">
            <button
              type="button"
              className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-cyan ${
                step.id === pageId
                  ? "border-accent-cyan/50 bg-accent-cyan/10 text-accent-cyan"
                  : "border-panel-line bg-black/20 text-slate-400 hover:border-slate-500 hover:text-slate-200"
              }`}
              aria-current={step.id === pageId ? "step" : undefined}
              title={step.headline}
              onClick={() => setWorkspacePage(step.id)}
            >
              <StepIcon state={step.state} />
              {step.label}
            </button>
            {index < progress.steps.length - 1 ? (
              <ArrowRight size={12} className="text-slate-600" aria-hidden="true" />
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-1">
        <p className="text-sm font-medium text-slate-100">{currentStep.headline}</p>
        <p className="leading-5 text-slate-500">{hint}</p>
        {currentStep.blockers.length > 1 ? (
          <ul className="grid gap-1 text-[11px] text-accent-yellow">
            {currentStep.blockers.slice(1).map((blocker) => (
              <li key={blocker}>· {blocker}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {showNextAction ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-panel-line/70 pt-3">
          <span className="text-[11px] text-slate-500">
            建议下一步：{nextStep.label} — {progress.recommendedAction}
          </span>
          <TextButton tone="primary" onClick={() => setWorkspacePage(progress.recommendedPage)}>
            去{nextStep.label}页
            <ArrowRight size={14} />
          </TextButton>
        </div>
      ) : null}
    </section>
  );
}

function StepIcon({ state }: { state: WorkspaceStepState }) {
  const className = "shrink-0";
  if (state === "complete") {
    return <CheckCircle2 size={12} className={`${className} text-accent-green`} aria-hidden="true" />;
  }
  if (state === "blocked") {
    return <CircleAlert size={12} className={`${className} text-accent-red`} aria-hidden="true" />;
  }
  if (state === "active") {
    return <Clock3 size={12} className={`${className} text-accent-cyan`} aria-hidden="true" />;
  }
  return <Circle size={12} className={`${className} text-slate-600`} aria-hidden="true" />;
}
