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
import {
  assignGlobalMediaMatches,
  type GlobalAssignmentRejectionReason,
  type GlobalMatchHypothesis
} from "../../domain/alignment/globalAssignment";
import { createMediaMatchCandidate } from "../../domain/alignment/mediaMatching";
import {
  assessManualMediaTimeMapVerificationEligibility,
  assessMediaTimeMapVerification
} from "../../domain/alignment/mediaTimeMap";
import {
  validateTimeMap,
  type TimeMapSpan,
  type TimeMapSpanKind
} from "../../domain/alignment/timeMap";
import {
  describeTimeMapSpanReviewAvailability,
  readTimeMapSpanReviewDecision,
  TIME_MAP_SPAN_REVIEW_LABELS,
  type TimeMapSpanReviewDecision
} from "../../domain/alignment/timeMapReviewDecision";
import { readTimeMapSpanPlaybackReview } from "../../domain/alignment/timeMapPlaybackReviewEvidence";
import type { SuspectedCutCandidate } from "../../domain/danmaku/cutHints";
import { createId } from "../../domain/project/factory";
import { findProjectMedia } from "../../domain/project/mediaLibrary";
import { parseSourceTimecode } from "../../domain/project/sourceTimeline";
import type {
  EditorProject,
  MediaMatchCandidate,
  MediaTimeMap,
  MediaTimeMapState,
  MediaTimeMapStreamIdentity,
  ProjectMediaReference
} from "../../domain/project/types";
import { formatTimecode } from "../../domain/shared/time";
import {
  cancelTauriAudioAlignmentBatchJob,
  getTauriAudioAlignmentBatchJob,
  isAudioAlignmentJobFinished,
  startTauriAudioAlignmentBatchJob,
  type AudioAlignmentBatchJobSnapshot,
  type AudioAlignmentBatchPairSnapshot
} from "../../infrastructure/alignment/tauriAudioAlignment";
import { loadAppSettings } from "../../infrastructure/settings/appSettings";
import { isManualVerificationAuthorityAvailable } from "../../infrastructure/media/manualVerificationAuthority";
import { useEditorStore } from "../../stores/editorStore";
import {
  TimeMapPlaybackReview,
  type TimeMapPlaybackAdapterFactory
} from "./TimeMapPlaybackReview";

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

interface StagedPairwiseCandidate {
  pairId: string;
  candidate: MediaMatchCandidate;
  sourceOrderHint: number | null;
  targetOrderHint: number | null;
}

interface ResolvedGlobalCandidate extends StagedPairwiseCandidate {
  adopted: boolean;
  globalMessage: string;
}

interface GlobalBatchResolution {
  candidates: ResolvedGlobalCandidate[];
  adoptedCount: number;
  blockedCount: number;
}

export function MediaMatchingPanel({
  project,
  suspectedCutCandidates,
  playbackAdapterFactory
}: {
  project: EditorProject;
  suspectedCutCandidates: SuspectedCutCandidate[];
  playbackAdapterFactory?: TimeMapPlaybackAdapterFactory;
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
  const [activePlaybackCandidateId, setActivePlaybackCandidateId] = useState<string | null>(
    null
  );
  const activeJobRef = useRef<{ runToken: number; jobId: string } | null>(null);
  const cancelRequestedRef = useRef(false);
  const initializedProjectIdRef = useRef<string | null>(null);
  const sourceSelectionTouchedRef = useRef(false);
  const targetSelectionTouchedRef = useRef(false);
  const addCandidate = useEditorStore((state) => state.addMediaMatchCandidate);
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
    setActivePlaybackCandidateId(null);
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
    if (
      activePlaybackCandidateId &&
      !project.mediaMatchCandidates.some(
        (candidate) => candidate.id === activePlaybackCandidateId
      )
    ) {
      setActivePlaybackCandidateId(null);
    }
  }, [activePlaybackCandidateId, project.mediaMatchCandidates]);

  useEffect(() => {
    if (projectEpochRef.current === projectEpoch) {
      return;
    }
    projectEpochRef.current = projectEpoch;
    batchTokenRef.current += 1;
    cancelRequestedRef.current = true;
    const activeJob = activeJobRef.current;
    if (activeJob) {
      void cancelTauriAudioAlignmentBatchJob(activeJob.jobId)
        .then((snapshot) => {
          if (
            isAudioAlignmentJobFinished(snapshot.status) &&
            activeJobRef.current?.jobId === activeJob.jobId
          ) {
            activeJobRef.current = null;
          }
        })
        .catch(() => undefined);
    }
    sourceSelectionTouchedRef.current = false;
    targetSelectionTouchedRef.current = false;
    setActivePlaybackCandidateId(null);
    setSelectedSourceIds(sourceMedia.filter(canAnalyzeMedia).map((media) => media.id));
    setSelectedTargetIds(targetMedia.filter(canAnalyzeMedia).map((media) => media.id));
    setRunning(false);
    setTasks([]);
  }, [projectEpoch, sourceMedia, targetMedia]);

  useEffect(
    () => () => {
      batchTokenRef.current += 1;
      cancelRequestedRef.current = true;
      const activeJob = activeJobRef.current;
      if (activeJob) {
        void cancelTauriAudioAlignmentBatchJob(activeJob.jobId).catch(() => undefined);
      }
    },
    []
  );

  const pairCount = selectedSourceIds.length * selectedTargetIds.length;
  const pendingCandidates = project.mediaMatchCandidates.filter(
    (candidate) => candidate.state === "pending" || candidate.state === "blocked"
  );
  const hasCancelledTasks = tasks.some((task) => task.state === "cancelled");

  const runBatch = async () => {
    const unfinishedPriorJob = activeJobRef.current;
    if (unfinishedPriorJob) {
      try {
        const stopped = await cancelTauriAudioAlignmentBatchJob(unfinishedPriorJob.jobId);
        if (!isAudioAlignmentJobFinished(stopped.status)) {
          throw new Error("原生批次尚未进入终态");
        }
        if (activeJobRef.current?.jobId === unfinishedPriorJob.jobId) {
          activeJobRef.current = null;
        }
      } catch {
        setEditorStatus(
          "上一次原生批次的清理状态仍不确定，已拒绝启动新任务。请再次尝试；若持续失败，请重启应用以回收媒体进程。",
          "error"
        );
        return;
      }
    }
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
      selectedTargets.map((target) => ({
        source,
        target,
        id: createMediaPairKey(source.id, target.id)
      }))
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
    const sourceOrderById = new Map(
      selectedSources.map((media) => [media.id, semanticEpisodeOrderHint(media)] as const)
    );
    const targetOrderById = new Map(
      selectedTargets.map((media) => [media.id, semanticEpisodeOrderHint(media)] as const)
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
        ? "已有候选或已保存关系，未重复分析"
        : "等待分析",
      jobId: null,
      logs: []
    }));
    setTasks(initialTasks);
    if (pendingPairs.length === 0) {
      setEditorStatus(
        `所选 ${pairs.length} 组素材已有候选或已保存关系，无需重复分析。`,
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
    const stagedCandidates: StagedPairwiseCandidate[] = [];
    let contextInvalidated = false;
    const isBatchContextCurrent = () => {
      if (!isRunCurrent()) {
        return false;
      }
      const currentProject = useEditorStore.getState().project;
      return pendingPairs.every((pair) => {
        const currentSource = findProjectMedia(currentProject, pair.source.id);
        const currentTarget = findProjectMedia(currentProject, pair.target.id);
        return (
          normalizeLocalPath(currentSource?.localPath) ===
            normalizeLocalPath(pair.source.localPath) &&
          normalizeLocalPath(currentTarget?.localPath) ===
            normalizeLocalPath(pair.target.localPath)
        );
      });
    };
    const pendingSourceIds = new Set(pendingPairs.map((pair) => pair.source.id));
    const pendingTargetIds = new Set(pendingPairs.map((pair) => pair.target.id));
    let snapshot: AudioAlignmentBatchJobSnapshot | null = null;
    let batchJobId: string | null = null;
    let batchFailure: string | null = null;
    let cancelSent = false;
    let cleanupUnconfirmed = false;

    try {
      snapshot = await startTauriAudioAlignmentBatchJob({
        sources: selectedSources
          .filter((media) => pendingSourceIds.has(media.id))
          .map((media) => ({ mediaId: media.id, path: requireLocalPath(media) })),
        targets: selectedTargets
          .filter((media) => pendingTargetIds.has(media.id))
          .map((media) => ({ mediaId: media.id, path: requireLocalPath(media) })),
        pairs: pendingPairs.map((pair) => ({
          sourceMediaId: pair.source.id,
          targetMediaId: pair.target.id
        })),
        ffmpegPath: settings.ffmpegPath.trim() || null,
        windowMs: settings.windowMs,
        minGapMs: settings.minGapMs,
        matchThreshold: settings.matchThreshold,
        localizationMode: true
      });
      batchJobId = snapshot.jobId;
      if (!isRunCurrent()) {
        if (!isAudioAlignmentJobFinished(snapshot.status)) {
          void cancelTauriAudioAlignmentBatchJob(snapshot.jobId).catch(() => undefined);
        }
        return;
      }
      activeJobRef.current = { runToken, jobId: snapshot.jobId };
      if (!isBatchContextCurrent()) {
        contextInvalidated = true;
        if (!isAudioAlignmentJobFinished(snapshot.status)) {
          void cancelTauriAudioAlignmentBatchJob(snapshot.jobId).catch(() => undefined);
        }
      } else {
        updateTasksFromBatchSnapshot(snapshot);
      }

      while (
        !contextInvalidated &&
        isRunCurrent() &&
        !isAudioAlignmentJobFinished(snapshot.status)
      ) {
        if (cancelRequestedRef.current && !cancelSent) {
          cancelSent = true;
          try {
            snapshot = await cancelTauriAudioAlignmentBatchJob(snapshot.jobId);
            if (isBatchContextCurrent()) {
              updateTasksFromBatchSnapshot(snapshot);
            }
          } catch (error) {
            batchFailure = error instanceof Error ? error.message : "停止批次时发生错误";
          }
          continue;
        }
        await waitForPoll();
        if (!isRunCurrent()) {
          break;
        }
        if (!isBatchContextCurrent()) {
          contextInvalidated = true;
          const activeJob = activeJobRef.current;
          if (
            activeJob?.runToken === runToken &&
            activeJob.jobId === snapshot.jobId &&
            !isAudioAlignmentJobFinished(snapshot.status)
          ) {
            void cancelTauriAudioAlignmentBatchJob(snapshot.jobId).catch(() => undefined);
          }
          break;
        }
        if (cancelRequestedRef.current && !cancelSent) {
          continue;
        }
        snapshot = await getTauriAudioAlignmentBatchJob(snapshot.jobId);
        if (isBatchContextCurrent()) {
          updateTasksFromBatchSnapshot(snapshot);
        }
      }
    } catch (error) {
      batchFailure = error instanceof Error ? error.message : "批量匹配未能完成";
    } finally {
      const ownsActiveJob =
        activeJobRef.current?.runToken === runToken &&
        activeJobRef.current.jobId === batchJobId;
      if (ownsActiveJob && snapshot && !isAudioAlignmentJobFinished(snapshot.status)) {
        try {
          snapshot = await cancelTauriAudioAlignmentBatchJob(snapshot.jobId);
          if (isBatchContextCurrent()) {
            updateTasksFromBatchSnapshot(snapshot);
          }
        } catch {
          cleanupUnconfirmed = true;
          batchFailure =
            "原生批次清理状态不确定；已保留任务引用并阻止新任务，必要时请重启应用。";
        }
      }
      if (
        ownsActiveJob &&
        !cleanupUnconfirmed &&
        snapshot &&
        isAudioAlignmentJobFinished(snapshot.status)
      ) {
        activeJobRef.current = null;
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
    if (cleanupUnconfirmed) {
      setTasks((current) =>
        current.map((task) =>
          task.state === "waiting" || task.state === "running"
            ? {
                ...task,
                state: "failed",
                progress: 1,
                message: "原生任务清理状态不确定；未应用任何迟到结果"
              }
            : task
        )
      );
      setEditorStatus(batchFailure ?? "原生批次清理状态不确定。", "error");
      setRunning(false);
      return;
    }
    if (!snapshot) {
      const cancelledBeforeStart = cancelRequestedRef.current;
      setTasks((current) =>
        current.map((task) =>
          pendingPairs.some((pair) => pair.id === task.id)
            ? {
                ...task,
                state: cancelledBeforeStart ? "cancelled" : "failed",
                progress: 1,
                message: cancelledBeforeStart
                  ? "未开始，已取消"
                  : (batchFailure ?? "批量匹配未能开始")
              }
            : task
        )
      );
      setEditorStatus(
        cancelledBeforeStart
          ? "批量匹配已取消：任务尚未开始。"
          : `批量匹配未能开始：${batchFailure ?? "未收到原生批任务状态。"}`,
        cancelledBeforeStart ? "warning" : "error"
      );
      setRunning(false);
      return;
    }
    if (snapshot.status === "failed") {
      batchFailure = snapshot.error ?? batchFailure ?? snapshot.message;
    }
    const pairSnapshots = new Map(
      snapshot.pairs.map((pairSnapshot) => [
        createMediaPairKey(pairSnapshot.sourceMediaId, pairSnapshot.targetMediaId),
        pairSnapshot
      ])
    );
    let failedCount = 0;
    let cancelledCount = 0;
    for (const pair of pendingPairs) {
      const pairSnapshot = pairSnapshots.get(createMediaPairKey(pair.source.id, pair.target.id));
      if (!pairSnapshot) {
        if (cancelRequestedRef.current) {
          cancelledCount += 1;
          updateTask(pair.id, { state: "cancelled", progress: 1, message: "未完成，已停止" });
        } else {
          failedCount += 1;
          updateTask(pair.id, {
            state: "failed",
            progress: 1,
            message: batchFailure ?? "这组素材未能完成分析"
          });
        }
        continue;
      }
      if (pairSnapshot.status === "failed") {
        failedCount += 1;
        updateTask(pair.id, batchTaskPatchFromPairSnapshot(pairSnapshot, snapshot.jobId));
        continue;
      }
      if (pairSnapshot.status === "cancelled") {
        cancelledCount += 1;
        updateTask(pair.id, batchTaskPatchFromPairSnapshot(pairSnapshot, snapshot.jobId));
        continue;
      }
      if (pairSnapshot.status !== "completed") {
        if (cancelRequestedRef.current) {
          cancelledCount += 1;
          updateTask(pair.id, { state: "cancelled", progress: 1, message: "未完成，已停止" });
        } else {
          failedCount += 1;
          updateTask(pair.id, {
            state: "failed",
            progress: 1,
            message: batchFailure ?? "这组素材未能完成分析"
          });
        }
        continue;
      }
      if (!pairSnapshot.proposal?.matchRange) {
        updateTask(pair.id, {
          state: "notFound",
          progress: 1,
          message: "没有找到可信对应片段"
        });
        continue;
      }
      const currentProject = useEditorStore.getState().project;
      const proposal = augmentAlignmentProposalWithDanmakuEvidence(
        pairSnapshot.proposal,
        danmakuEvidenceForSource(currentProject, pair.source.id, suspectedCutCandidates)
      );
      const candidate = createMediaMatchCandidate(currentProject, {
        id: createId("media_match_candidate"),
        batchId,
        sourceMediaId: pair.source.id,
        targetMediaId: pair.target.id,
        proposal
      });
      stagedCandidates.push({
        pairId: pair.id,
        candidate,
        sourceOrderHint: sourceOrderById.get(pair.source.id) ?? null,
        targetOrderHint: targetOrderById.get(pair.target.id) ?? null
      });
      updateTask(pair.id, {
        state: "found",
        progress: 1,
        message: `已找到 ${formatTimecode(candidate.sourceStartMs)}–${formatTimecode(candidate.sourceEndMs)}，正在与整批结果比较`
      });
    }
    const globalResolution = resolveGlobalBatch(stagedCandidates);
    globalResolution.candidates.forEach((resolved) => {
      addCandidate(resolved.candidate);
      updateTask(resolved.pairId, {
        state: "found",
        progress: 1,
        message: resolved.globalMessage
      });
    });
    const batchSummary = `找到 ${stagedCandidates.length} 组可能对应片段，其中 ${globalResolution.adoptedCount} 组建议优先复核，${globalResolution.blockedCount} 组需要额外复核`;
    const cancelled =
      snapshot.status === "cancelled" ||
      (cancelRequestedRef.current && !isAudioAlignmentJobFinished(snapshot.status));
    if (cancelled) {
      setEditorStatus(
        `批量匹配已取消：已完成结果中${batchSummary}；${cancelledCount} 组未完成。`,
        "warning"
      );
    } else {
      const skippedCount = pairs.length - pendingPairs.length;
      const summaryPrefix = snapshot.status === "failed" ? "批量匹配提前结束" : "批量匹配完成";
      setEditorStatus(
        `${summaryPrefix}：${batchSummary}${
          skippedCount > 0 ? `，跳过 ${skippedCount} 组已有结果` : ""
        }${failedCount > 0 ? `，${failedCount} 组未能完成分析` : ""}${
          batchFailure ? `；${batchFailure}` : ""
        }。`,
        snapshot.status === "failed" || failedCount > 0 || globalResolution.blockedCount > 0
          ? "warning"
          : "success"
      );
    }
    setRunning(false);
  };

  const cancelBatch = () => {
    cancelRequestedRef.current = true;
    setTasks((current) =>
      current.map((task) =>
        task.state === "waiting" || task.state === "running"
          ? { ...task, message: "正在停止；已经找到的结果会保留" }
          : task
      )
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

  const updateTasksFromBatchSnapshot = (snapshot: AudioAlignmentBatchJobSnapshot) => {
    const pairSnapshots = new Map(
      snapshot.pairs.map((pairSnapshot) => [
        createMediaPairKey(pairSnapshot.sourceMediaId, pairSnapshot.targetMediaId),
        pairSnapshot
      ])
    );
    setTasks((current) =>
      current.map((task) => {
        const pairSnapshot = pairSnapshots.get(
          createMediaPairKey(task.sourceMediaId, task.targetMediaId)
        );
        return pairSnapshot
          ? { ...task, ...batchTaskPatchFromPairSnapshot(pairSnapshot, snapshot.jobId) }
          : task;
      })
    );
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
          {savedRelationTargetCount(project)} / {targetMedia.length} 个原片已有保存关系 ·{" "}
          {pendingCandidates.length} 个候选待复核
        </span>
      </div>
      <p className="mt-2 leading-5 text-slate-500">
        直接使用素材页导入的视频寻找可能对应的片段。自动结果只进入候选队列，请逐项检查参考范围、原片起点和删减修正后再决定是否确认。
      </p>
      <div
        role="alert"
        data-testid="legacy-alignment-warning"
        className="mt-3 rounded border border-amber-400/40 bg-amber-400/10 p-3 leading-5 text-amber-100"
      >
        <div className="font-medium">实验性定位线索</div>
        <p className="mt-1">
          当前旧对齐引擎尚未通过真实媒体精度基准，旧引擎分数未经校准。Alignment V2
          也尚未在冻结真实媒体集完成校准。请以每张卡片的质量等级、实测指标和导出闸门为准；范围、起点和删减修正仍必须逐项试听或预览复核，自动结果不能直接作为导出依据。
        </p>
      </div>

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
          {pairCount} 组；所选组合会合并为一个批次并按顺序检查，界面不会逐组重复启动任务。
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
                playbackOpen={activePlaybackCandidateId === candidate.id}
                onPlaybackOpenChange={(open) =>
                  setActivePlaybackCandidateId(open ? candidate.id : null)
                }
                playbackAdapterFactory={playbackAdapterFactory}
              />
            ))}
        </div>
      )}

      <ConfirmedRelations project={project} />
    </section>
  );
}

function batchTaskPatchFromPairSnapshot(
  snapshot: AudioAlignmentBatchPairSnapshot,
  jobId: string | null
): Partial<BatchTask> {
  const base = {
    jobId,
    progress: snapshot.progress,
    logs: snapshot.message ? [snapshot.message] : []
  };
  if (snapshot.status === "queued") {
    return { ...base, state: "waiting", message: "等待前面的组合完成" };
  }
  if (snapshot.status === "running") {
    return { ...base, state: "running", message: "正在寻找可能对应的片段" };
  }
  if (snapshot.status === "failed") {
    return {
      ...base,
      state: "failed",
      progress: 1,
      message: snapshot.error ?? "这组素材未能完成分析"
    };
  }
  if (snapshot.status === "cancelled") {
    return { ...base, state: "cancelled", progress: 1, message: "未完成，已停止" };
  }
  if (!snapshot.proposal?.matchRange) {
    return { ...base, state: "notFound", progress: 1, message: "没有找到可信对应片段" };
  }
  return {
    ...base,
    state: "found",
    progress: 1,
    message: `已找到 ${formatTimecode(snapshot.proposal.matchRange.sourceStartMs)}–${formatTimecode(snapshot.proposal.matchRange.sourceEndMs)}，等待整批比较`
  };
}

function resolveGlobalBatch(
  stagedCandidates: readonly StagedPairwiseCandidate[]
): GlobalBatchResolution {
  if (stagedCandidates.length === 0) {
    return { candidates: [], adoptedCount: 0, blockedCount: 0 };
  }
  const assignment = assignGlobalMediaMatches(
    stagedCandidates.map(createGlobalMatchHypothesis)
  );
  const selectedIds = new Set(assignment.selectedIds);
  const rejectionById = new Map(
    assignment.rejected.map((rejection) => [rejection.id, rejection] as const)
  );
  const runnerUpIds = new Set(assignment.runnerUpIds ?? []);
  const ambiguityCandidateIds = new Set<string>();
  if (assignment.ambiguous) {
    if (assignment.runnerUpIds === null) {
      stagedCandidates.forEach((staged) => ambiguityCandidateIds.add(staged.candidate.id));
    } else {
      stagedCandidates.forEach((staged) => {
        const id = staged.candidate.id;
        if (selectedIds.has(id) !== runnerUpIds.has(id)) {
          ambiguityCandidateIds.add(id);
        }
      });
    }
  }
  const ambiguityReason = assignment.ambiguous
    ? `两套可行组合的把握接近（差距 ${formatQualityRatio(assignment.normalizedMargin)}），目前无法唯一确定，需人工复核。`
    : null;
  let adoptedCount = 0;
  const candidates = stagedCandidates.map((staged): ResolvedGlobalCandidate => {
    const isAmbiguousAlternative = ambiguityCandidateIds.has(staged.candidate.id);
    const adopted = selectedIds.has(staged.candidate.id) && !isAmbiguousAlternative;
    const rangeText = `${formatTimecode(staged.candidate.sourceStartMs)}–${formatTimecode(staged.candidate.sourceEndMs)}`;
    if (adopted) {
      adoptedCount += 1;
      return {
        ...staged,
        adopted: true,
        candidate: appendCandidateDiagnostic(
          staged.candidate,
          "全局分配：进入本批次最佳无冲突组合。"
        ),
        globalMessage: `已找到 ${rangeText}；建议优先复核`
      };
    }

    const rejection = rejectionById.get(staged.candidate.id);
    const reason =
      (isAmbiguousAlternative ? ambiguityReason : null) ??
      describeGlobalRejection(
        rejection?.reason ?? "notInBestCombination",
        rejection?.conflictsWith.length ?? 0
      );
    const resolvedCandidate =
      rejection?.reason === "blocked"
        ? staged.candidate
        : blockCandidateForGlobalReview(staged.candidate, reason);
    const globalMessage =
      rejection?.reason === "blocked"
        ? `已找到 ${rangeText}；证据不足，暂不建议采用`
        : `已找到 ${rangeText}；与其他结果冲突，作为备选保留：${reason}`;
    return {
      ...staged,
      adopted: false,
      // A central quality block can be resolved by the existing per-span review workflow.
      // Do not add a second, persistent global blocker that manual review cannot clear.
      candidate: resolvedCandidate,
      globalMessage
    };
  });
  return {
    candidates,
    adoptedCount,
    blockedCount: candidates.length - adoptedCount
  };
}

function createGlobalMatchHypothesis(staged: StagedPairwiseCandidate): GlobalMatchHypothesis {
  const { candidate } = staged;
  const timeMap = candidate.proposal.timeMap;
  const quality = timeMap?.quality;
  return {
    id: candidate.id,
    alternativeGroupId: createMediaPairKey(candidate.sourceMediaId, candidate.targetMediaId),
    sourceMediaId: candidate.sourceMediaId,
    targetMediaId: candidate.targetMediaId,
    sourceStartMs: timeMap?.sourceStartMs ?? candidate.sourceStartMs,
    sourceEndMs: timeMap?.sourceEndMs ?? candidate.sourceEndMs,
    targetStartMs: timeMap?.targetStartMs ?? candidate.targetStartMs,
    targetEndMs: timeMap?.targetEndMs ?? candidate.targetEndMs,
    score: clampUnitScore(quality?.probability ?? quality?.coverage ?? candidate.confidence),
    uniqueCoverage: clampUnitScore(
      timeMap?.evidence.uniqueContentCoverage ??
        quality?.coverage ??
        candidate.proposal.matchRange?.coverage ??
        0
    ),
    alternativeMargin: clampUnitScore(quality?.alternativeMargin ?? 0),
    repeatedContentOnly: timeMap?.evidence.repeatedContentOnly ?? false,
    // A reviewable ambiguous span is a candidate result, not a globally invalid hypothesis.
    // Only the central quality gate may exclude the whole hypothesis before assignment.
    blocked: quality?.level === "blocked",
    sourceOrderHint: staged.sourceOrderHint,
    targetOrderHint: staged.targetOrderHint
  };
}

function describeGlobalRejection(
  reason: GlobalAssignmentRejectionReason,
  conflictCount: number
): string {
  if (reason === "samePairAlternative") {
    return `同一素材组合只能采用一个定位答案；此项与 ${conflictCount} 个已采用答案互斥，已保留供复核。`;
  }
  if (reason === "sourceOverlap") {
    return `同一参考时间范围冲突（与 ${conflictCount} 个优先结果冲突），此项需单独复核。`;
  }
  if (reason === "targetOverlap") {
    return `同一原片时间范围冲突（与 ${conflictCount} 个优先结果冲突），此项需单独复核。`;
  }
  if (reason === "blocked") {
    return "这组定位证据不足，暂不建议采用。";
  }
  return "另一个整体组合更可信，此结果已作为备选保留。";
}

function appendCandidateDiagnostic(
  candidate: MediaMatchCandidate,
  diagnostic: string
): MediaMatchCandidate {
  return {
    ...candidate,
    proposal: {
      ...candidate.proposal,
      diagnostics: appendUniqueText(candidate.proposal.diagnostics, diagnostic)
    }
  };
}

function blockCandidateForGlobalReview(
  candidate: MediaMatchCandidate,
  reason: string
): MediaMatchCandidate {
  const existingTimeMap = candidate.proposal.timeMap;
  const timeMap: NonNullable<MediaMatchCandidate["proposal"]["timeMap"]> = existingTimeMap
    ? {
        ...existingTimeMap,
        quality: {
          ...existingTimeMap.quality,
          level: "blocked",
          probability: null,
          reasons: appendUniqueText(existingTimeMap.quality.reasons, reason)
        },
        evidence: {
          ...existingTimeMap.evidence,
          notes: appendUniqueText(existingTimeMap.evidence.notes, reason)
        }
      }
    : createLegacyGlobalBlockTimeMap(candidate, reason);
  return {
    ...candidate,
    state: "blocked",
    proposal: {
      ...candidate.proposal,
      diagnostics: appendUniqueText(candidate.proposal.diagnostics, `全局分配阻断：${reason}`),
      timeMap
    }
  };
}

function createLegacyGlobalBlockTimeMap(
  candidate: MediaMatchCandidate,
  reason: string
): NonNullable<MediaMatchCandidate["proposal"]["timeMap"]> {
  const coverage = candidate.proposal.matchRange?.coverage ?? null;
  return {
    sourceStartMs: candidate.sourceStartMs,
    sourceEndMs: candidate.sourceEndMs,
    targetStartMs: candidate.targetStartMs,
    targetEndMs: candidate.targetEndMs,
    spans: [
      {
        kind: "ambiguous",
        sourceStartMs: candidate.sourceStartMs,
        sourceEndMs: candidate.sourceEndMs,
        targetStartMs: candidate.targetStartMs,
        targetEndMs: candidate.targetEndMs
      }
    ],
    quality: {
      level: "blocked",
      probability: null,
      metricSource: coverage === null ? "missing" : "estimated",
      coverage,
      p50ResidualMs: null,
      p95ResidualMs: null,
      maxResidualMs: null,
      boundaryUncertaintyMs: null,
      alternativeMargin: null,
      anchorCount: candidate.proposal.anchors.length,
      heldOutAnchorCount: 0,
      reasons: [reason]
    },
    evidence: {
      types: ["legacy"],
      audioAnchorCount: 0,
      visualAnchorCount: 0,
      heldOutAnchorCount: 0,
      top1Top2Margin: null,
      notes: [reason]
    },
    sourceStream: null,
    targetStream: null,
    sourceIdentity: null,
    targetIdentity: null,
    engineVersion: "legacy-global-guard-v1",
    featureVersion: "legacy-global-guard-v1",
    parametersHash: `legacy-global-guard:${candidate.id}`
  };
}

function appendUniqueText(lines: readonly string[], line: string): string[] {
  return lines.includes(line) ? [...lines] : [...lines, line];
}

function clampUnitScore(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
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
  onSelectedAssetIdsChange,
  playbackOpen,
  onPlaybackOpenChange,
  playbackAdapterFactory
}: {
  candidate: MediaMatchCandidate;
  project: EditorProject;
  selectedAssetIds: string[];
  onSelectedAssetIdsChange: (assetIds: string[]) => void;
  playbackOpen: boolean;
  onPlaybackOpenChange: (open: boolean) => void;
  playbackAdapterFactory?: TimeMapPlaybackAdapterFactory;
}) {
  const source = findProjectMedia(project, candidate.sourceMediaId);
  const target = findProjectMedia(project, candidate.targetMediaId);
  const candidateTimeMap = project.mediaTimeMaps.find(
    (item) => item.id === candidate.timeMapId
  );
  const confirmedTimeMap = candidate.confirmedTimeMapId
    ? project.mediaTimeMaps.find((item) => item.id === candidate.confirmedTimeMapId)
    : undefined;
  const displayedTimeMap = candidate.state === "accepted" ? confirmedTimeMap : candidateTimeMap;
  const displayedTimeMapState = candidate.state === "accepted" ? "confirmed" : "candidate";
  const timeMapGate = describeTimeMapGate(candidateTimeMap, "candidate");
  const displayedTimeMapGate = describeTimeMapGate(displayedTimeMap, displayedTimeMapState);
  const acceptLabel = timeMapGate.exportReady
    ? "确认关系并用于导出"
    : timeMapGate.canSaveRelationship
      ? "保存关系供试听复核"
      : "此候选不能确认";
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
    if (!timeMapGate.canSaveRelationship) {
      setEditorStatus(timeMapGate.message, "warning");
      return;
    }
    if (!saveRange()) {
      return;
    }
    const currentProject = useEditorStore.getState().project;
    const currentCandidate = currentProject.mediaMatchCandidates.find(
      (item) => item.id === candidate.id
    );
    const currentTimeMap = currentCandidate
      ? currentProject.mediaTimeMaps.find((item) => item.id === currentCandidate.timeMapId)
      : undefined;
    const currentGate = describeTimeMapGate(currentTimeMap, "candidate");
    if (!currentGate.canSaveRelationship) {
      setEditorStatus(currentGate.message, "warning");
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
          className={`rounded border px-2 py-0.5 text-[11px] ${candidateStateClass(candidate.state, displayedTimeMapGate.exportReady)}`}
        >
          {candidateStateText(candidate, displayedTimeMapGate.exportReady)}
        </span>
        <span className="rounded border border-panel-line px-2 py-0.5 text-[11px] text-slate-400">
          {candidate.proposal.timeMap
            ? `定位线索分数 ${Math.round(candidate.confidence * 100)}% · 不是校准概率`
            : `旧引擎分数 ${Math.round(candidate.confidence * 100)}% · 未校准`}
        </span>
      </div>

      <TimeMapQualitySummary
        timeMap={displayedTimeMap}
        expectedState={displayedTimeMapState}
        testId="candidate-time-map-quality"
      />

      <TimeMapReview
        timeMap={displayedTimeMap}
        relationState={candidate.state === "accepted" ? "accepted" : "candidate"}
        sourceMedia={source}
        targetMedia={target}
        playbackOpen={playbackOpen}
        onPlaybackOpenChange={onPlaybackOpenChange}
        playbackAdapterFactory={playbackAdapterFactory}
      />

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
              disabled={
                selectedAssetIds.length === 0 ||
                candidate.state === "blocked" ||
                !timeMapGate.canSaveRelationship
              }
              onClick={accept}
            >
              <CircleCheck size={13} />
              {acceptLabel}
            </TextButton>
          </div>
        </>
      ) : null}

      {candidate.state === "accepted" ? (
        <>
          {confirmedTimeMap ? (
            <ManualTimeMapVerificationControls timeMap={confirmedTimeMap} />
          ) : null}
          <div className="mt-3 flex justify-end">
            <TextButton onClick={() => void revokeAcceptance(candidate.id)}>
              <RotateCcw size={13} />
              撤销确认并删除来源段
            </TextButton>
          </div>
        </>
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

const MANUAL_VERIFICATION_ARTIFACT_ID = "manual-a-b-review";
const MANUAL_VERIFICATION_ARTIFACT_VERSION = "1";
const MANUAL_VERIFIER = "本机用户";

function ManualTimeMapVerificationControls({ timeMap }: { timeMap: MediaTimeMap }) {
  const issueManualVerification = useEditorStore(
    (state) => state.issueManualMediaTimeMapVerification
  );
  const revokeManualVerification = useEditorStore(
    (state) => state.revokeManualMediaTimeMapVerification
  );
  const [busy, setBusy] = useState(false);
  const persistedRecord =
    timeMap.verification?.recordVersion === 2 && timeMap.verification.revocation === null
      ? timeMap.verification
      : null;
  const verificationAssessment = assessMediaTimeMapVerification(timeMap);
  const trustedRecord =
    persistedRecord && verificationAssessment.trusted ? persistedRecord : null;
  const desktopAvailable = isManualVerificationAuthorityAvailable();
  const preflightInput = {
    calibrationArtifactId: MANUAL_VERIFICATION_ARTIFACT_ID,
    calibrationArtifactVersion: MANUAL_VERIFICATION_ARTIFACT_VERSION,
    verifier: MANUAL_VERIFIER,
    verifiedAt: new Date().toISOString()
  };
  const eligibility = assessManualMediaTimeMapVerificationEligibility(timeMap, preflightInput);
  const disabledReason = !desktopAvailable
    ? "安装级人工验证只在 Tauri 桌面端可用；浏览器预览不能签发或撤销凭据。"
    : eligibility.reason;

  const issue = async () => {
    if (!desktopAvailable || !eligibility.eligible || busy) {
      return;
    }
    setBusy(true);
    try {
      await issueManualVerification(timeMap.id, {
        ...preflightInput,
        verifiedAt: new Date().toISOString()
      });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!desktopAvailable || !trustedRecord || busy) {
      return;
    }
    setBusy(true);
    try {
      await revokeManualVerification(timeMap.id, {
        reason: "用户在匹配页撤销了人工 A/B 复核验证。",
        revokedBy: MANUAL_VERIFIER,
        revokedAt: new Date().toISOString()
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mt-3 rounded border border-emerald-400/25 bg-emerald-400/5 p-2.5 text-[11px]"
      data-testid="manual-time-map-verification"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-200">整图人工验证</span>
        {trustedRecord ? (
          <span className="rounded border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-emerald-100">
            本机签名已验证
          </span>
        ) : persistedRecord ? (
          <span className="rounded border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-amber-100">
            签名记录未在本机受信
          </span>
        ) : null}
        {trustedRecord ? (
          <TextButton
            className="ml-auto"
            tone="danger"
            disabled={!desktopAvailable || busy}
            onClick={() => void revoke()}
          >
            撤销人工验证
          </TextButton>
        ) : (
          <TextButton
            className="ml-auto"
            tone="primary"
            disabled={!desktopAvailable || !eligibility.eligible || busy}
            onClick={() => void issue()}
          >
            完成复核并签发
          </TextButton>
        )}
      </div>
      <p className="mt-1.5 leading-5 text-slate-400">
        只有明确点击后，应用才会把分段人工分类、当前 revision
        与媒体身份交给本机安装级验证机构签名；自动匹配和保存关系都不会触发签发。
      </p>
      {trustedRecord ? (
        <p className="mt-1 leading-5 text-slate-500">
          签发人：{trustedRecord.verifier} · 时间：
          {new Date(trustedRecord.verifiedAt).toLocaleString("zh-CN")} · 凭据：
          {trustedRecord.verificationId}
        </p>
      ) : persistedRecord ? (
        <p className="mt-1 leading-5 text-amber-200" role="status">
          当前签名不能作为导出依据：
          {verificationAssessment.reason ?? "本机验证机构尚未确认该签名。"}
          {eligibility.eligible ? " 可在完整复核后重新签发。" : ` ${eligibility.reason ?? ""}`}
        </p>
      ) : disabledReason ? (
        <p className="mt-1 leading-5 text-amber-200" role="status">
          当前不能签发：{disabledReason}
        </p>
      ) : (
        <p className="mt-1 leading-5 text-emerald-100">
          已通过签发预检；请确认已完成所有 A/B 试听，再点击签发。
        </p>
      )}
    </section>
  );
}

type TimeMapGateKind =
  "verified" | "review" | "blocked" | "legacy-unverified" | "missing" | "state-error";

interface TimeMapGateDescription {
  kind: TimeMapGateKind;
  label: string;
  message: string;
  canSaveRelationship: boolean;
  exportReady: boolean;
}

function TimeMapQualitySummary({
  timeMap,
  expectedState,
  testId
}: {
  timeMap: MediaTimeMap | undefined;
  expectedState: Extract<MediaTimeMapState, "candidate" | "confirmed">;
  testId: string;
}) {
  const gate = describeTimeMapGate(timeMap, expectedState);
  const panelClass = gate.exportReady
    ? "border-emerald-400/35 bg-emerald-400/10 text-emerald-100"
    : gate.canSaveRelationship
      ? "border-amber-400/35 bg-amber-400/10 text-amber-100"
      : "border-red-400/35 bg-red-400/10 text-red-100";
  const badgeClass = gate.exportReady
    ? "border-emerald-300/50 bg-emerald-300/10 text-emerald-100"
    : gate.canSaveRelationship
      ? "border-amber-300/50 bg-amber-300/10 text-amber-100"
      : "border-red-300/50 bg-red-300/10 text-red-100";
  const spanCounts = { matched: 0, sourceOnly: 0, targetOnly: 0, ambiguous: 0 };
  timeMap?.spans.forEach((span) => {
    spanCounts[span.kind] += 1;
  });

  return (
    <section
      className={`mt-3 rounded border p-2.5 ${panelClass}`}
      data-testid={testId}
      role={
        gate.kind === "blocked" || gate.kind === "missing" || gate.kind === "state-error"
          ? "alert"
          : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded border px-2 py-0.5 text-[11px] font-medium ${badgeClass}`}
          data-testid="time-map-quality-label"
        >
          {gate.label}
        </span>
        <span className="text-[11px] font-medium">
          导出闸门：{gate.exportReady ? "通过" : "未通过"}
        </span>
      </div>
      <p className="mt-1 leading-5">{gate.message}</p>

      {timeMap ? (
        <details className="mt-2 rounded border border-current/20 bg-black/10 p-2 text-[11px]">
          <summary className="cursor-pointer rounded font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan">
            时间图证据详情
          </summary>
          <div className="mt-2 grid gap-1.5 text-slate-300">
            <div>
              引擎 / 特征：{timeMap.engineVersion || "未记录"} /{" "}
              {timeMap.featureVersion || "未记录"}
            </div>
            <div>
              校准概率：
              {timeMap.quality.probability === null
                ? "尚未完成真实基准校准"
                : formatQualityRatio(timeMap.quality.probability)}
            </div>
            <div>
              覆盖率：{formatQualityRatio(timeMap.quality.coverage)} · P95 残差：
              {formatQualityMilliseconds(timeMap.quality.p95ResidualMs)} · 边界不确定度：
              {formatQualityMilliseconds(timeMap.quality.boundaryUncertaintyMs)} · Top1/Top2
              差距：{formatQualityRatio(timeMap.quality.alternativeMargin)}
            </div>
            <div>
              时间图片段：matched {spanCounts.matched} · sourceOnly {spanCounts.sourceOnly} ·
              targetOnly {spanCounts.targetOnly} · ambiguous {spanCounts.ambiguous}
            </div>
            <div>
              选中音轨：{formatSelectedStream(timeMap.sourceStream, "参考")}；
              {formatSelectedStream(timeMap.targetStream, "原片")}
            </div>
            <div className="pt-1 font-medium text-slate-200">主要质量原因</div>
            {timeMap.quality.reasons.length > 0 ? (
              <ul className="list-disc space-y-1 pl-4">
                {timeMap.quality.reasons.slice(0, 4).map((reason, index) => (
                  <li key={`${timeMap.id}-quality-reason-${index}`}>{reason}</li>
                ))}
              </ul>
            ) : (
              <p>没有补充原因；请结合实测指标和试听结果判断。</p>
            )}
          </div>
        </details>
      ) : null}
    </section>
  );
}

const TIME_MAP_SPAN_LABELS: Record<TimeMapSpanKind, string> = {
  matched: "共同内容",
  sourceOnly: "参考独有",
  targetOnly: "原片独有",
  ambiguous: "无法判断"
};

interface TimeMapReviewValidation {
  valid: boolean;
  message: string | null;
}

/**
 * 匹配页用真实媒体完成 A/B 切换、区间循环和差异分类，但不会因此自动签发整图验证。
 * 两条轨道分别按自己的完整范围归一化，因此同一屏幕宽度不代表双方真实时长相同。
 */
function TimeMapReview({
  timeMap,
  relationState,
  sourceMedia,
  targetMedia,
  playbackOpen,
  onPlaybackOpenChange,
  playbackAdapterFactory
}: {
  timeMap: MediaTimeMap | undefined;
  relationState: "candidate" | "accepted";
  sourceMedia: ProjectMediaReference | null | undefined;
  targetMedia: ProjectMediaReference | null | undefined;
  playbackOpen: boolean;
  onPlaybackOpenChange: (open: boolean) => void;
  playbackAdapterFactory?: TimeMapPlaybackAdapterFactory;
}) {
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const setPlaying = useEditorStore((state) => state.setPlaying);
  const reviewCandidateTimeMapSpan = useEditorStore(
    (state) => state.reviewCandidateTimeMapSpan
  );
  const [selectedSpanIndex, setSelectedSpanIndex] = useState(0);
  const onPlaybackOpenChangeRef = useRef(onPlaybackOpenChange);

  useEffect(() => {
    onPlaybackOpenChangeRef.current = onPlaybackOpenChange;
  }, [onPlaybackOpenChange]);

  useEffect(() => {
    setSelectedSpanIndex(0);
  }, [timeMap?.id]);

  useEffect(() => {
    onPlaybackOpenChangeRef.current(false);
  }, [timeMap?.id, timeMap?.revision]);

  if (!timeMap) {
    return (
      <section
        className="mt-3 rounded border border-red-400/35 bg-red-400/10 p-2.5 text-red-100"
        data-testid="time-map-review"
        role="alert"
      >
        <div className="font-medium">来源↔原片时间图复核</div>
        <p className="mt-1 leading-5">
          {relationState === "accepted" ? "已保存关系的" : "候选"}
          时间图缺失，无法安全绘制或定位分段。请重新分析这组素材。
        </p>
      </section>
    );
  }

  const validation = validateTimeMapForReview(timeMap);
  if (!validation.valid) {
    return (
      <section
        className="mt-3 rounded border border-red-400/35 bg-red-400/10 p-2.5 text-red-100"
        data-testid="time-map-review"
        role="alert"
      >
        <div className="font-medium">来源↔原片时间图复核</div>
        <p className="mt-1 leading-5">
          时间图结构无效，已停止绘制和定位，避免按错误范围复核。
          {validation.message ? ` ${validation.message}` : ""}
        </p>
      </section>
    );
  }

  const spanCounts = countTimeMapSpans(timeMap.spans);
  const safeSelectedSpanIndex = Math.min(selectedSpanIndex, timeMap.spans.length - 1);
  const selectedSpan = timeMap.spans[safeSelectedSpanIndex];
  const blockingReason =
    timeMap.quality.level === "blocked" ||
    timeMap.spans.some((span) => span.kind === "ambiguous")
      ? timeMap.quality.reasons.slice(0, 3).join("；") ||
        "存在无法唯一判断的内容，当前时间图不能用于导出。"
      : null;

  const locateSpan = (span: TimeMapSpan, spanIndex: number) => {
    setSelectedSpanIndex(spanIndex);
    setPlaying(false);
    setPlayhead(span.sourceStartMs);
    const positionedMs = useEditorStore.getState().project.timeline.playheadMs;
    const label = TIME_MAP_SPAN_LABELS[span.kind];
    if (positionedMs !== span.sourceStartMs) {
      setEditorStatus(
        `当前编辑时间轴只能定位到参考 ${formatTimecode(positionedMs)}；第 ${spanIndex + 1} 段“${label}”起点为 ${formatTimecode(span.sourceStartMs)}。已选择 A/B 复核区间，尚未开始播放。`,
        "warning"
      );
      return;
    }
    setEditorStatus(
      `已选择第 ${spanIndex + 1} 段“${label}”作为 A/B 复核区间，并将编辑页指针定位到参考 ${formatTimecode(span.sourceStartMs)}；点击“打开 A/B 复核”后播放。`,
      "neutral"
    );
  };

  return (
    <details
      className="mt-3 rounded border border-panel-line/70 bg-black/10 p-2.5 text-[11px] text-slate-400"
      data-testid="time-map-review"
      onToggle={(event) => {
        if (!event.currentTarget.open && playbackOpen) {
          onPlaybackOpenChange(false);
        }
      }}
    >
      <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan">
        <span className="font-medium text-slate-200">来源↔原片时间图复核</span>
        <span className="ml-2 text-slate-500">
          {relationState === "accepted"
            ? timeMap.quality.level === "verified"
              ? "已验证 · 可导出 · "
              : "关系已保存 / 待完成复核 · "
            : "候选图 · "}
          共同内容 {spanCounts.matched} · 参考独有 {spanCounts.sourceOnly} · 原片独有{" "}
          {spanCounts.targetOnly} · 无法判断 {spanCounts.ambiguous}
        </span>
      </summary>

      <div className="mt-3 grid gap-3">
        <p className="leading-5 text-slate-400">
          两条轨道按各自完整范围铺满，宽度只表示内容在本方时间轴中的位置。先选择要核对的分段，再打开
          A/B 复核；共同内容按 TimeMap 同步切换，差异内容不会被强行映射。
        </p>

        <TimeMapPlaybackReview
          timeMap={timeMap}
          span={selectedSpan}
          spanIndex={safeSelectedSpanIndex}
          timeMapId={timeMap.id}
          relationState={relationState}
          persistedReview={Boolean(
            readTimeMapSpanPlaybackReview(timeMap, safeSelectedSpanIndex)
          )}
          sourceMapRange={{
            startMs: timeMap.sourceStartMs,
            endMs: timeMap.sourceEndMs
          }}
          targetMapRange={{
            startMs: timeMap.targetStartMs,
            endMs: timeMap.targetEndMs
          }}
          sourceMedia={sourceMedia}
          targetMedia={targetMedia}
          open={playbackOpen}
          onOpenChange={onPlaybackOpenChange}
          adapterFactory={playbackAdapterFactory}
        />

        <div
          className="grid gap-2 rounded border border-panel-line/70 bg-black/20 p-2"
          role="img"
          aria-label="来源与原片双时间轴分段图"
        >
          <TimeMapTrack
            label="参考轨道"
            rangeStartMs={timeMap.sourceStartMs}
            rangeEndMs={timeMap.sourceEndMs}
            spans={timeMap.spans}
            axis="source"
          />
          <TimeMapTrack
            label="原片轨道"
            rangeStartMs={timeMap.targetStartMs}
            rangeEndMs={timeMap.targetEndMs}
            spans={timeMap.spans}
            axis="target"
          />
        </div>

        <div className="flex flex-wrap gap-x-3 gap-y-1" aria-label="时间图图例">
          {(Object.keys(TIME_MAP_SPAN_LABELS) as TimeMapSpanKind[]).map((kind) => (
            <span key={kind} className="inline-flex items-center gap-1.5">
              <span
                className={`h-2.5 w-2.5 rounded-sm border ${timeMapSpanColor(kind)}`}
                aria-hidden="true"
              />
              {TIME_MAP_SPAN_LABELS[kind]}
            </span>
          ))}
        </div>

        {blockingReason ? (
          <p
            className="rounded border border-red-400/30 bg-red-400/10 p-2 leading-5 text-red-100"
            role="alert"
          >
            导出阻断原因：{blockingReason}
          </p>
        ) : null}

        <ol className="grid gap-1.5" aria-label="时间图分段复核列表">
          {timeMap.spans.map((span, spanIndex) => (
            <li key={`${timeMap.id}-review-span-${spanIndex}`}>
              <button
                type="button"
                className={`grid w-full gap-1 rounded border px-2.5 py-2 text-left text-slate-300 transition-colors hover:border-slate-500 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan ${
                  safeSelectedSpanIndex === spanIndex
                    ? "border-accent-cyan bg-accent-cyan/10"
                    : "border-panel-line/70 bg-black/15"
                }`}
                aria-label={createTimeMapSpanAccessibleName(span, spanIndex)}
                aria-pressed={safeSelectedSpanIndex === spanIndex}
                onClick={() => locateSpan(span, spanIndex)}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded border px-1.5 py-0.5 font-medium ${timeMapSpanBadgeColor(span.kind)}`}
                  >
                    第 {spanIndex + 1} 段 · {TIME_MAP_SPAN_LABELS[span.kind]}
                  </span>
                  <span>伸缩比例：{formatTimeMapStretchRatio(span)}</span>
                </span>
                <span>
                  参考 {formatTimeMapRange(span.sourceStartMs, span.sourceEndMs)} ↔ 原片{" "}
                  {formatTimeMapRange(span.targetStartMs, span.targetEndMs)}
                </span>
                <span className="text-slate-500">
                  边界不确定度：
                  {formatQualityMilliseconds(timeMap.quality.boundaryUncertaintyMs)} · P95
                  残差：{formatQualityMilliseconds(timeMap.quality.p95ResidualMs)}
                </span>
                {span.kind === "ambiguous" ? (
                  <span className="text-red-200">
                    阻断原因：{blockingReason ?? "这一段无法唯一判断，不能安全投影弹幕。"}
                  </span>
                ) : null}
              </button>
              {relationState === "candidate" && span.kind !== "matched" ? (
                <TimeMapSpanReviewControls
                  timeMap={timeMap}
                  span={span}
                  spanIndex={spanIndex}
                  onReview={(decision) =>
                    reviewCandidateTimeMapSpan(timeMap.id, spanIndex, decision)
                  }
                />
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}

const TIME_MAP_REVIEW_DECISIONS: readonly TimeMapSpanReviewDecision[] = [
  "source-extra",
  "target-extra",
  "replacement",
  "unresolved"
];

function TimeMapSpanReviewControls({
  timeMap,
  span,
  spanIndex,
  onReview
}: {
  timeMap: MediaTimeMap;
  span: TimeMapSpan;
  spanIndex: number;
  onReview: (decision: TimeMapSpanReviewDecision) => void;
}) {
  const recorded = readTimeMapSpanReviewDecision(timeMap, spanIndex);
  const unavailableReasons = new Set<string>();
  const options = TIME_MAP_REVIEW_DECISIONS.map((decision) => {
    const availability = describeTimeMapSpanReviewAvailability(span, decision);
    if (!availability.allowed) {
      unavailableReasons.add(availability.reason);
    }
    return { decision, availability };
  });
  return (
    <fieldset className="mt-1 rounded border border-panel-line/60 bg-black/20 p-2">
      <legend className="px-1 font-medium text-slate-400">人工判定这一段</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map(({ decision, availability }) => (
          <TextButton
            key={decision}
            className="h-7 px-2 text-[11px]"
            tone={recorded?.decision === decision ? "primary" : "neutral"}
            disabled={!availability.allowed}
            aria-pressed={recorded?.decision === decision}
            title={availability.reason}
            onClick={() => onReview(decision)}
          >
            {TIME_MAP_SPAN_REVIEW_LABELS[decision]}
          </TextButton>
        ))}
      </div>
      <p className="mt-1.5 leading-5 text-slate-500">
        {recorded
          ? `已保存：${TIME_MAP_SPAN_REVIEW_LABELS[recorded.decision]} · ${new Date(recorded.reviewedAt).toLocaleString("zh-CN")}`
          : "尚未人工分类；当前颜色只是算法候选结果。"}
      </p>
      {unavailableReasons.size > 0 ? (
        <p className="mt-1 leading-5 text-amber-200">
          灰色选项不会改写边界：{[...unavailableReasons].join("；")}
        </p>
      ) : null}
    </fieldset>
  );
}

function TimeMapTrack({
  label,
  rangeStartMs,
  rangeEndMs,
  spans,
  axis
}: {
  label: "参考轨道" | "原片轨道";
  rangeStartMs: number;
  rangeEndMs: number;
  spans: readonly TimeMapSpan[];
  axis: "source" | "target";
}) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2">
      <div>
        <div className="font-medium text-slate-300">{label}</div>
        <div className="mt-0.5 text-[10px] text-slate-500">
          {formatTimecode(rangeStartMs)}–{formatTimecode(rangeEndMs)}
        </div>
      </div>
      <div className="relative h-7 overflow-hidden rounded border border-panel-line bg-slate-950">
        {spans.map((span, spanIndex) => {
          const startMs = axis === "source" ? span.sourceStartMs : span.targetStartMs;
          const endMs = axis === "source" ? span.sourceEndMs : span.targetEndMs;
          const style = createNormalizedTrackStyle(startMs, endMs, rangeStartMs, rangeEndMs);
          return (
            <span
              key={`${label}-${spanIndex}`}
              className={`absolute inset-y-1 rounded-sm border ${timeMapSpanColor(span.kind)}`}
              style={style}
              title={`第 ${spanIndex + 1} 段 · ${TIME_MAP_SPAN_LABELS[span.kind]}`}
              aria-hidden="true"
            />
          );
        })}
      </div>
    </div>
  );
}

function validateTimeMapForReview(timeMap: MediaTimeMap): TimeMapReviewValidation {
  if (
    !isValidReviewRange(timeMap.sourceStartMs, timeMap.sourceEndMs) ||
    !isValidReviewRange(timeMap.targetStartMs, timeMap.targetEndMs)
  ) {
    return { valid: false, message: "时间图总范围不是有效的非负整数毫秒区间。" };
  }
  if (timeMap.spans.length === 0) {
    return { valid: false, message: "时间图没有任何内容分段。" };
  }
  const spanValidation = validateTimeMap(timeMap.spans);
  if (!spanValidation.valid) {
    return { valid: false, message: spanValidation.issues[0]?.message ?? null };
  }
  const first = timeMap.spans[0];
  const last = timeMap.spans[timeMap.spans.length - 1];
  const spansStayInsideRange = timeMap.spans.every(
    (span) =>
      span.sourceStartMs >= timeMap.sourceStartMs &&
      span.sourceEndMs <= timeMap.sourceEndMs &&
      span.targetStartMs >= timeMap.targetStartMs &&
      span.targetEndMs <= timeMap.targetEndMs
  );
  if (
    !spansStayInsideRange ||
    first.sourceStartMs !== timeMap.sourceStartMs ||
    first.targetStartMs !== timeMap.targetStartMs ||
    last.sourceEndMs !== timeMap.sourceEndMs ||
    last.targetEndMs !== timeMap.targetEndMs
  ) {
    return { valid: false, message: "分段没有完整覆盖时间图声明的双方范围。" };
  }
  return { valid: true, message: null };
}

function isValidReviewRange(startMs: number, endMs: number): boolean {
  return (
    Number.isSafeInteger(startMs) &&
    startMs >= 0 &&
    Number.isSafeInteger(endMs) &&
    endMs > startMs
  );
}

function countTimeMapSpans(spans: readonly TimeMapSpan[]): Record<TimeMapSpanKind, number> {
  const counts: Record<TimeMapSpanKind, number> = {
    matched: 0,
    sourceOnly: 0,
    targetOnly: 0,
    ambiguous: 0
  };
  spans.forEach((span) => {
    counts[span.kind] += 1;
  });
  return counts;
}

function createNormalizedTrackStyle(
  startMs: number,
  endMs: number,
  rangeStartMs: number,
  rangeEndMs: number
): { left: string; width: string; transform?: string } {
  const durationMs = rangeEndMs - rangeStartMs;
  const leftPercentage = ((startMs - rangeStartMs) / durationMs) * 100;
  const widthPercentage = ((endMs - startMs) / durationMs) * 100;
  if (endMs === startMs) {
    return {
      left: `${leftPercentage}%`,
      width: "3px",
      transform: leftPercentage >= 100 ? "translateX(-100%)" : "translateX(-1px)"
    };
  }
  return {
    left: `${leftPercentage}%`,
    width: `${Math.max(widthPercentage, 0.5)}%`
  };
}

function timeMapSpanColor(kind: TimeMapSpanKind): string {
  if (kind === "matched") return "border-emerald-300/60 bg-emerald-400/65";
  if (kind === "sourceOnly") return "border-amber-300/60 bg-amber-400/65";
  if (kind === "targetOnly") return "border-cyan-300/60 bg-cyan-400/65";
  return "border-red-300/60 bg-red-400/65";
}

function timeMapSpanBadgeColor(kind: TimeMapSpanKind): string {
  if (kind === "matched") return "border-emerald-400/40 bg-emerald-400/10 text-emerald-100";
  if (kind === "sourceOnly") return "border-amber-400/40 bg-amber-400/10 text-amber-100";
  if (kind === "targetOnly") return "border-cyan-400/40 bg-cyan-400/10 text-cyan-100";
  return "border-red-400/40 bg-red-400/10 text-red-100";
}

function formatTimeMapRange(startMs: number, endMs: number): string {
  if (startMs === endMs) {
    return `${formatTimecode(startMs)}（边界点）`;
  }
  return `${formatTimecode(startMs)}–${formatTimecode(endMs)}`;
}

function formatTimeMapStretchRatio(span: TimeMapSpan): string {
  const sourceDurationMs = span.sourceEndMs - span.sourceStartMs;
  const targetDurationMs = span.targetEndMs - span.targetStartMs;
  if (span.kind !== "matched" || sourceDurationMs <= 0 || targetDurationMs <= 0) {
    return "不适用";
  }
  return `${(targetDurationMs / sourceDurationMs).toFixed(3)}×`;
}

function createTimeMapSpanAccessibleName(span: TimeMapSpan, spanIndex: number): string {
  return `第 ${spanIndex + 1} 段 ${TIME_MAP_SPAN_LABELS[span.kind]}，参考 ${formatTimeMapRange(span.sourceStartMs, span.sourceEndMs)}，原片 ${formatTimeMapRange(span.targetStartMs, span.targetEndMs)}；选择为 A/B 复核区间并定位到参考起点 ${formatTimecode(span.sourceStartMs)}`;
}

function UnlinkedLegacyTimeMapWarning() {
  return (
    <section
      className="mt-3 rounded border border-accent-red/35 bg-accent-red/10 p-2.5 text-accent-red"
      data-testid="confirmed-time-map-quality"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-accent-red/50 bg-accent-red/10 px-2 py-0.5 text-[11px] font-medium">
          已保存关系的时间图缺失
        </span>
        <span className="text-[11px] font-medium">导出闸门：已阻断</span>
      </div>
      <p className="mt-1 leading-5">
        这是只保留供查看的旧关系；正式导出已停用旧规则兼容投影。请用 V2
        重新分析并确认一张可验证时间图。
      </p>
    </section>
  );
}

function describeTimeMapGate(
  timeMap: MediaTimeMap | undefined,
  expectedState: Extract<MediaTimeMapState, "candidate" | "confirmed">
): TimeMapGateDescription {
  const isConfirmedRelation = expectedState === "confirmed";
  if (!timeMap) {
    return {
      kind: "missing",
      label: "时间图缺失",
      message: isConfirmedRelation
        ? "已保存关系的时间图缺失，这条关系数据异常，不能导出；请重新分析或人工建立可验证映射。"
        : "候选时间图缺失，这个候选数据异常，不能确认或导出；请重新运行匹配。",
      canSaveRelationship: false,
      exportReady: false
    };
  }
  if (timeMap.state !== expectedState) {
    return {
      kind: "state-error",
      label: "时间图异常",
      message: `${isConfirmedRelation ? "已保存关系" : "候选"}引用的时间图状态为 ${timeMap.state}，预期为 ${expectedState}，不能继续保存或导出。`,
      canSaveRelationship: false,
      exportReady: false
    };
  }

  if (timeMap.quality.level === "verified") {
    return {
      kind: "verified",
      label: "已验证",
      message: isConfirmedRelation
        ? "已验证时间图达到导出质量门槛，可用于导出。"
        : "质量指标已达到导出门槛；确认关系后可用于导出。",
      canSaveRelationship: true,
      exportReady: true
    };
  }
  if (timeMap.quality.level === "review") {
    return {
      kind: "review",
      label: "需复核",
      message: isConfirmedRelation
        ? "关系已保存供试听复核，但仍不能导出；当前引擎尚未完成真实基准校准，本版本不会把试听结果伪装成已验证。"
        : "可以保存关系供试听复核，但仍不能导出；当前引擎尚未完成真实基准校准，本版本不会把试听结果伪装成已验证。",
      canSaveRelationship: true,
      exportReady: false
    };
  }
  if (timeMap.quality.level === "legacy-unverified") {
    return {
      kind: "legacy-unverified",
      label: "旧版未验证",
      message: isConfirmedRelation
        ? "旧版关系仅保留供试听复核，仍不能导出；需要用完成真实媒体校准的 V2 重新分析。"
        : "可以保存旧版关系供试听复核，但仍不能导出；需要用完成真实媒体校准的 V2 重新分析。",
      canSaveRelationship: true,
      exportReady: false
    };
  }
  return {
    kind: "blocked",
    label: "已阻断",
    message: isConfirmedRelation
      ? "已保存时间图不满足质量门槛，仍不能导出；请先处理歧义或证据不足问题。"
      : "证据不足或存在歧义，不能确认，也不能导出；请查看原因并重新分析。",
    canSaveRelationship: false,
    exportReady: false
  };
}

function formatQualityRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "未提供";
  }
  const percentage = value * 100;
  return `${percentage.toFixed(Number.isInteger(percentage) ? 0 : 1)}%`;
}

function formatQualityMilliseconds(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "未提供" : `${Math.round(value)} 毫秒`;
}

function formatSelectedStream(
  stream: MediaTimeMapStreamIdentity | null,
  role: "参考" | "原片"
): string {
  if (!stream) {
    return `${role}音轨未记录`;
  }
  const details = [
    stream.codec?.toUpperCase() ?? null,
    stream.sampleRate === null ? null : `${stream.sampleRate} Hz`,
    stream.channels === null ? null : `${stream.channels} 声道`,
    stream.language,
    stream.title
  ].filter((value): value is string => Boolean(value));
  return `${role}${stream.type === "audio" ? "音轨" : "视频流"} #${stream.index}${
    details.length > 0 ? ` · ${details.join(" · ")}` : ""
  }`;
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
      <h4 className="text-sm font-medium text-slate-100">已保存关系</h4>
      {sourceIds.length === 0 ? (
        <p className="mt-2 rounded border border-dashed border-panel-line p-3 leading-5 text-slate-500">
          尚无已保存关系。保存候选后，会按参考素材分别显示多条映射；完成复核和验证前，这些关系不能用于正式导出。
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
                    const confirmedTimeMap = segment.timeMapId
                      ? project.mediaTimeMaps.find(
                          (timeMap) => timeMap.id === segment.timeMapId
                        )
                      : undefined;
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
                        {segment.timeMapId === null ? (
                          <UnlinkedLegacyTimeMapWarning />
                        ) : (
                          <TimeMapQualitySummary
                            timeMap={confirmedTimeMap}
                            expectedState="confirmed"
                            testId="confirmed-time-map-quality"
                          />
                        )}
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

function savedRelationTargetCount(project: EditorProject): number {
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

function semanticEpisodeOrderHint(media: ProjectMediaReference): number | null {
  // Ordering is only a soft prior when the project carries explicit episode semantics. Import
  // array order and file names are not authoritative and must not silently steer assignment.
  const match = media.episodeKey?.match(/^(?:S(\d+))?E(\d+)(?::|$)/i);
  if (!match) {
    return null;
  }
  const season = match[1] ? Number.parseInt(match[1], 10) : 0;
  const episode = Number.parseInt(match[2], 10);
  return season * 100_000 + episode;
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

function candidateStateText(candidate: MediaMatchCandidate, exportReady: boolean): string {
  if (candidate.state === "pending") return "待复核";
  if (candidate.state === "accepted")
    return exportReady ? "已验证 · 可导出" : "关系已保存 / 待完成复核";
  if (candidate.state === "rejected") return "已忽略";
  if (candidate.proposal.timeMap?.quality.level === "blocked") return "已阻断";
  return "缺少 XML 绑定";
}

function candidateStateClass(
  state: MediaMatchCandidate["state"],
  exportReady: boolean
): string {
  if (state === "accepted")
    return exportReady
      ? "border-accent-green/40 bg-accent-green/10 text-accent-green"
      : "border-accent-yellow/40 bg-accent-yellow/10 text-accent-yellow";
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
