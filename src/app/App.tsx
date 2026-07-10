import { Panel } from "../components/Panel";
import { AssetPanel } from "../features/assets/AssetPanel";
import { EditorToolbar } from "../features/editor/EditorToolbar";
import { KeyboardShortcuts } from "../features/editor/KeyboardShortcuts";
import { ExportDialog } from "../features/export/ExportDialog";
import { InspectorPanel } from "../features/inspector/InspectorPanel";
import { PreviewPanel } from "../features/preview/PreviewPanel";
import { TimelinePanel } from "../features/timeline/TimelinePanel";
import { formatExportFileError, openExportDirectoryPath } from "../infrastructure/file-system/exportFiles";
import { formatDesktopSettingsError, hydrateDesktopAppSettings } from "../infrastructure/settings/desktopAppSettings";
import { useEditorStore } from "../stores/editorStore";
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";

type ResizeTarget = "left" | "right" | "timeline";

const LEFT_PANEL_MIN = 220;
const LEFT_PANEL_MAX = 440;
const RIGHT_PANEL_MIN = 240;
const RIGHT_PANEL_MAX = 440;
const TIMELINE_MIN = 220;
const TIMELINE_MAX = 560;
const RESIZE_STEP = 24;

export function App() {
  const status = useEditorStore((state) => state.status);
  const importXmlFiles = useEditorStore((state) => state.importXmlFiles);
  const importMediaFiles = useEditorStore((state) => state.importMediaFiles);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const activeResizeRef = useRef<ResizeTarget | null>(null);
  const dragDepthRef = useRef(0);
  const [leftPanelWidth, setLeftPanelWidth] = useState(280);
  const [rightPanelWidth, setRightPanelWidth] = useState(300);
  const [timelineHeight, setTimelineHeight] = useState(320);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    let mounted = true;
    void hydrateDesktopAppSettings().catch((error) => {
      if (!mounted) {
        return;
      }
      useEditorStore.setState({
        status: {
          message: `读取桌面应用设置失败，已使用浏览器本地设置：${formatDesktopSettingsError(error)}`,
          tone: "warning"
        }
      });
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const target = activeResizeRef.current;
      const workspace = workspaceRef.current;
      if (!target || !workspace) {
        return;
      }
      const bounds = workspace.getBoundingClientRect();
      if (target === "left") {
        setLeftPanelWidth(clampNumber(event.clientX - bounds.left, LEFT_PANEL_MIN, LEFT_PANEL_MAX));
        return;
      }
      if (target === "right") {
        setRightPanelWidth(clampNumber(bounds.right - event.clientX, RIGHT_PANEL_MIN, RIGHT_PANEL_MAX));
        return;
      }
      const availableHeight = bounds.height;
      setTimelineHeight(clampNumber(bounds.bottom - event.clientY, TIMELINE_MIN, Math.min(TIMELINE_MAX, availableHeight - 260)));
    };

    const handlePointerUp = () => {
      activeResizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  const beginResize = (target: ResizeTarget) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    activeResizeRef.current = target;
    document.body.style.cursor = target === "timeline" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const runStatusAction = () => {
    if (status.action?.type !== "openDirectory") {
      return;
    }
    void openExportDirectoryPath(status.action.directoryPath).catch((error) => {
      useEditorStore.setState({
        status: {
          message: `打开导出文件夹失败：${formatExportFileError(error)}`,
          tone: "error"
        }
      });
    });
  };

  const handleDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragActive(false);
    }
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files);
    const xmlFiles = files.filter(isXmlFile);
    const videoFiles = files.filter(isSupportedReferenceVideoFile);
    if (videoFiles.length > 0) {
      importMediaFiles(videoFiles, "bilibiliReference");
    }
    if (xmlFiles.length > 0) {
      void importXmlFiles(xmlFiles);
    }
    if (videoFiles.length === 0 && xmlFiles.length === 0) {
      useEditorStore.setState({
        status: {
          message: "拖放文件未导入：请拖入 Bilibili XML，或 MP4/WebM 参考视频。",
          tone: "warning"
        }
      });
    }
  };

  return (
    <div
      className="relative flex h-screen min-h-0 flex-col bg-[#101216] text-slate-100"
      data-testid="app-root"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <KeyboardShortcuts />
      <EditorToolbar />
      {dragActive ? (
        <div className="pointer-events-none fixed inset-3 z-50 grid place-items-center rounded border-2 border-dashed border-accent-cyan bg-black/70 text-center text-sm text-slate-200 shadow-2xl">
          <div className="grid gap-2">
            <div className="text-base font-medium text-slate-100">拖放导入</div>
            <div className="text-xs text-slate-400">支持 Bilibili XML 和 MP4/WebM 参考视频；目标原片请在“媒体 / 目标原片”中绑定。</div>
          </div>
        </div>
      ) : null}
      <main
        ref={workspaceRef}
        className="grid min-h-0 flex-1 bg-panel-line"
        style={{
          gridTemplateColumns: `${leftPanelWidth}px 6px minmax(420px, 1fr) 6px ${rightPanelWidth}px`,
          gridTemplateRows: `minmax(260px, 1fr) 6px ${timelineHeight}px`
        }}
      >
        <Panel title="资源" className="row-span-3">
          <AssetPanel />
        </Panel>
        <ResizeHandle
          label="调整资源栏宽度"
          orientation="vertical"
          value={leftPanelWidth}
          min={LEFT_PANEL_MIN}
          max={LEFT_PANEL_MAX}
          className="row-span-3"
          onPointerDown={beginResize("left")}
          onKeyboardStep={(delta) => setLeftPanelWidth((width) => clampNumber(width + delta, LEFT_PANEL_MIN, LEFT_PANEL_MAX))}
        />
        <Panel title="预览" className="min-h-0">
          <PreviewPanel />
        </Panel>
        <ResizeHandle
          label="调整检查器宽度"
          orientation="vertical"
          value={rightPanelWidth}
          min={RIGHT_PANEL_MIN}
          max={RIGHT_PANEL_MAX}
          className="row-span-3"
          onPointerDown={beginResize("right")}
          onKeyboardStep={(delta) => setRightPanelWidth((width) => clampNumber(width - delta, RIGHT_PANEL_MIN, RIGHT_PANEL_MAX))}
        />
        <Panel title="检查器" className="row-span-3">
          <InspectorPanel />
        </Panel>
        <ResizeHandle
          label="调整时间轴高度"
          orientation="horizontal"
          value={timelineHeight}
          min={TIMELINE_MIN}
          max={TIMELINE_MAX}
          className="col-start-3"
          onPointerDown={beginResize("timeline")}
          onKeyboardStep={(delta) => setTimelineHeight((height) => clampNumber(height - delta, TIMELINE_MIN, TIMELINE_MAX))}
        />
        <Panel className="min-h-0">
          <TimelinePanel />
        </Panel>
      </main>
      <footer
        className={`flex h-7 shrink-0 items-center border-t border-panel-line px-3 text-xs ${
          status.tone === "error"
            ? "bg-accent-red/10 text-accent-red"
            : status.tone === "warning"
              ? "bg-accent-yellow/10 text-accent-yellow"
              : status.tone === "success"
                ? "bg-accent-green/10 text-accent-green"
                : "bg-[#111318] text-slate-400"
        }`}
        data-testid="status-bar"
      >
        <span className="min-w-0 flex-1 truncate">{status.message}</span>
        {status.action ? (
          <button
            type="button"
            className="ml-3 shrink-0 rounded border border-current/30 px-2 py-0.5 text-[11px] transition hover:bg-current/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-current"
            onClick={runStatusAction}
          >
            {status.action.label}
          </button>
        ) : null}
      </footer>
      <ExportDialog />
    </div>
  );
}

function ResizeHandle({
  label,
  orientation,
  value,
  min,
  max,
  className,
  onPointerDown,
  onKeyboardStep
}: {
  label: string;
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  className?: string;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onKeyboardStep: (delta: number) => void;
}) {
  return (
    <button
      type="button"
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      title={label}
      className={`group flex items-center justify-center bg-panel-line transition hover:bg-accent-cyan/40 focus-visible:bg-accent-cyan/40 ${
        orientation === "vertical" ? "cursor-col-resize" : "cursor-row-resize"
      } ${className ?? ""}`}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          onKeyboardStep(-RESIZE_STEP);
          event.preventDefault();
        }
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          onKeyboardStep(RESIZE_STEP);
          event.preventDefault();
        }
      }}
    >
      <span
        className={`rounded-full bg-slate-500/80 transition group-hover:bg-accent-cyan group-focus-visible:bg-accent-cyan ${
          orientation === "vertical" ? "h-10 w-0.5" : "h-0.5 w-10"
        }`}
      />
    </button>
  );
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hasFileDrag(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function isXmlFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".xml") || file.type === "text/xml" || file.type === "application/xml";
}

function isSupportedReferenceVideoFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".mp4") ||
    name.endsWith(".webm") ||
    file.type === "video/mp4" ||
    file.type === "video/webm"
  );
}
