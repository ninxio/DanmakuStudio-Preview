import type { ResolvedDanmakuEvent } from "./types";
import type { CutMarker } from "./types";
import type { Milliseconds } from "../shared/time";
import { formatTimecode } from "../shared/time";

export interface ExportCompensationDetail {
  id: string;
  name: string;
  sourceAtMs: Milliseconds;
  targetGapMs: Milliseconds;
  note: string;
}

export interface ExportSummary {
  originalCount: number;
  enabledCount: number;
  disabledCount: number;
  earliestFinalTimeMs: Milliseconds;
  latestFinalTimeMs: Milliseconds;
  cutMarkerCount: number;
  totalCutGapMs: Milliseconds;
  compensationDetails: ExportCompensationDetail[];
  hasImportWarnings: boolean;
  negativeClampCount: number;
}

export function createExportSummary(
  allEvents: ResolvedDanmakuEvent[],
  cutMarkers: CutMarker[],
  hasImportWarnings: boolean,
  negativeClampCount: number
): ExportSummary {
  const enabled = allEvents.filter((event) => event.enabled);
  const times = enabled.map((event) => Math.max(0, event.finalTimeMs));
  return {
    originalCount: allEvents.length,
    enabledCount: enabled.length,
    disabledCount: allEvents.length - enabled.length,
    earliestFinalTimeMs: times.length > 0 ? Math.min(...times) : 0,
    latestFinalTimeMs: times.length > 0 ? Math.max(...times) : 0,
    cutMarkerCount: cutMarkers.length,
    totalCutGapMs: cutMarkers.reduce((total, marker) => total + marker.targetGapMs, 0),
    compensationDetails: [...cutMarkers]
      .sort((left, right) => left.sourceAtMs - right.sourceAtMs || left.name.localeCompare(right.name))
      .map((marker) => ({
        id: marker.id,
        name: marker.name,
        sourceAtMs: marker.sourceAtMs,
        targetGapMs: marker.targetGapMs,
        note: marker.note
      })),
    hasImportWarnings,
    negativeClampCount
  };
}

export function createCompensationReport(projectName: string, summary: ExportSummary): string {
  const lines = [
    `项目：${projectName || "未命名项目"}`,
    `启用弹幕：${summary.enabledCount.toLocaleString("zh-CN")} 条`,
    `禁用弹幕：${summary.disabledCount.toLocaleString("zh-CN")} 条`,
    `补偿点：${summary.cutMarkerCount.toLocaleString("zh-CN")} 个`,
    `总补偿：${formatSignedCompensationDuration(summary.totalCutGapMs)}`,
    ""
  ];

  if (summary.compensationDetails.length === 0) {
    lines.push("本次导出未应用补偿点。");
    return `${lines.join("\n")}\n`;
  }

  lines.push("补偿明细：");
  summary.compensationDetails.forEach((detail, index) => {
    lines.push(
      `${index + 1}. ${detail.name}`,
      `   源时间：${formatTimecode(detail.sourceAtMs)} (${detail.sourceAtMs} ms)`,
      `   补偿：${formatSignedCompensationDuration(detail.targetGapMs)} (${detail.targetGapMs} ms)`,
      `   影响：此时间点之后的弹幕最终时间会按该补偿继续平移。`,
      `   备注：${detail.note.trim().length > 0 ? detail.note : "无"}`
    );
  });

  return `${lines.join("\n")}\n`;
}

export function formatSignedCompensationDuration(milliseconds: Milliseconds): string {
  const sign = milliseconds < 0 ? "-" : "+";
  return `${sign}${formatTimecode(Math.abs(milliseconds))}`;
}
