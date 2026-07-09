import { describe, expect, it } from "vitest";
import {
  alignAudioFeatureSequences,
  createAudioAlignmentProposal,
  inferAudioCutCandidates,
  type AudioFeatureFrame
} from "./audioAlignment";

describe("音频特征对齐", () => {
  it("从完整片源和删减版特征序列中推断缺失段", () => {
    const complete = createFrames([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    const source = createFrames([0.1, 0.2, 0.5, 0.6]);

    const proposal = createAudioAlignmentProposal(complete, source, {
      matchThreshold: 0.01,
      minGapMs: 1000,
      anchorStride: 1
    });

    expect(proposal.cutCandidates).toHaveLength(1);
    expect(proposal.cutCandidates[0]).toMatchObject({
      sourceAtMs: 15_000,
      sourceRangeStartMs: 10_000,
      sourceRangeEndMs: 20_000,
      targetGapMs: 20_000
    });
    expect(proposal.anchors.map((anchor) => [anchor.sourceMs, anchor.targetMs])).toEqual([
      [0, 0],
      [10_000, 10_000],
      [20_000, 40_000],
      [30_000, 50_000]
    ]);
  });

  it("相同序列不产生缺失段", () => {
    const complete = createFrames([0.1, 0.2, 0.3, 0.4]);
    const source = createFrames([0.1, 0.2, 0.3, 0.4]);

    const proposal = createAudioAlignmentProposal(complete, source, { matchThreshold: 0.01 });

    expect(proposal.cutCandidates).toEqual([]);
    expect(proposal.confidence).toBe(1);
  });

  it("匹配路径中的完整片源额外跨度会变成候选补偿", () => {
    const matches = alignAudioFeatureSequences(
      createFrames([0.1, 0.2, 0.3, 0.4, 0.5]),
      createFrames([0.1, 0.2, 0.5]),
      { matchThreshold: 0.01 }
    );

    const candidates = inferAudioCutCandidates(matches, { matchThreshold: 0.01, minGapMs: 1000 });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceAtMs).toBe(15_000);
    expect(candidates[0].targetGapMs).toBe(20_000);
    expect(candidates[0].note).toContain("候选边界约在删减版 0:15");
  });

  it("空特征序列返回诊断而不是抛错", () => {
    const proposal = createAudioAlignmentProposal([], createFrames([0.1]));

    expect(proposal.cutCandidates).toEqual([]);
    expect(proposal.diagnostics[0]).toContain("音频特征为空");
  });
});

function createFrames(values: number[]): AudioFeatureFrame[] {
  return values.map((value, index) => ({
    timeMs: index * 10_000,
    values: [value]
  }));
}
