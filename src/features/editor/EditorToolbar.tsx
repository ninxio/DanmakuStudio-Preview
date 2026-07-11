import {
  Clapperboard,
  Download,
  FilePlus,
  FolderOpen,
  GitCompareArrows,
  Map as MapIcon,
  Pause,
  Play,
  Redo2,
  Save,
  Settings,
  SlidersHorizontal,
  Undo2,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { IconButton } from "../../components/IconButton";
import { createProjectDownloadFileName } from "../../domain/project/fileNames";
import { serializeProject } from "../../domain/project/schema";
import { formatTimecode } from "../../domain/shared/time";
import {
  sliderValueToZoom,
  TIMELINE_ZOOM_SLIDER_MAX,
  TIMELINE_ZOOM_SLIDER_MIN,
  zoomToSliderValue
} from "../../domain/timeline/view";
import { downloadTextFile, readTextFile } from "../../infrastructure/file-system/browserFiles";
import type { WorkspacePage } from "../../stores/editorStore";
import { useEditorStore } from "../../stores/editorStore";
import { SettingsDialog } from "./SettingsDialog";
import { WorkflowOverviewDialog } from "./WorkflowOverviewDialog";

const WORKSPACE_PAGES: { id: WorkspacePage; label: string; icon: ReactNode; hint: string }[] = [
  {
    id: "materials",
    label: "素材",
    icon: <Clapperboard size={14} />,
    hint: "导入原片、B 站参考视频和弹幕 XML"
  },
  {
    id: "matching",
    label: "匹配",
    icon: <GitCompareArrows size={14} />,
    hint: "确定参考视频与原片的对应关系"
  },
  {
    id: "editing",
    label: "编辑",
    icon: <SlidersHorizontal size={14} />,
    hint: "在时间轴上预览和微调弹幕"
  },
  {
    id: "export",
    label: "导出",
    icon: <Download size={14} />,
    hint: "按原片分集导出修正后的弹幕 XML"
  }
];

export function EditorToolbar() {
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
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-panel-line bg-[#111318] px-3">
      <IconButton label="新建项目" icon={<FilePlus size={16} />} onClick={newProject} />
      <IconButton
        label="打开项目"
        icon={<FolderOpen size={16} />}
        onClick={() => projectInputRef.current?.click()}
      />
      <IconButton label="保存项目" icon={<Save size={16} />} onClick={saveProjectFile} />
      <span className="mx-1 h-6 w-px bg-panel-line" />
      <nav
        aria-label="工作区页面"
        className="flex items-center gap-1 rounded border border-panel-line bg-black/25 p-0.5"
      >
        {WORKSPACE_PAGES.map((page) => (
          <button
            key={page.id}
            type="button"
            aria-current={workspacePage === page.id ? "page" : undefined}
            title={page.hint}
            data-testid={`workspace-nav-${page.id}`}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-cyan ${
              workspacePage === page.id
                ? "bg-accent-cyan/15 font-medium text-accent-cyan"
                : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
            onClick={() => setWorkspacePage(page.id)}
          >
            {page.icon}
            {page.label}
          </button>
        ))}
      </nav>
      <span className="mx-1 h-6 w-px bg-panel-line" />
      <IconButton label="撤销" icon={<Undo2 size={16} />} onClick={undo} />
      <IconButton label="重做" icon={<Redo2 size={16} />} onClick={redo} />
      {workspacePage === "editing" ? (
        <>
          <span className="mx-1 h-6 w-px bg-panel-line" />
          <IconButton
            label={isPlaying ? "暂停" : "播放"}
            icon={isPlaying ? <Pause size={16} /> : <Play size={16} />}
            active={isPlaying}
            onClick={togglePlayback}
          />
          <div className="ml-1 min-w-32 rounded border border-panel-line bg-black/30 px-2 py-1 font-mono text-xs text-accent-cyan">
            {formatTimecode(project.timeline.playheadMs)}
          </div>
        </>
      ) : null}
      <span className="ml-auto" />
      {workspacePage === "editing" ? (
        <>
          <span className="text-xs text-slate-400">时间轴缩放</span>
          <IconButton
            label="缩小时间轴"
            icon={<ZoomOut size={16} />}
            onClick={() => setTimelineZoom(project.timeline.pixelsPerSecond * 0.8)}
          />
          <input
            aria-label="时间轴缩放比例"
            title="时间轴缩放比例"
            className="h-1.5 w-32 accent-accent-cyan"
            type="range"
            min={TIMELINE_ZOOM_SLIDER_MIN}
            max={TIMELINE_ZOOM_SLIDER_MAX}
            step={1}
            value={zoomToSliderValue(project.timeline.pixelsPerSecond)}
            onChange={(event) => setTimelineZoom(sliderValueToZoom(Number(event.target.value)))}
          />
          <IconButton
            label="放大时间轴"
            icon={<ZoomIn size={16} />}
            onClick={() => setTimelineZoom(project.timeline.pixelsPerSecond * 1.25)}
          />
        </>
      ) : null}
      <IconButton
        label="新手引导"
        icon={<MapIcon size={16} />}
        active={workflowOpen}
        onClick={() => setWorkflowOpen(true)}
      />
      <IconButton
        label="设置"
        icon={<Settings size={16} />}
        onClick={() => setSettingsOpen(true)}
      />
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
