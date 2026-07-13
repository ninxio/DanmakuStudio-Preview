import { describe, expect, it } from "vitest";
import {
  createCompleteC137PerformanceEvidenceFixture,
  createCompleteC137PerformanceEvidenceV2Fixture
} from "../../test/c137PerformanceEvidence";
import {
  createC137FormalBlindProvenanceFixture,
  type C137FormalBlindProvenanceFixture
} from "../../test/c137FormalBlindProvenance";
import {
  computeC137PerformanceEnvironmentDigest,
  computeC137PerformanceEnvironmentDigestV2,
  computeC137PerformanceEvidenceDigest,
  computeC137PerformanceEvidenceDigestV2,
  computeC137PerformanceWorkloadStorageReceiptDigest,
  createC137PerformancePlanDigest,
  type C137PerformanceRawEvidenceV2
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

  it("v1 工程 evidence 即使伪装正式字段、自摘要并由调用方自建 trustContext 也只能 incomplete", () => {
    const bundle = createCompleteBundle();
    const raw = bundle.reports.performance!.rawEvidence;
    if (raw.schemaVersion !== 1) throw new Error("expected legacy v1 engineering evidence");
    raw.evidenceDigest = computeC137PerformanceEvidenceDigest(raw);
    refreshReportEvidenceDigests(bundle);
    const gate = evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle));

    expect(validateC137AcceptanceBundle(bundle)).toEqual({ valid: true, issues: [] });
    expect(raw.schemaVersion).toBe(1);
    expect(raw.collector.sampler).toBe("windows-job-object-working-set-v1");
    expect(raw.environment.storageScope).toBe("workload-media-volumes");
    expect(gate).toMatchObject({ status: "incomplete-evidence", verifiedEligible: false });
    expect(gate.checks.find((check) => check.id === "external-trust-authority"))
      .toMatchObject({
        status: "incomplete",
        actual: "unverified-caller-snapshot"
      });
    const rawSchemaCheck = gate.checks.find(
      (check) => check.id === "performance-formal-raw-schema-version"
    );
    expect(rawSchemaCheck).toMatchObject({
      status: "incomplete",
      actual: 1
    });
    expect(rawSchemaCheck?.requirement).toContain("schemaVersion=2");
    expect(gate.checks.find((check) => check.id === "performance-raw-evidence")).toMatchObject({
      status: "pass"
    });
  });

  it("关系排名缺少 private full-Cartesian provenance 时即使调用方补齐 trustContext 也不能放行", () => {
    const bundle = createCompleteBundle();
    refreshReportEvidenceDigests(bundle);

    const gate = evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle));

    expect(gate.checks.find((check) => check.id === "native-blind-ranking-provenance"))
      .toMatchObject({
        status: "incomplete",
        actual: "missing-private-provenance"
      });
    expect(
      gate.checks.find((check) => check.id === "native-blind-envelope-integrity")
    ).toMatchObject({ status: "incomplete", actual: "missing" });
    expect(gate).toMatchObject({ status: "incomplete-evidence", verifiedEligible: false });
  });

  it("acceptance 直接重算 private full-Cartesian provenance 并逐条绑定 native-derived ranking", () => {
    const fixture = createC137FormalBlindProvenanceFixture();
    const bundle = createCompleteBundle();
    bindFormalBlindProvenanceFixture(bundle, fixture);

    expect(validateC137AcceptanceBundle(bundle)).toEqual({ valid: true, issues: [] });
    const gate = evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle));

    for (const id of [
      "native-blind-envelope-integrity",
      "native-blind-plan-binding",
      "native-blind-decision-coverage",
      "native-blind-manifest-binding",
      "native-blind-gold-binding",
      "native-blind-media-binding",
      "native-blind-provenance-root-binding",
      "native-blind-parameters-binding",
      "native-blind-ranking-binding"
    ]) {
      expect(gate.checks.find((check) => check.id === id), id).toMatchObject({
        status: "pass"
      });
    }
    expect(
      gate.checks.find((check) => check.id === "native-blind-ranking-provenance")
    ).toMatchObject({
      status: "incomplete",
      actual: "self-consistent-no-native-authority"
    });
    expect(gate.checks.find((check) => check.id === "native-blind-native-attestation"))
      .toMatchObject({ status: "incomplete" });
    expect(gate).toMatchObject({ status: "incomplete-evidence", verifiedEligible: false });
  });

  it("调用方重排 relationship Top-K 并重签全部 report 仍不能越过 native-derived exact binding", () => {
    const fixture = createC137FormalBlindProvenanceFixture();
    const bundle = createCompleteBundle();
    bindFormalBlindProvenanceFixture(bundle, fixture);
    const reported = bundle.reports.relationshipRanking!.decisions[0];
    reported.rankedCandidateIds.reverse();
    refreshReportEvidenceDigests(bundle);

    expect(validateC137AcceptanceBundle(bundle)).toEqual({ valid: true, issues: [] });
    const gate = evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle));

    expect(gate.checks.find((check) => check.id === "native-blind-envelope-integrity"))
      .toMatchObject({ status: "pass" });
    expect(gate.checks.find((check) => check.id === "native-blind-ranking-binding"))
      .toMatchObject({ status: "incomplete", actual: false });
    expect(
      gate.checks.find((check) => check.id === "native-blind-ranking-provenance")
    ).toMatchObject({ status: "incomplete", actual: "private-provenance-not-closed" });
  });

  it("公开 aggregate blind evidence 不能冒充 private formal provenance", () => {
    const fixture = createC137FormalBlindProvenanceFixture();
    const bundle = createCompleteBundle() as unknown as {
      formalEvidence: { blindRelationship: unknown };
    };
    bundle.formalEvidence.blindRelationship =
      fixture.provenance.batches[0].aggregateEvidence;

    const validation = validateC137AcceptanceBundle(bundle);

    expect(validation.valid).toBe(false);
    expect(validation.issues.join("\n")).toContain(
      "bundle.formalEvidence.blindRelationship"
    );
    expect(evaluateC137AcceptanceBundle(bundle)).toMatchObject({
      status: "incomplete-evidence",
      verifiedEligible: false
    });
  });

  it("旧 protocol v2 缺少正式 raw schema 绑定时严格拒绝", () => {
    const legacy = structuredClone(createCompleteBundle()) as unknown as {
      protocol: Record<string, unknown>;
    };
    legacy.protocol.schemaVersion = 2;
    delete legacy.protocol.requiredPerformanceRawSchemaVersion;

    const validation = validateC137AcceptanceBundle(legacy);

    expect(validation.valid).toBe(false);
    expect(validation.issues.join("\n")).toContain("bundle.protocol.schemaVersion 必须为 4");
    expect(validation.issues.join("\n")).toContain(
      "bundle.protocol.requiredPerformanceRawSchemaVersion 缺失"
    );
  });

  it("真实上一版 bundle v1/protocol v3/ranking v1 不能混入 v2 formal 字段语义", () => {
    const legacy = structuredClone(createCompleteBundle()) as unknown as {
      schemaVersion: number;
      protocol: Record<string, unknown>;
      reports: { relationshipRanking: { schemaVersion: number; decisions: Record<string, unknown>[] } };
    };
    legacy.schemaVersion = 1;
    legacy.protocol.schemaVersion = 3;
    legacy.protocol.version = "3";
    delete legacy.protocol.blindRankingPlanDigest;
    delete legacy.protocol.requiredBlindProjectionSchemaVersion;
    delete legacy.protocol.requiredNativeEvidenceVersion;
    delete legacy.protocol.requiredBlindPairingMode;
    legacy.reports.relationshipRanking.schemaVersion = 1;
    for (const decision of legacy.reports.relationshipRanking.decisions) {
      delete decision.provenanceRef;
    }

    const validation = validateC137AcceptanceBundle(legacy);
    const issues = validation.issues.join("\n");

    expect(validation.valid).toBe(false);
    expect(issues).toContain("bundle.schemaVersion 必须为 2");
    expect(issues).toContain("bundle.protocol.schemaVersion 必须为 4");
    expect(issues).toContain("bundle.protocol.blindRankingPlanDigest 缺失");
    expect(issues).toContain("bundle.reports.relationshipRanking.schemaVersion 必须为 2");
    expect(issues).toContain("provenanceRef 缺失");
  });

  it.each([1, 21])("protocol topK=%s 与 formal blind 2..20 契约不一致时严格拒绝", (topK) => {
    const bundle = createCompleteBundle();
    bundle.protocol.topK = topK;

    const validation = validateC137AcceptanceBundle(bundle);

    expect(validation.valid).toBe(false);
    expect(validation.issues.join("\n")).toContain(
      "bundle.protocol.topK 必须位于 2..20"
    );
  });

  it("performance report v2 不能冒充绑定 raw v2 的 v3 报告", () => {
    const legacy = structuredClone(createCompleteBundle()) as unknown as {
      reports: { performance: Record<string, unknown> };
    };
    legacy.reports.performance.schemaVersion = 2;

    const validation = validateC137AcceptanceBundle(legacy);

    expect(validation.valid).toBe(false);
    expect(validation.issues.join("\n")).toContain(
      "bundle.reports.performance.schemaVersion 必须为 3"
    );
  });

  it("raw v2 即使改写为 Job、完整绑定存储、自摘要和自建信任上下文，仍缺三项原生正式 receipt", () => {
    const bundle = createCompleteV2Bundle();
    const raw = bundle.reports.performance!.rawEvidence;
    if (raw.schemaVersion !== 2) throw new Error("expected raw evidence v2");
    const gate = evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle));

    expect(validateC137AcceptanceBundle(bundle)).toEqual({ valid: true, issues: [] });
    expect(raw.collector.sampler).toBe("windows-job-object-working-set-v1");
    expect(raw.assurance.jobMemoryReceipt).toBeNull();
    expect(raw.assurance.terminalCleanupReceipt).toBeNull();
    expect(raw.assurance.attestation).toBeNull();
    expect(gate).toMatchObject({ status: "incomplete-evidence", verifiedEligible: false });
    expect(
      gate.checks.find((check) => check.id === "performance-formal-raw-schema-version")
    ).toMatchObject({ status: "pass", actual: 2 });
    const storageCheck = gate.checks.find((check) => check.id === "workload-storage-receipt");
    expect(storageCheck).toMatchObject({ status: "pass" });
    expect(storageCheck?.requirement).toContain("结构完整");
    expect(storageCheck?.requirement).toContain("native attestation");
    expect(storageCheck?.requirement).not.toContain("原生 v2 生成");
    for (const id of [
      "job-memory-receipt",
      "terminal-cleanup-receipt",
      "native-attestation"
    ]) {
      expect(gate.checks.find((check) => check.id === id)).toMatchObject({
        status: "incomplete",
        actual: "not-verifiable-in-schema-v2"
      });
    }
  });

  it("另一工作负载的 raw v2 即使完整闭环重签也不能绑定当前冻结集", () => {
    const bundle = createCompleteV2Bundle();
    const raw = bundle.reports.performance!.rawEvidence;
    if (raw.schemaVersion !== 2) throw new Error("expected raw evidence v2");
    rebindV2EvidenceWorkload(raw, digest("e"));
    bundle.protocol.performancePlanDigest = raw.planDigest;
    refreshReportEvidenceDigests(bundle);

    const gate = evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle));

    expect(validateC137AcceptanceBundle(bundle)).toEqual({ valid: true, issues: [] });
    expect(raw.runManifestDigest).not.toBe(bundle.manifestDigest);
    expect(
      gate.checks.find((check) => check.id === "performance-workload-manifest-binding")
    ).toMatchObject({
      status: "incomplete",
      actual: raw.runManifestDigest
    });
    expect(gate.checks.find((check) => check.id === "performance-measurements"))
      .toMatchObject({ status: "incomplete", actual: false });
    expect(gate).toMatchObject({ status: "incomplete-evidence", verifiedEligible: false });
  });

  it("协议锁定 Top-K 后，冻结 decision 少报候选即使重签全部 report 也必须失败", () => {
    const bundle = createCompleteBundle();
    const decision = bundle.reports.relationshipRanking!.decisions[0];
    decision.rankedCandidateIds = [decision.goldCandidateId];
    refreshReportEvidenceDigests(bundle);

    const gate = evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle));

    expect(validateC137AcceptanceBundle(bundle)).toEqual({ valid: true, issues: [] });
    expect(bundle.protocol.topK).toBe(5);
    expect(gate.checks.find((check) => check.id === "ranking-top-k-reported")).toMatchObject({
      status: "fail",
      actual: 999
    });
    expect(gate.status).toBe("incomplete-evidence");
    expect(gate.reasons.join("\n")).toContain("external-trust-authority");
    expect(gate.reasons.join("\n")).toContain("ranking-top-k-reported");
  });

  it("Top-K 数量完整但不含 gold 时，即使重签全部 report 也必须失败", () => {
    const bundle = createCompleteBundle();
    const decision = bundle.reports.relationshipRanking!.decisions[0];
    decision.rankedCandidateIds = decision.rankedCandidateIds.map((candidateId, index) =>
      candidateId === decision.goldCandidateId ? `wrong-candidate-${index}` : candidateId
    );
    refreshReportEvidenceDigests(bundle);

    const gate = evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle));

    expect(validateC137AcceptanceBundle(bundle)).toEqual({ valid: true, issues: [] });
    expect(decision.rankedCandidateIds).toHaveLength(bundle.protocol.topK);
    expect(decision.rankedCandidateIds).not.toContain(decision.goldCandidateId);
    expect(gate.checks.find((check) => check.id === "ranking-top-k-reported")).toMatchObject({
      status: "pass",
      actual: 1_000
    });
    expect(gate.checks.find((check) => check.id === "ranking-top-k-hit")).toMatchObject({
      status: "fail",
      actual: 999
    });
    expect(gate.status).toBe("incomplete-evidence");
  });

  it.each([
    ["ranking mediaKind", (bundle: C137AcceptanceBundle) => {
      bundle.reports.relationshipRanking!.decisions[0].mediaKind = "synthetic";
    }],
    ["TimeMap split", (bundle: C137AcceptanceBundle) => {
      bundle.reports.timeMap!.cases[0].split = "development";
    }],
    ["TimeMap scenarios", (bundle: C137AcceptanceBundle) => {
      bundle.reports.timeMap!.cases[0].scenarios = ["global-offset"];
    }],
    ["visual metadata", (bundle: C137AcceptanceBundle) => {
      bundle.reports.visualFallback!.cases[0].split = "calibration";
    }],
    ["degradation metadata", (bundle: C137AcceptanceBundle) => {
      bundle.reports.degradation!.cases[0].mediaKind = "synthetic";
    }]
  ] as const)("%s 与 dataset 不一致时，重签 report 仍必须被元数据闭环阻断", (_label, mutate) => {
    const bundle = createCompleteBundle();
    mutate(bundle);
    refreshReportEvidenceDigests(bundle);

    const gate = evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle));

    expect(validateC137AcceptanceBundle(bundle)).toEqual({ valid: true, issues: [] });
    expect(gate.checks.find((check) => check.id === "case-metadata-consistency"))
      .toMatchObject({ status: "incomplete", actual: false });
    expect(gate).toMatchObject({ status: "incomplete-evidence", verifiedEligible: false });
  });

  it.each([
    ["缺少 frozen decision", (bundle: C137AcceptanceBundle) => {
      bundle.reports.calibration!.samples.pop();
    }],
    ["metadata 不一致", (bundle: C137AcceptanceBundle) => {
      bundle.reports.calibration!.samples[0].split = "development";
    }],
    ["伪造 correct", (bundle: C137AcceptanceBundle) => {
      bundle.reports.calibration!.samples[0].correct = false;
    }],
    ["decisionId 不一致", (bundle: C137AcceptanceBundle) => {
      bundle.reports.calibration!.samples[0].decisionId = "unbound-calibration-decision";
    }]
  ] as const)("calibration %s 时，重签 report 仍不能冒充一对一校准", (_label, mutate) => {
    const bundle = createCompleteBundle();
    mutate(bundle);
    refreshReportEvidenceDigests(bundle);

    const gate = evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle));

    expect(validateC137AcceptanceBundle(bundle)).toEqual({ valid: true, issues: [] });
    expect(gate.checks.find((check) => check.id === "calibration-samples"))
      .toMatchObject({ status: "incomplete", actual: false });
  });

  it("dataset gold 事件计数与 TimeMap 原始事件不一致时，重签 report 仍必须阻断", () => {
    const bundle = createCompleteBundle();
    bundle.reports.dataset!.cases[0].goldEditEventCount += 1;
    refreshReportEvidenceDigests(bundle);

    const gate = evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle));

    expect(validateC137AcceptanceBundle(bundle)).toEqual({ valid: true, issues: [] });
    expect(gate.checks.find((check) => check.id === "gold-edit-event-count-binding"))
      .toMatchObject({ status: "incomplete", actual: false });
  });

  it("任一冻结 time-stretch case 漏报漂移时，其他完美样本不能掩盖", () => {
    const bundle = createCompleteBundle();
    bundle.reports.timeMap!.cases[0].endDriftAt45MinutesMs = null;
    refreshReportEvidenceDigests(bundle);

    const gate = evaluateC137AcceptanceBundle(bundle, createTrustContext(bundle));

    expect(validateC137AcceptanceBundle(bundle)).toEqual({ valid: true, issues: [] });
    expect(gate.checks.find((check) => check.id === "drift-measurements"))
      .toMatchObject({ status: "incomplete", actual: false });
    expect(gate.checks.find((check) => check.id === "time-map-end-drift-45m"))
      .toMatchObject({ status: "pass" });
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
    expect(gate.status).toBe("incomplete-evidence");
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
    if (raw.schemaVersion !== 1) throw new Error("expected legacy v1 engineering evidence");
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
    protocolId: "c137-acceptance@4",
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
    schemaVersion: 2,
    kind: "c137-acceptance-bundle",
    manifestDigest,
    datasetVersion: "real-frozen-1",
    certificationClass: "real-frozen",
    protocol: {
      schemaVersion: 4,
      id: "c137-acceptance",
      version: "4",
      topK: 5,
      calibrationBinCount: 10,
      requiredColdRuns: 1,
      requiredHotRuns: 1,
      requiredCancellationRuns: 1,
      performancePlanDigest: performanceEvidence.planDigest,
      blindRankingPlanDigest: digest("c"),
      requiredBlindProjectionSchemaVersion: 1,
      requiredNativeEvidenceVersion: 1,
      requiredBlindPairingMode: "fullCartesian",
      requiredPerformanceRawSchemaVersion: 2,
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
        protocolId: "c137-acceptance@4",
        environmentDigest,
        buildDigest,
        engineVersion: "alignment-v2",
        featureVersion: "feature-v2",
        parametersDigest,
        completedAt: "2026-07-12T00:02:00.000Z"
      }
    },
    formalEvidence: {
      blindRelationship: null
    },
    reports: {
      dataset: { schemaVersion: 1, binding: { ...binding }, cases: datasetCases },
      relationshipRanking: {
        schemaVersion: 2,
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
        schemaVersion: 3,
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

function createCompleteV2Bundle(): C137AcceptanceBundle {
  const bundle = createCompleteBundle();
  const raw = createCompleteC137PerformanceEvidenceV2Fixture();
  raw.collector.sampler = "windows-job-object-working-set-v1";
  for (const trial of raw.trials) {
    if (trial.trialType === "run") {
      for (const item of trial.cases) {
        item.telemetry.memory.sampler = "windows-job-object-working-set-v1";
      }
    } else {
      trial.telemetry.memory.sampler = "windows-job-object-working-set-v1";
    }
  }
  raw.evidenceDigest = computeC137PerformanceEvidenceDigestV2(raw);

  const measured = raw.environment;
  const environmentWithoutDigest: Omit<C137EnvironmentFingerprint, "digest"> = {
    schemaVersion: 2,
    operatingSystem: measured.operatingSystem,
    operatingSystemVersion: measured.operatingSystemVersion,
    architecture: measured.architecture,
    cpuModel: measured.cpuModel,
    physicalCoreCount: measured.physicalCoreCount,
    logicalCoreCount: measured.logicalCoreCount,
    totalMemoryBytes: measured.totalMemoryBytes,
    storageScope: measured.storageScope,
    storageKind: measured.storageKind,
    powerProfile: measured.powerProfile,
    ffmpegVersion: measured.ffmpeg.version,
    ffmpegBinaryDigest: measured.ffmpeg.binaryDigest,
    ffprobeVersion: measured.ffprobe.version,
    ffprobeBinaryDigest: measured.ffprobe.binaryDigest
  };
  const environmentDigest = computeC137EnvironmentDigest(environmentWithoutDigest);
  bundle.environment = { ...environmentWithoutDigest, digest: environmentDigest };
  bundle.protocol.targetEnvironmentDigest = environmentDigest;
  bundle.protocol.performancePlanDigest = raw.planDigest;
  if (bundle.receipts.predictionRun !== null) {
    bundle.receipts.predictionRun.environmentDigest = environmentDigest;
  }
  for (const key of REPORT_KEYS) {
    const report = bundle.reports[key];
    if (report !== null) report.binding.environmentDigest = environmentDigest;
  }
  const binding = bundle.reports.performance?.binding;
  if (!binding) throw new Error("expected performance report binding");
  bundle.reports.performance = {
    schemaVersion: 3,
    binding,
    rawEvidence: raw
  };
  refreshReportEvidenceDigests(bundle);
  return bundle;
}

function bindFormalBlindProvenanceFixture(
  bundle: C137AcceptanceBundle,
  fixture: C137FormalBlindProvenanceFixture
): void {
  const { provenance, manifest, expectations, decisions } = fixture;
  const datasetApproval = bundle.receipts.datasetApproval;
  const preflight = bundle.receipts.preflight;
  const predictionRun = bundle.receipts.predictionRun;
  const datasetReport = bundle.reports.dataset;
  const relationshipReport = bundle.reports.relationshipRanking;
  const timeMapReport = bundle.reports.timeMap;
  const calibrationReport = bundle.reports.calibration;
  const visualReport = bundle.reports.visualFallback;
  const degradationReport = bundle.reports.degradation;
  if (
    datasetApproval === null ||
    preflight === null ||
    predictionRun === null ||
    datasetReport === null ||
    relationshipReport === null ||
    timeMapReport === null ||
    calibrationReport === null ||
    visualReport === null ||
    degradationReport === null
  ) {
    throw new Error("formal acceptance fixture requires a complete base bundle");
  }

  bundle.manifestDigest = provenance.manifestDigest;
  bundle.datasetVersion = manifest.datasetVersion;
  bundle.protocol.topK = expectations.topK;
  bundle.protocol.blindRankingPlanDigest = provenance.plan.planDigest;
  bundle.runner.parametersDigest = expectations.parametersDigest;
  bundle.formalEvidence.blindRelationship = structuredClone(provenance);

  datasetApproval.manifestDigest = provenance.manifestDigest;
  datasetApproval.goldDigest = provenance.goldDigest;
  datasetApproval.datasetVersion = manifest.datasetVersion;
  preflight.manifestDigest = provenance.manifestDigest;
  preflight.datasetVersion = manifest.datasetVersion;
  preflight.mediaBindingsDigest = provenance.mediaBindingsDigest;
  preflight.realRelationCount = manifest.cases.length;
  preflight.checkedFileCount = manifest.cases.length * 2;
  predictionRun.manifestDigest = provenance.manifestDigest;
  predictionRun.datasetVersion = manifest.datasetVersion;
  predictionRun.predictionsDigest = provenance.provenanceDigest;
  predictionRun.parametersDigest = expectations.parametersDigest;

  datasetReport.cases = manifest.cases.map((benchmarkCase) => ({
    caseId: benchmarkCase.id,
    mediaKind: "real",
    split: "frozen-test",
    scenarios: [...benchmarkCase.scenarios],
    goldEditEventCount:
      benchmarkCase.gold.sourceOnlySpans.length +
      benchmarkCase.gold.targetOnlySpans.length +
      benchmarkCase.gold.ambiguousSpans.length,
    independentlyReviewed: benchmarkCase.independentAnnotations.length >= 2,
    adjudicationComplete: benchmarkCase.adjudication !== null
  }));
  relationshipReport.decisions = decisions.map((decision) => ({
    decisionId: decision.provenanceRef,
    provenanceRef: decision.provenanceRef,
    caseId: decision.caseId,
    mediaKind: "real",
    split: "frozen-test",
    modality: "same-audio",
    goldCandidateId: decision.goldPairId,
    rankedCandidateIds: [...decision.rankedPairIds],
    verifiedCandidateId: null
  }));
  timeMapReport.cases = manifest.cases.map((benchmarkCase) => ({
    caseId: benchmarkCase.id,
    mediaKind: "real",
    split: "frozen-test",
    scenarios: [...benchmarkCase.scenarios],
    matchedProjectionErrorsMs: [0],
    endDriftAt45MinutesMs: null,
    editDecisions: []
  }));
  calibrationReport.samples = decisions.map((decision) => ({
    decisionId: decision.provenanceRef,
    mediaKind: "real",
    split: "frozen-test",
    probability: 1,
    correct: decision.rankedPairIds[0] === decision.goldPairId
  }));
  visualReport.cases = [];
  degradationReport.cases = [];

  for (const key of REPORT_KEYS) {
    const report = bundle.reports[key];
    if (report === null) continue;
    report.binding.manifestDigest = provenance.manifestDigest;
    report.binding.goldDigest = provenance.goldDigest;
    report.binding.datasetVersion = manifest.datasetVersion;
    report.binding.predictionsDigest = provenance.provenanceDigest;
    report.binding.parametersDigest = expectations.parametersDigest;
  }
  refreshReportEvidenceDigests(bundle);
}

function rebindV2EvidenceWorkload(
  raw: C137PerformanceRawEvidenceV2,
  workloadDigest: C137Digest
): void {
  raw.runManifestDigest = workloadDigest;
  raw.plan.workloadDigest = workloadDigest;
  raw.environment.workloadStorage.runManifestDigest = workloadDigest;
  raw.environment.workloadStorage.workloadDigest = workloadDigest;
  raw.environment.workloadStorage.receiptDigest =
    computeC137PerformanceWorkloadStorageReceiptDigest(
      raw.environment.workloadStorage
    );
  const { digest: ignoredEnvironmentDigest, ...unsignedEnvironment } = raw.environment;
  void ignoredEnvironmentDigest;
  raw.environment.digest = computeC137PerformanceEnvironmentDigestV2(unsignedEnvironment);
  raw.collector.runManifestDigest = workloadDigest;
  raw.collector.workloadDigest = workloadDigest;
  raw.collector.workloadStorageReceiptDigest =
    raw.environment.workloadStorage.receiptDigest;
  raw.assurance.workloadStorageReceiptDigest =
    raw.environment.workloadStorage.receiptDigest;
  for (const trial of raw.trials) trial.workloadDigest = workloadDigest;
  raw.planDigest = createC137PerformancePlanDigest(raw.plan);
  raw.evidenceDigest = computeC137PerformanceEvidenceDigestV2(raw);
}

function relationshipDecision(
  index: number,
  caseId: string,
  split: C137DatasetSplit,
  correct: boolean,
  prefix: string
): C137RelationshipDecisionEvidence {
  const goldCandidateId = `${prefix}-gold-${index}`;
  const distractors = Array.from(
    { length: 4 },
    (_, distractorIndex) => `${prefix}-wrong-${index}-${distractorIndex}`
  );
  return {
    decisionId: `${prefix}-decision-${index}`,
    provenanceRef: null,
    caseId,
    mediaKind: "real",
    split,
    modality: "same-audio",
    goldCandidateId,
    rankedCandidateIds: correct
      ? [goldCandidateId, ...distractors]
      : [distractors[0], goldCandidateId, ...distractors.slice(1)],
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
