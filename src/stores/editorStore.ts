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
import {
  cleanupProjectEditReferences as cleanupProjectEditReferencesInProject,
  cleanupProjectMissingAssetClips as cleanupProjectMissingAssetClipsInProject,
  createProjectHealthSummary,
  summarizeProjectHealthBlockers
} from "../domain/project/health";
import {
  createBrowserFileMediaReference,
  createDanmakuSourceBinding,
  createLocalPathMediaReference,
  createMediaReferenceFromBinding,
  findDanmakuSourceBinding,
  findProjectMedia,
  removeDanmakuSourceBinding,
  removeMediaReference,
  reconnectMediaReference as reconnectProjectMediaReference,
  updateMediaDuration as updateProjectMediaDuration,
  upsertDanmakuSourceBinding,
  validateDanmakuSourceBinding,
  validateSourceSegmentReferences
} from "../domain/project/mediaLibrary";
import { createLocalFileMediaBinding } from "../domain/project/mediaBinding";
import {
  createDanmakuSourceSegment,
  updateDanmakuSourceSegment,
  type DanmakuSourceSegmentDraft,
  type DanmakuSourceSegmentPatch
} from "../domain/project/sourceTimeline";
import { requiresProjectionOnlyExport } from "../domain/timeline/sourceProjection";
import type {
  EditorProject,
  EditorSelection,
  MediaBinding,
  MediaMatchCandidate,
  MediaReference,
  ProjectMediaReference,
  ProjectMediaRole
} from "../domain/project/types";
import {
  getAssetTimeRange,
  getClipDurationMs,
  getProjectDurationMs,
  resolveProjectDanmakuEvents
} from "../domain/timeline/mapping";
import {
  parseProjectJsonWithMetadata,
  type ProjectSchemaMigration
} from "../domain/project/schema";
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
import {
  acceptMediaMatchCandidate as acceptProjectMediaMatchCandidate,
  reconcileMediaMatchCandidates,
  rejectMediaMatchCandidate as rejectProjectMediaMatchCandidate,
  revokeMediaMatchCandidateAcceptance as revokeProjectMediaMatchCandidateAcceptance,
  upsertMediaMatchCandidate as upsertProjectMediaMatchCandidate,
  updateMediaMatchCandidateRange as updateProjectMediaMatchCandidateRange,
  type MediaMatchRangePatch
} from "../domain/alignment/mediaMatching";
import {
  reviewCandidateTimeMapSpan as reviewProjectCandidateTimeMapSpan,
  type TimeMapSpanReviewDecision
} from "../domain/alignment/timeMapReviewDecision";
import {
  recordCandidateTimeMapSpanPlaybackReview as recordProjectTimeMapSpanPlaybackReview,
  type TimeMapSpanPlaybackEvidence
} from "../domain/alignment/timeMapPlaybackReviewEvidence";
import {
  assessMediaTimeMapVerification,
  clearRegisteredManualMediaTimeMapVerificationTrust,
  computeMediaTimeMapCoreDigest,
  reconcileMediaTimeMapQuality,
  type ManualMediaTimeMapVerificationInput,
  type ManualMediaTimeMapVerificationRevocationInput
} from "../domain/alignment/mediaTimeMap";
import {
  issuePersistedManualMediaTimeMapVerification,
  rehydrateProjectManualMediaTimeMapVerifications,
  revokePersistedManualMediaTimeMapVerification
} from "../infrastructure/media/manualVerificationAuthority";
import { createAlignmentApplyBlockers } from "../domain/alignment/alignmentReport";
import {
  isAlignmentAnchorApplied,
  isAlignmentCutCandidateApplied
} from "../domain/alignment/preview";
import {
  parseAlignmentProposal,
  serializeAlignmentProposal
} from "../domain/alignment/manualProvider";
import { pickAssetColor } from "../domain/shared/assetColors";
import {
  DEFAULT_CUT_HINT_SEARCH_SETTINGS,
  type CutHintSearchSettings
} from "../domain/danmaku/cutHints";

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
  action?: {
    type: "openDirectory";
    label: string;
    directoryPath: string;
  };
}

export interface CutMarkerDraft {
  name?: string;
  note?: string;
}

export type WorkspacePage = "materials" | "matching" | "editing" | "export";

interface EditorStore {
  project: EditorProject;
  selection: EditorSelection;
  history: HistoryState<EditorProject>;
  isPlaying: boolean;
  status: EditorStatus;
  importProgress: number | null;
  exportDraft: ExportDraft | null;
  alignmentProposal: AlignmentProposal | null;
  cutHintSettings: CutHintSearchSettings;
  timelineTool: TimelineTool;
  workspacePage: WorkspacePage;
  projectEpoch: number;
  setWorkspacePage: (page: WorkspacePage) => void;
  newProject: () => void;
  importXmlFiles: (files: FileList | File[]) => Promise<void>;
  importMediaFiles: (files: FileList | File[], role: ProjectMediaRole) => void;
  importMediaPaths: (paths: string[], role: ProjectMediaRole) => void;
  addMediaMatchCandidate: (candidate: MediaMatchCandidate) => void;
  updateMediaMatchCandidateRange: (candidateId: string, patch: MediaMatchRangePatch) => void;
  reviewCandidateTimeMapSpan: (
    timeMapId: string,
    spanIndex: number,
    decision: TimeMapSpanReviewDecision
  ) => void;
  recordTimeMapSpanPlaybackReview: (
    timeMapId: string,
    spanIndex: number,
    evidence: TimeMapSpanPlaybackEvidence
  ) => void;
  acceptMediaMatchCandidate: (candidateId: string, assetIds: string[]) => void;
  issueManualMediaTimeMapVerification: (
    timeMapId: string,
    input: ManualMediaTimeMapVerificationInput
  ) => Promise<void>;
  revokeManualMediaTimeMapVerification: (
    timeMapId: string,
    input: ManualMediaTimeMapVerificationRevocationInput
  ) => Promise<void>;
  revokeMediaMatchCandidateAcceptance: (candidateId: string) => Promise<void>;
  rejectMediaMatchCandidate: (candidateId: string) => void;
  importVideoFile: (file: File) => void;
  removeMedia: () => void;
  removeMediaReference: (mediaId: string) => void;
  reconnectMediaReference: (mediaId: string, file: File) => void;
  bindCurrentMediaAsTarget: () => void;
  setMediaBinding: (binding: MediaBinding) => void;
  clearMediaBinding: () => void;
  bindXmlToSourceMedia: (assetId: string, sourceMediaId: string) => void;
  clearXmlSourceBinding: (assetId: string) => void;
  bindCurrentTargetToSeasonEpisode: (episodeKey: string, episodeLabel: string) => void;
  clearSeasonEpisodeBinding: (episodeKey: string) => void;
  addDanmakuSourceSegment: (draft: DanmakuSourceSegmentDraft) => void;
  updateDanmakuSourceSegment: (id: string, patch: DanmakuSourceSegmentPatch) => void;
  deleteDanmakuSourceSegment: (id: string) => void;
  updateMediaDuration: (durationMs: Milliseconds, mediaId?: string | null) => void;
  openProjectFromText: (text: string, sourceFileName?: string) => void;
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
  cleanupProjectEditReferences: () => void;
  cleanupProjectMissingAssetClips: () => void;
  addCutMarkerAtPlayhead: () => void;
  addCutMarker: (
    sourceAtMs: Milliseconds,
    targetGapMs?: Milliseconds,
    draft?: CutMarkerDraft
  ) => void;
  updateCutMarker: (id: string, patch: Partial<Omit<CutMarker, "id">>) => void;
  deleteCutMarker: (id: string) => void;
  deleteSelection: () => void;
  splitClipAtTime: (clipId: string, splitAtMs: Milliseconds) => void;
  splitSelectedClipsAtPlayhead: () => void;
  mergeSelectedClips: () => void;
  setTimelineTool: (tool: TimelineTool) => void;
  addSyncAnchor: (anchor: SyncAnchor) => void;
  updateSyncAnchor: (id: string, patch: Partial<Omit<SyncAnchor, "id">>) => void;
  deleteSyncAnchor: (id: string) => void;
  setGlobalOffset: (offsetMs: Milliseconds) => void;
  updatePreview: (patch: Partial<EditorProject["preview"]>) => void;
  prepareExport: () => void;
  clearExport: () => void;
  importAlignmentProposalText: (text: string, sourceFileName?: string) => void;
  previewAlignmentProposalData: (proposal: AlignmentProposal) => void;
  exportAlignmentProposal: () => string;
  clearAlignmentProposal: () => void;
  applyAlignmentProposalData: (proposal: AlignmentProposal) => void;
  applyAlignmentProposal: () => void;
  setCutHintSettings: (settings: Partial<CutHintSearchSettings>) => void;
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
  cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS },
  timelineTool: "select",
  workspacePage: "materials",
  projectEpoch: 0,

  setWorkspacePage: (page) => set({ workspacePage: page }),

  newProject: () => {
    revokeProjectObjectUrls(get().project);
    set({
      project: createEmptyProject(),
      selection: emptySelection,
      history: createHistoryState<EditorProject>(),
      isPlaying: false,
      status: { message: "已创建新项目", tone: "success" },
      exportDraft: null,
      alignmentProposal: null,
      timelineTool: "select",
      projectEpoch: get().projectEpoch + 1
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
    try {
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
    } catch (error) {
      set({
        importProgress: null,
        status: createErrorStatus("XML 导入失败", error)
      });
    }
  },

  importMediaFiles: (files, role) => {
    const fileArray = Array.from(files).filter(isSupportedVideoFile);
    if (fileArray.length === 0) {
      set({ status: { message: "请选择受支持的视频文件。", tone: "warning" } });
      return;
    }
    const importedMedia = fileArray.map((file) =>
      createBrowserFileMediaReference(createId("media"), role, {
        name: file.name.replace(/\.[^.]+$/, ""),
        fileName: file.name,
        objectUrl: createObjectUrl(file),
        durationMs: null
      })
    );
    commitProject(
      set,
      get,
      role === "targetOriginal" ? "导入原片素材" : "导入 B 站参考素材",
      (project) => ({
        ...project,
        mediaLibrary: [...project.mediaLibrary, ...importedMedia]
      })
    );
    set({
      status: {
        message:
          role === "targetOriginal"
            ? `已导入 ${importedMedia.length} 个原片素材。`
            : `已导入 ${importedMedia.length} 个 B 站参考素材。`,
        tone: "success"
      }
    });
  },

  importMediaPaths: (paths, role) => {
    const uniquePaths = uniqueSupportedMediaPaths(paths);
    if (uniquePaths.length === 0) {
      set({ status: { message: "请选择受支持的视频文件。", tone: "warning" } });
      return;
    }
    const project = get().project;
    const existingKeys = new Set(
      project.mediaLibrary
        .filter((media) => media.role === role && media.localPath)
        .map((media) => normalizeMediaPathKey(media.localPath ?? ""))
    );
    const importedPaths = uniquePaths.filter(
      (path) => !existingKeys.has(normalizeMediaPathKey(path))
    );
    const skippedCount = uniquePaths.length - importedPaths.length;
    if (importedPaths.length === 0) {
      set({
        status: {
          message: `所选 ${uniquePaths.length} 个视频已在${role === "targetOriginal" ? "原片" : "B 站参考"}素材中，未重复导入。`,
          tone: "neutral"
        }
      });
      return;
    }
    const importedMedia = importedPaths.map((path) =>
      createLocalPathMediaReference(createId("media"), role, path)
    );
    commitProject(
      set,
      get,
      role === "targetOriginal" ? "批量导入原片素材" : "批量导入 B 站参考素材",
      (current) => ({
        ...current,
        mediaLibrary: [...current.mediaLibrary, ...importedMedia]
      })
    );
    set({
      status: {
        message: `已导入 ${importedMedia.length} 个${role === "targetOriginal" ? "原片" : "B 站参考"}素材${
          skippedCount > 0 ? `，跳过 ${skippedCount} 个重复路径` : ""
        }。`,
        tone: "success"
      }
    });
  },

  importVideoFile: (file) => {
    get().importMediaFiles([file], "bilibiliReference");
  },

  addMediaMatchCandidate: (candidate) => {
    const existing = get().project.mediaMatchCandidates.some(
      (item) => item.id === candidate.id
    );
    commitProject(set, get, existing ? "更新媒体匹配候选" : "新增媒体匹配候选", (project) =>
      upsertProjectMediaMatchCandidate(project, candidate)
    );
    set({
      status: {
        message:
          candidate.state === "blocked"
            ? candidate.proposal.timeMap?.quality.level === "blocked"
              ? "匹配候选已保存，但时间图存在歧义或证据不足，不能确认或导出。"
              : "匹配候选已保存，但需要先为参考素材绑定 XML。"
            : "匹配候选已加入复核队列。",
        tone: candidate.state === "blocked" ? "warning" : "success"
      }
    });
  },

  updateMediaMatchCandidateRange: (candidateId, patch) => {
    try {
      commitProject(set, get, "调整媒体匹配候选", (project) =>
        updateProjectMediaMatchCandidateRange(project, candidateId, patch)
      );
      set({ status: { message: "已更新候选匹配范围。", tone: "success" } });
    } catch (error) {
      set({ status: createErrorStatus("匹配候选范围无效", error) });
    }
  },

  reviewCandidateTimeMapSpan: (timeMapId, spanIndex, decision) => {
    try {
      commitProject(set, get, "记录时间图差异分类", (project) =>
        reviewProjectCandidateTimeMapSpan(
          project,
          timeMapId,
          spanIndex,
          decision,
          new Date().toISOString()
        )
      );
      set({
        status: {
          message: "已保存这一段的人工分类；整张时间图仍需完成验证后才能导出。",
          tone: "success"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("无法保存这一段的人工分类", error) });
    }
  },

  recordTimeMapSpanPlaybackReview: (timeMapId, spanIndex, evidence) => {
    try {
      commitProject(set, get, "记录真实 A/B 播放复核", (project) =>
        recordProjectTimeMapSpanPlaybackReview(
          project,
          timeMapId,
          spanIndex,
          evidence,
          new Date().toISOString()
        )
      );
      set({
        status: {
          message: "已保存本段真实 A/B 播放复核证据。",
          tone: "success"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("无法保存 A/B 播放复核证据", error) });
    }
  },

  acceptMediaMatchCandidate: (candidateId, assetIds) => {
    try {
      const beforeCount = get().project.danmakuSourceSegments.length;
      commitProject(set, get, "接受媒体匹配候选", (project) =>
        acceptProjectMediaMatchCandidate(project, candidateId, assetIds)
      );
      const addedCount = get().project.danmakuSourceSegments.length - beforeCount;
      set({
        status: {
          message: `已确认匹配关系，新增 ${Math.max(0, addedCount)} 个来源段。`,
          tone: "success"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("无法接受匹配候选", error) });
    }
  },

  issueManualMediaTimeMapVerification: async (timeMapId, input) => {
    const snapshot = get();
    const timeMap = snapshot.project.mediaTimeMaps.find((item) => item.id === timeMapId);
    if (!timeMap) {
      set({ status: { message: "待签发的时间图不存在。", tone: "error" } });
      return;
    }
    const projectEpoch = snapshot.projectEpoch;
    const coreDigest = computeMediaTimeMapCoreDigest(timeMap);
    try {
      const issued = await issuePersistedManualMediaTimeMapVerification(timeMap, input);
      const current = get();
      const currentMap = current.project.mediaTimeMaps.find((item) => item.id === timeMapId);
      if (
        current.projectEpoch !== projectEpoch ||
        !currentMap ||
        computeMediaTimeMapCoreDigest(currentMap) !== coreDigest
      ) {
        try {
          await revokePersistedManualMediaTimeMapVerification(issued, {
            reason: "签发期间项目或时间图发生变化，未应用的凭据已由竞态保护撤销。",
            revokedBy: "system:stale-project-guard",
            revokedAt: new Date().toISOString()
          });
        } catch {
          // Native issue registry remains the authority. A later project open still rechecks it;
          // never attach this stale seal to a different project even if compensating revoke fails.
        }
        if (get().projectEpoch === projectEpoch) {
          set({
            status: {
              message: "签发期间时间图发生变化，未把旧验证写回项目；请重新完成复核。",
              tone: "warning"
            }
          });
        }
        return;
      }
      commitProject(set, get, "签发人工时间图验证", (project) => ({
        ...project,
        mediaTimeMaps: project.mediaTimeMaps.map((item) =>
          item.id === timeMapId ? issued : item
        )
      }));
      set({ status: { message: "人工复核凭据已由本机签发并写入项目。", tone: "success" } });
    } catch (error) {
      if (get().projectEpoch === projectEpoch) {
        set({ status: createErrorStatus("人工验证签发失败", error) });
      }
    }
  },

  revokeManualMediaTimeMapVerification: async (timeMapId, input) => {
    const snapshot = get();
    const timeMap = snapshot.project.mediaTimeMaps.find((item) => item.id === timeMapId);
    if (!timeMap) {
      set({ status: { message: "待撤销验证的时间图不存在。", tone: "error" } });
      return;
    }
    const projectEpoch = snapshot.projectEpoch;
    const coreDigest = computeMediaTimeMapCoreDigest(timeMap);
    try {
      const revoked = await revokePersistedManualMediaTimeMapVerification(timeMap, input);
      const current = get();
      const currentMap = current.project.mediaTimeMaps.find((item) => item.id === timeMapId);
      if (
        current.projectEpoch !== projectEpoch ||
        !currentMap ||
        computeMediaTimeMapCoreDigest(currentMap) !== coreDigest
      ) {
        return;
      }
      commitProject(set, get, "撤销人工时间图验证", (project) => ({
        ...project,
        mediaTimeMaps: project.mediaTimeMaps.map((item) =>
          item.id === timeMapId ? revoked : item
        )
      }));
      set({ status: { message: "人工验证已写入本机撤销注册表。", tone: "success" } });
    } catch (error) {
      if (get().projectEpoch === projectEpoch) {
        set({ status: createErrorStatus("人工验证撤销失败", error) });
      }
    }
  },

  revokeMediaMatchCandidateAcceptance: async (candidateId) => {
    const snapshot = get();
    const candidate = snapshot.project.mediaMatchCandidates.find(
      (item) => item.id === candidateId
    );
    const confirmedMap = candidate?.confirmedTimeMapId
      ? snapshot.project.mediaTimeMaps.find((map) => map.id === candidate.confirmedTimeMapId)
      : null;
    const hasUntrustedForeignVerification =
      confirmedMap?.verification?.recordVersion === 2 &&
      confirmedMap.verification.revocation === null &&
      !assessMediaTimeMapVerification(confirmedMap).trusted;
    let revokedVerifiedMap = confirmedMap ?? null;
    try {
      if (
        confirmedMap?.verification?.recordVersion === 2 &&
        confirmedMap.verification.revocation === null &&
        assessMediaTimeMapVerification(confirmedMap).trusted
      ) {
        revokedVerifiedMap = await revokePersistedManualMediaTimeMapVerification(confirmedMap, {
          reason: "用户撤销了对应媒体匹配关系。",
          revokedBy: "user:match-revocation",
          revokedAt: new Date().toISOString()
        });
        if (
          get().projectEpoch !== snapshot.projectEpoch ||
          get().project.mediaMatchCandidates.find((item) => item.id === candidateId)
            ?.confirmedTimeMapId !== candidate?.confirmedTimeMapId
        ) {
          return;
        }
      }
      commitProject(set, get, "撤销媒体匹配确认", (project) => {
        const withRevocation = revokedVerifiedMap
          ? {
              ...project,
              mediaTimeMaps: project.mediaTimeMaps.map((map) =>
                map.id === revokedVerifiedMap?.id ? revokedVerifiedMap : map
              )
            }
          : project;
        return revokeProjectMediaMatchCandidateAcceptance(withRevocation, candidateId);
      });
      set({
        status: {
          message: hasUntrustedForeignVerification
            ? "已撤销匹配确认；旧签名不受本机信任，无法修改原安装撤销注册表，已仅作为 superseded 审计保留。"
            : "已撤销匹配确认，候选已恢复到复核队列。",
          tone: "success"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("无法撤销匹配确认", error) });
    }
  },

  rejectMediaMatchCandidate: (candidateId) => {
    try {
      commitProject(set, get, "忽略媒体匹配候选", (project) =>
        rejectProjectMediaMatchCandidate(project, candidateId)
      );
      set({ status: { message: "已忽略该匹配候选。", tone: "neutral" } });
    } catch (error) {
      set({ status: createErrorStatus("无法忽略匹配候选", error) });
    }
  },

  removeMedia: () => {
    const media = get().project.media;
    if (!media) {
      set({ status: { message: "当前没有可删除的视频。", tone: "warning" } });
      return;
    }
    get().removeMediaReference(media.id);
  },

  removeMediaReference: (mediaId) => {
    const media = findProjectMedia(get().project, mediaId);
    if (!media) {
      set({ status: { message: "媒体素材不存在。", tone: "warning" } });
      return;
    }
    const result = removeMediaReference(get().project, mediaId);
    if (!result.ok) {
      const detail =
        result.usages.length > 0
          ? result.usages
              .slice(0, 3)
              .map((usage) => usage.label)
              .join("；")
          : "未找到可删除的媒体素材。";
      set({ status: { message: `不能删除该素材：${detail}`, tone: "warning" } });
      return;
    }
    revokeObjectUrlIfUnused(get().project, media.objectUrl, media.id);
    commitProject(set, get, "删除媒体素材", () =>
      reconcileMediaMatchCandidates(result.project)
    );
    set({ status: { message: `已删除媒体素材：${media.fileName}`, tone: "success" } });
  },

  reconnectMediaReference: (mediaId, file) => {
    const media = findProjectMedia(get().project, mediaId);
    if (!media) {
      set({ status: { message: "媒体素材不存在。", tone: "warning" } });
      return;
    }
    if (!isSupportedVideoFile(file)) {
      set({ status: { message: "请选择受支持的视频文件重新连接。", tone: "warning" } });
      return;
    }
    const objectUrl = createObjectUrl(file);
    const reconnected = reconnectProjectMediaReference(media, {
      name: file.name.replace(/\.[^.]+$/, ""),
      fileName: file.name,
      objectUrl,
      durationMs: media.durationMs
    });
    revokeObjectUrlIfUnused(get().project, media.objectUrl, media.id);
    commitProject(set, get, "重新连接媒体素材", (project) => ({
      ...project,
      mediaLibrary: project.mediaLibrary.map((candidate) =>
        candidate.id === mediaId ? reconnected : candidate
      ),
      media:
        project.media?.id === mediaId || (media.role === "bilibiliReference" && !project.media)
          ? toLegacyMediaReference(reconnected)
          : project.media,
      mediaBinding:
        project.mediaBinding?.kind === "localFile" && project.mediaBinding.mediaId === mediaId
          ? {
              ...project.mediaBinding,
              displayName: reconnected.name,
              fileName: reconnected.fileName,
              runtimeMs: reconnected.durationMs
            }
          : project.mediaBinding
    }));
    set({ status: { message: `已重新连接媒体素材：${file.name}`, tone: "success" } });
  },

  bindCurrentMediaAsTarget: () => {
    const media = get().project.media;
    if (!media) {
      set({ status: { message: "请先导入参考视频，再绑定为目标原片。", tone: "warning" } });
      return;
    }
    if (!media.objectUrl) {
      set({
        status: { message: "该视频需要重新连接后才能作为本次会话的目标原片。", tone: "warning" }
      });
      return;
    }
    const targetMedia = createBrowserFileMediaReference(createId("media"), "targetOriginal", {
      name: media.name,
      fileName: media.fileName,
      objectUrl: media.objectUrl,
      durationMs: media.durationMs
    });
    const binding = createLocalFileMediaBinding(
      createId("media_binding"),
      toLegacyMediaReference(targetMedia)
    );
    commitProject(set, get, "绑定本地目标原片", (project) => ({
      ...project,
      mediaLibrary: [...project.mediaLibrary, targetMedia],
      mediaBinding: { ...binding, mediaId: targetMedia.id }
    }));
    set({ status: { message: `已绑定目标原片：${binding.displayName}`, tone: "success" } });
  },

  setMediaBinding: (binding) => {
    const mediaId = createBindingMediaId(binding);
    const normalizedBinding =
      binding.kind === "localFile" && binding.mediaId !== mediaId
        ? { ...binding, mediaId }
        : binding;
    const targetMedia = createMediaReferenceFromBinding(mediaId, normalizedBinding);
    commitProject(set, get, "绑定目标原片", (project) => ({
      ...project,
      mediaLibrary: upsertMediaById(project.mediaLibrary, targetMedia),
      mediaBinding: normalizedBinding
    }));
    set({
      status: { message: `已绑定目标原片：${normalizedBinding.displayName}`, tone: "success" }
    });
  },

  clearMediaBinding: () => {
    const binding = get().project.mediaBinding;
    if (!binding) {
      set({ status: { message: "当前没有绑定目标原片。", tone: "warning" } });
      return;
    }
    commitProject(set, get, "解除目标原片绑定", (project) => ({
      ...project,
      mediaBinding: null
    }));
    set({ status: { message: `已解除目标原片绑定：${binding.displayName}`, tone: "success" } });
  },

  bindXmlToSourceMedia: (assetId, sourceMediaId) => {
    const conflictingSegment = get().project.danmakuSourceSegments.find(
      (segment) => segment.assetId === assetId && segment.sourceMediaId !== sourceMediaId
    );
    if (conflictingSegment) {
      set({
        status: {
          message: `不能更换 XML 来源：已有来源段“${conflictingSegment.label}”使用当前参考素材，请先删除或调整该来源段。`,
          tone: "warning"
        }
      });
      return;
    }
    const validationMessage = validateDanmakuSourceBinding(
      get().project,
      assetId,
      sourceMediaId
    );
    if (validationMessage) {
      set({ status: { message: validationMessage, tone: "warning" } });
      return;
    }
    const existing = findDanmakuSourceBinding(get().project.danmakuSourceBindings, assetId);
    const binding = createDanmakuSourceBinding(
      existing?.id ?? createId("danmaku_source_binding"),
      assetId,
      sourceMediaId
    );
    const asset = get().project.assets.find((candidate) => candidate.id === assetId);
    const sourceMedia = findProjectMedia(get().project, sourceMediaId);
    commitProject(set, get, "绑定 XML 来源视频", (project) =>
      reconcileMediaMatchCandidates({
        ...project,
        danmakuSourceBindings: upsertDanmakuSourceBinding(
          project.danmakuSourceBindings,
          binding
        )
      })
    );
    set({
      status: {
        message: `已绑定 XML 来源：${asset?.fileName ?? assetId} -> ${sourceMedia?.fileName ?? sourceMediaId}`,
        tone: "success"
      }
    });
  },

  clearXmlSourceBinding: (assetId) => {
    const binding = findDanmakuSourceBinding(get().project.danmakuSourceBindings, assetId);
    if (!binding) {
      set({ status: { message: "该 XML 尚未绑定 B 站参考素材。", tone: "warning" } });
      return;
    }
    const referencedSegment = get().project.danmakuSourceSegments.find(
      (segment) => segment.assetId === assetId
    );
    if (referencedSegment) {
      set({
        status: {
          message: `不能解除 XML 来源绑定：来源段“${referencedSegment.label}”仍在使用，请先删除该来源段。`,
          tone: "warning"
        }
      });
      return;
    }
    const asset = get().project.assets.find((candidate) => candidate.id === assetId);
    commitProject(set, get, "解除 XML 来源视频绑定", (project) =>
      reconcileMediaMatchCandidates({
        ...project,
        danmakuSourceBindings: removeDanmakuSourceBinding(
          project.danmakuSourceBindings,
          assetId
        )
      })
    );
    set({
      status: { message: `已解除 XML 来源绑定：${asset?.fileName ?? assetId}`, tone: "success" }
    });
  },

  bindCurrentTargetToSeasonEpisode: (episodeKey, episodeLabel) => {
    const binding = get().project.mediaBinding;
    if (!binding) {
      set({ status: { message: "请先绑定目标原片，再分配给这一集。", tone: "warning" } });
      return;
    }
    const seasonBinding = {
      id: createId("season_episode_binding"),
      episodeKey,
      episodeLabel,
      targetBinding: structuredClone(binding),
      linkedAt: new Date().toISOString()
    };
    commitProject(set, get, "绑定分集目标原片", (project) => ({
      ...project,
      seasonEpisodeBindings: [
        ...project.seasonEpisodeBindings.filter(
          (candidate) => candidate.episodeKey !== episodeKey
        ),
        seasonBinding
      ]
    }));
    set({ status: { message: `已把当前目标原片绑定到：${episodeLabel}`, tone: "success" } });
  },

  clearSeasonEpisodeBinding: (episodeKey) => {
    const binding = get().project.seasonEpisodeBindings.find(
      (candidate) => candidate.episodeKey === episodeKey
    );
    if (!binding) {
      set({ status: { message: "这一集还没有单独绑定目标原片。", tone: "warning" } });
      return;
    }
    commitProject(set, get, "清除分集目标原片", (project) => ({
      ...project,
      seasonEpisodeBindings: project.seasonEpisodeBindings.filter(
        (candidate) => candidate.episodeKey !== episodeKey
      )
    }));
    set({
      status: { message: `已清除分集目标原片：${binding.episodeLabel}`, tone: "success" }
    });
  },

  addDanmakuSourceSegment: (draft) => {
    try {
      const segment = createDanmakuSourceSegment(createId("danmaku_source_segment"), draft);
      const issues = validateSourceSegmentReferences(get().project, segment);
      const error = issues.find((issue) => issue.severity === "error");
      if (error) {
        throw new Error(error.message);
      }
      commitProject(set, get, "新增弹幕来源内容段", (project) => ({
        ...project,
        danmakuSourceSegments: [...project.danmakuSourceSegments, segment]
      }));
      const warning = issues.find((issue) => issue.severity === "warning");
      set({
        status: {
          message: warning
            ? `已新增弹幕来源内容段：${segment.label}。${warning.message}`
            : `已新增弹幕来源内容段：${segment.label}`,
          tone: warning ? "warning" : "success"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("弹幕来源内容段无效", error) });
    }
  },

  updateDanmakuSourceSegment: (id, patch) => {
    const segment = get().project.danmakuSourceSegments.find(
      (candidate) => candidate.id === id
    );
    if (!segment) {
      set({ status: { message: "弹幕来源内容段不存在。", tone: "warning" } });
      return;
    }
    try {
      const updatedSegment = updateDanmakuSourceSegment(segment, patch);
      const issues = validateSourceSegmentReferences(get().project, updatedSegment);
      const error = issues.find((issue) => issue.severity === "error");
      if (error) {
        throw new Error(error.message);
      }
      commitProject(set, get, "更新弹幕来源内容段", (project) => ({
        ...project,
        danmakuSourceSegments: project.danmakuSourceSegments.map((candidate) =>
          candidate.id === id ? updatedSegment : candidate
        )
      }));
      const warning = issues.find((issue) => issue.severity === "warning");
      set({
        status: {
          message: warning
            ? `已更新弹幕来源内容段：${updatedSegment.label}。${warning.message}`
            : `已更新弹幕来源内容段：${updatedSegment.label}`,
          tone: warning ? "warning" : "success"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("弹幕来源内容段更新失败", error) });
    }
  },

  deleteDanmakuSourceSegment: (id) => {
    const segment = get().project.danmakuSourceSegments.find(
      (candidate) => candidate.id === id
    );
    if (!segment) {
      set({ status: { message: "弹幕来源内容段不存在。", tone: "warning" } });
      return;
    }
    if (segment.timeMapId) {
      set({
        status: {
          message: "该来源段属于已确认时间图，不能单独删除；请在匹配页撤销对应关系。",
          tone: "warning"
        }
      });
      return;
    }
    commitProject(set, get, "删除弹幕来源内容段", (project) =>
      reconcileMediaMatchCandidates({
        ...project,
        danmakuSourceSegments: project.danmakuSourceSegments.filter(
          (candidate) => candidate.id !== id
        )
      })
    );
    set({ status: { message: `已删除弹幕来源内容段：${segment.label}`, tone: "success" } });
  },

  updateMediaDuration: (durationMs, mediaId = null) => {
    const normalizedDuration = clampMilliseconds(durationMs);
    set((state) => {
      const localBinding =
        state.project.mediaBinding?.kind === "localFile" ? state.project.mediaBinding : null;
      const fallbackMediaId = state.project.media?.id ?? localBinding?.mediaId ?? null;
      const activeMediaId = mediaId ?? fallbackMediaId;
      if (!activeMediaId) {
        return { project: state.project };
      }
      const legacyMedia = state.project.media;
      const updatesLegacyMedia = legacyMedia?.id === activeMediaId;
      const updatesMediaLibrary = state.project.mediaLibrary.some(
        (media) => media.id === activeMediaId
      );
      const updatesLocalBinding = localBinding?.mediaId === activeMediaId;
      if (!updatesLegacyMedia && !updatesMediaLibrary && !updatesLocalBinding) {
        return { project: state.project };
      }
      return {
        project: touchProject({
          ...state.project,
          media:
            updatesLegacyMedia && legacyMedia
              ? { ...legacyMedia, durationMs: normalizedDuration }
              : legacyMedia,
          mediaLibrary: state.project.mediaLibrary.map((media) =>
            media.id === activeMediaId
              ? updateProjectMediaDuration(media, normalizedDuration)
              : media
          ),
          mediaBinding:
            updatesLocalBinding && localBinding
              ? { ...localBinding, runtimeMs: normalizedDuration }
              : state.project.mediaBinding
        })
      };
    });
  },

  openProjectFromText: (text, sourceFileName) => {
    try {
      const { project: parsedWithCachedTrust, migration } = parseProjectJsonWithMetadata(text);
      clearRegisteredManualMediaTimeMapVerificationTrust();
      const parsedProject: EditorProject = {
        ...parsedWithCachedTrust,
        mediaTimeMaps: parsedWithCachedTrust.mediaTimeMaps.map((map) =>
          reconcileMediaTimeMapQuality(
            map.verification?.recordVersion === 2
              ? { ...map, quality: { ...map.quality, level: "verified" } }
              : map
          )
        )
      };
      const project = reconcileMediaMatchCandidates(parsedProject, parsedProject.updatedAt);
      const projectEpoch = get().projectEpoch + 1;
      revokeProjectObjectUrls(get().project);
      set({
        project,
        selection: emptySelection,
        history: createHistoryState<EditorProject>(),
        exportDraft: null,
        alignmentProposal: project.alignmentProposal,
        timelineTool: "select",
        projectEpoch,
        status: createOpenProjectStatus(project.name, migration)
      });
      void rehydrateProjectManualMediaTimeMapVerifications(project).then((rehydrated) => {
        set((state) => {
          if (state.projectEpoch !== projectEpoch) {
            return {};
          }
          const merged = mergeRehydratedManualVerificationMaps(
            state.project,
            project,
            rehydrated
          );
          return {
            project: merged.project,
            status:
              merged.restoredCount > 0
                ? {
                    message: `已打开项目“${merged.project.name}”，并通过本机签发/撤销注册表恢复 ${merged.restoredCount} 张人工验证时间图。`,
                    tone: "success"
                  }
                : state.status
          };
        });
      });
    } catch (error) {
      set({
        status: createSourceFileErrorStatus(
          "项目文件打开失败",
          "项目文件打开失败。",
          error,
          sourceFileName
        )
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
        return reconcileMediaMatchCandidates({
          ...currentProject,
          assets: currentProject.assets.filter((candidate) => candidate.id !== assetId),
          clips: currentProject.clips.filter((clip) => clip.assetId !== assetId),
          danmakuSourceBindings: currentProject.danmakuSourceBindings.filter(
            (binding) => binding.assetId !== assetId
          ),
          // XML 是来源段的内容所有者；删除 XML 时必须连同这些派生段一起移除。
          // 仅把 assetId 置空会留下仍引用 confirmed TimeMap 的孤儿段，使项目可保存却无法重开。
          danmakuSourceSegments: currentProject.danmakuSourceSegments.filter(
            (segment) => segment.assetId !== assetId
          ),
          disabledItemIds: currentProject.disabledItemIds.filter(
            (itemId) => !itemIds.has(itemId)
          ),
          itemTimeAdjustments
        });
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
          sourceOutMs: Math.max(range.latestMs + 1, range.earliestMs + 1),
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
    commitProject(set, get, "移动版本差异", (project) => ({
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

  cleanupProjectEditReferences: () => {
    const cleanup = cleanupProjectEditReferencesInProject(get().project);
    if (!cleanup.changed) {
      set({ status: { message: "当前没有需要清理的失效编辑引用。", tone: "neutral" } });
      return;
    }
    commitProject(set, get, "清理失效编辑引用", () => cleanup.project);
    set({
      status: {
        message: `已清理 ${cleanup.removedDisabledItemIds + cleanup.removedItemAdjustments} 条失效编辑引用。`,
        tone: "success"
      }
    });
  },

  cleanupProjectMissingAssetClips: () => {
    const cleanup = cleanupProjectMissingAssetClipsInProject(get().project);
    if (!cleanup.changed) {
      set({ status: { message: "当前没有需要清理的缺失资源片段。", tone: "neutral" } });
      return;
    }
    const removedClipIds = new Set(cleanup.removedClipIds);
    const selection = get().selection;
    const nextSelection =
      selection.kind === "clip"
        ? createSelection(
            "clip",
            selection.ids.filter((id) => !removedClipIds.has(id))
          )
        : selection;
    commitProject(set, get, "清理缺失资源片段", () => cleanup.project, nextSelection);
    set({
      status: {
        message: `已清理 ${cleanup.removedClipCount} 个缺失资源片段。`,
        tone: "success"
      }
    });
  },

  addCutMarkerAtPlayhead: () => {
    get().addCutMarker(get().project.timeline.playheadMs, 45_000);
  },

  addCutMarker: (sourceAtMs, targetGapMs = 45_000, draft) => {
    const markerId = createId("cut");
    commitProject(
      set,
      get,
      "添加版本差异",
      (project) => ({
        ...project,
        cutMarkers: [
          ...project.cutMarkers,
          {
            id: markerId,
            name: draft?.name ?? `版本差异 ${project.cutMarkers.length + 1}`,
            sourceAtMs: clampMilliseconds(sourceAtMs),
            targetGapMs,
            note: draft?.note ?? "目标完整版在此处额外存在内容"
          }
        ]
      }),
      { kind: "cut", ids: [markerId] }
    );
    set({
      status: {
        message: draft ? "已添加待确认版本差异。" : "已添加版本差异。",
        tone: "success"
      }
    });
  },

  updateCutMarker: (id, patch) => {
    commitProject(set, get, "修改版本差异", (project) => ({
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
      "删除版本差异",
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
        "删除版本差异",
        (project) => ({
          ...project,
          cutMarkers: project.cutMarkers.filter((marker) => !selection.ids.includes(marker.id))
        }),
        emptySelection
      );
      set({
        status: { message: `已删除 ${selection.ids.length} 个版本差异。`, tone: "success" }
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
        status: {
          message: "只能合并同一 XML 且原弹幕时间、时间轴连续的片段。",
          tone: "warning"
        }
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

  updateSyncAnchor: (id, patch) => {
    commitProject(set, get, "修改同步锚点", (project) => ({
      ...project,
      syncAnchors: project.syncAnchors.map((anchor) =>
        anchor.id === id
          ? {
              ...anchor,
              ...patch,
              sourceMs:
                patch.sourceMs !== undefined
                  ? clampMilliseconds(patch.sourceMs)
                  : anchor.sourceMs,
              targetMs:
                patch.targetMs !== undefined
                  ? clampMilliseconds(patch.targetMs)
                  : anchor.targetMs
            }
          : anchor
      )
    }));
  },

  deleteSyncAnchor: (id) => {
    commitProject(
      set,
      get,
      "删除同步锚点",
      (project) => ({
        ...project,
        syncAnchors: project.syncAnchors.filter((anchor) => anchor.id !== id)
      }),
      get().selection.kind === "anchor" && get().selection.ids.includes(id)
        ? emptySelection
        : get().selection
    );
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
    if (requiresProjectionOnlyExport(project)) {
      set({
        exportDraft: null,
        status: {
          message: "导出已阻断：当前项目必须在导出页通过已确认时间图按原片分集导出。",
          tone: "warning"
        }
      });
      return;
    }
    const health = createProjectHealthSummary(project);
    const blockingFinding = health.findings.find((finding) => finding.severity === "error");
    if (blockingFinding) {
      const blockingDetail = summarizeProjectHealthBlockers(health) ?? blockingFinding.title;
      set({
        exportDraft: null,
        status: {
          message: `导出前检查未通过：${blockingDetail}。请在导出检查中处理后再导出。`,
          tone: "warning"
        }
      });
      return;
    }
    const events = resolveProjectDanmakuEvents(project);
    const enabledEvents = events.filter((event) => event.enabled);
    if (enabledEvents.length === 0) {
      set({
        exportDraft: null,
        status: {
          message: "当前没有可导出的弹幕，请先把 XML 放入时间轴。",
          tone: "warning"
        }
      });
      return;
    }
    const exportResult = serializeBilibiliXml(
      enabledEvents.map((event) => ({ item: event.item, finalTimeMs: event.finalTimeMs }))
    );
    const validation = validateExportedXml(exportResult.xml);
    const summary = createExportSummary(
      events,
      project.cutMarkers,
      project.assets.some((asset) => asset.warnings.length > 0)
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

  importAlignmentProposalText: (text, sourceFileName) => {
    try {
      const proposal = parseAlignmentProposal(text);
      get().previewAlignmentProposalData(proposal);
    } catch (error) {
      set({
        status: createSourceFileErrorStatus(
          "对齐提案导入失败",
          "对齐提案导入失败。",
          error,
          sourceFileName
        )
      });
    }
  },

  previewAlignmentProposalData: (proposal) => {
    const existingProposal = get().project.alignmentProposal;
    if (isSameAlignmentProposal(existingProposal, proposal)) {
      set({
        alignmentProposal: existingProposal,
        status: createAlignmentProposalPreviewStatus(proposal)
      });
      return;
    }
    commitProject(set, get, "预览对齐提案", (currentProject) => ({
      ...currentProject,
      alignmentProposal: proposal
    }));
    set({ status: createAlignmentProposalPreviewStatus(proposal) });
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

  clearAlignmentProposal: () => {
    if (!get().alignmentProposal && !get().project.alignmentProposal) {
      set({ status: { message: "当前没有可清空的对齐提案。", tone: "warning" } });
      return;
    }
    commitProject(set, get, "清空对齐提案", (currentProject) => ({
      ...currentProject,
      alignmentProposal: null
    }));
    set({ status: { message: "已清空当前对齐提案。", tone: "success" } });
  },

  applyAlignmentProposalData: (proposal) => {
    const project = get().project;
    const blockers = createAlignmentApplyBlockers(proposal, {
      existingAnchors: project.syncAnchors,
      existingCutMarkers: project.cutMarkers
    });
    if (blockers.length > 0) {
      set({
        status: {
          message: `对齐提案存在应用阻断：${blockers[0]}`,
          tone: "warning"
        }
      });
      return;
    }
    const pendingAnchors = proposal.anchors.filter(
      (anchor) => !isAlignmentAnchorApplied(project.syncAnchors, anchor)
    );
    const pendingCutCandidates = proposal.cutCandidates.filter(
      (candidate) => !isAlignmentCutCandidateApplied(project.cutMarkers, candidate)
    );
    if (pendingAnchors.length === 0 && pendingCutCandidates.length === 0) {
      set({ status: { message: "对齐提案没有新的可应用项。", tone: "neutral" } });
      return;
    }
    commitProject(set, get, "应用对齐提案", (currentProject) => ({
      ...currentProject,
      syncAnchors: uniqueById([...currentProject.syncAnchors, ...pendingAnchors]),
      cutMarkers: uniqueById([
        ...currentProject.cutMarkers,
        ...pendingCutCandidates.map((candidate, index) => ({
          ...cutCandidateToMarker(candidate),
          id: candidate.id.length > 0 ? candidate.id : createId("cut"),
          name: candidate.name.length > 0 ? candidate.name : `候选版本差异 ${index + 1}`
        }))
      ])
    }));
    set({
      status: {
        message: `已应用对齐提案：新增 ${pendingAnchors.length} 个同步线索，${pendingCutCandidates.length} 个版本差异。`,
        tone: "success"
      }
    });
  },

  applyAlignmentProposal: () => {
    const proposal = get().alignmentProposal;
    if (!proposal) {
      set({ status: { message: "当前没有可应用的对齐提案。", tone: "warning" } });
      return;
    }
    get().applyAlignmentProposalData(proposal);
  },

  setCutHintSettings: (settings) => {
    set((state) => ({
      cutHintSettings: {
        ...state.cutHintSettings,
        ...settings
      }
    }));
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
        alignmentProposal: result.value.alignmentProposal,
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
        alignmentProposal: result.value.alignmentProposal,
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
    alignmentProposal: after.alignmentProposal,
    selection: selection ?? state.selection,
    exportDraft: null
  }));
}

function mergeRehydratedManualVerificationMaps(
  currentProject: EditorProject,
  openedSnapshot: EditorProject,
  rehydratedSnapshot: EditorProject
): { project: EditorProject; restoredCount: number } {
  const openedById = new Map(openedSnapshot.mediaTimeMaps.map((map) => [map.id, map]));
  const rehydratedById = new Map(rehydratedSnapshot.mediaTimeMaps.map((map) => [map.id, map]));
  let restoredCount = 0;
  const mediaTimeMaps = currentProject.mediaTimeMaps.map((currentMap) => {
    const openedMap = openedById.get(currentMap.id);
    const rehydratedMap = rehydratedById.get(currentMap.id);
    if (
      !openedMap ||
      !rehydratedMap ||
      !hasSameManualVerificationHydrationInput(currentMap, openedMap)
    ) {
      return currentMap;
    }
    if (rehydratedMap.quality.level === "verified") {
      restoredCount += 1;
    }
    return rehydratedMap;
  });
  return { project: { ...currentProject, mediaTimeMaps }, restoredCount };
}

function hasSameManualVerificationHydrationInput(
  currentMap: EditorProject["mediaTimeMaps"][number],
  openedMap: EditorProject["mediaTimeMaps"][number]
): boolean {
  return (
    currentMap.revision === openedMap.revision &&
    currentMap.state === openedMap.state &&
    currentMap.updatedAt === openedMap.updatedAt &&
    computeMediaTimeMapCoreDigest(currentMap) === computeMediaTimeMapCoreDigest(openedMap) &&
    JSON.stringify(currentMap.verification) === JSON.stringify(openedMap.verification)
  );
}

function revokeProjectObjectUrls(project: EditorProject): void {
  const urls = new Set<string>();
  if (project.media?.objectUrl) {
    urls.add(project.media.objectUrl);
  }
  project.mediaLibrary.forEach((media) => {
    if (media.objectUrl) {
      urls.add(media.objectUrl);
    }
  });
  urls.forEach((url) => revokeObjectUrl(url));
}

function revokeObjectUrlIfUnused(
  project: EditorProject,
  objectUrl: string | null,
  removedMediaId: string
): void {
  if (!objectUrl) {
    return;
  }
  const stillUsed = project.mediaLibrary.some(
    (media) => media.id !== removedMediaId && media.objectUrl === objectUrl
  );
  if (!stillUsed) {
    revokeObjectUrl(objectUrl);
  }
}

function isSupportedVideoFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return isSupportedVideoPath(name) || file.type.startsWith("video/");
}

const SUPPORTED_VIDEO_EXTENSIONS = [
  ".mp4",
  ".mkv",
  ".webm",
  ".mov",
  ".m4v",
  ".avi",
  ".flv",
  ".ts",
  ".m2ts"
];

function uniqueSupportedMediaPaths(paths: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  paths.forEach((path) => {
    const trimmed = path.trim();
    const key = normalizeMediaPathKey(trimmed);
    if (trimmed.length === 0 || !isSupportedVideoPath(trimmed) || seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(trimmed);
  });
  return result;
}

function isSupportedVideoPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SUPPORTED_VIDEO_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function normalizeMediaPathKey(path: string): string {
  return path.trim().replace(/\//g, "\\").replace(/\\+/g, "\\").toLocaleLowerCase("en-US");
}

function toLegacyMediaReference(media: ProjectMediaReference): MediaReference {
  return {
    id: media.id,
    name: media.name,
    fileName: media.fileName,
    objectUrl: media.objectUrl,
    durationMs: media.durationMs
  };
}

function upsertMediaById(
  mediaLibrary: readonly ProjectMediaReference[],
  media: ProjectMediaReference
): ProjectMediaReference[] {
  const exists = mediaLibrary.some((candidate) => candidate.id === media.id);
  if (!exists) {
    return [...mediaLibrary, media];
  }
  return mediaLibrary.map((candidate) => (candidate.id === media.id ? media : candidate));
}

function createBindingMediaId(binding: MediaBinding): string {
  if (binding.kind === "localFile" && binding.mediaId) {
    return binding.mediaId;
  }
  return `media_${binding.id}`;
}

function createAlignmentProposalPreviewStatus(proposal: AlignmentProposal): EditorStatus {
  return {
    message: `已发送到时间轴预览：${proposal.anchors.length} 个同步线索，${proposal.cutCandidates.length} 个候选版本差异。`,
    tone: "success"
  };
}

function isSameAlignmentProposal(
  current: AlignmentProposal | null,
  next: AlignmentProposal
): boolean {
  return current
    ? serializeAlignmentProposal(current) === serializeAlignmentProposal(next)
    : false;
}

function createOpenProjectStatus(
  projectName: string,
  migration: ProjectSchemaMigration | null
): EditorStatus {
  if (!migration) {
    return { message: `已打开项目：${projectName}`, tone: "success" };
  }
  const adjustedClipRangeSuffix =
    migration.adjustedClipRangeCount > 0
      ? `，并兼容调整 ${migration.adjustedClipRangeCount} 个片段边界`
      : "";
  return {
    message: `已打开旧版项目：${projectName}。已从 v${migration.fromVersion} 升级到 v${migration.toVersion}${adjustedClipRangeSuffix}。`,
    tone: migration.adjustedClipRangeCount > 0 ? "warning" : "success"
  };
}

function createErrorStatus(prefix: string, error: unknown): EditorStatus {
  if (error instanceof Error && error.message.trim().length > 0) {
    return { message: `${prefix}：${error.message}`, tone: "error" };
  }
  return { message: `${prefix}。`, tone: "error" };
}

function createSourceFileErrorStatus(
  prefix: string,
  fallbackMessage: string,
  error: unknown,
  sourceFileName?: string
): EditorStatus {
  const detail =
    error instanceof Error && error.message.trim().length > 0 ? error.message : fallbackMessage;
  if (!sourceFileName) {
    return { message: detail, tone: "error" };
  }
  if (detail.includes(sourceFileName)) {
    return { message: `${prefix}：${detail}`, tone: "error" };
  }
  return { message: `${prefix}：${sourceFileName}：${detail}`, tone: "error" };
}

function createClipFromAsset(asset: DanmakuAsset, timelineStartMs: Milliseconds): DanmakuClip {
  const range = getAssetTimeRange(asset);
  return {
    id: createId("clip"),
    assetId: asset.id,
    name: asset.name,
    timelineStartMs: clampMilliseconds(timelineStartMs),
    sourceInMs: range.earliestMs,
    sourceOutMs: Math.max(range.latestMs + 1, range.earliestMs + 1),
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

function createSelection(kind: EditorSelection["kind"], ids: string[]): EditorSelection {
  return ids.length > 0 ? { kind, ids } : emptySelection;
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
