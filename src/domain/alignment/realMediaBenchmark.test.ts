import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  C137_REQUIRED_SCENARIOS,
  evaluateRealMediaBenchmark,
  parseRealMediaBenchmarkManifestJson,
  parseRealMediaBenchmarkResultJson,
  validateRealMediaBenchmarkManifest,
  validateRealMediaBenchmarkResult,
  type RealMediaBenchmarkCase,
  type RealMediaBenchmarkManifest,
  type RealMediaBenchmarkMediaKind,
  type RealMediaBenchmarkPrediction
} from "./realMediaBenchmark";
import type { TimeMapSpan } from "./timeMap";

describe("C137 真实媒体 manifest", () => {
  it("严格读取占位示例，并明确排除在真实数据门槛之外", () => {
    const json = readFileSync(
      resolve("fixtures", "alignment", "c137-real-media-manifest.example.json"),
      "utf8"
    );
    const manifest = parseRealMediaBenchmarkManifestJson(json);

    expect(manifest.isExample).toBe(true);
    expect(manifest.cases[0]).toMatchObject({
      mediaKind: "placeholder",
      source: { audioStreamIndex: 1 },
      target: { audioStreamIndex: 1 }
    });
    const result = evaluateRealMediaBenchmark(manifest, []);
    expect(result.gate).toMatchObject({
      status: "insufficient-data",
      verifiedEligible: false
    });
  });

  it("拒绝缺少显式音轨和许可说明的清单", () => {
    const manifest = createManifest([createBidirectionalCase()]);
    const invalid = structuredClone(manifest) as unknown as Record<string, unknown>;
    const cases = invalid.cases as Array<Record<string, unknown>>;
    const source = cases[0].source as Record<string, unknown>;
    delete source.audioStreamIndex;
    cases[0].licenseNotes = [];

    const validation = validateRealMediaBenchmarkManifest(invalid);

    expect(validation.valid).toBe(false);
    expect(validation.issues.join("\n")).toContain("audioStreamIndex");
    expect(validation.issues.join("\n")).toContain("licenseNotes");
  });

  it("拒绝只在时间轴局部放置 anchor 的真实关系", () => {
    const benchmarkCase = createTargetOnlyCase("real");
    benchmarkCase.gold.matchedAnchors = benchmarkCase.gold.matchedAnchors.slice(0, 2);

    const validation = validateRealMediaBenchmarkManifest(createManifest([benchmarkCase]));

    expect(validation.valid).toBe(false);
    expect(validation.issues.join("\n")).toContain("至少需要 5 个独立 matched anchor");
  });
});

describe("C137 纯 TimeMap 评测", () => {
  it("完美预测得到零 anchor/边界误差和满分编辑分类", () => {
    const benchmarkCase = createBidirectionalCase();
    const result = evaluateSingle(benchmarkCase, createBidirectionalSpans());
    const caseResult = result.caseResults[0];

    expect(caseResult.structureValid).toBe(true);
    expect(caseResult.anchorError).toEqual({ sampleCount: 6, p50Ms: 0, p95Ms: 0, maxMs: 0 });
    expect(caseResult.boundaryError).toEqual({
      sampleCount: 10,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0
    });
    expect(caseResult.editClassification).toMatchObject({
      truePositive: 3,
      falsePositive: 0,
      falseNegative: 0,
      precision: 1,
      recall: 1,
      f1: 1
    });
    expect(caseResult.mappingCoverage).toBe(1);
    expect(caseResult.ambiguousRatio).toBeCloseTo(2 / 30);
    expect(validateRealMediaBenchmarkResult(result)).toEqual({ valid: true, issues: [] });
    expect(parseRealMediaBenchmarkResultJson(JSON.stringify(result))).toEqual(result);
  });

  it("量化全局延迟和线性漂移造成的 anchor 绝对误差", () => {
    const benchmarkCase = createNoEditCase();
    const predicted: TimeMapSpan[] = [matched(0, 10_000, 100, 10_300)];
    const caseResult = evaluateSingle(benchmarkCase, predicted).caseResults[0];

    expect(caseResult.anchorAbsoluteErrorsMs).toEqual([100, 200, 280]);
    expect(caseResult.anchorError).toEqual({
      sampleCount: 3,
      p50Ms: 200,
      p95Ms: 280,
      maxMs: 280
    });
    expect(caseResult.mappingCoverage).toBe(1);
  });

  it("错误边界同时计为边界误差、漏报和误报", () => {
    const benchmarkCase = createTargetOnlyCase();
    const predicted: TimeMapSpan[] = [
      matched(0, 10_000, 0, 11_000),
      targetOnly(10_000, 11_000, 16_000),
      matched(10_000, 20_000, 16_000, 25_000)
    ];
    const caseResult = evaluateSingle(benchmarkCase, predicted).caseResults[0];

    expect(caseResult.boundaryAbsoluteErrorsMs).toEqual([0, 1_000, 1_000]);
    expect(caseResult.boundaryError.p95Ms).toBe(1_000);
    expect(caseResult.editClassification).toMatchObject({
      truePositive: 0,
      falsePositive: 1,
      falseNegative: 1,
      f1: 0
    });
    expect(caseResult.missedEvents).toEqual([{ kind: "targetOnly", index: 0 }]);
    expect(caseResult.falsePositiveEvents).toEqual([{ kind: "targetOnly", index: 1 }]);
  });

  it("把漏掉的原片独有内容记为 targetOnly 漏报", () => {
    const benchmarkCase = createTargetOnlyCase();
    const predicted: TimeMapSpan[] = [matched(0, 20_000, 0, 25_000)];
    const caseResult = evaluateSingle(benchmarkCase, predicted).caseResults[0];

    expect(caseResult.predictedEditCount).toBe(0);
    expect(caseResult.editClassification).toMatchObject({
      truePositive: 0,
      falsePositive: 0,
      falseNegative: 1,
      precision: 0,
      recall: 0,
      f1: 0
    });
    expect(caseResult.missedEvents).toEqual([{ kind: "targetOnly", index: 0 }]);
  });

  it("分别统计 sourceOnly、targetOnly 与 ambiguous 双边编辑", () => {
    const caseResult = evaluateSingle(createBidirectionalCase(), createBidirectionalSpans())
      .caseResults[0];

    expect(caseResult.editClassificationByKind.sourceOnly).toMatchObject({
      truePositive: 1,
      f1: 1
    });
    expect(caseResult.editClassificationByKind.targetOnly).toMatchObject({
      truePositive: 1,
      f1: 1
    });
    expect(caseResult.editClassificationByKind.ambiguous).toMatchObject({
      truePositive: 1,
      f1: 1
    });
  });

  it("编辑事件先最大化容差内匹配数，不被局部最近边界贪心误导", () => {
    const benchmarkCase = createNoEditCase();
    benchmarkCase.gold.sourceEndMs = 30_000;
    benchmarkCase.gold.targetEndMs = 30_000;
    benchmarkCase.gold.matchedAnchors = [
      { id: "a-0", sourceMs: 5_000, targetMs: 5_000 },
      { id: "a-1", sourceMs: 15_000, targetMs: 15_000 },
      { id: "a-2", sourceMs: 25_000, targetMs: 25_000 }
    ];
    benchmarkCase.scenarios = ["ambiguous"];
    benchmarkCase.boundaryToleranceMs = 10_000;
    benchmarkCase.gold.ambiguousSpans = [
      ambiguous(0, 1_000, 0, 1_000),
      ambiguous(10_000, 11_000, 10_000, 11_000)
    ];
    const prediction: TimeMapSpan[] = [
      matched(0, 9_000, 0, 9_000),
      ambiguous(9_000, 10_000, 9_000, 10_000),
      matched(10_000, 20_000, 10_000, 20_000),
      ambiguous(20_000, 21_000, 20_000, 21_000),
      matched(21_000, 30_000, 21_000, 30_000)
    ];

    const caseResult = evaluateSingle(benchmarkCase, prediction).caseResults[0];

    expect(caseResult.editClassificationByKind.ambiguous).toMatchObject({
      truePositive: 2,
      falsePositive: 0,
      falseNegative: 0,
      f1: 1
    });
  });

  it("把非单调、重叠或断裂预测记录为结构失败而不是继续映射", () => {
    const predicted: TimeMapSpan[] = [
      matched(0, 7_000, 0, 7_000),
      matched(6_000, 10_000, 8_000, 12_000)
    ];
    const caseResult = evaluateSingle(createNoEditCase(), predicted).caseResults[0];

    expect(caseResult.structureValid).toBe(false);
    expect(caseResult.structuralFailureCount).toBeGreaterThan(0);
    expect(caseResult.monotonicityFailureCount).toBeGreaterThan(0);
    expect(caseResult.mappedAnchorCount).toBe(0);
    expect(caseResult.unmappedAnchorCount).toBe(3);
  });

  it("真实样本规模或必需场景不足时 gate 必须是 insufficient-data", () => {
    const benchmarkCase = createTargetOnlyCase("real");
    const result = evaluateSingle(benchmarkCase, createTargetOnlySpans());

    expect(result.realMediaOverall.relationCount).toBe(1);
    expect(result.gate.status).toBe("insufficient-data");
    expect(result.gate.verifiedEligible).toBe(false);
    expect(result.gate.qualityChecks).toEqual([]);
    expect(result.gate.dataChecks.find((check) => check.id === "real-relations")).toMatchObject(
      {
        passed: false,
        actual: 1
      }
    );
  });

  it("数据规模达标但只映射时间轴开头时 coverage 闸门必须失败", () => {
    const cases = Array.from({ length: 150 }, (_, index) => {
      const benchmarkCase = createTargetOnlyCase("real");
      benchmarkCase.id = `coverage-guard-${index}`;
      benchmarkCase.title = `覆盖率闸门关系 ${index}`;
      benchmarkCase.scenarios = [...C137_REQUIRED_SCENARIOS, "multi-edit"];
      benchmarkCase.gold.sourceOnlySpans = [
        sourceOnly(1_000, 1_100, 1_000),
        sourceOnly(4_000, 4_100, 4_200)
      ];
      benchmarkCase.gold.targetOnlySpans = [targetOnly(2_000, 2_000, 2_100)];
      benchmarkCase.gold.ambiguousSpans = [ambiguous(3_000, 3_100, 3_100, 3_200)];
      return benchmarkCase;
    });
    const predictions = cases.map((benchmarkCase) => ({
      caseId: benchmarkCase.id,
      spans: [matched(0, 100, 0, 100)]
    }));

    const result = evaluateRealMediaBenchmark(createManifest(cases), predictions);

    expect(result.gate.status).toBe("fail");
    expect(result.gate.dataChecks.every((check) => check.passed)).toBe(true);
    expect(
      result.gate.qualityChecks.find((check) => check.id === "mapping-coverage")
    ).toMatchObject({ passed: false, actual: 0.005 });
    expect(
      result.gate.qualityChecks.find(
        (check) => check.id === "per-relation-mapping-coverage"
      )
    ).toMatchObject({ passed: false });
  });
});

function evaluateSingle(benchmarkCase: RealMediaBenchmarkCase, spans: TimeMapSpan[]) {
  const manifest = createManifest([benchmarkCase]);
  const predictions: RealMediaBenchmarkPrediction[] = [{ caseId: benchmarkCase.id, spans }];
  return evaluateRealMediaBenchmark(manifest, predictions);
}

function createManifest(cases: RealMediaBenchmarkCase[]): RealMediaBenchmarkManifest {
  return {
    schemaVersion: 1,
    id: "unit-real-media-benchmark",
    name: "单元测试基准",
    datasetVersion: "unit-1",
    description: "只用于评测函数单元测试，不代表真实精度结果。",
    isExample: false,
    licenseNotes: ["测试数据为程序构造，不包含媒体。"],
    cases
  };
}

function createMediaInput(side: "source" | "target") {
  return {
    path: `C:\\unit-test\\${side}.mkv`,
    audioStreamIndex: 1,
    videoStreamIndex: 0,
    versionNote: `${side} 单元测试版本`,
    licenseNote: "程序构造路径，不指向真实媒体。"
  };
}

function createBidirectionalCase(
  mediaKind: RealMediaBenchmarkMediaKind = "synthetic"
): RealMediaBenchmarkCase {
  return {
    id: "bidirectional-edits",
    title: "双边编辑与 ambiguous",
    mediaKind,
    scenarios: ["source-only", "target-only", "ambiguous", "multi-edit"],
    source: createMediaInput("source"),
    target: createMediaInput("target"),
    boundaryToleranceMs: 250,
    versionNotes: ["程序构造的双边编辑。"],
    licenseNotes: ["不包含真实媒体。"],
    gold: {
      sourceStartMs: 0,
      sourceEndMs: 30_000,
      targetStartMs: 0,
      targetEndMs: 34_000,
      matchedAnchors: [
        { id: "a-0", sourceMs: 0, targetMs: 0 },
        { id: "a-1", sourceMs: 9_000, targetMs: 9_000 },
        { id: "a-2", sourceMs: 10_000, targetMs: 15_000 },
        { id: "a-3", sourceMs: 19_000, targetMs: 24_000 },
        { id: "a-4", sourceMs: 23_000, targetMs: 26_000 },
        { id: "a-5", sourceMs: 29_000, targetMs: 33_000 }
      ],
      sourceOnlySpans: [sourceOnly(20_000, 22_000, 25_000)],
      targetOnlySpans: [targetOnly(10_000, 10_000, 15_000)],
      ambiguousSpans: [ambiguous(25_000, 27_000, 28_000, 31_000)]
    }
  };
}

function createBidirectionalSpans(): TimeMapSpan[] {
  return [
    matched(0, 10_000, 0, 10_000),
    targetOnly(10_000, 10_000, 15_000),
    matched(10_000, 20_000, 15_000, 25_000),
    sourceOnly(20_000, 22_000, 25_000),
    matched(22_000, 25_000, 25_000, 28_000),
    ambiguous(25_000, 27_000, 28_000, 31_000),
    matched(27_000, 30_000, 31_000, 34_000)
  ];
}

function createNoEditCase(): RealMediaBenchmarkCase {
  return {
    id: "delay-and-drift",
    title: "全局延迟与线性漂移",
    mediaKind: "synthetic",
    scenarios: ["global-offset", "time-stretch"],
    source: createMediaInput("source"),
    target: createMediaInput("target"),
    boundaryToleranceMs: 250,
    versionNotes: ["程序构造的单位斜率 gold。"],
    licenseNotes: ["不包含真实媒体。"],
    gold: {
      sourceStartMs: 0,
      sourceEndMs: 10_000,
      targetStartMs: 0,
      targetEndMs: 10_000,
      matchedAnchors: [
        { id: "a-0", sourceMs: 0, targetMs: 0 },
        { id: "a-1", sourceMs: 5_000, targetMs: 5_000 },
        { id: "a-2", sourceMs: 9_000, targetMs: 9_000 }
      ],
      sourceOnlySpans: [],
      targetOnlySpans: [],
      ambiguousSpans: []
    }
  };
}

function createTargetOnlyCase(
  mediaKind: RealMediaBenchmarkMediaKind = "synthetic"
): RealMediaBenchmarkCase {
  return {
    id: "target-only-cut",
    title: "原片独有内容",
    mediaKind,
    scenarios: ["target-only"],
    source: createMediaInput("source"),
    target: createMediaInput("target"),
    boundaryToleranceMs: 250,
    versionNotes: ["程序构造的 5 秒 targetOnly。"],
    licenseNotes: ["不包含真实媒体。"],
    gold: {
      sourceStartMs: 0,
      sourceEndMs: 20_000,
      targetStartMs: 0,
      targetEndMs: 25_000,
      matchedAnchors:
        mediaKind === "real"
          ? [
              { id: "a-0", sourceMs: 0, targetMs: 0 },
              { id: "a-1", sourceMs: 4_000, targetMs: 4_000 },
              { id: "a-2", sourceMs: 8_000, targetMs: 8_000 },
              { id: "a-3", sourceMs: 12_000, targetMs: 17_000 },
              { id: "a-4", sourceMs: 16_000, targetMs: 21_000 },
              { id: "a-5", sourceMs: 19_000, targetMs: 24_000 }
            ]
          : [
              { id: "a-0", sourceMs: 0, targetMs: 0 },
              { id: "a-1", sourceMs: 9_000, targetMs: 9_000 },
              { id: "a-2", sourceMs: 10_000, targetMs: 15_000 },
              { id: "a-3", sourceMs: 19_000, targetMs: 24_000 }
            ],
      sourceOnlySpans: [],
      targetOnlySpans: [targetOnly(10_000, 10_000, 15_000)],
      ambiguousSpans: []
    }
  };
}

function createTargetOnlySpans(): TimeMapSpan[] {
  return [
    matched(0, 10_000, 0, 10_000),
    targetOnly(10_000, 10_000, 15_000),
    matched(10_000, 20_000, 15_000, 25_000)
  ];
}

function matched(
  sourceStartMs: number,
  sourceEndMs: number,
  targetStartMs: number,
  targetEndMs: number
): TimeMapSpan {
  return { kind: "matched", sourceStartMs, sourceEndMs, targetStartMs, targetEndMs };
}

function sourceOnly(sourceStartMs: number, sourceEndMs: number, targetAtMs: number) {
  return {
    kind: "sourceOnly" as const,
    sourceStartMs,
    sourceEndMs,
    targetStartMs: targetAtMs,
    targetEndMs: targetAtMs
  };
}

function targetOnly(sourceAtMs: number, targetStartMs: number, targetEndMs: number) {
  return {
    kind: "targetOnly" as const,
    sourceStartMs: sourceAtMs,
    sourceEndMs: sourceAtMs,
    targetStartMs,
    targetEndMs
  };
}

function ambiguous(
  sourceStartMs: number,
  sourceEndMs: number,
  targetStartMs: number,
  targetEndMs: number
) {
  return {
    kind: "ambiguous" as const,
    sourceStartMs,
    sourceEndMs,
    targetStartMs,
    targetEndMs
  };
}
