import {
  Check,
  Circle,
  CircleAlert,
  Clock3
} from "lucide-react";
import type {
  UsabilityStepState,
  UsabilityStepViewModel
} from "../../domain/project/usabilityViewModel";
import type { WorkspacePage } from "../../stores/editorStore";

export function WorkflowStepper({
  steps,
  activePage,
  onChange
}: {
  steps: UsabilityStepViewModel[];
  activePage: WorkspacePage;
  onChange: (page: WorkspacePage) => void;
}) {
  return (
    <nav
      aria-label="工作区页面"
      className="flex min-w-0 flex-1 items-center justify-center gap-1"
      data-testid="workflow-stepper"
    >
      {steps.map((step, index) => (
        <div key={step.id} className="flex min-w-0 items-center">
          <button
            type="button"
            aria-current={activePage === step.id ? "page" : undefined}
            data-testid={`workspace-nav-${step.id}`}
            className={`group flex min-w-[132px] items-center gap-2 rounded-lg border px-3 py-2 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-cyan ${
              activePage === step.id
                ? "border-accent-cyan/50 bg-accent-cyan/10 text-slate-50 shadow-[inset_0_-2px_0_rgba(76,201,240,0.75)]"
                : "border-transparent text-slate-400 hover:border-panel-line hover:bg-white/[0.035] hover:text-slate-200"
            }`}
            title={step.headline}
            onClick={() => onChange(step.id)}
          >
            <span
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold ${
                activePage === step.id
                  ? "border-accent-cyan bg-accent-cyan text-[#081217]"
                  : step.state === "complete"
                    ? "border-accent-green/50 bg-accent-green/10 text-accent-green"
                    : step.state === "attention"
                      ? "border-accent-yellow/50 bg-accent-yellow/10 text-accent-yellow"
                      : "border-panel-line bg-black/20 text-slate-500"
              }`}
              aria-hidden="true"
            >
              <StepGlyph state={step.state} order={step.order} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium">
                {step.label}
              </span>
              <span className="mt-0.5 block truncate text-[10px] text-slate-500 group-hover:text-slate-400">
                {step.issueCount > 0
                  ? `${step.issueCount} 项待处理`
                  : step.stateLabel}
              </span>
            </span>
          </button>
          {index < steps.length - 1 ? (
            <span
              className="mx-1 h-px w-5 shrink-0 bg-panel-line"
              aria-hidden="true"
            />
          ) : null}
        </div>
      ))}
    </nav>
  );
}

function StepGlyph({
  state,
  order
}: {
  state: UsabilityStepState;
  order: number;
}) {
  if (state === "complete") {
    return <Check size={13} strokeWidth={2.5} />;
  }
  if (state === "attention") {
    return <CircleAlert size={13} />;
  }
  if (state === "current") {
    return <Clock3 size={13} />;
  }
  if (state === "available") {
    return <Circle size={11} />;
  }
  return <span>{order}</span>;
}

