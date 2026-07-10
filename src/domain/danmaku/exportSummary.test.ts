import { describe, expect, it } from "vitest";
import { createCompensationReport, createExportSummary } from "./exportSummary";
import type { CutMarker, DanmakuAsset, DanmakuClip, DanmakuItem, ResolvedDanmakuEvent } from "./types";

describe("导出补偿报告", () => {
  it("按源时间输出补偿明细和总补偿时长", () => {
    const markers: CutMarker[] = [
      {
        id: "cut-late",
        name: "后段补偿",
        sourceAtMs: 30_000,
        targetGapMs: 5_000,
        note: ""
      },
      {
        id: "cut-early",
        name: "前段补偿",
        sourceAtMs: 10_000,
        targetGapMs: 12_000,
        note: "人工复核"
      }
    ];

    const summary = createExportSummary([], markers, false);
    const report = createCompensationReport("测试项目", summary);

    expect(summary.totalCutGapMs).toBe(17_000);
    expect(summary.compensationDetails.map((detail) => detail.id)).toEqual(["cut-early", "cut-late"]);
    expect(report).toContain("项目：测试项目");
    expect(report).toContain("总补偿：+00:00:17.000");
    expect(report).toContain("1. 前段补偿");
    expect(report).toContain("备注：人工复核");
  });

  it("记录负时间限制明细", () => {
    const event = createResolvedEvent(-500);
    const summary = createExportSummary([event], [], false);
    const report = createCompensationReport("负时间项目", summary);

    expect(summary.negativeClampCount).toBe(1);
    expect(summary.negativeClampDetails).toEqual([
      expect.objectContaining({
        assetFileName: "asset.xml",
        clipName: "片段",
        originalIndex: 0,
        finalTimeMs: -500,
        text: "过早弹幕"
      })
    ]);
    expect(report).toContain("本次导出未应用补偿点。");
    expect(report).toContain("负时间限制明细");
    expect(report).toContain("原最终时间：-00:00:00.500 (-500 ms)");
    expect(report).toContain("文本：过早弹幕");
  });
});

function createResolvedEvent(finalTimeMs: number): ResolvedDanmakuEvent {
  const item: DanmakuItem = {
    id: "item",
    assetId: "asset",
    originalIndex: 0,
    sourceTimeMs: 1000,
    mode: 1,
    fontSize: 25,
    color: 16_777_215,
    timestamp: 0,
    pool: 0,
    userHash: "user",
    rowId: "row",
    text: "过早弹幕",
    rawPFields: ["1.000", "1", "25", "16777215", "0", "0", "user", "row"],
    enabled: true
  };
  const asset: DanmakuAsset = {
    id: "asset",
    name: "asset",
    fileName: "asset.xml",
    color: "#4cc9f0",
    items: [item],
    warnings: [],
    importedAt: "now"
  };
  const clip: DanmakuClip = {
    id: "clip",
    assetId: "asset",
    name: "片段",
    timelineStartMs: 0,
    sourceInMs: 0,
    sourceOutMs: 2000,
    localOffsetMs: 0,
    enabled: true
  };
  return {
    id: "clip:item",
    item,
    asset,
    clip,
    finalTimeMs,
    originalIndex: item.originalIndex,
    enabled: true
  };
}
