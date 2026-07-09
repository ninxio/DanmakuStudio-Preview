import { describe, expect, it } from "vitest";
import { createAlignmentReviewFocus, createAlignmentReviewReport } from "./alignmentReport";
import type { AlignmentProposal } from "./types";

describe("alignment review report", () => {
  it("生成包含锚点、补偿区间和诊断信息的复核报告", () => {
    const proposal: AlignmentProposal = {
      anchors: [{ id: "anchor-1", sourceMs: 20_000, targetMs: 40_000, origin: "automatic", confidence: 0.9 }],
      cutCandidates: [
        {
          id: "audio-gap-1",
          name: "音频推断补偿 1",
          sourceAtMs: 20_000,
          sourceRangeStartMs: 18_000,
          sourceRangeEndMs: 22_000,
          targetGapMs: 20_000,
          confidence: 0.72,
          note: "音频对齐候选"
        }
      ],
      confidence: 0.82,
      diagnostics: ["音频特征匹配 4 / 4 帧。"]
    };

    const report = createAlignmentReviewReport(proposal, new Date("2026-07-10T01:02:03.000Z"));

    expect(report).toContain("# 对齐提案复核报告");
    expect(report).toContain("生成时间：2026-07-10T01:02:03.000Z");
    expect(report).toContain("整体置信度：82.0%");
    expect(report).toContain("[anchor-1] 自动");
    expect(report).toContain("偏移：+00:00:20.000 (20000 ms)");
    expect(report).toContain("[audio-gap-1] 音频推断补偿 1");
    expect(report).toContain("不确定区间：00:00:18.000 (18000 ms) - 00:00:22.000 (22000 ms)");
    expect(report).toContain("1 个候选补偿置信度低于 75%");
    expect(report).toContain("音频特征匹配 4 / 4 帧。");
    expect(createAlignmentReviewFocus(proposal)).toEqual([
      "1 个候选补偿置信度低于 75%，建议人工确认边界和缺失时长。",
      "1 个候选补偿包含不确定区间，优先核对区间内的真实删减边界。"
    ]);
  });

  it("对空提案给出可复核的风险提示", () => {
    const report = createAlignmentReviewReport(
      {
        anchors: [],
        cutCandidates: [],
        confidence: 0,
        diagnostics: []
      },
      new Date("2026-07-10T01:02:03.000Z")
    );

    expect(report).toContain("提案没有同步锚点或候选补偿");
    expect(report).toContain("没有诊断信息");
    expect(report).toContain("暂无同步锚点。");
    expect(report).toContain("暂无候选补偿。");
  });
});
