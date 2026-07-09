import { Combine, Magnet, MousePointer2, Plus, Scissors, Trash2 } from "lucide-react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent
} from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { TextButton } from "../../components/TextButton";
import {
  buildAlignmentPreview,
  type AlignmentPreviewAnchor,
  type AlignmentPreviewCutCandidate,
  type AlignmentPreviewModel
} from "../../domain/alignment/preview";
import {
  createCutHintSearchPlan,
  findSuspectedCutCandidates,
  isSuspectedCutCandidateApplied,
  type SuspectedCutCandidate
} from "../../domain/danmaku/cutHints";
import type { CutMarker, DanmakuClip, ResolvedDanmakuEvent } from "../../domain/danmaku/types";
import { formatTimecode } from "../../domain/shared/time";
import type { Milliseconds } from "../../domain/shared/time";
import { clamp, clampMilliseconds } from "../../domain/shared/time";
import {
  getClipDurationMs,
  getProjectDurationMs,
  resolveProjectDanmakuEvents
} from "../../domain/timeline/mapping";
import {
  aggregateDensity,
  chooseBucketSizeMs,
  getEventsInRange
} from "../../domain/timeline/search";
import { formatPixelsPerSecond } from "../../domain/timeline/view";
import { useEditorStore } from "../../stores/editorStore";

const LABEL_WIDTH = 104;
const SNAP_THRESHOLD_MS = 180;
const EDGE_SCROLL_ZONE_PX = 36;

type TimelineEdgeFeedback = "start" | "end" | null;

interface TimelineTracks {
  ruler: TrackRect;
  video: TrackRect;
  cuts: TrackRect;
  clips: TrackRect;
  density: TrackRect;
  events: TrackRect;
}

interface TrackRect {
  y: number;
  height: number;
}

type DragState =
  | { type: "none" }
  | { type: "playhead" }
  | {
      type: "clip";
      clipIds: string[];
      startX: number;
      primaryClipId: string;
      originalStartMs: Milliseconds;
    }
  | { type: "danmaku"; startX: number }
  | { type: "box"; startX: number; currentX: number; additive: boolean };

export function TimelinePanel() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState>({ type: "none" });
  const [size, setSize] = useState({ width: 1000, height: 320 });
  const [boxPreview, setBoxPreview] = useState<{ startX: number; currentX: number } | null>(
    null
  );
  const [edgeFeedback, setEdgeFeedback] = useState<TimelineEdgeFeedback>(null);

  const project = useEditorStore((state) => state.project);
  const selection = useEditorStore((state) => state.selection);
  const timelineTool = useEditorStore((state) => state.timelineTool);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const setTimelineScroll = useEditorStore((state) => state.setTimelineScroll);
  const setTimelineZoom = useEditorStore((state) => state.setTimelineZoom);
  const moveClip = useEditorStore((state) => state.moveClip);
  const moveSelectedClips = useEditorStore((state) => state.moveSelectedClips);
  const moveSelectedDanmaku = useEditorStore((state) => state.moveSelectedDanmaku);
  const toggleDanmakuSelection = useEditorStore((state) => state.toggleDanmakuSelection);
  const toggleClipSelection = useEditorStore((state) => state.toggleClipSelection);
  const toggleCutSelection = useEditorStore((state) => state.toggleCutSelection);
  const selectDanmakuRange = useEditorStore((state) => state.selectDanmakuRange);
  const addCutMarkerAtPlayhead = useEditorStore((state) => state.addCutMarkerAtPlayhead);
  const fitTimelineToContent = useEditorStore((state) => state.fitTimelineToContent);
  const splitClipAtTime = useEditorStore((state) => state.splitClipAtTime);
  const splitSelectedClipsAtPlayhead = useEditorStore(
    (state) => state.splitSelectedClipsAtPlayhead
  );
  const mergeSelectedClips = useEditorStore((state) => state.mergeSelectedClips);
  const deleteSelection = useEditorStore((state) => state.deleteSelection);
  const setTimelineTool = useEditorStore((state) => state.setTimelineTool);
  const alignmentProposal = useEditorStore((state) => state.alignmentProposal);
  const cutHintSettings = useEditorStore((state) => state.cutHintSettings);

  const tracks = useMemo(() => makeTracks(size.height), [size.height]);
  const allEvents = useMemo(() => resolveProjectDanmakuEvents(project), [project]);
  const timelineDurationMs = useMemo(() => getProjectDurationMs(project), [project]);
  const alignmentPreview = useMemo(
    () => buildAlignmentPreview(project, alignmentProposal),
    [project, alignmentProposal]
  );
  const cutHintSearch = useMemo(() => createCutHintSearchPlan(cutHintSettings), [cutHintSettings]);
  const suspectedCutCandidates = useMemo(
    () => findSuspectedCutCandidates(project.assets, cutHintSearch.options),
    [cutHintSearch, project.assets]
  );
  const pendingSuspectedCutCount = useMemo(
    () =>
      suspectedCutCandidates.filter(
        (candidate) => !isSuspectedCutCandidateApplied(candidate, project.cutMarkers)
      ).length,
    [project.cutMarkers, suspectedCutCandidates]
  );
  const pendingAlignmentCount =
    alignmentPreview.summary.candidateAnchorCount + alignmentPreview.summary.candidateCutCount;
  const appliedAlignmentCount =
    alignmentPreview.summary.appliedAnchorCount + alignmentPreview.summary.appliedCutCount;
  const viewport = useMemo(() => {
    const durationMs = ((size.width - LABEL_WIDTH) * 1000) / project.timeline.pixelsPerSecond;
    return {
      startMs: project.timeline.scrollMs,
      endMs: project.timeline.scrollMs + durationMs
    };
  }, [project.timeline.pixelsPerSecond, project.timeline.scrollMs, size.width]);
  const visibleEvents = useMemo(
    () => getEventsInRange(allEvents, viewport.startMs - 1000, viewport.endMs + 1000),
    [allEvents, viewport.startMs, viewport.endMs]
  );

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) {
        setSize({ width: Math.max(500, rect.width), height: Math.max(220, rect.height) });
      }
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * ratio);
    canvas.height = Math.floor(size.height * ratio);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawTimeline(context, {
      width: size.width,
      height: size.height,
      project,
      tracks,
      visibleEvents,
      allEvents,
      selection,
      boxPreview,
      edgeFeedback,
      alignmentPreview,
      suspectedCutCandidates
    });
  }, [
    size,
    project,
    tracks,
    visibleEvents,
    allEvents,
    selection,
    boxPreview,
    edgeFeedback,
    alignmentPreview,
    suspectedCutCandidates
  ]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel-base" data-testid="timeline-panel">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-panel-line px-3">
        <TextButton
          onClick={() => setTimelineTool("select")}
          tone={timelineTool === "select" ? "primary" : "neutral"}
        >
          <MousePointer2 size={14} />
          选择
        </TextButton>
        <TextButton
          onClick={() => setTimelineTool("blade")}
          tone={timelineTool === "blade" ? "primary" : "neutral"}
        >
          <Scissors size={14} />
          剪刀
        </TextButton>
        <TextButton onClick={addCutMarkerAtPlayhead}>
          <Plus size={14} />
          添加删减点
        </TextButton>
        <TextButton onClick={splitSelectedClipsAtPlayhead}>
          <Scissors size={14} />
          剪切播放头
        </TextButton>
        <TextButton onClick={mergeSelectedClips}>
          <Combine size={14} />
          合并片段
        </TextButton>
        <TextButton onClick={deleteSelection} tone="danger">
          <Trash2 size={14} />
          删除
        </TextButton>
        <TextButton
          onClick={() => fitTimelineToContent(Math.max(240, size.width - LABEL_WIDTH - 24))}
        >
          缩放到全部
        </TextButton>
        <div className="ml-auto flex items-center gap-2 text-xs text-slate-400">
          {alignmentPreview.summary.proposalAnchorCount +
            alignmentPreview.summary.proposalCutCount >
          0 ? (
            <span className="rounded border border-panel-line bg-panel-soft px-2 py-1 text-slate-200">
              对齐候选 {pendingAlignmentCount} / 已应用 {appliedAlignmentCount}
            </span>
          ) : null}
          {suspectedCutCandidates.length > 0 ? (
            <span className="rounded border border-panel-line bg-panel-soft px-2 py-1 text-slate-200">
              文本候选 {pendingSuspectedCutCount} / 已落点{" "}
              {suspectedCutCandidates.length - pendingSuspectedCutCount}
            </span>
          ) : null}
          <Magnet size={14} className="text-accent-cyan" />
          吸附播放头 / 删减点
          <span className="rounded border border-panel-line bg-panel-soft px-2 py-1 font-mono text-slate-200">
            {formatPixelsPerSecond(project.timeline.pixelsPerSecond)}
          </span>
          <span className="rounded border border-panel-line bg-panel-soft px-2 py-1 text-slate-200">
            选择 {selection.ids.length}
          </span>
        </div>
      </div>
      <div ref={wrapperRef} className="relative min-h-0 flex-1 overflow-hidden">
        <canvas
          ref={canvasRef}
          className="timeline-canvas absolute inset-0 cursor-crosshair"
          data-testid="timeline-canvas"
          onPointerDown={(event) => {
            const point = getCanvasPoint(event);
            const timeMs = xToTime(
              point.x,
              project.timeline.scrollMs,
              project.timeline.pixelsPerSecond
            );
            const cutHit = hitCut(
              point,
              project.cutMarkers,
              project.timeline.scrollMs,
              project.timeline.pixelsPerSecond,
              tracks
            );
            const clipHit = hitClip(
              point,
              project.clips,
              project.timeline.scrollMs,
              project.timeline.pixelsPerSecond,
              tracks
            );
            const eventHit = hitEvent(
              point,
              visibleEvents,
              project.timeline.scrollMs,
              project.timeline.pixelsPerSecond,
              tracks
            );
            event.currentTarget.setPointerCapture(event.pointerId);
            setEdgeFeedback(null);
            if (timelineTool === "blade") {
              if (clipHit) {
                splitClipAtTime(clipHit.id, timeMs);
              }
              dragRef.current = { type: "none" };
              return;
            }
            if (eventHit) {
              toggleDanmakuSelection(eventHit.item.id, event.shiftKey);
              dragRef.current = { type: "danmaku", startX: point.x };
              return;
            }
            if (clipHit) {
              const clipIds =
                selection.kind === "clip" && selection.ids.includes(clipHit.id)
                  ? selection.ids
                  : [clipHit.id];
              toggleClipSelection(clipHit.id, event.shiftKey);
              dragRef.current = {
                type: "clip",
                clipIds,
                primaryClipId: clipHit.id,
                startX: point.x,
                originalStartMs: clipHit.timelineStartMs + clipHit.localOffsetMs
              };
              return;
            }
            if (cutHit) {
              toggleCutSelection(cutHit.id, event.shiftKey);
              return;
            }
            if (isInsideTrack(point.y, tracks.events)) {
              dragRef.current = {
                type: "box",
                startX: point.x,
                currentX: point.x,
                additive: event.shiftKey
              };
              setBoxPreview({ startX: point.x, currentX: point.x });
              return;
            }
            setPlayhead(timeMs);
            dragRef.current = { type: "playhead" };
          }}
          onPointerMove={(event) => {
            const point = getCanvasPoint(event);
            const drag = dragRef.current;
            if (drag.type === "playhead") {
              const next = getPlayheadDragUpdate({
                pointX: point.x,
                width: size.width,
                scrollMs: project.timeline.scrollMs,
                pixelsPerSecond: project.timeline.pixelsPerSecond,
                durationMs: timelineDurationMs
              });
              if (next.scrollMs !== project.timeline.scrollMs) {
                setTimelineScroll(next.scrollMs);
              }
              setPlayhead(next.playheadMs);
              setEdgeFeedback(next.edge);
            } else if (drag.type === "box") {
              dragRef.current = { ...drag, currentX: point.x };
              setBoxPreview({ startX: drag.startX, currentX: point.x });
            }
          }}
          onPointerUp={(event) => {
            const point = getCanvasPoint(event);
            const drag = dragRef.current;
            if (drag.type === "clip") {
              const rawDelta =
                ((point.x - drag.startX) * 1000) / project.timeline.pixelsPerSecond;
              const proposedStart = clampMilliseconds(drag.originalStartMs + rawDelta);
              const snappedStart = snapTime(
                proposedStart,
                project.timeline.playheadMs,
                project.cutMarkers
              );
              if (drag.clipIds.length > 1) {
                moveSelectedClips(Math.round(snappedStart - drag.originalStartMs));
              } else {
                moveClip(drag.primaryClipId, snappedStart - drag.originalStartMs);
              }
            } else if (drag.type === "danmaku") {
              const rawDelta =
                ((point.x - drag.startX) * 1000) / project.timeline.pixelsPerSecond;
              const firstSelected = visibleEvents.find(
                (eventItem) =>
                  selection.kind === "danmaku" && selection.ids.includes(eventItem.item.id)
              );
              const snappedDelta = firstSelected
                ? snapTime(
                    firstSelected.finalTimeMs + rawDelta,
                    project.timeline.playheadMs,
                    project.cutMarkers
                  ) - firstSelected.finalTimeMs
                : rawDelta;
              moveSelectedDanmaku(Math.round(snappedDelta));
            } else if (drag.type === "box") {
              const start = xToTime(
                drag.startX,
                project.timeline.scrollMs,
                project.timeline.pixelsPerSecond
              );
              const end = xToTime(
                point.x,
                project.timeline.scrollMs,
                project.timeline.pixelsPerSecond
              );
              selectDanmakuRange(start, end, drag.additive);
              setBoxPreview(null);
            }
            dragRef.current = { type: "none" };
            setEdgeFeedback(null);
          }}
          onDoubleClick={(event) => {
            const point = getCanvasPoint(event);
            const eventHit = hitEvent(
              point,
              visibleEvents,
              project.timeline.scrollMs,
              project.timeline.pixelsPerSecond,
              tracks
            );
            if (eventHit) {
              toggleDanmakuSelection(eventHit.item.id, false);
              setPlayhead(eventHit.finalTimeMs);
            }
          }}
          onWheel={(event) => {
            event.preventDefault();
            const point = getCanvasPoint(event);
            const pointerTime = xToTime(
              point.x,
              project.timeline.scrollMs,
              project.timeline.pixelsPerSecond
            );
            if (event.ctrlKey || event.metaKey) {
              const direction = event.deltaY > 0 ? 0.88 : 1.14;
              setTimelineZoom(
                project.timeline.pixelsPerSecond * direction,
                pointerTime,
                point.x - LABEL_WIDTH
              );
            } else {
              const deltaPx = event.deltaX !== 0 ? event.deltaX : event.deltaY;
              const deltaMs = (deltaPx * 1000) / project.timeline.pixelsPerSecond;
              setTimelineScroll(project.timeline.scrollMs + deltaMs);
            }
          }}
        />
      </div>
    </div>
  );
}

function drawTimeline(
  context: CanvasRenderingContext2D,
  props: {
    width: number;
    height: number;
    project: ReturnType<typeof useEditorStore.getState>["project"];
    tracks: TimelineTracks;
    visibleEvents: ResolvedDanmakuEvent[];
    allEvents: ResolvedDanmakuEvent[];
    selection: ReturnType<typeof useEditorStore.getState>["selection"];
    boxPreview: { startX: number; currentX: number } | null;
    edgeFeedback: TimelineEdgeFeedback;
    alignmentPreview: AlignmentPreviewModel;
    suspectedCutCandidates: SuspectedCutCandidate[];
  }
): void {
  const {
    width,
    height,
    project,
    tracks,
    visibleEvents,
    allEvents,
    selection,
    boxPreview,
    edgeFeedback,
    alignmentPreview,
    suspectedCutCandidates
  } = props;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#101216";
  context.fillRect(0, 0, width, height);
  drawTrack(context, tracks.ruler, width, "时间标尺");
  drawTrack(context, tracks.video, width, "视频轨道");
  drawTrack(context, tracks.cuts, width, "版本差异");
  drawTrack(context, tracks.clips, width, "弹幕片段");
  drawTrack(context, tracks.density, width, "密度热力图");
  drawTrack(context, tracks.events, width, "弹幕事件");
  drawRuler(
    context,
    width,
    project.timeline.scrollMs,
    project.timeline.pixelsPerSecond,
    tracks.ruler
  );
  drawVideoTrack(context, project, tracks.video);
  drawClips(context, project.clips, project, tracks.clips, selection);
  drawDensity(
    context,
    allEvents,
    project.timeline.scrollMs,
    project.timeline.pixelsPerSecond,
    width,
    tracks.density
  );
  drawEvents(
    context,
    visibleEvents,
    project.timeline.scrollMs,
    project.timeline.pixelsPerSecond,
    tracks.events,
    selection
  );
  drawSuspectedCutHints(
    context,
    suspectedCutCandidates,
    project.cutMarkers,
    tracks,
    project.timeline.scrollMs,
    project.timeline.pixelsPerSecond,
    width,
    height
  );
  drawCutMarkers(
    context,
    project.cutMarkers,
    project.timeline.scrollMs,
    project.timeline.pixelsPerSecond,
    tracks.cuts,
    selection
  );
  drawAlignmentPreview(
    context,
    alignmentPreview,
    tracks,
    project.timeline.scrollMs,
    project.timeline.pixelsPerSecond,
    width,
    height
  );
  drawPlayhead(
    context,
    project.timeline.playheadMs,
    project.timeline.scrollMs,
    project.timeline.pixelsPerSecond,
    height
  );
  drawEdgeFeedback(context, edgeFeedback, width, height);
  if (boxPreview) {
    context.fillStyle = "rgba(76, 201, 240, 0.16)";
    context.strokeStyle = "rgba(76, 201, 240, 0.9)";
    const left = Math.min(boxPreview.startX, boxPreview.currentX);
    const boxWidth = Math.abs(boxPreview.currentX - boxPreview.startX);
    context.fillRect(left, tracks.events.y, boxWidth, tracks.events.height);
    context.strokeRect(left, tracks.events.y + 1, boxWidth, tracks.events.height - 2);
  }
}

function makeTracks(height: number): TimelineTracks {
  const ruler = { y: 0, height: 28 };
  const video = { y: 28, height: 34 };
  const cuts = { y: 62, height: 36 };
  const clips = { y: 98, height: 62 };
  const density = { y: 160, height: 52 };
  const events = { y: 212, height: Math.max(48, height - 212) };
  return { ruler, video, cuts, clips, density, events };
}

function drawTrack(
  context: CanvasRenderingContext2D,
  track: TrackRect,
  width: number,
  label: string
): void {
  context.fillStyle = track.y % 2 === 0 ? "#15171b" : "#171a20";
  context.fillRect(0, track.y, width, track.height);
  context.strokeStyle = "#303540";
  context.beginPath();
  context.moveTo(0, track.y + track.height);
  context.lineTo(width, track.y + track.height);
  context.stroke();
  context.fillStyle = "#6b7280";
  context.font = "12px Segoe UI";
  context.fillText(label, 12, track.y + Math.min(22, track.height - 8));
  context.fillStyle = "#20242c";
  context.fillRect(LABEL_WIDTH - 1, track.y, 1, track.height);
}

function drawRuler(
  context: CanvasRenderingContext2D,
  width: number,
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  track: TrackRect
): void {
  const visibleMs = ((width - LABEL_WIDTH) * 1000) / pixelsPerSecond;
  const step = chooseTickStep(pixelsPerSecond);
  const first = Math.floor(scrollMs / step) * step;
  context.strokeStyle = "#475062";
  context.fillStyle = "#cbd5e1";
  context.font = "11px ui-monospace, Consolas";
  for (let time = first; time <= scrollMs + visibleMs + step; time += step) {
    const x = timeToX(time, scrollMs, pixelsPerSecond);
    if (x < LABEL_WIDTH) {
      continue;
    }
    context.beginPath();
    context.moveTo(x, track.y + 4);
    context.lineTo(x, track.y + track.height);
    context.stroke();
    context.fillText(formatTimecode(time), x + 4, track.y + 18);
  }
}

function drawVideoTrack(
  context: CanvasRenderingContext2D,
  project: ReturnType<typeof useEditorStore.getState>["project"],
  track: TrackRect
): void {
  const duration = project.media?.durationMs ?? 0;
  if (duration <= 0) {
    context.fillStyle = "#64748b";
    context.font = "12px Segoe UI";
    context.fillText("导入视频后显示素材长度", LABEL_WIDTH + 12, track.y + 22);
    return;
  }
  const x = timeToX(0, project.timeline.scrollMs, project.timeline.pixelsPerSecond);
  const width = (duration / 1000) * project.timeline.pixelsPerSecond;
  context.fillStyle = "#27374a";
  context.fillRect(Math.max(LABEL_WIDTH, x), track.y + 7, width, track.height - 14);
  context.fillStyle = "#dbeafe";
  context.font = "12px Segoe UI";
  context.fillText(
    project.media?.fileName ?? "视频",
    Math.max(LABEL_WIDTH + 8, x + 8),
    track.y + 22
  );
}

function drawCutMarkers(
  context: CanvasRenderingContext2D,
  markers: CutMarker[],
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  track: TrackRect,
  selection: ReturnType<typeof useEditorStore.getState>["selection"]
): void {
  for (const marker of markers) {
    const x = timeToX(marker.sourceAtMs, scrollMs, pixelsPerSecond);
    if (x < LABEL_WIDTH || x > context.canvas.width) {
      continue;
    }
    const selected = selection.kind === "cut" && selection.ids.includes(marker.id);
    context.strokeStyle = selected ? "#4cc9f0" : "#f2c94c";
    context.fillStyle = selected ? "rgba(76,201,240,0.18)" : "rgba(242,201,76,0.14)";
    context.beginPath();
    context.moveTo(x, track.y + 4);
    context.lineTo(x + 7, track.y + 15);
    context.lineTo(x, track.y + track.height - 4);
    context.lineTo(x - 7, track.y + 15);
    context.closePath();
    context.fill();
    context.stroke();
    context.fillStyle = "#f8fafc";
    context.font = "11px Segoe UI";
    context.fillText(
      `${marker.targetGapMs >= 0 ? "+" : ""}${marker.targetGapMs}ms`,
      x + 9,
      track.y + 22
    );
  }
}

function drawClips(
  context: CanvasRenderingContext2D,
  clips: DanmakuClip[],
  project: ReturnType<typeof useEditorStore.getState>["project"],
  track: TrackRect,
  selection: ReturnType<typeof useEditorStore.getState>["selection"]
): void {
  for (const clip of clips) {
    const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
    const startX = timeToX(
      clip.timelineStartMs + clip.localOffsetMs,
      project.timeline.scrollMs,
      project.timeline.pixelsPerSecond
    );
    const width = Math.max(
      18,
      (getClipDurationMs(clip) / 1000) * project.timeline.pixelsPerSecond
    );
    if (startX + width < LABEL_WIDTH || startX > context.canvas.width) {
      continue;
    }
    const selected = selection.kind === "clip" && selection.ids.includes(clip.id);
    context.fillStyle = clip.enabled ? (asset?.color ?? "#4cc9f0") : "#64748b";
    context.globalAlpha = selected ? 0.95 : 0.62;
    context.fillRect(Math.max(LABEL_WIDTH, startX), track.y + 10, width, track.height - 20);
    context.globalAlpha = 1;
    context.strokeStyle = selected ? "#ffffff" : "#111827";
    context.lineWidth = selected ? 2 : 1;
    context.strokeRect(Math.max(LABEL_WIDTH, startX), track.y + 10, width, track.height - 20);
    context.fillStyle = "#0f172a";
    context.font = "12px Segoe UI";
    context.fillText(clip.name, Math.max(LABEL_WIDTH + 8, startX + 8), track.y + 34);
  }
}

function drawDensity(
  context: CanvasRenderingContext2D,
  events: ResolvedDanmakuEvent[],
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  width: number,
  track: TrackRect
): void {
  const endMs = scrollMs + ((width - LABEL_WIDTH) * 1000) / pixelsPerSecond;
  const bucketSize = chooseBucketSizeMs(pixelsPerSecond);
  const buckets = aggregateDensity(events, scrollMs, endMs, bucketSize);
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  for (const bucket of buckets) {
    const x = timeToX(bucket.startMs, scrollMs, pixelsPerSecond);
    const bucketWidth = Math.max(1, ((bucket.endMs - bucket.startMs) / 1000) * pixelsPerSecond);
    const normalized = bucket.count / max;
    context.fillStyle = `rgba(76, 201, 240, ${0.12 + normalized * 0.72})`;
    context.fillRect(
      Math.max(LABEL_WIDTH, x),
      track.y + track.height - normalized * (track.height - 8),
      bucketWidth,
      normalized * (track.height - 8)
    );
  }
}

function drawEvents(
  context: CanvasRenderingContext2D,
  events: ResolvedDanmakuEvent[],
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  track: TrackRect,
  selection: ReturnType<typeof useEditorStore.getState>["selection"]
): void {
  const maxToDraw = 2500;
  const step = Math.max(1, Math.ceil(events.length / maxToDraw));
  for (let index = 0; index < events.length; index += step) {
    const event = events[index];
    if (!event.enabled) {
      continue;
    }
    const x = timeToX(event.finalTimeMs, scrollMs, pixelsPerSecond);
    if (x < LABEL_WIDTH || x > context.canvas.width) {
      continue;
    }
    const selected = selection.kind === "danmaku" && selection.ids.includes(event.item.id);
    const lane = event.originalIndex % 12;
    const y = track.y + 8 + lane * Math.max(4, (track.height - 16) / 12);
    context.fillStyle = selected ? "#ffffff" : event.asset.color;
    context.fillRect(x - (selected ? 3 : 1), y, selected ? 6 : 2, selected ? 14 : 10);
    if (selected && pixelsPerSecond > 220) {
      context.font = "11px Segoe UI";
      context.fillText(event.item.text.slice(0, 16), x + 6, y + 10);
    }
  }
}

function drawSuspectedCutHints(
  context: CanvasRenderingContext2D,
  candidates: SuspectedCutCandidate[],
  cutMarkers: CutMarker[],
  tracks: TimelineTracks,
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  width: number,
  height: number
): void {
  const guideTop = tracks.cuts.y + 2;
  const guideBottom = Math.min(height - 3, tracks.events.y + tracks.events.height - 3);
  const bandTop = tracks.cuts.y;
  const bandBottom = tracks.events.y + tracks.events.height;
  for (const candidate of candidates) {
    const x = timeToX(candidate.sourceAtMs, scrollMs, pixelsPerSecond);
    const startX = timeToX(candidate.startMs, scrollMs, pixelsPerSecond);
    const endX = timeToX(candidate.endMs, scrollMs, pixelsPerSecond);
    const rawBandLeft = Math.min(startX, endX, x - 3);
    const rawBandRight = Math.max(startX, endX, x + 3);
    const bandVisible = rawBandRight >= LABEL_WIDTH && rawBandLeft <= width;
    const guideVisible = x >= LABEL_WIDTH && x <= width;
    if (!bandVisible && !guideVisible) {
      continue;
    }

    const applied = isSuspectedCutCandidateApplied(candidate, cutMarkers);
    const strokeColor = applied ? "rgba(242, 201, 76, 0.36)" : "rgba(242, 201, 76, 0.9)";
    const fillColor = applied ? "rgba(242, 201, 76, 0.035)" : "rgba(242, 201, 76, 0.085)";
    context.save();
    if (bandVisible) {
      const left = clamp(rawBandLeft, LABEL_WIDTH, width);
      const right = clamp(rawBandRight, LABEL_WIDTH, width);
      if (right > left) {
        context.fillStyle = fillColor;
        context.fillRect(left, bandTop, Math.max(3, right - left), bandBottom - bandTop);
      }
    }
    context.restore();

    if (!guideVisible) {
      continue;
    }
    drawVerticalGuide(
      context,
      x,
      guideTop,
      guideBottom,
      strokeColor,
      applied ? [2, 5] : [4, 5],
      applied ? 1 : 1.4
    );
    drawSuspectedCutHintMarker(context, x, tracks.cuts, strokeColor, applied);
    if (!applied || pixelsPerSecond > 95) {
      drawTimelineLabel(
        context,
        `${applied ? "已落点" : "文本候选"} ${candidate.hitCount} 条`,
        x,
        tracks.cuts.y + 3,
        width,
        {
          borderColor: strokeColor,
          fillColor: applied ? "rgba(242, 201, 76, 0.08)" : "rgba(242, 201, 76, 0.18)"
        }
      );
    }
  }
}

function drawAlignmentPreview(
  context: CanvasRenderingContext2D,
  preview: AlignmentPreviewModel,
  tracks: TimelineTracks,
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  width: number,
  height: number
): void {
  drawProjectAnchors(
    context,
    preview.projectAnchors,
    tracks,
    scrollMs,
    pixelsPerSecond,
    width,
    height
  );
  drawProposalAnchors(
    context,
    preview.proposalAnchors,
    tracks,
    scrollMs,
    pixelsPerSecond,
    width,
    height
  );
  drawProposalCutCandidates(
    context,
    preview.proposalCuts,
    tracks,
    scrollMs,
    pixelsPerSecond,
    width,
    height
  );
}

function drawSuspectedCutHintMarker(
  context: CanvasRenderingContext2D,
  x: number,
  track: TrackRect,
  color: string,
  applied: boolean
): void {
  const centerY = track.y + track.height / 2;
  const radius = applied ? 5 : 7;
  context.save();
  context.fillStyle = applied ? "rgba(242, 201, 76, 0.1)" : "rgba(242, 201, 76, 0.24)";
  context.strokeStyle = color;
  context.lineWidth = applied ? 1 : 1.4;
  context.setLineDash(applied ? [2, 4] : []);
  context.beginPath();
  context.arc(x, centerY, radius, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();
}

function drawProjectAnchors(
  context: CanvasRenderingContext2D,
  anchors: AlignmentPreviewModel["projectAnchors"],
  tracks: TimelineTracks,
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  width: number,
  height: number
): void {
  const guideTop = tracks.video.y + 2;
  const guideBottom = Math.min(height - 3, tracks.events.y + tracks.events.height - 3);
  for (const anchor of anchors) {
    const x = timeToX(anchor.sourceMs, scrollMs, pixelsPerSecond);
    if (x < LABEL_WIDTH || x > width) {
      continue;
    }
    drawVerticalGuide(context, x, guideTop, guideBottom, "#7bd88f", [], 1.4);
    context.save();
    context.fillStyle = "#7bd88f";
    context.fillRect(x - 3, tracks.cuts.y + tracks.cuts.height / 2 - 3, 6, 6);
    context.restore();
    if (pixelsPerSecond > 140) {
      drawTimelineLabel(
        context,
        `同步锚点 ${formatTimecode(anchor.sourceMs)}`,
        x,
        tracks.cuts.y + 3,
        width,
        {
          borderColor: "#7bd88f",
          fillColor: "rgba(123, 216, 143, 0.16)"
        }
      );
    }
  }
}

function drawProposalAnchors(
  context: CanvasRenderingContext2D,
  anchors: AlignmentPreviewAnchor[],
  tracks: TimelineTracks,
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  width: number,
  height: number
): void {
  const guideTop = tracks.video.y + 2;
  const guideBottom = Math.min(height - 3, tracks.events.y + tracks.events.height - 3);
  for (const anchor of anchors) {
    const x = timeToX(anchor.sourceMs, scrollMs, pixelsPerSecond);
    if (x < LABEL_WIDTH || x > width) {
      continue;
    }
    const applied = anchor.state === "applied";
    const strokeColor = applied ? "rgba(123, 216, 143, 0.42)" : "rgba(123, 216, 143, 0.92)";
    drawVerticalGuide(
      context,
      x,
      guideTop,
      guideBottom,
      strokeColor,
      applied ? [2, 6] : [6, 4],
      applied ? 1 : 1.6
    );
    context.save();
    context.strokeStyle = strokeColor;
    context.fillStyle = applied ? "rgba(123, 216, 143, 0.12)" : "rgba(123, 216, 143, 0.28)";
    context.lineWidth = applied ? 1 : 1.5;
    context.beginPath();
    context.arc(x, tracks.cuts.y + tracks.cuts.height / 2, applied ? 4 : 5, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.restore();
    if (pixelsPerSecond > 95) {
      drawTimelineLabel(
        context,
        `${applied ? "已应用锚点" : "候选锚点"} ${formatSignedOffset(anchor.targetMs - anchor.sourceMs)}`,
        x,
        tracks.cuts.y + 3,
        width,
        {
          borderColor: strokeColor,
          fillColor: applied ? "rgba(123, 216, 143, 0.08)" : "rgba(123, 216, 143, 0.18)"
        }
      );
    }
  }
}

function drawProposalCutCandidates(
  context: CanvasRenderingContext2D,
  candidates: AlignmentPreviewCutCandidate[],
  tracks: TimelineTracks,
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  width: number,
  height: number
): void {
  const guideTop = tracks.cuts.y + 2;
  const guideBottom = Math.min(height - 3, tracks.events.y + tracks.events.height - 3);
  for (const candidate of candidates) {
    const x = timeToX(candidate.sourceAtMs, scrollMs, pixelsPerSecond);
    if (x < LABEL_WIDTH || x > width) {
      continue;
    }
    const applied = candidate.state === "applied";
    const strokeColor = applied ? "rgba(255, 143, 112, 0.42)" : "rgba(255, 143, 112, 0.94)";
    drawCandidateSourceRange(context, candidate, tracks, scrollMs, pixelsPerSecond, width, applied);
    if (!applied) {
      context.save();
      context.fillStyle = "rgba(255, 143, 112, 0.045)";
      const impactLeft = Math.max(LABEL_WIDTH, x);
      context.fillRect(
        impactLeft,
        tracks.cuts.y,
        width - impactLeft,
        tracks.events.y + tracks.events.height - tracks.cuts.y
      );
      drawImpactRegionText(
        context,
        `补偿影响区：后续整体 ${formatSignedOffset(candidate.targetGapMs)}`,
        impactLeft,
        tracks.events.y + 16,
        width
      );
      context.restore();
    }
    drawVerticalGuide(
      context,
      x,
      guideTop,
      guideBottom,
      strokeColor,
      applied ? [2, 6] : [7, 4],
      applied ? 1 : 1.6
    );
    drawCutCandidateDiamond(context, x, tracks.cuts, strokeColor, applied);
    if (!applied) {
      drawGapArrow(
        context,
        x,
        tracks.cuts.y + tracks.cuts.height - 8,
        candidate.targetGapMs,
        pixelsPerSecond,
        strokeColor
      );
    }
    drawTimelineLabel(
      context,
      `${applied ? "已应用补偿" : "候选补偿"} ${formatSignedOffset(candidate.targetGapMs)}`,
      x,
      tracks.cuts.y + 3,
      width,
      {
        borderColor: strokeColor,
        fillColor: applied ? "rgba(255, 143, 112, 0.08)" : "rgba(255, 143, 112, 0.18)"
      }
    );
  }
}

function drawCandidateSourceRange(
  context: CanvasRenderingContext2D,
  candidate: AlignmentPreviewCutCandidate,
  tracks: TimelineTracks,
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  width: number,
  applied: boolean
): void {
  if (
    candidate.sourceRangeStartMs === undefined ||
    candidate.sourceRangeEndMs === undefined ||
    candidate.sourceRangeEndMs <= candidate.sourceRangeStartMs
  ) {
    return;
  }
  const startX = timeToX(candidate.sourceRangeStartMs, scrollMs, pixelsPerSecond);
  const endX = timeToX(candidate.sourceRangeEndMs, scrollMs, pixelsPerSecond);
  const left = clamp(Math.min(startX, endX), LABEL_WIDTH, width);
  const right = clamp(Math.max(startX, endX), LABEL_WIDTH, width);
  if (right <= LABEL_WIDTH || left >= width || right - left < 2) {
    return;
  }
  context.save();
  context.fillStyle = applied ? "rgba(255, 143, 112, 0.08)" : "rgba(255, 143, 112, 0.16)";
  context.strokeStyle = applied ? "rgba(255, 143, 112, 0.22)" : "rgba(255, 143, 112, 0.45)";
  context.lineWidth = 1;
  const y = tracks.cuts.y + 4;
  const height = Math.max(6, tracks.cuts.height - 8);
  context.fillRect(left, y, right - left, height);
  context.strokeRect(left, y, right - left, height);
  context.restore();
}

function drawImpactRegionText(
  context: CanvasRenderingContext2D,
  text: string,
  left: number,
  baselineY: number,
  maxRight: number
): void {
  const availableWidth = maxRight - left - 12;
  if (availableWidth < 96) {
    return;
  }
  context.save();
  context.font = "11px Segoe UI";
  context.fillStyle = "rgba(255, 190, 165, 0.92)";
  context.fillText(text, left + 8, baselineY, availableWidth);
  context.restore();
}

function drawVerticalGuide(
  context: CanvasRenderingContext2D,
  x: number,
  top: number,
  bottom: number,
  color: string,
  dash: number[],
  lineWidth: number
): void {
  context.save();
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.setLineDash(dash);
  context.beginPath();
  context.moveTo(x, top);
  context.lineTo(x, bottom);
  context.stroke();
  context.restore();
}

function drawCutCandidateDiamond(
  context: CanvasRenderingContext2D,
  x: number,
  track: TrackRect,
  color: string,
  applied: boolean
): void {
  const centerY = track.y + track.height / 2;
  const radius = applied ? 7 : 9;
  context.save();
  context.fillStyle = applied ? "rgba(255, 143, 112, 0.12)" : "rgba(255, 143, 112, 0.28)";
  context.strokeStyle = color;
  context.lineWidth = applied ? 1 : 1.5;
  context.setLineDash(applied ? [2, 5] : [5, 3]);
  context.beginPath();
  context.moveTo(x, centerY - radius);
  context.lineTo(x + radius, centerY);
  context.lineTo(x, centerY + radius);
  context.lineTo(x - radius, centerY);
  context.closePath();
  context.fill();
  context.stroke();
  context.restore();
}

function drawGapArrow(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  targetGapMs: Milliseconds,
  pixelsPerSecond: number,
  color: string
): void {
  const direction = targetGapMs >= 0 ? 1 : -1;
  const rawLength = (Math.abs(targetGapMs) / 1000) * pixelsPerSecond;
  const length = Math.max(16, Math.min(96, rawLength));
  const startX = x + direction * 10;
  const endX = x + direction * length;
  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 1.4;
  context.beginPath();
  context.moveTo(startX, y);
  context.lineTo(endX, y);
  context.stroke();
  context.beginPath();
  context.moveTo(endX, y);
  context.lineTo(endX - direction * 6, y - 4);
  context.lineTo(endX - direction * 6, y + 4);
  context.closePath();
  context.fill();
  context.restore();
}

function drawTimelineLabel(
  context: CanvasRenderingContext2D,
  text: string,
  anchorX: number,
  y: number,
  maxRight: number,
  style: { borderColor: string; fillColor: string }
): void {
  const paddingX = 6;
  const labelHeight = 18;
  const maxLabelWidth = 168;
  context.save();
  context.font = "11px Segoe UI";
  const measuredWidth = Math.min(maxLabelWidth, context.measureText(text).width + paddingX * 2);
  const left = Math.max(LABEL_WIDTH + 4, Math.min(anchorX + 8, maxRight - measuredWidth - 4));
  context.fillStyle = style.fillColor;
  context.strokeStyle = style.borderColor;
  context.fillRect(left, y, measuredWidth, labelHeight);
  context.strokeRect(left, y, measuredWidth, labelHeight);
  context.fillStyle = "#f8fafc";
  context.fillText(text, left + paddingX, y + 13, measuredWidth - paddingX * 2);
  context.restore();
}

function formatSignedOffset(milliseconds: Milliseconds): string {
  const rounded = Math.round(milliseconds);
  const sign = rounded >= 0 ? "+" : "-";
  const absolute = Math.abs(rounded);
  const fractionDigits = absolute % 1000 === 0 ? 0 : 3;
  return `${sign}${(absolute / 1000).toFixed(fractionDigits)}s`;
}

function drawPlayhead(
  context: CanvasRenderingContext2D,
  playheadMs: Milliseconds,
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  height: number
): void {
  const x = timeToX(playheadMs, scrollMs, pixelsPerSecond);
  if (x < LABEL_WIDTH || x > context.canvas.width) {
    return;
  }
  context.strokeStyle = "#ff6b6b";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(x, 0);
  context.lineTo(x, height);
  context.stroke();
  context.fillStyle = "#ff6b6b";
  context.beginPath();
  context.moveTo(x - 6, 0);
  context.lineTo(x + 6, 0);
  context.lineTo(x, 9);
  context.closePath();
  context.fill();
}

function drawEdgeFeedback(
  context: CanvasRenderingContext2D,
  edge: TimelineEdgeFeedback,
  width: number,
  height: number
): void {
  if (!edge) {
    return;
  }
  const x = edge === "start" ? LABEL_WIDTH : width - 1;
  const label = edge === "start" ? "已到时间轴开端" : "已到时间轴末端";
  context.save();
  context.strokeStyle = "#ff6b6b";
  context.fillStyle = "rgba(255, 107, 107, 0.12)";
  context.lineWidth = 4;
  context.fillRect(edge === "start" ? LABEL_WIDTH : width - 18, 0, 18, height);
  context.beginPath();
  context.moveTo(x, 0);
  context.lineTo(x, height);
  context.stroke();
  context.font = "12px Segoe UI";
  context.fillStyle = "#fecaca";
  const textWidth = context.measureText(label).width + 16;
  const labelX =
    edge === "start" ? LABEL_WIDTH + 10 : Math.max(LABEL_WIDTH + 10, width - textWidth - 12);
  context.fillStyle = "rgba(127, 29, 29, 0.78)";
  context.fillRect(labelX, 34, textWidth, 24);
  context.strokeStyle = "rgba(248, 113, 113, 0.9)";
  context.lineWidth = 1;
  context.strokeRect(labelX, 34, textWidth, 24);
  context.fillStyle = "#fee2e2";
  context.fillText(label, labelX + 8, 50);
  context.restore();
}

function chooseTickStep(pixelsPerSecond: number): Milliseconds {
  if (pixelsPerSecond < 0.1) {
    return 6 * 60 * 60_000;
  }
  if (pixelsPerSecond < 0.25) {
    return 60 * 60_000;
  }
  if (pixelsPerSecond < 0.7) {
    return 30 * 60_000;
  }
  if (pixelsPerSecond < 1.5) {
    return 10 * 60_000;
  }
  if (pixelsPerSecond < 4) {
    return 5 * 60_000;
  }
  if (pixelsPerSecond < 8) {
    return 2 * 60_000;
  }
  if (pixelsPerSecond < 18) {
    return 60_000;
  }
  if (pixelsPerSecond < 45) {
    return 20_000;
  }
  if (pixelsPerSecond < 110) {
    return 10_000;
  }
  if (pixelsPerSecond < 280) {
    return 2_000;
  }
  return 1_000;
}

function timeToX(
  timeMs: Milliseconds,
  scrollMs: Milliseconds,
  pixelsPerSecond: number
): number {
  return LABEL_WIDTH + ((timeMs - scrollMs) / 1000) * pixelsPerSecond;
}

function xToTime(x: number, scrollMs: Milliseconds, pixelsPerSecond: number): Milliseconds {
  return clampMilliseconds(scrollMs + ((x - LABEL_WIDTH) * 1000) / pixelsPerSecond);
}

function getPlayheadDragUpdate({
  pointX,
  width,
  scrollMs,
  pixelsPerSecond,
  durationMs
}: {
  pointX: number;
  width: number;
  scrollMs: Milliseconds;
  pixelsPerSecond: number;
  durationMs: Milliseconds;
}): { playheadMs: Milliseconds; scrollMs: Milliseconds; edge: TimelineEdgeFeedback } {
  const visibleMs = ((width - LABEL_WIDTH) * 1000) / pixelsPerSecond;
  const maxScrollMs = clampMilliseconds(Math.max(0, durationMs - visibleMs));
  let nextScrollMs = Math.min(scrollMs, maxScrollMs);

  if (pointX < LABEL_WIDTH + EDGE_SCROLL_ZONE_PX && scrollMs > 0) {
    const edgePressure = LABEL_WIDTH + EDGE_SCROLL_ZONE_PX - pointX;
    nextScrollMs = clampMilliseconds(scrollMs - (edgePressure * 1000) / pixelsPerSecond);
  } else if (pointX > width - EDGE_SCROLL_ZONE_PX && scrollMs < maxScrollMs) {
    const edgePressure = pointX - (width - EDGE_SCROLL_ZONE_PX);
    nextScrollMs = clampMilliseconds(
      Math.min(maxScrollMs, scrollMs + (edgePressure * 1000) / pixelsPerSecond)
    );
  }

  const clampedX = clamp(pointX, LABEL_WIDTH, width);
  const playheadMs = clampMilliseconds(
    clamp(xToTime(clampedX, nextScrollMs, pixelsPerSecond), 0, durationMs)
  );
  const edge =
    playheadMs <= 0 && pointX <= LABEL_WIDTH
      ? "start"
      : playheadMs >= durationMs && pointX >= width - EDGE_SCROLL_ZONE_PX
        ? "end"
        : null;

  return { playheadMs, scrollMs: nextScrollMs, edge };
}

function getCanvasPoint(
  event:
    | ReactPointerEvent<HTMLCanvasElement>
    | ReactWheelEvent<HTMLCanvasElement>
    | ReactMouseEvent<HTMLCanvasElement>
): {
  x: number;
  y: number;
} {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function isInsideTrack(y: number, track: TrackRect): boolean {
  return y >= track.y && y <= track.y + track.height;
}

function hitClip(
  point: { x: number; y: number },
  clips: DanmakuClip[],
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  tracks: TimelineTracks
): DanmakuClip | null {
  if (!isInsideTrack(point.y, tracks.clips)) {
    return null;
  }
  return (
    clips.find((clip) => {
      const x = timeToX(clip.timelineStartMs + clip.localOffsetMs, scrollMs, pixelsPerSecond);
      const width = Math.max(18, (getClipDurationMs(clip) / 1000) * pixelsPerSecond);
      return point.x >= x && point.x <= x + width;
    }) ?? null
  );
}

function hitCut(
  point: { x: number; y: number },
  markers: CutMarker[],
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  tracks: TimelineTracks
): CutMarker | null {
  if (!isInsideTrack(point.y, tracks.cuts)) {
    return null;
  }
  return (
    markers.find(
      (marker) => Math.abs(point.x - timeToX(marker.sourceAtMs, scrollMs, pixelsPerSecond)) <= 9
    ) ?? null
  );
}

function hitEvent(
  point: { x: number; y: number },
  events: ResolvedDanmakuEvent[],
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  tracks: TimelineTracks
): ResolvedDanmakuEvent | null {
  if (!isInsideTrack(point.y, tracks.events)) {
    return null;
  }
  let best: ResolvedDanmakuEvent | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const event of events) {
    const x = timeToX(event.finalTimeMs, scrollMs, pixelsPerSecond);
    const distance = Math.abs(point.x - x);
    if (distance < bestDistance && distance <= 8) {
      best = event;
      bestDistance = distance;
    }
  }
  return best;
}

function snapTime(
  timeMs: Milliseconds,
  playheadMs: Milliseconds,
  cutMarkers: CutMarker[]
): Milliseconds {
  const candidates = [playheadMs, ...cutMarkers.map((marker) => marker.sourceAtMs)];
  let best = timeMs;
  let bestDistance = SNAP_THRESHOLD_MS + 1;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - timeMs);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= SNAP_THRESHOLD_MS ? best : timeMs;
}
