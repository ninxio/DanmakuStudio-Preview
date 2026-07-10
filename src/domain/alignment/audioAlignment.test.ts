import { describe, expect, it } from "vitest";
import {
  alignAudioFeatureSequences,
  alignSparseAudioFeatureSequences,
  createAudioAlignmentProposal,
  inferAudioCutCandidates,
  type AudioFeatureFrame
} from "./audioAlignment";

describe("音频特征对齐", () => {
  it("从完整版和当前视频特征序列中推断缺失段", () => {
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
    expect(proposal.evidence).toMatchObject({
      algorithm: "sparse-fingerprint",
      fingerprintMatchCount: 4,
      monotonicMatchCount: 4,
      refinedCandidateCount: 1
    });
    expect(proposal.diagnostics.join("\n")).toContain("稀疏音频指纹");
  });

  it("稀疏路径可在低 maxCells 下避开密集 DP 爆炸", () => {
    const complete = createFrames([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    const source = createFrames([0.1, 0.2, 0.5, 0.6]);

    const proposal = createAudioAlignmentProposal(complete, source, {
      matchThreshold: 0.01,
      minGapMs: 1000,
      maxCells: 1,
      anchorStride: 1
    });

    expect(proposal.cutCandidates).toHaveLength(1);
    expect(proposal.evidence?.algorithm).toBe("sparse-fingerprint");
  });

  it("公开的稀疏锚点匹配会输出单调路径", () => {
    const matches = alignSparseAudioFeatureSequences(
      createFrames([0.1, 0.2, 0.3, 0.4, 0.5]),
      createFrames([0.1, 0.2, 0.5]),
      { matchThreshold: 0.01 }
    );

    expect(matches.map((match) => [match.sourceTimeMs, match.completeTimeMs])).toEqual([
      [0, 0],
      [10_000, 10_000],
      [20_000, 40_000]
    ]);
  });

  it("相同序列不产生缺失段", () => {
    const complete = createFrames([0.1, 0.2, 0.3, 0.4]);
    const source = createFrames([0.1, 0.2, 0.3, 0.4]);

    const proposal = createAudioAlignmentProposal(complete, source, { matchThreshold: 0.01 });

    expect(proposal.cutCandidates).toEqual([]);
    expect(proposal.confidence).toBe(1);
  });

  it("匹配路径中的完整版额外跨度会变成候选版本差异", () => {
    const matches = alignAudioFeatureSequences(
      createFrames([0.1, 0.2, 0.3, 0.4, 0.5]),
      createFrames([0.1, 0.2, 0.5]),
      { matchThreshold: 0.01 }
    );

    const candidates = inferAudioCutCandidates(matches, { matchThreshold: 0.01, minGapMs: 1000 });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceAtMs).toBe(15_000);
    expect(candidates[0].targetGapMs).toBe(20_000);
    expect(candidates[0].note).toContain("候选边界约在当前视频 0:15");
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
