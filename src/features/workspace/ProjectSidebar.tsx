import { Clapperboard, FileText, Film, FolderKanban } from "lucide-react";
import type { ReactNode } from "react";
import type { UsabilityViewModel } from "../../domain/project/usabilityViewModel";
import type { EditorProject } from "../../domain/project/types";

export function ProjectSidebar({
  project,
  model
}: {
  project: EditorProject;
  model: UsabilityViewModel;
}) {
  const matchedTargetIds = new Set(
    project.danmakuSourceSegments.flatMap((segment) =>
      segment.kind === "content" && segment.targetMediaId
        ? [segment.targetMediaId]
        : []
    )
  );
  const pendingTargetIds = new Set(
    project.mediaMatchCandidates.flatMap((candidate) =>
      candidate.targetMediaId &&
      (candidate.state === "pending" || candidate.state === "blocked")
        ? [candidate.targetMediaId]
        : []
    )
  );
  const episodes = project.mediaLibrary.filter(
    (media) => media.role === "targetOriginal"
  );

  return (
    <aside
      className="flex min-h-0 w-[232px] shrink-0 flex-col border-r border-panel-line bg-[#11141a]"
      aria-label="项目侧栏"
      data-testid="project-sidebar"
    >
      <div className="border-b border-panel-line px-3 py-3">
        <div className="flex items-center gap-2 text-slate-200">
          <FolderKanban size={15} className="text-accent-cyan" />
          <span className="min-w-0 truncate text-xs font-semibold">
            {model.projectName}
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-4 text-slate-500">
          {model.summary.materialSummary}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-1 border-b border-panel-line p-2">
        <SummaryMetric
          icon={<Film size={12} />}
          label="原片"
          value={model.summary.originalCount}
        />
        <SummaryMetric
          icon={<Clapperboard size={12} />}
          label="参考"
          value={model.summary.referenceCount}
        />
        <SummaryMetric
          icon={<FileText size={12} />}
          label="XML"
          value={model.summary.xmlCount}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-3 py-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
            分集
          </h2>
          {episodes.length > 0 ? (
            <span className="text-[10px] text-slate-600">
              {model.summary.matchedEpisodeCount}/{episodes.length}
            </span>
          ) : null}
        </div>
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {episodes.length > 0 ? (
            <ul className="grid gap-1" aria-label="原片分集">
              {episodes.map((episode, index) => {
                const status = matchedTargetIds.has(episode.id)
                  ? "matched"
                  : pendingTargetIds.has(episode.id)
                    ? "review"
                    : "waiting";
                return (
                  <li
                    key={episode.id}
                    className="rounded-md border border-transparent bg-white/[0.025] px-2.5 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-8 shrink-0 font-mono text-[11px] text-slate-500">
                        {episode.episodeLabel ??
                          `E${String(index + 1).padStart(2, "0")}`}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate text-xs text-slate-300"
                        title={episode.name}
                      >
                        {episode.name}
                      </span>
                      <EpisodeState status={status} />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="rounded-lg border border-dashed border-panel-line px-3 py-5 text-center">
              <Film size={18} className="mx-auto text-slate-600" />
              <p className="mt-2 text-xs text-slate-400">还没有原片</p>
              <p className="mt-1 text-[10px] leading-4 text-slate-600">
                在素材页添加后，会在这里按分集显示匹配状态。
              </p>
            </div>
          )}
        </div>
      </div>
      <div className="border-t border-panel-line px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-slate-500">项目状态</span>
          <span
            className={`truncate text-[10px] ${
              model.summary.reviewIssueCount > 0
                ? "text-accent-yellow"
                : "text-accent-green"
            }`}
          >
            {model.summary.resultSummary}
          </span>
        </div>
      </div>
    </aside>
  );
}

function SummaryMetric({
  icon,
  label,
  value
}: {
  icon: ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-md bg-black/20 px-2 py-1.5 text-center">
      <div className="flex items-center justify-center gap-1 text-slate-600">
        {icon}
        <span className="text-[9px]">{label}</span>
      </div>
      <div className="mt-0.5 text-xs font-medium text-slate-300">{value}</div>
    </div>
  );
}

function EpisodeState({
  status
}: {
  status: "matched" | "review" | "waiting";
}) {
  const label =
    status === "matched" ? "已匹配" : status === "review" ? "需复核" : "待匹配";
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${
        status === "matched"
          ? "bg-accent-green"
          : status === "review"
            ? "bg-accent-yellow"
            : "bg-slate-600"
      }`}
      title={label}
      aria-label={label}
    />
  );
}
