import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  Crosshair,
  Download,
  FolderOpen,
  Layers,
  ListPlus,
  ListX,
  Search,
  Shuffle,
  Trash2,
  TriangleAlert,
  Video,
  WandSparkles
} from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { TextButton } from "../../components/TextButton";
import {
  createAlignmentApplyBlockers,
  createAlignmentReviewItemStatuses,
  createAlignmentReviewReport,
  createAlignmentReviewStatusSummary
} from "../../domain/alignment/alignmentReport";
import { createAnchorCalibrationProposal } from "../../domain/alignment/anchorCalibration";
import {
  assessMediaTimeMapVerification,
  computeMediaTimeMapCoreDigest,
  createMediaTimeMapCoreCanonicalJson,
  createManualMediaTimeMapVerificationRequest
} from "../../domain/alignment/mediaTimeMap";
import {
  isTimeMapManualTakeoverExportApproved,
  readTimeMapManualTakeover
} from "../../domain/alignment/timeMapReviewDecision";
import { serializeAlignmentProposal } from "../../domain/alignment/manualProvider";
import { buildAlignmentPreview } from "../../domain/alignment/preview";
import type { AlignmentProposal } from "../../domain/alignment/types";
import { buildBatchMergePlan, type BatchMergeOptions } from "../../domain/danmaku/batchMerge";
import {
  createCutHintSearchPlan,
  findSuspectedCutCandidates,
  isSuspectedCutCandidateApplied,
  type SuspectedCutCandidate
} from "../../domain/danmaku/cutHints";
import {
  parseCutPointsText,
  parseEpisodeDurationsText,
  parseMinutesInput
} from "../../domain/danmaku/manualRules";
import type { CutMarker, SyncAnchor } from "../../domain/danmaku/types";
import {
  createProjectHealthReport,
  createProjectHealthSummary
} from "../../domain/project/health";
import { createProjectDownloadFileName } from "../../domain/project/fileNames";
import { createId } from "../../domain/project/factory";
import {
  findDanmakuSourceBinding,
  findProjectMedia,
  formatMediaConnectionState,
  formatMediaRole
} from "../../domain/project/mediaLibrary";
import {
  createEmbyItemMediaBinding,
  formatMediaBindingEpisode,
  formatMediaBindingSource,
  formatMediaBindingTitle,
  formatMediaSourceSummary,
  createLocalPathMediaBinding
} from "../../domain/project/mediaBinding";
import {
  createProjectMatchAssessment,
  formatProjectMatchScore,
  type ProjectMatchAssessment,
  type ProjectMatchCriterionState
} from "../../domain/project/matchAssessment";
import {
  createProjectReadinessSummary,
  type ProjectReadinessItem,
  type ProjectReadinessStatus,
  type ProjectReadinessSummary
} from "../../domain/project/readiness";
import {
  createSeasonWorkbenchSummary,
  type SeasonWorkbenchStepState,
  type SeasonWorkbenchSummary
} from "../../domain/project/seasonWorkbench";
import {
  createSeasonEpisodeKey,
  findSeasonEpisodeBinding
} from "../../domain/project/seasonEpisodeBinding";
import {
  createSourceTimelineSummary,
  parseSourceTimecode,
  type DanmakuSourceSegmentDraft,
  type DanmakuSourceSegmentPatch,
  type SegmentTimingRuleDraft,
  type SourceTimelineFinding,
  type SourceTimelineSummary
} from "../../domain/project/sourceTimeline";
import type {
  DanmakuSourceSegment,
  DanmakuSourceSegmentKind,
  EditorProject,
  MediaContentIdentity,
  MediaBinding,
  MediaReference,
  ProjectMediaReference,
  ProjectMediaRole,
  SeasonEpisodeBinding
} from "../../domain/project/types";
import { formatTimecode, type Milliseconds } from "../../domain/shared/time";
import { getAssetTimeRange } from "../../domain/timeline/mapping";
import {
  projectDanmakuToTargets,
  requiresProjectionOnlyExport,
  type SourceProjectionResult,
  type TargetProjectionGroup
} from "../../domain/timeline/sourceProjection";
import { preflightProjectMediaIdentities } from "../../infrastructure/media/mediaIdentityPreflight";
import { issuePersistedManualMediaTimeMapVerification } from "../../infrastructure/media/manualVerificationAuthority";
import {
  createStoredZipEntries,
  downloadTextFile,
  readTextFile
} from "../../infrastructure/file-system/browserFiles";
import {
  downloadLegacyXmlFiles,
  formatExportFileError,
  getVerifiedExportUnavailableReason,
  openExportDirectoryPath,
  saveProjectedXmlExports,
  type SaveTextExportResult,
  type ProjectionDerivationV2,
  type VerifiedExportMapProof,
  type VerifiedExportVerificationSeed,
  type VerifiedMediaDependency
} from "../../infrastructure/file-system/exportFiles";
import {
  pickAlignmentMediaPath,
  pickMediaPaths,
  pickXmlPaths,
  VIDEO_FILE_EXTENSIONS
} from "../../infrastructure/file-system/nativeDialogs";
import {
  authenticateEmby,
  fetchEmbyEpisodeChildren,
  fetchEmbyItem,
  formatEmbyEpisodeDurationLines,
  formatEmbySingleDurationLine,
  searchEmbyItems,
  type EmbyAuthSession,
  type EmbyItemMetadata
} from "../../infrastructure/metadata/embyClient";
import { loadAppSettings } from "../../infrastructure/settings/appSettings";
import { loadVolatileEmbyPassword } from "../../infrastructure/settings/volatileEmbyCredentials";
import {
  serializeBilibiliXml,
  validateExportedXml
} from "../../infrastructure/xml/bilibiliXml";
import { WorkspaceProgressBanner } from "../workspace/WorkspaceProgressBanner";
import { useEditorStore, type EditorStatus } from "../../stores/editorStore";

const MediaMatchingPanel = lazy(async () => {
  const module = await import("../matching/MediaMatchingPanel");
  return { default: module.MediaMatchingPanel };
});

const RealMediaBenchmarkPanel = lazy(async () => {
  const module = await import("../matching/RealMediaBenchmarkPanel");
  return { default: module.RealMediaBenchmarkPanel };
});

export type AssetPanelSection = "materials" | "matching" | "editing" | "export";
type PartWindowMode = "full" | "prefix" | "suffix" | "range";
type LongSplitMode = "auto" | "durations" | "cuts";
type EmbyLoadingKind = "auth" | "search" | "item" | "episodes";

interface EmbySessionState {
  key: string;
  session: EmbyAuthSession;
}

interface EmbyConnectionState {
  config: {
    serverUrl: string;
    pathPrefix: string;
  };
  username: string;
  password: string;
  sessionKey: string;
}

export function AssetPanel({ section }: { section: AssetPanelSection }) {
  const [legacyMaterialsOpen, setLegacyMaterialsOpen] = useState(false);
  const [legacyExportOpen, setLegacyExportOpen] = useState(false);
  const [partWindowMode, setPartWindowMode] = useState<PartWindowMode>("full");
  const [partWindowMinutes, setPartWindowMinutes] = useState("9");
  const [partRangeStartMinutes, setPartRangeStartMinutes] = useState("0");
  const [partRangeEndMinutes, setPartRangeEndMinutes] = useState("9");
  const [longSplitMode, setLongSplitMode] = useState<LongSplitMode>("auto");
  const [episodeDurationsText, setEpisodeDurationsText] = useState("");
  const [cutPointsText, setCutPointsText] = useState("");
  const [anchorCalibrationText, setAnchorCalibrationText] = useState("");
  const [alignmentProposalText, setAlignmentProposalText] = useState("");
  const [targetValidationLoading, setTargetValidationLoading] = useState(false);
  const [reconnectMediaId, setReconnectMediaId] = useState<string | null>(null);
  const [xmlDropActive, setXmlDropActive] = useState(false);
  const [matchingTechnicalToolsOpen, setMatchingTechnicalToolsOpen] =
    useState(false);
  const targetMediaInputRef = useRef<HTMLInputElement | null>(null);
  const sourceMediaInputRef = useRef<HTMLInputElement | null>(null);
  const reconnectMediaInputRef = useRef<HTMLInputElement | null>(null);
  const xmlInputRef = useRef<HTMLInputElement | null>(null);
  const lastSyncedAlignmentProposalTextRef = useRef("");
  const lastAlignmentProjectIdRef = useRef<string | null>(null);
  const project = useEditorStore((state) => state.project);
  const selection = useEditorStore((state) => state.selection);
  const alignmentProposal = useEditorStore((state) => state.alignmentProposal);
  const cutHintSettings = useEditorStore((state) => state.cutHintSettings);
  const importProgress = useEditorStore((state) => state.importProgress);
  const importMediaFiles = useEditorStore((state) => state.importMediaFiles);
  const importMediaPaths = useEditorStore((state) => state.importMediaPaths);
  const importXmlFiles = useEditorStore((state) => state.importXmlFiles);
  const importXmlPaths = useEditorStore((state) => state.importXmlPaths);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const addAssetToTimeline = useEditorStore((state) => state.addAssetToTimeline);
  const removeAsset = useEditorStore((state) => state.removeAsset);
  const removeAssetFromTimeline = useEditorStore((state) => state.removeAssetFromTimeline);
  const removeMediaReference = useEditorStore((state) => state.removeMediaReference);
  const reconnectMediaReference = useEditorStore((state) => state.reconnectMediaReference);
  const setMediaBinding = useEditorStore((state) => state.setMediaBinding);
  const clearMediaBinding = useEditorStore((state) => state.clearMediaBinding);
  const bindXmlToSourceMedia = useEditorStore((state) => state.bindXmlToSourceMedia);
  const clearXmlSourceBinding = useEditorStore((state) => state.clearXmlSourceBinding);
  const bindCurrentTargetToSeasonEpisode = useEditorStore(
    (state) => state.bindCurrentTargetToSeasonEpisode
  );
  const clearSeasonEpisodeBinding = useEditorStore((state) => state.clearSeasonEpisodeBinding);
  const addDanmakuSourceSegment = useEditorStore((state) => state.addDanmakuSourceSegment);
  const updateDanmakuSourceSegment = useEditorStore(
    (state) => state.updateDanmakuSourceSegment
  );
  const deleteDanmakuSourceSegment = useEditorStore(
    (state) => state.deleteDanmakuSourceSegment
  );
  const autoArrangeClips = useEditorStore((state) => state.autoArrangeClips);
  const select = useEditorStore((state) => state.select);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const addCutMarker = useEditorStore((state) => state.addCutMarker);
  const updateCutMarker = useEditorStore((state) => state.updateCutMarker);
  const deleteCutMarker = useEditorStore((state) => state.deleteCutMarker);
  const updateSyncAnchor = useEditorStore((state) => state.updateSyncAnchor);
  const deleteSyncAnchor = useEditorStore((state) => state.deleteSyncAnchor);
  const importAlignmentProposalText = useEditorStore(
    (state) => state.importAlignmentProposalText
  );
  const clearAlignmentProposal = useEditorStore((state) => state.clearAlignmentProposal);
  const previewAlignmentProposalData = useEditorStore(
    (state) => state.previewAlignmentProposalData
  );
  const applyAlignmentProposalData = useEditorStore(
    (state) => state.applyAlignmentProposalData
  );
  const setCutHintSettings = useEditorStore((state) => state.setCutHintSettings);
  const cleanupProjectEditReferences = useEditorStore(
    (state) => state.cleanupProjectEditReferences
  );
  const cleanupProjectMissingAssetClips = useEditorStore(
    (state) => state.cleanupProjectMissingAssetClips
  );
  const prepareExport = useEditorStore((state) => state.prepareExport);
  const manualRules = useMemo(
    () =>
      createBatchMergeOptions({
        partWindowMode,
        partWindowMinutes,
        partRangeStartMinutes,
        partRangeEndMinutes,
        longSplitMode,
        episodeDurationsText,
        cutPointsText
      }),
    [
      partWindowMode,
      partWindowMinutes,
      partRangeStartMinutes,
      partRangeEndMinutes,
      longSplitMode,
      episodeDurationsText,
      cutPointsText
    ]
  );
  const batchMergeOptions = useMemo(
    () => ({
      ...manualRules.options,
      cutMarkers: project.cutMarkers
    }),
    [manualRules.options, project.cutMarkers]
  );
  const batchMergePlan = useMemo(
    () => buildBatchMergePlan(project.assets, batchMergeOptions),
    [batchMergeOptions, project.assets]
  );
  const seasonWorkbench = useMemo(
    () => createSeasonWorkbenchSummary(project, batchMergePlan, manualRules.warnings),
    [batchMergePlan, manualRules.warnings, project]
  );
  const sourceTimelineSummary = useMemo(
    () => createSourceTimelineSummary(project, batchMergePlan),
    [batchMergePlan, project]
  );
  const cutHintSearch = useMemo(
    () => createCutHintSearchPlan(cutHintSettings),
    [cutHintSettings]
  );

  const openMediaImport = async (role: ProjectMediaRole) => {
    if (!isTauri()) {
      (role === "targetOriginal" ? targetMediaInputRef : sourceMediaInputRef).current?.click();
      return;
    }
    try {
      const paths = await pickMediaPaths(role);
      if (paths.length > 0) {
        importMediaPaths(paths, role);
      }
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "视频批量导入失败。",
        tone: "error"
      });
    }
  };
  const openXmlImport = async () => {
    if (!isTauri()) {
      xmlInputRef.current?.click();
      return;
    }
    try {
      const paths = await pickXmlPaths();
      if (paths.length > 0) {
        await importXmlPaths(paths);
      }
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "XML 批量导入失败。",
        tone: "error"
      });
    }
  };
  const suspectedCutCandidates = useMemo(
    () => findSuspectedCutCandidates(project.assets, cutHintSearch.options),
    [cutHintSearch, project.assets]
  );
  const anchorCalibrationProposal = useMemo(
    () => createAnchorCalibrationProposal(anchorCalibrationText),
    [anchorCalibrationText]
  );
  const alignmentPreview = useMemo(
    () => buildAlignmentPreview(project, alignmentProposal),
    [project, alignmentProposal]
  );
  const serializedAlignmentProposalText = useMemo(
    () => (alignmentProposal ? serializeAlignmentProposal(alignmentProposal) : ""),
    [alignmentProposal]
  );
  const projectHealth = useMemo(() => createProjectHealthSummary(project), [project]);
  const projectReadiness = useMemo(() => createProjectReadinessSummary(project), [project]);
  const projectMatchAssessment = useMemo(
    () => createProjectMatchAssessment(project),
    [project]
  );
  const sourceProjection = useMemo(() => projectDanmakuToTargets(project), [project]);
  const projectionOnlyExport = requiresProjectionOnlyExport(project);
  const targetOriginalMedia = useMemo(
    () => project.mediaLibrary.filter((media) => media.role === "targetOriginal"),
    [project.mediaLibrary]
  );
  const bilibiliReferenceMedia = useMemo(
    () => project.mediaLibrary.filter((media) => media.role === "bilibiliReference"),
    [project.mediaLibrary]
  );

  const bindLocalPathAsTarget = async () => {
    const currentPath =
      project.mediaBinding?.kind === "localFile" ? (project.mediaBinding.localPath ?? "") : "";
    try {
      const path = await pickAlignmentMediaPath(currentPath);
      if (!path) {
        return;
      }
      const binding = createLocalPathMediaBinding(createId("media_binding"), path);
      setMediaBinding(binding);
      setStatus({ message: `已绑定本地目标原片路径：${binding.fileName}`, tone: "success" });
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "选择本地目标原片失败。",
        tone: "warning"
      });
    }
  };

  const validateEmbyTargetBinding = async () => {
    const binding = project.mediaBinding;
    if (!binding || binding.kind !== "embyItem") {
      setStatus({ message: "当前目标原片不是 Emby 条目。", tone: "warning" });
      return;
    }
    const connection = loadEmbyConnectionState();
    if (!validateEmbyConnectionState(connection)) {
      return;
    }
    setTargetValidationLoading(true);
    try {
      const session = await authenticateEmby(connection.config, {
        username: connection.username,
        password: connection.password
      });
      const item = await fetchEmbyItem(connection.config, session, binding.itemId);
      const updatedBinding = createEmbyBindingFromItem(item, connection);
      setMediaBinding(updatedBinding);
      setStatus({
        message: `已重新确认目标原片：${updatedBinding.displayName}`,
        tone: "success"
      });
    } catch (error) {
      setStatus({
        message: `目标原片需要重新连接：${error instanceof Error ? error.message : "Emby 请求失败。"}`,
        tone: "error"
      });
    } finally {
      setTargetValidationLoading(false);
    }
  };

  const previewProjectMatchProposal = () => {
    if (!projectMatchAssessment.proposal) {
      setStatus({
        message: "先绑定目标原片并导入 XML 后，才能生成匹配评分提案。",
        tone: "warning"
      });
      return;
    }
    previewAlignmentProposalData(projectMatchAssessment.proposal);
  };

  useEffect(() => {
    const projectChanged = lastAlignmentProjectIdRef.current !== project.id;
    lastAlignmentProjectIdRef.current = project.id;
    setAlignmentProposalText((currentText) => {
      const lastSyncedText = lastSyncedAlignmentProposalTextRef.current;
      const hasUserDraft = currentText.trim().length > 0 && currentText !== lastSyncedText;
      if (!projectChanged && hasUserDraft) {
        return currentText;
      }
      lastSyncedAlignmentProposalTextRef.current = serializedAlignmentProposalText;
      return serializedAlignmentProposalText;
    });
  }, [project.id, serializedAlignmentProposalText]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="thin-scrollbar min-h-0 flex-1 overflow-auto p-3">
        {section === "materials" ? (
          <div className="grid gap-3">
            <MaterialsSummaryPanel
              originalCount={targetOriginalMedia.length}
              referenceCount={bilibiliReferenceMedia.length}
              xmlCount={project.assets.length}
              unboundXmlCount={
                project.assets.filter(
                  (asset) =>
                    !findDanmakuSourceBinding(
                      project.danmakuSourceBindings,
                      asset.id
                    )
                ).length
              }
              reconnectCount={project.mediaLibrary.filter(
                (media) => media.connectionState === "needsReconnect"
              ).length}
              onAddOriginal={() => void openMediaImport("targetOriginal")}
              onAddReference={() => void openMediaImport("bilibiliReference")}
              onAddXml={() => void openXmlImport()}
              onReviewBindings={() =>
                document
                  .querySelector<HTMLSelectElement>("[data-unbound-xml='true']")
                  ?.focus()
              }
              onContinue={() => setWorkspacePage("matching")}
            />
            <MediaRoleGuidePanel
              targetCount={targetOriginalMedia.length}
              referenceCount={bilibiliReferenceMedia.length}
            />
            <MediaLibrarySection
              title="原片素材"
              description="原片素材是弹幕最终要匹配到的标准时间轴，可导入一个或多个完整版或目标集视频。"
              role="targetOriginal"
              mediaItems={targetOriginalMedia}
              onImport={() => void openMediaImport("targetOriginal")}
              onDropFiles={(files) =>
                importMediaFiles(files, "targetOriginal")
              }
              onReconnect={(mediaId) => {
                setReconnectMediaId(mediaId);
                reconnectMediaInputRef.current?.click();
              }}
              onDelete={removeMediaReference}
            />
            <MediaLibrarySection
              title="B 站参考素材"
              description="B 站参考素材用于理解弹幕 XML 的原始时间轴，可以是单集、合集或存在删减的参考视频，但不是最终输出目标。"
              role="bilibiliReference"
              mediaItems={bilibiliReferenceMedia}
              onImport={() => void openMediaImport("bilibiliReference")}
              onDropFiles={(files) =>
                importMediaFiles(files, "bilibiliReference")
              }
              onReconnect={(mediaId) => {
                setReconnectMediaId(mediaId);
                reconnectMediaInputRef.current?.click();
              }}
              onDelete={removeMediaReference}
            />
            <section
              id="xml-materials"
              className={`rounded-lg border p-3 text-xs text-slate-300 transition ${
                xmlDropActive
                  ? "border-accent-cyan bg-accent-cyan/10"
                  : "border-panel-line bg-panel-soft"
              }`}
              data-testid="xml-material-dropzone"
              onDragEnter={(event) => {
                if (event.dataTransfer.types.includes("Files")) {
                  event.preventDefault();
                  event.stopPropagation();
                  setXmlDropActive(true);
                }
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  setXmlDropActive(false);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setXmlDropActive(false);
                void importXmlFiles(event.dataTransfer.files);
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-slate-100">弹幕 XML</h3>
                <TextButton onClick={() => void openXmlImport()}>
                  <ListPlus size={14} />
                  导入 XML
                </TextButton>
              </div>
              <p className="mt-2 leading-5 text-slate-500">
                拖入或多选要转换的弹幕 XML，再为每个文件选择它原本对应的参考视频。
              </p>
              {importProgress !== null ? (
                <div className="mt-2 rounded border border-panel-line bg-black/15 p-2 text-slate-300">
                  正在导入 XML... {Math.round(importProgress * 100)}%
                </div>
              ) : null}
              {project.assets.length === 0 ? (
                <EmptyState
                  title="尚未导入 XML"
                  text="可一次选择多个 Bilibili XML 分 P 文件。"
                />
              ) : (
                <div className="mt-3 grid gap-3">
                  {project.assets.map((asset) => {
                    const range = getAssetTimeRange(asset);
                    const sourceBinding = findDanmakuSourceBinding(
                      project.danmakuSourceBindings,
                      asset.id
                    );
                    return (
                      <article
                        key={asset.id}
                        className="performance-list-item rounded border border-panel-line bg-[#111318] p-3"
                        data-testid="asset-card"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className="h-3 w-3 rounded-sm"
                            style={{ background: asset.color }}
                          />
                          <h4 className="min-w-0 flex-1 truncate text-sm font-medium text-slate-100">
                            {asset.fileName}
                          </h4>
                        </div>
                        <p className="mt-2 text-[11px] text-slate-500">
                          {asset.items.length.toLocaleString("zh-CN")} 条弹幕
                        </p>
                        <span
                          className={`mt-2 inline-flex rounded border px-1.5 py-0.5 text-[10px] ${
                            asset.sourceReceipt
                              ? "border-accent-green/30 bg-accent-green/10 text-accent-green"
                              : "border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow"
                          }`}
                        >
                          {asset.sourceReceipt ? "已受验证" : "仅预览"}
                        </span>
                        {asset.sourceReceipt ? (
                          <p className="mt-3 rounded border border-accent-green/30 bg-accent-green/10 p-2 text-[11px] leading-5 text-accent-green">
                            已由桌面端核验原始 XML 内容，可用于正式受验证导出。
                          </p>
                        ) : (
                          <p className="mt-3 rounded border border-accent-yellow/30 bg-accent-yellow/10 p-2 text-[11px] leading-5 text-accent-yellow">
                            此资源仅作预览，没有原始 XML 内容收据。请在桌面端点击“导入
                            XML”并重新选择原文件；若正式投影引用它，导出会失败关闭。
                          </p>
                        )}
                        <div className="mt-3 grid gap-2 rounded border border-panel-line/70 bg-black/15 p-2 text-xs">
                          <label className="grid gap-1">
                            <span className="text-slate-500">弹幕来源视频</span>
                            <select
                              aria-label={`${asset.fileName} 弹幕来源视频`}
                              data-unbound-xml={sourceBinding ? undefined : "true"}
                              className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
                              value={sourceBinding?.sourceMediaId ?? ""}
                              onChange={(event) => {
                                if (event.target.value.length > 0) {
                                  bindXmlToSourceMedia(asset.id, event.target.value);
                                } else {
                                  clearXmlSourceBinding(asset.id);
                                }
                              }}
                            >
                              <option value="">未绑定</option>
                              {bilibiliReferenceMedia.map((media) => (
                                <option key={media.id} value={media.id}>
                                  {media.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          {sourceBinding ? (
                            <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                              <span className="min-w-0 truncate">
                                已关联：
                                {findProjectMedia(project, sourceBinding.sourceMediaId)
                                  ?.fileName ?? sourceBinding.sourceMediaId}
                              </span>
                              <TextButton onClick={() => clearXmlSourceBinding(asset.id)}>
                                解除绑定
                              </TextButton>
                            </div>
                          ) : (
                            <p className="rounded border border-accent-yellow/30 bg-accent-yellow/10 p-2 text-[11px] leading-5 text-accent-yellow">
                              该 XML 尚未关联弹幕来源视频，仍可编辑但无法进行可靠的来源段匹配。
                            </p>
                          )}
                        </div>
                        <details className="mt-3 rounded border border-panel-line/70 bg-black/10">
                          <summary className="cursor-pointer px-2.5 py-2 text-[11px] text-slate-400 hover:text-slate-200">
                            文件详情
                          </summary>
                          <dl className="grid gap-1 border-t border-panel-line/70 px-2.5 py-2 text-xs text-slate-400">
                            <Row
                              label="弹幕数量"
                              value={asset.items.length.toLocaleString("zh-CN")}
                            />
                            <Row label="最早时间" value={formatTimecode(range.earliestMs)} />
                            <Row label="最晚时间" value={formatTimecode(range.latestMs)} />
                            <Row label="导入警告" value={asset.warnings.length.toString()} />
                            <Row
                              label="原文件验证"
                              value={
                                asset.sourceReceipt
                                  ? "原文件收据有效"
                                  : "正式导出前需重新导入"
                              }
                            />
                          </dl>
                        </details>
                        <div className="mt-3 flex flex-wrap justify-end gap-2">
                          <TextButton
                            tone="danger"
                            title="删除资源及关联片段"
                            onClick={() => removeAsset(asset.id)}
                          >
                            <Trash2 size={14} />
                            删除
                          </TextButton>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
            <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 text-left"
                aria-expanded={legacyMaterialsOpen}
                onClick={() => setLegacyMaterialsOpen((open) => !open)}
              >
                <span>
                  <span className="block text-sm font-medium text-slate-100">
                    高级：单目标绑定与匹配评分（兼容旧项目）
                  </span>
                  <span className="mt-1 block leading-5 text-slate-500">
                    多集工作流请使用上方「原片素材」和「来源段」；此处仅供旧版单目标绑定项目兼容。
                  </span>
                </span>
                <span className="shrink-0 rounded border border-panel-line px-2 py-1 text-[11px] text-slate-300">
                  {legacyMaterialsOpen ? "收起" : "展开"}
                </span>
              </button>
              {legacyMaterialsOpen ? (
                <div className="mt-3 grid gap-3">
                  <TargetMediaBindingPanel
                    binding={project.mediaBinding}
                    media={project.media}
                    mediaLibrary={project.mediaLibrary}
                    validating={targetValidationLoading}
                    onBindLocalPath={() => void bindLocalPathAsTarget()}
                    onValidateEmby={() => void validateEmbyTargetBinding()}
                    onClear={clearMediaBinding}
                  />
                  <ProjectMatchAssessmentPanel
                    assessment={projectMatchAssessment}
                    onPreview={previewProjectMatchProposal}
                  />
                </div>
              ) : null}
            </section>
            <input
              ref={xmlInputRef}
              className="hidden"
              type="file"
              accept=".xml,text/xml,application/xml"
              multiple
              data-testid="xml-input"
              aria-label="导入弹幕 XML 文件"
              onChange={(event) => {
                if (event.target.files) {
                  void importXmlFiles(event.target.files);
                }
                event.target.value = "";
              }}
            />
            <input
              ref={targetMediaInputRef}
              className="hidden"
              type="file"
              accept={VIDEO_FILE_EXTENSIONS.map((extension) => `.${extension}`).join(",")}
              multiple
              aria-label="导入原片素材文件"
              onChange={(event) => {
                if (event.target.files) {
                  importMediaFiles(event.target.files, "targetOriginal");
                }
                event.target.value = "";
              }}
            />
            <input
              ref={sourceMediaInputRef}
              className="hidden"
              type="file"
              accept={VIDEO_FILE_EXTENSIONS.map((extension) => `.${extension}`).join(",")}
              multiple
              aria-label="导入 B 站参考素材文件"
              onChange={(event) => {
                if (event.target.files) {
                  importMediaFiles(event.target.files, "bilibiliReference");
                }
                event.target.value = "";
              }}
            />
            <input
              ref={reconnectMediaInputRef}
              className="hidden"
              type="file"
              accept={VIDEO_FILE_EXTENSIONS.map((extension) => `.${extension}`).join(",")}
              aria-label="重新连接媒体素材文件"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file && reconnectMediaId) {
                  reconnectMediaReference(reconnectMediaId, file);
                }
                setReconnectMediaId(null);
                event.target.value = "";
              }}
            />
          </div>
        ) : null}
        {section === "editing" ? (
          <div className="grid gap-3">
            <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
              <h3 className="text-sm font-medium text-slate-100">下一步</h3>
              <p className="mt-2 leading-5 text-slate-500">
                {project.assets.length === 0
                  ? "还没有弹幕 XML。请先到素材页导入。"
                  : project.clips.length === 0
                    ? "把弹幕素材放到时间轴。多分 P 文件可以直接按顺序排列。"
                    : "现在可以在时间轴预览和微调弹幕；遇到视频版本删减时，用“标记版本差异”。"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {project.assets.length === 0 ? (
                  <TextButton tone="primary" onClick={() => setWorkspacePage("materials")}>
                    <ListPlus size={14} />
                    去素材页导入
                  </TextButton>
                ) : (
                  <TextButton onClick={autoArrangeClips}>
                    <Shuffle size={14} />
                    按顺序放入时间轴
                  </TextButton>
                )}
              </div>
            </section>
            {project.assets.length === 0 ? (
              <EmptyState
                title="尚未导入 XML"
                text="到素材页导入 Bilibili XML 后，这里会显示可编辑的弹幕素材。"
              />
            ) : (
              project.assets.map((asset) => {
                const range = getAssetTimeRange(asset);
                const inTimeline = project.clips.some((clip) => clip.assetId === asset.id);
                return (
                  <article
                    key={asset.id}
                    className="performance-list-item rounded border border-panel-line bg-panel-soft p-3"
                    data-testid="asset-card"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="h-3 w-3 rounded-sm"
                        style={{ background: asset.color }}
                      />
                      <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-slate-100">
                        {asset.fileName}
                      </h3>
                    </div>
                    <dl className="mt-3 grid gap-1 text-xs text-slate-400">
                      <Row
                        label="弹幕数量"
                        value={asset.items.length.toLocaleString("zh-CN")}
                      />
                      <Row label="最早时间" value={formatTimecode(range.earliestMs)} />
                      <Row label="最晚时间" value={formatTimecode(range.latestMs)} />
                      <Row label="状态" value={inTimeline ? "已放入时间轴" : "未放入时间轴"} />
                    </dl>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <TextButton
                        onClick={() => addAssetToTimeline(asset.id)}
                        disabled={inTimeline}
                        tone={inTimeline ? "neutral" : "primary"}
                      >
                        <ListPlus size={14} />
                        放入时间轴
                      </TextButton>
                      {inTimeline ? (
                        <TextButton
                          onClick={() => {
                            const clip = project.clips.find(
                              (candidate) => candidate.assetId === asset.id
                            );
                            if (clip) {
                              select({ kind: "clip", ids: [clip.id] });
                            }
                          }}
                        >
                          <Layers size={14} />
                          选择片段
                        </TextButton>
                      ) : null}
                      {inTimeline ? (
                        <TextButton
                          title="从时间轴移出，保留资源"
                          onClick={() => removeAssetFromTimeline(asset.id)}
                        >
                          <ListX size={14} />
                          移出
                        </TextButton>
                      ) : null}
                    </div>
                  </article>
                );
              })
            )}
            {project.assets.length > 0 ? (
              <>
                <CompensationMarkersPanel
                  markers={project.cutMarkers}
                  selectedIds={selection.kind === "cut" ? selection.ids : []}
                  onFocus={(marker) => {
                    select({ kind: "cut", ids: [marker.id] });
                    setPlayhead(marker.sourceAtMs);
                  }}
                  onUpdate={updateCutMarker}
                  onDelete={deleteCutMarker}
                />
                <SyncAnchorsPanel
                  anchors={project.syncAnchors}
                  onFocus={(anchor) => setPlayhead(anchor.sourceMs)}
                  onUpdate={updateSyncAnchor}
                  onDelete={deleteSyncAnchor}
                />
              </>
            ) : null}
          </div>
        ) : null}
        {section === "matching" ? (
          <div className="grid gap-3">
            <WorkspaceProgressBanner pageId="matching" />
            <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
              <h3 className="text-sm font-medium text-slate-100">匹配：参考视频 → 原片</h3>
              <p className="mt-2 leading-5 text-slate-500">
                这一页回答一个问题：B
                站参考视频的哪一段对应哪个原片。产出是“来源内容段”和段内删减修正；
                导出页会按这些结果把弹幕投影到每个原片。
              </p>
              {project.assets.length === 0 ||
              bilibiliReferenceMedia.length === 0 ||
              targetOriginalMedia.length === 0 ? (
                <div className="mt-3 rounded border border-accent-yellow/30 bg-accent-yellow/10 p-2 leading-5 text-accent-yellow">
                  {project.assets.length === 0
                    ? "还没有弹幕 XML。"
                    : bilibiliReferenceMedia.length === 0
                      ? "还没有 B 站参考素材。"
                      : "还没有原片素材。"}
                  请先到素材页补齐。
                  <div className="mt-2">
                    <TextButton tone="primary" onClick={() => setWorkspacePage("materials")}>
                      去素材页
                    </TextButton>
                  </div>
                </div>
              ) : null}
            </section>
            {project.assets.length > 0 ? (
              <>
                <Suspense
                  fallback={
                    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-500">
                      正在载入智能匹配工作区…
                    </section>
                  }
                >
                  <MediaMatchingPanel
                    project={project}
                    suspectedCutCandidates={suspectedCutCandidates}
                  />
                </Suspense>
                <details className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
                  <summary className="cursor-pointer text-sm font-medium text-slate-100">
                    手动补充或精修来源段
                  </summary>
                  <p className="mt-2 leading-5 text-slate-500">
                    自动候选不足时再使用。所属 XML
                    决定参考素材；未绑定时间图的手工段可调整范围。已确认时间图生成的来源段只允许改输出标签和备注，结构修改必须先撤销确认。
                  </p>
                  <div className="mt-3">
                    <SourceTimelineSegmentsPanel
                      segments={project.danmakuSourceSegments}
                      assets={project.assets}
                      sourceBindings={project.danmakuSourceBindings}
                      sourceMediaOptions={bilibiliReferenceMedia}
                      targetMediaOptions={targetOriginalMedia}
                      plan={batchMergePlan}
                      summary={sourceTimelineSummary}
                      onAdd={addDanmakuSourceSegment}
                      onUpdate={updateDanmakuSourceSegment}
                      onDelete={deleteDanmakuSourceSegment}
                      onFocus={(timeMs) => {
                        setPlayhead(timeMs);
                        setStatus({
                          message: `已定位弹幕来源时间：${formatTimecode(timeMs)}。`,
                          tone: "success"
                        });
                      }}
                    />
                  </div>
                </details>
                <details
                  className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300"
                  data-testid="manual-alignment-diagnostics"
                >
                  <summary className="cursor-pointer text-sm font-medium text-slate-100">
                    手工导入诊断（JSON，只读）
                  </summary>
                  <p className="mt-2 leading-5 text-slate-500">
                    仅用于检查外部或旧项目生成的对齐提案。这里不会选择视频、不会运行自动匹配，也不会把诊断结果直接写入来源段；普通多集工作流请使用上方项目素材批量匹配。
                  </p>
                  <div className="mt-3 grid gap-3">
                    <AlignmentProposalDiagnosticsPanel
                      project={project}
                      text={alignmentProposalText}
                      proposal={alignmentProposal}
                      preview={alignmentPreview}
                      onTextChange={setAlignmentProposalText}
                      onImportText={importAlignmentProposalText}
                      onClear={() => {
                        if (alignmentProposal) {
                          clearAlignmentProposal();
                        } else {
                          setStatus({ message: "已清空对齐提案草稿。", tone: "neutral" });
                        }
                        setAlignmentProposalText("");
                      }}
                    />
                    <SuspectedCutPanel
                      candidates={suspectedCutCandidates}
                      cutMarkers={project.cutMarkers}
                      keywordsText={cutHintSettings.keywordsText}
                      windowSeconds={cutHintSettings.windowSeconds}
                      minHitCount={cutHintSettings.minHitCount}
                      warnings={cutHintSearch.warnings}
                      onKeywordsTextChange={(keywordsText) =>
                        setCutHintSettings({ keywordsText })
                      }
                      onWindowSecondsChange={(windowSeconds) =>
                        setCutHintSettings({ windowSeconds })
                      }
                      onMinHitCountChange={(minHitCount) => setCutHintSettings({ minHitCount })}
                      onApply={(candidate) => {
                        addCutMarker(candidate.sourceAtMs, 45_000, {
                          name: `待确认版本差异 ${formatTimecode(candidate.sourceAtMs)}`,
                          note: `由弹幕文本扫描生成，需人工复核。来源：${candidate.assetFileName}；关键词：${candidate.keywords.join("、")}`
                        });
                      }}
                    />
                    <AnchorCalibrationPanel
                      text={anchorCalibrationText}
                      proposal={anchorCalibrationProposal}
                      onTextChange={setAnchorCalibrationText}
                      onPreview={() => previewAlignmentProposalData(anchorCalibrationProposal)}
                      onApply={() => applyAlignmentProposalData(anchorCalibrationProposal)}
                    />
                  </div>
                </details>
              </>
            ) : (
              <EmptyState
                title="先导入素材"
                text="匹配需要弹幕 XML、B 站参考素材和原片素材。"
              />
            )}
            <details
              className="rounded-lg border border-panel-line bg-panel-soft p-3 text-xs text-slate-300"
              onToggle={(event) =>
                setMatchingTechnicalToolsOpen(event.currentTarget.open)
              }
            >
              <summary className="cursor-pointer text-sm font-medium text-slate-300">
                开发与验收工具
              </summary>
              <p className="mt-2 leading-5 text-slate-500">
                C137 精度基准、原生性能证据和诊断只面向开发验收，不是普通匹配流程的一部分。
              </p>
              {matchingTechnicalToolsOpen ? (
                <div className="mt-3">
                  <Suspense
                    fallback={
                      <section className="rounded border border-panel-line bg-black/10 p-3 text-xs text-slate-500">
                        正在载入高级精度基准工具…
                      </section>
                    }
                  >
                    <RealMediaBenchmarkPanel project={project} />
                  </Suspense>
                </div>
              ) : null}
            </details>
          </div>
        ) : null}
        {section === "export" ? (
          <div className="grid gap-3 text-xs text-slate-400">
            <ExportReadinessPanel
              projectName={project.name}
              reportSummary={projectHealth}
              readiness={projectReadiness}
              onCleanupEditReferences={cleanupProjectEditReferences}
              onCleanupMissingAssetClips={cleanupProjectMissingAssetClips}
            />
            <ProjectionExportPanel
              projection={sourceProjection}
              project={project}
              onGoMatching={() => setWorkspacePage("matching")}
            />
            <details className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
              <summary className="cursor-pointer text-sm font-medium text-slate-200">
                兼容导出方式（单集或旧项目）
              </summary>
              <div className="mt-2">
                <p className="leading-5 text-slate-500">
                以下为单文件或传统分 P
                合并导出，不依赖来源段投影。多集场景请优先使用上方「按原片分集导出」。
                </p>
                {projectionOnlyExport ? (
                  <p className="mt-2 rounded border border-accent-red/30 bg-accent-red/10 p-2 leading-5 text-accent-red">
                    当前项目已包含目标原片或时间映射。为避免导出错位
                    XML，只可使用上方「按原片分集导出」。
                  </p>
                ) : null}
              </div>
            <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
              <h3 className="text-sm font-medium text-slate-100">
                导出当前编辑时间轴（单文件）
              </h3>
              <p className="mt-2 leading-5 text-slate-500">
                把编辑页时间轴上的全部弹幕（含全局偏移、版本差异、单条调整）合并导出为一个
                XML。适合单集修正场景。
              </p>
              <div className="mt-3">
                <TextButton
                  tone="primary"
                  onClick={prepareExport}
                  disabled={projectionOnlyExport || project.clips.length === 0}
                  title={
                    projectionOnlyExport
                      ? "当前项目必须通过已确认时间图按原片分集导出。"
                      : project.clips.length === 0
                        ? "编辑页时间轴上还没有弹幕片段。"
                        : "预览并导出单个 XML"
                  }
                >
                  <Download size={14} />
                  预览并导出单个 XML
                </TextButton>
              </div>
            </section>
            <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 text-left"
                aria-expanded={legacyExportOpen}
                disabled={projectionOnlyExport}
                onClick={() => {
                  if (!projectionOnlyExport) {
                    setLegacyExportOpen((open) => !open);
                  }
                }}
              >
                <span>
                  <span className="block text-sm font-medium text-slate-100">
                    按文件名分 P 合并导出（传统方式）
                  </span>
                  <span className="mt-1 block leading-5 text-slate-500">
                    不依赖来源段，按 XML 文件名识别集数并切分合并。适合命名规范的分 P 弹幕。
                  </span>
                </span>
                <span className="shrink-0 rounded border border-panel-line px-2 py-1 text-[11px] text-slate-300">
                  {legacyExportOpen ? "收起" : "展开"}
                </span>
              </button>
              {legacyExportOpen && !projectionOnlyExport ? (
                <div className="mt-3 grid gap-3">
                  {project.assets.length > 0 ? (
                    <>
                      <EmbyMetadataPanel
                        onImportDurationLines={(lines) => {
                          setEpisodeDurationsText(lines);
                          setLongSplitMode("durations");
                          setStatus({
                            message: "已把 Emby 剧集时长导入批量整理规则。",
                            tone: "success"
                          });
                        }}
                      />
                      <ManualRulePanel
                        partWindowMode={partWindowMode}
                        partWindowMinutes={partWindowMinutes}
                        partRangeStartMinutes={partRangeStartMinutes}
                        partRangeEndMinutes={partRangeEndMinutes}
                        longSplitMode={longSplitMode}
                        episodeDurationsText={episodeDurationsText}
                        cutPointsText={cutPointsText}
                        warnings={manualRules.warnings}
                        onPartWindowModeChange={setPartWindowMode}
                        onPartWindowMinutesChange={setPartWindowMinutes}
                        onPartRangeStartMinutesChange={setPartRangeStartMinutes}
                        onPartRangeEndMinutesChange={setPartRangeEndMinutes}
                        onLongSplitModeChange={setLongSplitMode}
                        onEpisodeDurationsTextChange={setEpisodeDurationsText}
                        onCutPointsTextChange={setCutPointsText}
                      />
                      <SeasonWorkbenchPanel summary={seasonWorkbench} />
                      <SeasonEpisodeBindingPanel
                        plan={batchMergePlan}
                        bindings={project.seasonEpisodeBindings}
                        currentBinding={project.mediaBinding}
                        onBindCurrent={(episodeKey, episodeLabel) =>
                          bindCurrentTargetToSeasonEpisode(episodeKey, episodeLabel)
                        }
                        onClear={clearSeasonEpisodeBinding}
                        onOpenMediaTab={() => setWorkspacePage("materials")}
                      />
                      <BatchMergeSummary
                        plan={batchMergePlan}
                        warnings={manualRules.warnings}
                      />
                      <div className="flex justify-end">
                        <TextButton
                          tone="primary"
                          onClick={() => void exportBatchMergePlan(batchMergePlan, project)}
                          disabled={batchMergePlan.episodes.length === 0}
                          title="按当前批量规则导出多个分集 XML"
                        >
                          <Download size={14} />
                          导出分集 XML
                        </TextButton>
                      </div>
                    </>
                  ) : (
                    <EmptyState title="先导入 XML" text="分 P 合并导出基于已导入的弹幕素材。" />
                  )}
                </div>
              ) : null}
            </section>
            <div className="rounded border border-panel-line bg-panel-soft p-3">
              <h3 className="mb-2 text-sm font-medium text-slate-100">{project.name}</h3>
              <Row label="资源数" value={project.assets.length.toString()} />
              <Row label="片段数" value={project.clips.length.toString()} />
              <Row label="版本差异" value={project.cutMarkers.length.toString()} />
              <Row label="同步线索" value={project.syncAnchors.length.toString()} />
              <Row label="禁用弹幕" value={project.disabledItemIds.length.toString()} />
              <Row label="目标原片" value={formatMediaBindingTitle(project.mediaBinding)} />
              <Row label="全局偏移" value={`${project.globalOffsetMs} ms`} />
              <Row
                label="创建时间"
                value={new Date(project.createdAt).toLocaleString("zh-CN")}
              />
              <Row
                label="更新时间"
                value={new Date(project.updatedAt).toLocaleString("zh-CN")}
              />
            </div>
            </details>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TargetMediaBindingPanel({
  binding,
  media,
  mediaLibrary,
  validating,
  onBindLocalPath,
  onValidateEmby,
  onClear
}: {
  binding: MediaBinding | null;
  media: MediaReference | null;
  mediaLibrary: ProjectMediaReference[];
  validating: boolean;
  onBindLocalPath: () => void;
  onValidateEmby: () => void;
  onClear: () => void;
}) {
  const bindingMedia =
    binding?.kind === "localFile" && binding.mediaId
      ? mediaLibrary.find((candidate) => candidate.id === binding.mediaId)
      : null;
  const localBindingConnected =
    binding?.kind === "localFile" &&
    (Boolean(binding.localPath) ||
      Boolean(bindingMedia?.objectUrl) ||
      (Boolean(media?.objectUrl) &&
        (binding.mediaId
          ? media?.id === binding.mediaId
          : media?.fileName === binding.fileName)));
  const statusText = !binding
    ? "未绑定"
    : binding.kind === "localFile"
      ? localBindingConnected
        ? "本地文件已连接"
        : "需要重新选择本地视频"
      : "Emby 条目已保存";
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
      <div className="flex items-center gap-2">
        <Crosshair size={16} className="text-accent-cyan" />
        <h3 className="text-sm font-medium text-slate-100">目标原片（完整版）</h3>
        <span className="ml-auto rounded border border-panel-line bg-black/20 px-2 py-0.5 text-[11px] text-slate-500">
          {statusText}
        </span>
      </div>
      <p className="mt-2 leading-5 text-slate-500">
        {binding
          ? "后续匹配评分、对齐和导出检查会以这里保存的完整版作为目标来源。"
          : "绑定本地完整版或 Emby 条目后，项目会记住弹幕最终要对齐到哪一部、哪一集。"}
      </p>
      {binding ? (
        <dl className="mt-3 grid gap-2">
          <Row label="名称" value={formatMediaBindingTitle(binding)} />
          <Row label="来源" value={formatMediaBindingSource(binding)} />
          <Row label="位置" value={formatMediaBindingEpisode(binding)} />
          <Row
            label="时长"
            value={binding.runtimeMs === null ? "未知" : formatTimecode(binding.runtimeMs)}
          />
          {binding.kind === "localFile" ? (
            <Row
              label="本地路径"
              value={binding.localPath ? binding.localPath : "未保存路径"}
            />
          ) : null}
          {binding.kind === "embyItem" ? (
            <>
              <Row label="条目 ID" value={binding.itemId} />
              <Row
                label="媒体源"
                value={
                  binding.mediaSources[0]
                    ? formatMediaSourceSummary(binding.mediaSources[0])
                    : "暂未读取"
                }
              />
            </>
          ) : null}
        </dl>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <TextButton onClick={onBindLocalPath}>
          <FolderOpen size={14} />
          选择本地路径
        </TextButton>
        {binding?.kind === "embyItem" ? (
          <TextButton onClick={onValidateEmby} disabled={validating}>
            <Search size={14} />
            {validating ? "验证中" : "验证 Emby"}
          </TextButton>
        ) : null}
        {binding ? (
          <TextButton tone="danger" onClick={onClear}>
            <Trash2 size={14} />
            解除绑定
          </TextButton>
        ) : null}
      </div>
    </section>
  );
}

function MediaLibrarySection({
  title,
  description,
  role,
  mediaItems,
  onImport,
  onDropFiles,
  onReconnect,
  onDelete
}: {
  title: string;
  description: string;
  role: ProjectMediaRole;
  mediaItems: ProjectMediaReference[];
  onImport: () => void;
  onDropFiles: (files: FileList) => void;
  onReconnect: (mediaId: string) => void;
  onDelete: (mediaId: string) => void;
}) {
  const [dropActive, setDropActive] = useState(false);
  return (
    <section
      className={`rounded-lg border p-3 text-xs text-slate-300 transition ${
        dropActive
          ? "border-accent-cyan bg-accent-cyan/10"
          : "border-panel-line bg-panel-soft"
      }`}
      data-testid={`${role}-dropzone`}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.stopPropagation();
          setDropActive(true);
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setDropActive(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDropActive(false);
        onDropFiles(event.dataTransfer.files);
      }}
    >
      <div className="flex items-center gap-2">
        <Video
          size={16}
          className={role === "targetOriginal" ? "text-accent-green" : "text-accent-cyan"}
        />
        <h3 className="text-sm font-medium text-slate-100">{title}</h3>
        <span className="ml-auto rounded border border-panel-line bg-black/20 px-2 py-0.5 text-[11px] text-slate-500">
          {mediaItems.length} 个
        </span>
      </div>
      <p className="mt-2 leading-5 text-slate-500">{description}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <TextButton onClick={onImport}>
          <FolderOpen size={14} />
          {role === "targetOriginal" ? "批量导入原片素材" : "批量导入 B 站参考素材"}
        </TextButton>
      </div>
      {mediaItems.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {mediaItems.map((media) => (
            <article
              key={media.id}
              className="rounded border border-panel-line/80 bg-[#111318] p-2"
            >
              <div className="flex items-center gap-2">
                <span
                  className="min-w-0 flex-1 truncate text-sm text-slate-100"
                  title={media.name}
                >
                  {media.fileName}
                </span>
                <span className="sr-only">{media.name}</span>
                <span className="shrink-0 rounded border border-panel-line bg-black/25 px-1.5 py-0.5 text-[11px] text-slate-400">
                  {formatMediaConnectionState(media)}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                {media.durationMs === null
                  ? "时长将在分析时读取"
                  : formatTimecode(media.durationMs)}
              </p>
              {media.connectionState === "needsReconnect" ? (
                <p className="mt-2 rounded border border-accent-yellow/30 bg-accent-yellow/10 p-2 text-[11px] leading-5 text-accent-yellow">
                  此素材使用的是临时浏览器引用，重新打开项目后需要重新选择原文件。项目中的绑定和时间段信息仍然保留。
                  自动匹配需要桌面端持久本地路径；请删除此临时引用后，使用本区的批量导入按钮重新加入。
                </p>
              ) : null}
              <details className="mt-2 rounded border border-panel-line/70 bg-black/10">
                <summary className="cursor-pointer px-2 py-1.5 text-[11px] text-slate-400 hover:text-slate-200">
                  文件详情
                </summary>
                <dl className="grid gap-1 border-t border-panel-line/70 px-2 py-2 text-slate-400">
                  <Row label="角色" value={formatMediaRole(media.role)} />
                  <Row
                    label="时长"
                    value={
                      media.durationMs === null
                        ? "时长未知"
                        : formatTimecode(media.durationMs)
                    }
                  />
                  <Row label="来源" value={media.sourceSummary} />
                  <Row label="引用" value={formatProjectMediaReferenceKind(media)} />
                </dl>
              </details>
              <div className="mt-2 flex flex-wrap justify-end gap-2">
                {media.connectionState === "needsReconnect" ||
                media.referenceKind === "browserFile" ? (
                  <TextButton onClick={() => onReconnect(media.id)}>
                    <FolderOpen size={14} />
                    重新连接
                  </TextButton>
                ) : null}
                <TextButton tone="danger" onClick={() => onDelete(media.id)}>
                  <Trash2 size={14} />
                  删除
                </TextButton>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title={role === "targetOriginal" ? "尚未导入原片素材" : "尚未导入 B 站参考素材"}
          text={
            role === "targetOriginal"
              ? "可连续导入多个完整版或目标集视频。"
              : "可连续导入多个 B 站单集、合集或删减版参考视频。"
          }
        />
      )}
    </section>
  );
}

function MaterialsSummaryPanel({
  originalCount,
  referenceCount,
  xmlCount,
  unboundXmlCount,
  reconnectCount,
  onAddOriginal,
  onAddReference,
  onAddXml,
  onReviewBindings,
  onContinue
}: {
  originalCount: number;
  referenceCount: number;
  xmlCount: number;
  unboundXmlCount: number;
  reconnectCount: number;
  onAddOriginal: () => void;
  onAddReference: () => void;
  onAddXml: () => void;
  onReviewBindings: () => void;
  onContinue: () => void;
}) {
  const nextAction =
    originalCount === 0
      ? {
          label: "添加原片",
          detail: "先选择最终要观看的完整视频。",
          run: onAddOriginal
        }
      : referenceCount === 0
        ? {
            label: "添加参考视频",
            detail: "参考视频用于确定弹幕原本的时间位置。",
            run: onAddReference
          }
        : xmlCount === 0
          ? {
              label: "添加弹幕 XML",
              detail: "可一次选择一集或多集 XML。",
              run: onAddXml
            }
          : unboundXmlCount > 0
            ? {
                label: `确认 ${unboundXmlCount} 个弹幕来源`,
                detail: "告诉应用每个 XML 原本对应哪个参考视频。",
                run: onReviewBindings
              }
            : {
                label: "进入智能匹配",
                detail: "素材已经齐全，可以开始分析时间关系。",
                run: onContinue
              };
  const ready =
    originalCount > 0 &&
    referenceCount > 0 &&
    xmlCount > 0 &&
    unboundXmlCount === 0 &&
    reconnectCount === 0;

  return (
    <section
      className="rounded-xl border border-panel-line bg-[#151920] p-4"
      aria-label="素材准备摘要"
      data-testid="materials-summary"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            {ready ? (
              <CircleCheck size={18} className="text-accent-green" />
            ) : (
              <Layers size={18} className="text-accent-cyan" />
            )}
            <h2 className="text-base font-semibold text-slate-100">
              {ready ? "素材已经准备好" : "准备项目素材"}
            </h2>
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            {nextAction.detail}
          </p>
        </div>
        <TextButton tone="primary" onClick={nextAction.run}>
          {nextAction.label}
          <ArrowRight size={14} />
        </TextButton>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <MaterialCount label="原片" count={originalCount} ready={originalCount > 0} />
        <MaterialCount
          label="参考视频"
          count={referenceCount}
          ready={referenceCount > 0}
        />
        <MaterialCount label="弹幕 XML" count={xmlCount} ready={xmlCount > 0} />
      </div>
      {unboundXmlCount > 0 || reconnectCount > 0 ? (
        <div className="mt-3 grid gap-1.5 text-[11px]">
          {unboundXmlCount > 0 ? (
            <p className="flex items-center gap-2 text-accent-yellow">
              <CircleAlert size={13} />
              {unboundXmlCount} 个 XML 还没有选择参考视频
            </p>
          ) : null}
          {reconnectCount > 0 ? (
            <p className="flex items-center gap-2 text-accent-yellow">
              <CircleAlert size={13} />
              {reconnectCount} 个视频需要重新连接本地文件
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function MaterialCount({
  label,
  count,
  ready
}: {
  label: string;
  count: number;
  ready: boolean;
}) {
  return (
    <div className="rounded-lg border border-panel-line/70 bg-black/15 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-500">{label}</span>
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            ready ? "bg-accent-green" : "bg-slate-600"
          }`}
          aria-hidden="true"
        />
      </div>
      <div className="mt-1 text-sm font-semibold text-slate-200">{count}</div>
    </div>
  );
}

function MediaRoleGuidePanel({
  targetCount,
  referenceCount
}: {
  targetCount: number;
  referenceCount: number;
}) {
  return (
    <details className="rounded-lg border border-panel-line bg-panel-soft text-xs text-slate-300">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-slate-400 hover:text-slate-200">
        <Video size={15} className="text-accent-cyan" />
        <span className="font-medium">了解三类素材的关系</span>
        <span className="ml-auto text-[10px] text-slate-600">说明</span>
      </summary>
      <div className="border-t border-panel-line px-3 py-3">
        <h3 className="text-sm font-medium text-slate-100">视频来源</h3>
        <p className="mt-2 leading-5 text-slate-500">
          按四页动线工作：先在素材页导入并绑定，再在匹配页标出来源段，最后在导出页按原片分集导出。视频不嵌入项目文件。
        </p>
        <dl className="mt-3 grid gap-2">
          <Row label="原片素材" value={`${targetCount} 个`} />
          <Row label="B 站参考" value={`${referenceCount} 个`} />
          <Row label="关系" value="XML → 参考视频 → 来源段 → 原片" />
        </dl>
      </div>
    </details>
  );
}

function ProjectMatchAssessmentPanel({
  assessment,
  onPreview
}: {
  assessment: ProjectMatchAssessment;
  onPreview: () => void;
}) {
  const canPreview = Boolean(assessment.proposal);
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
      <div className="flex items-center gap-2">
        <WandSparkles size={16} className="text-accent-cyan" />
        <h3 className="text-sm font-medium text-slate-100">匹配评分</h3>
        <span
          className={`ml-auto rounded border px-2 py-0.5 text-[11px] ${projectMatchBadgeClass(assessment.conclusion)}`}
        >
          {assessment.conclusionLabel}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-[64px_minmax(0,1fr)] gap-3">
        <div
          className={`flex h-14 items-center justify-center rounded border text-lg font-semibold ${projectMatchScoreClass(assessment.conclusion)}`}
        >
          {formatProjectMatchScore(assessment.score)}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium leading-5 text-slate-100">{assessment.headline}</p>
          <p className="mt-1 leading-5 text-slate-500">{assessment.detail}</p>
        </div>
      </div>
      <dl className="mt-3 grid gap-2">
        <Row label="目标" value={assessment.targetTitle} />
        <Row label="XML" value={formatMatchSourceSummary(assessment)} />
      </dl>
      <div className="mt-3 grid gap-2">
        {assessment.criteria.map((criterion) => (
          <div
            key={criterion.id}
            className="rounded border border-panel-line/70 bg-black/15 p-2"
          >
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
              <span className={`text-[11px] ${projectMatchCriterionClass(criterion.state)}`}>
                {projectMatchCriterionStateText(criterion.state)}
              </span>
              <span className="min-w-0">
                <span className="text-slate-100">{criterion.label}</span>
                <span className="text-slate-500"> / {criterion.summary}</span>
              </span>
            </div>
            <p className="mt-1 leading-5 text-slate-500">{criterion.detail}</p>
            {criterion.evidence.length > 0 ? (
              <p
                className="mt-1 truncate text-[11px] text-slate-400"
                title={criterion.evidence.join("；")}
              >
                {criterion.evidence.join("；")}
              </p>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <TextButton
          onClick={onPreview}
          disabled={!canPreview}
          title={
            canPreview
              ? "把评分诊断和候选同步线索送入时间轴预览"
              : "绑定目标原片并导入 XML 后可生成提案"
          }
        >
          <Crosshair size={14} />
          预览评分提案
        </TextButton>
      </div>
    </section>
  );
}

const EMBY_INPUT_CLASS =
  "h-8 min-w-0 w-full rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100";

function EmbyMetadataPanel({
  onImportDurationLines
}: {
  onImportDurationLines: (lines: string) => void;
}) {
  const [itemId, setItemId] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [sessionState, setSessionState] = useState<EmbySessionState | null>(null);
  const [loadedItem, setLoadedItem] = useState<EmbyItemMetadata | null>(null);
  const [episodeItems, setEpisodeItems] = useState<EmbyItemMetadata[]>([]);
  const [searchResults, setSearchResults] = useState<EmbyItemMetadata[]>([]);
  const [durationLines, setDurationLines] = useState("");
  const [loading, setLoading] = useState<EmbyLoadingKind | null>(null);
  const setMediaBinding = useEditorStore((state) => state.setMediaBinding);
  const selectedItemId = itemId.trim();
  const hasSelectedItem = selectedItemId.length > 0;

  async function runAction<T>(
    kind: EmbyLoadingKind,
    action: () => Promise<T>
  ): Promise<T | null> {
    setLoading(kind);
    try {
      return await action();
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "Emby 请求失败。",
        tone: "error"
      });
      return null;
    } finally {
      setLoading(null);
    }
  }

  const ensureSession = async () => {
    const connection = loadEmbyConnectionState();
    if (!validateEmbyConnectionState(connection)) {
      return null;
    }
    if (sessionState?.key === connection.sessionKey) {
      return { connection, session: sessionState.session };
    }
    const nextSession = await runAction("auth", () =>
      authenticateEmby(connection.config, {
        username: connection.username,
        password: connection.password
      })
    );
    if (nextSession) {
      setSessionState({ key: connection.sessionKey, session: nextSession });
      setSearchResults([]);
      setStatus({
        message: `Emby 已登录：${nextSession.userName || nextSession.userId}`,
        tone: "success"
      });
      return { connection, session: nextSession };
    }
    return null;
  };

  const searchItems = async () => {
    if (searchTerm.trim().length === 0) {
      setStatus({ message: "请填写要搜索的片名、剧名或季集信息。", tone: "warning" });
      return;
    }
    const ready = await ensureSession();
    if (!ready) {
      return;
    }
    const items = await runAction("search", () =>
      searchEmbyItems(ready.connection.config, ready.session, { searchTerm, limit: 12 })
    );
    if (items) {
      setSearchResults(items);
      setStatus({
        message:
          items.length > 0
            ? `已找到 ${items.length} 个 Emby 候选条目。`
            : "没有找到匹配的 Emby 条目。",
        tone: items.length > 0 ? "success" : "warning"
      });
    }
  };

  const selectSearchResult = (item: EmbyItemMetadata) => {
    setItemId(item.id);
    setLoadedItem(item);
    setEpisodeItems([]);
    setDurationLines("");
    setStatus({ message: `已选择 Emby 条目：${item.name}`, tone: "success" });
  };

  const importLoadedItemDuration = () => {
    if (!loadedItem || loadedItem.durationMs === null) {
      setStatus({ message: "当前条目没有可导入的时长。", tone: "warning" });
      return;
    }
    const line = formatEmbySingleDurationLine(loadedItem);
    setDurationLines(line);
    onImportDurationLines(line);
    setStatus({ message: "已把单条 Emby 时长导入人工整理规则。", tone: "success" });
  };

  const bindLoadedItemAsTarget = () => {
    if (!loadedItem) {
      setStatus({ message: "请先选择或读取一个 Emby 条目。", tone: "warning" });
      return;
    }
    const connection = loadEmbyConnectionState();
    if (!validateEmbyConnectionState(connection)) {
      return;
    }
    setMediaBinding(createEmbyBindingFromItem(loadedItem, connection));
  };

  const readItem = async () => {
    if (!hasSelectedItem) {
      setStatus({ message: "请先从搜索结果中选择一个 Emby 条目。", tone: "warning" });
      return;
    }
    const ready = await ensureSession();
    if (!ready) {
      return;
    }
    const item = await runAction("item", () =>
      fetchEmbyItem(ready.connection.config, ready.session, selectedItemId)
    );
    if (item) {
      setLoadedItem(item);
      setStatus({ message: `已读取 Emby 条目：${item.name}`, tone: "success" });
    }
  };

  const readEpisodes = async () => {
    if (!hasSelectedItem) {
      setStatus({ message: "请先从搜索结果中选择剧集、季或合集。", tone: "warning" });
      return;
    }
    const ready = await ensureSession();
    if (!ready) {
      return;
    }
    const items = await runAction("episodes", () =>
      fetchEmbyEpisodeChildren(ready.connection.config, ready.session, selectedItemId)
    );
    if (items) {
      const lines = formatEmbyEpisodeDurationLines(items);
      setEpisodeItems(items);
      setDurationLines(lines);
      setStatus({
        message:
          lines.length > 0
            ? `已读取 ${items.length} 个 Emby 剧集条目。`
            : "未读到带时长的 Emby 剧集。",
        tone: lines.length > 0 ? "success" : "warning"
      });
    }
  };

  return (
    <section className="min-w-0 overflow-hidden rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-medium text-slate-100">Emby 时长</h3>
        <span className="shrink-0 rounded border border-panel-line bg-black/20 px-2 py-0.5 text-[11px] text-slate-500">
          设置中心
        </span>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-slate-500">
        连接、路径和账号在设置中心维护；这里仅搜索并导入真实时长。
      </p>
      <div className="mt-3 grid min-w-0 gap-2">
        <label className="grid min-w-0 gap-1">
          <span className="text-slate-500">搜索</span>
          <input
            className={EMBY_INPUT_CLASS}
            value={searchTerm}
            placeholder="片名 / 剧名 / S01E02 / 第1季第2集"
            onChange={(event) => setSearchTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void searchItems();
              }
            }}
          />
        </label>
        <div className="grid min-w-0 gap-2">
          <TextButton
            tone="primary"
            className="w-full min-w-0 px-2"
            onClick={() => void searchItems()}
            disabled={loading !== null}
          >
            <Search size={14} />
            <span className="truncate">
              {loading === "auth" ? "连接中" : loading === "search" ? "搜索中" : "搜索"}
            </span>
          </TextButton>
        </div>
        {searchResults.length > 0 ? (
          <div className="grid min-w-0 gap-1 rounded border border-panel-line bg-black/20 p-2">
            <div className="text-slate-500">搜索结果</div>
            {searchResults.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`grid min-w-0 gap-0.5 rounded px-2 py-1 text-left transition hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-cyan ${
                  item.id === itemId ? "bg-accent-cyan/15 text-accent-cyan" : "text-slate-300"
                }`}
                onClick={() => selectSearchResult(item)}
              >
                <span className="truncate">{item.name}</span>
                <span className="truncate text-[11px] text-slate-500">
                  {formatEmbySearchResultMeta(item)}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {loadedItem ? (
          <div className="min-w-0 rounded border border-panel-line bg-black/20 p-2">
            <Row label="条目" value={loadedItem.name} />
            <Row label="类型" value={loadedItem.type} />
            {loadedItem.seriesName ? <Row label="剧名" value={loadedItem.seriesName} /> : null}
            <Row
              label="时长"
              value={
                loadedItem.durationMs === null ? "未知" : formatTimecode(loadedItem.durationMs)
              }
            />
            <Row
              label="媒体源"
              value={
                loadedItem.mediaSources[0]
                  ? formatMediaSourceSummary(loadedItem.mediaSources[0])
                  : "暂未读取"
              }
            />
            <div className="mt-2 grid min-w-0 gap-2">
              <TextButton
                className="w-full min-w-0 px-2"
                onClick={() => void readItem()}
                disabled={loading !== null || !hasSelectedItem}
              >
                <span className="truncate">{loading === "item" ? "读取中" : "读取条目"}</span>
              </TextButton>
              <TextButton
                className="w-full min-w-0 px-2"
                onClick={() => void readEpisodes()}
                disabled={loading !== null || !hasSelectedItem}
              >
                <span className="truncate">
                  {loading === "episodes" ? "读取中" : "读取下级剧集"}
                </span>
              </TextButton>
              {loadedItem.durationMs !== null ? (
                <TextButton className="w-full min-w-0 px-2" onClick={importLoadedItemDuration}>
                  <span className="truncate">导入单条时长</span>
                </TextButton>
              ) : null}
              <TextButton
                tone="primary"
                className="w-full min-w-0 px-2"
                onClick={bindLoadedItemAsTarget}
              >
                <span className="truncate">绑定为目标原片</span>
              </TextButton>
            </div>
          </div>
        ) : null}
        {durationLines.length > 0 ? (
          <div className="grid min-w-0 gap-2">
            <textarea
              className="min-h-24 min-w-0 resize-y rounded border border-panel-line bg-[#111318] p-2 font-mono text-xs leading-5 text-slate-100"
              value={durationLines}
              readOnly
            />
            <div className="grid min-w-0 gap-2">
              <span className="min-w-0 truncate text-slate-500">
                {episodeItems.length} 个条目
              </span>
              <TextButton
                tone="primary"
                className="w-full min-w-0 px-2"
                onClick={() => onImportDurationLines(durationLines)}
              >
                <span className="truncate">导入时长规则</span>
              </TextButton>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function loadEmbyConnectionState(): EmbyConnectionState {
  const settings = loadAppSettings();
  const password = loadVolatileEmbyPassword();
  const serverUrl = settings.emby.serverUrl.trim();
  const pathPrefix = settings.emby.pathPrefix.trim();
  const username = settings.emby.username.trim();
  return {
    config: { serverUrl, pathPrefix },
    username,
    password,
    sessionKey: [serverUrl, pathPrefix, username, password].join("\n")
  };
}

function createEmbyBindingFromItem(
  item: EmbyItemMetadata,
  connection: EmbyConnectionState
): MediaBinding {
  return createEmbyItemMediaBinding(createId("media_binding"), item, {
    serverUrl: connection.config.serverUrl,
    pathPrefix: connection.config.pathPrefix,
    username: connection.username
  });
}

function validateEmbyConnectionState(connection: EmbyConnectionState): boolean {
  if (connection.config.serverUrl.length === 0) {
    setStatus({ message: "请先在设置中心填写 Emby 服务器地址。", tone: "warning" });
    return false;
  }
  if (connection.username.length === 0) {
    setStatus({ message: "请先在设置中心填写 Emby 用户名。", tone: "warning" });
    return false;
  }
  if (connection.password.length === 0) {
    setStatus({
      message: "请先在设置中心填写本次会话密码。密码不会写入本地设置。",
      tone: "warning"
    });
    return false;
  }
  return true;
}

function formatEmbySearchResultMeta(item: EmbyItemMetadata): string {
  const parts = [formatEmbyItemType(item.type)];
  if (item.seasonNumber !== null) {
    parts.push(`第 ${item.seasonNumber} 季`);
  }
  if (item.episodeNumber !== null) {
    parts.push(`第 ${item.episodeNumber} 集`);
  }
  if (item.durationMs !== null) {
    parts.push(formatTimecode(item.durationMs));
  }
  return parts.join(" / ");
}

function formatEmbyItemType(type: string): string {
  if (type === "Movie") {
    return "电影";
  }
  if (type === "Series") {
    return "剧集";
  }
  if (type === "Season") {
    return "季";
  }
  if (type === "Episode") {
    return "单集";
  }
  return type;
}

function ManualRulePanel({
  partWindowMode,
  partWindowMinutes,
  partRangeStartMinutes,
  partRangeEndMinutes,
  longSplitMode,
  episodeDurationsText,
  cutPointsText,
  warnings,
  onPartWindowModeChange,
  onPartWindowMinutesChange,
  onPartRangeStartMinutesChange,
  onPartRangeEndMinutesChange,
  onLongSplitModeChange,
  onEpisodeDurationsTextChange,
  onCutPointsTextChange
}: {
  partWindowMode: PartWindowMode;
  partWindowMinutes: string;
  partRangeStartMinutes: string;
  partRangeEndMinutes: string;
  longSplitMode: LongSplitMode;
  episodeDurationsText: string;
  cutPointsText: string;
  warnings: string[];
  onPartWindowModeChange: (mode: PartWindowMode) => void;
  onPartWindowMinutesChange: (value: string) => void;
  onPartRangeStartMinutesChange: (value: string) => void;
  onPartRangeEndMinutesChange: (value: string) => void;
  onLongSplitModeChange: (mode: LongSplitMode) => void;
  onEpisodeDurationsTextChange: (value: string) => void;
  onCutPointsTextChange: (value: string) => void;
}) {
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
      <h3 className="text-sm font-medium text-slate-100">人工整理规则</h3>
      <div className="mt-3 grid gap-3">
        <label className="grid gap-1">
          <span className="text-slate-500">每个分 P</span>
          <select
            className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
            value={partWindowMode}
            onChange={(event) => onPartWindowModeChange(event.target.value as PartWindowMode)}
          >
            <option value="full">完整保留</option>
            <option value="prefix">只取前 N 分钟</option>
            <option value="suffix">只取后 N 分钟</option>
            <option value="range">统一起止分钟</option>
          </select>
        </label>
        {partWindowMode === "prefix" || partWindowMode === "suffix" ? (
          <label className="grid gap-1">
            <span className="text-slate-500">N 分钟</span>
            <input
              className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              value={partWindowMinutes}
              inputMode="decimal"
              onChange={(event) => onPartWindowMinutesChange(event.target.value)}
            />
          </label>
        ) : null}
        {partWindowMode === "range" ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1">
              <span className="text-slate-500">开始分钟</span>
              <input
                className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
                value={partRangeStartMinutes}
                inputMode="decimal"
                onChange={(event) => onPartRangeStartMinutesChange(event.target.value)}
              />
            </label>
            <label className="grid gap-1">
              <span className="text-slate-500">结束分钟</span>
              <input
                className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
                value={partRangeEndMinutes}
                inputMode="decimal"
                onChange={(event) => onPartRangeEndMinutesChange(event.target.value)}
              />
            </label>
          </div>
        ) : null}
        <label className="grid gap-1">
          <span className="text-slate-500">长合集切分</span>
          <select
            className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
            value={longSplitMode}
            onChange={(event) => onLongSplitModeChange(event.target.value as LongSplitMode)}
          >
            <option value="auto">按文件名自动切分</option>
            <option value="durations">按真实集时长</option>
            <option value="cuts">按人工切点</option>
          </select>
        </label>
        {longSplitMode === "durations" ? (
          <textarea
            className="min-h-20 resize-y rounded border border-panel-line bg-[#111318] p-2 text-xs leading-5 text-slate-100"
            value={episodeDurationsText}
            placeholder={"每行一个时长，例如：\nS01E01 51:20\nS01E02 50:45"}
            onChange={(event) => onEpisodeDurationsTextChange(event.target.value)}
          />
        ) : null}
        {longSplitMode === "cuts" ? (
          <textarea
            className="min-h-16 resize-y rounded border border-panel-line bg-[#111318] p-2 text-xs leading-5 text-slate-100"
            value={cutPointsText}
            placeholder="切点用逗号或换行分隔，例如：51:20, 1:42:05"
            onChange={(event) => onCutPointsTextChange(event.target.value)}
          />
        ) : null}
        {warnings.length > 0 ? (
          <div className="rounded border border-accent-yellow/30 bg-accent-yellow/10 p-2 text-accent-yellow">
            {warnings[0]}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function BatchMergeSummary({
  plan,
  warnings
}: {
  plan: ReturnType<typeof buildBatchMergePlan>;
  warnings: string[];
}) {
  const previewEpisodes = plan.episodes.slice(0, 4);
  const hiddenCount = Math.max(0, plan.episodes.length - previewEpisodes.length);
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
        <WandSparkles size={15} className="text-accent-cyan" />
        <span>分集合并草案</span>
        <span className="ml-auto rounded border border-panel-line bg-black/25 px-1.5 py-0.5 text-[11px] text-slate-400">
          {confidenceLabel(plan.confidence)}
        </span>
      </div>
      <div className="mt-2 grid gap-1">
        {[...plan.diagnostics, ...warnings].map((diagnostic, index) => (
          <p key={`${diagnostic}-${index}`} className="leading-5 text-slate-400">
            {diagnostic}
          </p>
        ))}
      </div>
      {previewEpisodes.length > 0 ? (
        <div className="mt-3 grid gap-1">
          {previewEpisodes.map((episode) => (
            <div key={episode.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <span
                className="truncate"
                title={`${episode.label}：${episode.sourceFileNames.join("、")}`}
              >
                {episode.label}
              </span>
              <span className="text-slate-500">
                {episode.itemCount.toLocaleString("zh-CN")} 条
              </span>
            </div>
          ))}
          {hiddenCount > 0 ? (
            <p className="text-slate-500">另有 {hiddenCount} 个输出。</p>
          ) : null}
        </div>
      ) : null}
      {plan.compensation.markerCount > 0 ? (
        <div className="mt-3 grid gap-1 border-t border-panel-line pt-3 text-slate-400">
          <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
            <span className="text-slate-500">版本差异</span>
            <span>{plan.compensation.markerCount} 个</span>
          </div>
          <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
            <span className="text-slate-500">总时长</span>
            <span>{formatSignedDuration(plan.compensation.totalGapMs)}</span>
          </div>
          <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
            <span className="text-slate-500">影响</span>
            <span>
              {plan.compensation.affectedEpisodeCount} 个输出，
              {plan.compensation.affectedEntryCount.toLocaleString("zh-CN")} 条弹幕
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface SourceSegmentEpisodeOption {
  key: string;
  label: string;
}

interface SourceSegmentFormState {
  kind: DanmakuSourceSegmentKind;
  assetId: string;
  sourceMediaId: string;
  startText: string;
  endText: string;
  targetMediaId: string;
  targetStartText: string;
  timingRulesText: string;
  episodeKey: string;
  label: string;
  note: string;
}

function SourceTimelineSegmentsPanel({
  segments,
  assets,
  sourceBindings,
  sourceMediaOptions,
  targetMediaOptions,
  plan,
  summary,
  onAdd,
  onUpdate,
  onDelete,
  onFocus
}: {
  segments: DanmakuSourceSegment[];
  assets: EditorProject["assets"];
  sourceBindings: EditorProject["danmakuSourceBindings"];
  sourceMediaOptions: ProjectMediaReference[];
  targetMediaOptions: ProjectMediaReference[];
  plan: ReturnType<typeof buildBatchMergePlan>;
  summary: SourceTimelineSummary;
  onAdd: (draft: DanmakuSourceSegmentDraft) => void;
  onUpdate: (id: string, patch: DanmakuSourceSegmentPatch) => void;
  onDelete: (id: string) => void;
  onFocus: (timeMs: Milliseconds) => void;
}) {
  const episodeOptions = useMemo(() => createSourceSegmentEpisodeOptions(plan), [plan]);
  const sourceSegmentGroups = useMemo(
    () => createSourceSegmentGroups(segments, sourceMediaOptions),
    [segments, sourceMediaOptions]
  );
  const [form, setForm] = useState<SourceSegmentFormState>({
    kind: "content",
    assetId: "",
    sourceMediaId: "",
    startText: "00:00:00.000",
    endText: "00:24:00.000",
    targetMediaId: "",
    targetStartText: "00:00:00.000",
    timingRulesText: "",
    episodeKey: "",
    label: "",
    note: ""
  });

  useEffect(() => {
    setForm((current) => ({
      ...current,
      assetId:
        current.assetId.length === 0 && assets.length > 0 ? assets[0].id : current.assetId,
      sourceMediaId:
        findDanmakuSourceBinding(
          sourceBindings,
          current.assetId.length === 0 && assets.length > 0 ? assets[0].id : current.assetId
        )?.sourceMediaId ?? "",
      targetMediaId:
        current.targetMediaId.length === 0 && targetMediaOptions.length > 0
          ? targetMediaOptions[0].id
          : current.targetMediaId,
      episodeKey:
        current.episodeKey.length === 0 && episodeOptions.length > 0
          ? episodeOptions[0].key
          : current.episodeKey
    }));
  }, [assets, episodeOptions, sourceBindings, targetMediaOptions]);

  useEffect(() => {
    if (form.kind === "ignored" && form.targetMediaId.length > 0) {
      setForm((current) => ({ ...current, targetMediaId: "" }));
    }
  }, [form.kind, form.targetMediaId]);

  const submit = () => {
    const draft = createSourceSegmentDraftFromForm(form, episodeOptions);
    if (!draft.ok) {
      setStatus({ message: draft.message, tone: "warning" });
      return;
    }
    onAdd(draft.value);
    setForm((current) => ({
      ...current,
      startText: current.endText,
      endText: formatTimecode((parseSourceTimecode(current.endText) ?? 0) + 24 * 60 * 1000),
      label: "",
      note: ""
    }));
  };

  return (
    <section
      className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300"
      aria-label="弹幕来源内容段"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
        <Clock3 size={15} className="text-accent-cyan" />
        <span>弹幕来源内容段</span>
        <span className="ml-auto rounded border border-panel-line bg-black/25 px-1.5 py-0.5 text-[11px] text-slate-400">
          {summary.statusLabel}
        </span>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-slate-500">
        {summary.headline}。这里只标注 B 站/XML 时间轴上的虚拟范围，不剪切、不修改视频文件。
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {summary.metrics.map((metric) => (
          <div key={metric.label} className="rounded border border-panel-line bg-[#111318] p-2">
            <div className="text-[11px] text-slate-500">{metric.label}</div>
            <div className="mt-1 text-sm font-medium text-slate-100">{metric.value}</div>
          </div>
        ))}
      </div>
      <SourceTimelineLanes groups={sourceSegmentGroups} />
      <div className="mt-3 grid gap-1">
        {summary.findings.map((finding) => (
          <div
            key={finding.id}
            className={`rounded border p-2 ${sourceTimelineFindingClass(finding.severity)}`}
          >
            <div className="font-medium">{finding.title}</div>
            <div className="mt-1 leading-5">{finding.detail}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-2 rounded border border-panel-line bg-black/15 p-2">
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            <span className="text-slate-500">所属 XML</span>
            <select
              aria-label="来源段所属 XML"
              className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              value={form.assetId}
              onChange={(event) => {
                const assetId = event.target.value;
                setForm((current) => ({
                  ...current,
                  assetId,
                  sourceMediaId:
                    findDanmakuSourceBinding(sourceBindings, assetId)?.sourceMediaId ?? ""
                }));
              }}
            >
              <option value="">请选择 XML</option>
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.fileName}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="text-slate-500">B 站参考素材（由 XML 绑定决定）</span>
            <select
              aria-label="来源段 B 站参考素材"
              className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100 disabled:opacity-70"
              value={form.sourceMediaId}
              disabled
            >
              <option value="">请先到素材页绑定 XML</option>
              {sourceMediaOptions.map((media) => (
                <option key={media.id} value={media.id}>
                  {media.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <details className="rounded border border-panel-line/70 bg-black/10 p-2">
          <summary className="cursor-pointer text-[11px] text-slate-400">
            目标起点与段内删减修正
          </summary>
          <div className="mt-2 grid gap-2">
            <label className="grid gap-1">
              <span className="text-slate-500">目标原片起点</span>
              <input
                aria-label="来源段目标原片起点"
                className="h-8 min-w-0 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100 disabled:opacity-50"
                value={form.targetStartText}
                disabled={form.kind === "ignored"}
                onChange={(event) =>
                  setForm((current) => ({ ...current, targetStartText: event.target.value }))
                }
              />
            </label>
            <label className="grid gap-1">
              <span className="text-slate-500">删减修正（每行：参考时间 -&gt; 毫秒差值）</span>
              <textarea
                aria-label="来源段删减修正"
                className="min-h-20 rounded border border-panel-line bg-[#111318] p-2 text-xs text-slate-100 disabled:opacity-50"
                value={form.timingRulesText}
                disabled={form.kind === "ignored"}
                placeholder="00:12:30.000 -> +45000"
                onChange={(event) =>
                  setForm((current) => ({ ...current, timingRulesText: event.target.value }))
                }
              />
            </label>
            <p className="text-[11px] leading-5 text-slate-500">
              目标起点影响这一段投影到原片的落点；删减修正只影响该来源段内后续弹幕，不修改原始
              XML。
            </p>
          </div>
        </details>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            <span className="text-slate-500">开始</span>
            <input
              aria-label="来源段开始"
              className="h-8 min-w-0 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              value={form.startText}
              onChange={(event) =>
                setForm((current) => ({ ...current, startText: event.target.value }))
              }
            />
          </label>
          <label className="grid gap-1">
            <span className="text-slate-500">结束</span>
            <input
              aria-label="来源段结束"
              className="h-8 min-w-0 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              value={form.endText}
              onChange={(event) =>
                setForm((current) => ({ ...current, endText: event.target.value }))
              }
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            <span className="text-slate-500">用途</span>
            <select
              aria-label="来源段用途"
              className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              value={form.kind}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  kind: event.target.value as DanmakuSourceSegmentKind
                }))
              }
            >
              <option value="content">正片内容</option>
              <option value="ignored">忽略范围</option>
            </select>
          </label>
          <label className="grid gap-1">
            <span className="text-slate-500">目标原片</span>
            <select
              aria-label="来源段目标原片"
              className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100 disabled:opacity-50"
              value={form.targetMediaId}
              disabled={form.kind === "ignored"}
              onChange={(event) =>
                setForm((current) => ({ ...current, targetMediaId: event.target.value }))
              }
            >
              <option value="">暂不关联</option>
              {targetMediaOptions.map((media) => (
                <option key={media.id} value={media.id}>
                  {media.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="grid gap-1">
          <span className="text-slate-500">对应输出</span>
          <select
            aria-label="来源段对应输出"
            className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100 disabled:opacity-50"
            value={form.episodeKey}
            disabled={form.kind === "ignored"}
            onChange={(event) =>
              setForm((current) => ({ ...current, episodeKey: event.target.value }))
            }
          >
            <option value="">暂不关联</option>
            {episodeOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-slate-500">名称</span>
          <input
            aria-label="来源段名称"
            className="h-8 min-w-0 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
            value={form.label}
            placeholder="留空时自动命名"
            onChange={(event) =>
              setForm((current) => ({ ...current, label: event.target.value }))
            }
          />
        </label>
        <label className="grid gap-1">
          <span className="text-slate-500">备注</span>
          <input
            aria-label="来源段备注"
            className="h-8 min-w-0 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
            value={form.note}
            placeholder="例如：前两小时为无意义片段"
            onChange={(event) =>
              setForm((current) => ({ ...current, note: event.target.value }))
            }
          />
        </label>
        <div className="flex justify-end">
          <TextButton tone="primary" onClick={submit}>
            <ListPlus size={14} />
            新增来源段
          </TextButton>
        </div>
      </div>
      {segments.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {sourceSegmentGroups.map((group) => (
            <section
              key={group.sourceMediaId}
              className="grid gap-2 rounded border border-panel-line/70 bg-black/10 p-2"
              aria-label={`${group.label} 来源段`}
              data-testid="source-segment-lane"
            >
              <div className="text-[11px] font-medium text-slate-400">{group.label}</div>
              {group.segments.map((segment) => (
                <SourceTimelineSegmentRow
                  key={segment.id}
                  segment={segment}
                  assets={assets}
                  sourceBindings={sourceBindings}
                  sourceMediaOptions={sourceMediaOptions}
                  targetMediaOptions={targetMediaOptions}
                  episodeOptions={episodeOptions}
                  onUpdate={onUpdate}
                  onDelete={onDelete}
                  onFocus={onFocus}
                />
              ))}
            </section>
          ))}
        </div>
      ) : null}
      <p className="mt-3 text-[11px] leading-5 text-slate-500">
        下一步：{summary.nextActionLabel}
      </p>
    </section>
  );
}

function SourceTimelineSegmentRow({
  segment,
  assets,
  sourceBindings,
  sourceMediaOptions,
  targetMediaOptions,
  episodeOptions,
  onUpdate,
  onDelete,
  onFocus
}: {
  segment: DanmakuSourceSegment;
  assets: EditorProject["assets"];
  sourceBindings: EditorProject["danmakuSourceBindings"];
  sourceMediaOptions: ProjectMediaReference[];
  targetMediaOptions: ProjectMediaReference[];
  episodeOptions: SourceSegmentEpisodeOption[];
  onUpdate: (id: string, patch: DanmakuSourceSegmentPatch) => void;
  onDelete: (id: string) => void;
  onFocus: (timeMs: Milliseconds) => void;
}) {
  const timeMapOwned = Boolean(segment.timeMapId);
  const [form, setForm] = useState<SourceSegmentFormState>(() =>
    createFormFromSegment(segment)
  );

  useEffect(() => {
    setForm(createFormFromSegment(segment));
  }, [segment]);

  useEffect(() => {
    if (form.kind === "ignored" && form.targetMediaId.length > 0) {
      setForm((current) => ({ ...current, targetMediaId: "" }));
    }
  }, [form.kind, form.targetMediaId]);

  useEffect(() => {
    const boundSourceMediaId =
      findDanmakuSourceBinding(sourceBindings, form.assetId)?.sourceMediaId ?? "";
    if (boundSourceMediaId !== form.sourceMediaId) {
      setForm((current) => ({ ...current, sourceMediaId: boundSourceMediaId }));
    }
  }, [form.assetId, form.sourceMediaId, sourceBindings]);

  const save = () => {
    if (timeMapOwned) {
      const episode = episodeOptions.find((option) => option.key === form.episodeKey);
      onUpdate(segment.id, {
        episodeKey: form.episodeKey || null,
        episodeLabel: episode?.label ?? null,
        label: form.label,
        note: form.note
      });
      return;
    }
    const draft = createSourceSegmentDraftFromForm(form, episodeOptions);
    if (!draft.ok) {
      setStatus({ message: draft.message, tone: "warning" });
      return;
    }
    onUpdate(segment.id, draft.value);
  };

  return (
    <article className="grid gap-2 rounded border border-panel-line bg-[#111318] p-2">
      <div className="flex items-center gap-2">
        <span
          className={`h-2.5 w-2.5 rounded-sm ${segment.kind === "content" ? "bg-accent-cyan" : "bg-slate-600"}`}
        />
        <span className="min-w-0 flex-1 truncate text-slate-100" title={segment.label}>
          {segment.label}
        </span>
        <span className="text-[11px] text-slate-500">
          {formatTimecode(segment.sourceStartMs)} - {formatTimecode(segment.sourceEndMs)}
        </span>
      </div>
      <div className="grid gap-1 rounded border border-panel-line/70 bg-black/15 p-2 text-[11px] text-slate-500">
        <div className="truncate">
          XML：{assets.find((asset) => asset.id === segment.assetId)?.fileName ?? "未选择"}
        </div>
        <div className="truncate">
          B 站参考：
          {sourceMediaOptions.find((media) => media.id === segment.sourceMediaId)?.name ??
            "未选择"}
        </div>
        <div className="truncate">
          目标原片：
          {segment.kind === "ignored"
            ? "忽略范围无需目标"
            : (targetMediaOptions.find((media) => media.id === segment.targetMediaId)?.name ??
              "未选择")}
        </div>
      </div>
      {timeMapOwned ? (
        <div className="rounded border border-accent-yellow/30 bg-accent-yellow/10 p-2 text-[11px] leading-5 text-accent-yellow">
          这条来源段由已确认时间图管理。素材、用途、双方范围和删减修正已锁定；这里只能修改输出标签与备注。若映射有误，请回到上方候选卡撤销确认后重新分析。
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <select
          aria-label={`${segment.label} 所属 XML`}
          className="h-8 rounded border border-panel-line bg-black/20 px-2 text-xs text-slate-100"
          value={form.assetId}
          disabled={timeMapOwned}
          onChange={(event) => {
            const assetId = event.target.value;
            setForm((current) => ({
              ...current,
              assetId,
              sourceMediaId:
                findDanmakuSourceBinding(sourceBindings, assetId)?.sourceMediaId ?? ""
            }));
          }}
        >
          <option value="">请选择 XML</option>
          {assets.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.fileName}
            </option>
          ))}
        </select>
        <select
          aria-label={`${segment.label} B 站参考素材`}
          className="h-8 rounded border border-panel-line bg-black/20 px-2 text-xs text-slate-100 disabled:opacity-70"
          value={form.sourceMediaId}
          disabled
        >
          <option value="">请先到素材页绑定 XML</option>
          {sourceMediaOptions.map((media) => (
            <option key={media.id} value={media.id}>
              {media.name}
            </option>
          ))}
        </select>
      </div>
      <details className="rounded border border-panel-line/70 bg-black/10 p-2">
        <summary className="cursor-pointer text-[11px] text-slate-400">
          目标起点与段内删减修正
        </summary>
        <div className="mt-2 grid gap-2">
          <input
            aria-label={`${segment.label} 目标原片起点`}
            className="h-8 min-w-0 rounded border border-panel-line bg-black/20 px-2 text-xs text-slate-100 disabled:opacity-50"
            value={form.targetStartText}
            disabled={timeMapOwned || form.kind === "ignored"}
            onChange={(event) =>
              setForm((current) => ({ ...current, targetStartText: event.target.value }))
            }
          />
          <textarea
            aria-label={`${segment.label} 删减修正`}
            className="min-h-20 rounded border border-panel-line bg-black/20 p-2 text-xs text-slate-100 disabled:opacity-50"
            value={form.timingRulesText}
            disabled={timeMapOwned || form.kind === "ignored"}
            placeholder="00:12:30.000 -> +45000"
            onChange={(event) =>
              setForm((current) => ({ ...current, timingRulesText: event.target.value }))
            }
          />
        </div>
      </details>
      <div className="grid grid-cols-2 gap-2">
        <input
          aria-label={`${segment.label} 开始`}
          className="h-8 min-w-0 rounded border border-panel-line bg-black/20 px-2 text-xs text-slate-100"
          value={form.startText}
          disabled={timeMapOwned}
          onChange={(event) =>
            setForm((current) => ({ ...current, startText: event.target.value }))
          }
        />
        <input
          aria-label={`${segment.label} 结束`}
          className="h-8 min-w-0 rounded border border-panel-line bg-black/20 px-2 text-xs text-slate-100"
          value={form.endText}
          disabled={timeMapOwned}
          onChange={(event) =>
            setForm((current) => ({ ...current, endText: event.target.value }))
          }
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <select
          aria-label={`${segment.label} 用途`}
          className="h-8 rounded border border-panel-line bg-black/20 px-2 text-xs text-slate-100"
          value={form.kind}
          disabled={timeMapOwned}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              kind: event.target.value as DanmakuSourceSegmentKind
            }))
          }
        >
          <option value="content">正片内容</option>
          <option value="ignored">忽略范围</option>
        </select>
        <select
          aria-label={`${segment.label} 目标原片`}
          className="h-8 rounded border border-panel-line bg-black/20 px-2 text-xs text-slate-100 disabled:opacity-50"
          value={form.targetMediaId}
          disabled={timeMapOwned || form.kind === "ignored"}
          onChange={(event) =>
            setForm((current) => ({ ...current, targetMediaId: event.target.value }))
          }
        >
          <option value="">暂不关联</option>
          {targetMediaOptions.map((media) => (
            <option key={media.id} value={media.id}>
              {media.name}
            </option>
          ))}
        </select>
      </div>
      <select
        aria-label={`${segment.label} 对应输出`}
        className="h-8 rounded border border-panel-line bg-black/20 px-2 text-xs text-slate-100 disabled:opacity-50"
        value={form.episodeKey}
        disabled={form.kind === "ignored"}
        onChange={(event) =>
          setForm((current) => ({ ...current, episodeKey: event.target.value }))
        }
      >
        <option value="">暂不关联</option>
        {episodeOptions.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
      <input
        aria-label={`${segment.label} 名称`}
        className="h-8 min-w-0 rounded border border-panel-line bg-black/20 px-2 text-xs text-slate-100"
        value={form.label}
        onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
      />
      <input
        aria-label={`${segment.label} 备注`}
        className="h-8 min-w-0 rounded border border-panel-line bg-black/20 px-2 text-xs text-slate-100"
        value={form.note}
        placeholder="备注"
        onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <TextButton onClick={() => onFocus(segment.sourceStartMs)}>
          <Crosshair size={14} />
          定位
        </TextButton>
        <TextButton onClick={save}>
          <CircleCheck size={14} />
          更新
        </TextButton>
        <TextButton
          tone="danger"
          disabled={timeMapOwned}
          title={timeMapOwned ? "请在匹配候选卡中撤销已确认关系。" : undefined}
          onClick={() => onDelete(segment.id)}
        >
          <Trash2 size={14} />
          删除
        </TextButton>
      </div>
    </article>
  );
}

interface SourceSegmentGroup {
  sourceMediaId: string;
  label: string;
  segments: DanmakuSourceSegment[];
}

function SourceTimelineLanes({ groups }: { groups: SourceSegmentGroup[] }) {
  if (groups.length === 0) {
    return null;
  }
  return (
    <div className="mt-3 grid gap-2" data-testid="source-timeline-lanes">
      {groups.map((group) => (
        <section
          key={group.sourceMediaId}
          className="rounded border border-panel-line bg-black/15 p-2"
          aria-label={`${group.label} 独立时间带`}
        >
          <div className="text-[11px] font-medium text-slate-400">{group.label}</div>
          <SourceTimelineStrip
            segments={group.segments}
            ariaLabel={`${group.label} 弹幕来源时间带`}
          />
        </section>
      ))}
    </div>
  );
}

function SourceTimelineStrip({
  segments,
  ariaLabel
}: {
  segments: DanmakuSourceSegment[];
  ariaLabel: string;
}) {
  if (segments.length === 0) {
    return null;
  }
  const sorted = [...segments].sort(
    (left, right) =>
      left.sourceStartMs - right.sourceStartMs || left.sourceEndMs - right.sourceEndMs
  );
  const startMs = sorted[0].sourceStartMs;
  const endMs = Math.max(...sorted.map((segment) => segment.sourceEndMs));
  const durationMs = Math.max(1, endMs - startMs);
  return (
    <div
      className="mt-2 rounded border border-panel-line bg-black/20 p-2"
      aria-label={ariaLabel}
    >
      <div className="relative h-7 overflow-hidden rounded bg-[#0b0d12]">
        {sorted.map((segment) => {
          const left = ((segment.sourceStartMs - startMs) / durationMs) * 100;
          const width = Math.max(
            1,
            ((segment.sourceEndMs - segment.sourceStartMs) / durationMs) * 100
          );
          return (
            <div
              key={segment.id}
              className={`absolute top-0 h-full border-r border-black/40 ${
                segment.kind === "content" ? "bg-accent-cyan/60" : "bg-slate-600/60"
              }`}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${segment.label}：${formatTimecode(segment.sourceStartMs)} - ${formatTimecode(segment.sourceEndMs)}`}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-slate-500">
        <span>{formatTimecode(startMs)}</span>
        <span>{formatTimecode(endMs)}</span>
      </div>
    </div>
  );
}

function createSourceSegmentGroups(
  segments: DanmakuSourceSegment[],
  sourceMediaOptions: ProjectMediaReference[]
): SourceSegmentGroup[] {
  const unboundSourceId = "__unbound_source__";
  const labels = new Map(sourceMediaOptions.map((media) => [media.id, media.name]));
  const order = new Map(sourceMediaOptions.map((media, index) => [media.id, index]));
  const groups = new Map<string, DanmakuSourceSegment[]>();
  segments.forEach((segment) => {
    const sourceMediaId = segment.sourceMediaId ?? unboundSourceId;
    groups.set(sourceMediaId, [...(groups.get(sourceMediaId) ?? []), segment]);
  });
  return [...groups.entries()]
    .map(([sourceMediaId, groupedSegments]) => ({
      sourceMediaId,
      label:
        sourceMediaId === unboundSourceId
          ? "未绑定参考素材"
          : (labels.get(sourceMediaId) ?? sourceMediaId),
      segments: [...groupedSegments].sort(
        (left, right) =>
          left.sourceStartMs - right.sourceStartMs || left.sourceEndMs - right.sourceEndMs
      )
    }))
    .sort(
      (left, right) =>
        (order.get(left.sourceMediaId) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.sourceMediaId) ?? Number.MAX_SAFE_INTEGER) ||
        left.label.localeCompare(right.label, "zh-CN")
    );
}

function createSourceSegmentEpisodeOptions(
  plan: ReturnType<typeof buildBatchMergePlan>
): SourceSegmentEpisodeOption[] {
  return plan.episodes.map((episode) => ({
    key: createSeasonEpisodeKey(episode),
    label: episode.label
  }));
}

function createSourceSegmentDraftFromForm(
  form: SourceSegmentFormState,
  episodeOptions: readonly SourceSegmentEpisodeOption[]
): { ok: true; value: DanmakuSourceSegmentDraft } | { ok: false; message: string } {
  const sourceStartMs = parseSourceTimecode(form.startText);
  const sourceEndMs = parseSourceTimecode(form.endText);
  if (sourceStartMs === null || sourceEndMs === null) {
    return { ok: false, message: "来源段时间格式无效，请使用 00:00:00.000。" };
  }
  if (sourceEndMs <= sourceStartMs) {
    return { ok: false, message: "来源段结束时间必须晚于开始时间。" };
  }
  if (form.assetId.length === 0) {
    return { ok: false, message: "来源段必须选择所属 XML。" };
  }
  if (form.sourceMediaId.length === 0) {
    return { ok: false, message: "来源段必须选择 B 站参考素材。" };
  }
  const targetStartMs = parseSourceTimecode(form.targetStartText);
  if (form.kind === "content" && targetStartMs === null) {
    return { ok: false, message: "目标原片起点格式无效，请使用 00:00:00.000。" };
  }
  const timingRules = parseSegmentTimingRulesText(form.timingRulesText);
  if (!timingRules.ok) {
    return timingRules;
  }
  const episode = episodeOptions.find((option) => option.key === form.episodeKey);
  return {
    ok: true,
    value: {
      kind: form.kind,
      assetId: form.assetId || null,
      sourceMediaId: form.sourceMediaId || null,
      sourceStartMs,
      sourceEndMs,
      targetMediaId: form.kind === "content" ? form.targetMediaId || null : null,
      targetStartMs: form.kind === "content" ? targetStartMs : null,
      timingRules: form.kind === "content" ? timingRules.value : [],
      episodeKey: form.kind === "content" ? form.episodeKey || null : null,
      episodeLabel: form.kind === "content" ? (episode?.label ?? null) : null,
      label: form.label,
      note: form.note
    }
  };
}

function createFormFromSegment(segment: DanmakuSourceSegment): SourceSegmentFormState {
  return {
    kind: segment.kind,
    assetId: segment.assetId ?? "",
    sourceMediaId: segment.sourceMediaId ?? "",
    startText: formatTimecode(segment.sourceStartMs),
    endText: formatTimecode(segment.sourceEndMs),
    targetMediaId: segment.targetMediaId ?? "",
    targetStartText: formatTimecode(segment.targetStartMs ?? 0),
    timingRulesText: segment.timingRules
      .map(
        (rule) =>
          `${formatTimecode(rule.sourceAtMs)} -> ${rule.gapMs >= 0 ? "+" : ""}${rule.gapMs}${rule.note ? ` ${rule.note}` : ""}`
      )
      .join("\n"),
    episodeKey: segment.episodeKey ?? "",
    label: segment.label,
    note: segment.note
  };
}

function parseSegmentTimingRulesText(
  text: string
): { ok: true; value: SegmentTimingRuleDraft[] } | { ok: false; message: string } {
  const rules: SegmentTimingRuleDraft[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(.*?)\s*(?:->|=>)\s*([+-]?\d+)(?:\s+(.*))?$/);
    if (!match) {
      return {
        ok: false,
        message: `第 ${index + 1} 行删减修正格式无效，请使用“00:12:30.000 -> +45000”。`
      };
    }
    const sourceAtMs = parseSourceTimecode(match[1].trim());
    const gapMs = Number(match[2]);
    if (sourceAtMs === null || !Number.isSafeInteger(gapMs) || gapMs === 0) {
      return { ok: false, message: `第 ${index + 1} 行删减修正的时间或差值无效。` };
    }
    rules.push({ sourceAtMs, gapMs, note: match[3]?.trim() ?? "手动段内删减修正" });
  }
  return { ok: true, value: rules };
}

function sourceTimelineFindingClass(severity: SourceTimelineFinding["severity"]): string {
  if (severity === "error") {
    return "border-accent-red/30 bg-accent-red/10 text-accent-red";
  }
  if (severity === "warning") {
    return "border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow";
  }
  return "border-panel-line bg-black/15 text-slate-500";
}

function SeasonWorkbenchPanel({ summary }: { summary: SeasonWorkbenchSummary }) {
  return (
    <section
      className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300"
      aria-label="剧集工作台"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
        <WandSparkles size={15} className="text-accent-cyan" />
        <span>剧集工作台</span>
        <span className="ml-auto rounded border border-panel-line bg-black/25 px-1.5 py-0.5 text-[11px] text-slate-400">
          {summary.statusLabel}
        </span>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-slate-500">{summary.headline}</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {summary.metrics.map((metric) => (
          <div key={metric.label} className="rounded border border-panel-line bg-[#111318] p-2">
            <div className="text-[11px] text-slate-500">{metric.label}</div>
            <div className="mt-1 text-sm font-medium text-slate-100">{metric.value}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-2">
        {summary.steps.map((step) => (
          <div
            key={step.id}
            className="grid gap-1 rounded border border-panel-line bg-black/15 p-2"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-slate-100">{step.label}</span>
              <span
                className={`rounded border px-1.5 py-0.5 text-[11px] ${seasonWorkbenchStepClass(step.state)}`}
              >
                {step.stateText}
              </span>
            </div>
            <p className="leading-5 text-slate-500">{step.detail}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-5 text-slate-500">
        下一步：{summary.nextActionLabel}
      </p>
    </section>
  );
}

function SeasonEpisodeBindingPanel({
  plan,
  bindings,
  currentBinding,
  onBindCurrent,
  onClear,
  onOpenMediaTab
}: {
  plan: ReturnType<typeof buildBatchMergePlan>;
  bindings: SeasonEpisodeBinding[];
  currentBinding: MediaBinding | null;
  onBindCurrent: (episodeKey: string, episodeLabel: string) => void;
  onClear: (episodeKey: string) => void;
  onOpenMediaTab: () => void;
}) {
  const previewEpisodes = plan.episodes.slice(0, 6);
  const hiddenCount = Math.max(0, plan.episodes.length - previewEpisodes.length);
  return (
    <section
      className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300"
      aria-label="逐集目标绑定"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
        <Layers size={15} className="text-accent-cyan" />
        <span>逐集目标绑定</span>
        <span className="ml-auto rounded border border-panel-line bg-black/25 px-1.5 py-0.5 text-[11px] text-slate-400">
          {bindings.length} 个已绑定
        </span>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-slate-500">
        把当前目标原片分配给具体输出集，保存项目后仍可恢复；这里不保存视频内容、密码或临时播放地址。
      </p>
      {previewEpisodes.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {previewEpisodes.map((episode) => {
            const episodeKey = createSeasonEpisodeKey(episode);
            const savedBinding = findSeasonEpisodeBinding(bindings, episodeKey);
            const canBindCurrent = Boolean(currentBinding);
            return (
              <div
                key={episodeKey}
                className="grid gap-2 rounded border border-panel-line bg-black/15 p-2"
              >
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <div className="min-w-0">
                    <div
                      className="truncate text-slate-100"
                      title={`${episode.label}：${episode.sourceFileNames.join("、")}`}
                    >
                      {episode.label}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-slate-500">
                      {episode.sourceFileNames.join("、")} /{" "}
                      {episode.itemCount.toLocaleString("zh-CN")} 条
                    </div>
                  </div>
                  <span
                    className={`h-fit rounded border px-1.5 py-0.5 text-[11px] ${
                      savedBinding
                        ? "border-accent-green/30 bg-accent-green/10 text-accent-green"
                        : canBindCurrent
                          ? "border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan"
                          : "border-panel-line bg-black/25 text-slate-500"
                    }`}
                  >
                    {savedBinding ? "已绑定" : canBindCurrent ? "可绑定" : "待目标"}
                  </span>
                </div>
                <div className="text-[11px] leading-5 text-slate-500">
                  {savedBinding
                    ? `目标原片：${formatMediaBindingTitle(savedBinding.targetBinding)}`
                    : currentBinding
                      ? `当前目标：${formatMediaBindingTitle(currentBinding)}`
                      : "先在“媒体”页绑定本地文件或 Emby 条目。"}
                </div>
                <div className="flex flex-wrap gap-2">
                  {currentBinding ? (
                    <TextButton onClick={() => onBindCurrent(episodeKey, episode.label)}>
                      {savedBinding ? "更新目标" : "绑定当前目标"}
                    </TextButton>
                  ) : (
                    <TextButton onClick={onOpenMediaTab}>去绑定目标</TextButton>
                  )}
                  {savedBinding ? (
                    <TextButton onClick={() => onClear(episodeKey)}>清除</TextButton>
                  ) : null}
                </div>
              </div>
            );
          })}
          {hiddenCount > 0 ? (
            <p className="text-[11px] text-slate-500">
              另有 {hiddenCount} 个输出，可继续调整规则后查看。
            </p>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 rounded border border-panel-line bg-black/15 p-2 text-slate-500">
          先生成分集草案，再为每一集绑定目标原片。
        </div>
      )}
    </section>
  );
}

function seasonWorkbenchStepClass(state: SeasonWorkbenchStepState): string {
  if (state === "complete") {
    return "border-accent-green/30 bg-accent-green/10 text-accent-green";
  }
  if (state === "active") {
    return "border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan";
  }
  if (state === "blocked") {
    return "border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow";
  }
  return "border-panel-line bg-black/25 text-slate-500";
}

function CompensationMarkersPanel({
  markers,
  selectedIds,
  onFocus,
  onUpdate,
  onDelete
}: {
  markers: CutMarker[];
  selectedIds: string[];
  onFocus: (marker: CutMarker) => void;
  onUpdate: (id: string, patch: Partial<Omit<CutMarker, "id">>) => void;
  onDelete: (id: string) => void;
}) {
  const totalGapMs = markers.reduce((total, marker) => total + marker.targetGapMs, 0);
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
        <ListPlus size={15} className="text-accent-cyan" />
        <span>版本差异列表</span>
        <span className="ml-auto text-[11px] text-slate-500">{markers.length} 个</span>
      </div>
      <div className="mt-3 grid gap-2">
        {markers.length > 0 ? (
          <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 text-slate-400">
            <span className="text-slate-500">累计调整</span>
            <span>{formatSignedDuration(totalGapMs)}</span>
          </div>
        ) : (
          <div className="text-slate-500">
            暂无版本差异。可在时间轴标记，或从删减扫描、对齐线索生成。
          </div>
        )}
        {markers.map((marker) => {
          const selected = selectedIds.includes(marker.id);
          return (
            <article
              key={marker.id}
              className={`grid gap-2 rounded border p-2 ${
                selected
                  ? "border-accent-cyan bg-accent-cyan/10"
                  : "border-panel-line bg-black/20"
              }`}
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <button
                  type="button"
                  className="min-w-0 text-left"
                  onClick={() => onFocus(marker)}
                  aria-label={`定位版本差异 ${marker.name}`}
                >
                  <span className="block truncate text-slate-100" title={marker.name}>
                    {marker.name}
                  </span>
                  <span className="mt-1 block font-mono text-[11px] text-slate-500">
                    {formatTimecode(marker.sourceAtMs)} /{" "}
                    {formatSignedDuration(marker.targetGapMs)}
                  </span>
                </button>
                <TextButton
                  aria-label={`删除版本差异 ${marker.name}`}
                  tone="danger"
                  onClick={() => onDelete(marker.id)}
                >
                  <Trash2 size={14} />
                  删除
                </TextButton>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1">
                  <span className="text-slate-500">发生时间 ms</span>
                  <input
                    aria-label={`${marker.name} 发生时间 ms`}
                    className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
                    inputMode="numeric"
                    value={marker.sourceAtMs}
                    onChange={(event) =>
                      onUpdate(marker.id, { sourceAtMs: Number(event.target.value) })
                    }
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-slate-500">相差 ms</span>
                  <input
                    aria-label={`${marker.name} 相差 ms`}
                    className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
                    inputMode="numeric"
                    value={marker.targetGapMs}
                    onChange={(event) =>
                      onUpdate(marker.id, { targetGapMs: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function SuspectedCutPanel({
  candidates,
  cutMarkers,
  keywordsText,
  windowSeconds,
  minHitCount,
  warnings,
  onKeywordsTextChange,
  onWindowSecondsChange,
  onMinHitCountChange,
  onApply
}: {
  candidates: SuspectedCutCandidate[];
  cutMarkers: CutMarker[];
  keywordsText: string;
  windowSeconds: string;
  minHitCount: string;
  warnings: string[];
  onKeywordsTextChange: (value: string) => void;
  onWindowSecondsChange: (value: string) => void;
  onMinHitCountChange: (value: string) => void;
  onApply: (candidate: SuspectedCutCandidate) => void;
}) {
  const previewCandidates = candidates.slice(0, 5);
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
        <Search size={15} className="text-accent-yellow" />
        <span>疑似版本差异</span>
        <span className="ml-auto text-[11px] text-slate-500">{candidates.length} 个候选</span>
      </div>
      <div className="mt-3 grid gap-2">
        <label className="grid gap-1">
          <span className="text-slate-500">关键词</span>
          <textarea
            aria-label="疑似版本差异关键词"
            className="min-h-16 resize-y rounded border border-panel-line bg-[#111318] p-2 text-xs leading-5 text-slate-100"
            value={keywordsText}
            placeholder="删了, 剪了, 跳了, 和谐"
            onChange={(event) => onKeywordsTextChange(event.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            <span className="text-slate-500">窗口秒</span>
            <input
              aria-label="疑似版本差异聚类窗口秒"
              className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              inputMode="decimal"
              value={windowSeconds}
              onChange={(event) => onWindowSecondsChange(event.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-slate-500">最小命中</span>
            <input
              aria-label="疑似版本差异最小命中数"
              className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              inputMode="numeric"
              value={minHitCount}
              onChange={(event) => onMinHitCountChange(event.target.value)}
            />
          </label>
        </div>
        {warnings.map((warning) => (
          <div key={warning} className="text-[11px] text-accent-yellow">
            {warning}
          </div>
        ))}
        {previewCandidates.length === 0 ? (
          <div className="border-t border-panel-line pt-2 text-slate-500">暂无候选</div>
        ) : null}
        {previewCandidates.map((candidate) => {
          const applied = isSuspectedCutCandidateApplied(candidate, cutMarkers);
          return (
            <div
              key={candidate.id}
              className="grid gap-2 border-t border-panel-line pt-2 first:border-t-0 first:pt-0"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <div className="min-w-0">
                  <div className="truncate text-slate-100" title={candidate.assetFileName}>
                    {formatTimecode(candidate.sourceAtMs)} / {candidate.assetFileName}
                  </div>
                  <div
                    className="mt-1 truncate text-slate-500"
                    title={candidate.sampleTexts.join(" / ")}
                  >
                    {candidate.hitCount} 条 / {candidate.keywords.join("、")} /{" "}
                    {confidenceText(candidate.confidence)}
                  </div>
                </div>
                <TextButton
                  tone={applied ? "neutral" : "primary"}
                  disabled={applied}
                  onClick={() => onApply(candidate)}
                >
                  {applied ? "已存在" : "转为版本差异"}
                </TextButton>
              </div>
              <div
                className="truncate text-[11px] text-slate-500"
                title={candidate.sampleTexts.join(" / ")}
              >
                {candidate.sampleTexts[0]}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AnchorCalibrationPanel({
  text,
  proposal,
  onTextChange,
  onPreview,
  onApply
}: {
  text: string;
  proposal: ReturnType<typeof createAnchorCalibrationProposal>;
  onTextChange: (value: string) => void;
  onPreview: () => void;
  onApply: () => void;
}) {
  const hasInput = text.trim().length > 0;
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
      <h3 className="text-sm font-medium text-slate-100">锚点校准</h3>
      <div className="mt-3 grid gap-2">
        <textarea
          className="min-h-20 resize-y rounded border border-panel-line bg-[#111318] p-2 text-xs leading-5 text-slate-100"
          value={text}
          placeholder={"每行一个对应点，例如：\n00:10 -> 00:10\n23:12.400 -> 24:34.400"}
          onChange={(event) => onTextChange(event.target.value)}
        />
        {hasInput ? (
          <div className="grid gap-1 text-slate-400">
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
              <span className="text-slate-500">锚点</span>
              <span>{proposal.anchors.length} 个</span>
            </div>
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
              <span className="text-slate-500">推断差异</span>
              <span>{proposal.cutCandidates.length} 个</span>
            </div>
            {proposal.cutCandidates.slice(0, 3).map((candidate) => (
              <div key={candidate.id} className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
                <span className="text-slate-500">{formatTimecode(candidate.sourceAtMs)}</span>
                <span>
                  +{formatTimecode(candidate.targetGapMs)}
                  {formatCandidateSourceRange(candidate)}
                </span>
              </div>
            ))}
            {proposal.diagnostics.length > 0 ? (
              <div className="rounded border border-accent-yellow/30 bg-accent-yellow/10 p-2 text-accent-yellow">
                {proposal.diagnostics[0]}
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <TextButton disabled={proposal.anchors.length === 0} onClick={onPreview}>
                预览到时间轴
              </TextButton>
              <TextButton
                tone="primary"
                disabled={proposal.anchors.length === 0}
                onClick={onApply}
              >
                应用线索与差异
              </TextButton>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SyncAnchorsPanel({
  anchors,
  onFocus,
  onUpdate,
  onDelete
}: {
  anchors: SyncAnchor[];
  onFocus: (anchor: SyncAnchor) => void;
  onUpdate: (id: string, patch: Partial<Omit<SyncAnchor, "id">>) => void;
  onDelete: (id: string) => void;
}) {
  const sortedAnchors = [...anchors].sort(
    (left, right) => left.sourceMs - right.sourceMs || left.id.localeCompare(right.id)
  );
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
        <Layers size={15} className="text-accent-cyan" />
        <span>同步锚点管理</span>
        <span className="ml-auto text-[11px] text-slate-500">{sortedAnchors.length} 个</span>
      </div>
      <div className="mt-3 grid gap-2">
        {sortedAnchors.length === 0 ? (
          <div className="text-slate-500">暂无同步锚点，可从锚点校准或本地对齐提案生成。</div>
        ) : null}
        {sortedAnchors.map((anchor, index) => {
          const label = `同步锚点 ${index + 1}`;
          return (
            <article
              key={anchor.id}
              className="grid gap-2 rounded border border-panel-line bg-black/20 p-2"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <button
                  type="button"
                  className="min-w-0 text-left"
                  onClick={() => onFocus(anchor)}
                  aria-label={`定位${label}`}
                >
                  <span className="block truncate text-slate-100">
                    {label} / {anchorOriginText(anchor.origin)}
                  </span>
                  <span className="mt-1 block font-mono text-[11px] text-slate-500">
                    {formatTimecode(anchor.sourceMs)} -&gt; {formatTimecode(anchor.targetMs)} /{" "}
                    {formatSignedDuration(anchor.targetMs - anchor.sourceMs)}
                  </span>
                </button>
                <TextButton
                  aria-label={`删除${label}`}
                  tone="danger"
                  onClick={() => onDelete(anchor.id)}
                >
                  <Trash2 size={14} />
                  删除
                </TextButton>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1">
                  <span className="text-slate-500">当前视频时间 ms</span>
                  <input
                    aria-label={`${label} 当前视频时间 ms`}
                    className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
                    inputMode="numeric"
                    value={anchor.sourceMs}
                    onChange={(event) =>
                      onUpdate(anchor.id, { sourceMs: Number(event.target.value) })
                    }
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-slate-500">完整版时间 ms</span>
                  <input
                    aria-label={`${label} 完整版时间 ms`}
                    className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
                    inputMode="numeric"
                    value={anchor.targetMs}
                    onChange={(event) =>
                      onUpdate(anchor.id, { targetMs: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function AlignmentProposalDiagnosticsPanel({
  project,
  text,
  proposal,
  preview,
  onTextChange,
  onImportText,
  onClear
}: {
  project: EditorProject;
  text: string;
  proposal: AlignmentProposal | null;
  preview: ReturnType<typeof buildAlignmentPreview>;
  onTextChange: (value: string) => void;
  onImportText: (value: string, sourceFileName?: string) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const downloadContent = getAlignmentProposalDownloadText(text, proposal);
  const canClearProposal = Boolean(proposal) || text.trim().length > 0;
  const applyBlockerContext = {
    existingAnchors: project.syncAnchors,
    existingCutMarkers: project.cutMarkers
  };
  const applyBlockers = proposal
    ? createAlignmentApplyBlockers(proposal, applyBlockerContext)
    : [];
  const reviewItemStatuses = proposal
    ? createAlignmentReviewItemStatuses(proposal, applyBlockerContext)
    : [];
  const reviewStatusSummary = createAlignmentReviewStatusSummary(reviewItemStatuses);
  const previewCuts = preview.proposalCuts.slice(0, 3);

  const exportProposal = () => {
    if (!downloadContent) {
      setStatus({ message: "暂无可导出的对齐提案。", tone: "warning" });
      return;
    }
    const fileName = downloadTextFile(
      createProjectDownloadFileName(project.name, "-alignment-proposal.json"),
      downloadContent,
      "application/json;charset=utf-8"
    );
    setStatus({ message: `已导出对齐提案 JSON：${fileName}。`, tone: "success" });
  };

  const exportReviewReport = () => {
    if (!proposal) {
      setStatus({ message: "暂无可导出的对齐诊断报告。", tone: "warning" });
      return;
    }
    const fileName = downloadTextFile(
      createProjectDownloadFileName(project.name, "-alignment-review-report.txt"),
      createAlignmentReviewReport(proposal, new Date(), applyBlockerContext),
      "text/plain;charset=utf-8"
    );
    setStatus({ message: `已导出对齐诊断报告：${fileName}。`, tone: "success" });
  };

  return (
    <section
      aria-label="手工 JSON 对齐诊断"
      className="rounded border border-panel-line bg-black/10 p-3 text-xs text-slate-300"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
        <Search size={15} className="text-accent-cyan" />
        <span>手工 JSON 与只读结果</span>
        {proposal ? (
          <span className="ml-auto text-[11px] text-slate-500">
            待检查 {reviewStatusSummary.pendingCount} / 已存在{" "}
            {reviewStatusSummary.appliedCount}
            {reviewStatusSummary.blockedCount > 0
              ? ` / 冲突 ${reviewStatusSummary.blockedCount}`
              : ""}
          </span>
        ) : null}
      </div>
      <p className="mt-2 leading-5 text-slate-500">
        可粘贴或导入 AlignmentProposal JSON，结果只用于证据检查和时间轴候选预览。
        本区不读取视频、不启动 FFmpeg，也不提供旧单对单自动对齐。
      </p>
      <div className="mt-3 grid gap-2">
        <textarea
          aria-label="对齐提案 JSON"
          className="min-h-24 resize-y rounded border border-panel-line bg-[#111318] p-2 font-mono text-xs leading-5 text-slate-100"
          value={text}
          placeholder="粘贴 AlignmentProposal JSON"
          onChange={(event) => onTextChange(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <TextButton onClick={() => inputRef.current?.click()}>选择 JSON 文件</TextButton>
          <TextButton onClick={() => onImportText(text)} disabled={text.trim().length === 0}>
            解析为只读诊断
          </TextButton>
          <TextButton onClick={exportProposal} disabled={!downloadContent}>
            导出 JSON
          </TextButton>
          <TextButton onClick={exportReviewReport} disabled={!proposal}>
            <Download size={14} />
            导出诊断报告
          </TextButton>
          <TextButton onClick={onClear} disabled={!canClearProposal}>
            <Trash2 size={14} />
            清空诊断
          </TextButton>
        </div>
        <input
          ref={inputRef}
          className="hidden"
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void readTextFile(file)
                .then((content) => {
                  onTextChange(content);
                  onImportText(content, file.name);
                })
                .catch((error: unknown) => {
                  setStatus({
                    message:
                      error instanceof Error && error.message.trim().length > 0
                        ? `对齐提案文件读取失败：${error.message}`
                        : "对齐提案文件读取失败。",
                    tone: "error"
                  });
                });
            }
            event.target.value = "";
          }}
        />
        {proposal ? (
          <div className="grid gap-2 text-slate-400">
            <AlignmentEvidencePanel proposal={proposal} />
            {applyBlockers.length > 0 ? (
              <div className="rounded border border-accent-yellow/30 bg-accent-yellow/10 p-2 text-[11px] text-accent-yellow">
                <div className="mb-1 font-medium">诊断警告</div>
                <ul className="grid list-disc gap-1 pl-4">
                  {applyBlockers.slice(0, 3).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
              <span className="text-slate-500">同步锚点</span>
              <span>
                {proposal.anchors.length} 个，候选 {preview.summary.candidateAnchorCount}
              </span>
              <span className="text-slate-500">版本差异</span>
              <span>
                {proposal.cutCandidates.length} 个，候选 {preview.summary.candidateCutCount}
              </span>
            </div>
            {previewCuts.map((candidate) => (
              <div
                key={candidate.id}
                className="grid grid-cols-[88px_minmax(0,1fr)] gap-2 rounded border border-panel-line/70 bg-[#111318] p-2"
              >
                <span className="text-slate-500">{formatTimecode(candidate.sourceAtMs)}</span>
                <span>
                  {formatSignedDuration(candidate.targetGapMs)} /{" "}
                  {candidate.state === "applied" ? "项目中已存在" : "只读候选"}
                  {formatCandidateSourceRange(candidate)}
                </span>
              </div>
            ))}
            {proposal.diagnostics.slice(0, 4).map((diagnostic, index) => (
              <div
                key={`${diagnostic}-${index}`}
                className="rounded border border-panel-line bg-[#111318] p-2 leading-5 text-slate-400"
              >
                {diagnostic}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded border border-panel-line bg-[#111318] p-2 leading-5 text-slate-500">
            暂无已解析的对齐提案。普通匹配无需使用本区；仅在收到外部 JSON 或排查旧项目时导入。
          </div>
        )}
      </div>
    </section>
  );
}
function AlignmentEvidencePanel({ proposal }: { proposal: AlignmentProposal }) {
  if (!proposal.evidence) {
    return null;
  }
  const evidence = proposal.evidence;
  const offsetSummary = createAlignmentOffsetSummary(proposal);
  const timelineMaxMs = createAlignmentEvidenceTimelineMaxMs(proposal);
  const anchorTicks = proposal.anchors.slice(0, 18).map((anchor) => ({
    id: anchor.id,
    x:
      timelineMaxMs > 0 ? Math.min(96, Math.max(4, (anchor.sourceMs / timelineMaxMs) * 100)) : 4
  }));
  const cutBands = proposal.cutCandidates.slice(0, 12).map((candidate) => ({
    id: candidate.id,
    x:
      timelineMaxMs > 0
        ? Math.min(96, Math.max(4, (candidate.sourceAtMs / timelineMaxMs) * 100))
        : 4,
    width:
      timelineMaxMs > 0
        ? Math.min(18, Math.max(3, (Math.abs(candidate.targetGapMs) / timelineMaxMs) * 100))
        : 3
  }));
  return (
    <div className="grid gap-2 rounded border border-panel-line bg-black/20 p-2 text-[11px] text-slate-300">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-slate-200">对齐证据</span>
        <span className={getAlignmentEvidenceQualityClassName(evidence.quality)}>
          {formatAlignmentEvidenceQuality(evidence.quality)}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(92px,1fr))] gap-2">
        <EvidenceMetric
          label="算法"
          value={formatAlignmentEvidenceAlgorithm(evidence.algorithm)}
        />
        <EvidenceMetric
          label="稀疏锚点"
          value={`${evidence.monotonicMatchCount} / ${evidence.fingerprintMatchCount}`}
        />
        <EvidenceMetric
          label="强/弱锚点"
          value={`${evidence.strongAnchorCount} / ${evidence.weakAnchorCount}`}
        />
        <EvidenceMetric label="offset 簇" value={`${evidence.offsetClusterCount}`} />
        <EvidenceMetric label="低置信区" value={`${evidence.lowConfidenceRegionCount}`} />
        <EvidenceMetric label="精修候选" value={`${evidence.refinedCandidateCount}`} />
        {evidence.timeMappingSegmentCount !== undefined ? (
          <EvidenceMetric label="时间段" value={`${evidence.timeMappingSegmentCount}`} />
        ) : null}
        {evidence.confirmedChangeCount !== undefined ? (
          <EvidenceMetric label="持续变点" value={`${evidence.confirmedChangeCount}`} />
        ) : null}
      </div>
      <svg
        className="h-12 w-full overflow-visible"
        viewBox="0 0 100 32"
        role="img"
        aria-label="对齐证据图"
        preserveAspectRatio="none"
      >
        <line x1="4" y1="10" x2="96" y2="10" stroke="rgb(71 85 105)" strokeWidth="1" />
        <line x1="4" y1="22" x2="96" y2="22" stroke="rgb(71 85 105)" strokeWidth="1" />
        {cutBands.map((band) => (
          <rect
            key={band.id}
            x={Math.max(4, band.x - band.width / 2)}
            y="5"
            width={band.width}
            height="22"
            rx="1.5"
            fill="rgba(245,158,11,0.26)"
          />
        ))}
        {anchorTicks.map((tick) => (
          <circle key={tick.id} cx={tick.x} cy="10" r="1.6" fill="rgb(34 211 238)" />
        ))}
        {anchorTicks.map((tick) => (
          <circle
            key={`${tick.id}-target`}
            cx={tick.x}
            cy="22"
            r="1.6"
            fill="rgb(16 185 129)"
          />
        ))}
      </svg>
      <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2 text-slate-400">
        <span className="text-slate-500">指纹数量</span>
        <span>
          完整版 {evidence.completeFingerprintCount} / B 站删减版{" "}
          {evidence.sourceFingerprintCount}
        </span>
        <span className="text-slate-500">offset 范围</span>
        <span>
          {offsetSummary
            ? `${formatSignedDuration(offsetSummary.minOffsetMs)} 到 ${formatSignedDuration(offsetSummary.maxOffsetMs)}`
            : "锚点不足"}
        </span>
      </div>
      {evidence.signals && evidence.signals.length > 0 ? (
        <div className="grid gap-1 border-t border-panel-line pt-2">
          <div className="text-slate-500">证据信号</div>
          {evidence.signals.map((signal) => (
            <div
              key={signal.kind}
              className="grid gap-0.5 rounded border border-panel-line/70 bg-[#111318] p-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-slate-200">{signal.label}</span>
                <span className={`shrink-0 ${getEvidenceSignalStatusClassName(signal.status)}`}>
                  {formatEvidenceSignalStatus(signal.status)}
                </span>
              </div>
              <div className="text-slate-500">
                观测 {signal.observations} / 权重 {Math.round(signal.weight * 100)}%
              </div>
              <div className="leading-5 text-slate-400">{signal.note}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EvidenceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 gap-0.5 rounded border border-panel-line/70 bg-[#111318] px-2 py-1">
      <span className="truncate text-slate-500">{label}</span>
      <span className="truncate text-slate-100" title={value}>
        {value}
      </span>
    </div>
  );
}

function getAlignmentProposalDownloadText(
  text: string,
  proposal: AlignmentProposal | null
): string {
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    return `${trimmed}\n`;
  }
  if (proposal) {
    return `${JSON.stringify(proposal, null, 2)}\n`;
  }
  return "";
}

function formatAlignmentEvidenceAlgorithm(
  algorithm: NonNullable<AlignmentProposal["evidence"]>["algorithm"]
): string {
  if (algorithm === "alignment-v2-edit-map") {
    return "C137 分段时间映射";
  }
  if (algorithm === "time-map-audio") {
    return "音频时间映射";
  }
  if (algorithm === "offset-path") {
    return "offset 路径";
  }
  if (algorithm === "sparse-fingerprint") {
    return "稀疏指纹";
  }
  if (algorithm === "sparse-fingerprint-fallback") {
    return "稀疏+DP";
  }
  return "密集 DP";
}

function formatAlignmentEvidenceQuality(
  quality: NonNullable<AlignmentProposal["evidence"]>["quality"]
): string {
  if (quality === "high") {
    return "高可信";
  }
  if (quality === "medium") {
    return "中等可信";
  }
  if (quality === "low") {
    return "低可信";
  }
  return "需重跑";
}

function getAlignmentEvidenceQualityClassName(
  quality: NonNullable<AlignmentProposal["evidence"]>["quality"]
): string {
  if (quality === "high") {
    return "text-emerald-300";
  }
  if (quality === "medium") {
    return "text-accent-cyan";
  }
  if (quality === "low") {
    return "text-amber-200";
  }
  return "text-red-200";
}

function formatEvidenceSignalStatus(
  status: NonNullable<NonNullable<AlignmentProposal["evidence"]>["signals"]>[number]["status"]
): string {
  if (status === "used") {
    return "已参与";
  }
  if (status === "blocked") {
    return "不可用";
  }
  return "未启用";
}

function getEvidenceSignalStatusClassName(
  status: NonNullable<NonNullable<AlignmentProposal["evidence"]>["signals"]>[number]["status"]
): string {
  if (status === "used") {
    return "text-emerald-300";
  }
  if (status === "blocked") {
    return "text-red-200";
  }
  return "text-slate-500";
}

function createAlignmentOffsetSummary(
  proposal: AlignmentProposal
): { minOffsetMs: number; maxOffsetMs: number } | null {
  if (proposal.anchors.length === 0) {
    return null;
  }
  const offsets = proposal.anchors.map((anchor) => anchor.targetMs - anchor.sourceMs);
  return {
    minOffsetMs: Math.min(...offsets),
    maxOffsetMs: Math.max(...offsets)
  };
}

function createAlignmentEvidenceTimelineMaxMs(proposal: AlignmentProposal): number {
  const anchorMax = proposal.anchors.reduce(
    (current, anchor) => Math.max(current, anchor.sourceMs, anchor.targetMs),
    0
  );
  const cutMax = proposal.cutCandidates.reduce(
    (current, candidate) =>
      Math.max(
        current,
        candidate.sourceAtMs,
        candidate.sourceRangeEndMs ?? candidate.sourceAtMs,
        candidate.sourceAtMs + Math.abs(candidate.targetGapMs)
      ),
    0
  );
  return Math.max(anchorMax, cutMax, 1);
}

function createBatchMergeOptions({
  partWindowMode,
  partWindowMinutes,
  partRangeStartMinutes,
  partRangeEndMinutes,
  longSplitMode,
  episodeDurationsText,
  cutPointsText
}: {
  partWindowMode: PartWindowMode;
  partWindowMinutes: string;
  partRangeStartMinutes: string;
  partRangeEndMinutes: string;
  longSplitMode: LongSplitMode;
  episodeDurationsText: string;
  cutPointsText: string;
}): { options: BatchMergeOptions; warnings: string[] } {
  const options: BatchMergeOptions = {};
  const warnings: string[] = [];
  if (partWindowMode === "prefix" || partWindowMode === "suffix") {
    const durationMs = parseMinutesInput(partWindowMinutes);
    if (durationMs === null || durationMs <= 0) {
      warnings.push("每分 P 的 N 分钟必须是大于 0 的数字。");
    } else {
      options.segmentWindow = { mode: partWindowMode, durationMs };
    }
  }
  if (partWindowMode === "range") {
    const startMs = parseMinutesInput(partRangeStartMinutes);
    const endMs = parseMinutesInput(partRangeEndMinutes);
    if (startMs === null || endMs === null || endMs <= startMs) {
      warnings.push("统一起止分钟需要填写有效的开始和结束。");
    } else {
      options.segmentWindow = { mode: "range", startMs, endMs };
    }
  }
  if (longSplitMode === "durations") {
    const parsed = parseEpisodeDurationsText(episodeDurationsText);
    warnings.push(...parsed.warnings);
    if (parsed.episodes.length > 0) {
      options.rangeSplit = { mode: "episodeDurations", episodes: parsed.episodes };
    }
  }
  if (longSplitMode === "cuts") {
    const parsed = parseCutPointsText(cutPointsText);
    warnings.push(...parsed.warnings);
    if (parsed.cutPointsMs.length > 0) {
      options.rangeSplit = { mode: "manualCutPoints", cutPointsMs: parsed.cutPointsMs };
    }
  }
  return { options, warnings };
}

async function exportBatchMergePlan(
  plan: ReturnType<typeof buildBatchMergePlan>,
  project: EditorProject
) {
  if (requiresProjectionOnlyExport(project)) {
    setStatus({
      message: "导出已阻断：当前项目必须通过已确认时间图按原片分集导出。",
      tone: "error"
    });
    return;
  }
  const files = plan.episodes.map((episode) => {
    const result = serializeBilibiliXml(episode.entries);
    const validation = validateExportedXml(result.xml);
    return {
      fileName: episode.fileName,
      content: result.xml,
      valid: validation.ok,
      message: validation.message
    };
  });
  const invalid = files.find((file) => !file.valid);
  if (invalid) {
    setStatus({ message: `分集 XML 验证失败：${invalid.message}`, tone: "error" });
    return;
  }
  try {
    const exportResult = await downloadLegacyXmlFiles(
      files.map((file) => ({ fileName: file.fileName, content: file.content })),
      {
        type: "application/xml;charset=utf-8",
        archiveFileName: createProjectDownloadFileName(project.name, "-danmaku-exports.zip")
      }
    );
    setStatus(createBatchExportStatus(exportResult));
  } catch (error) {
    setStatus({ message: `分集 XML 导出失败：${formatExportFileError(error)}`, tone: "error" });
  }
}

function setStatus(status: EditorStatus) {
  useEditorStore.setState({ status });
}

async function exportProjectionGroups(
  projection: SourceProjectionResult,
  project: EditorProject
): Promise<SaveTextExportResult | null> {
  const projectSnapshot = project;
  const exportableGroups = projection.groups.filter((group) => group.entries.length > 0);
  if (exportableGroups.length === 0) {
    setStatus({ message: "没有可导出的分集弹幕，请先在匹配页完成来源段。", tone: "warning" });
    return null;
  }
  setStatus({ message: "正在重新核验参考视频与原片的文件身份……", tone: "neutral" });
  const settings = loadAppSettings();
  const identityPreflight = await preflightProjectMediaIdentities(project, {
    ffmpegPath: settings.alignment.ffmpegPath.trim() || null
  });
  if (!identityPreflight.ok) {
    setStatus({
      message: `导出已阻断：${identityPreflight.issues.map((issue) => issue.message).join("；")}`,
      tone: "error"
    });
    return null;
  }
  if (!isProjectExportSnapshotCurrent(projectSnapshot)) {
    setStatus({
      message: "导出已取消：项目在媒体身份核验期间发生变化，请检查最新结果后重新导出。",
      tone: "warning"
    });
    return null;
  }
  const files = exportableGroups.map((group) => {
    const result = serializeBilibiliXml(
      group.entries.map((entry) => ({ item: entry.item, finalTimeMs: entry.finalTimeMs }))
    );
    const validation = validateExportedXml(result.xml);
    return {
      fileName: group.exportFileName,
      content: result.xml,
      valid: validation.ok,
      message: validation.message
    };
  });
  const invalid = files.find((file) => !file.valid);
  if (invalid) {
    setStatus({ message: `分集 XML 验证失败：${invalid.message}`, tone: "error" });
    return null;
  }
  try {
    const verification = await createVerifiedExportVerificationSeed(
      projectSnapshot,
      projection,
      identityPreflight.currentIdentities
    );
    const exportResult = await saveProjectedXmlExports(
      files.map((file) => ({ fileName: file.fileName, content: file.content })),
      {
        directoryPath: settings.export.defaultDirectory,
        archiveFileName: createProjectDownloadFileName(project.name, "-target-danmaku.zip"),
        verification,
        isSnapshotCurrent: () => isProjectExportSnapshotCurrent(projectSnapshot)
      }
    );
    setStatus(createBatchExportStatus(exportResult));
    return exportResult;
  } catch (error) {
    setStatus({ message: `分集 XML 导出失败：${formatExportFileError(error)}`, tone: "error" });
    return null;
  }
}

export function ProjectionExportPanel({
  projection,
  project,
  onGoMatching,
  exportGroups = exportProjectionGroups,
  openDirectory = openExportDirectoryPath
}: {
  projection: SourceProjectionResult;
  project: EditorProject;
  onGoMatching: () => void;
  exportGroups?: (
    projection: SourceProjectionResult,
    project: EditorProject
  ) => Promise<SaveTextExportResult | null>;
  openDirectory?: (directoryPath: string) => Promise<void>;
}) {
  const [isExporting, setIsExporting] = useState(false);
  const [lastExport, setLastExport] = useState<SaveTextExportResult | null>(null);
  const exportInFlightRef = useRef(false);
  const exportableGroups = projection.groups.filter((group) => group.entries.length > 0);
  const verifiedExportUnavailableReason = getVerifiedExportUnavailableReason(
    loadAppSettings().export.defaultDirectory
  );
  const exportDisabled =
    isExporting ||
    projection.status === "blocked" ||
    exportableGroups.length === 0 ||
    verifiedExportUnavailableReason !== null;
  const exportDisabledReason = isExporting
    ? "正在核验媒体身份并导出，请稍候。"
    : projection.status === "blocked"
      ? "先处理下面的阻断问题，再导出分集 XML。"
      : exportableGroups.length === 0
        ? "还没有可导出的分集弹幕。请先在匹配页标出来源段并关联原片。"
        : (verifiedExportUnavailableReason ?? "为每个原片导出一个精准同步的弹幕 XML");
  useEffect(() => {
    setLastExport(null);
  }, [project.id, project.updatedAt]);
  return (
    <section
      className="rounded-xl border border-panel-line bg-panel-soft p-4 text-xs text-slate-300"
      aria-label="按原片分集导出"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-slate-100">
            {lastExport ? "分集 XML 已导出" : "确认导出内容"}
          </h3>
          <p className="mt-1 leading-5 text-slate-500">
            {lastExport
              ? `已完成 ${lastExport.fileCount} 个文件；项目中的映射和原始 XML 没有改变。`
              : "按原片分集生成 XML，文件名和弹幕数量如下。导出前会再次核验媒体身份并重新解析 XML。"}
          </p>
        </div>
        <span className="ml-auto rounded border border-panel-line bg-black/25 px-1.5 py-0.5 text-[11px] text-slate-400">
          {projectionStatusLabel(projection.status)}
        </span>
      </div>
      {lastExport?.mode === "directory" ? (
        <div
          className="mt-3 rounded-lg border border-accent-green/30 bg-accent-green/10 p-3"
          data-testid="export-completion"
        >
          <div className="flex items-center gap-2 font-medium text-accent-green">
            <CircleCheck size={15} />
            导出完成
          </div>
          <p className="mt-1 break-all text-[11px] leading-5 text-slate-300">
            {lastExport.filePath}
            {lastExport.wasRenamed ? "（已有同名文件，已自动改名）" : ""}
          </p>
          <div className="mt-2">
            <TextButton
              onClick={() => {
                void openDirectory(lastExport.directoryPath).catch((error) =>
                  setStatus({
                    message: `打开目录失败：${formatExportFileError(error)}`,
                    tone: "error"
                  })
                );
              }}
            >
              <FolderOpen size={14} />
              打开导出目录
            </TextButton>
          </div>
        </div>
      ) : null}
      {verifiedExportUnavailableReason ? (
        <p className="mt-2 rounded border border-accent-yellow/30 bg-accent-yellow/10 p-2 leading-5 text-accent-yellow">
          {verifiedExportUnavailableReason} 本导出不会降级为普通浏览器下载。
        </p>
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded border border-panel-line bg-[#111318] p-2">
          <div className="text-[11px] text-slate-500">可导出分集</div>
          <div className="mt-1 text-sm font-medium text-slate-100">
            {exportableGroups.length} 个
          </div>
        </div>
        <div className="rounded border border-panel-line bg-[#111318] p-2">
          <div className="text-[11px] text-slate-500">已投影弹幕</div>
          <div className="mt-1 text-sm font-medium text-slate-100">
            {projection.projectedItemCount.toLocaleString("zh-CN")} 条
          </div>
        </div>
      </div>
      <details className="mt-2 rounded border border-panel-line/70 bg-black/10 px-2.5 py-2">
        <summary className="cursor-pointer text-[11px] text-slate-400">
          查看未导出弹幕统计
        </summary>
        <dl className="mt-2 grid grid-cols-3 gap-2 border-t border-panel-line/70 pt-2">
          <ExportMetric label="忽略段" value={projection.ignoredItemCount} />
          <ExportMetric label="参考独有段" value={projection.sourceOnlyItemCount} />
          <ExportMetric
            label="意外未覆盖"
            value={projection.unexpectedUnmappedItemCount}
          />
        </dl>
      </details>
      {projection.issues.length > 0 ? (
        <div className="mt-3 grid gap-1">
          {projection.issues.map((issue) => (
            <div
              key={issue.id}
              className={`rounded border p-2 leading-5 ${
                issue.severity === "error"
                  ? "border-accent-red/30 bg-accent-red/10 text-accent-red"
                  : "border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow"
              }`}
            >
              {issue.message}
            </div>
          ))}
        </div>
      ) : null}
      {projection.groups.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {projection.groups.map((group) => (
            <ProjectionGroupRow key={group.targetMediaId} group={group} />
          ))}
        </div>
      ) : (
        <div className="mt-3 rounded border border-panel-line bg-black/15 p-3 leading-5 text-slate-500">
          这里会按目标原片列出每一集的导出预览。请先在匹配页把参考视频的正片段关联到原片。
          <div className="mt-2">
            <TextButton onClick={onGoMatching}>去匹配页</TextButton>
          </div>
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <TextButton
          tone="primary"
          disabled={exportDisabled}
          title={exportDisabledReason}
          onClick={() => {
            if (exportInFlightRef.current) {
              return;
            }
            exportInFlightRef.current = true;
            setIsExporting(true);
            void exportGroups(projection, project)
              .then((result) => {
                if (result) {
                  setLastExport(result);
                }
              })
              .finally(() => {
                exportInFlightRef.current = false;
                setIsExporting(false);
              });
          }}
        >
          <Download size={14} />
          {isExporting
            ? "正在核验并导出…"
            : lastExport
              ? "再次导出全部分集 XML"
              : "导出全部分集 XML"}
        </TextButton>
      </div>
    </section>
  );
}

function ExportMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-panel-line/70 bg-black/10 px-2 py-1.5">
      <dt className="text-[10px] text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-xs font-medium text-slate-300">
        {value.toLocaleString("zh-CN")} 条
      </dd>
    </div>
  );
}

function isProjectExportSnapshotCurrent(projectSnapshot: EditorProject): boolean {
  const current = useEditorStore.getState().project;
  return (
    current === projectSnapshot &&
    current.id === projectSnapshot.id &&
    current.updatedAt === projectSnapshot.updatedAt
  );
}

async function createVerifiedExportVerificationSeed(
  project: EditorProject,
  projection: SourceProjectionResult,
  currentIdentities: Readonly<Record<string, MediaContentIdentity>>
): Promise<VerifiedExportVerificationSeed> {
  const referencedAssetIds = new Set(
    projection.groups.flatMap((group) =>
      group.segments.flatMap((segment) => (segment.assetId ? [segment.assetId] : []))
    )
  );
  const assetsMissingReceipt = project.assets.filter(
    (asset) => referencedAssetIds.has(asset.id) && asset.sourceReceipt === null
  );
  if (assetsMissingReceipt.length > 0) {
    throw new Error(
      `正式受验证导出所引用的 XML 缺少原文件内容收据：${assetsMissingReceipt
        .map((asset) => asset.fileName)
        .join("、")}。请回到素材页点击“导入 XML”，重新选择原 XML 文件。`
    );
  }
  const referencedMapIds = new Set(
    project.danmakuSourceSegments.flatMap((segment) =>
      segment.kind === "content" && segment.timeMapId ? [segment.timeMapId] : []
    )
  );
  const mediaById = new Map(project.mediaLibrary.map((media) => [media.id, media]));
  const dependencyByMediaId = new Map<string, VerifiedMediaDependency>();
  const appendDependency = (mediaId: string, mapId: string) => {
    const existing = dependencyByMediaId.get(mediaId);
    if (existing) {
      if (!existing.mapIds.includes(mapId)) {
        existing.mapIds.push(mapId);
      }
      return;
    }
    const media = mediaById.get(mediaId);
    const identity = currentIdentities[mediaId];
    if (!media?.localPath?.trim() || !identity) {
      throw new Error(`媒体 ${media?.name ?? mediaId} 缺少可原子复核的本地路径或内容身份。`);
    }
    dependencyByMediaId.set(mediaId, {
      mediaId,
      path: media.localPath.trim(),
      expectedIdentity: { ...identity },
      mapIds: [mapId]
    });
  };

  for (const timeMap of project.mediaTimeMaps) {
    if (timeMap.state !== "confirmed" || !referencedMapIds.has(timeMap.id)) {
      continue;
    }
    appendDependency(timeMap.sourceMediaId, timeMap.id);
    appendDependency(timeMap.targetMediaId, timeMap.id);
  }
  const dependencies = [...dependencyByMediaId.values()];
  if (dependencies.length === 0) {
    throw new Error("导出结果没有可复核的已确认时间图媒体依赖。");
  }
  const mapProofs = await Promise.all(
    project.mediaTimeMaps
      .filter((timeMap) => timeMap.state === "confirmed" && referencedMapIds.has(timeMap.id))
      .map(async (sourceTimeMap): Promise<VerifiedExportMapProof> => {
        const takeoverAt = readTimeMapManualTakeover(sourceTimeMap);
        const manualTakeoverApproved = isTimeMapManualTakeoverExportApproved(sourceTimeMap);
        const sourceAssessment = assessMediaTimeMapVerification(sourceTimeMap);
        const timeMap =
          manualTakeoverApproved && !sourceAssessment.trusted
            ? await issuePersistedManualMediaTimeMapVerification(sourceTimeMap, {
                calibrationArtifactId: "manual-takeover-direct-export",
                calibrationArtifactVersion: "1",
                verifier: "本机用户",
                verifiedAt: takeoverAt ?? new Date().toISOString()
              })
            : sourceTimeMap;
        const exportTakeoverApproved = isTimeMapManualTakeoverExportApproved(timeMap);
        if (
          timeMap.quality.level !== "verified" ||
          (timeMap.spans.some((span) => span.kind === "ambiguous") && !exportTakeoverApproved)
        ) {
          throw new Error(
            `时间图 ${timeMap.id} 尚未达到 verified，或含有未经人工接管明确判为版本替换的 ambiguous span。`
          );
        }
        const record = timeMap.verification;
        if (
          !record ||
          record.recordVersion !== 2 ||
          record.method !== "manual-review" ||
          record.revocation !== null ||
          record.signatureAlgorithm !== "hmac-sha256-v1"
        ) {
          throw new Error(`时间图 ${timeMap.id} 缺少有效的签名人工验证记录。`);
        }
        if (!assessMediaTimeMapVerification(timeMap).trusted) {
          throw new Error(`时间图 ${timeMap.id} 的人工验证尚未通过本机信任复核。`);
        }
        if (!timeMap.sourceIdentity || !timeMap.targetIdentity) {
          throw new Error(`时间图 ${timeMap.id} 缺少两端媒体身份。`);
        }
        const coreDigest = computeMediaTimeMapCoreDigest(timeMap);
        const coreCanonicalJson = createMediaTimeMapCoreCanonicalJson(timeMap);
        if (record.mapCoreDigest !== coreDigest || record.mapRevision !== timeMap.revision) {
          throw new Error(`时间图 ${timeMap.id} 的人工验证没有绑定当前核心或 revision。`);
        }
        const manualRequest = createManualMediaTimeMapVerificationRequest(timeMap, {
          calibrationArtifactId: record.calibrationArtifactId,
          calibrationArtifactVersion: record.calibrationArtifactVersion,
          verifier: record.verifier,
          verifiedAt: record.verifiedAt
        });
        if (manualRequest.requestDigest !== record.requestDigest) {
          throw new Error(`时间图 ${timeMap.id} 的人工验证请求摘要不一致。`);
        }
        return {
          mapId: timeMap.id,
          revision: timeMap.revision,
          state: "confirmed",
          declaredQuality: "verified",
          spanKinds: timeMap.spans.map((span) => span.kind),
          coreDigest,
          coreCanonicalJson,
          sourceMediaId: timeMap.sourceMediaId,
          targetMediaId: timeMap.targetMediaId,
          sourceIdentity: { ...timeMap.sourceIdentity },
          targetIdentity: { ...timeMap.targetIdentity },
          manualVerification: {
            verificationId: record.verificationId,
            issuerKeyId: record.issuerKeyId,
            signatureAlgorithm: record.signatureAlgorithm,
            signature: record.signature,
            requestPayload: manualRequest.payload,
            requestDigest: manualRequest.requestDigest
          }
        };
      })
  );
  if (mapProofs.length !== referencedMapIds.size) {
    throw new Error("被引用时间图与 verified export proofs 未形成一一对应关系。");
  }
  return {
    schemaVersion: 3,
    projectId: project.id,
    projectUpdatedAt: project.updatedAt,
    projectionDerivation: createProjectionDerivation(project, projection),
    mapProofs,
    dependencies
  };
}

function createProjectionDerivation(
  project: EditorProject,
  projection: SourceProjectionResult
): ProjectionDerivationV2 {
  const groupsInFileAllocationOrder = [
    ...projection.groups.filter((group) => group.entries.length > 0),
    ...projection.groups.filter((group) => group.entries.length === 0)
  ];
  const logicalTargetFiles = createStoredZipEntries(
    groupsInFileAllocationOrder.map((group) => ({ fileName: group.exportFileName, content: "" }))
  );
  const logicalFileNameByTarget = new Map(
    groupsInFileAllocationOrder.map((group, groupIndex) => [
      group.targetMediaId,
      logicalTargetFiles[groupIndex].fileName
    ])
  );
  return {
    domain: "projection-derivation-v2",
    projectionPolicyVersion: "source-projection-v1",
    serializerVersion: "bilibili-xml-export-v1",
    projectId: project.id,
    projectUpdatedAt: project.updatedAt,
    media: project.mediaLibrary.map((media) => ({
      mediaId: media.id,
      role: media.role,
      name: media.name,
      mediaFileName: media.fileName,
      durationMs: media.durationMs,
      episodeLabel: media.episodeLabel,
      contentIdentity: media.contentIdentity ? { ...media.contentIdentity } : null
    })),
    xmlAssets: project.assets.map((asset) => ({
      assetId: asset.id,
      sourceFileName: asset.fileName,
      sourceReceipt: asset.sourceReceipt ? { ...asset.sourceReceipt } : null,
      items: asset.items.map((item) => ({
        itemId: item.id,
        assetId: item.assetId,
        originalIndex: item.originalIndex,
        sourceTimeMs: item.sourceTimeMs,
        mode: item.mode,
        fontSize: item.fontSize,
        color: item.color,
        timestamp: item.timestamp,
        pool: item.pool,
        userHash: item.userHash,
        rowId: item.rowId,
        text: item.text,
        rawPFields: [...item.rawPFields],
        enabled: item.enabled
      }))
    })),
    sourceBindings: project.danmakuSourceBindings.map((binding) => ({
      bindingId: binding.id,
      assetId: binding.assetId,
      sourceMediaId: binding.sourceMediaId
    })),
    routes: project.danmakuSourceSegments.map((segment) => ({
      routeId: segment.id,
      kind: segment.kind,
      assetId: segment.assetId,
      sourceMediaId: segment.sourceMediaId,
      sourceStartMs: segment.sourceStartMs,
      sourceEndMs: segment.sourceEndMs,
      targetMediaId: segment.targetMediaId,
      targetStartMs: segment.targetStartMs,
      timeMapId: segment.timeMapId,
      timingRules: segment.timingRules.map((rule) => ({
        ruleId: rule.id,
        sourceAtMs: rule.sourceAtMs,
        gapMs: rule.gapMs
      }))
    })),
    disabledItemIds: [...new Set(project.disabledItemIds)].sort(compareUtf8Strings),
    itemTimeAdjustments: Object.entries(project.itemTimeAdjustments)
      .map(([itemId, adjustmentMs]) => ({ itemId, adjustmentMs }))
      .sort((left, right) => compareUtf8Strings(left.itemId, right.itemId)),
    targetOutputFiles: projection.groups.map((group) => ({
      targetMediaId: group.targetMediaId,
      fileName: logicalFileNameByTarget.get(group.targetMediaId) ?? group.exportFileName
    }))
  };
}

function compareUtf8Strings(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] - rightBytes[index];
    }
  }
  return leftBytes.length - rightBytes.length;
}

function ProjectionGroupRow({ group }: { group: TargetProjectionGroup }) {
  const totalGapMs = group.appliedRules.reduce((sum, rule) => sum + rule.gapMs, 0);
  return (
    <article
      className="performance-list-item rounded border border-panel-line bg-[#111318] p-2"
      data-testid="projection-group"
    >
      <div className="flex items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate text-sm text-slate-100"
          title={group.targetName}
        >
          {group.episodeLabel
            ? `${group.episodeLabel} · ${group.targetName}`
            : group.targetName}
        </span>
        <span className="shrink-0 text-[11px] text-slate-500">{group.exportFileName}</span>
      </div>
      <div className="mt-2 grid gap-1 text-[11px] text-slate-500">
        <div>
          {group.entries.length.toLocaleString("zh-CN")} 条弹幕 · 来自 {group.segments.length}{" "}
          个来源段
          {group.disabledCount > 0 ? ` · ${group.disabledCount} 条已禁用不导出` : ""}
        </div>
        {group.appliedRules.length > 0 ? (
          <div>
            应用 {group.appliedRules.length} 处删减修正，共{" "}
            {formatTimecode(Math.abs(totalGapMs))}
            {totalGapMs < 0 ? "（提前）" : ""}
          </div>
        ) : null}
        {group.warnings.map((warning) => (
          <div key={warning} className="text-accent-yellow">
            {warning}
          </div>
        ))}
      </div>
    </article>
  );
}

function projectionStatusLabel(status: SourceProjectionResult["status"]): string {
  if (status === "empty") {
    return "等待匹配";
  }
  if (status === "blocked") {
    return "有阻断";
  }
  if (status === "readyWithWarnings") {
    return "可导出（有提示）";
  }
  return "可导出";
}

function createBatchExportStatus(result: SaveTextExportResult): EditorStatus {
  const fileCount = result.fileCount.toLocaleString("zh-CN");
  if (result.mode === "directory") {
    return {
      message: `已导出 ${fileCount} 个分集 XML 到 ${result.filePath}${result.wasRenamed ? "（已有同名文件，已自动改名）。" : "。"}`,
      tone: "success",
      action: {
        type: "openDirectory",
        label: "打开目录",
        directoryPath: result.directoryPath
      }
    };
  }
  if (result.archiveFileName) {
    return {
      message: `已触发下载 ${fileCount} 个分集 XML，已打包为 ${result.archiveFileName}。`,
      tone: "success"
    };
  }
  if (result.downloadedFileName) {
    return {
      message: `已触发下载 ${fileCount} 个分集 XML：${result.downloadedFileName}。`,
      tone: "success"
    };
  }
  return { message: `已触发下载 ${fileCount} 个分集 XML。`, tone: "success" };
}

function confidenceLabel(confidence: "high" | "medium" | "low"): string {
  if (confidence === "high") {
    return "高置信";
  }
  if (confidence === "medium") {
    return "中置信";
  }
  return "需复核";
}

function ExportReadinessPanel({
  projectName,
  reportSummary,
  readiness,
  onCleanupEditReferences,
  onCleanupMissingAssetClips
}: {
  projectName: string;
  reportSummary: ReturnType<typeof createProjectHealthSummary>;
  readiness: ProjectReadinessSummary;
  onCleanupEditReferences: () => void;
  onCleanupMissingAssetClips: () => void;
}) {
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const StatusIcon =
    readiness.status === "blocked"
      ? CircleAlert
      : readiness.status === "attention"
        ? TriangleAlert
        : CircleCheck;
  return (
    <section
      className="rounded border border-panel-line bg-panel-soft p-3"
      data-testid="project-health-panel"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
            <StatusIcon size={16} className={projectReadinessIconClass(readiness.status)} />
            <span>导出前检查</span>
          </div>
          <p className="mt-1 text-xs font-medium leading-5 text-slate-300">
            {readiness.headline}
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-500">{readiness.detail}</p>
        </div>
        <span
          className={`shrink-0 rounded border px-2 py-1 text-[11px] ${projectReadinessBadgeClass(readiness.status)}`}
        >
          {readiness.statusLabel}
        </span>
      </div>
      {readiness.items.length > 0 ? (
        <ul className="mt-3 divide-y divide-panel-line border-t border-panel-line">
          {readiness.items.map((item) => (
            <ProjectReadinessItemRow key={item.id} item={item} />
          ))}
        </ul>
      ) : (
        <div className="mt-3 rounded border border-emerald-400/30 bg-emerald-400/10 p-2 text-xs leading-5 text-emerald-100">
          没有需要你现在处理的问题。可以继续编辑，或直接导出 XML。
        </div>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <TextButton
          onClick={() => {
            const fileName = downloadTextFile(
              createProjectDownloadFileName(projectName, "-health-report.txt"),
              createProjectHealthReport(projectName, reportSummary),
              "text/plain;charset=utf-8"
            );
            setStatus({ message: `已导出检查报告：${fileName}。`, tone: "success" });
          }}
        >
          <Download size={14} />
          下载检查报告
        </TextButton>
        {readiness.canCleanupEditReferences ? (
          <TextButton onClick={onCleanupEditReferences}>
            <Trash2 size={14} />
            清理失效调整
          </TextButton>
        ) : null}
        {readiness.canCleanupMissingAssetClips ? (
          <TextButton tone="danger" onClick={onCleanupMissingAssetClips}>
            <Trash2 size={14} />
            移除缺失片段
          </TextButton>
        ) : null}
        <TextButton onClick={() => setDiagnosticsOpen((open) => !open)}>
          {diagnosticsOpen ? "收起诊断详情" : "查看诊断详情"}
        </TextButton>
      </div>
      {diagnosticsOpen ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-panel-line pt-3">
          {readiness.diagnostics.map((diagnostic) => (
            <HealthMetric
              key={diagnostic.label}
              label={diagnostic.label}
              value={diagnostic.value}
            />
          ))}
        </dl>
      ) : null}
    </section>
  );
}

function HealthMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded border border-panel-line/70 bg-black/15 px-2 py-1.5">
      <dt className="truncate text-[11px] text-slate-500">{label}</dt>
      <dd className="truncate text-xs font-medium text-slate-200" title={value}>
        {value}
      </dd>
    </div>
  );
}

function ProjectReadinessItemRow({ item }: { item: ProjectReadinessItem }) {
  const FindingIcon =
    item.severity === "error"
      ? CircleAlert
      : item.severity === "warning"
        ? TriangleAlert
        : CircleCheck;
  return (
    <li className="flex gap-2 py-2 first:pt-3 last:pb-0">
      <FindingIcon
        size={14}
        className={`mt-0.5 shrink-0 ${projectReadinessItemIconClass(item.severity)}`}
      />
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-200">{item.title}</p>
        <p className="mt-0.5 text-[11px] leading-5 text-slate-500">{item.detail}</p>
        {item.evidence.length > 0 ? (
          <ul className="mt-1 grid gap-1 text-[11px] leading-5 text-slate-400">
            {item.evidence.map((evidenceItem) => (
              <li key={evidenceItem} className="break-words">
                {evidenceItem}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

function projectReadinessIconClass(status: ProjectReadinessStatus): string {
  if (status === "blocked") {
    return "text-red-300";
  }
  if (status === "attention") {
    return "text-amber-300";
  }
  return "text-emerald-300";
}

function projectReadinessBadgeClass(status: ProjectReadinessStatus): string {
  if (status === "blocked") {
    return "border-red-400/40 bg-red-400/10 text-red-200";
  }
  if (status === "attention") {
    return "border-amber-400/40 bg-amber-400/10 text-amber-200";
  }
  return "border-emerald-400/40 bg-emerald-400/10 text-emerald-200";
}

function projectReadinessItemIconClass(severity: ProjectReadinessItem["severity"]): string {
  if (severity === "error") {
    return "text-red-300";
  }
  if (severity === "warning") {
    return "text-amber-300";
  }
  return "text-emerald-300";
}

function formatMatchSourceSummary(assessment: ProjectMatchAssessment): string {
  if (assessment.source.itemCount === 0) {
    return `${assessment.source.assetCount} 个 XML / 暂无弹幕`;
  }
  const endText =
    assessment.source.sourceEndMs === null
      ? "未知"
      : formatTimecode(assessment.source.sourceEndMs);
  return `${assessment.source.assetCount} 个 XML / ${assessment.source.itemCount.toLocaleString("zh-CN")} 条 / 到 ${endText}`;
}

function projectMatchBadgeClass(conclusion: ProjectMatchAssessment["conclusion"]): string {
  if (conclusion === "likely") {
    return "border-emerald-400/40 bg-emerald-400/10 text-emerald-200";
  }
  if (conclusion === "unlikely") {
    return "border-red-400/40 bg-red-400/10 text-red-200";
  }
  return "border-amber-400/40 bg-amber-400/10 text-amber-200";
}

function projectMatchScoreClass(conclusion: ProjectMatchAssessment["conclusion"]): string {
  if (conclusion === "likely") {
    return "border-emerald-400/30 bg-emerald-400/10 text-emerald-100";
  }
  if (conclusion === "unlikely") {
    return "border-red-400/30 bg-red-400/10 text-red-100";
  }
  return "border-amber-400/30 bg-amber-400/10 text-amber-100";
}

function projectMatchCriterionClass(state: ProjectMatchCriterionState): string {
  if (state === "positive") {
    return "text-emerald-300";
  }
  if (state === "negative") {
    return "text-red-300";
  }
  if (state === "warning") {
    return "text-amber-300";
  }
  return "text-slate-400";
}

function projectMatchCriterionStateText(state: ProjectMatchCriterionState): string {
  if (state === "positive") {
    return "有利";
  }
  if (state === "negative") {
    return "冲突";
  }
  if (state === "warning") {
    return "待确认";
  }
  return "中性";
}

function formatProjectMediaReferenceKind(media: ProjectMediaReference): string {
  if (media.referenceKind === "localPath") {
    return media.localPath ? `本地路径：${media.localPath}` : "本地路径待补齐";
  }
  if (media.referenceKind === "embyItem") {
    return media.emby ? `Emby：${media.emby.itemName}` : "Emby 摘要";
  }
  return media.objectUrl ? "临时浏览器引用，保存后需重连" : "临时浏览器引用，当前需要重连";
}

function confidenceText(confidence: "high" | "medium" | "low"): string {
  if (confidence === "high") {
    return "高置信";
  }
  if (confidence === "medium") {
    return "中置信";
  }
  return "低置信";
}

function anchorOriginText(origin: SyncAnchor["origin"]): string {
  return origin === "manual" ? "手动" : "自动";
}

function formatSignedDuration(milliseconds: number): string {
  const sign = milliseconds < 0 ? "-" : "+";
  return `${sign}${formatTimecode(Math.abs(milliseconds))}`;
}

function formatCandidateSourceRange(candidate: {
  sourceRangeStartMs?: number;
  sourceRangeEndMs?: number;
}): string {
  if (
    candidate.sourceRangeStartMs === undefined ||
    candidate.sourceRangeEndMs === undefined ||
    candidate.sourceRangeEndMs <= candidate.sourceRangeStartMs
  ) {
    return "";
  }
  return ` / 区间 ${formatTimecode(candidate.sourceRangeStartMs)}-${formatTimecode(candidate.sourceRangeEndMs)}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[72px_minmax(0,1fr)] gap-2">
      <dt className="min-w-0 truncate text-slate-500">{label}</dt>
      <dd className="truncate text-slate-300" title={value}>
        {value}
      </dd>
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded border border-dashed border-panel-line bg-black/20 p-4 text-center">
      <h3 className="text-sm font-medium text-slate-200">{title}</h3>
      <p className="mt-2 text-xs leading-5 text-slate-500">{text}</p>
    </div>
  );
}
