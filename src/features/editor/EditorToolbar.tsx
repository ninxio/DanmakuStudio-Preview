import {
  FileDown,
  FilePlus,
  FileUp,
  FolderOpen,
  Pause,
  Play,
  Redo2,
  Save,
  Settings,
  Undo2,
  Video,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { useRef, useState } from "react";
import { IconButton } from "../../components/IconButton";
import { TextButton } from "../../components/TextButton";
import { createAlignmentApplyBlockers } from "../../domain/alignment/alignmentReport";
import { createProjectDownloadFileName } from "../../domain/project/fileNames";
import { serializeProject } from "../../domain/project/schema";
import { formatTimecode } from "../../domain/shared/time";
import { resolveProjectDanmakuEvents } from "../../domain/timeline/mapping";
import {
  sliderValueToZoom,
  TIMELINE_ZOOM_SLIDER_MAX,
  TIMELINE_ZOOM_SLIDER_MIN,
  zoomToSliderValue
} from "../../domain/timeline/view";
import { downloadTextFile, readTextFile } from "../../infrastructure/file-system/browserFiles";
import { useEditorStore } from "../../stores/editorStore";
import { SettingsDialog } from "./SettingsDialog";

export function EditorToolbar() {
  const xmlInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const projectInputRef = useRef<HTMLInputElement | null>(null);
  const alignmentInputRef = useRef<HTMLInputElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const project = useEditorStore((state) => state.project);
  const isPlaying = useEditorStore((state) => state.isPlaying);
  const newProject = useEditorStore((state) => state.newProject);
  const importXmlFiles = useEditorStore((state) => state.importXmlFiles);
  const importVideoFile = useEditorStore((state) => state.importVideoFile);
  const openProjectFromText = useEditorStore((state) => state.openProjectFromText);
  const prepareExport = useEditorStore((state) => state.prepareExport);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const togglePlayback = useEditorStore((state) => state.togglePlayback);
  const setTimelineZoom = useEditorStore((state) => state.setTimelineZoom);
  const importAlignmentProposalText = useEditorStore((state) => state.importAlignmentProposalText);
  const exportAlignmentProposal = useEditorStore((state) => state.exportAlignmentProposal);
  const applyAlignmentProposal = useEditorStore((state) => state.applyAlignmentProposal);
  const alignmentProposal = useEditorStore((state) => state.alignmentProposal);
  const alignmentApplyBlockers = alignmentProposal
    ? createAlignmentApplyBlockers(alignmentProposal, {
        existingAnchorIds: project.syncAnchors.map((anchor) => anchor.id),
        existingCutMarkerIds: project.cutMarkers.map((marker) => marker.id)
      })
    : [];
  const canExportXml = useEditorStore((state) =>
    resolveProjectDanmakuEvents(state.project).some((event) => event.enabled)
  );

  const saveProjectFile = () => {
    const fileName = downloadTextFile(
      createProjectDownloadFileName(project.name, ".danmaku-project.json"),
      serializeProject(project),
      "application/json;charset=utf-8"
    );
    useEditorStore.setState({ status: { message: `已保存项目文件：${fileName}。`, tone: "success" } });
  };

  const downloadAlignmentProposal = () => {
    const fileName = downloadTextFile(
      createProjectDownloadFileName(project.name, "-alignment-proposal.json"),
      exportAlignmentProposal(),
      "application/json"
    );
    useEditorStore.setState({ status: { message: `已导出对齐提案 JSON：${fileName}。`, tone: "success" } });
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-panel-line bg-[#111318] px-3">
      <IconButton label="新建项目" icon={<FilePlus size={16} />} onClick={newProject} />
      <IconButton label="打开项目" icon={<FolderOpen size={16} />} onClick={() => projectInputRef.current?.click()} />
      <IconButton
        label="保存项目"
        icon={<Save size={16} />}
        onClick={saveProjectFile}
      />
      <span className="mx-1 h-6 w-px bg-panel-line" />
      <IconButton label="导入视频" icon={<Video size={16} />} onClick={() => videoInputRef.current?.click()} />
      <IconButton label="导入 XML" icon={<FileUp size={16} />} onClick={() => xmlInputRef.current?.click()} />
      <IconButton
        label={canExportXml ? "导出 XML" : "请先添加时间轴片段再导出 XML"}
        icon={<FileDown size={16} />}
        disabled={!canExportXml}
        onClick={prepareExport}
      />
      <span className="mx-1 h-6 w-px bg-panel-line" />
      <IconButton label="撤销" icon={<Undo2 size={16} />} onClick={undo} />
      <IconButton label="重做" icon={<Redo2 size={16} />} onClick={redo} />
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
      <span className="ml-auto text-xs text-slate-400">时间轴缩放</span>
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
      <TextButton
        title="导入对齐提案 JSON"
        onClick={() => alignmentInputRef.current?.click()}
        className="hidden xl:inline-flex"
      >
        导入对齐
      </TextButton>
      <TextButton
        title="导出对齐提案 JSON"
        onClick={downloadAlignmentProposal}
        className="hidden xl:inline-flex"
      >
        导出对齐
      </TextButton>
      <TextButton
        title={alignmentApplyBlockers[0] ?? "应用当前对齐提案"}
        onClick={applyAlignmentProposal}
        disabled={!alignmentProposal || alignmentApplyBlockers.length > 0}
        className="hidden xl:inline-flex"
        tone="primary"
      >
        应用对齐
      </TextButton>
      <IconButton label="设置" icon={<Settings size={16} />} onClick={() => setSettingsOpen(true)} />
      <input
        ref={xmlInputRef}
        className="hidden"
        type="file"
        accept=".xml,text/xml,application/xml"
        multiple
        data-testid="xml-input"
        onChange={(event) => {
          if (event.target.files) {
            void importXmlFiles(event.target.files);
          }
          event.target.value = "";
        }}
      />
      <input
        ref={videoInputRef}
        className="hidden"
        type="file"
        accept="video/mp4,video/webm"
        data-testid="video-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            importVideoFile(file);
          }
          event.target.value = "";
        }}
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
              .then(openProjectFromText)
              .catch((error: unknown) => {
                useEditorStore.setState({ status: createFileReadErrorStatus("项目文件读取失败", error) });
              });
          }
          event.target.value = "";
        }}
      />
      <input
        ref={alignmentInputRef}
        className="hidden"
        type="file"
        accept=".json,application/json"
        data-testid="alignment-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void readTextFile(file)
              .then(importAlignmentProposalText)
              .catch((error: unknown) => {
                useEditorStore.setState({ status: createFileReadErrorStatus("对齐提案读取失败", error) });
              });
          }
          event.target.value = "";
        }}
      />
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
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
