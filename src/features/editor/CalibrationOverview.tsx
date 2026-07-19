import { ArrowRight, Clock3, Link2, Play, SplitSquareHorizontal } from "lucide-react";
import { useState } from "react";
import { TextButton } from "../../components/TextButton";
import { createId } from "../../domain/project/factory";
import { parseSourceTimecode } from "../../domain/project/sourceTimeline";
import { formatTimecode } from "../../domain/shared/time";
import { useEditorStore } from "../../stores/editorStore";

type RepairMode = "sync" | "difference" | null;

export function CalibrationOverview() {
  const project = useEditorStore((state) => state.project);
  const selection = useEditorStore((state) => state.selection);
  const isPlaying = useEditorStore((state) => state.isPlaying);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const autoArrangeClips = useEditorStore((state) => state.autoArrangeClips);
  const togglePlayback = useEditorStore((state) => state.togglePlayback);
  const setGlobalOffset = useEditorStore((state) => state.setGlobalOffset);
  const addSyncAnchor = useEditorStore((state) => state.addSyncAnchor);
  const addCutMarker = useEditorStore((state) => state.addCutMarker);
  const [repairMode, setRepairMode] = useState<RepairMode>(null);
  const [targetTimeText, setTargetTimeText] = useState(() =>
    formatTimecode(project.timeline.playheadMs)
  );
  const [differenceSeconds, setDifferenceSeconds] = useState("45");

  const issueCount =
    (project.clips.length === 0 && project.assets.length > 0 ? 1 : 0) +
    project.cutMarkers.length;
  const selectedLabel =
    selection.kind === "none"
      ? "未选择对象"
      : selection.kind === "clip"
        ? `已选择 ${selection.ids.length} 个弹幕片段`
        : selection.kind === "danmaku"
          ? `已选择 ${selection.ids.length} 条弹幕`
          : selection.kind === "cut"
            ? `已选择 ${selection.ids.length} 个版本差异`
            : `已选择 ${selection.ids.length} 个同步点`;
  const primaryAction =
    project.assets.length === 0
      ? {
          label: "先添加弹幕素材",
          run: () => setWorkspacePage("materials")
        }
      : project.clips.length === 0
        ? {
            label: "自动排列弹幕",
            run: autoArrangeClips
          }
        : {
            label: isPlaying ? "暂停检查" : "播放检查",
            run: togglePlayback
          };

  const openRepair = (mode: Exclude<RepairMode, null>) => {
    if (mode === "sync") {
      setTargetTimeText(formatTimecode(project.timeline.playheadMs));
    }
    setRepairMode(mode);
  };

  const saveSyncPoint = () => {
    const targetMs = parseSourceTimecode(targetTimeText);
    if (targetMs === null) {
      setEditorStatus("原片时间格式无效，请使用 00:00:00.000。", "warning");
      return;
    }
    addSyncAnchor({
      id: createId("sync_anchor"),
      sourceMs: project.timeline.playheadMs,
      targetMs,
      origin: "manual"
    });
    setEditorStatus("已添加同步点；弹幕和原始素材保持不变，可随时撤销。", "success");
    setRepairMode(null);
  };

  const saveDifference = () => {
    const seconds = Number(differenceSeconds);
    if (!Number.isFinite(seconds) || seconds === 0) {
      setEditorStatus("请输入非零差异秒数；负数表示之后的弹幕提前。", "warning");
      return;
    }
    const targetGapMs = Math.round(seconds * 1000);
    addCutMarker(project.timeline.playheadMs, targetGapMs, {
      name: `版本差异 ${project.cutMarkers.length + 1}`,
      note: "由校准页常用修复添加。"
    });
    setEditorStatus("已标记版本差异；只调整后续弹幕映射，不修改视频或原始 XML。", "success");
    setRepairMode(null);
  };

  return (
    <section
      className="shrink-0 border-b border-panel-line bg-[#12161c] px-3 py-2.5 text-xs"
      data-testid="calibration-overview"
      aria-label="校准摘要"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Clock3 size={15} className="text-accent-cyan" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="font-semibold text-slate-100">试听并校准时间关系</h2>
            <span className="text-[10px] text-slate-600">
              {issueCount > 0 ? `${issueCount} 项需要留意` : "可以从开头、中段和结尾抽查"}
            </span>
          </div>
          <p className="mt-1 truncate text-[10px] text-slate-500">
            {selectedLabel} · 播放头 {formatTimecode(project.timeline.playheadMs)} · 整体偏移{" "}
            {formatSignedMilliseconds(project.globalOffsetMs)}
          </p>
        </div>
        <TextButton tone="primary" onClick={primaryAction.run}>
          {primaryAction.label === "播放检查" ? <Play size={13} /> : null}
          {primaryAction.label}
          <ArrowRight size={13} />
        </TextButton>
      </div>
      <details className="mt-2 rounded-md border border-panel-line/70 bg-black/10 px-2 py-1.5">
        <summary className="cursor-pointer text-[10px] font-medium text-slate-400">
          常用修复
          <span className="ml-2 font-normal text-slate-600">
            整体偏移、重新同步、版本差异
          </span>
        </summary>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <TextButton
          title="让全部弹幕提前 0.5 秒"
          onClick={() => setGlobalOffset(project.globalOffsetMs - 500)}
        >
          整体提前 0.5 秒
        </TextButton>
        <TextButton
          title="让全部弹幕延后 0.5 秒"
          onClick={() => setGlobalOffset(project.globalOffsetMs + 500)}
        >
          整体延后 0.5 秒
        </TextButton>
        {project.globalOffsetMs !== 0 ? (
          <TextButton onClick={() => setGlobalOffset(0)}>清除整体偏移</TextButton>
        ) : null}
        <TextButton onClick={() => openRepair("sync")}>
          <Link2 size={13} />
          从这里重新同步
        </TextButton>
        <TextButton onClick={() => openRepair("difference")}>
          <SplitSquareHorizontal size={13} />
          这之后有版本差异
        </TextButton>
        </div>
        {repairMode ? (
        <div
          className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-panel-line bg-black/15 p-2"
          role="group"
          aria-label={repairMode === "sync" ? "重新同步设置" : "版本差异设置"}
        >
          {repairMode === "sync" ? (
            <>
              <div className="text-[10px] leading-4 text-slate-500">
                参考位置
                <span className="block font-mono text-slate-300">
                  {formatTimecode(project.timeline.playheadMs)}
                </span>
              </div>
              <label className="grid gap-1 text-[10px] text-slate-500">
                对应原片时间
                <input
                  aria-label="对应原片时间"
                  className="h-7 w-36 rounded border border-panel-line bg-panel-base px-2 font-mono text-[11px] text-slate-100"
                  value={targetTimeText}
                  onChange={(event) => setTargetTimeText(event.target.value)}
                />
              </label>
              <TextButton tone="primary" onClick={saveSyncPoint}>
                保存同步点
              </TextButton>
            </>
          ) : (
            <>
              <label className="grid gap-1 text-[10px] text-slate-500">
                之后弹幕移动秒数
                <input
                  aria-label="版本差异秒数"
                  className="h-7 w-28 rounded border border-panel-line bg-panel-base px-2 text-[11px] text-slate-100"
                  type="number"
                  step="0.1"
                  value={differenceSeconds}
                  onChange={(event) => setDifferenceSeconds(event.target.value)}
                />
              </label>
              <span className="pb-1.5 text-[10px] text-slate-600">
                正数延后，负数提前
              </span>
              <TextButton tone="primary" onClick={saveDifference}>
                保存版本差异
              </TextButton>
            </>
          )}
          <TextButton onClick={() => setRepairMode(null)}>取消</TextButton>
        </div>
        ) : null}
      </details>
    </section>
  );
}

function setEditorStatus(
  message: string,
  tone: "success" | "warning"
): void {
  useEditorStore.setState({ status: { message, tone } });
}

function formatSignedMilliseconds(value: number): string {
  if (value === 0) {
    return "0 秒";
  }
  return `${value > 0 ? "延后" : "提前"} ${(Math.abs(value) / 1000).toFixed(1)} 秒`;
}
