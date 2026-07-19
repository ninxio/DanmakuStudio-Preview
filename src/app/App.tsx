import { Panel } from "../components/Panel";
import { TextButton } from "../components/TextButton";
import { createUsabilityViewModel } from "../domain/project/usabilityViewModel";
import { AssetPanel } from "../features/assets/AssetPanel";
import { CalibrationOverview } from "../features/editor/CalibrationOverview";
import { EditorToolbar } from "../features/editor/EditorToolbar";
import { KeyboardShortcuts } from "../features/editor/KeyboardShortcuts";
import { InspectorPanel } from "../features/inspector/InspectorPanel";
import { PreviewPanel } from "../features/preview/PreviewPanel";
import { TimelinePanel } from "../features/timeline/TimelinePanel";
import { BackgroundTaskBar } from "../features/workspace/BackgroundTaskBar";
import { ContextRail } from "../features/workspace/ContextRail";
import { ProjectSidebar } from "../features/workspace/ProjectSidebar";
import {
  formatExportFileError,
  openExportDirectoryPath
} from "../infrastructure/file-system/exportFiles";
import {
  formatDesktopSettingsError,
  hydrateDesktopAppSettings
} from "../infrastructure/settings/desktopAppSettings";
import {
  loadAppLayoutSettings,
  saveAppLayoutSettings,
  type AppLayoutSettings
} from "../infrastructure/settings/appLayoutSettings";
import { useEditorStore } from "../stores/editorStore";
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from "react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

const ExportDialog = lazy(async () => {
  const module = await import("../features/export/ExportDialog");
  return { default: module.ExportDialog };
});

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
  const project = useEditorStore((state) => state.project);
  const importProgress = useEditorStore((state) => state.importProgress);
  const exportDraft = useEditorStore((state) => state.exportDraft);
  const workspacePage = useEditorStore((state) => state.workspacePage);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const importXmlFiles = useEditorStore((state) => state.importXmlFiles);
  const importMediaFiles = useEditorStore((state) => state.importMediaFiles);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const activeResizeRef = useRef<ResizeTarget | null>(null);
  const dragDepthRef = useRef(0);
  const [leftPanelWidth, setLeftPanelWidth] = useState(280);
  const [rightPanelWidth, setRightPanelWidth] = useState(300);
  const [timelineHeight, setTimelineHeight] = useState(320);
  const [dragActive, setDragActive] = useState(false);
  const [pendingDroppedVideos, setPendingDroppedVideos] = useState<File[]>([]);
  const [layoutSettings, setLayoutSettings] = useState<AppLayoutSettings>(() =>
    loadAppLayoutSettings()
  );
  const usabilityModel = useMemo(
    () => createUsabilityViewModel(project),
    [project]
  );

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
        setLeftPanelWidth(
          clampNumber(event.clientX - bounds.left, LEFT_PANEL_MIN, LEFT_PANEL_MAX)
        );
        return;
      }
      if (target === "right") {
        setRightPanelWidth(
          clampNumber(bounds.right - event.clientX, RIGHT_PANEL_MIN, RIGHT_PANEL_MAX)
        );
        return;
      }
      const availableHeight = bounds.height;
      setTimelineHeight(
        clampNumber(
          bounds.bottom - event.clientY,
          TIMELINE_MIN,
          Math.min(TIMELINE_MAX, availableHeight - 260)
        )
      );
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

  const beginResize =
    (target: ResizeTarget) => (event: ReactPointerEvent<HTMLButtonElement>) => {
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

  const updateLayoutSettings = (patch: Partial<AppLayoutSettings>) => {
    setLayoutSettings((current) =>
      saveAppLayoutSettings({ ...current, ...patch })
    );
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
      setPendingDroppedVideos(videoFiles);
      useEditorStore.setState({
        status: {
          message: `已收到 ${videoFiles.length} 个视频，请确认它们是原片素材还是 B 站参考素材。`,
          tone: "neutral"
        }
      });
    }
    if (xmlFiles.length > 0) {
      void importXmlFiles(xmlFiles);
    }
    if (videoFiles.length === 0 && xmlFiles.length === 0) {
      useEditorStore.setState({
        status: {
          message: "拖放文件未导入：请拖入 Bilibili XML 或受支持的视频文件。",
          tone: "warning"
        }
      });
      return;
    }
    setWorkspacePage("materials");
  };

  return (
    <div
      className={`app-shell relative flex h-screen min-h-0 flex-col bg-[#0d1015] text-slate-100 ${
        layoutSettings.reduceMotion ? "reduce-motion" : ""
      }`}
      data-testid="app-root"
      data-density={layoutSettings.density}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <KeyboardShortcuts />
      <EditorToolbar
        projectSidebarCollapsed={layoutSettings.projectSidebarCollapsed}
        contextPanelCollapsed={layoutSettings.contextPanelCollapsed}
        onToggleProjectSidebar={() =>
          updateLayoutSettings({
            projectSidebarCollapsed: !layoutSettings.projectSidebarCollapsed
          })
        }
        onToggleContextPanel={() =>
          updateLayoutSettings({
            contextPanelCollapsed: !layoutSettings.contextPanelCollapsed
          })
        }
      />
      {dragActive ? (
        <div className="pointer-events-none fixed inset-3 z-50 grid place-items-center rounded border-2 border-dashed border-accent-cyan bg-black/70 text-center text-sm text-slate-200 shadow-2xl">
          <div className="grid gap-2">
            <div className="text-base font-medium text-slate-100">拖放导入</div>
            <div className="text-xs text-slate-400">
              支持 Bilibili XML 和视频；视频放下后需要确认素材角色。
            </div>
          </div>
        </div>
      ) : null}
      {pendingDroppedVideos.length > 0 ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="drop-role-title"
        >
          <div className="w-full max-w-md rounded border border-panel-line bg-[#171a20] p-4 shadow-2xl">
            <h2 id="drop-role-title" className="text-base font-semibold text-slate-100">
              确认视频角色
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              共 {pendingDroppedVideos.length} 个视频。原片是最终观看的标准时间轴；B
              站参考只用于确定弹幕原始时间和删减关系。
            </p>
            <p className="mt-2 rounded border border-accent-yellow/30 bg-accent-yellow/10 p-2 text-xs leading-5 text-accent-yellow">
              拖放视频会作为本次会话的临时引用。若要保存本地路径并运行自动匹配，请改用素材页的批量导入按钮。
            </p>
            <div className="mt-3 max-h-32 overflow-auto rounded border border-panel-line bg-black/20 p-2 text-xs text-slate-500">
              {pendingDroppedVideos.map((file) => (
                <div key={`${file.name}-${file.size}`}>{file.name}</div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <TextButton onClick={() => setPendingDroppedVideos([])}>取消</TextButton>
              <TextButton
                onClick={() => {
                  importMediaFiles(pendingDroppedVideos, "bilibiliReference");
                  setPendingDroppedVideos([]);
                }}
              >
                作为 B 站参考导入
              </TextButton>
              <TextButton
                tone="primary"
                onClick={() => {
                  importMediaFiles(pendingDroppedVideos, "targetOriginal");
                  setPendingDroppedVideos([]);
                }}
              >
                作为原片导入
              </TextButton>
            </div>
          </div>
        </div>
      ) : null}
      {workspacePage === "editing" ? (
        <main
          ref={workspaceRef}
          className="grid min-h-0 flex-1 bg-panel-line"
          data-testid="workspace-editing"
          style={{
            gridTemplateColumns: `${leftPanelWidth}px 6px minmax(420px, 1fr) 6px ${rightPanelWidth}px`,
            gridTemplateRows: `minmax(260px, 1fr) 6px ${timelineHeight}px`
          }}
        >
          <Panel title="弹幕素材与高级工具" className="row-span-3">
            <AssetPanel section="editing" />
          </Panel>
          <ResizeHandle
            label="调整资源栏宽度"
            orientation="vertical"
            value={leftPanelWidth}
            min={LEFT_PANEL_MIN}
            max={LEFT_PANEL_MAX}
            className="row-span-3"
            onPointerDown={beginResize("left")}
            onKeyboardStep={(delta) =>
              setLeftPanelWidth((width) =>
                clampNumber(width + delta, LEFT_PANEL_MIN, LEFT_PANEL_MAX)
              )
            }
          />
          <Panel title="校准预览" className="min-h-0">
            <div className="flex h-full min-h-0 flex-col">
              <CalibrationOverview />
              <div className="min-h-0 flex-1">
                <PreviewPanel />
              </div>
            </div>
          </Panel>
          <ResizeHandle
            label="调整检查器宽度"
            orientation="vertical"
            value={rightPanelWidth}
            min={RIGHT_PANEL_MIN}
            max={RIGHT_PANEL_MAX}
            className="row-span-3"
            onPointerDown={beginResize("right")}
            onKeyboardStep={(delta) =>
              setRightPanelWidth((width) =>
                clampNumber(width - delta, RIGHT_PANEL_MIN, RIGHT_PANEL_MAX)
              )
            }
          />
          <Panel title="所选对象与高级参数" className="row-span-3">
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
            onKeyboardStep={(delta) =>
              setTimelineHeight((height) =>
                clampNumber(height - delta, TIMELINE_MIN, TIMELINE_MAX)
              )
            }
          />
          <Panel title="时间关系" className="min-h-0">
            <TimelinePanel />
          </Panel>
        </main>
      ) : (
        <main
          className="flex min-h-0 flex-1 overflow-hidden"
          data-testid={`workspace-${workspacePage}`}
        >
          {layoutSettings.projectSidebarCollapsed ? null : (
            <ProjectSidebar project={project} model={usabilityModel} />
          )}
          <div className="min-w-0 flex-1 overflow-hidden bg-[#0f1217] p-3">
            <div className="mx-auto flex h-full w-full max-w-[1180px] min-h-0 flex-col overflow-hidden rounded-xl border border-panel-line bg-panel-base shadow-[0_12px_40px_rgba(0,0,0,0.18)]">
              <Panel
                title={
                  workspacePage === "materials"
                    ? "素材"
                    : workspacePage === "matching"
                      ? "智能匹配"
                      : "导出"
                }
                className="min-h-0 flex-1"
              >
                <AssetPanel section={workspacePage} />
              </Panel>
            </div>
          </div>
          {layoutSettings.contextPanelCollapsed ? null : (
            <ContextRail model={usabilityModel} pageId={workspacePage} />
          )}
        </main>
      )}
      <BackgroundTaskBar
        status={status}
        progress={importProgress}
        onAction={runStatusAction}
      />
      {exportDraft ? (
        <Suspense fallback={null}>
          <ExportDialog />
        </Suspense>
      ) : null}
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
    [".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".flv", ".ts", ".m2ts"].some(
      (extension) => name.endsWith(extension)
    ) || file.type.startsWith("video/")
  );
}
