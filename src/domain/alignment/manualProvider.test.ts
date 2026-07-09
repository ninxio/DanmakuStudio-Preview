import { describe, expect, it } from "vitest";
import { parseAlignmentProposal } from "./manualProvider";

describe("manual alignment provider", () => {
  it("解析合法的手动对齐提案", () => {
    const proposal = parseAlignmentProposal(
      JSON.stringify({
        anchors: [{ id: "anchor-1", sourceMs: 1000, targetMs: 1200, origin: "manual", confidence: 0.9 }],
        cutCandidates: [
          {
            id: "cut-1",
            name: "片头差异",
            sourceAtMs: 30_000,
            sourceRangeStartMs: 28_000,
            sourceRangeEndMs: 32_000,
            targetGapMs: 45_000,
            confidence: 0.8,
            note: "目标版本多出片头"
          }
        ],
        confidence: 0.85,
        diagnostics: ["手动标注"]
      })
    );

    expect(proposal.anchors).toHaveLength(1);
    expect(proposal.cutCandidates[0]?.sourceRangeStartMs).toBe(28_000);
    expect(proposal.cutCandidates[0]?.targetGapMs).toBe(45_000);
  });

  it("拒绝字段缺失的候选删减点", () => {
    expect(() =>
      parseAlignmentProposal(
        JSON.stringify({
          anchors: [],
          cutCandidates: [{ id: "cut-1", sourceAtMs: 30_000, targetGapMs: 45_000 }],
          confidence: 0.8,
          diagnostics: []
        })
      )
    ).toThrow("对齐提案 JSON 格式不正确。");
  });
});
