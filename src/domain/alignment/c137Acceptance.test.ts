import { describe, expect, it } from "vitest";
import { createCompleteC137PerformanceEvidenceFixture } from "../../test/c137PerformanceEvidence";
import {
  computeC137PerformanceEnvironmentDigest,
  computeC137PerformanceEvidenceDigest
} from "./c137PerformanceEvidence";
import {
  computeC137CanonicalDigest,
  computeC137EnvironmentDigest,
  computeC137ReportEvidenceDigest,
  evaluateC137AcceptanceBundle,
  validateC137AcceptanceBundle,
  type C137AcceptanceBundle,
  type C137AcceptanceReports,
  type C137AcceptanceTrustContext,
  type C137DatasetSplit,
  type C137Digest,
  type C137EditKind,
  type C137EvidenceBinding,
  type C137EnvironmentFingerprint,
  type C137RelationshipDecisionEvidence
} from "./c137Acceptance";

describe("C137 fail-closed acceptance gate", () => {
  it("空 evidence 与未批准 ECE/Brier/取消阈值只能 incomplete", () => {
    const bundle = createCompleteBundle();
    bundle.protocol.calibrationThresholds = {
      status: "pending",
      approvalId: null,
      maximumEce: null,
      maximumBrierScore: null
    };
    bundle.protocol.cancellationThreshold = {
      status: "pending",
      approvalId: null,
      maximumP95Ms: null
    };
    bundle.receipts = { datasetApproval: null, preflight: null, predictionRun: null };
    bundle.reports = {
      dataset: null,
      relationshipRanking: null,
      timeMap: null,
      calibration: null,
      visualFallback: null,
      degradation: null,
      northStar: null,
      performance: null,
      uiWalkthrough: null,
      releaseVerification: null
    };

    expect(validateC137AcceptanceBundle(bundle)).toEqual({ valid: true, issues: [] });
    expect(evaluateC137AcceptanceBundle(bundle)).toMatchObject({
      scope: "c137-release-acceptance",
      status: "incomplete-evidence",
      verifiedEligible: false
    });
  });

  it("只有完整 real-frozen 原始 evidence 才能 pass", () => {
    const bundle = createCompleteBundle();
    const gate = evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle));

    expect(gate.status).toBe("pass");
    expect(gate.verifiedEligible).toBe(true);
    expect(gate.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("修改硬件或工具链字段但保留旧环境摘要时严格拒绝", () => {
    const bundle = createCompleteBundle();
    bundle.environment.cpuModel = "tampered cpu";

    const validation = validateC137AcceptanceBundle(bundle);
    expect(validation.valid).toBe(false);
    expect(validation.issues.join("\n")).toContain("规范摘要不一致");
    expect(evaluateC137AcceptanceBundle(bundle, createTrustContext(createCompleteBundle()))).toMatchObject({
      status: "incomplete-evidence",
      verifiedEligible: false
    });
  });

  it("完整 bundle 默认没有外部信任根，仍必须 incomplete", () => {
    const gate = evaluateC137AcceptanceBundle(createCompleteBundle());

    expect(gate.status).toBe("incomplete-evidence");
    expect(gate.verifiedEligible).toBe(false);
    expect(gate.checks.find((check) => check.id === "external-trust-context")).toMatchObject({
      status: "incomplete",
      actual: "missing"
    });
  });

  it("150 个完美 TimeMap 但缺少其他验收报告时仍不能完整放行", () => {
    const bundle = createCompleteBundle();
    bundle.reports.relationshipRanking = null;
    bundle.reports.calibration = null;
    bundle.reports.visualFallback = null;
    bundle.reports.degradation = null;
    bundle.reports.northStar = null;
    bundle.reports.performance = null;
    bundle.reports.uiWalkthrough = null;
    bundle.reports.releaseVerification = null;

    const gate = evaluateC137AcceptanceBundle(bundle);

    expect(bundle.reports.timeMap?.cases).toHaveLength(150);
    expect(gate.status).toBe("incomplete-evidence");
    expect(gate.verifiedEligible).toBe(false);
  });

  it("synthetic 或 real-development 自报不能进入完整资格", () => {
    for (const certificationClass of ["synthetic-smoke", "real-development"] as const) {
      const bundle = createCompleteBundle();
      bundle.certificationClass = certificationClass;
      if (bundle.receipts.datasetApproval) {
        bundle.receipts.datasetApproval.certificationClass = certificationClass;
      }
      if (certificationClass === "synthetic-smoke" && bundle.reports.dataset) {
        bundle.reports.dataset.cases.forEach((item) => {
          item.mediaKind = "synthetic";
        });
      }

      refreshReportEvidenceDigests(bundle);
      expect(evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle))).toMatchObject({
        status: "incomplete-evidence",
        verifiedEligible: false
      });
    }
  });

  it("只用 frozen-test 重算 Top-1，development 大样本不能掩盖冻结集失败", () => {
    const bundle = createCompleteBundle();
    const dataset = bundle.reports.dataset!;
    const timeMap = bundle.reports.timeMap!;
    dataset.cases.forEach((item, index) => {
      item.split = index < 105 ? "development" : "frozen-test";
    });
    timeMap.cases.forEach((item, index) => {
      item.split = index < 105 ? "development" : "frozen-test";
    });
    dataset.cases[105]?.scenarios.push("time-stretch");
    timeMap.cases[105]?.scenarios.push("time-stretch");
    if (timeMap.cases[105]) {
      timeMap.cases[105].endDriftAt45MinutesMs = 0;
    }
    const decisions: C137RelationshipDecisionEvidence[] = [
      ...Array.from({ length: 10_000 }, (_, index) =>
        relationshipDecision(index, `case-${index % 105}`, "development", true, "dev")
      ),
      ...Array.from({ length: 1_000 }, (_, index) =>
        relationshipDecision(
          index,
          `case-${105 + (index % 45)}`,
          "frozen-test",
          index >= 6,
          "frozen"
        )
      )
    ];
    bundle.reports.relationshipRanking!.decisions = decisions;
    bundle.reports.calibration!.samples = decisions
      .filter((item) => item.split === "frozen-test")
      .map((item) => ({
        decisionId: item.decisionId,
        mediaKind: "real" as const,
        split: "frozen-test" as const,
        probability: item.rankedCandidateIds[0] === item.goldCandidateId ? 1 : 0,
        correct: item.rankedCandidateIds[0] === item.goldCandidateId
      }));
    bundle.reports.visualFallback!.cases = bundle.reports.visualFallback!.cases
      .slice(105)
      .map((item) => ({ ...item, split: "frozen-test" as const }));
    bundle.reports.degradation!.cases = Array.from({ length: 10 }, (_, index) => ({
      caseId: `case-${140 + index}`,
      mediaKind: "real" as const,
      split: "frozen-test" as const,
      expectedLevel: "blocked" as const,
      actualLevel: "blocked" as const,
      expectedReasonCode: "pts-untrusted",
      actualReasonCode: "pts-untrusted"
    }));

    refreshReportEvidenceDigests(bundle);
    const gate = evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle));
    const top1 = gate.checks.find((check) => check.id === "ranking-same-audio-top1");

    expect(top1).toMatchObject({ status: "fail", actual: 0.994 });
    expect(gate.status).toBe("fail");
    expect(gate.verifiedEligible).toBe(false);
  });

  it("receipt/report digest 不一致必须 incomplete", () => {
    const bundle = createCompleteBundle();
    const trustContext = createTrustContext(bundle);
    bundle.reports.timeMap!.binding.manifestDigest = digest("f");

    expect(validateC137AcceptanceBundle(bundle)).toEqual({ valid: true, issues: [] });
    const gate = evaluateC137AcceptanceBundle(bundle, trustContext);
    expect(gate.status).toBe("incomplete-evidence");
    expect(gate.checks.find((check) => check.id === "binding:timeMap")).toMatchObject({
      status: "incomplete"
    });
  });

  it("receipt 内容被改写但未获外部重新审批时必须 incomplete", () => {
    const bundle = createCompleteBundle();
    const trustContext = createTrustContext(bundle);
    bundle.receipts.preflight!.completedAt = "2026-07-12T08:00:00.000Z";

    const gate = evaluateC137AcceptanceBundle(bundle, trustContext);

    expect(gate.status).toBe("incomplete-evidence");
    expect(gate.checks.find((check) => check.id === "trusted-receipt:preflight")).toMatchObject({
      status: "incomplete"
    });
  });

  it("raw report 内容篡改但不更新 evidence digest 时必须 incomplete", () => {
    const bundle = createCompleteBundle();
    const trustContext = createTrustContext(bundle);
    bundle.reports.timeMap!.cases[0].matchedProjectionErrorsMs[0] = 199;

    const gate = evaluateC137AcceptanceBundle(bundle, trustContext);

    expect(gate.status).toBe("incomplete-evidence");
    expect(gate.checks.find((check) => check.id === "trusted-report:timeMap")).toMatchObject({
      status: "incomplete"
    });
  });

  it("旧版手写 runs/cancellation 数组不能升级为 performance v2", () => {
    const bundle = createCompleteBundle();
    bundle.reports.performance = {
      schemaVersion: 1,
      binding: bundle.reports.performance!.binding,
      runs: [],
      cancellationLatenciesMs: []
    } as unknown as C137AcceptanceBundle["reports"]["performance"];

    const validation = validateC137AcceptanceBundle(bundle);
    expect(validation.valid).toBe(false);
    expect(validation.issues.join("\n")).toContain("rawEvidence");
  });

  it("raw performance plan 未命中受信 protocol 时保持 incomplete", () => {
    const bundle = createCompleteBundle();
    bundle.protocol.performancePlanDigest = digest("e");
    const gate = evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle));

    expect(gate.status).toBe("incomplete-evidence");
    expect(gate.checks.find((check) => check.id === "performance-measurements")).toMatchObject({
      status: "incomplete"
    });
  });

  it("ToolHelp engineering raw 不能晋升为正式性能通过", () => {
    const bundle = createCompleteBundle();
    const raw = bundle.reports.performance!.rawEvidence;
    raw.collector.sampler = "windows-toolhelp-working-set-v1";
    for (const trial of raw.trials) {
      if (trial.trialType === "run") {
        for (const item of trial.cases) {
          item.telemetry.memory.sampler = "windows-toolhelp-working-set-v1";
        }
      } else {
        trial.telemetry.memory.sampler = "windows-toolhelp-working-set-v1";
      }
    }
    raw.evidenceDigest = computeC137PerformanceEvidenceDigest(raw);
    refreshReportEvidenceDigests(bundle);
    const gate = evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle));

    expect(gate.status).toBe("incomplete-evidence");
    expect(gate.checks.find((check) => check.id === "performance-measurements"))
      .toMatchObject({ status: "incomplete", actual: false });
  });

  it("bundle 自带任意 approval ID 不能替代外部受信 receipt digest", () => {
    const bundle = createCompleteBundle();
    const trustContext = createTrustContext(bundle);
    bundle.receipts.datasetApproval!.receiptId = "self-declared-approved";

    const gate = evaluateC137AcceptanceBundle(bundle, trustContext);

    expect(gate.status).toBe("incomplete-evidence");
    expect(
      gate.checks.find((check) => check.id === "trusted-receipt:datasetApproval")
    ).toMatchObject({ status: "incomplete" });
  });

  it("拒绝注入 summary/gate，所有汇总必须从 raw evidence 重算", () => {
    const tampered = structuredClone(createCompleteBundle()) as unknown as Record<string, unknown>;
    tampered.summary = { status: "pass" };
    tampered.gate = { status: "pass", verifiedEligible: true };

    const validation = validateC137AcceptanceBundle(tampered);

    expect(validation.valid).toBe(false);
    expect(validation.issues.join("\n")).toContain("未知字段");
    expect(evaluateC137AcceptanceBundle(tampered)).toMatchObject({
      status: "incomplete-evidence",
      verifiedEligible: false
    });
  });
});

function createCompleteBundle(): C137AcceptanceBundle {
  const manifestDigest = digest("1");
  const goldDigest = digest("2");
  const predictionsDigest = digest("3");
  const buildDigest = digest("5");
  const parametersDigest = digest("6");
  const performanceEvidence = createCompleteC137PerformanceEvidenceFixture();
  performanceEvidence.collector.sampler = "windows-job-object-working-set-v1";
  performanceEvidence.environment.storageScope = "workload-media-volumes";
  const { digest: ignoredEnvironmentDigest, ...performanceEnvironmentFields } =
    performanceEvidence.environment;
  void ignoredEnvironmentDigest;
  performanceEvidence.environment.digest =
    computeC137PerformanceEnvironmentDigest(performanceEnvironmentFields);
  for (const trial of performanceEvidence.trials) {
    if (trial.trialType === "run") {
      for (const item of trial.cases) {
        item.telemetry.memory.sampler = "windows-job-object-working-set-v1";
      }
    } else {
      trial.telemetry.memory.sampler = "windows-job-object-working-set-v1";
    }
  }
  performanceEvidence.evidenceDigest = computeC137PerformanceEvidenceDigest(performanceEvidence);
  const performanceEnvironment = performanceEvidence.environment;
  const environmentWithoutDigest: Omit<C137EnvironmentFingerprint, "digest"> = {
    schemaVersion: 2,
    operatingSystem: performanceEnvironment.operatingSystem,
    operatingSystemVersion: performanceEnvironment.operatingSystemVersion,
    architecture: performanceEnvironment.architecture,
    cpuModel: performanceEnvironment.cpuModel,
    physicalCoreCount: performanceEnvironment.physicalCoreCount,
    logicalCoreCount: performanceEnvironment.logicalCoreCount,
    totalMemoryBytes: performanceEnvironment.totalMemoryBytes,
    storageScope: performanceEnvironment.storageScope,
    storageKind: performanceEnvironment.storageKind,
    powerProfile: performanceEnvironment.powerProfile,
    ffmpegVersion: performanceEnvironment.ffmpeg.version,
    ffmpegBinaryDigest: performanceEnvironment.ffmpeg.binaryDigest,
    ffprobeVersion: performanceEnvironment.ffprobe.version,
    ffprobeBinaryDigest: performanceEnvironment.ffprobe.binaryDigest
  };
  const environmentDigest = computeC137EnvironmentDigest(environmentWithoutDigest);
  const binding: C137EvidenceBinding = {
    manifestDigest,
    goldDigest,
    datasetVersion: "real-frozen-1",
    predictionsDigest,
    protocolId: "c137-acceptance@2",
    environmentDigest,
    buildDigest,
    engineVersion: "alignment-v2",
    featureVersion: "feature-v2",
    parametersDigest,
    evidenceDigest: digest("8")
  };
  const datasetCases = Array.from({ length: 150 }, (_, index) => ({
    caseId: `case-${index}`,
    mediaKind: "real" as const,
    split: "frozen-test" as const,
    scenarios:
      index < 30
        ? (["long-reference", "time-stretch"] as const)
        : (["global-offset"] as const),
    goldEditEventCount: 4,
    independentlyReviewed: true,
    adjudicationComplete: true
  })).map((item) => ({ ...item, scenarios: [...item.scenarios] }));
  const decisions = Array.from({ length: 1_000 }, (_, index) =>
    relationshipDecision(index, `case-${index % 150}`, "frozen-test", true, "frozen")
  );
  const timeMapCases = datasetCases.map((item, caseIndex) => ({
    caseId: item.caseId,
    mediaKind: "real" as const,
    split: item.split,
    scenarios: [...item.scenarios],
    matchedProjectionErrorsMs: [0, 0, 0],
    endDriftAt45MinutesMs: item.scenarios.includes("time-stretch") ? 0 : null,
    editDecisions: Array.from({ length: 4 }, (_, eventIndex) => {
      const kind = ["sourceOnly", "targetOnly", "replacement"][(caseIndex + eventIndex) % 3] as C137EditKind;
      return {
        eventId: `${item.caseId}-event-${eventIndex}`,
        goldKind: kind,
        predictedKind: kind,
        durationMs: 1_000,
        boundaryErrorMs: 0,
        durationErrorMs: 0
      };
    })
  }));

  const bundle: C137AcceptanceBundle = {
    schemaVersion: 1,
    kind: "c137-acceptance-bundle",
    manifestDigest,
    datasetVersion: "real-frozen-1",
    certificationClass: "real-frozen",
    protocol: {
      schemaVersion: 2,
      id: "c137-acceptance",
      version: "2",
      topK: 5,
      calibrationBinCount: 10,
      requiredColdRuns: 1,
      requiredHotRuns: 1,
      requiredCancellationRuns: 1,
      performancePlanDigest: performanceEvidence.planDigest,
      maximumMemorySampleIntervalMs: 100,
      requiredMonotonicClock: "rust-std-instant-session-relative-v1",
      requiredMemorySampler: "windows-job-object-working-set-v1",
      requiredStorageScope: "workload-media-volumes",
      performanceAggregation: "maximum",
      memoryScope: "application-process-tree",
      coldCacheDefinition: "empty-application-feature-cache",
      hotCacheDefinition: "same-process-after-complete-warmup",
      targetEnvironmentDigest: environmentDigest,
      calibrationThresholds: {
        status: "approved",
        approvalId: "calibration-threshold-review-1",
        maximumEce: 0.05,
        maximumBrierScore: 0.05
      },
      cancellationThreshold: {
        status: "approved",
        approvalId: "cancellation-threshold-review-1",
        maximumP95Ms: 1_000
      }
    },
    environment: {
      ...environmentWithoutDigest,
      digest: environmentDigest,
    },
    runner: {
      schemaVersion: 1,
      appVersion: "0.1.0",
      gitCommit: "test-commit",
      buildProfile: "release",
      buildDigest,
      engineVersion: "alignment-v2",
      featureVersion: "feature-v2",
      parametersDigest
    },
    receipts: {
      datasetApproval: {
        schemaVersion: 1,
        receiptId: "dataset-approval-1",
        manifestDigest,
        goldDigest,
        datasetVersion: "real-frozen-1",
        certificationClass: "real-frozen",
        licenseReviewComplete: true,
        independentReviewComplete: true,
        frozenGoldSealed: true,
        approvedAt: "2026-07-12T00:00:00.000Z"
      },
      preflight: {
        schemaVersion: 1,
        receiptId: "preflight-1",
        manifestDigest,
        datasetVersion: "real-frozen-1",
        mediaBindingsDigest: digest("b"),
        ok: true,
        realRelationCount: 150,
        checkedFileCount: 300,
        completedAt: "2026-07-12T00:01:00.000Z"
      },
      predictionRun: {
        schemaVersion: 1,
        receiptId: "prediction-run-1",
        manifestDigest,
        datasetVersion: "real-frozen-1",
        predictionsDigest,
        protocolId: "c137-acceptance@2",
        environmentDigest,
        buildDigest,
        engineVersion: "alignment-v2",
        featureVersion: "feature-v2",
        parametersDigest,
        completedAt: "2026-07-12T00:02:00.000Z"
      }
    },
    reports: {
      dataset: { schemaVersion: 1, binding: { ...binding }, cases: datasetCases },
      relationshipRanking: {
        schemaVersion: 1,
        binding: { ...binding },
        decisions
      },
      timeMap: { schemaVersion: 1, binding: { ...binding }, cases: timeMapCases },
      calibration: {
        schemaVersion: 1,
        binding: { ...binding },
        samples: decisions.map((item) => ({
          decisionId: item.decisionId,
          mediaKind: "real" as const,
          split: "frozen-test" as const,
          probability: 1,
          correct: true
        }))
      },
      visualFallback: {
        schemaVersion: 1,
        binding: { ...binding },
        cases: datasetCases.map((item) => ({
          caseId: item.caseId,
          mediaKind: "real" as const,
          split: "frozen-test" as const,
          goldCandidateId: `visual-${item.caseId}`,
          rankedCandidateIds: [`visual-${item.caseId}`, `visual-distractor-${item.caseId}`],
          projectionErrorsMs: [0],
          sparseVisualAutomaticVerified: false
        }))
      },
      degradation: {
        schemaVersion: 1,
        binding: { ...binding },
        cases: datasetCases.slice(0, 10).map((item) => ({
          caseId: item.caseId,
          mediaKind: "real" as const,
          split: "frozen-test" as const,
          expectedLevel: "blocked" as const,
          actualLevel: "blocked" as const,
          expectedReasonCode: "pts-untrusted",
          actualReasonCode: "pts-untrusted"
        }))
      },
      northStar: {
        schemaVersion: 1,
        binding: { ...binding },
        suites: Array.from({ length: 20 }, (_, index) => ({
          suiteId: `suite-${index}`,
          mediaKind: "real" as const,
          split: "frozen-test" as const,
          expectedEpisodeCount: 5,
          correctlyLocatedEpisodeCount: 5,
          crossEpisodeMismatchCount: 0,
          exportCompleted: true
        }))
      },
      performance: {
        schemaVersion: 2,
        binding: { ...binding },
        rawEvidence: structuredClone(performanceEvidence)
      },
      uiWalkthrough: {
        schemaVersion: 1,
        binding: { ...binding },
        passed: true,
        completedSuiteCount: 20,
        buildDigest,
        completedAt: "2026-07-12T00:03:00.000Z"
      },
      releaseVerification: {
        schemaVersion: 1,
        binding: { ...binding },
        sourceAuditPassed: true,
        lintPassed: true,
        frontendTestsPassed: true,
        rustTestsPassed: true,
        e2ePassed: true,
        buildPassed: true,
        tauriReleasePassed: true,
        buildDigest,
        completedAt: "2026-07-12T00:04:00.000Z"
      }
    }
  };
  refreshReportEvidenceDigests(bundle);
  return bundle;
}

function relationshipDecision(
  index: number,
  caseId: string,
  split: C137DatasetSplit,
  correct: boolean,
  prefix: string
): C137RelationshipDecisionEvidence {
  const goldCandidateId = `${prefix}-gold-${index}`;
  return {
    decisionId: `${prefix}-decision-${index}`,
    caseId,
    mediaKind: "real",
    split,
    modality: "same-audio",
    goldCandidateId,
    rankedCandidateIds: correct
      ? [goldCandidateId, `${prefix}-wrong-${index}`]
      : [`${prefix}-wrong-${index}`, goldCandidateId],
    verifiedCandidateId: null
  };
}

const REPORT_KEYS: readonly (keyof C137AcceptanceReports)[] = [
  "dataset",
  "relationshipRanking",
  "timeMap",
  "calibration",
  "visualFallback",
  "degradation",
  "northStar",
  "performance",
  "uiWalkthrough",
  "releaseVerification"
];

function refreshReportEvidenceDigests(bundle: C137AcceptanceBundle): void {
  for (const key of REPORT_KEYS) {
    const report = bundle.reports[key];
    if (report !== null) {
      report.binding.evidenceDigest = computeC137ReportEvidenceDigest(report);
    }
  }
}

function createTrustContext(bundle: C137AcceptanceBundle): C137AcceptanceTrustContext {
  const { datasetApproval, preflight, predictionRun } = bundle.receipts;
  const reports = bundle.reports;
  if (
    datasetApproval === null ||
    preflight === null ||
    predictionRun === null ||
    reports.dataset === null ||
    reports.relationshipRanking === null ||
    reports.timeMap === null ||
    reports.calibration === null ||
    reports.visualFallback === null ||
    reports.degradation === null ||
    reports.northStar === null ||
    reports.performance === null ||
    reports.uiWalkthrough === null ||
    reports.releaseVerification === null
  ) {
    throw new Error("测试 trustContext 只能从完整 bundle 的独立快照创建。");
  }
  return {
    trustedProtocolDigest: computeC137CanonicalDigest(bundle.protocol),
    trustedReceiptDigests: {
      datasetApproval: computeC137CanonicalDigest(datasetApproval),
      preflight: computeC137CanonicalDigest(preflight),
      predictionRun: computeC137CanonicalDigest(predictionRun)
    },
    trustedReportEvidenceDigests: {
      dataset: computeC137ReportEvidenceDigest(reports.dataset),
      relationshipRanking: computeC137ReportEvidenceDigest(reports.relationshipRanking),
      timeMap: computeC137ReportEvidenceDigest(reports.timeMap),
      calibration: computeC137ReportEvidenceDigest(reports.calibration),
      visualFallback: computeC137ReportEvidenceDigest(reports.visualFallback),
      degradation: computeC137ReportEvidenceDigest(reports.degradation),
      northStar: computeC137ReportEvidenceDigest(reports.northStar),
      performance: computeC137ReportEvidenceDigest(reports.performance),
      uiWalkthrough: computeC137ReportEvidenceDigest(reports.uiWalkthrough),
      releaseVerification: computeC137ReportEvidenceDigest(reports.releaseVerification)
    }
  };
}

function digest(character: string): C137Digest {
  return `sha256:${character.repeat(64)}`;
}
