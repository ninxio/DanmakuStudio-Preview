import { describe, expect, it } from "vitest";
import { createCompensationReport, createExportSummary } from "./exportSummary";
import type { CutMarker } from "./types";

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

    const summary = createExportSummary([], markers, false, 0);
    const report = createCompensationReport("测试项目", summary);

    expect(summary.totalCutGapMs).toBe(17_000);
    expect(summary.compensationDetails.map((detail) => detail.id)).toEqual(["cut-early", "cut-late"]);
    expect(report).toContain("项目：测试项目");
    expect(report).toContain("总补偿：+00:00:17.000");
    expect(report).toContain("1. 前段补偿");
    expect(report).toContain("备注：人工复核");
  });
});
