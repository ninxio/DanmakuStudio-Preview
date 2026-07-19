import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../project/factory";
import type { MediaMatchCandidate, MediaTimeMap } from "../project/types";
import {
  applyCandidateTimeMapManualTakeover,
  applySystemSuggestedTimeMapReviews,
  applyTimeMapSpanReviewDecision,
  describeTimeMapSpanReviewAvailability,
  editCandidateTimeMapSpan,
  isTimeMapManualTakeoverExportApproved,
  mergeCandidateTimeMapSpanWithNext,
  readTimeMapManualTakeover,
  readTimeMapSpanReviewDecision,
  reviewCandidateTimeMapSpan,
  splitCandidateTimeMapSpan
} from "./timeMapReviewDecision";
import { createTestCompleteTimeMapSpan } from "../../test/timeMapEvidence";

describe("时间图差异人工分类", () => {
  it("把兼容形状的参考独有分类写回候选并在项目保存状态中保留", () => {
    const map = createMap();
    const reviewed = applyTimeMapSpanReviewDecision(
      map,
      1,
      "source-extra",
      "2026-07-12T10:00:00.000Z"
    );

    expect(reviewed.spans[1]?.kind).toBe("sourceOnly");
    expect(reviewed.revision).toBe(2);
    expect(reviewed.verification).toBeNull();
    expect(reviewed.quality.level).toBe("blocked");
    expect(reviewed.spans[1]).toMatchObject({
      id: `${map.id}:span:0002`,
      reason: "manualReview",
      quality: { level: "review", metricSource: "missing", p99ResidualMs: null },
      boundaries: {
        start: { status: "unsupported" },
        end: { status: "unsupported" }
      },
      alternatives: []
    });
    expect(reviewed.evidence.types).toContain("manual");
    expect(readTimeMapSpanReviewDecision(reviewed, 1)).toEqual({
      spanIndex: 1,
      decision: "source-extra",
      reviewedAt: "2026-07-12T10:00:00.000Z"
    });
  });

  it("版本替换保持 ambiguous 结构但与无法判断形成可恢复的不同人工结论", () => {
    const map = createMap();
    const replacement = applyTimeMapSpanReviewDecision(
      map,
      3,
      "replacement",
      "2026-07-12T10:00:00.000Z"
    );
    const unresolved = applyTimeMapSpanReviewDecision(
      replacement,
      3,
      "unresolved",
      "2026-07-12T10:01:00.000Z"
    );

    expect(replacement.spans[3]?.kind).toBe("ambiguous");
    expect(readTimeMapSpanReviewDecision(replacement, 3)?.decision).toBe("replacement");
    expect(readTimeMapSpanReviewDecision(unresolved, 3)?.decision).toBe("unresolved");
    expect(
      unresolved.evidence.notes.filter((note) => note.startsWith("manual-span-review:v1:3:"))
    ).toHaveLength(1);
    expect(replacement.quality.level).toBe("blocked");
    expect(replacement.quality.reasons.join(" ")).toContain("A/B 播放");
    expect(unresolved.quality.level).toBe("blocked");
  });

  it.each([
    ["音画冲突已安全阻断，不能仅靠人工分类解除。", 0.8],
    ["存在无法唯一解释的歧义区间。", 0.1]
  ] as const)("真实质量 blocker 仍保持 blocked：%s", (reason, coverage) => {
    const map = createMap();
    map.quality.reasons = [reason];
    map.quality.coverage = coverage;

    const reviewed = applyTimeMapSpanReviewDecision(
      map,
      3,
      "replacement",
      "2026-07-12T10:00:00.000Z"
    );

    expect(reviewed.quality.level).toBe("blocked");
  });

  it("边界形状不兼容时 fail-closed，不把双侧内容静默改成单侧内容", () => {
    const map = createMap();
    const availability = describeTimeMapSpanReviewAvailability(map.spans[3], "source-extra");

    expect(availability.allowed).toBe(false);
    expect(availability.reason).toContain("原片侧必须先收敛为同一个边界点");
    expect(() =>
      applyTimeMapSpanReviewDecision(map, 3, "source-extra", "2026-07-12T10:00:00.000Z")
    ).toThrow("当前分类未写入");
    expect(map.spans[3]?.kind).toBe("ambiguous");
  });

  it("系统按区间形状采用最高可能性分类，用户接管后保留算法诊断并形成可导出的正式关系", () => {
    const map = createMap();
    const identity = {
      algorithm: "fnv1a64-first-middle-last-64k-v1",
      sizeBytes: 1_000,
      modifiedUnixMs: 1_700_000_000_000,
      firstSampleDigest: "a".repeat(16),
      middleSampleDigest: "b".repeat(16),
      lastSampleDigest: "c".repeat(16)
    };
    map.sourceIdentity = identity;
    map.targetIdentity = { ...identity, sizeBytes: 2_000 };

    const suggested = applySystemSuggestedTimeMapReviews(
      map,
      "2026-07-12T10:00:00.000Z"
    );
    expect(readTimeMapSpanReviewDecision(suggested, 1)?.decision).toBe("source-extra");
    expect(readTimeMapSpanReviewDecision(suggested, 2)?.decision).toBe("target-extra");
    expect(readTimeMapSpanReviewDecision(suggested, 3)?.decision).toBe("replacement");

    const takeover = applyCandidateTimeMapManualTakeover(
      suggested,
      "2026-07-12T10:01:00.000Z"
    );
    expect(takeover.quality.level).toBe("review");
    expect(takeover.quality.reasons.join(" ")).toContain("无法唯一解释");
    expect(takeover.quality.reasons.join(" ")).toContain("用户已采用系统最高可能性建议");
    expect(takeover.spans.every((span) => span.quality?.level === "review")).toBe(true);
    expect(takeover.evidence.types).toContain("manual");
    expect(readTimeMapManualTakeover(takeover)).toBe("2026-07-12T10:01:00.000Z");
    expect(takeover.verification).toBeNull();
    expect(isTimeMapManualTakeoverExportApproved(takeover)).toBe(false);
    expect(
      isTimeMapManualTakeoverExportApproved({
        ...takeover,
        state: "confirmed",
        confirmedAt: "2026-07-12T10:01:00.000Z"
      })
    ).toBe(true);
  });

  it("只允许待复核候选引用的 candidate 时间图通过项目 API 更新", () => {
    const project = createEmptyProject("review");
    const map = createMap();
    project.mediaTimeMaps = [map];
    project.mediaMatchCandidates = [createCandidate(map.id)];
    project.assets = [
      {
        id: "asset-review",
        name: "review.xml",
        fileName: "review.xml",
        color: "#ffffff",
        items: [],
        warnings: [],
        importedAt: "2026-07-12T09:00:00.000Z",
        sourceReceipt: null
      }
    ];
    project.danmakuSourceBindings = [
      {
        id: "binding-review",
        assetId: "asset-review",
        sourceMediaId: "source",
        linkedAt: "2026-07-12T09:00:00.000Z",
        updatedAt: "2026-07-12T09:00:00.000Z"
      }
    ];

    const reviewed = reviewCandidateTimeMapSpan(
      project,
      map.id,
      2,
      "target-extra",
      "2026-07-12T10:00:00.000Z"
    );
    expect(reviewed.mediaTimeMaps[0]?.spans[2]?.kind).toBe("targetOnly");
    expect(project.mediaTimeMaps[0]?.revision).toBe(1);
    expect(reviewed.mediaMatchCandidates[0]?.state).toBe("blocked");

    const resolved = reviewCandidateTimeMapSpan(
      reviewed,
      map.id,
      3,
      "replacement",
      "2026-07-12T10:01:00.000Z"
    );
    expect(resolved.mediaTimeMaps[0]?.quality.level).toBe("blocked");
    expect(resolved.mediaMatchCandidates[0]?.state).toBe("blocked");

    project.mediaMatchCandidates[0].state = "accepted";
    expect(() =>
      reviewCandidateTimeMapSpan(project, map.id, 2, "target-extra", "2026-07-12T10:00:00.000Z")
    ).toThrow("不再属于待复核候选");
  });

  it("允许一次性改写双轴边界和类型，并同步相邻段、候选范围与失效状态", () => {
    const project = createEmptyProject("manual-boundary");
    const map = applyTimeMapSpanReviewDecision(
      createMap(),
      3,
      "replacement",
      "2026-07-12T09:30:00.000Z"
    );
    project.mediaTimeMaps = [map];
    project.mediaMatchCandidates = [createCandidate(map.id)];

    const edited = editCandidateTimeMapSpan(
      project,
      map.id,
      3,
      {
        kind: "sourceOnly",
        sourceStartMs: 12_000,
        sourceEndMs: 30_000,
        targetStartMs: 13_000,
        targetEndMs: 13_000
      },
      "2026-07-12T10:00:00.000Z"
    );
    const editedMap = edited.mediaTimeMaps[0];

    expect(editedMap.spans[2]).toMatchObject({
      targetEndMs: 13_000,
      reason: "manualReview",
      quality: { level: "review" }
    });
    expect(editedMap.spans[3]).toMatchObject({
      kind: "sourceOnly",
      targetStartMs: 13_000,
      targetEndMs: 13_000,
      reason: "manualReview"
    });
    expect(editedMap.revision).toBe(map.revision + 1);
    expect(editedMap.targetEndMs).toBe(13_000);
    expect(editedMap.verification).toBeNull();
    expect(readTimeMapSpanReviewDecision(editedMap, 3)).toBeNull();
    expect(editedMap.evidence.notes.join(" ")).toContain("manual-span-structure-edit:v1:");
    expect(edited.mediaMatchCandidates[0]).toMatchObject({
      targetEndMs: 13_000,
      state: "blocked"
    });
  });

  it("按双轴锚点拆分并可把相邻同类段合并，异类合并明确拒绝", () => {
    const project = createEmptyProject("manual-structure");
    const map = createMap();
    project.mediaTimeMaps = [map];
    project.mediaMatchCandidates = [createCandidate(map.id)];

    const split = splitCandidateTimeMapSpan(
      project,
      map.id,
      0,
      { sourceMs: 5_000, targetMs: 5_000 },
      "2026-07-12T10:00:00.000Z"
    );
    const splitMap = split.mediaTimeMaps[0];
    expect(splitMap.spans).toHaveLength(5);
    expect(splitMap.spans[0]).toMatchObject({
      kind: "matched",
      sourceEndMs: 5_000,
      targetEndMs: 5_000
    });
    expect(splitMap.spans[1]).toMatchObject({
      kind: "matched",
      sourceStartMs: 5_000,
      targetStartMs: 5_000
    });

    const merged = mergeCandidateTimeMapSpanWithNext(
      split,
      map.id,
      0,
      "2026-07-12T10:01:00.000Z"
    );
    expect(merged.mediaTimeMaps[0]?.spans).toHaveLength(4);
    expect(merged.mediaTimeMaps[0]?.spans[0]).toMatchObject({
      kind: "matched",
      sourceStartMs: 0,
      sourceEndMs: 10_000,
      targetStartMs: 0,
      targetEndMs: 10_000,
      reason: "manualReview"
    });
    expect(() =>
      mergeCandidateTimeMapSpanWithNext(
        project,
        map.id,
        0,
        "2026-07-12T10:02:00.000Z"
      )
    ).toThrow("只有相同类型的相邻段可以直接合并");
  });

  it("结构不合法时拒绝写入，不会为所选分类猜测边界", () => {
    const project = createEmptyProject("manual-invalid");
    const map = createMap();
    project.mediaTimeMaps = [map];
    project.mediaMatchCandidates = [createCandidate(map.id)];

    expect(() =>
      editCandidateTimeMapSpan(
        project,
        map.id,
        1,
        {
          kind: "targetOnly",
          sourceStartMs: 10_000,
          sourceEndMs: 12_000,
          targetStartMs: 10_000,
          targetEndMs: 11_000
        },
        "2026-07-12T10:00:00.000Z"
      )
    ).toThrow("结构无效");
    expect(project.mediaTimeMaps[0]?.spans[1]?.kind).toBe("sourceOnly");
  });
});

function createMap(): MediaTimeMap {
  return {
    id: "map-review",
    revision: 1,
    sourceMediaId: "source",
    targetMediaId: "target",
    sourceStream: null,
    targetStream: null,
    sourceIdentity: null,
    targetIdentity: null,
    sourceStartMs: 0,
    sourceEndMs: 30_000,
    targetStartMs: 0,
    targetEndMs: 31_000,
    spans: [
      createTestCompleteTimeMapSpan({
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 0,
        targetEndMs: 10_000
      }, "map-review:span:0001"),
      createTestCompleteTimeMapSpan({
        kind: "sourceOnly",
        sourceStartMs: 10_000,
        sourceEndMs: 12_000,
        targetStartMs: 10_000,
        targetEndMs: 10_000
      }, "map-review:span:0002"),
      createTestCompleteTimeMapSpan({
        kind: "targetOnly",
        sourceStartMs: 12_000,
        sourceEndMs: 12_000,
        targetStartMs: 10_000,
        targetEndMs: 13_000
      }, "map-review:span:0003"),
      {
        ...createTestCompleteTimeMapSpan({
        kind: "ambiguous",
        sourceStartMs: 12_000,
        sourceEndMs: 30_000,
        targetStartMs: 13_000,
        targetEndMs: 31_000
        }, "map-review:span:0004"),
        quality: {
          ...createTestCompleteTimeMapSpan({
            kind: "ambiguous",
            sourceStartMs: 12_000,
            sourceEndMs: 30_000,
            targetStartMs: 13_000,
            targetEndMs: 31_000
          }, "map-review:span:0004").quality,
          level: "blocked",
          reasons: ["存在无法唯一解释的歧义区间。"]
        }
      }
    ],
    quality: {
      level: "blocked",
      probability: null,
      metricSource: "measured",
      coverage: 0.8,
      uniqueContentCoverage: 0.8,
      p50ResidualMs: 50,
      p95ResidualMs: 100,
      p99ResidualMs: 130,
      maxResidualMs: 150,
      boundaryUncertaintyMs: 300,
      alternativeMargin: 0.1,
      anchorCount: 30,
      anchorRegionCount: 3,
      heldOutAnchorCount: 2,
      reasons: ["存在无法唯一解释的歧义区间。"]
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 10,
      visualAnchorCount: 0,
      heldOutAnchorCount: 2,
      top1Top2Margin: 0.1,
      uniqueContentCoverage: 0.8,
      repeatedContentOnly: false,
      selectedTrackReason: "测试轨道。",
      alternativeTrackScores: [],
      notes: []
    },
    verification: null,
    engineVersion: "test",
    featureVersion: "test",
    parametersHash: "test",
    state: "candidate",
    createdAt: "2026-07-12T09:00:00.000Z",
    updatedAt: "2026-07-12T09:00:00.000Z",
    confirmedAt: null
  };
}

function createCandidate(timeMapId: string): MediaMatchCandidate {
  return {
    id: "candidate-review",
    batchId: "batch-review",
    sourceMediaId: "source",
    targetMediaId: "target",
    sourceStartMs: 0,
    sourceEndMs: 30_000,
    targetStartMs: 0,
    targetEndMs: 31_000,
    confidence: 0,
    state: "blocked",
    proposal: {
      anchors: [],
      cutCandidates: [],
      confidence: 0,
      diagnostics: []
    },
    timingRules: [],
    appliedSegmentIds: [],
    timeMapId,
    confirmedTimeMapId: null,
    createdAt: "2026-07-12T09:00:00.000Z",
    updatedAt: "2026-07-12T09:00:00.000Z"
  };
}
