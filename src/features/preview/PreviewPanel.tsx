import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "../../components/IconButton";
import { TextButton } from "../../components/TextButton";
import type { ResolvedDanmakuEvent } from "../../domain/danmaku/types";
import {
  getPreviewEvents,
  ROLLING_DANMAKU_DURATION_MS,
  STATIC_DANMAKU_DURATION_MS
} from "../../domain/preview/visibleEvents";
import { formatTimecode } from "../../domain/shared/time";
import { resolveProjectDanmakuEvents } from "../../domain/timeline/mapping";
import { HtmlVideoMediaAdapter } from "../../infrastructure/media/mediaAdapter";
import { useEditorStore } from "../../stores/editorStore";

export function PreviewPanel() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const adapterRef = useRef<HtmlVideoMediaAdapter | null>(null);
  const playheadRef = useRef(0);
  const project = useEditorStore((state) => state.project);
  const isPlaying = useEditorStore((state) => state.isPlaying);
  const setPlaying = useEditorStore((state) => state.setPlaying);
  const togglePlayback = useEditorStore((state) => state.togglePlayback);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const updateMediaDuration = useEditorStore((state) => state.updateMediaDuration);
  const updatePreview = useEditorStore((state) => state.updatePreview);
  const [videoError, setVideoError] = useState<string | null>(null);
  const mediaObjectUrl = project.media?.objectUrl ?? null;
  const mediaName = project.media?.name ?? "视频";

  const events = useMemo(() => resolveProjectDanmakuEvents(project), [project]);
  const visibleEvents = useMemo(
    () => getPreviewEvents(events, project.timeline.playheadMs),
    [events, project.timeline.playheadMs]
  );

  useEffect(() => {
    playheadRef.current = project.timeline.playheadMs;
  }, [project.timeline.playheadMs]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const adapter = new HtmlVideoMediaAdapter(video);
    adapterRef.current = adapter;
    return () => {
      adapter.dispose();
      adapterRef.current = null;
    };
  }, []);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter || !mediaObjectUrl) {
      return;
    }
    let cancelled = false;
    setVideoError(null);
    void adapter
      .load({ kind: "file", name: mediaName, url: mediaObjectUrl })
      .then(() => {
        if (!cancelled) {
          updateMediaDuration(adapter.getDurationMs());
          adapter.seek(playheadRef.current);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setVideoError(error instanceof Error ? error.message : "视频加载失败。");
          setPlaying(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mediaName, mediaObjectUrl, setPlaying, updateMediaDuration]);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) {
      return;
    }
    if (Math.abs(adapter.getCurrentTimeMs() - project.timeline.playheadMs) > 240) {
      adapter.seek(project.timeline.playheadMs);
    }
  }, [project.timeline.playheadMs]);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) {
      return;
    }
    if (isPlaying) {
      void adapter.play().catch(() => setPlaying(false));
    } else {
      adapter.pause();
    }
  }, [isPlaying, setPlaying]);

  useEffect(() => {
    let raf = 0;
    let lastTick = performance.now();
    const tick = (now: number): void => {
      if (isPlaying) {
        const adapter = adapterRef.current;
        if (adapter && mediaObjectUrl) {
          setPlayhead(adapter.getCurrentTimeMs());
        } else {
          const delta = now - lastTick;
          setPlayhead(playheadRef.current + delta);
        }
      }
      lastTick = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, mediaObjectUrl, setPlayhead]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0d0f13]">
      <div
        className="relative min-h-0 flex-1 overflow-hidden bg-black"
        data-testid="preview-panel"
      >
        {project.media?.objectUrl ? (
          <video
            ref={videoRef}
            className="h-full w-full object-contain"
            onPause={() => setPlaying(false)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-center text-sm text-slate-500">
            <div>
              <div className="text-slate-300">尚未导入视频</div>
              <div className="mt-2 text-xs">
                当前仍可编辑弹幕时间轴，导入 MP4/WebM 后可同步预览。
              </div>
            </div>
          </div>
        )}
        {videoError ? (
          <div className="absolute left-4 top-4 rounded border border-accent-red/40 bg-accent-red/10 px-3 py-2 text-xs text-accent-red">
            {videoError}
          </div>
        ) : null}
        {project.preview.safeAreaVisible ? (
          <div className="pointer-events-none absolute inset-[8%] border border-dashed border-white/35" />
        ) : null}
        {project.preview.danmakuVisible ? (
          <DanmakuOverlay
            events={visibleEvents}
            currentTimeMs={project.timeline.playheadMs}
            opacity={project.preview.opacity}
          />
        ) : null}
      </div>
      <div className="flex h-12 shrink-0 items-center gap-3 border-t border-panel-line bg-panel-base px-3">
        <IconButton
          label={isPlaying ? "暂停预览" : "播放预览"}
          icon={isPlaying ? <Pause size={16} /> : <Play size={16} />}
          active={isPlaying}
          onClick={togglePlayback}
        />
        <div className="font-mono text-xs text-slate-300">
          {formatTimecode(project.timeline.playheadMs)}
        </div>
        <div className="text-xs text-slate-500">
          / {formatTimecode(project.media?.durationMs ?? 0)}
        </div>
        <TextButton
          onClick={() => updatePreview({ danmakuVisible: !project.preview.danmakuVisible })}
        >
          {project.preview.danmakuVisible ? "隐藏弹幕" : "显示弹幕"}
        </TextButton>
        <label className="ml-auto flex items-center gap-2 text-xs text-slate-400">
          透明度
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={project.preview.opacity}
            className="w-28 accent-accent-cyan"
            onChange={(event) => updatePreview({ opacity: Number(event.target.value) })}
          />
        </label>
      </div>
    </div>
  );
}

function DanmakuOverlay({
  events,
  currentTimeMs,
  opacity
}: {
  events: ResolvedDanmakuEvent[];
  currentTimeMs: number;
  opacity: number;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      data-testid="danmaku-overlay"
    >
      {events.map((event) => {
        const mode = event.item.mode ?? 1;
        const isTop = mode === 5;
        const isBottom = mode === 4;
        const duration =
          isTop || isBottom ? STATIC_DANMAKU_DURATION_MS : ROLLING_DANMAKU_DURATION_MS;
        const progress = Math.min(
          1,
          Math.max(0, (currentTimeMs - event.finalTimeMs) / duration)
        );
        const lane = event.originalIndex % 10;
        const fontSize = Math.min(34, Math.max(14, event.item.fontSize ?? 25));
        const color = `#${(event.item.color ?? 16_777_215).toString(16).padStart(6, "0").slice(-6)}`;
        const baseStyle = {
          color,
          fontSize: `${fontSize}px`,
          opacity,
          textShadow: "0 1px 2px #000, 0 0 2px #000"
        };
        if (isTop || isBottom) {
          return (
            <div
              key={event.id}
              className="absolute left-1/2 max-w-[88%] -translate-x-1/2 whitespace-nowrap font-semibold"
              style={{
                ...baseStyle,
                top: isTop ? `${5 + lane * 6}%` : undefined,
                bottom: isBottom ? `${5 + lane * 6}%` : undefined
              }}
            >
              {event.item.text}
            </div>
          );
        }
        return (
          <div
            key={event.id}
            className="absolute whitespace-nowrap font-semibold"
            style={{
              ...baseStyle,
              top: `${6 + lane * 7}%`,
              left: `${100 - progress * 145}%`
            }}
          >
            {event.item.text}
          </div>
        );
      })}
    </div>
  );
}
