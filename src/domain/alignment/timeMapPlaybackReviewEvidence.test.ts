import { describe, expect, it } from "vitest";
import {
  createEmptyTimeMapSpanPlaybackEvidence,
  describeMissingTimeMapSpanPlaybackEvidence,
  markTimeMapSpanPlaybackStarted
} from "./timeMapPlaybackReviewEvidence";
import type { TimeMapSpan } from "./timeMap";

describe("TimeMap 持久播放复核证据", () => {
  it("matched 必须真实启动 A 与 B，边界循环不是必需项", () => {
    const span: TimeMapSpan = {
      kind: "matched",
      sourceStartMs: 0,
      sourceEndMs: 10_000,
      targetStartMs: 0,
      targetEndMs: 10_000
    };
    let evidence = createEmptyTimeMapSpanPlaybackEvidence();
    expect(describeMissingTimeMapSpanPlaybackEvidence(span, evidence)).toEqual([
      "播放参考 A",
      "播放原片 B"
    ]);
    evidence = markTimeMapSpanPlaybackStarted(evidence, "span", "source");
    evidence = markTimeMapSpanPlaybackStarted(evidence, "span", "target");
    expect(describeMissingTimeMapSpanPlaybackEvidence(span, evidence)).toEqual([]);
  });

  it("sourceOnly 要求存在侧试听及段首段尾两侧边界对照", () => {
    const span: TimeMapSpan = {
      kind: "sourceOnly",
      sourceStartMs: 10_000,
      sourceEndMs: 12_000,
      targetStartMs: 20_000,
      targetEndMs: 20_000
    };
    let evidence = createEmptyTimeMapSpanPlaybackEvidence();
    evidence = markTimeMapSpanPlaybackStarted(evidence, "span", "source");
    evidence = markTimeMapSpanPlaybackStarted(evidence, "startBoundary", "source");
    evidence = markTimeMapSpanPlaybackStarted(evidence, "startBoundary", "target");
    evidence = markTimeMapSpanPlaybackStarted(evidence, "endBoundary", "source");
    expect(describeMissingTimeMapSpanPlaybackEvidence(span, evidence)).toEqual([
      "段尾边界播放原片 B"
    ]);
    evidence = markTimeMapSpanPlaybackStarted(evidence, "endBoundary", "target");
    expect(describeMissingTimeMapSpanPlaybackEvidence(span, evidence)).toEqual([]);
  });
});
