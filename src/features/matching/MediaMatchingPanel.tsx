import {
  CircleCheck,
  CircleX,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  WandSparkles
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { TextButton } from "../../components/TextButton";
import { augmentAlignmentProposalWithDanmakuEvidence } from "../../domain/alignment/danmakuEvidence";
import { createMediaMatchCandidate } from "../../domain/alignment/mediaMatching";
import type { SuspectedCutCandidate } from "../../domain/danmaku/cutHints";
import { createId } from "../../domain/project/factory";
import { findProjectMedia } from "../../domain/project/mediaLibrary";
import { parseSourceTimecode } from "../../domain/project/sourceTimeline";
import type {
  EditorProject,
  MediaMatchCandidate,
  ProjectMediaReference
} from "../../domain/project/types";
import { formatTimecode } from "../../domain/shared/time";
import {
  cancelTauriAudioAlignmentJob,
  getTauriAudioAlignmentJob,
  isAudioAlignmentJobFinished,
  startTauriAudioAlignmentJob,
  type AudioAlignmentJobSnapshot
} from "../../infrastructure/alignment/tauriAudioAlignment";
import { loadAppSettings } from "../../infrastructure/settings/appSettings";
import { useEditorStore } from "../../stores/editorStore";

type BatchTaskState = "waiting" | "running" | "found" | "notFound" | "failed" | "cancelled";

interface BatchTask {
  id: string;
  sourceMediaId: string;
  targetMediaId: string;
  state: BatchTaskState;
  progress: number;
  message: string;
  jobId: string | null;
  logs: string[];
}

interface CandidateAssetSelection {
  assetIds: string[];
  touched: boolean;
}

export function MediaMatchingPanel({
  project,
  suspectedCutCandidates
}: {
  project: EditorProject;
  suspectedCutCandidates: SuspectedCutCandidate[];
}) {
  const sourceMedia = useMemo(
    () => project.mediaLibrary.filter((media) => media.role === "bilibiliReference"),
    [project.mediaLibrary]
  );
  const targetMedia = useMemo(
    () => project.mediaLibrary.filter((media) => media.role === "targetOriginal"),
    [project.mediaLibrary]
  );
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>([]);
  const [tasks, setTasks] = useState<BatchTask[]>([]);
  const [running, setRunning] = useState(false);
  const [candidateAssetSelections, setCandidateAssetSelections] = useState<
    Record<string, CandidateAssetSelection>
  >({});
  const activeJobRef = useRef<{ runToken: number; jobId: string } | null>(null);
  const cancelRequestedRef = useRef(false);
  const initializedProjectIdRef = useRef<string | null>(null);
  const sourceSelectionTouchedRef = useRef(false);
  const targetSelectionTouchedRef = useRef(false);
  const addCandidate = useEditorStore((state) => state.addMediaMatchCandidate);
  const acceptCandidate = useEditorStore((state) => state.acceptMediaMatchCandidate);
  const projectEpoch = useEditorStore((state) => state.projectEpoch);
  const projectEpochRef = useRef(projectEpoch);
  const batchTokenRef = useRef(0);

  useEffect(() => {
    if (initializedProjectIdRef.current === project.id) {
      setSelectedSourceIds((current) => {
        if (!sourceSelectionTouchedRef.current) {
          return sourceMedia.filter(canAnalyzeMedia).map((media) => media.id);
        }
        return current.filter((id) => sourceMedia.some((media) => media.id === id));
      });
      setSelectedTargetIds((current) => {
        if (!targetSelectionTouchedRef.current) {
          return targetMedia.filter(canAnalyzeMedia).map((media) => media.id);
        }
        return current.filter((id) => targetMedia.some((media) => media.id === id));
      });
      return;
    }
    initializedProjectIdRef.current = project.id;
    sourceSelectionTouchedRef.current = false;
    targetSelectionTouchedRef.current = false;
    setSelectedSourceIds(sourceMedia.filter(canAnalyzeMedia).map((media) => media.id));
    setSelectedTargetIds(targetMedia.filter(canAnalyzeMedia).map((media) => media.id));
    setTasks([]);
  }, [project.id, sourceMedia, targetMedia]);

  useEffect(() => {
    setCandidateAssetSelections((current) => {
      const next: Record<string, CandidateAssetSelection> = {};
      project.mediaMatchCandidates.forEach((candidate) => {
        if (candidate.state !== "pending" && candidate.state !== "blocked") {
          return;
        }
        const boundAssetIds = boundAssetsForCandidate(project, candidate).map(
          (asset) => asset.id
        );
        const existing = current[candidate.id];
        next[candidate.id] = existing?.touched
          ? {
              assetIds: existing.assetIds.filter((assetId) => boundAssetIds.includes(assetId)),
              touched: true
            }
          : { assetIds: boundAssetIds, touched: false };
      });
      return areCandidateAssetSelectionsEqual(current, next) ? current : next;
    });
  }, [project]);

  useEffect(() => {
    if (projectEpochRef.current === projectEpoch) {
      return;
    }
    projectEpochRef.current = projectEpoch;
    batchTokenRef.current += 1;
    cancelRequestedRef.current = true;
    const activeJob = activeJobRef.current;
    activeJobRef.current = null;
    if (activeJob) {
      void cancelTauriAudioAlignmentJob(activeJob.jobId).catch(() => undefined);
    }
    sourceSelectionTouchedRef.current = false;
    targetSelectionTouchedRef.current = false;
    setSelectedSourceIds(sourceMedia.filter(canAnalyzeMedia).map((media) => media.id));
    setSelectedTargetIds(targetMedia.filter(canAnalyzeMedia).map((media) => media.id));
    setRunning(false);
    setTasks([]);
  }, [projectEpoch, sourceMedia, targetMedia]);

  useEffect(
    () => () => {
      cancelRequestedRef.current = true;
      const activeJob = activeJobRef.current;
      if (activeJob) {
        void cancelTauriAudioAlignmentJob(activeJob.jobId).catch(() => undefined);
      }
    },
    []
  );

  const pairCount = selectedSourceIds.length * selectedTargetIds.length;
  const pendingCandidates = project.mediaMatchCandidates.filter(
    (candidate) => candidate.state === "pending" || candidate.state === "blocked"
  );
  const highConfidenceCandidates = pendingCandidates.filter(
    (candidate) => candidate.state === "pending" && candidate.confidence >= 0.75
  );
  const hasCancelledTasks = tasks.some((task) => task.state === "cancelled");

  const runBatch = async () => {
    const selectedSources = selectedSourceIds
      .map((id) => sourceMedia.find((media) => media.id === id))
      .filter((media): media is ProjectMediaReference => Boolean(media));
    const selectedTargets = selectedTargetIds
      .map((id) => targetMedia.find((media) => media.id === id))
      .filter((media): media is ProjectMediaReference => Boolean(media));
    if (selectedSources.length === 0 || selectedTargets.length === 0) {
      setEditorStatus("请至少选择一个可分析的 B 站参考素材和一个原片素材。", "warning");
      return;
    }
    const pairs = selectedSources.flatMap((source) =>
      selectedTargets.map((target) => ({ source, target, id: `${source.id}:${target.id}` }))
    );
    const existingPairKeys = new Set([
      ...useEditorStore
        .getState()
        .project.mediaMatchCandidates.filter((candidate) => candidate.state !== "rejected")
        .map((candidate) =>
          createMediaPairKey(candidate.sourceMediaId, candidate.targetMediaId)
        ),
      ...useEditorStore
        .getState()
        .project.danmakuSourceSegments.filter(
          (segment) =>
            segment.kind === "content" && segment.sourceMediaId && segment.targetMediaId
        )
        .map((segment) =>
          createMediaPairKey(segment.sourceMediaId ?? "", segment.targetMediaId ?? "")
        )
    ]);
    const pendingPairs = pairs.filter(
      (pair) => !existingPairKeys.has(createMediaPairKey(pair.source.id, pair.target.id))
    );
    const batchId = createId("media_match_batch");
    const initialTasks: BatchTask[] = pairs.map(({ source, target, id }) => ({
      id,
      sourceMediaId: source.id,
      targetMediaId: target.id,
      state: existingPairKeys.has(createMediaPairKey(source.id, target.id))
        ? "found"
        : "waiting",
      progress: existingPairKeys.has(createMediaPairKey(source.id, target.id)) ? 1 : 0,
      message: existingPairKeys.has(createMediaPairKey(source.id, target.id))
        ? "已有候选或已确认关系，未重复分析"
        : "等待分析",
      jobId: null,
      logs: []
    }));
    setTasks(initialTasks);
    if (pendingPairs.length === 0) {
      setEditorStatus(
        `所选 ${pairs.length} 组素材已有候选或确认关系，无需重复分析。`,
        "neutral"
      );
      return;
    }
    const runProjectEpoch = useEditorStore.getState().projectEpoch;
    const runToken = batchTokenRef.current + 1;
    batchTokenRef.current = runToken;
    const isRunCurrent = () =>
      batchTokenRef.current === runToken &&
      useEditorStore.getState().projectEpoch === runProjectEpoch;
    setRunning(true);
    cancelRequestedRef.current = false;
    const settings = loadAppSettings().alignment;
    let foundCount = 0;
    let contextInvalidated = false;

    for (const pair of pendingPairs) {
      if (cancelRequestedRef.current || !isRunCurrent()) {
        break;
      }
      const isPairCurrent = () => {
        if (!isRunCurrent()) {
          return false;
        }
        const currentProject = useEditorStore.getState().project;
        const currentSource = findProjectMedia(currentProject, pair.source.id);
        const currentTarget = findProjectMedia(currentProject, pair.target.id);
        return (
          normalizeLocalPath(currentSource?.localPath) ===
            normalizeLocalPath(pair.source.localPath) &&
          normalizeLocalPath(currentTarget?.localPath) ===
            normalizeLocalPath(pair.target.localPath)
        );
      };
      updateTask(pair.id, {
        state: "running",
        progress: 0,
        message: "正在定位参考视频中的对应片段"
      });
      let pairJobId: string | null = null;
      try {
        let snapshot = await startTauriAudioAlignmentJob({
          completePath: requireLocalPath(pair.target),
          sourcePath: requireLocalPath(pair.source),
          ffmpegPath: settings.ffmpegPath.trim() || null,
          windowMs: settings.windowMs,
          minGapMs: settings.minGapMs,
          matchThreshold: settings.matchThreshold,
          localizationMode: true
        });
        pairJobId = snapshot.jobId;
        if (!isRunCurrent()) {
          if (!isAudioAlignmentJobFinished(snapshot.status)) {
            void cancelTauriAudioAlignmentJob(snapshot.jobId).catch(() => undefined);
          }
          break;
        }
        activeJobRef.current = { runToken, jobId: snapshot.jobId };
        if (!isPairCurrent()) {
          contextInvalidated = true;
          if (!isAudioAlignmentJobFinished(snapshot.status)) {
            void cancelTauriAudioAlignmentJob(snapshot.jobId).catch(() => undefined);
          }
          break;
        }
        updateTaskFromSnapshot(pair.id, snapshot);
        if (cancelRequestedRef.current) {
          if (!isAudioAlignmentJobFinished(snapshot.status)) {
            try {
              snapshot = await cancelTauriAudioAlignmentJob(snapshot.jobId);
              if (isRunCurrent()) {
                updateTaskFromSnapshot(pair.id, snapshot);
              }
            } catch {
              // 后端任务可能已结束；前端仍按已取消处理，并且不会创建候选。
            }
          }
          if (isRunCurrent()) {
            updateTask(pair.id, { state: "cancelled", message: "已取消" });
          }
          break;
        }
        while (!isAudioAlignmentJobFinished(snapshot.status)) {
          await waitForPoll();
          if (cancelRequestedRef.current || !isPairCurrent()) {
            break;
          }
          snapshot = await getTauriAudioAlignmentJob(snapshot.jobId);
          if (!isPairCurrent()) {
            contextInvalidated = true;
            if (!isAudioAlignmentJobFinished(snapshot.status)) {
              void cancelTauriAudioAlignmentJob(snapshot.jobId).catch(() => undefined);
            }
            break;
          }
          updateTaskFromSnapshot(pair.id, snapshot);
        }
        if (!isPairCurrent()) {
          contextInvalidated = true;
          if (!isAudioAlignmentJobFinished(snapshot.status)) {
            void cancelTauriAudioAlignmentJob(snapshot.jobId).catch(() => undefined);
          }
          break;
        }
        if (cancelRequestedRef.current) {
          updateTask(pair.id, { state: "cancelled", message: "已取消" });
          break;
        }
        if (snapshot.status === "cancelled") {
          updateTask(pair.id, { state: "cancelled", message: snapshot.message || "已取消" });
          continue;
        }
        if (snapshot.status === "failed") {
          throw new Error(snapshot.error ?? snapshot.message ?? "分析失败");
        }
        if (!snapshot.proposal?.matchRange) {
          updateTask(pair.id, {
            state: "notFound",
            progress: 1,
            message: "没有找到可信对应片段"
          });
          continue;
        }
        const currentProject = useEditorStore.getState().project;
        const proposal = augmentAlignmentProposalWithDanmakuEvidence(
          snapshot.proposal,
          danmakuEvidenceForSource(currentProject, pair.source.id, suspectedCutCandidates)
        );
        const candidate = createMediaMatchCandidate(currentProject, {
          id: createId("media_match_candidate"),
          batchId,
          sourceMediaId: pair.source.id,
          targetMediaId: pair.target.id,
          proposal
        });
        addCandidate(candidate);
        foundCount += 1;
        updateTask(pair.id, {
          state: "found",
          progress: 1,
          message: `已找到 ${formatTimecode(candidate.sourceStartMs)}–${formatTimecode(candidate.sourceEndMs)}`
        });
      } catch (error) {
        if (isRunCurrent()) {
          updateTask(pair.id, {
            state: "failed",
            message: error instanceof Error ? error.message : "分析失败"
          });
        }
      } finally {
        if (
          activeJobRef.current?.runToken === runToken &&
          activeJobRef.current.jobId === pairJobId
        ) {
          activeJobRef.current = null;
        }
      }
    }

    if (!isRunCurrent()) {
      return;
    }
    if (contextInvalidated) {
      setEditorStatus(
        "项目素材在分析期间发生变化，本批次结果未应用，请重新开始匹配。",
        "warning"
      );
      setRunning(false);
      return;
    }
    if (cancelRequestedRef.current) {
      setTasks((current) =>
        current.map((task) =>
          task.state === "waiting"
            ? { ...task, state: "cancelled", message: "批次已取消" }
            : task
        )
      );
      setEditorStatus("批量匹配已取消，已经完成的候选仍保留。", "warning");
    } else {
      const skippedCount = pairs.length - pendingPairs.length;
      setEditorStatus(
        `批量匹配完成：${pendingPairs.length} 组中新找到 ${foundCount} 个候选${
          skippedCount > 0 ? `，跳过 ${skippedCount} 组已有结果` : ""
        }。`,
        "success"
      );
    }
    setRunning(false);
  };

  const cancelBatch = async () => {
    cancelRequestedRef.current = true;
    const activeJob = activeJobRef.current;
    if (activeJob) {
      try {
        await cancelTauriAudioAlignmentJob(activeJob.jobId);
      } catch {
        // 任务可能恰好结束；循环会在下一次状态检查时停止。
      }
    }
  };

  const acceptAllHighConfidence = () => {
    let acceptedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    highConfidenceCandidates.forEach((candidate) => {
      const assetIds = selectedAssetIdsForCandidate(candidate);
      if (assetIds.length === 0) {
        skippedCount += 1;
        return;
      }
      acceptCandidate(candidate.id, assetIds);
      const updated = useEditorStore
        .getState()
        .project.mediaMatchCandidates.find((item) => item.id === candidate.id);
      if (updated?.state === "accepted") {
        acceptedCount += 1;
      } else {
        failedCount += 1;
      }
    });
    setEditorStatus(
      `已按各卡 XML 勾选确认 ${acceptedCount} 个高可信候选${
        skippedCount > 0 ? `，跳过 ${skippedCount} 个未勾选 XML 的候选` : ""
      }${failedCount > 0 ? `，${failedCount} 个因已有重叠关系或校验失败而未确认` : ""}；请继续复核其余结果。`,
      acceptedCount > 0 && failedCount === 0 ? "success" : "warning"
    );
  };

  const selectedAssetIdsForCandidate = (candidate: MediaMatchCandidate): string[] =>
    candidateAssetSelections[candidate.id]?.assetIds ??
    boundAssetsForCandidate(project, candidate).map((asset) => asset.id);

  const updateCandidateAssetSelection = (candidateId: string, assetIds: string[]) => {
    setCandidateAssetSelections((current) => ({
      ...current,
      [candidateId]: { assetIds, touched: true }
    }));
  };

  const updateTask = (taskId: string, patch: Partial<BatchTask>) => {
    setTasks((current) =>
      current.map((task) => (task.id === taskId ? { ...task, ...patch } : task))
    );
  };

  const updateTaskFromSnapshot = (taskId: string, snapshot: AudioAlignmentJobSnapshot) => {
    updateTask(taskId, {
      jobId: snapshot.jobId,
      progress: snapshot.progress,
      message: snapshot.stageLabel || snapshot.message,
      logs: snapshot.logs
    });
  };

  return (
    <section
      className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300"
      data-testid="media-matching-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <WandSparkles size={16} className="text-accent-cyan" />
        <h3 className="text-sm font-medium text-slate-100">自动匹配项目素材</h3>
        <span className="ml-auto text-[11px] text-slate-500">
          {confirmedTargetCount(project)} / {targetMedia.length} 个原片已确认 ·{" "}
          {pendingCandidates.length} 个待复核
        </span>
      </div>
      <p className="mt-2 leading-5 text-slate-500">
        直接使用素材页导入的视频定位对应片段。自动结果只进入候选队列，确认后才会生成来源段并影响分集导出。
      </p>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <MediaChoiceList
          title="B 站参考素材"
          items={sourceMedia}
          selectedIds={selectedSourceIds}
          onToggle={(id) => {
            sourceSelectionTouchedRef.current = true;
            setSelectedSourceIds((current) => toggleId(current, id));
          }}
        />
        <MediaChoiceList
          title="原片素材"
          items={targetMedia}
          selectedIds={selectedTargetIds}
          onToggle={(id) => {
            targetSelectionTouchedRef.current = true;
            setSelectedTargetIds((current) => toggleId(current, id));
          }}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-panel-line bg-black/15 p-2">
        <span className="mr-auto text-slate-400">
          将分析 {selectedSourceIds.length} 个参考 × {selectedTargetIds.length} 个原片，共{" "}
          {pairCount} 组；任务顺序执行并复用音频特征缓存。
        </span>
        {running ? (
          <TextButton tone="danger" onClick={() => void cancelBatch()}>
            <Square size={13} />
            取消剩余任务
          </TextButton>
        ) : (
          <TextButton tone="primary" disabled={pairCount === 0} onClick={() => void runBatch()}>
            <Play size={13} />
            {hasCancelledTasks ? "继续剩余任务" : "开始批量匹配"}
          </TextButton>
        )}
      </div>

      {tasks.length > 0 ? <BatchTaskList tasks={tasks} project={project} /> : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium text-slate-100">候选复核</h4>
        {highConfidenceCandidates.length > 0 ? (
          <TextButton className="ml-auto" onClick={acceptAllHighConfidence}>
            <CircleCheck size={13} />
            按各卡勾选确认高可信候选（{highConfidenceCandidates.length}）
          </TextButton>
        ) : null}
      </div>
      {project.mediaMatchCandidates.length === 0 ? (
        <div className="mt-2 rounded border border-dashed border-panel-line p-3 leading-5 text-slate-500">
          尚无候选。选择项目内素材并开始匹配后，每一组结果会在这里单独复核；未确认结果不会改变导出。
        </div>
      ) : (
        <div className="mt-2 grid gap-2">
          {[...project.mediaMatchCandidates]
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            .map((candidate) => (
              <MediaMatchCandidateCard
                key={candidate.id}
                candidate={candidate}
                project={project}
                selectedAssetIds={selectedAssetIdsForCandidate(candidate)}
                onSelectedAssetIdsChange={(assetIds) =>
                  updateCandidateAssetSelection(candidate.id, assetIds)
                }
              />
            ))}
        </div>
      )}

      <ConfirmedRelations project={project} />
    </section>
  );
}

function MediaChoiceList({
  title,
  items,
  selectedIds,
  onToggle
}: {
  title: string;
  items: ProjectMediaReference[];
  selectedIds: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <fieldset className="rounded border border-panel-line bg-black/15 p-2">
      <legend className="px-1 text-xs font-medium text-slate-300">{title}</legend>
      {items.length === 0 ? (
        <p className="p-2 leading-5 text-slate-500">尚未导入。请回素材页批量导入。</p>
      ) : (
        <div className="grid gap-1">
          {items.map((media) => {
            const available = canAnalyzeMedia(media);
            return (
              <label
                key={media.id}
                className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-white/5"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-cyan-500"
                  checked={selectedIds.includes(media.id)}
                  disabled={!available}
                  onChange={() => onToggle(media.id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-slate-200">{media.name}</span>
                  <span
                    className={`block text-[11px] ${available ? "text-slate-500" : "text-accent-yellow"}`}
                  >
                    {available ? media.localPath : unavailableMediaHint(media)}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

function BatchTaskList({ tasks, project }: { tasks: BatchTask[]; project: EditorProject }) {
  return (
    <div
      className="mt-3 grid gap-1 rounded border border-panel-line bg-black/15 p-2"
      aria-label="批量匹配任务"
    >
      {tasks.map((task) => {
        const source = findProjectMedia(project, task.sourceMediaId);
        const target = findProjectMedia(project, task.targetMediaId);
        return (
          <div
            key={task.id}
            className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2 rounded px-2 py-1.5"
          >
            <div className="min-w-0">
              <div className="truncate text-slate-300">
                {source?.name ?? task.sourceMediaId} → {target?.name ?? task.targetMediaId}
              </div>
              <div
                className={
                  task.state === "failed" ? "text-accent-red" : "text-[11px] text-slate-500"
                }
              >
                {task.message}
              </div>
              {task.logs.length > 0 ? (
                <details className="mt-1 text-[11px] text-slate-500">
                  <summary className="cursor-pointer">任务日志</summary>
                  <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap">
                    {task.logs.join("\n")}
                  </pre>
                </details>
              ) : null}
            </div>
            <div className="flex items-center justify-end gap-2 text-[11px] text-slate-500">
              {task.state === "running" ? (
                <LoaderCircle size={13} className="animate-spin text-accent-cyan" />
              ) : null}
              <span>{batchTaskStateText(task.state)}</span>
              <span>{Math.round(task.progress * 100)}%</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MediaMatchCandidateCard({
  candidate,
  project,
  selectedAssetIds,
  onSelectedAssetIdsChange
}: {
  candidate: MediaMatchCandidate;
  project: EditorProject;
  selectedAssetIds: string[];
  onSelectedAssetIdsChange: (assetIds: string[]) => void;
}) {
  const source = findProjectMedia(project, candidate.sourceMediaId);
  const target = findProjectMedia(project, candidate.targetMediaId);
  const boundAssets = useMemo(() => {
    const boundIds = new Set(
      project.danmakuSourceBindings
        .filter((binding) => binding.sourceMediaId === candidate.sourceMediaId)
        .map((binding) => binding.assetId)
    );
    return project.assets.filter((asset) => boundIds.has(asset.id));
  }, [candidate.sourceMediaId, project.assets, project.danmakuSourceBindings]);
  const [sourceStartText, setSourceStartText] = useState(
    formatTimecode(candidate.sourceStartMs)
  );
  const [sourceEndText, setSourceEndText] = useState(formatTimecode(candidate.sourceEndMs));
  const [targetStartText, setTargetStartText] = useState(
    formatTimecode(candidate.targetStartMs)
  );
  const updateRange = useEditorStore((state) => state.updateMediaMatchCandidateRange);
  const acceptCandidate = useEditorStore((state) => state.acceptMediaMatchCandidate);
  const revokeAcceptance = useEditorStore((state) => state.revokeMediaMatchCandidateAcceptance);
  const rejectCandidate = useEditorStore((state) => state.rejectMediaMatchCandidate);

  useEffect(() => {
    setSourceStartText(formatTimecode(candidate.sourceStartMs));
    setSourceEndText(formatTimecode(candidate.sourceEndMs));
    setTargetStartText(formatTimecode(candidate.targetStartMs));
  }, [candidate.sourceEndMs, candidate.sourceStartMs, candidate.targetStartMs]);

  const createRangePatch = () => {
    const sourceStartMs = parseSourceTimecode(sourceStartText);
    const sourceEndMs = parseSourceTimecode(sourceEndText);
    const targetStartMs = parseSourceTimecode(targetStartText);
    if (
      sourceStartMs === null ||
      sourceEndMs === null ||
      targetStartMs === null ||
      sourceEndMs <= sourceStartMs
    ) {
      setEditorStatus("候选时间格式无效，请使用 00:00:00.000，并确保结束晚于开始。", "warning");
      return null;
    }
    const targetSpanMs = candidate.targetEndMs - candidate.targetStartMs;
    return {
      sourceStartMs,
      sourceEndMs,
      targetStartMs,
      targetEndMs: targetStartMs + targetSpanMs
    };
  };

  const saveRange = (): boolean => {
    const patch = createRangePatch();
    if (!patch) {
      return false;
    }
    updateRange(candidate.id, patch);
    const updated = useEditorStore
      .getState()
      .project.mediaMatchCandidates.find((item) => item.id === candidate.id);
    return Boolean(
      updated &&
      updated.sourceStartMs === patch.sourceStartMs &&
      updated.sourceEndMs === patch.sourceEndMs &&
      updated.targetStartMs === patch.targetStartMs &&
      updated.targetEndMs === patch.targetEndMs
    );
  };

  const accept = () => {
    if (!saveRange()) {
      return;
    }
    acceptCandidate(candidate.id, selectedAssetIds);
  };

  return (
    <article
      className="rounded border border-panel-line bg-[#111318] p-3"
      data-testid="media-match-candidate"
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-slate-100">
            {source?.name ?? candidate.sourceMediaId} →{" "}
            {target?.name ?? candidate.targetMediaId}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            参考 {formatTimecode(candidate.sourceStartMs)}–
            {formatTimecode(candidate.sourceEndMs)} 对应原片{" "}
            {formatTimecode(candidate.targetStartMs)} 起
          </div>
        </div>
        <span
          className={`rounded border px-2 py-0.5 text-[11px] ${candidateStateClass(candidate.state)}`}
        >
          {candidateStateText(candidate.state)}
        </span>
        <span className="rounded border border-panel-line px-2 py-0.5 text-[11px] text-slate-400">
          可信度 {Math.round(candidate.confidence * 100)}%
        </span>
      </div>

      {candidate.state === "pending" || candidate.state === "blocked" ? (
        <>
          <div className="mt-3 grid gap-2 md:grid-cols-3">
            <TimeField label="参考开始" value={sourceStartText} onChange={setSourceStartText} />
            <TimeField label="参考结束" value={sourceEndText} onChange={setSourceEndText} />
            <TimeField label="原片起点" value={targetStartText} onChange={setTargetStartText} />
          </div>
          <fieldset className="mt-3 rounded border border-panel-line/70 bg-black/15 p-2">
            <legend className="px-1 text-[11px] text-slate-500">
              应用到该参考素材绑定的 XML
            </legend>
            {boundAssets.length === 0 ? (
              <p className="text-accent-yellow">尚无绑定 XML；请先回素材页完成绑定。</p>
            ) : (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {boundAssets.map((asset) => (
                  <label key={asset.id} className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedAssetIds.includes(asset.id)}
                      onChange={() =>
                        onSelectedAssetIdsChange(toggleId(selectedAssetIds, asset.id))
                      }
                    />
                    {asset.fileName}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {candidate.state === "blocked" ? (
              <TextButton onClick={() => updateRange(candidate.id, {})}>
                <RefreshCw size={13} />
                刷新 XML 绑定
              </TextButton>
            ) : null}
            <TextButton onClick={saveRange}>保存范围</TextButton>
            <TextButton tone="danger" onClick={() => rejectCandidate(candidate.id)}>
              <CircleX size={13} />
              忽略候选
            </TextButton>
            <TextButton
              tone="primary"
              disabled={selectedAssetIds.length === 0 || candidate.state === "blocked"}
              onClick={accept}
            >
              <CircleCheck size={13} />
              确认并生成来源段
            </TextButton>
          </div>
        </>
      ) : null}

      {candidate.state === "accepted" ? (
        <div className="mt-3 flex justify-end">
          <TextButton onClick={() => revokeAcceptance(candidate.id)}>
            <RotateCcw size={13} />
            撤销确认并删除来源段
          </TextButton>
        </div>
      ) : null}

      <details className="mt-3 rounded border border-panel-line/70 bg-black/10 p-2 text-[11px] text-slate-500">
        <summary className="cursor-pointer">匹配证据与诊断</summary>
        <div className="mt-2 grid gap-1">
          <div>覆盖率：{Math.round((candidate.proposal.matchRange?.coverage ?? 0) * 100)}%</div>
          <div>
            同步线索：{candidate.proposal.anchors.length} 个；删减修正：
            {candidate.timingRules.length} 处
          </div>
          {candidate.proposal.diagnostics.map((line, index) => (
            <div key={`${candidate.id}-diag-${index}`}>{line}</div>
          ))}
        </div>
      </details>
    </article>
  );
}

function TimeField({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-[11px] text-slate-500">{label}</span>
      <input
        className="h-8 min-w-0 rounded border border-panel-line bg-black/20 px-2 text-xs text-slate-100"
        aria-label={`候选${label}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function ConfirmedRelations({ project }: { project: EditorProject }) {
  const confirmed = project.danmakuSourceSegments.filter(
    (segment) => segment.kind === "content"
  );
  const sourceIds = [
    ...new Set(
      confirmed
        .map((segment) => segment.sourceMediaId)
        .filter((id): id is string => Boolean(id))
    )
  ];
  return (
    <div className="mt-4">
      <h4 className="text-sm font-medium text-slate-100">已确认关系</h4>
      {sourceIds.length === 0 ? (
        <p className="mt-2 rounded border border-dashed border-panel-line p-3 leading-5 text-slate-500">
          尚未确认关系。接受候选后，会按参考素材分别显示多条映射，不会把不同视频放在同一时间标尺上。
        </p>
      ) : (
        <div className="mt-2 grid gap-2" data-testid="confirmed-media-relations">
          {sourceIds.map((sourceId) => {
            const source = findProjectMedia(project, sourceId);
            const segments = confirmed
              .filter((segment) => segment.sourceMediaId === sourceId)
              .sort((left, right) => left.sourceStartMs - right.sourceStartMs);
            return (
              <article
                key={sourceId}
                className="rounded border border-panel-line bg-black/15 p-2"
              >
                <div className="font-medium text-slate-200">{source?.name ?? sourceId}</div>
                <div className="mt-2 grid gap-1">
                  {segments.map((segment) => {
                    const target = findProjectMedia(project, segment.targetMediaId);
                    const asset = project.assets.find(
                      (candidate) => candidate.id === segment.assetId
                    );
                    return (
                      <div
                        key={segment.id}
                        className="rounded bg-black/15 px-2 py-1.5 text-slate-400"
                      >
                        <div className="font-medium text-slate-300">{segment.label}</div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          作用 XML：{asset?.fileName ?? "XML 已移除"}
                        </div>
                        <div className="mt-0.5">
                          {formatTimecode(segment.sourceStartMs)}–
                          {formatTimecode(segment.sourceEndMs)} → {target?.name ?? "未选择原片"}{" "}
                          {formatTimecode(segment.targetStartMs ?? 0)} 起 ·{" "}
                          {segment.timingRules.length} 处删减修正
                        </div>
                      </div>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function boundAssetsForCandidate(project: EditorProject, candidate: MediaMatchCandidate) {
  const boundIds = new Set(
    project.danmakuSourceBindings
      .filter((binding) => binding.sourceMediaId === candidate.sourceMediaId)
      .map((binding) => binding.assetId)
  );
  return project.assets.filter((asset) => boundIds.has(asset.id));
}

function danmakuEvidenceForSource(
  project: EditorProject,
  sourceMediaId: string,
  suspectedCutCandidates: SuspectedCutCandidate[]
) {
  const boundAssetIds = new Set(
    project.danmakuSourceBindings
      .filter(
        (binding) =>
          binding.sourceMediaId === sourceMediaId &&
          project.assets.some((asset) => asset.id === binding.assetId)
      )
      .map((binding) => binding.assetId)
  );
  return {
    assets: project.assets.filter((asset) => boundAssetIds.has(asset.id)),
    suspectedCutCandidates: suspectedCutCandidates.filter((candidate) =>
      boundAssetIds.has(candidate.assetId)
    )
  };
}

function areCandidateAssetSelectionsEqual(
  left: Record<string, CandidateAssetSelection>,
  right: Record<string, CandidateAssetSelection>
): boolean {
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);
  return (
    leftIds.length === rightIds.length &&
    leftIds.every((candidateId) => {
      const leftSelection = left[candidateId];
      const rightSelection = right[candidateId];
      return (
        rightSelection !== undefined &&
        leftSelection.touched === rightSelection.touched &&
        leftSelection.assetIds.length === rightSelection.assetIds.length &&
        leftSelection.assetIds.every(
          (assetId, index) => assetId === rightSelection.assetIds[index]
        )
      );
    })
  );
}

function confirmedTargetCount(project: EditorProject): number {
  return new Set(
    project.danmakuSourceSegments
      .filter((segment) => segment.kind === "content" && segment.targetMediaId)
      .map((segment) => segment.targetMediaId)
  ).size;
}

function canAnalyzeMedia(media: ProjectMediaReference): boolean {
  return media.connectionState === "connected" && Boolean(media.localPath?.trim());
}

function requireLocalPath(media: ProjectMediaReference): string {
  const path = media.localPath?.trim();
  if (!path) {
    throw new Error(`${media.name} 没有可供 FFmpeg 使用的本地路径，请回素材页重新连接。`);
  }
  return path;
}

function unavailableMediaHint(media: ProjectMediaReference): string {
  if (media.referenceKind === "browserFile") {
    return "临时浏览器引用；自动匹配请回素材页删除后用桌面批量导入";
  }
  return "需要回素材页用本地路径重新连接";
}

function normalizeLocalPath(path: string | null | undefined): string {
  return (
    path?.trim().replace(/\//g, "\\").replace(/\\+/g, "\\").toLocaleLowerCase("en-US") ?? ""
  );
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id];
}

function createMediaPairKey(sourceMediaId: string, targetMediaId: string): string {
  return `${sourceMediaId}\u0000${targetMediaId}`;
}

function batchTaskStateText(state: BatchTaskState): string {
  if (state === "waiting") return "等待";
  if (state === "running") return "分析中";
  if (state === "found") return "已找到";
  if (state === "notFound") return "未找到";
  if (state === "cancelled") return "已取消";
  return "失败";
}

function candidateStateText(state: MediaMatchCandidate["state"]): string {
  if (state === "pending") return "待复核";
  if (state === "accepted") return "已确认";
  if (state === "rejected") return "已忽略";
  return "缺少 XML 绑定";
}

function candidateStateClass(state: MediaMatchCandidate["state"]): string {
  if (state === "accepted")
    return "border-accent-green/40 bg-accent-green/10 text-accent-green";
  if (state === "rejected") return "border-panel-line bg-black/20 text-slate-500";
  if (state === "blocked")
    return "border-accent-yellow/40 bg-accent-yellow/10 text-accent-yellow";
  return "border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan";
}

function setEditorStatus(message: string, tone: "neutral" | "success" | "warning" | "error") {
  useEditorStore.setState({ status: { message, tone } });
}

function waitForPoll(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 350));
}
