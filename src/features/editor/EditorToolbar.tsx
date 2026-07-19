import {
  AppWindow,
  FilePlus,
  FolderOpen,
  Map as MapIcon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Redo2,
  Save,
  Settings,
  Undo2,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { IconButton } from "../../components/IconButton";
import { createProjectDownloadFileName } from "../../domain/project/fileNames";
import { serializeProject } from "../../domain/project/schema";
import { createUsabilityViewModel } from "../../domain/project/usabilityViewModel";
import { formatTimecode } from "../../domain/shared/time";
import {
  sliderValueToZoom,
  TIMELINE_ZOOM_SLIDER_MAX,
  TIMELINE_ZOOM_SLIDER_MIN,
  zoomToSliderValue
} from "../../domain/timeline/view";
import { downloadTextFile, readTextFile } from "../../infrastructure/file-system/browserFiles";
import { useEditorStore } from "../../stores/editorStore";
import { WorkflowStepper } from "../workspace/WorkflowStepper";
import { SettingsDialog } from "./SettingsDialog";
import { WorkflowOverviewDialog } from "./WorkflowOverviewDialog";

export function EditorToolbar({
  projectSidebarCollapsed = false,
  contextPanelCollapsed = false,
  onToggleProjectSidebar,
  onToggleContextPanel
}: {
  projectSidebarCollapsed?: boolean;
  contextPanelCollapsed?: boolean;
  onToggleProjectSidebar?: () => void;
  onToggleContextPanel?: () => void;
} = {}) {
  const projectInputRef = useRef<HTMLInputElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const project = useEditorStore((state) => state.project);
  const isPlaying = useEditorStore((state) => state.isPlaying);
  const workspacePage = useEditorStore((state) => state.workspacePage);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const newProject = useEditorStore((state) => state.newProject);
  const openProjectFromText = useEditorStore((state) => state.openProjectFromText);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const togglePlayback = useEditorStore((state) => state.togglePlayback);
  const setTimelineZoom = useEditorStore((state) => state.setTimelineZoom);
  const usabilityModel = useMemo(
    () => createUsabilityViewModel(project),
    [project]
  );

  const saveProjectFile = () => {
    const fileName = downloadTextFile(
      createProjectDownloadFileName(project.name, ".danmaku-project.json"),
      serializeProject(project),
      "application/json;charset=utf-8"
    );
    useEditorStore.setState({
      status: { message: `已保存项目文件：${fileName}。`, tone: "success" }
    });
  };

  return (
    <header className="shrink-0 border-b border-panel-line bg-[#11141a]">
      <div className="flex h-11 items-center gap-2 px-3">
        <div className="mr-2 flex min-w-[212px] items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg border border-accent-cyan/25 bg-accent-cyan/10 text-accent-cyan">
            <AppWindow size={15} />
          </span>
          <div className="min-w-0">
            <div className="text-xs font-semibold tracking-wide text-slate-100">
              Danmaku Studio
            </div>
            <div
              className="truncate text-[10px] text-slate-500"
              title={project.name}
            >
              {project.name}
            </div>
          </div>
        </div>
        <IconButton
          label="新建项目"
          icon={<FilePlus size={15} />}
          onClick={newProject}
        />
        <IconButton
          label="打开项目"
          icon={<FolderOpen size={15} />}
          onClick={() => projectInputRef.current?.click()}
        />
        <IconButton
          label="保存项目"
          icon={<Save size={15} />}
          onClick={saveProjectFile}
        />
        <span className="mx-1 h-5 w-px bg-panel-line" />
        <IconButton label="撤销" icon={<Undo2 size={15} />} onClick={undo} />
        <IconButton label="重做" icon={<Redo2 size={15} />} onClick={redo} />
        {workspacePage === "editing" ? (
          <>
            <span className="mx-1 h-5 w-px bg-panel-line" />
            <IconButton
              label={isPlaying ? "暂停" : "播放"}
              icon={isPlaying ? <Pause size={15} /> : <Play size={15} />}
              active={isPlaying}
              onClick={togglePlayback}
            />
            <div className="min-w-28 rounded-md border border-panel-line bg-black/25 px-2 py-1 font-mono text-[11px] text-accent-cyan">
              {formatTimecode(project.timeline.playheadMs)}
            </div>
          </>
        ) : null}
        <span className="ml-auto" />
        {workspacePage === "editing" ? (
          <>
            <span className="text-[10px] text-slate-500">时间轴缩放</span>
            <IconButton
              label="缩小时间轴"
              icon={<ZoomOut size={15} />}
              onClick={() =>
                setTimelineZoom(project.timeline.pixelsPerSecond * 0.8)
              }
            />
            <input
              aria-label="时间轴缩放比例"
              title="时间轴缩放比例"
              className="h-1.5 w-24 accent-accent-cyan"
              type="range"
              min={TIMELINE_ZOOM_SLIDER_MIN}
              max={TIMELINE_ZOOM_SLIDER_MAX}
              step={1}
              value={zoomToSliderValue(project.timeline.pixelsPerSecond)}
              onChange={(event) =>
                setTimelineZoom(sliderValueToZoom(Number(event.target.value)))
              }
            />
            <IconButton
              label="放大时间轴"
              icon={<ZoomIn size={15} />}
              onClick={() =>
                setTimelineZoom(project.timeline.pixelsPerSecond * 1.25)
              }
            />
          </>
        ) : (
          <>
            {onToggleProjectSidebar ? (
              <IconButton
                label={
                  projectSidebarCollapsed ? "显示项目侧栏" : "隐藏项目侧栏"
                }
                icon={
                  projectSidebarCollapsed ? (
                    <PanelLeftOpen size={15} />
                  ) : (
                    <PanelLeftClose size={15} />
                  )
                }
                active={!projectSidebarCollapsed}
                onClick={onToggleProjectSidebar}
              />
            ) : null}
            {onToggleContextPanel ? (
              <IconButton
                label={
                  contextPanelCollapsed ? "显示当前步骤面板" : "隐藏当前步骤面板"
                }
                icon={
                  contextPanelCollapsed ? (
                    <PanelRightOpen size={15} />
                  ) : (
                    <PanelRightClose size={15} />
                  )
                }
                active={!contextPanelCollapsed}
                onClick={onToggleContextPanel}
              />
            ) : null}
          </>
        )}
        <IconButton
          label="新手引导"
          icon={<MapIcon size={15} />}
          active={workflowOpen}
          onClick={() => setWorkflowOpen(true)}
        />
        <IconButton
          label="设置"
          icon={<Settings size={15} />}
          onClick={() => setSettingsOpen(true)}
        />
      </div>
      <div className="flex h-14 items-center border-t border-white/[0.025] px-3">
        <WorkflowStepper
          steps={usabilityModel.steps}
          activePage={workspacePage}
          onChange={setWorkspacePage}
        />
      </div>
      <input
        ref={projectInputRef}
        className="hidden"
        type="file"
        accept=".json,.danmaku-project.json,application/json"
        data-testid="project-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void readTextFile(file)
              .then((content) => openProjectFromText(content, file.name))
              .catch((error: unknown) => {
                useEditorStore.setState({
                  status: createFileReadErrorStatus("项目文件读取失败", error)
                });
              });
          }
          event.target.value = "";
        }}
      />
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      {workflowOpen ? (
        <WorkflowOverviewDialog
          onClose={() => setWorkflowOpen(false)}
          onImportVideo={() => {
            setWorkspacePage("materials");
            setWorkflowOpen(false);
          }}
          onImportXml={() => {
            setWorkspacePage("materials");
            setWorkflowOpen(false);
          }}
          onGoMatching={() => setWorkspacePage("matching")}
          onSaveProject={saveProjectFile}
          onExportXml={() => {
            setWorkspacePage("export");
          }}
        />
      ) : null}
    </header>
  );
}

function createFileReadErrorStatus(
  prefix: string,
  error: unknown
): { message: string; tone: "error" } {
  if (error instanceof Error && error.message.trim().length > 0) {
    return { message: `${prefix}：${error.message}`, tone: "error" };
  }
  return { message: `${prefix}。`, tone: "error" };
}
