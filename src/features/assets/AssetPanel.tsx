import { Download, Layers, ListPlus, ListX, Search, Shuffle, Trash2, Video, WandSparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { TextButton } from "../../components/TextButton";
import { buildBatchMergePlan, type BatchMergeOptions } from "../../domain/danmaku/batchMerge";
import { parseCutPointsText, parseEpisodeDurationsText, parseMinutesInput } from "../../domain/danmaku/manualRules";
import { formatTimecode } from "../../domain/shared/time";
import { getAssetTimeRange } from "../../domain/timeline/mapping";
import { downloadTextFiles } from "../../infrastructure/file-system/browserFiles";
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
import { serializeBilibiliXml, validateExportedXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore, type EditorStatus } from "../../stores/editorStore";

type AssetTab = "media" | "danmaku" | "project";
type PartWindowMode = "full" | "prefix" | "suffix" | "range";
type LongSplitMode = "auto" | "durations" | "cuts";

export function AssetPanel() {
  const [tab, setTab] = useState<AssetTab>("danmaku");
  const [partWindowMode, setPartWindowMode] = useState<PartWindowMode>("full");
  const [partWindowMinutes, setPartWindowMinutes] = useState("9");
  const [partRangeStartMinutes, setPartRangeStartMinutes] = useState("0");
  const [partRangeEndMinutes, setPartRangeEndMinutes] = useState("9");
  const [longSplitMode, setLongSplitMode] = useState<LongSplitMode>("auto");
  const [episodeDurationsText, setEpisodeDurationsText] = useState("");
  const [cutPointsText, setCutPointsText] = useState("");
  const project = useEditorStore((state) => state.project);
  const importProgress = useEditorStore((state) => state.importProgress);
  const addAssetToTimeline = useEditorStore((state) => state.addAssetToTimeline);
  const removeAsset = useEditorStore((state) => state.removeAsset);
  const removeAssetFromTimeline = useEditorStore((state) => state.removeAssetFromTimeline);
  const removeMedia = useEditorStore((state) => state.removeMedia);
  const autoArrangeClips = useEditorStore((state) => state.autoArrangeClips);
  const select = useEditorStore((state) => state.select);
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
  const batchMergePlan = useMemo(
    () => buildBatchMergePlan(project.assets, manualRules.options),
    [manualRules.options, project.assets]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid h-10 shrink-0 grid-cols-3 border-b border-panel-line text-xs">
        <TabButton active={tab === "media"} onClick={() => setTab("media")}>
          媒体
        </TabButton>
        <TabButton active={tab === "danmaku"} onClick={() => setTab("danmaku")}>
          弹幕文件
        </TabButton>
        <TabButton active={tab === "project"} onClick={() => setTab("project")}>
          项目信息
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
            <div className="flex gap-2">
              <TextButton onClick={autoArrangeClips} disabled={project.assets.length === 0}>
                <Shuffle size={14} />
                按顺序排列
              </TextButton>
              <TextButton
                tone="primary"
                onClick={() => exportBatchMergePlan(batchMergePlan)}
                disabled={batchMergePlan.episodes.length === 0}
              >
                <Download size={14} />
                导出分集
              </TextButton>
            </div>
            {importProgress !== null ? (
              <div className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
                正在导入 XML... {Math.round(importProgress * 100)}%
              </div>
            ) : null}
            <EmbyMetadataPanel
              onImportDurationLines={(lines) => {
                setEpisodeDurationsText(lines);
                setLongSplitMode("durations");
                setStatus({ message: "已把 Emby 剧集时长导入人工整理规则。", tone: "success" });
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
                <BatchMergeSummary plan={batchMergePlan} warnings={manualRules.warnings} />
              </>
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
          </div>
        ) : null}
        {tab === "project" ? (
          <div className="grid gap-3 text-xs text-slate-400">
            <div className="rounded border border-panel-line bg-panel-soft p-3">
              <h3 className="mb-2 text-sm font-medium text-slate-100">{project.name}</h3>
              <Row label="资源数" value={project.assets.length.toString()} />
              <Row label="片段数" value={project.clips.length.toString()} />
              <Row label="删减标记" value={project.cutMarkers.length.toString()} />
              <Row label="同步锚点" value={project.syncAnchors.length.toString()} />
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

function EmbyMetadataPanel({ onImportDurationLines }: { onImportDurationLines: (lines: string) => void }) {
  const [serverUrl, setServerUrl] = useState("");
  const [pathPrefix, setPathPrefix] = useState("/emby");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [itemId, setItemId] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [session, setSession] = useState<EmbyAuthSession | null>(null);
  const [loadedItem, setLoadedItem] = useState<EmbyItemMetadata | null>(null);
  const [episodeItems, setEpisodeItems] = useState<EmbyItemMetadata[]>([]);
  const [searchResults, setSearchResults] = useState<EmbyItemMetadata[]>([]);
  const [durationLines, setDurationLines] = useState("");
  const [loading, setLoading] = useState<"login" | "search" | "item" | "episodes" | null>(null);
  const config = { serverUrl, pathPrefix };
  const disabled = serverUrl.trim().length === 0 || itemId.trim().length === 0;

  async function runAction<T>(kind: typeof loading, action: () => Promise<T>): Promise<T | null> {
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

  const login = async () => {
    if (serverUrl.trim().length === 0 || username.trim().length === 0 || password.length === 0) {
      setStatus({ message: "请填写 Emby 地址、用户名和密码。", tone: "warning" });
      return;
    }
    const nextSession = await runAction("login", () => authenticateEmby(config, { username, password }));
    if (nextSession) {
      setSession(nextSession);
      setSearchResults([]);
      setStatus({ message: `Emby 已登录：${nextSession.userName || nextSession.userId}`, tone: "success" });
    }
  };

  const searchItems = async () => {
    if (!session) {
      setStatus({ message: "请先登录后再搜索。", tone: "warning" });
      return;
    }
    if (searchTerm.trim().length === 0) {
      setStatus({ message: "请填写要搜索的片名、剧名或季集信息。", tone: "warning" });
      return;
    }
    const items = await runAction("search", () => searchEmbyItems(config, session, { searchTerm, limit: 12 }));
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
    if (!session || disabled) {
      setStatus({ message: "请先登录并填写 ItemId。", tone: "warning" });
      return;
    }
    const item = await runAction("item", () => fetchEmbyItem(config, session, itemId.trim()));
    if (item) {
      setLoadedItem(item);
      setStatus({ message: `已读取 Emby 条目：${item.name}`, tone: "success" });
    }
  };

  const readEpisodes = async () => {
    if (!session || disabled) {
      setStatus({ message: "请先登录并填写剧集、季或合集 ItemId。", tone: "warning" });
      return;
    }
    const items = await runAction("episodes", () => fetchEmbyEpisodeChildren(config, session, itemId.trim()));
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
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300">
      <h3 className="text-sm font-medium text-slate-100">Emby 时长</h3>
      <div className="mt-3 grid gap-2">
        <label className="grid gap-1">
          <span className="text-slate-500">服务器</span>
          <input
            className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
            value={serverUrl}
            placeholder="https://example.com:443"
            onChange={(event) => setServerUrl(event.target.value)}
          />
        </label>
        <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
          <label className="grid gap-1">
            <span className="text-slate-500">路径</span>
            <input
              className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              value={pathPrefix}
              placeholder="/emby"
              onChange={(event) => setPathPrefix(event.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-slate-500">ItemId</span>
            <input
              className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              value={itemId}
              placeholder="剧集、季或单集 ID"
              onChange={(event) => setItemId(event.target.value)}
            />
          </label>
        </div>
        <label className="grid gap-1">
          <span className="text-slate-500">搜索</span>
          <input
            className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
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
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            <span className="text-slate-500">用户名</span>
            <input
              className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              value={username}
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-slate-500">密码</span>
            <input
              className="h-8 rounded border border-panel-line bg-[#111318] px-2 text-xs text-slate-100"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <TextButton onClick={() => void login()} disabled={loading !== null}>
            {loading === "login" ? "登录中" : "登录"}
          </TextButton>
          <TextButton onClick={() => void searchItems()} disabled={!session || loading !== null}>
            <Search size={14} />
            {loading === "search" ? "搜索中" : "搜索"}
          </TextButton>
          <TextButton onClick={() => void readItem()} disabled={!session || disabled || loading !== null}>
            读取条目
          </TextButton>
          <TextButton onClick={() => void readEpisodes()} disabled={!session || disabled || loading !== null} tone="primary">
            读取下级剧集
          </TextButton>
        </div>
        {searchResults.length > 0 ? (
          <div className="grid gap-1 rounded border border-panel-line bg-black/20 p-2">
            <div className="text-slate-500">搜索结果</div>
            {searchResults.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`grid gap-0.5 rounded px-2 py-1 text-left transition hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-cyan ${
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
          <div className="rounded border border-panel-line bg-black/20 p-2">
            <Row label="条目" value={loadedItem.name} />
            <Row label="类型" value={loadedItem.type} />
            <Row label="时长" value={loadedItem.durationMs === null ? "未知" : formatTimecode(loadedItem.durationMs)} />
            {loadedItem.durationMs !== null ? (
              <div className="mt-2">
                <TextButton onClick={importLoadedItemDuration}>导入单条时长</TextButton>
              </div>
            ) : null}
          </div>
        ) : null}
        {durationLines.length > 0 ? (
          <div className="grid gap-2">
            <textarea
              className="min-h-24 resize-y rounded border border-panel-line bg-[#111318] p-2 font-mono text-xs leading-5 text-slate-100"
              value={durationLines}
              readOnly
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">{episodeItems.length} 个条目</span>
              <TextButton tone="primary" onClick={() => onImportDurationLines(durationLines)}>
                导入时长规则
              </TextButton>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
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
    </section>
  );
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

function exportBatchMergePlan(plan: ReturnType<typeof buildBatchMergePlan>) {
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
  downloadTextFiles(
    files.map((file) => ({ fileName: file.fileName, content: file.content })),
    "application/xml;charset=utf-8"
  );
  setStatus({ message: `已触发下载 ${files.length} 个分集 XML。`, tone: "success" });
}

function setStatus(status: EditorStatus) {
  useEditorStore.setState({ status });
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
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
      <dt className="text-slate-500">{label}</dt>
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
