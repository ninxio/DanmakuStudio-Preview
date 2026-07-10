import { Flag, Pause, Play } from "lucide-react";
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
import {
  HtmlVideoMediaAdapter,
  TauriMpvMediaAdapter,
  type MediaAdapter
} from "../../infrastructure/media/mediaAdapter";
import { loadAppSettings } from "../../infrastructure/settings/appSettings";
import { useEditorStore } from "../../stores/editorStore";

type VideoLoadState = "empty" | "loading" | "ready" | "unsupported";
type PreviewBackend = "htmlVideo" | "nativeMpv";

export function PreviewPanel() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const adapterRef = useRef<MediaAdapter | null>(null);
  const playheadRef = useRef(0);
  const loadedSourceRef = useRef<string | null>(null);
  const project = useEditorStore((state) => state.project);
  const isPlaying = useEditorStore((state) => state.isPlaying);
  const setPlaying = useEditorStore((state) => state.setPlaying);
  const togglePlayback = useEditorStore((state) => state.togglePlayback);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const updateMediaDuration = useEditorStore((state) => state.updateMediaDuration);
  const updatePreview = useEditorStore((state) => state.updatePreview);
  const addCutMarkerAtPlayhead = useEditorStore((state) => state.addCutMarkerAtPlayhead);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoLoadState, setVideoLoadState] = useState<VideoLoadState>("empty");
  const appSettings = loadAppSettings();
  const preferredBackend = appSettings.player.preferredBackend;
  const mpvPath = appSettings.player.mpvPath;
  const mediaObjectUrl = project.media?.objectUrl ?? null;
  const mediaName = project.media?.name ?? "视频";
  const localMediaPath =
    project.mediaBinding?.kind === "localFile" ? project.mediaBinding.localPath?.trim() ?? "" : "";
  const localMediaFileName = project.mediaBinding?.kind === "localFile" ? project.mediaBinding.fileName : mediaName;
  const hasLocalMediaPath = localMediaPath.length > 0;
  const canUseNativeMpv = mpvPath.trim().length > 0 && hasLocalMediaPath;
  const previewBackend: PreviewBackend =
    canUseNativeMpv && (preferredBackend === "nativeMpv" || (preferredBackend === "auto" && !mediaObjectUrl))
      ? "nativeMpv"
      : "htmlVideo";
  const previewSource = previewBackend === "nativeMpv" ? localMediaPath : mediaObjectUrl;
  const previewSourceName = previewBackend === "nativeMpv" ? localMediaFileName : mediaName;
  const mediaFileName = previewBackend === "nativeMpv" ? localMediaFileName : project.media?.fileName ?? mediaName;
  const previewDurationMs = project.media?.durationMs ?? project.mediaBinding?.runtimeMs ?? 0;
  const localBindingNeedsReconnect =
    project.mediaBinding?.kind === "localFile" &&
    !hasLocalMediaPath &&
    (!project.media ||
      !project.media.objectUrl ||
      (project.mediaBinding.mediaId
        ? project.media.id !== project.mediaBinding.mediaId
        : project.media.fileName !== project.mediaBinding.fileName));
  const mediaReferenceNeedsReconnect = Boolean(project.media && !project.media.objectUrl);

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
    const adapter =
      previewBackend === "nativeMpv"
        ? new TauriMpvMediaAdapter(mpvPath)
        : video
          ? new HtmlVideoMediaAdapter(video)
          : null;
    if (!adapter) {
      return;
    }
    adapterRef.current = adapter;
    loadedSourceRef.current = null;
    return () => {
      adapter.dispose();
      if (adapterRef.current === adapter) {
        adapterRef.current = null;
      }
    };
  }, [mpvPath, previewBackend]);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) {
      return;
    }
    if (!previewSource) {
      if (loadedSourceRef.current) {
        adapter.dispose();
        loadedSourceRef.current = null;
      }
      setVideoError(null);
      setVideoLoadState("empty");
      setPlaying(false);
      return;
    }
    let cancelled = false;
    const sourceKey = `${previewBackend}:${previewSource}`;
    setVideoLoadState("loading");
    setVideoError(null);
    void adapter
      .load({ kind: "file", name: previewSourceName, url: previewSource })
      .then(() => {
        if (!cancelled) {
          loadedSourceRef.current = sourceKey;
          updateMediaDuration(adapter.getDurationMs());
          adapter.seek(playheadRef.current);
          setVideoLoadState("ready");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setVideoError(error instanceof Error ? error.message : "视频加载失败。");
          setVideoLoadState("unsupported");
          setPlaying(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [previewBackend, previewSource, previewSourceName, setPlaying, updateMediaDuration]);

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
        if (adapter && previewSource) {
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
  }, [isPlaying, previewSource, setPlayhead]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0d0f13]">
      <div
        className="relative min-h-0 flex-1 overflow-hidden bg-black"
        data-testid="preview-panel"
      >
        <video
          ref={videoRef}
          aria-label="视频预览画面"
          className={`h-full w-full object-contain transition-opacity ${
            previewBackend === "htmlVideo" && mediaObjectUrl ? "opacity-100" : "opacity-0"
          }`}
          data-testid="preview-video"
          playsInline
          preload="metadata"
          onPause={() => setPlaying(false)}
        />
        {!previewSource ? (
          <div className="absolute inset-0 flex items-center justify-center text-center text-sm text-slate-500">
            <div className="max-w-[min(420px,calc(100%-32px))]">
              <div className="text-slate-300">
                {localBindingNeedsReconnect || mediaReferenceNeedsReconnect
                  ? "需要重新连接视频"
                  : preferredBackend === "nativeMpv" && !hasLocalMediaPath
                    ? "需要选择本地原片路径"
                    : "尚未导入视频"}
              </div>
              <div className="mt-2 text-xs leading-5">
                {localBindingNeedsReconnect
                  ? "项目保存了目标原片引用，但没有保存视频内容。请重新导入同一份本地视频。"
                  : mediaReferenceNeedsReconnect
                    ? "项目里只有媒体引用，没有当前会话可播放的视频对象。请重新导入本地视频。"
                    : preferredBackend === "nativeMpv" && !hasLocalMediaPath
                      ? "mpv 需要真实本地文件路径。请在“媒体 / 目标原片”里选择本地路径。"
                      : "当前仍可编辑弹幕时间轴，导入 MP4/WebM 后可同步预览。"}
              </div>
            </div>
          </div>
        ) : null}
        {previewBackend === "nativeMpv" && previewSource ? (
          <div className="absolute inset-0 flex items-center justify-center text-center text-sm text-slate-500">
            <div className="max-w-[min(420px,calc(100%-32px))]">
              <div className="text-slate-300">mpv 桌面播放器</div>
              <div className="mt-2 text-xs leading-5">
                本地视频正在 mpv 窗口中播放；这里继续显示播放头、时间和弹幕预览状态。
              </div>
            </div>
          </div>
        ) : null}
        {previewSource ? (
          <div className="absolute left-3 top-3 max-w-[min(420px,calc(100%-24px))] rounded border border-white/10 bg-black/55 px-3 py-2 text-xs text-slate-300 shadow-lg backdrop-blur">
            <div className="truncate font-medium text-slate-100">{mediaFileName}</div>
            <div className="mt-1 text-slate-400">
              {videoLoadState === "loading"
                ? "正在加载预览..."
                : videoLoadState === "ready"
                  ? `${formatPreviewBackend(previewBackend)} 已就绪 / ${formatTimecode(previewDurationMs)}`
                  : videoLoadState === "unsupported"
                    ? "格式不支持"
                    : "等待视频载入"}
            </div>
          </div>
        ) : null}
        {videoError ? (
          <div className="absolute left-4 top-4 max-w-[min(520px,calc(100%-32px))] rounded border border-accent-red/40 bg-accent-red/10 px-3 py-2 text-xs leading-5 text-accent-red">
            <div className="font-medium">格式不支持</div>
            <div>{videoError}</div>
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
          / {formatTimecode(previewDurationMs)}
        </div>
        <div className="text-xs text-slate-500">
          {formatPreviewBackend(previewBackend)}
        </div>
        <TextButton
          onClick={() => updatePreview({ danmakuVisible: !project.preview.danmakuVisible })}
        >
          {project.preview.danmakuVisible ? "隐藏弹幕" : "显示弹幕"}
        </TextButton>
        <TextButton onClick={addCutMarkerAtPlayhead}>
          <Flag size={14} />
          添加播放点差异
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

function formatPreviewBackend(backend: PreviewBackend): string {
  return backend === "nativeMpv" ? "mpv" : "HTML Video";
}
