import { useEffect } from "react";
import { getProjectDurationMs } from "../../domain/timeline/mapping";
import { useEditorStore } from "../../stores/editorStore";

export function KeyboardShortcuts() {
  const togglePlayback = useEditorStore((state) => state.togglePlayback);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const deleteSelection = useEditorStore((state) => state.deleteSelection);
  const clearSelection = useEditorStore((state) => state.clearSelection);
  const selectAllClips = useEditorStore((state) => state.selectAllClips);
  const moveSelectedDanmaku = useEditorStore((state) => state.moveSelectedDanmaku);
  const moveSelectedClips = useEditorStore((state) => state.moveSelectedClips);
  const moveSelectedCutMarkers = useEditorStore((state) => state.moveSelectedCutMarkers);
  const addCutMarkerAtPlayhead = useEditorStore((state) => state.addCutMarkerAtPlayhead);
  const fitTimelineToContent = useEditorStore((state) => state.fitTimelineToContent);
  const project = useEditorStore((state) => state.project);
  const selection = useEditorStore((state) => state.selection);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const setTimelineZoom = useEditorStore((state) => state.setTimelineZoom);
  const setTimelineTool = useEditorStore((state) => state.setTimelineTool);
  const splitSelectedClipsAtPlayhead = useEditorStore((state) => state.splitSelectedClipsAtPlayhead);
  const mergeSelectedClips = useEditorStore((state) => state.mergeSelectedClips);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) {
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (event.code === "Space") {
        event.preventDefault();
        togglePlayback();
      } else if (mod && event.key.toLowerCase() === "z" && event.shiftKey) {
        event.preventDefault();
        redo();
      } else if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
      } else if (mod && event.key.toLowerCase() === "a") {
        event.preventDefault();
        selectAllClips();
      } else if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        splitSelectedClipsAtPlayhead();
      } else if (mod && event.key.toLowerCase() === "j") {
        event.preventDefault();
        mergeSelectedClips();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const step = event.altKey ? 1000 : event.shiftKey ? 100 : 10;
        if (selection.kind === "clip") {
          moveSelectedClips(direction * step);
        } else if (selection.kind === "cut") {
          moveSelectedCutMarkers(direction * step);
        } else if (selection.kind === "danmaku") {
          moveSelectedDanmaku(direction * step);
        } else {
          setPlayhead(project.timeline.playheadMs + direction * step);
        }
      } else if (event.key === "Home") {
        event.preventDefault();
        setPlayhead(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setPlayhead(getProjectDurationMs(project));
      } else if (event.key === "Escape") {
        event.preventDefault();
        clearSelection();
      } else if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        addCutMarkerAtPlayhead();
      } else if (event.key.toLowerCase() === "v") {
        event.preventDefault();
        setTimelineTool("select");
      } else if (event.key.toLowerCase() === "b" || event.key.toLowerCase() === "c") {
        event.preventDefault();
        setTimelineTool("blade");
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        fitTimelineToContent();
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setTimelineZoom(project.timeline.pixelsPerSecond * 1.2);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setTimelineZoom(project.timeline.pixelsPerSecond * 0.84);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    addCutMarkerAtPlayhead,
    clearSelection,
    deleteSelection,
    fitTimelineToContent,
    mergeSelectedClips,
    moveSelectedClips,
    moveSelectedCutMarkers,
    moveSelectedDanmaku,
    project,
    project.timeline.pixelsPerSecond,
    project.timeline.playheadMs,
    redo,
    selectAllClips,
    selection.kind,
    setPlayhead,
    setTimelineZoom,
    setTimelineTool,
    splitSelectedClipsAtPlayhead,
    togglePlayback,
    undo
  ]);

  return null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}
