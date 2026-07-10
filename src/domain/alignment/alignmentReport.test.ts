import { describe, expect, it } from "vitest";
import {
  createAlignmentApplyBlockers,
  createAlignmentReviewFocus,
  createAlignmentReviewReport
} from "./alignmentReport";
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
    expect(report).toContain("暂无应用阻断。");
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

  it("识别会阻断应用的结构异常", () => {
    const proposal: AlignmentProposal = {
      anchors: [
        { id: "", sourceMs: 1000, targetMs: 1000, origin: "automatic" },
        { id: "anchor-dup", sourceMs: 2000, targetMs: 3000, origin: "automatic" },
        { id: "anchor-dup", sourceMs: 4000, targetMs: 5000, origin: "automatic" }
      ],
      cutCandidates: [
        {
          id: "range-reversed",
          name: "区间反向",
          sourceAtMs: 20_000,
          sourceRangeStartMs: 22_000,
          sourceRangeEndMs: 18_000,
          targetGapMs: 20_000,
          confidence: 0.8,
          note: ""
        },
        {
          id: "source-outside",
          name: "源时间越界",
          sourceAtMs: 30_000,
          sourceRangeStartMs: 18_000,
          sourceRangeEndMs: 22_000,
          targetGapMs: 20_000,
          confidence: 0.8,
          note: ""
        },
        {
          id: "source-outside",
          name: "重复 ID",
          sourceAtMs: 40_000,
          targetGapMs: 20_000,
          confidence: 0.8,
          note: ""
        }
      ],
      confidence: 0.8,
      diagnostics: ["测试"]
    };

    expect(createAlignmentApplyBlockers(proposal)).toEqual([
      "1 个同步锚点缺少 ID，无法安全写入项目。",
      "1 个同步锚点 ID 在提案内重复（ID：anchor-dup），应用会丢失锚点。",
      "1 个候选补偿 ID 在提案内重复（ID：source-outside），应用会丢失补偿。",
      "1 个候选补偿的不确定区间起止顺序异常，请修正后再应用。",
      "1 个候选补偿的源时间不在不确定区间内，请修正后再应用。"
    ]);
  });

  it("识别和当前项目已有 ID 冲突的提案", () => {
    const proposal: AlignmentProposal = {
      anchors: [{ id: "anchor-existing", sourceMs: 1000, targetMs: 2000, origin: "automatic" }],
      cutCandidates: [
        {
          id: "cut-existing",
          name: "已有补偿",
          sourceAtMs: 3000,
          targetGapMs: 1200,
          confidence: 0.9,
          note: ""
        }
      ],
      confidence: 0.9,
      diagnostics: []
    };

    const context = {
      existingAnchorIds: ["anchor-existing"],
      existingCutMarkerIds: ["cut-existing"]
    };

    expect(createAlignmentApplyBlockers(proposal, context)).toEqual([
      "1 个同步锚点 ID 已存在于当前项目（ID：anchor-existing），应用会丢失新锚点。",
      "1 个候选补偿 ID 已存在于当前项目（ID：cut-existing），应用会丢失新补偿。"
    ]);
    const report = createAlignmentReviewReport(proposal, new Date("2026-07-10T01:02:03.000Z"), context);
    expect(report).toContain("## 应用阻断");
    expect(report).toContain("1 个同步锚点 ID 已存在于当前项目（ID：anchor-existing）");
    expect(report).toContain("1 个候选补偿 ID 已存在于当前项目（ID：cut-existing）");
  });

  it("已有 ID 的等价落点不会阻断应用，时间不同才阻断", () => {
    const equivalentProposal: AlignmentProposal = {
      anchors: [{ id: "anchor-existing", sourceMs: 1000, targetMs: 2000, origin: "automatic" }],
      cutCandidates: [
        {
          id: "cut-existing",
          name: "已有补偿",
          sourceAtMs: 3000,
          targetGapMs: 1200,
          confidence: 0.9,
          note: ""
        }
      ],
      confidence: 0.9,
      diagnostics: []
    };
    const conflictProposal: AlignmentProposal = {
      anchors: [{ id: "anchor-existing", sourceMs: 1200, targetMs: 2400, origin: "automatic" }],
      cutCandidates: [
        {
          id: "cut-existing",
          name: "同 ID 不同补偿",
          sourceAtMs: 3000,
          targetGapMs: 2400,
          confidence: 0.9,
          note: ""
        }
      ],
      confidence: 0.9,
      diagnostics: []
    };
    const context = {
      existingAnchors: [{ id: "anchor-existing", sourceMs: 1000, targetMs: 2000, origin: "manual" as const }],
      existingCutMarkers: [{ id: "cut-existing", name: "已有补偿", sourceAtMs: 3000, targetGapMs: 1200, note: "" }]
    };

    expect(createAlignmentApplyBlockers(equivalentProposal, context)).toEqual([]);
    expect(createAlignmentApplyBlockers(conflictProposal, context)).toEqual([
      "1 个同步锚点 ID 已存在于当前项目（ID：anchor-existing），应用会丢失新锚点。",
      "1 个候选补偿 ID 已存在于当前项目（ID：cut-existing），应用会丢失新补偿。"
    ]);
  });
});
