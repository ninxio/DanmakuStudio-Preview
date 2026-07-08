import { create } from "zustand";
import type {
  CutMarker,
  DanmakuAsset,
  DanmakuClip,
  DanmakuItem,
  ResolvedDanmakuEvent,
  SyncAnchor
} from "../domain/danmaku/types";
import { createExportSummary, type ExportSummary } from "../domain/danmaku/exportSummary";
import {
  createHistoryState,
  pushHistory,
  redoHistory,
  undoHistory,
  type HistoryState
} from "../domain/history/history";
import {
  createEmptyProject,
  createId,
  cloneProject,
  touchProject
} from "../domain/project/factory";
import type { EditorProject, EditorSelection, MediaReference } from "../domain/project/types";
import {
  getAssetTimeRange,
  getClipDurationMs,
  getProjectDurationMs,
  resolveProjectDanmakuEvents
} from "../domain/timeline/mapping";
import { parseProjectJson } from "../domain/project/schema";
import type { Milliseconds } from "../domain/shared/time";
import { clamp, clampMilliseconds } from "../domain/shared/time";
import {
  TIMELINE_MAX_PIXELS_PER_SECOND,
  TIMELINE_MIN_PIXELS_PER_SECOND
} from "../domain/timeline/view";
import {
  createObjectUrl,
  readFilesAsText,
  revokeObjectUrl
} from "../infrastructure/file-system/browserFiles";
import {
  parseBilibiliXml,
  serializeBilibiliXml,
  validateExportedXml
} from "../infrastructure/xml/bilibiliXml";
import { cutCandidateToMarker, type AlignmentProposal } from "../domain/alignment/types";
import { parseAlignmentProposal } from "../domain/alignment/manualProvider";
import { pickAssetColor } from "../domain/shared/assetColors";

export type TimelineTool = "select" | "blade";

export interface ExportDraft {
  summary: ExportSummary;
  xml: string;
  validation: {
    ok: boolean;
    message: string;
    count: number;
  };
}

export interface EditorStatus {
  message: string;
  tone: "neutral" | "success" | "warning" | "error";
}

interface EditorStore {
  project: EditorProject;
  selection: EditorSelection;
  history: HistoryState<EditorProject>;
  isPlaying: boolean;
  status: EditorStatus;
  importProgress: number | null;
  exportDraft: ExportDraft | null;
  alignmentProposal: AlignmentProposal | null;
  timelineTool: TimelineTool;
  newProject: () => void;
  importXmlFiles: (files: FileList | File[]) => Promise<void>;
  importVideoFile: (file: File) => void;
  removeMedia: () => void;
  updateMediaDuration: (durationMs: Milliseconds) => void;
  openProjectFromText: (text: string) => void;
  addAssetToTimeline: (assetId: string) => void;
  removeAsset: (assetId: string) => void;
  removeAssetFromTimeline: (assetId: string) => void;
  autoArrangeClips: () => void;
  select: (selection: EditorSelection) => void;
  clearSelection: () => void;
  selectAllClips: () => void;
  toggleDanmakuSelection: (itemId: string, additive: boolean) => void;
  toggleClipSelection: (clipId: string, additive: boolean) => void;
  toggleCutSelection: (cutId: string, additive: boolean) => void;
  selectDanmakuRange: (startMs: Milliseconds, endMs: Milliseconds, additive: boolean) => void;
  setPlayhead: (timeMs: Milliseconds) => void;
  setPlaying: (playing: boolean) => void;
  togglePlayback: () => void;
  setTimelineScroll: (scrollMs: Milliseconds) => void;
  setTimelineZoom: (
    pixelsPerSecond: number,
    anchorTimeMs?: Milliseconds,
    anchorRatio?: number
  ) => void;
  fitTimelineToContent: (viewportWidthPx?: number) => void;
  moveClip: (clipId: string, deltaMs: Milliseconds) => void;
  moveSelectedClips: (deltaMs: Milliseconds) => void;
  moveSelectedCutMarkers: (deltaMs: Milliseconds) => void;
  updateClip: (clipId: string, patch: Partial<Omit<DanmakuClip, "id" | "assetId">>) => void;
  moveSelectedDanmaku: (deltaMs: Milliseconds) => void;
  setItemAdjustment: (itemId: string, adjustmentMs: Milliseconds) => void;
  disableSelectedDanmaku: () => void;
  restoreSelectedDanmaku: () => void;
  addCutMarkerAtPlayhead: () => void;
  addCutMarker: (sourceAtMs: Milliseconds, targetGapMs?: Milliseconds) => void;
  updateCutMarker: (id: string, patch: Partial<Omit<CutMarker, "id">>) => void;
  deleteCutMarker: (id: string) => void;
  deleteSelection: () => void;
  splitClipAtTime: (clipId: string, splitAtMs: Milliseconds) => void;
  splitSelectedClipsAtPlayhead: () => void;
  mergeSelectedClips: () => void;
  setTimelineTool: (tool: TimelineTool) => void;
  addSyncAnchor: (anchor: SyncAnchor) => void;
  setGlobalOffset: (offsetMs: Milliseconds) => void;
  updatePreview: (patch: Partial<EditorProject["preview"]>) => void;
  prepareExport: () => void;
  clearExport: () => void;
  importAlignmentProposalText: (text: string) => void;
  exportAlignmentProposal: () => string;
  applyAlignmentProposal: () => void;
  undo: () => void;
  redo: () => void;
}

const emptySelection: EditorSelection = { kind: "none", ids: [] };

export const useEditorStore = create<EditorStore>((set, get) => ({
  project: createEmptyProject(),
  selection: emptySelection,
  history: createHistoryState<EditorProject>(),
  isPlaying: false,
  status: { message: "准备就绪", tone: "neutral" },
  importProgress: null,
  exportDraft: null,
  alignmentProposal: null,
  timelineTool: "select",

  newProject: () => {
    revokeObjectUrl(get().project.media?.objectUrl ?? null);
    set({
      project: createEmptyProject(),
      selection: emptySelection,
      history: createHistoryState<EditorProject>(),
      isPlaying: false,
      status: { message: "已创建新项目", tone: "success" },
      exportDraft: null,
      alignmentProposal: null,
      timelineTool: "select"
    });
  },

  importXmlFiles: async (files) => {
    const fileArray = Array.from(files).filter((file) =>
      file.name.toLowerCase().endsWith(".xml")
    );
    if (fileArray.length === 0) {
      set({ status: { message: "请选择 XML 文件。", tone: "warning" } });
      return;
    }
    set({ importProgress: 0, status: { message: "正在读取 XML...", tone: "neutral" } });
    const texts = await readFilesAsText(fileArray);
    const assets: DanmakuAsset[] = [];
    for (let index = 0; index < texts.length; index += 1) {
      const { file, text } = texts[index];
      assets.push(
        parseBilibiliXml(text, {
          fileName: file.name,
          assetName: file.name.replace(/\.[^.]+$/, ""),
          color: pickAssetColor(get().project.assets.length + index)
        })
      );
      set({ importProgress: (index + 1) / texts.length });
      await Promise.resolve();
    }
    commitProject(set, get, "导入 XML", (project) => ({
      ...project,
      assets: [...project.assets, ...assets]
    }));
    set({
      importProgress: null,
      status: {
        message: `已导入 ${assets.length} 个 XML，共 ${assets.reduce((sum, asset) => sum + asset.items.length, 0)} 条弹幕。`,
        tone: "success"
      }
    });
  },

  importVideoFile: (file) => {
    const previousUrl = get().project.media?.objectUrl;
    if (previousUrl) {
      URL.revokeObjectURL(previousUrl);
    }
    const objectUrl = createObjectUrl(file);
    const media: MediaReference = {
      id: createId("media"),
      name: file.name.replace(/\.[^.]+$/, ""),
      fileName: file.name,
      objectUrl,
      durationMs: null
    };
    commitProject(set, get, "导入视频", (project) => ({
      ...project,
      media
    }));
    set({ status: { message: `已导入视频：${file.name}`, tone: "success" } });
  },

  removeMedia: () => {
    const media = get().project.media;
    if (!media) {
      set({ status: { message: "当前没有可删除的视频。", tone: "warning" } });
      return;
    }
    revokeObjectUrl(media.objectUrl);
    commitProject(set, get, "删除视频引用", (project) => ({
      ...project,
      media: null
    }));
    set({ status: { message: `已删除视频引用：${media.fileName}`, tone: "success" } });
  },

  updateMediaDuration: (durationMs) => {
    set((state) => ({
      project: state.project.media
        ? touchProject({
            ...state.project,
            media: { ...state.project.media, durationMs: clampMilliseconds(durationMs) }
          })
        : state.project
    }));
  },

  openProjectFromText: (text) => {
    try {
      const project = parseProjectJson(text);
      revokeObjectUrl(get().project.media?.objectUrl ?? null);
      set({
        project,
        selection: emptySelection,
        history: createHistoryState<EditorProject>(),
        exportDraft: null,
        alignmentProposal: null,
        timelineTool: "select",
        status: { message: `已打开项目：${project.name}`, tone: "success" }
      });
    } catch (error) {
      set({
        status: {
          message: error instanceof Error ? error.message : "项目文件打开失败。",
          tone: "error"
        }
      });
    }
  },

  addAssetToTimeline: (assetId) => {
    commitProject(
      set,
      get,
      "添加弹幕片段",
      (project) => {
        const asset = project.assets.find((candidate) => candidate.id === assetId);
        if (!asset) {
          return project;
        }
        const latestEnd = project.clips.reduce(
          (max, clip) => Math.max(max, getClipVisualEndMs(clip)),
          0
        );
        return {
          ...project,
          clips: [...project.clips, createClipFromAsset(asset, latestEnd)]
        };
      },
      { kind: "clip", ids: [] }
    );
    const lastClip = get().project.clips.at(-1);
    if (lastClip) {
      set({ selection: { kind: "clip", ids: [lastClip.id] } });
    }
  },

  removeAsset: (assetId) => {
    const project = get().project;
    const asset = project.assets.find((candidate) => candidate.id === assetId);
    if (!asset) {
      set({ status: { message: "弹幕资源不存在。", tone: "warning" } });
      return;
    }
    const itemIds = new Set(asset.items.map((item) => item.id));
    commitProject(
      set,
      get,
      "删除弹幕资源",
      (currentProject) => {
        const itemTimeAdjustments = Object.fromEntries(
          Object.entries(currentProject.itemTimeAdjustments).filter(
            ([itemId]) => !itemIds.has(itemId)
          )
        );
        return {
          ...currentProject,
          assets: currentProject.assets.filter((candidate) => candidate.id !== assetId),
          clips: currentProject.clips.filter((clip) => clip.assetId !== assetId),
          disabledItemIds: currentProject.disabledItemIds.filter(
            (itemId) => !itemIds.has(itemId)
          ),
          itemTimeAdjustments
        };
      },
      emptySelection
    );
    set({ status: { message: `已删除弹幕资源：${asset.fileName}`, tone: "success" } });
  },

  removeAssetFromTimeline: (assetId) => {
    const asset = get().project.assets.find((candidate) => candidate.id === assetId);
    if (!asset) {
      set({ status: { message: "弹幕资源不存在。", tone: "warning" } });
      return;
    }
    const clipCount = get().project.clips.filter((clip) => clip.assetId === assetId).length;
    if (clipCount === 0) {
      set({ status: { message: "该资源尚未放入时间轴。", tone: "warning" } });
      return;
    }
    commitProject(
      set,
      get,
      "移出时间轴",
      (project) => ({
        ...project,
        clips: project.clips.filter((clip) => clip.assetId !== assetId)
      }),
      emptySelection
    );
    set({ status: { message: `已从时间轴移出：${asset.fileName}`, tone: "success" } });
  },

  autoArrangeClips: () => {
    commitProject(set, get, "按顺序排列分 P", (project) => {
      let cursor = 0;
      const clips = project.assets.map((asset) => {
        const existing = project.clips.find((clip) => clip.assetId === asset.id);
        const base = existing ?? createClipFromAsset(asset, cursor);
        const range = getAssetTimeRange(asset);
        const duration = Math.max(30_000, range.latestMs - range.earliestMs);
        const arranged: DanmakuClip = {
          ...base,
          timelineStartMs: cursor,
          sourceInMs: range.earliestMs,
          sourceOutMs: Math.max(range.latestMs, range.earliestMs + 1),
          localOffsetMs: 0,
          enabled: true
        };
        cursor += duration;
        return arranged;
      });
      return { ...project, clips };
    });
    set({ status: { message: "已按分 P 顺序排列片段。", tone: "success" } });
  },

  select: (selection) => set({ selection }),

  clearSelection: () => set({ selection: emptySelection }),

  selectAllClips: () => {
    const ids = get().project.clips.map((clip) => clip.id);
    set({
      selection: ids.length > 0 ? { kind: "clip", ids } : emptySelection,
      status:
        ids.length > 0
          ? { message: `已选择 ${ids.length} 个时间轴片段。`, tone: "success" }
          : { message: "当前没有可选择的时间轴片段。", tone: "warning" }
    });
  },

  toggleDanmakuSelection: (itemId, additive) => {
    set((state) => {
      if (!additive || state.selection.kind !== "danmaku") {
        return { selection: { kind: "danmaku", ids: [itemId] } };
      }
      const exists = state.selection.ids.includes(itemId);
      const ids = exists
        ? state.selection.ids.filter((candidate) => candidate !== itemId)
        : [...state.selection.ids, itemId];
      return { selection: ids.length > 0 ? { kind: "danmaku", ids } : emptySelection };
    });
  },

  toggleClipSelection: (clipId, additive) => {
    set((state) => toggleSelectionId(state.selection, "clip", clipId, additive));
  },

  toggleCutSelection: (cutId, additive) => {
    set((state) => toggleSelectionId(state.selection, "cut", cutId, additive));
  },

  selectDanmakuRange: (startMs, endMs, additive) => {
    const events = resolveProjectDanmakuEvents(get().project);
    const min = Math.min(startMs, endMs);
    const max = Math.max(startMs, endMs);
    const ids = events
      .filter((event) => event.enabled && event.finalTimeMs >= min && event.finalTimeMs <= max)
      .map((event) => event.item.id);
    set((state) => ({
      selection: {
        kind: "danmaku",
        ids:
          additive && state.selection.kind === "danmaku"
            ? unique([...state.selection.ids, ...ids])
            : unique(ids)
      }
    }));
  },

  setPlayhead: (timeMs) => {
    set((state) => ({
      project: {
        ...state.project,
        timeline: {
          ...state.project.timeline,
          playheadMs: clampMilliseconds(clamp(timeMs, 0, getProjectDurationMs(state.project)))
        }
      }
    }));
  },

  setPlaying: (playing) => set({ isPlaying: playing }),

  togglePlayback: () => set((state) => ({ isPlaying: !state.isPlaying })),

  setTimelineScroll: (scrollMs) => {
    set((state) => ({
      project: {
        ...state.project,
        timeline: {
          ...state.project.timeline,
          scrollMs: clampMilliseconds(scrollMs)
        }
      }
    }));
  },

  setTimelineZoom: (pixelsPerSecond, anchorTimeMs, anchorRatio) => {
    set((state) => {
      const nextPps = clamp(
        pixelsPerSecond,
        TIMELINE_MIN_PIXELS_PER_SECOND,
        TIMELINE_MAX_PIXELS_PER_SECOND
      );
      const timeline = state.project.timeline;
      const nextScroll =
        anchorTimeMs !== undefined && anchorRatio !== undefined
          ? clampMilliseconds(anchorTimeMs - (anchorRatio * 1000) / nextPps)
          : timeline.scrollMs;
      return {
        project: {
          ...state.project,
          timeline: {
            ...timeline,
            pixelsPerSecond: nextPps,
            scrollMs: nextScroll
          }
        }
      };
    });
  },

  fitTimelineToContent: (viewportWidthPx) => {
    const project = get().project;
    const duration = getProjectDurationMs(project);
    const visibleWidthPx = Math.max(240, viewportWidthPx ?? 1200);
    set((state) => ({
      project: {
        ...state.project,
        timeline: {
          ...state.project.timeline,
          scrollMs: 0,
          pixelsPerSecond: clamp(
            (visibleWidthPx * 0.96) / (duration / 1000),
            TIMELINE_MIN_PIXELS_PER_SECOND,
            TIMELINE_MAX_PIXELS_PER_SECOND
          )
        }
      },
      status: { message: "已缩放到全部内容。", tone: "success" }
    }));
  },

  moveClip: (clipId, deltaMs) => {
    if (deltaMs === 0) {
      return;
    }
    commitProject(set, get, "移动片段", (project) => ({
      ...project,
      clips: project.clips.map((clip) =>
        clip.id === clipId
          ? { ...clip, timelineStartMs: clampMilliseconds(clip.timelineStartMs + deltaMs) }
          : clip
      )
    }));
  },

  moveSelectedClips: (deltaMs) => {
    const selection = get().selection;
    if (selection.kind !== "clip" || selection.ids.length === 0 || deltaMs === 0) {
      return;
    }
    commitProject(set, get, "移动片段", (project) => ({
      ...project,
      clips: project.clips.map((clip) =>
        selection.ids.includes(clip.id)
          ? { ...clip, timelineStartMs: clampMilliseconds(clip.timelineStartMs + deltaMs) }
          : clip
      )
    }));
  },

  moveSelectedCutMarkers: (deltaMs) => {
    const selection = get().selection;
    if (selection.kind !== "cut" || selection.ids.length === 0 || deltaMs === 0) {
      return;
    }
    commitProject(set, get, "移动删减标记", (project) => ({
      ...project,
      cutMarkers: project.cutMarkers.map((marker) =>
        selection.ids.includes(marker.id)
          ? { ...marker, sourceAtMs: clampMilliseconds(marker.sourceAtMs + deltaMs) }
          : marker
      )
    }));
  },

  updateClip: (clipId, patch) => {
    commitProject(set, get, "修改片段", (project) => ({
      ...project,
      clips: project.clips.map((clip) =>
        clip.id === clipId
          ? {
              ...clip,
              ...patch,
              timelineStartMs:
                patch.timelineStartMs !== undefined
                  ? clampMilliseconds(patch.timelineStartMs)
                  : clip.timelineStartMs,
              sourceInMs:
                patch.sourceInMs !== undefined
                  ? clampMilliseconds(patch.sourceInMs)
                  : clip.sourceInMs,
              sourceOutMs:
                patch.sourceOutMs !== undefined
                  ? clampMilliseconds(patch.sourceOutMs)
                  : clip.sourceOutMs
            }
          : clip
      )
    }));
  },

  moveSelectedDanmaku: (deltaMs) => {
    const selection = get().selection;
    if (selection.kind !== "danmaku" || selection.ids.length === 0 || deltaMs === 0) {
      return;
    }
    commitProject(set, get, "移动弹幕", (project) => {
      const adjustments = { ...project.itemTimeAdjustments };
      for (const itemId of selection.ids) {
        adjustments[itemId] = (adjustments[itemId] ?? 0) + deltaMs;
      }
      return { ...project, itemTimeAdjustments: adjustments };
    });
  },

  setItemAdjustment: (itemId, adjustmentMs) => {
    commitProject(set, get, "设置弹幕时间微调", (project) => ({
      ...project,
      itemTimeAdjustments: {
        ...project.itemTimeAdjustments,
        [itemId]: adjustmentMs
      }
    }));
  },

  disableSelectedDanmaku: () => {
    const selection = get().selection;
    if (selection.kind !== "danmaku" || selection.ids.length === 0) {
      return;
    }
    commitProject(set, get, "禁用弹幕", (project) => ({
      ...project,
      disabledItemIds: unique([...project.disabledItemIds, ...selection.ids])
    }));
  },

  restoreSelectedDanmaku: () => {
    const selection = get().selection;
    if (selection.kind !== "danmaku" || selection.ids.length === 0) {
      return;
    }
    commitProject(set, get, "恢复弹幕", (project) => ({
      ...project,
      disabledItemIds: project.disabledItemIds.filter((id) => !selection.ids.includes(id))
    }));
  },

  addCutMarkerAtPlayhead: () => {
    get().addCutMarker(get().project.timeline.playheadMs, 45_000);
  },

  addCutMarker: (sourceAtMs, targetGapMs = 45_000) => {
    const markerId = createId("cut");
    commitProject(
      set,
      get,
      "添加删减标记",
      (project) => ({
        ...project,
        cutMarkers: [
          ...project.cutMarkers,
          {
            id: markerId,
            name: `删减点 ${project.cutMarkers.length + 1}`,
            sourceAtMs: clampMilliseconds(sourceAtMs),
            targetGapMs,
            note: "目标完整版在此处额外存在内容"
          }
        ]
      }),
      { kind: "cut", ids: [markerId] }
    );
    set({ status: { message: "已添加删减标记。", tone: "success" } });
  },

  updateCutMarker: (id, patch) => {
    commitProject(set, get, "修改删减标记", (project) => ({
      ...project,
      cutMarkers: project.cutMarkers.map((marker) =>
        marker.id === id
          ? {
              ...marker,
              ...patch,
              sourceAtMs:
                patch.sourceAtMs !== undefined
                  ? clampMilliseconds(patch.sourceAtMs)
                  : marker.sourceAtMs
            }
          : marker
      )
    }));
  },

  deleteCutMarker: (id) => {
    commitProject(
      set,
      get,
      "删除删减标记",
      (project) => ({
        ...project,
        cutMarkers: project.cutMarkers.filter((marker) => marker.id !== id)
      }),
      emptySelection
    );
  },

  deleteSelection: () => {
    const selection = get().selection;
    if (selection.ids.length === 0 || selection.kind === "none") {
      set({ status: { message: "当前没有可删除的选择项。", tone: "warning" } });
      return;
    }
    if (selection.kind === "danmaku") {
      get().disableSelectedDanmaku();
      set({ status: { message: `已禁用 ${selection.ids.length} 条弹幕。`, tone: "success" } });
      return;
    }
    if (selection.kind === "clip") {
      commitProject(
        set,
        get,
        "删除片段",
        (project) => ({
          ...project,
          clips: project.clips.filter((clip) => !selection.ids.includes(clip.id))
        }),
        emptySelection
      );
      set({
        status: { message: `已删除 ${selection.ids.length} 个时间轴片段。`, tone: "success" }
      });
      return;
    }
    if (selection.kind === "cut") {
      commitProject(
        set,
        get,
        "删除删减标记",
        (project) => ({
          ...project,
          cutMarkers: project.cutMarkers.filter((marker) => !selection.ids.includes(marker.id))
        }),
        emptySelection
      );
      set({
        status: { message: `已删除 ${selection.ids.length} 个删减标记。`, tone: "success" }
      });
      return;
    }
    set({ status: { message: "当前选择类型暂不支持删除。", tone: "warning" } });
  },

  splitClipAtTime: (clipId, splitAtMs) => {
    const project = get().project;
    const clip = project.clips.find((candidate) => candidate.id === clipId);
    if (!clip) {
      set({ status: { message: "要剪切的片段不存在。", tone: "warning" } });
      return;
    }
    const split = splitClip(clip, splitAtMs);
    if (!split) {
      set({ status: { message: "播放头必须位于片段内部，才能剪切。", tone: "warning" } });
      return;
    }
    commitProject(
      set,
      get,
      "剪切片段",
      (currentProject) => ({
        ...currentProject,
        clips: currentProject.clips.flatMap((candidate) =>
          candidate.id === clipId ? [split.left, split.right] : [candidate]
        )
      }),
      { kind: "clip", ids: [split.left.id, split.right.id] }
    );
    set({ status: { message: "已剪切片段。", tone: "success" } });
  },

  splitSelectedClipsAtPlayhead: () => {
    const { project, selection } = get();
    const targetIds =
      selection.kind === "clip" && selection.ids.length > 0
        ? selection.ids
        : project.clips
            .filter((clip) => isTimeInsideClipBody(project.timeline.playheadMs, clip))
            .map((clip) => clip.id);
    const splits = new Map<string, { left: DanmakuClip; right: DanmakuClip }>();
    for (const clipId of targetIds) {
      const clip = project.clips.find((candidate) => candidate.id === clipId);
      const split = clip ? splitClip(clip, project.timeline.playheadMs) : null;
      if (split) {
        splits.set(clipId, split);
      }
    }
    if (splits.size === 0) {
      set({ status: { message: "播放头没有位于可剪切的片段内部。", tone: "warning" } });
      return;
    }
    const selectedIds = Array.from(splits.values()).flatMap((split) => [
      split.left.id,
      split.right.id
    ]);
    commitProject(
      set,
      get,
      "剪切片段",
      (currentProject) => ({
        ...currentProject,
        clips: currentProject.clips.flatMap((clip) => {
          const split = splits.get(clip.id);
          return split ? [split.left, split.right] : [clip];
        })
      }),
      { kind: "clip", ids: selectedIds }
    );
    set({ status: { message: `已剪切 ${splits.size} 个片段。`, tone: "success" } });
  },

  mergeSelectedClips: () => {
    const { project, selection } = get();
    if (selection.kind !== "clip" || selection.ids.length < 2) {
      set({ status: { message: "请选择至少两个相邻片段再合并。", tone: "warning" } });
      return;
    }
    const selectedClips = project.clips
      .filter((clip) => selection.ids.includes(clip.id))
      .sort((left, right) => getClipVisualStartMs(left) - getClipVisualStartMs(right));
    const mergedClip = mergeAdjacentClips(selectedClips);
    if (!mergedClip) {
      set({
        status: { message: "只能合并同一 XML 且源时间、时间轴连续的片段。", tone: "warning" }
      });
      return;
    }
    const selected = new Set(selection.ids);
    commitProject(
      set,
      get,
      "合并片段",
      (currentProject) => ({
        ...currentProject,
        clips: currentProject.clips.flatMap((clip) => {
          if (clip.id === mergedClip.id) {
            return [mergedClip];
          }
          return selected.has(clip.id) ? [] : [clip];
        })
      }),
      { kind: "clip", ids: [mergedClip.id] }
    );
    set({ status: { message: "已合并相邻片段。", tone: "success" } });
  },

  setTimelineTool: (tool) => {
    set({
      timelineTool: tool,
      status: {
        message: tool === "select" ? "已切换到选择工具。" : "已切换到剪刀工具。",
        tone: "neutral"
      }
    });
  },

  addSyncAnchor: (anchor) => {
    commitProject(set, get, "添加同步锚点", (project) => ({
      ...project,
      syncAnchors: [...project.syncAnchors, anchor]
    }));
  },

  setGlobalOffset: (offsetMs) => {
    commitProject(set, get, "修改全局偏移", (project) => ({
      ...project,
      globalOffsetMs: Math.round(offsetMs)
    }));
  },

  updatePreview: (patch) => {
    set((state) => ({
      project: touchProject({
        ...state.project,
        preview: {
          ...state.project.preview,
          ...patch
        }
      })
    }));
  },

  prepareExport: () => {
    const project = get().project;
    const events = resolveProjectDanmakuEvents(project);
    const enabledEvents = events.filter((event) => event.enabled);
    const exportResult = serializeBilibiliXml(
      enabledEvents.map((event) => ({ item: event.item, finalTimeMs: event.finalTimeMs }))
    );
    const validation = validateExportedXml(exportResult.xml);
    const summary = createExportSummary(
      events,
      project.cutMarkers,
      project.assets.some((asset) => asset.warnings.length > 0),
      exportResult.negativeClampCount
    );
    set({
      exportDraft: {
        summary,
        xml: exportResult.xml,
        validation
      },
      status: {
        message: validation.ok ? "导出摘要已生成。" : `导出验证失败：${validation.message}`,
        tone: validation.ok ? "success" : "error"
      }
    });
  },

  clearExport: () => set({ exportDraft: null }),

  importAlignmentProposalText: (text) => {
    try {
      const proposal = parseAlignmentProposal(text);
      set({
        alignmentProposal: proposal,
        status: {
          message: `已导入对齐提案：${proposal.anchors.length} 个锚点，${proposal.cutCandidates.length} 个候选删减点。`,
          tone: "success"
        }
      });
    } catch (error) {
      set({
        status: {
          message: error instanceof Error ? error.message : "对齐提案导入失败。",
          tone: "error"
        }
      });
    }
  },

  exportAlignmentProposal: () => {
    const proposal = get().alignmentProposal ?? {
      anchors: get().project.syncAnchors,
      cutCandidates: [],
      confidence: 1,
      diagnostics: ["手动导出的当前锚点。"]
    };
    return `${JSON.stringify(proposal, null, 2)}\n`;
  },

  applyAlignmentProposal: () => {
    const proposal = get().alignmentProposal;
    if (!proposal) {
      set({ status: { message: "当前没有可应用的对齐提案。", tone: "warning" } });
      return;
    }
    commitProject(set, get, "应用对齐提案", (project) => ({
      ...project,
      syncAnchors: uniqueById([...project.syncAnchors, ...proposal.anchors]),
      cutMarkers: uniqueById([
        ...project.cutMarkers,
        ...proposal.cutCandidates.map((candidate, index) => ({
          ...cutCandidateToMarker(candidate),
          id: candidate.id.length > 0 ? candidate.id : createId("cut"),
          name: candidate.name.length > 0 ? candidate.name : `候选删减点 ${index + 1}`
        }))
      ])
    }));
    set({ status: { message: "已应用对齐提案，时间轴会标记已应用项。", tone: "success" } });
  },

  undo: () => {
    set((state) => {
      const result = undoHistory(state.history);
      if (!result.value) {
        return { status: { message: "没有可撤销的操作。", tone: "warning" } };
      }
      return {
        project: result.value,
        history: result.history,
        status: { message: "已撤销。", tone: "success" }
      };
    });
  },

  redo: () => {
    set((state) => {
      const result = redoHistory(state.history);
      if (!result.value) {
        return { status: { message: "没有可重做的操作。", tone: "warning" } };
      }
      return {
        project: result.value,
        history: result.history,
        status: { message: "已重做。", tone: "success" }
      };
    });
  }
}));

function commitProject(
  set: (partial: Partial<EditorStore> | ((state: EditorStore) => Partial<EditorStore>)) => void,
  get: () => EditorStore,
  label: string,
  updater: (project: EditorProject) => EditorProject,
  selection?: EditorSelection
): void {
  const before = cloneProject(get().project);
  const after = touchProject(updater(cloneProject(before)));
  set((state) => ({
    project: after,
    history: pushHistory(state.history, label, before, after),
    selection: selection ?? state.selection,
    exportDraft: null
  }));
}

function createClipFromAsset(asset: DanmakuAsset, timelineStartMs: Milliseconds): DanmakuClip {
  const range = getAssetTimeRange(asset);
  return {
    id: createId("clip"),
    assetId: asset.id,
    name: asset.name,
    timelineStartMs: clampMilliseconds(timelineStartMs),
    sourceInMs: range.earliestMs,
    sourceOutMs: Math.max(range.latestMs, range.earliestMs + 1),
    localOffsetMs: 0,
    enabled: true
  };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    if (!seen.has(value.id)) {
      seen.add(value.id);
      result.push(value);
    }
  }
  return result;
}

function toggleSelectionId(
  selection: EditorSelection,
  kind: EditorSelection["kind"],
  id: string,
  additive: boolean
): { selection: EditorSelection } {
  if (!additive || selection.kind !== kind) {
    return { selection: { kind, ids: [id] } };
  }
  const exists = selection.ids.includes(id);
  const ids = exists
    ? selection.ids.filter((candidate) => candidate !== id)
    : [...selection.ids, id];
  return { selection: ids.length > 0 ? { kind, ids } : emptySelection };
}

function getClipVisualStartMs(clip: DanmakuClip): Milliseconds {
  return clip.timelineStartMs + clip.localOffsetMs;
}

function getClipVisualEndMs(clip: DanmakuClip): Milliseconds {
  return getClipVisualStartMs(clip) + getClipDurationMs(clip);
}

function isTimeInsideClipBody(timeMs: Milliseconds, clip: DanmakuClip): boolean {
  return timeMs > getClipVisualStartMs(clip) && timeMs < getClipVisualEndMs(clip);
}

function splitClip(
  clip: DanmakuClip,
  splitAtMs: Milliseconds
): { left: DanmakuClip; right: DanmakuClip } | null {
  if (!isTimeInsideClipBody(splitAtMs, clip)) {
    return null;
  }
  const sourceSplitMs = clip.sourceInMs + Math.round(splitAtMs - getClipVisualStartMs(clip));
  if (sourceSplitMs <= clip.sourceInMs || sourceSplitMs >= clip.sourceOutMs) {
    return null;
  }
  const left: DanmakuClip = {
    ...clip,
    name: `${clip.name} A`,
    sourceOutMs: sourceSplitMs
  };
  const right: DanmakuClip = {
    ...clip,
    id: createId("clip"),
    name: `${clip.name} B`,
    timelineStartMs: clampMilliseconds(splitAtMs - clip.localOffsetMs),
    sourceInMs: sourceSplitMs
  };
  return { left, right };
}

function mergeAdjacentClips(clips: DanmakuClip[]): DanmakuClip | null {
  if (clips.length < 2) {
    return null;
  }
  const [first, ...rest] = clips;
  let sourceOutMs = first.sourceOutMs;
  let enabled = first.enabled;
  let previous = first;
  for (const current of rest) {
    const timelineContinuous =
      Math.abs(getClipVisualEndMs(previous) - getClipVisualStartMs(current)) <= 1;
    const sourceContinuous = Math.abs(previous.sourceOutMs - current.sourceInMs) <= 1;
    if (current.assetId !== first.assetId || !timelineContinuous || !sourceContinuous) {
      return null;
    }
    sourceOutMs = current.sourceOutMs;
    enabled = enabled && current.enabled;
    previous = current;
  }
  return {
    ...first,
    name: first.name.replace(/\s+[AB]$/, ""),
    sourceOutMs,
    enabled
  };
}

export function findDanmakuItem(project: EditorProject, itemId: string): DanmakuItem | null {
  for (const asset of project.assets) {
    const item = asset.items.find((candidate) => candidate.id === itemId);
    if (item) {
      return item;
    }
  }
  return null;
}

export function findResolvedEvent(
  project: EditorProject,
  itemId: string
): ResolvedDanmakuEvent | null {
  return resolveProjectDanmakuEvents(project).find((event) => event.item.id === itemId) ?? null;
}
