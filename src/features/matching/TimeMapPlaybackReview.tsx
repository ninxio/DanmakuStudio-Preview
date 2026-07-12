import { ArrowLeftRight, Pause, Play, Repeat2, RotateCcw, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextButton } from "../../components/TextButton";
import {
  createTimeMapPlaybackBoundaryContext,
  createTimeMapPlaybackSpanPlan,
  intervalForAxis,
  mapTimeMapPlaybackCounterpart,
  resolveTimeMapBoundaryPlaybackSwitch,
  resolveTimeMapPlaybackBoundary,
  resolveTimeMapPlaybackSwitch,
  type TimeMapPlaybackAxis,
  type TimeMapPlaybackBoundaryContext,
  type TimeMapPlaybackBoundaryKind,
  type TimeMapPlaybackInterval
} from "../../domain/alignment/timeMapPlayback";
import type { TimeMapSpan } from "../../domain/alignment/timeMap";
import {
  createEmptyTimeMapSpanPlaybackEvidence,
  describeMissingTimeMapSpanPlaybackEvidence,
  markTimeMapSpanPlaybackStarted
} from "../../domain/alignment/timeMapPlaybackReviewEvidence";
import type { ProjectMediaReference } from "../../domain/project/types";
import { formatTimecode } from "../../domain/shared/time";
import {
  HtmlVideoMediaAdapter,
  TauriMpvMediaAdapter,
  type MediaAdapter,
  type MediaSource
} from "../../infrastructure/media/mediaAdapter";
import {
  loadAppSettings,
  type PreviewBackendPreference
} from "../../infrastructure/settings/appSettings";
import { useEditorStore } from "../../stores/editorStore";

export type TimeMapPlaybackBackend = "htmlVideo" | "nativeMpv";

export type TimeMapPlaybackAdapterFactory = (options: {
  backend: TimeMapPlaybackBackend;
  video: HTMLVideoElement | null;
  mpvPath: string;
}) => MediaAdapter | null;

interface PlaybackMediaPair {
  available: boolean;
  backend: TimeMapPlaybackBackend | null;
  source: MediaSource | null;
  target: MediaSource | null;
  message: string;
}

interface TimeMapPlaybackReviewProps {
  span: TimeMapSpan;
  spanIndex: number;
  timeMapId: string;
  relationState: "candidate" | "accepted";
  persistedReview: boolean;
  sourceMapRange: TimeMapPlaybackInterval;
  targetMapRange: TimeMapPlaybackInterval;
  sourceMedia: ProjectMediaReference | null | undefined;
  targetMedia: ProjectMediaReference | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adapterFactory?: TimeMapPlaybackAdapterFactory;
}

const defaultAdapterFactory: TimeMapPlaybackAdapterFactory = ({ backend, video, mpvPath }) =>
  backend === "nativeMpv"
    ? new TauriMpvMediaAdapter(mpvPath)
    : video
      ? new HtmlVideoMediaAdapter(video)
      : null;

export function TimeMapPlaybackReview({
  span,
  spanIndex,
  timeMapId,
  relationState,
  persistedReview,
  sourceMapRange,
  targetMapRange,
  sourceMedia,
  targetMedia,
  open,
  onOpenChange,
  adapterFactory = defaultAdapterFactory
}: TimeMapPlaybackReviewProps) {
  const settings = loadAppSettings().player;
  const playbackPair = useMemo(
    () =>
      resolvePlaybackMediaPair(
        sourceMedia,
        targetMedia,
        settings.preferredBackend,
        settings.mpvPath
      ),
    [settings.mpvPath, settings.preferredBackend, sourceMedia, targetMedia]
  );
  const plan = useMemo(() => createTimeMapPlaybackSpanPlan(span), [span]);
  const initialInterval = intervalForAxis(plan, plan.initialAxis);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const adapterRef = useRef<MediaAdapter | null>(null);
  const loadedAxisRef = useRef<TimeMapPlaybackAxis | null>(null);
  const positionRef = useRef(initialInterval?.startMs ?? 0);
  const playingRef = useRef(false);
  const operationRef = useRef(0);
  const [adapterReady, setAdapterReady] = useState(false);
  const [activeAxis, setActiveAxis] = useState<TimeMapPlaybackAxis>(plan.initialAxis);
  const [positionMs, setPositionMs] = useState(initialInterval?.startMs ?? 0);
  const [playing, setPlayingState] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(true);
  const [loopScope, setLoopScope] = useState<"span" | TimeMapPlaybackBoundaryKind>("span");
  const [status, setStatus] = useState(plan.explanation);
  const [error, setError] = useState<string | null>(null);
  const [sessionEvidence, setSessionEvidence] = useState(
    createEmptyTimeMapSpanPlaybackEvidence
  );
  const recordPlaybackReview = useEditorStore((state) => state.recordTimeMapSpanPlaybackReview);
  const boundaryContext = useMemo(
    () =>
      loopScope === "span"
        ? null
        : createTimeMapPlaybackBoundaryContext(span, loopScope, sourceMapRange, targetMapRange),
    [loopScope, sourceMapRange, span, targetMapRange]
  );

  const setPlaying = useCallback((next: boolean) => {
    playingRef.current = next;
    setPlayingState(next);
  }, []);

  const updatePosition = useCallback((next: number) => {
    const normalized = Math.max(0, Math.round(next));
    positionRef.current = normalized;
    setPositionMs((current) => (current === normalized ? current : normalized));
  }, []);

  const markPlayback = useCallback(
    (axis: TimeMapPlaybackAxis) => {
      setSessionEvidence((current) => markTimeMapSpanPlaybackStarted(current, loopScope, axis));
    },
    [loopScope]
  );

  useEffect(() => {
    operationRef.current += 1;
    adapterRef.current?.pause();
    loadedAxisRef.current = null;
    setPlaying(false);
    setLoading(false);
    setError(null);
    setLoopScope("span");
    setSessionEvidence(createEmptyTimeMapSpanPlaybackEvidence());
    setActiveAxis(plan.initialAxis);
    const interval = intervalForAxis(plan, plan.initialAxis);
    updatePosition(interval?.startMs ?? 0);
    setStatus(`已选择第 ${spanIndex + 1} 段。${plan.explanation}`);
  }, [plan, setPlaying, spanIndex, updatePosition]);

  useEffect(() => {
    if (!open || !playbackPair.available || !playbackPair.backend) {
      setAdapterReady(false);
      return;
    }
    const adapter = adapterFactory({
      backend: playbackPair.backend,
      video: videoRef.current,
      mpvPath: settings.mpvPath
    });
    if (!adapter) {
      setAdapterReady(false);
      setError("播放器初始化失败，请关闭复核后重试。");
      return;
    }
    adapterRef.current = adapter;
    setAdapterReady(true);
    setError(null);
    return () => {
      operationRef.current += 1;
      adapter.pause();
      adapter.dispose();
      if (adapterRef.current === adapter) {
        adapterRef.current = null;
      }
      loadedAxisRef.current = null;
      playingRef.current = false;
    };
  }, [adapterFactory, open, playbackPair.available, playbackPair.backend, settings.mpvPath]);

  const loadAxis = useCallback(
    async (
      axis: TimeMapPlaybackAxis,
      requestedPositionMs: number,
      autoplay: boolean
    ): Promise<boolean> => {
      const adapter = adapterRef.current;
      const interval = reviewIntervalForAxis(plan, boundaryContext, axis);
      const mediaSource = axis === "source" ? playbackPair.source : playbackPair.target;
      if (!adapter || !interval || !mediaSource) {
        setError(
          !interval
            ? axis === "source"
              ? "当前分段没有可试听的参考 A 区间。"
              : "当前分段没有可试听的原片 B 区间。"
            : "播放器尚未准备完成，请稍后重试。"
        );
        return false;
      }
      const safePositionMs = Math.min(
        interval.endMs - 1,
        Math.max(interval.startMs, Math.round(requestedPositionMs))
      );
      const operation = operationRef.current + 1;
      operationRef.current = operation;
      setLoading(true);
      setError(null);
      adapter.pause();
      setPlaying(false);
      try {
        if (loadedAxisRef.current !== axis) {
          await adapter.load(mediaSource, safePositionMs);
        } else {
          adapter.seek(safePositionMs);
        }
        if (operationRef.current !== operation) {
          return false;
        }
        loadedAxisRef.current = axis;
        adapter.setPlaybackRate(1);
        setActiveAxis(axis);
        updatePosition(safePositionMs);
        if (autoplay) {
          await adapter.play();
          if (operationRef.current !== operation) {
            return false;
          }
          setPlaying(true);
          markPlayback(axis);
        }
        return true;
      } catch (loadError) {
        if (operationRef.current === operation) {
          setError(formatPlaybackError(loadError, playbackPair.backend));
          loadedAxisRef.current = null;
          setPlaying(false);
        }
        return false;
      } finally {
        if (operationRef.current === operation) {
          setLoading(false);
        }
      }
    },
    [
      boundaryContext,
      plan,
      playbackPair.backend,
      playbackPair.source,
      playbackPair.target,
      setPlaying,
      markPlayback,
      updatePosition
    ]
  );

  const switchAxis = useCallback(
    async (nextAxis: TimeMapPlaybackAxis): Promise<void> => {
      if (nextAxis === activeAxis && loadedAxisRef.current === nextAxis) {
        return;
      }
      const currentPositionMs =
        loadedAxisRef.current === activeAxis
          ? (adapterRef.current?.getCurrentTimeMs() ?? positionRef.current)
          : positionRef.current;
      const result = boundaryContext
        ? resolveTimeMapBoundaryPlaybackSwitch(
            span,
            boundaryContext,
            activeAxis,
            nextAxis,
            currentPositionMs
          )
        : resolveTimeMapPlaybackSwitch(span, activeAxis, nextAxis, currentPositionMs);
      if (result.status === "unavailable") {
        setStatus(plan.explanation);
        return;
      }
      const keepPlaying = playingRef.current;
      const loaded = await loadAxis(nextAxis, result.positionMs, keepPlaying);
      if (!loaded) {
        return;
      }
      setStatus(
        result.status === "mapped"
          ? `已按 TimeMap 将播放头同步到${axisLabel(nextAxis)} ${formatTimecode(result.positionMs)}。`
          : result.reason === "boundary-context"
            ? `已按双方 TimeMap 边界中心切到${axisLabel(nextAxis)} ${formatTimecode(result.positionMs)}；差异段上下文仅用于前后对照，不声称逐帧映射。`
            : `第 ${spanIndex + 1} 段无法可靠映射；已切到${axisLabel(nextAxis)}段首独立试听，未声称同步。`
      );
    },
    [activeAxis, boundaryContext, loadAxis, plan.explanation, span, spanIndex]
  );

  const togglePlayback = useCallback(async (): Promise<void> => {
    const adapter = adapterRef.current;
    const interval = reviewIntervalForAxis(plan, boundaryContext, activeAxis);
    if (!adapter || !interval) {
      setError("播放器尚未准备完成，或当前一侧没有可试听区间。");
      return;
    }
    if (playingRef.current) {
      adapter.pause();
      setPlaying(false);
      setStatus(`已暂停${axisLabel(activeAxis)}。`);
      return;
    }
    const requestedPositionMs =
      positionRef.current >= interval.startMs && positionRef.current < interval.endMs
        ? positionRef.current
        : interval.startMs;
    if (loadedAxisRef.current !== activeAxis) {
      const loaded = await loadAxis(activeAxis, requestedPositionMs, true);
      if (loaded) {
        setStatus(
          `正在播放${axisLabel(activeAxis)}第 ${spanIndex + 1} 段${loopEnabled ? "，到段尾后循环" : "，到段尾后暂停"}。`
        );
      }
      return;
    }
    try {
      await adapter.play();
      setPlaying(true);
      markPlayback(activeAxis);
      setError(null);
      setStatus(
        `正在播放${axisLabel(activeAxis)}第 ${spanIndex + 1} 段${loopEnabled ? "，到段尾后循环" : "，到段尾后暂停"}。`
      );
    } catch (playError) {
      setError(formatPlaybackError(playError, playbackPair.backend));
    }
  }, [
    activeAxis,
    boundaryContext,
    loadAxis,
    loopEnabled,
    markPlayback,
    plan,
    playbackPair.backend,
    setPlaying,
    spanIndex
  ]);

  const restartInterval = useCallback(async (): Promise<void> => {
    const interval = reviewIntervalForAxis(plan, boundaryContext, activeAxis);
    if (!interval) {
      return;
    }
    const loaded = await loadAxis(activeAxis, interval.startMs, false);
    if (loaded) {
      setStatus(`已回到${axisLabel(activeAxis)}第 ${spanIndex + 1} 段段首。`);
    }
  }, [activeAxis, boundaryContext, loadAxis, plan, spanIndex]);

  const selectLoopScope = useCallback(
    (nextScope: "span" | TimeMapPlaybackBoundaryKind): void => {
      adapterRef.current?.pause();
      setPlaying(false);
      setError(null);
      const nextContext =
        nextScope === "span"
          ? null
          : createTimeMapPlaybackBoundaryContext(
              span,
              nextScope,
              sourceMapRange,
              targetMapRange
            );
      const nextAxis =
        nextScope === "span" && !intervalForAxis(plan, activeAxis)
          ? plan.initialAxis
          : activeAxis;
      const nextInterval = reviewIntervalForAxis(plan, nextContext, nextAxis);
      setLoopScope(nextScope);
      setActiveAxis(nextAxis);
      if (nextInterval) {
        updatePosition(nextInterval.startMs);
        if (loadedAxisRef.current === nextAxis) {
          adapterRef.current?.seek(nextInterval.startMs);
        } else {
          loadedAxisRef.current = null;
        }
      }
      setStatus(
        nextScope === "span"
          ? `已选择第 ${spanIndex + 1} 段完整区间。`
          : `已选择${nextScope === "startBoundary" ? "段首" : "段尾"}边界前后 3 秒；双方以 TimeMap 边界为中心对照。`
      );
    },
    [
      activeAxis,
      plan,
      setPlaying,
      sourceMapRange,
      span,
      spanIndex,
      targetMapRange,
      updatePosition
    ]
  );

  useEffect(() => {
    if (!open || !adapterReady) {
      return;
    }
    const timer = window.setInterval(() => {
      const adapter = adapterRef.current;
      if (!adapter || loadedAxisRef.current !== activeAxis) {
        return;
      }
      const currentPositionMs = adapter.getCurrentTimeMs();
      updatePosition(currentPositionMs);
      if (!playingRef.current) {
        return;
      }
      const interval = reviewIntervalForAxis(plan, boundaryContext, activeAxis);
      if (!interval) {
        return;
      }
      const boundary = resolveTimeMapPlaybackBoundary(interval, currentPositionMs, loopEnabled);
      if (!boundary.reachedEnd || boundary.seekToMs === null) {
        return;
      }
      adapter.seek(boundary.seekToMs);
      updatePosition(boundary.seekToMs);
      if (boundary.shouldPause) {
        adapter.pause();
        setPlaying(false);
        setStatus(`已到${axisLabel(activeAxis)}当前分段末端并暂停。`);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [
    activeAxis,
    adapterReady,
    boundaryContext,
    loopEnabled,
    open,
    plan,
    setPlaying,
    updatePosition
  ]);

  const activeInterval = reviewIntervalForAxis(plan, boundaryContext, activeAxis);
  const counterpartResult = boundaryContext
    ? resolveTimeMapBoundaryPlaybackSwitch(
        span,
        boundaryContext,
        activeAxis,
        activeAxis === "source" ? "target" : "source",
        positionMs
      )
    : null;
  const counterpartMs = boundaryContext
    ? counterpartResult?.status === "unavailable"
      ? null
      : (counterpartResult?.positionMs ?? null)
    : mapTimeMapPlaybackCounterpart(span, activeAxis, positionMs);
  const counterpartKind = boundaryContext
    ? span.kind === "matched"
      ? "mapped"
      : "boundary-context"
    : counterpartMs === null
      ? "none"
      : "mapped";
  const sourcePositionLabel = playbackPositionLabel(
    "source",
    activeAxis,
    positionMs,
    counterpartMs,
    plan.kind,
    counterpartKind
  );
  const targetPositionLabel = playbackPositionLabel(
    "target",
    activeAxis,
    positionMs,
    counterpartMs,
    plan.kind,
    counterpartKind
  );
  const canOpen = playbackPair.available && Boolean(activeInterval);
  const missingPlaybackEvidence = describeMissingTimeMapSpanPlaybackEvidence(
    span,
    sessionEvidence
  );

  return (
    <section
      className="rounded border border-cyan-400/25 bg-cyan-400/5 p-2.5 text-slate-300"
      data-testid="time-map-playback-review"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ArrowLeftRight size={14} className="text-accent-cyan" aria-hidden="true" />
        <span className="font-medium text-slate-100">双源 A/B 同步复核</span>
        <span className="text-slate-500">当前：第 {spanIndex + 1} 段</span>
        <TextButton
          className="ml-auto"
          disabled={!canOpen}
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          {open ? <Square size={12} /> : <Play size={12} />}
          {open ? "关闭 A/B 复核" : "打开 A/B 复核"}
        </TextButton>
      </div>
      <p className="mt-1.5 leading-5 text-slate-400">{plan.explanation}</p>
      <p
        className={`mt-1 leading-5 ${playbackPair.available ? "text-slate-500" : "text-amber-200"}`}
      >
        {playbackPair.message}
      </p>
      <p className="mt-1 leading-5 text-slate-500">
        任一时刻只播放当前 A 或 B 的声音；切换前会暂停并卸载另一侧，避免两路音频叠加。
      </p>
      {persistedReview ? (
        <p className="mt-1 leading-5 text-emerald-100">
          本段已有与当前边界一致的播放复核证据。
        </p>
      ) : null}

      {open ? (
        <div className="mt-3 grid gap-3" aria-label="A/B 播放控制">
          <video
            ref={videoRef}
            className={
              playbackPair.backend === "htmlVideo"
                ? "aspect-video w-full rounded border border-panel-line bg-black object-contain"
                : "hidden"
            }
            playsInline
            preload="metadata"
          />
          {playbackPair.backend === "nativeMpv" ? (
            <div className="rounded border border-panel-line bg-black/30 p-3 text-center leading-5 text-slate-400">
              本地复杂编码由外部 mpv 窗口播放；本页按钮仍负责 A/B 切换、TimeMap 定位和区间循环。
            </div>
          ) : null}

          <div
            className="grid gap-1.5 rounded border border-panel-line/70 bg-black/20 p-2 sm:grid-cols-3"
            role="group"
            aria-label="选择循环复核范围"
          >
            <TextButton
              className="h-7 px-2 text-[11px]"
              tone={loopScope === "span" ? "primary" : "neutral"}
              aria-pressed={loopScope === "span"}
              onClick={() => selectLoopScope("span")}
            >
              当前分段
            </TextButton>
            <TextButton
              className="h-7 px-2 text-[11px]"
              tone={loopScope === "startBoundary" ? "primary" : "neutral"}
              aria-pressed={loopScope === "startBoundary"}
              onClick={() => selectLoopScope("startBoundary")}
            >
              段首前后 3 秒
            </TextButton>
            <TextButton
              className="h-7 px-2 text-[11px]"
              tone={loopScope === "endBoundary" ? "primary" : "neutral"}
              aria-pressed={loopScope === "endBoundary"}
              onClick={() => selectLoopScope("endBoundary")}
            >
              段尾前后 3 秒
            </TextButton>
          </div>

          <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="选择试听来源">
            <TextButton
              tone={activeAxis === "source" ? "primary" : "neutral"}
              disabled={
                !reviewIntervalForAxis(plan, boundaryContext, "source") ||
                loading ||
                !adapterReady
              }
              aria-pressed={activeAxis === "source"}
              onClick={() => void switchAxis("source")}
            >
              A · 参考视频
            </TextButton>
            <TextButton
              tone={activeAxis === "target" ? "primary" : "neutral"}
              disabled={
                !reviewIntervalForAxis(plan, boundaryContext, "target") ||
                loading ||
                !adapterReady
              }
              aria-pressed={activeAxis === "target"}
              onClick={() => void switchAxis("target")}
            >
              B · 目标原片
            </TextButton>
          </div>

          <div className="grid gap-1.5 rounded border border-panel-line/70 bg-black/20 p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>A 参考：{sourcePositionLabel}</span>
              <span>B 原片：{targetPositionLabel}</span>
            </div>
            {activeInterval ? (
              <label className="grid gap-1 text-slate-500">
                <span>当前分段播放位置</span>
                <input
                  type="range"
                  min={activeInterval.startMs}
                  max={activeInterval.endMs - 1}
                  step={1}
                  value={Math.min(
                    activeInterval.endMs - 1,
                    Math.max(activeInterval.startMs, positionMs)
                  )}
                  disabled={loading || !adapterReady}
                  aria-label={`${axisLabel(activeAxis)}当前分段播放位置`}
                  onChange={(event) => {
                    const nextPositionMs = Number(event.currentTarget.value);
                    adapterRef.current?.pause();
                    setPlaying(false);
                    updatePosition(nextPositionMs);
                    if (loadedAxisRef.current === activeAxis) {
                      adapterRef.current?.seek(nextPositionMs);
                    }
                  }}
                />
              </label>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <TextButton
              tone="primary"
              disabled={loading || !adapterReady || !activeInterval}
              onClick={() => void togglePlayback()}
            >
              {playing ? <Pause size={13} /> : <Play size={13} />}
              {playing ? "暂停当前段" : "播放当前段"}
            </TextButton>
            <TextButton
              disabled={loading || !adapterReady || !activeInterval}
              onClick={() => void restartInterval()}
            >
              <RotateCcw size={13} />
              回到段首
            </TextButton>
            <TextButton
              aria-pressed={loopEnabled}
              disabled={loading || !activeInterval}
              onClick={() => {
                setLoopEnabled((current) => !current);
                setStatus(loopEnabled ? "已关闭区间循环，到段尾后暂停。" : "已开启区间循环。");
              }}
            >
              <Repeat2 size={13} />
              {loopEnabled ? "循环复核区间：开" : "循环复核区间：关"}
            </TextButton>
          </div>

          <p className="leading-5 text-slate-400" aria-live="polite">
            {loading ? "正在切换媒体并定位播放头…" : status}
          </p>
          <div className="rounded border border-panel-line/70 bg-black/20 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-300">本段复核证据</span>
              {relationState === "candidate" ? (
                <TextButton
                  className="ml-auto"
                  tone="primary"
                  disabled={missingPlaybackEvidence.length > 0 || loading}
                  onClick={() => recordPlaybackReview(timeMapId, spanIndex, sessionEvidence)}
                >
                  记录本段已复核
                </TextButton>
              ) : null}
            </div>
            <p className="mt-1 leading-5 text-slate-500">
              {missingPlaybackEvidence.length === 0
                ? "播放器已完成本段要求的真实 A/B 启动组合，可以保存证据。"
                : `还需：${missingPlaybackEvidence.join("、")}。`}
            </p>
            {relationState === "accepted" && !persistedReview ? (
              <p className="mt-1 leading-5 text-amber-200">
                已确认图缺少本段播放证据；请撤销确认，回到候选完成真实播放复核后再保存关系。
              </p>
            ) : null}
          </div>
          {error ? (
            <p
              className="rounded border border-red-400/35 bg-red-400/10 p-2 leading-5 text-red-100"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function resolvePlaybackMediaPair(
  sourceMedia: ProjectMediaReference | null | undefined,
  targetMedia: ProjectMediaReference | null | undefined,
  preferredBackend: PreviewBackendPreference,
  mpvPath: string
): PlaybackMediaPair {
  if (!sourceMedia || !targetMedia) {
    return unavailablePair("候选引用的参考视频或原片已不存在，无法启动 A/B 复核。");
  }
  const hasHtmlPair = Boolean(sourceMedia.objectUrl && targetMedia.objectUrl);
  const hasMpvPair = Boolean(
    mpvPath.trim() && sourceMedia.localPath?.trim() && targetMedia.localPath?.trim()
  );
  const htmlLikelySupported =
    isLikelyHtmlVideoFile(sourceMedia.fileName) && isLikelyHtmlVideoFile(targetMedia.fileName);
  const chooseMpv =
    hasMpvPair &&
    (preferredBackend === "nativeMpv" ||
      !hasHtmlPair ||
      (preferredBackend === "auto" && !htmlLikelySupported));

  if (chooseMpv) {
    return {
      available: true,
      backend: "nativeMpv",
      source: {
        kind: "file",
        name: sourceMedia.name,
        url: sourceMedia.localPath?.trim() ?? ""
      },
      target: {
        kind: "file",
        name: targetMedia.name,
        url: targetMedia.localPath?.trim() ?? ""
      },
      message: "使用已配置的 mpv 读取两条本地路径；切换时复用同一播放器窗口。"
    };
  }

  if (hasHtmlPair) {
    return {
      available: true,
      backend: "htmlVideo",
      source: { kind: "url", name: sourceMedia.name, url: sourceMedia.objectUrl ?? "" },
      target: { kind: "url", name: targetMedia.name, url: targetMedia.objectUrl ?? "" },
      message:
        "使用本次导入会话中的两条视频连接内嵌播放；重新打开项目后如连接失效，请回素材页重新连接。"
    };
  }

  if (hasMpvPair) {
    return {
      available: true,
      backend: "nativeMpv",
      source: {
        kind: "file",
        name: sourceMedia.name,
        url: sourceMedia.localPath?.trim() ?? ""
      },
      target: {
        kind: "file",
        name: targetMedia.name,
        url: targetMedia.localPath?.trim() ?? ""
      },
      message: "内嵌视频连接不可用，已改用 mpv 读取两条本地路径。"
    };
  }

  const missing: string[] = [];
  if (!sourceMedia.objectUrl && !sourceMedia.localPath?.trim()) missing.push("参考视频未连接");
  if (!targetMedia.objectUrl && !targetMedia.localPath?.trim()) missing.push("原片未连接");
  if (!mpvPath.trim() && (sourceMedia.localPath || targetMedia.localPath)) {
    missing.push("设置中心尚未配置 mpv");
  }
  return unavailablePair(
    `${missing.join("；") || "两条媒体没有共同可用的播放后端"}。请回素材页重新连接，或在设置中心配置 mpv。`
  );
}

function unavailablePair(message: string): PlaybackMediaPair {
  return { available: false, backend: null, source: null, target: null, message };
}

function isLikelyHtmlVideoFile(fileName: string): boolean {
  return /\.(?:mp4|m4v|webm|ogv|ogg)$/iu.test(fileName.trim());
}

function formatPlaybackError(error: unknown, backend: TimeMapPlaybackBackend | null): string {
  const detail = error instanceof Error ? error.message : String(error);
  return backend === "htmlVideo"
    ? `内嵌播放器无法播放这条媒体：${detail} 请在设置中心配置 mpv 后重试。`
    : `mpv A/B 复核失败：${detail}`;
}

function axisLabel(axis: TimeMapPlaybackAxis): string {
  return axis === "source" ? "参考 A" : "原片 B";
}

function reviewIntervalForAxis(
  plan: ReturnType<typeof createTimeMapPlaybackSpanPlan>,
  boundaryContext: TimeMapPlaybackBoundaryContext | null,
  axis: TimeMapPlaybackAxis
): TimeMapPlaybackInterval | null {
  if (boundaryContext) {
    return axis === "source" ? boundaryContext.sourceInterval : boundaryContext.targetInterval;
  }
  return intervalForAxis(plan, axis);
}

function playbackPositionLabel(
  axis: TimeMapPlaybackAxis,
  activeAxis: TimeMapPlaybackAxis,
  activePositionMs: number,
  counterpartMs: number | null,
  kind: ReturnType<typeof createTimeMapPlaybackSpanPlan>["kind"],
  counterpartKind: "mapped" | "boundary-context" | "none"
): string {
  if (axis === activeAxis) {
    return formatTimecode(activePositionMs);
  }
  if (counterpartMs !== null) {
    return counterpartKind === "boundary-context"
      ? `${formatTimecode(counterpartMs)}（边界对照，非映射）`
      : `${formatTimecode(counterpartMs)}（映射）`;
  }
  if (kind === "ambiguous") {
    return "未同步";
  }
  return "此段不存在";
}
