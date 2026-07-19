import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import type { EditorStatus } from "../../stores/editorStore";

export function BackgroundTaskBar({
  status,
  progress,
  onAction
}: {
  status: EditorStatus;
  progress: number | null;
  onAction: () => void;
}) {
  const running = progress !== null;
  const toneClass =
    status.tone === "error"
      ? "text-accent-red"
      : status.tone === "warning"
        ? "text-accent-yellow"
        : status.tone === "success"
          ? "text-accent-green"
          : "text-slate-400";

  return (
    <footer
      className="relative flex h-8 shrink-0 items-center border-t border-panel-line bg-[#0d1015] px-3 text-[11px]"
      data-testid="status-bar"
      aria-live="polite"
    >
      <span className={`mr-2 shrink-0 ${toneClass}`} aria-hidden="true">
        {running ? (
          <LoaderCircle size={13} className="animate-spin" />
        ) : status.tone === "error" || status.tone === "warning" ? (
          <CircleAlert size={13} />
        ) : (
          <CheckCircle2 size={13} />
        )}
      </span>
      <span className={`min-w-0 flex-1 truncate ${toneClass}`}>
        {status.message}
      </span>
      {running ? (
        <span className="ml-3 shrink-0 font-mono text-[10px] text-slate-500">
          {Math.round((progress ?? 0) * 100)}%
        </span>
      ) : null}
      {status.action ? (
        <button
          type="button"
          className="ml-3 shrink-0 rounded-md border border-current/25 px-2 py-0.5 text-[10px] text-slate-300 transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-cyan"
          onClick={onAction}
        >
          {status.action.label}
        </button>
      ) : null}
      {running ? (
        <span
          className="absolute inset-x-0 bottom-0 h-px bg-accent-cyan/20"
          aria-hidden="true"
        >
          <span
            className="block h-full bg-accent-cyan transition-[width]"
            style={{
              width: `${Math.max(0, Math.min(1, progress ?? 0)) * 100}%`
            }}
          />
        </span>
      ) : null}
    </footer>
  );
}
