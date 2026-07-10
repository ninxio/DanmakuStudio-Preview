import {
  CircleAlert,
  CircleCheck,
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
import { useEffect, useMemo, useRef, useState } from "react";
import { TextButton } from "../../components/TextButton";
import {
  createAlignmentApplyBlockers,
  createAlignmentReviewFocus,
  createAlignmentReviewItemStatuses,
  createAlignmentReviewQueue,
  createAlignmentReviewReport,
  createAlignmentReviewStatusSummary,
  type AlignmentReviewItemState,
  type AlignmentReviewQueueSeverity
} from "../../domain/alignment/alignmentReport";
import { createAnchorCalibrationProposal } from "../../domain/alignment/anchorCalibration";
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
import { parseCutPointsText, parseEpisodeDurationsText, parseMinutesInput } from "../../domain/danmaku/manualRules";
import type { CutMarker, SyncAnchor } from "../../domain/danmaku/types";
import {
  createProjectHealthReport,
  createProjectHealthSummary
} from "../../domain/project/health";
import { createProjectDownloadFileName } from "../../domain/project/fileNames";
import {
  createProjectReadinessSummary,
  type ProjectReadinessItem,
  type ProjectReadinessStatus,
  type ProjectReadinessSummary
} from "../../domain/project/readiness";
import type { EditorProject } from "../../domain/project/types";
import { formatTimecode } from "../../domain/shared/time";
import { getAssetTimeRange } from "../../domain/timeline/mapping";
import {
  cancelTauriAudioAlignmentJob,
  getTauriAudioAlignmentJob,
  isAudioAlignmentJobFinished,
  startTauriAudioAlignmentJob,
  type AudioAlignmentJobSnapshot
} from "../../infrastructure/alignment/tauriAudioAlignment";
import {
  downloadTextFile,
  downloadTextFiles,
  readTextFile,
  type DownloadTextFilesResult
} from "../../infrastructure/file-system/browserFiles";
import { pickAlignmentMediaPath, pickFfmpegExecutablePath } from "../../infrastructure/file-system/nativeDialogs";
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
import { hydrateDesktopAppSettings } from "../../infrastructure/settings/desktopAppSettings";
import { loadVolatileEmbyPassword } from "../../infrastructure/settings/volatileEmbyCredentials";
import { serializeBilibiliXml, validateExportedXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore, type EditorStatus } from "../../stores/editorStore";

type AssetTab = "media" | "danmaku" | "project";
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

export function AssetPanel() {
  const [tab, setTab] = useState<AssetTab>("danmaku");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [partWindowMode, setPartWindowMode] = useState<PartWindowMode>("full");
  const [partWindowMinutes, setPartWindowMinutes] = useState("9");
  const [partRangeStartMinutes, setPartRangeStartMinutes] = useState("0");
  const [partRangeEndMinutes, setPartRangeEndMinutes] = useState("9");
  const [longSplitMode, setLongSplitMode] = useState<LongSplitMode>("auto");
  const [episodeDurationsText, setEpisodeDurationsText] = useState("");
  const [cutPointsText, setCutPointsText] = useState("");
  const [anchorCalibrationText, setAnchorCalibrationText] = useState("");
  const [alignmentProposalText, setAlignmentProposalText] = useState("");
  const lastSyncedAlignmentProposalTextRef = useRef("");
  const lastAlignmentProjectIdRef = useRef<string | null>(null);
  const project = useEditorStore((state) => state.project);
  const selection = useEditorStore((state) => state.selection);
  const alignmentProposal = useEditorStore((state) => state.alignmentProposal);
  const cutHintSettings = useEditorStore((state) => state.cutHintSettings);
  const importProgress = useEditorStore((state) => state.importProgress);
  const addAssetToTimeline = useEditorStore((state) => state.addAssetToTimeline);
  const removeAsset = useEditorStore((state) => state.removeAsset);
  const removeAssetFromTimeline = useEditorStore((state) => state.removeAssetFromTimeline);
  const removeMedia = useEditorStore((state) => state.removeMedia);
  const autoArrangeClips = useEditorStore((state) => state.autoArrangeClips);
  const select = useEditorStore((state) => state.select);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const addCutMarker = useEditorStore((state) => state.addCutMarker);
  const updateCutMarker = useEditorStore((state) => state.updateCutMarker);
  const deleteCutMarker = useEditorStore((state) => state.deleteCutMarker);
  const updateSyncAnchor = useEditorStore((state) => state.updateSyncAnchor);
  const deleteSyncAnchor = useEditorStore((state) => state.deleteSyncAnchor);
  const importAlignmentProposalText = useEditorStore((state) => state.importAlignmentProposalText);
  const applyAlignmentProposal = useEditorStore((state) => state.applyAlignmentProposal);
  const clearAlignmentProposal = useEditorStore((state) => state.clearAlignmentProposal);
  const previewAlignmentProposalData = useEditorStore((state) => state.previewAlignmentProposalData);
  const applyAlignmentProposalData = useEditorStore((state) => state.applyAlignmentProposalData);
  const setCutHintSettings = useEditorStore((state) => state.setCutHintSettings);
  const cleanupProjectEditReferences = useEditorStore((state) => state.cleanupProjectEditReferences);
  const cleanupProjectMissingAssetClips = useEditorStore((state) => state.cleanupProjectMissingAssetClips);
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
  const cutHintSearch = useMemo(() => createCutHintSearchPlan(cutHintSettings), [cutHintSettings]);
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
      <div className="grid h-10 shrink-0 grid-cols-3 border-b border-panel-line text-xs">
        <TabButton active={tab === "media"} onClick={() => setTab("media")}>
          媒体
        </TabButton>
        <TabButton active={tab === "danmaku"} onClick={() => setTab("danmaku")}>
          弹幕素材
        </TabButton>
        <TabButton active={tab === "project"} onClick={() => setTab("project")}>
          导出检查
        </TabButton>
      </div>
      <div className="thin-scrollbar min-h-0 flex-1 overflow-auto p-3">
        {tab === "media" ? (
          <div className="grid gap-3">
            {project.media ? (
              <div className="rounded border border-panel-line bg-panel-soft p-3">
                <div className="flex items-center gap-2 text-sm text-slate-100">
                  <Video size={16} className="text-accent-cyan" />
                  <span className="truncate">{project.media.fileName}</span>
                </div>
                <dl className="mt-3 grid gap-2 text-xs text-slate-400">
                  <Row label="名称" value={project.media.name} />
                  <Row label="时长" value={formatTimecode(project.media.durationMs ?? 0)} />
                  <Row label="引用" value="本地浏览器对象 URL" />
                </dl>
                <div className="mt-3 flex flex-wrap gap-2">
                  <TextButton tone="danger" onClick={removeMedia}>
                    <Trash2 size={14} />
                    删除
                  </TextButton>
                </div>
              </div>
            ) : (
              <EmptyState title="尚未导入视频" text="使用顶部“导入视频”选择 MP4 或 WebM。" />
            )}
          </div>
        ) : null}
        {tab === "danmaku" ? (
          <div className="grid gap-3">
            <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
              <h3 className="text-sm font-medium text-slate-100">下一步</h3>
              <p className="mt-2 leading-5 text-slate-500">
                {project.assets.length === 0
                  ? "先导入 B 站 XML 弹幕文件。导入后，它们会出现在下面的素材列表里。"
                  : project.clips.length === 0
                    ? "把弹幕素材放到时间轴。多分 P 文件可以直接按顺序排列。"
                    : "现在可以在时间轴预览和微调弹幕；遇到视频版本删减时，用“标记版本差异”。"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <TextButton onClick={autoArrangeClips} disabled={project.assets.length === 0}>
                  <Shuffle size={14} />
                  按顺序放入时间轴
                </TextButton>
                <TextButton
                  tone="primary"
                  onClick={() => exportBatchMergePlan(batchMergePlan, project.name)}
                  disabled={batchMergePlan.episodes.length === 0}
                  title="按当前批量规则导出多个分集 XML"
                >
                  <Download size={14} />
                  导出分集 XML
                </TextButton>
              </div>
            </section>
            {importProgress !== null ? (
              <div className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
                正在导入 XML... {Math.round(importProgress * 100)}%
              </div>
            ) : null}
            {project.assets.length === 0 ? (
              <EmptyState title="尚未导入 XML" text="可一次选择多个 Bilibili XML 分 P 文件。" />
            ) : (
              project.assets.map((asset) => {
                const range = getAssetTimeRange(asset);
                const inTimeline = project.clips.some((clip) => clip.assetId === asset.id);
                return (
                  <article
                    key={asset.id}
                    className="rounded border border-panel-line bg-panel-soft p-3"
                    data-testid="asset-card"
                  >
                    <div className="flex items-center gap-2">
                      <span className="h-3 w-3 rounded-sm" style={{ background: asset.color }} />
                      <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-slate-100">{asset.fileName}</h3>
                    </div>
                    <dl className="mt-3 grid gap-1 text-xs text-slate-400">
                      <Row label="弹幕数量" value={asset.items.length.toLocaleString("zh-CN")} />
                      <Row label="最早时间" value={formatTimecode(range.earliestMs)} />
                      <Row label="最晚时间" value={formatTimecode(range.latestMs)} />
                      <Row label="状态" value={inTimeline ? "已放入时间轴" : "未放入时间轴"} />
                      <Row label="导入警告" value={asset.warnings.length.toString()} />
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
                            const clip = project.clips.find((candidate) => candidate.assetId === asset.id);
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
                        <TextButton title="从时间轴移出，保留资源" onClick={() => removeAssetFromTimeline(asset.id)}>
                          <ListX size={14} />
                          移出
                        </TextButton>
                      ) : null}
                      <TextButton tone="danger" title="删除资源及关联片段" onClick={() => removeAsset(asset.id)}>
                        <Trash2 size={14} />
                        删除
                      </TextButton>
                    </div>
                  </article>
                );
              })
            )}
            <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 text-left"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((open) => !open)}
              >
                <span>
                  <span className="block text-sm font-medium text-slate-100">高级工具</span>
                  <span className="mt-1 block leading-5 text-slate-500">
                    Emby 时长、批量整理、版本差异列表、差异扫描和视频对齐都在这里。
                  </span>
                </span>
                <span className="shrink-0 rounded border border-panel-line px-2 py-1 text-[11px] text-slate-300">
                  {advancedOpen ? "收起" : "展开"}
                </span>
              </button>
              {advancedOpen ? (
                <div className="mt-3 grid gap-3">
                  <EmbyMetadataPanel
                    onImportDurationLines={(lines) => {
                      setEpisodeDurationsText(lines);
                      setLongSplitMode("durations");
                      setStatus({ message: "已把 Emby 剧集时长导入批量整理规则。", tone: "success" });
                    }}
                  />
                  {project.assets.length > 0 ? (
                    <>
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
                      <SuspectedCutPanel
                        candidates={suspectedCutCandidates}
                        cutMarkers={project.cutMarkers}
                        keywordsText={cutHintSettings.keywordsText}
                        windowSeconds={cutHintSettings.windowSeconds}
                        minHitCount={cutHintSettings.minHitCount}
                        warnings={cutHintSearch.warnings}
                        onKeywordsTextChange={(keywordsText) => setCutHintSettings({ keywordsText })}
                        onWindowSecondsChange={(windowSeconds) => setCutHintSettings({ windowSeconds })}
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
                      <SyncAnchorsPanel
                        anchors={project.syncAnchors}
                        onFocus={(anchor) => setPlayhead(anchor.sourceMs)}
                        onUpdate={updateSyncAnchor}
                        onDelete={deleteSyncAnchor}
                      />
                      <VideoAlignmentLabPanel
                        project={project}
                        text={alignmentProposalText}
                        proposal={alignmentProposal}
                        preview={alignmentPreview}
                        onTextChange={setAlignmentProposalText}
                        onImportText={importAlignmentProposalText}
                        onApply={applyAlignmentProposal}
                        onClear={() => {
                          if (alignmentProposal) {
                            clearAlignmentProposal();
                          } else {
                            setStatus({ message: "已清空对齐提案草稿。", tone: "neutral" });
                          }
                          setAlignmentProposalText("");
                        }}
                        onFocusQueueItem={(sourceAtMs, name) => {
                          setPlayhead(sourceAtMs);
                          setStatus({
                            message: `已定位复核项：${name}（${formatTimecode(sourceAtMs)}）。`,
                            tone: "success"
                          });
                        }}
                      />
                      <BatchMergeSummary plan={batchMergePlan} warnings={manualRules.warnings} />
                    </>
                  ) : (
                    <EmptyState title="先导入 XML" text="高级工具会基于已导入的弹幕素材生成规则和候选。" />
                  )}
                </div>
              ) : null}
            </section>
          </div>
        ) : null}
        {tab === "project" ? (
          <div className="grid gap-3 text-xs text-slate-400">
            <ExportReadinessPanel
              projectName={project.name}
              reportSummary={projectHealth}
              readiness={projectReadiness}
              onCleanupEditReferences={cleanupProjectEditReferences}
              onCleanupMissingAssetClips={cleanupProjectMissingAssetClips}
            />
            <div className="rounded border border-panel-line bg-panel-soft p-3">
              <h3 className="mb-2 text-sm font-medium text-slate-100">{project.name}</h3>
              <Row label="资源数" value={project.assets.length.toString()} />
              <Row label="片段数" value={project.clips.length.toString()} />
              <Row label="版本差异" value={project.cutMarkers.length.toString()} />
              <Row label="同步线索" value={project.syncAnchors.length.toString()} />
              <Row label="禁用弹幕" value={project.disabledItemIds.length.toString()} />
              <Row label="全局偏移" value={`${project.globalOffsetMs} ms`} />
              <Row label="创建时间" value={new Date(project.createdAt).toLocaleString("zh-CN")} />
              <Row label="更新时间" value={new Date(project.updatedAt).toLocaleString("zh-CN")} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const EMBY_INPUT_CLASS =
  "h-8 min-w-0 w-full rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100";

function EmbyMetadataPanel({ onImportDurationLines }: { onImportDurationLines: (lines: string) => void }) {
  const [itemId, setItemId] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [sessionState, setSessionState] = useState<EmbySessionState | null>(null);
  const [loadedItem, setLoadedItem] = useState<EmbyItemMetadata | null>(null);
  const [episodeItems, setEpisodeItems] = useState<EmbyItemMetadata[]>([]);
  const [searchResults, setSearchResults] = useState<EmbyItemMetadata[]>([]);
  const [durationLines, setDurationLines] = useState("");
  const [loading, setLoading] = useState<EmbyLoadingKind | null>(null);
  const selectedItemId = itemId.trim();
  const hasSelectedItem = selectedItemId.length > 0;

  async function runAction<T>(kind: EmbyLoadingKind, action: () => Promise<T>): Promise<T | null> {
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
      authenticateEmby(connection.config, { username: connection.username, password: connection.password })
    );
    if (nextSession) {
      setSessionState({ key: connection.sessionKey, session: nextSession });
      setSearchResults([]);
      setStatus({ message: `Emby 已登录：${nextSession.userName || nextSession.userId}`, tone: "success" });
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
        message: items.length > 0 ? `已找到 ${items.length} 个 Emby 候选条目。` : "没有找到匹配的 Emby 条目。",
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

  const readItem = async () => {
    if (!hasSelectedItem) {
      setStatus({ message: "请先从搜索结果中选择一个 Emby 条目。", tone: "warning" });
      return;
    }
    const ready = await ensureSession();
    if (!ready) {
      return;
    }
    const item = await runAction("item", () => fetchEmbyItem(ready.connection.config, ready.session, selectedItemId));
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
        message: lines.length > 0 ? `已读取 ${items.length} 个 Emby 剧集条目。` : "未读到带时长的 Emby 剧集。",
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
            <span className="truncate">{loading === "auth" ? "连接中" : loading === "search" ? "搜索中" : "搜索"}</span>
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
                <span className="truncate text-[11px] text-slate-500">{formatEmbySearchResultMeta(item)}</span>
              </button>
            ))}
          </div>
        ) : null}
        {loadedItem ? (
          <div className="min-w-0 rounded border border-panel-line bg-black/20 p-2">
            <Row label="条目" value={loadedItem.name} />
            <Row label="类型" value={loadedItem.type} />
            <Row label="时长" value={loadedItem.durationMs === null ? "未知" : formatTimecode(loadedItem.durationMs)} />
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
                <span className="truncate">{loading === "episodes" ? "读取中" : "读取下级剧集"}</span>
              </TextButton>
              {loadedItem.durationMs !== null ? (
                <TextButton className="w-full min-w-0 px-2" onClick={importLoadedItemDuration}>
                  <span className="truncate">导入单条时长</span>
                </TextButton>
              ) : null}
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
              <span className="min-w-0 truncate text-slate-500">{episodeItems.length} 个条目</span>
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
    setStatus({ message: "请先在设置中心填写本次会话密码。密码不会写入本地设置。", tone: "warning" });
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

function BatchMergeSummary({ plan, warnings }: { plan: ReturnType<typeof buildBatchMergePlan>; warnings: string[] }) {
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
              <span className="truncate" title={`${episode.label}：${episode.sourceFileNames.join("、")}`}>
                {episode.label}
              </span>
              <span className="text-slate-500">{episode.itemCount.toLocaleString("zh-CN")} 条</span>
            </div>
          ))}
          {hiddenCount > 0 ? <p className="text-slate-500">另有 {hiddenCount} 个输出。</p> : null}
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
              {plan.compensation.affectedEpisodeCount} 个输出，{plan.compensation.affectedEntryCount.toLocaleString("zh-CN")} 条弹幕
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
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
          <div className="text-slate-500">暂无版本差异。可在时间轴标记，或从删减扫描、对齐线索生成。</div>
        )}
        {markers.map((marker) => {
          const selected = selectedIds.includes(marker.id);
          return (
            <article
              key={marker.id}
              className={`grid gap-2 rounded border p-2 ${
                selected ? "border-accent-cyan bg-accent-cyan/10" : "border-panel-line bg-black/20"
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
                    {formatTimecode(marker.sourceAtMs)} / {formatSignedDuration(marker.targetGapMs)}
                  </span>
                </button>
                <TextButton aria-label={`删除版本差异 ${marker.name}`} tone="danger" onClick={() => onDelete(marker.id)}>
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
                    onChange={(event) => onUpdate(marker.id, { sourceAtMs: Number(event.target.value) })}
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-slate-500">相差 ms</span>
                  <input
                    aria-label={`${marker.name} 相差 ms`}
                    className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
                    inputMode="numeric"
                    value={marker.targetGapMs}
                    onChange={(event) => onUpdate(marker.id, { targetGapMs: Number(event.target.value) })}
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
            <div key={candidate.id} className="grid gap-2 border-t border-panel-line pt-2 first:border-t-0 first:pt-0">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <div className="min-w-0">
                  <div className="truncate text-slate-100" title={candidate.assetFileName}>
                    {formatTimecode(candidate.sourceAtMs)} / {candidate.assetFileName}
                  </div>
                  <div className="mt-1 truncate text-slate-500" title={candidate.sampleTexts.join(" / ")}>
                    {candidate.hitCount} 条 / {candidate.keywords.join("、")} / {confidenceText(candidate.confidence)}
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
              <div className="truncate text-[11px] text-slate-500" title={candidate.sampleTexts.join(" / ")}>
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
              <TextButton
                disabled={proposal.anchors.length === 0}
                onClick={onPreview}
              >
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
  const sortedAnchors = [...anchors].sort((left, right) => left.sourceMs - right.sourceMs || left.id.localeCompare(right.id));
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
            <article key={anchor.id} className="grid gap-2 rounded border border-panel-line bg-black/20 p-2">
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
                <TextButton aria-label={`删除${label}`} tone="danger" onClick={() => onDelete(anchor.id)}>
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
                    onChange={(event) => onUpdate(anchor.id, { sourceMs: Number(event.target.value) })}
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-slate-500">完整版时间 ms</span>
                  <input
                    aria-label={`${label} 完整版时间 ms`}
                    className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
                    inputMode="numeric"
                    value={anchor.targetMs}
                    onChange={(event) => onUpdate(anchor.id, { targetMs: Number(event.target.value) })}
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

function VideoAlignmentLabPanel({
  project,
  text,
  proposal,
  preview,
  onTextChange,
  onImportText,
  onApply,
  onClear,
  onFocusQueueItem
}: {
  project: EditorProject;
  text: string;
  proposal: AlignmentProposal | null;
  preview: ReturnType<typeof buildAlignmentPreview>;
  onTextChange: (value: string) => void;
  onImportText: (value: string, sourceFileName?: string) => void;
  onApply: () => void;
  onClear: () => void;
  onFocusQueueItem: (sourceAtMs: number, name: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const initialSettingsRef = useRef(loadAppSettings());
  const [completePath, setCompletePath] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [ffmpegPath, setFfmpegPath] = useState(initialSettingsRef.current.alignment.ffmpegPath);
  const [windowMs, setWindowMs] = useState(String(initialSettingsRef.current.alignment.windowMs));
  const [minGapMs, setMinGapMs] = useState(String(initialSettingsRef.current.alignment.minGapMs));
  const [matchThreshold, setMatchThreshold] = useState(String(initialSettingsRef.current.alignment.matchThreshold));
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobSnapshot, setJobSnapshot] = useState<AudioAlignmentJobSnapshot | null>(null);
  const runTokenRef = useRef(0);
  const previewCuts = preview.proposalCuts.slice(0, 3);
  const canRunAlignment = completePath.trim().length > 0 && sourcePath.trim().length > 0 && !running;
  const downloadContent = getAlignmentProposalDownloadText(text, proposal);
  const canClearProposal = Boolean(proposal) || text.trim().length > 0;
  const reviewFocus = proposal ? createAlignmentReviewFocus(proposal) : [];
  const applyBlockerContext = {
    existingAnchors: project.syncAnchors,
    existingCutMarkers: project.cutMarkers
  };
  const applyBlockers = proposal ? createAlignmentApplyBlockers(proposal, applyBlockerContext) : [];
  const reviewItemStatuses = proposal ? createAlignmentReviewItemStatuses(proposal, applyBlockerContext) : [];
  const reviewStatusSummary = createAlignmentReviewStatusSummary(reviewItemStatuses);
  const reviewQueue = proposal ? createAlignmentReviewQueue(proposal, applyBlockerContext) : [];
  const visibleReviewQueue = reviewQueue.slice(0, 4);
  const hiddenReviewQueueCount = reviewQueue.length - visibleReviewQueue.length;
  const visibleReviewItemStatuses = reviewItemStatuses.slice(0, 5);
  const hiddenReviewItemStatusCount = reviewItemStatuses.length - visibleReviewItemStatuses.length;

  useEffect(() => {
    let mounted = true;
    const initialSettings = initialSettingsRef.current;
    void hydrateDesktopAppSettings()
      .then((desktopSettings) => {
        if (!mounted || !desktopSettings) {
          return;
        }
        setFfmpegPath((current) =>
          current === initialSettings.alignment.ffmpegPath ? desktopSettings.alignment.ffmpegPath : current
        );
        setWindowMs((current) =>
          current === String(initialSettings.alignment.windowMs) ? String(desktopSettings.alignment.windowMs) : current
        );
        setMinGapMs((current) =>
          current === String(initialSettings.alignment.minGapMs) ? String(desktopSettings.alignment.minGapMs) : current
        );
        setMatchThreshold((current) =>
          current === String(initialSettings.alignment.matchThreshold)
            ? String(desktopSettings.alignment.matchThreshold)
            : current
        );
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const runDesktopAlignment = async () => {
    const parsedWindowMs = parsePositiveIntegerInput(windowMs, "窗口");
    const parsedMinGapMs = parseNonNegativeIntegerInput(minGapMs, "最小缺失");
    const parsedMatchThreshold = parsePositiveNumberInput(matchThreshold, "匹配阈值");
    if (parsedWindowMs.error || parsedMinGapMs.error || parsedMatchThreshold.error) {
      setStatus({
        message: parsedWindowMs.error ?? parsedMinGapMs.error ?? parsedMatchThreshold.error ?? "对齐参数无效。",
        tone: "warning"
      });
      return;
    }
    const request = {
      completePath: completePath.trim(),
      sourcePath: sourcePath.trim(),
      ffmpegPath: ffmpegPath.trim().length > 0 ? ffmpegPath.trim() : null,
      windowMs: parsedWindowMs.value,
      minGapMs: parsedMinGapMs.value,
      matchThreshold: parsedMatchThreshold.value
    };
    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    setRunning(true);
    setCancelling(false);
    setJobSnapshot(null);
    setActiveJobId(null);
    try {
      let snapshot = await startTauriAudioAlignmentJob(request);
      if (runTokenRef.current !== runToken) {
        return;
      }
      setActiveJobId(snapshot.jobId);
      setJobSnapshot(snapshot);
      setStatus({ message: snapshot.message, tone: "success" });
      while (!isAudioAlignmentJobFinished(snapshot.status)) {
        await waitForAudioAlignmentPoll();
        if (runTokenRef.current !== runToken) {
          return;
        }
        snapshot = await getTauriAudioAlignmentJob(snapshot.jobId);
        if (runTokenRef.current !== runToken) {
          return;
        }
        setJobSnapshot(snapshot);
      }
      if (snapshot.status === "cancelled") {
        setStatus({ message: snapshot.message || "本地音频对齐已取消。", tone: "warning" });
        return;
      }
      if (snapshot.status === "failed" || !snapshot.proposal) {
        throw new Error(snapshot.error ?? snapshot.message ?? "本地音频对齐失败。");
      }
      const content = `${JSON.stringify(snapshot.proposal, null, 2)}\n`;
      onTextChange(content);
      onImportText(content);
      setStatus({ message: "本地音频对齐完成，已导入候选提案。", tone: "success" });
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "本地音频对齐失败。",
        tone: "error"
      });
    } finally {
      if (runTokenRef.current === runToken) {
        setRunning(false);
        setCancelling(false);
        setActiveJobId(null);
      }
    }
  };

  const cancelDesktopAlignment = async () => {
    if (!activeJobId || cancelling) {
      return;
    }
    setCancelling(true);
    try {
      const snapshot = await cancelTauriAudioAlignmentJob(activeJobId);
      setJobSnapshot(snapshot);
      setStatus({ message: snapshot.message, tone: "warning" });
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "取消音频对齐任务失败。",
        tone: "error"
      });
    }
  };

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
      setStatus({ message: "暂无可导出的对齐报告。", tone: "warning" });
      return;
    }
    const fileName = downloadTextFile(
      createProjectDownloadFileName(project.name, "-alignment-review-report.txt"),
      createAlignmentReviewReport(proposal, new Date(), applyBlockerContext),
      "text/plain;charset=utf-8"
    );
    setStatus({ message: `已导出对齐复核报告：${fileName}。`, tone: "success" });
  };

  const chooseCompletePath = async () => {
    try {
      const path = await pickAlignmentMediaPath(completePath);
      if (path) {
        setCompletePath(path);
        setStatus({ message: "已选择完整版路径。", tone: "success" });
      }
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "完整版路径选择失败。",
        tone: "error"
      });
    }
  };

  const chooseSourcePath = async () => {
    try {
      const path = await pickAlignmentMediaPath(sourcePath);
      if (path) {
        setSourcePath(path);
        setStatus({ message: "已选择当前视频路径。", tone: "success" });
      }
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "当前视频路径选择失败。",
        tone: "error"
      });
    }
  };

  const chooseFfmpegPath = async () => {
    try {
      const path = await pickFfmpegExecutablePath(ffmpegPath);
      if (path) {
        setFfmpegPath(path);
        setStatus({ message: "已选择 FFmpeg 路径。", tone: "success" });
      }
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "FFmpeg 路径选择失败。",
        tone: "error"
      });
    }
  };

  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
        <Video size={15} className="text-accent-cyan" />
        <span>视频对齐实验室</span>
        {proposal ? (
          <span className="ml-auto text-[11px] text-slate-500">
            待应用 {reviewStatusSummary.pendingCount} / 已落点 {reviewStatusSummary.appliedCount}
            {reviewStatusSummary.blockedCount > 0 ? ` / 阻断 ${reviewStatusSummary.blockedCount}` : ""}
          </span>
        ) : null}
      </div>
      <div className="mt-3 grid gap-2">
        <label className="grid gap-1">
          <span className="text-slate-500">完整版路径</span>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <input
              aria-label="完整版路径"
              className="h-8 min-w-0 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              value={completePath}
              placeholder="D:\\media\\full.mkv"
              onChange={(event) => setCompletePath(event.target.value)}
            />
            <TextButton
              aria-label="选择完整版"
              title="选择完整版"
              onClick={() => {
                void chooseCompletePath();
              }}
              className="px-2"
            >
              <FolderOpen size={14} />
              选择
            </TextButton>
          </div>
        </label>
        <label className="grid gap-1">
          <span className="text-slate-500">当前视频路径</span>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <input
              aria-label="当前视频路径"
              className="h-8 min-w-0 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              value={sourcePath}
              placeholder="D:\\media\\bilibili-cut.mp4"
              onChange={(event) => setSourcePath(event.target.value)}
            />
            <TextButton
              aria-label="选择当前视频"
              title="选择当前视频"
              onClick={() => {
                void chooseSourcePath();
              }}
              className="px-2"
            >
              <FolderOpen size={14} />
              选择
            </TextButton>
          </div>
        </label>
        <label className="grid gap-1">
          <span className="text-slate-500">FFmpeg 路径</span>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <input
              aria-label="FFmpeg 路径"
              className="h-8 min-w-0 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              value={ffmpegPath}
              placeholder="留空使用 PATH 中的 ffmpeg"
              onChange={(event) => setFfmpegPath(event.target.value)}
            />
            <TextButton
              aria-label="选择 FFmpeg"
              title="选择 FFmpeg"
              onClick={() => {
                void chooseFfmpegPath();
              }}
              className="px-2"
            >
              <FolderOpen size={14} />
              选择
            </TextButton>
          </div>
        </label>
        <div className="grid grid-cols-3 gap-2">
          <label className="grid gap-1">
            <span className="text-slate-500">窗口 ms</span>
            <input
              className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              inputMode="numeric"
              value={windowMs}
              onChange={(event) => setWindowMs(event.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-slate-500">最小缺失 ms</span>
            <input
              className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              inputMode="numeric"
              value={minGapMs}
              onChange={(event) => setMinGapMs(event.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-slate-500">匹配阈值</span>
            <input
              className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              inputMode="decimal"
              value={matchThreshold}
              onChange={(event) => setMatchThreshold(event.target.value)}
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <TextButton
            tone="primary"
            onClick={() => {
              void runDesktopAlignment();
            }}
            disabled={!canRunAlignment}
          >
            {running ? "对齐中" : "运行本地对齐"}
          </TextButton>
          <TextButton
            onClick={() => {
              void cancelDesktopAlignment();
            }}
            disabled={!activeJobId || cancelling || !running}
          >
            {cancelling ? "取消中" : "取消任务"}
          </TextButton>
        </div>
        {jobSnapshot ? (
          <div className="grid gap-1 rounded border border-panel-line bg-black/20 p-2 text-slate-400">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{jobSnapshot.message}</span>
              <span className="shrink-0 text-slate-500">
                {Math.round(jobSnapshot.progress * 100)}%
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded bg-[#111318]">
              <div
                className="h-full rounded bg-accent-cyan"
                style={{ width: `${Math.round(jobSnapshot.progress * 100)}%` }}
              />
            </div>
            <div className="text-[11px] text-slate-500">
              任务 {jobSnapshot.jobId} / {alignmentJobStatusText(jobSnapshot.status)}
            </div>
            {jobSnapshot.logs.length > 0 ? (
              <details className="rounded border border-panel-line bg-[#111318] p-2 text-[11px] text-slate-400">
                <summary className="cursor-pointer text-slate-300">任务日志</summary>
                <ol className="mt-2 grid gap-1">
                  {jobSnapshot.logs.slice(-8).map((item, index) => (
                    <li key={`${item}-${index}`} className="break-words">
                      {item}
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
          </div>
        ) : null}
        <textarea
          className="min-h-24 resize-y rounded border border-panel-line bg-[#111318] p-2 font-mono text-xs leading-5 text-slate-100"
          value={text}
          placeholder="AlignmentProposal JSON"
          onChange={(event) => onTextChange(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <TextButton onClick={() => inputRef.current?.click()}>导入文件</TextButton>
          <TextButton
            onClick={() => onImportText(text)}
            disabled={text.trim().length === 0}
          >
            导入提案
          </TextButton>
          <TextButton
            onClick={exportProposal}
            disabled={!downloadContent}
          >
            导出提案
          </TextButton>
          <TextButton
            onClick={exportReviewReport}
            disabled={!proposal}
          >
            <Download size={14} />
            导出报告
          </TextButton>
          <TextButton
            onClick={onClear}
            disabled={!canClearProposal}
          >
            <Trash2 size={14} />
            清空提案
          </TextButton>
          <TextButton
            tone="primary"
            onClick={onApply}
            disabled={!proposal || reviewStatusSummary.pendingCount === 0 || applyBlockers.length > 0}
            title={applyBlockers[0] ?? "应用候选"}
          >
            应用候选
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
          <div className="grid gap-1 text-slate-400">
            {reviewFocus.length > 0 ? (
              <div className="rounded border border-amber-400/30 bg-amber-400/10 p-2 text-[11px] text-amber-100">
                <div className="mb-1 font-medium">复核提示</div>
                <ul className="grid list-disc gap-1 pl-4">
                  {reviewFocus.slice(0, 3).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {applyBlockers.length > 0 ? (
              <div className="rounded border border-accent-red/30 bg-accent-red/10 p-2 text-[11px] text-red-100">
                <div className="mb-1 font-medium">应用已暂停</div>
                <ul className="grid list-disc gap-1 pl-4">
                  {applyBlockers.slice(0, 3).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {reviewQueue.length > 0 ? (
              <div className="rounded border border-panel-line bg-black/20 p-2 text-[11px] text-slate-300">
                <div className="mb-1 font-medium text-slate-200">复核队列</div>
                <ol className="grid gap-1" aria-label="对齐复核队列">
                  {visibleReviewQueue.map((item, index) => (
                    <li
                      key={`${item.kind}-${item.id}-${index}`}
                      className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-start gap-2"
                    >
                      <span className={getAlignmentReviewQueueSeverityClassName(item.severity)}>
                        {item.severityText}
                      </span>
                      <span className="min-w-0">
                        <span className="text-slate-100">{item.name}</span>
                        <span className="text-slate-500">
                          {" "}
                          / {item.kind === "anchor" ? "锚点" : "版本差异"} / {formatTimecode(item.sourceAtMs)}
                        </span>
                        <span className="block text-slate-400">{item.reasons.join("；")}</span>
                      </span>
                      <TextButton
                        aria-label={`定位复核项 ${index + 1}`}
                        title={`定位到 ${formatTimecode(item.sourceAtMs)}`}
                        onClick={() => onFocusQueueItem(item.sourceAtMs, item.name)}
                        className="px-2"
                      >
                        <Crosshair size={13} />
                        定位
                      </TextButton>
                    </li>
                  ))}
                </ol>
                {hiddenReviewQueueCount > 0 ? (
                  <div className="mt-1 text-slate-500">另有 {hiddenReviewQueueCount} 条复核项已收起。</div>
                ) : null}
              </div>
            ) : null}
            {reviewItemStatuses.length > 0 ? (
              <div className="rounded border border-panel-line bg-black/20 p-2 text-[11px] text-slate-300">
                <div className="mb-1 font-medium text-slate-200">落点状态</div>
                <ul className="grid gap-1" aria-label="对齐落点状态">
                  {visibleReviewItemStatuses.map((item, index) => (
                    <li
                      key={`${item.kind}-${item.id}-${index}`}
                      className="grid grid-cols-[44px_minmax(0,1fr)] gap-2"
                    >
                      <span className="text-slate-500">{item.kind === "anchor" ? "锚点" : "版本差异"}</span>
                      <span className="min-w-0">
                        <span className="text-slate-100">{item.name}</span>
                        <span className="text-slate-500"> / {formatTimecode(item.sourceAtMs)} / </span>
                        <span className={getAlignmentReviewStatusClassName(item.state)}>{item.statusText}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                {hiddenReviewItemStatusCount > 0 ? (
                  <div className="mt-1 text-slate-500">另有 {hiddenReviewItemStatusCount} 条状态已收起。</div>
                ) : null}
              </div>
            ) : null}
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
              <span className="text-slate-500">锚点</span>
              <span>
                {proposal.anchors.length} 个，候选 {preview.summary.candidateAnchorCount}
              </span>
            </div>
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
              <span className="text-slate-500">版本差异</span>
              <span>
                {proposal.cutCandidates.length} 个，候选 {preview.summary.candidateCutCount}
              </span>
            </div>
            {previewCuts.map((candidate) => (
              <div key={candidate.id} className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
                <span className="text-slate-500">{formatTimecode(candidate.sourceAtMs)}</span>
                <span>
                  {formatSignedDuration(candidate.targetGapMs)} / {candidate.state === "applied" ? "已应用" : "候选"}
                  {formatCandidateSourceRange(candidate)}
                </span>
              </div>
            ))}
            {proposal.diagnostics.slice(0, 2).map((diagnostic, index) => (
              <div
                key={`${diagnostic}-${index}`}
                className="rounded border border-panel-line bg-black/20 p-2 text-slate-400"
              >
                {diagnostic}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

interface ParsedNumericInput {
  value: number;
  error: string | null;
}

function parsePositiveIntegerInput(value: string, label: string): ParsedNumericInput {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (trimmed.length === 0 || !Number.isInteger(parsed) || parsed <= 0) {
    return {
      value: 0,
      error: `${label}必须是大于 0 的整数。`
    };
  }
  return { value: parsed, error: null };
}

function parseNonNegativeIntegerInput(value: string, label: string): ParsedNumericInput {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (trimmed.length === 0 || !Number.isInteger(parsed) || parsed < 0) {
    return {
      value: 0,
      error: `${label}必须是 0 或正整数。`
    };
  }
  return { value: parsed, error: null };
}

function parsePositiveNumberInput(value: string, label: string): ParsedNumericInput {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (trimmed.length === 0 || !Number.isFinite(parsed) || parsed <= 0) {
    return {
      value: 0,
      error: `${label}必须是大于 0 的数字。`
    };
  }
  return { value: parsed, error: null };
}

function getAlignmentProposalDownloadText(text: string, proposal: AlignmentProposal | null): string {
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    return `${trimmed}\n`;
  }
  if (proposal) {
    return `${JSON.stringify(proposal, null, 2)}\n`;
  }
  return "";
}

function waitForAudioAlignmentPoll(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 700);
  });
}

function alignmentJobStatusText(status: AudioAlignmentJobSnapshot["status"]): string {
  if (status === "queued") {
    return "排队中";
  }
  if (status === "running") {
    return "运行中";
  }
  if (status === "completed") {
    return "已完成";
  }
  if (status === "failed") {
    return "失败";
  }
  return "已取消";
}

function getAlignmentReviewStatusClassName(state: AlignmentReviewItemState): string {
  if (state === "applied") {
    return "text-emerald-300";
  }
  if (state === "blocked") {
    return "text-red-200";
  }
  return "text-amber-200";
}

function getAlignmentReviewQueueSeverityClassName(severity: AlignmentReviewQueueSeverity): string {
  if (severity === "blocked") {
    return "text-red-200";
  }
  if (severity === "attention") {
    return "text-amber-200";
  }
  return "text-slate-400";
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

function exportBatchMergePlan(plan: ReturnType<typeof buildBatchMergePlan>, projectName: string) {
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
  const downloadResult = downloadTextFiles(
    files.map((file) => ({ fileName: file.fileName, content: file.content })),
    "application/xml;charset=utf-8",
    createProjectDownloadFileName(projectName, "-danmaku-exports.zip")
  );
  setStatus({ message: createBatchExportDownloadStatus(downloadResult), tone: "success" });
}

function setStatus(status: EditorStatus) {
  useEditorStore.setState({ status });
}

function createBatchExportDownloadStatus(result: DownloadTextFilesResult): string {
  const fileCount = result.fileCount.toLocaleString("zh-CN");
  if (result.archiveFileName) {
    return `已触发下载 ${fileCount} 个分集 XML，已打包为 ${result.archiveFileName}。`;
  }
  if (result.downloadedFileName) {
    return `已触发下载 ${fileCount} 个分集 XML：${result.downloadedFileName}。`;
  }
  return `已触发下载 ${fileCount} 个分集 XML。`;
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
  const StatusIcon = readiness.status === "blocked" ? CircleAlert : readiness.status === "attention" ? TriangleAlert : CircleCheck;
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3" data-testid="project-health-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
            <StatusIcon size={16} className={projectReadinessIconClass(readiness.status)} />
            <span>导出前检查</span>
          </div>
          <p className="mt-1 text-xs font-medium leading-5 text-slate-300">{readiness.headline}</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">{readiness.detail}</p>
        </div>
        <span className={`shrink-0 rounded border px-2 py-1 text-[11px] ${projectReadinessBadgeClass(readiness.status)}`}>
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
            <HealthMetric key={diagnostic.label} label={diagnostic.label} value={diagnostic.value} />
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
    item.severity === "error" ? CircleAlert : item.severity === "warning" ? TriangleAlert : CircleCheck;
  return (
    <li className="flex gap-2 py-2 first:pt-3 last:pb-0">
      <FindingIcon size={14} className={`mt-0.5 shrink-0 ${projectReadinessItemIconClass(item.severity)}`} />
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

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      className={`border-r border-panel-line text-xs ${
        active ? "bg-panel-soft text-accent-cyan" : "text-slate-400 hover:bg-panel-soft hover:text-slate-200"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
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
