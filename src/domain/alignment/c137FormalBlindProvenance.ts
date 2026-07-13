import type { C137Digest } from "./c137Acceptance";
import {
  compileC137BlindBatchBenchmarkEvidence,
  createC137BlindBatchExecutionProjection,
  createC137BlindBatchMediaBindingCommitment,
  deriveC137BlindBatchRawPredictionFromNativeReceipt,
  deriveC137BlindBatchRelationshipDecisions,
  orderC137BlindBatchMediaInputs,
  type C137BlindBatchBenchmarkEvidence,
  type C137BlindBatchDerivedRelationshipDecision,
  type C137BlindBatchExecutionProjection,
  type C137BlindBatchRawPrediction,
  type C137BlindBatchRelationshipAxis
} from "./c137BlindBatchEvidence";
import {
  validateRealMediaBenchmarkManifest,
  type RealMediaBenchmarkCase,
  type RealMediaBenchmarkManifest,
  type RealMediaBenchmarkMediaInput
} from "./realMediaBenchmark";
import {
  validateRealMediaBlindBatchExecutionSuite,
  type RealMediaBlindBatchExecutionSuite,
  type RealMediaBlindBatchRunReceipt
} from "./realMediaBlindBatchContract";
import { sha256Hex } from "../shared/sha256";

export const C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION = 1 as const;

const MANIFEST_DIGEST_DOMAIN = "c137-formal-blind-full-manifest-v1";
const GOLD_DIGEST_DOMAIN = "c137-formal-blind-gold-v1";
const MEDIA_BINDINGS_DIGEST_DOMAIN = "c137-formal-blind-media-bindings-v1";
const PLAN_DIGEST_DOMAIN = "c137-formal-blind-plan-v1";
const PARAMETERS_DIGEST_DOMAIN = "c137-formal-blind-execution-parameters-v1";
const PROVENANCE_DIGEST_DOMAIN = "c137-formal-blind-provenance-v1";
const REPLAY_FINGERPRINT_DOMAIN = "c137-formal-blind-suite-case-fingerprint-v1";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface C137FormalBlindProvenancePlanBatchV1 {
  batchId: string;
  caseIds: string[];
  candidateCaseIds: string[];
  relationshipAxis: C137BlindBatchRelationshipAxis;
  visualEvidenceEnabled: boolean;
  topK: number;
}

export interface C137FormalBlindProvenancePlanV1 {
  schemaVersion: typeof C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION;
  kind: "c137-formal-blind-provenance-plan";
  manifestDigest: C137Digest;
  datasetVersion: string;
  batches: C137FormalBlindProvenancePlanBatchV1[];
  planDigest: C137Digest;
}

export interface C137FormalBlindProvenanceBatchEnvelopeV1 {
  schemaVersion: typeof C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION;
  kind: "c137-formal-blind-provenance-batch";
  batchId: string;
  projection: C137BlindBatchExecutionProjection;
  executionSuite: RealMediaBlindBatchExecutionSuite;
  nativeReceipt: RealMediaBlindBatchRunReceipt;
  rawPrediction: C137BlindBatchRawPrediction;
  aggregateEvidence: C137BlindBatchBenchmarkEvidence;
}

export interface C137FormalBlindProvenanceV1 {
  schemaVersion: typeof C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION;
  kind: "c137-formal-blind-provenance";
  releaseEligible: false;
  trustStatus: "untrusted-self-consistent-provenance";
  manifest: RealMediaBenchmarkManifest;
  manifestDigest: C137Digest;
  goldDigest: C137Digest;
  mediaBindingsDigest: C137Digest;
  plan: C137FormalBlindProvenancePlanV1;
  batches: C137FormalBlindProvenanceBatchEnvelopeV1[];
  provenanceDigest: C137Digest;
}

export interface C137FormalBlindProvenanceExpectations {
  manifestDigest: C137Digest;
  datasetVersion: string;
  planDigest: C137Digest;
  parametersDigest: C137Digest;
  topK: number;
}

export interface C137FormalBlindProvenanceEvaluation {
  valid: boolean;
  issues: string[];
  coverageValid: boolean;
  decisions: C137BlindBatchDerivedRelationshipDecision[];
}

type C137FormalBlindProvenancePlanDraft = Omit<
  C137FormalBlindProvenancePlanV1,
  "planDigest"
>;

type C137FormalBlindProvenanceDraft = Omit<
  C137FormalBlindProvenanceV1,
  "provenanceDigest"
>;

export function computeC137FormalBlindManifestDigest(
  manifest: RealMediaBenchmarkManifest
): C137Digest {
  return digest(MANIFEST_DIGEST_DOMAIN, canonicalJson(manifest));
}

export function computeC137FormalBlindGoldDigest(
  manifest: RealMediaBenchmarkManifest
): C137Digest {
  return digest(
    GOLD_DIGEST_DOMAIN,
    canonicalJson({
      schemaVersion: manifest.schemaVersion,
      manifestId: manifest.id,
      datasetVersion: manifest.datasetVersion,
      cases: manifest.cases.map((benchmarkCase) => ({
        id: benchmarkCase.id,
        mediaKind: benchmarkCase.mediaKind,
        split: benchmarkCase.split,
        scenarios: benchmarkCase.scenarios,
        boundaryToleranceMs: benchmarkCase.boundaryToleranceMs,
        independentAnnotations: benchmarkCase.independentAnnotations,
        adjudication: benchmarkCase.adjudication,
        gold: benchmarkCase.gold
      }))
    })
  );
}

export function computeC137FormalBlindMediaBindingsDigest(
  manifest: RealMediaBenchmarkManifest
): C137Digest {
  return digest(
    MEDIA_BINDINGS_DIGEST_DOMAIN,
    canonicalJson({
      schemaVersion: manifest.schemaVersion,
      manifestId: manifest.id,
      datasetVersion: manifest.datasetVersion,
      cases: manifest.cases.map((benchmarkCase) => ({
        caseId: benchmarkCase.id,
        source: formalMediaBinding(benchmarkCase.source),
        target: formalMediaBinding(benchmarkCase.target)
      }))
    })
  );
}

export function computeC137FormalBlindPlanDigest(
  plan: C137FormalBlindProvenancePlanDraft | C137FormalBlindProvenancePlanV1
): C137Digest {
  return digest(
    PLAN_DIGEST_DOMAIN,
    canonicalJson({
      schemaVersion: plan.schemaVersion,
      kind: plan.kind,
      manifestDigest: plan.manifestDigest,
      datasetVersion: plan.datasetVersion,
      batches: plan.batches
    })
  );
}

export function computeC137FormalBlindParametersDigest(
  provenance: Pick<C137FormalBlindProvenanceV1, "batches">
): C137Digest {
  return digest(
    PARAMETERS_DIGEST_DOMAIN,
    canonicalJson(
      provenance.batches.map((batch) => ({
        batchId: batch.batchId,
        parameters: batch.executionSuite.parameters
      }))
    )
  );
}

export function computeC137FormalBlindProvenanceDigest(
  provenance: C137FormalBlindProvenanceDraft | C137FormalBlindProvenanceV1
): C137Digest {
  return digest(
    PROVENANCE_DIGEST_DOMAIN,
    canonicalJson({
      schemaVersion: provenance.schemaVersion,
      kind: provenance.kind,
      releaseEligible: provenance.releaseEligible,
      trustStatus: provenance.trustStatus,
      manifest: provenance.manifest,
      manifestDigest: provenance.manifestDigest,
      goldDigest: provenance.goldDigest,
      mediaBindingsDigest: provenance.mediaBindingsDigest,
      plan: provenance.plan,
      batches: provenance.batches
    })
  );
}

export function validateC137FormalBlindProvenance(
  value: unknown
): C137FormalBlindProvenanceEvaluation {
  return evaluateInternal(value, undefined);
}

export function evaluateC137FormalBlindProvenance(
  value: unknown,
  expected: C137FormalBlindProvenanceExpectations
): C137FormalBlindProvenanceEvaluation {
  return evaluateInternal(value, expected);
}

function evaluateInternal(
  value: unknown,
  expected: C137FormalBlindProvenanceExpectations | undefined
): C137FormalBlindProvenanceEvaluation {
  try {
    if (expected !== undefined) validateExpectations(expected);
    const provenance = parseProvenance(value);
    const manifestValidation = validateRealMediaBenchmarkManifest(provenance.manifest);
    if (!manifestValidation.valid) {
      throw new Error(
        `formal blind manifest 无效：${manifestValidation.issues.join("；")}`
      );
    }
    if (
      provenance.manifest.cases.length === 0 ||
      provenance.manifest.cases.some(
        (benchmarkCase) =>
          benchmarkCase.mediaKind !== "real" || benchmarkCase.split !== "frozen-test"
      )
    ) {
      throw new Error("formal blind provenance 只接受非空、全 real frozen-test manifest。");
    }
    validateConsistentPathIdentities(provenance.manifest);
    validateUniquePhysicalRelationships(provenance.manifest);

    const manifestDigest = computeC137FormalBlindManifestDigest(provenance.manifest);
    if (provenance.manifestDigest !== manifestDigest) {
      throw new Error("formal blind manifestDigest 与完整 manifest 不一致。");
    }
    if (provenance.goldDigest !== computeC137FormalBlindGoldDigest(provenance.manifest)) {
      throw new Error("formal blind goldDigest 与完整冻结 gold 不一致。");
    }
    if (
      provenance.mediaBindingsDigest !==
      computeC137FormalBlindMediaBindingsDigest(provenance.manifest)
    ) {
      throw new Error("formal blind mediaBindingsDigest 与路径/全文件身份/流绑定不一致。");
    }
    validatePlan(provenance.plan, provenance.manifest, manifestDigest);
    if (
      provenance.provenanceDigest !==
      computeC137FormalBlindProvenanceDigest(provenance)
    ) {
      throw new Error("formal blind provenanceDigest 与完整私有 provenance 内容不一致。");
    }
    if (expected !== undefined) {
      if (manifestDigest !== expected.manifestDigest) {
        throw new Error("formal blind manifestDigest 未命中外部期望。");
      }
      if (provenance.manifest.datasetVersion !== expected.datasetVersion) {
        throw new Error("formal blind datasetVersion 未命中外部期望。");
      }
      if (provenance.plan.planDigest !== expected.planDigest) {
        throw new Error("formal blind planDigest 未命中外部期望。");
      }
      if (computeC137FormalBlindParametersDigest(provenance) !== expected.parametersDigest) {
        throw new Error("formal blind parametersDigest 未命中外部期望。");
      }
      if (provenance.plan.batches.some((batch) => batch.topK !== expected.topK)) {
        throw new Error("formal blind batch topK 未全部命中外部期望。");
      }
    }

    if (provenance.batches.length !== provenance.plan.batches.length) {
      throw new Error("formal blind plan 与 batch envelope 数量不一一对应。");
    }
    const batchIds = new Set<string>();
    const envelopeBatchIds = new Set<string>();
    const replayFingerprints = new Set<C137Digest>();
    const coveredCaseIds = new Set<string>();
    const decisions: C137BlindBatchDerivedRelationshipDecision[] = [];

    provenance.plan.batches.forEach((planBatch, index) => {
      if (batchIds.has(planBatch.batchId)) {
        throw new Error(`formal blind plan batchId 重复：${planBatch.batchId}。`);
      }
      batchIds.add(planBatch.batchId);
      const envelope = provenance.batches[index];
      if (envelope === undefined || envelope.batchId !== planBatch.batchId) {
        throw new Error("formal blind plan/envelope 必须按序以 batchId 一一对应。");
      }
      if (envelopeBatchIds.has(envelope.batchId)) {
        throw new Error(`formal blind envelope batchId 重复：${envelope.batchId}。`);
      }
      envelopeBatchIds.add(envelope.batchId);

      const options = {
        caseIds: planBatch.caseIds,
        candidateCaseIds: planBatch.candidateCaseIds,
        relationshipAxis: planBatch.relationshipAxis,
        visualEvidenceEnabled: planBatch.visualEvidenceEnabled,
        topK: planBatch.topK
      } as const;
      const expectedProjection = createC137BlindBatchExecutionProjection(
        provenance.manifest,
        options
      );
      if (!canonicalEqual(envelope.projection, expectedProjection)) {
        throw new Error(`formal blind batch ${planBatch.batchId} projection 不是唯一重建结果。`);
      }
      validateExecutionManifestBinding(
        provenance.manifest,
        planBatch,
        expectedProjection,
        envelope.executionSuite
      );
      const derivedRaw = deriveC137BlindBatchRawPredictionFromNativeReceipt(
        expectedProjection,
        envelope.executionSuite,
        envelope.nativeReceipt
      );
      if (!canonicalEqual(envelope.rawPrediction, derivedRaw)) {
        throw new Error(`formal blind batch ${planBatch.batchId} rawPrediction 不是 native receipt 的唯一派生结果。`);
      }
      const aggregateEvidence = compileC137BlindBatchBenchmarkEvidence(
        provenance.manifest,
        options,
        expectedProjection,
        derivedRaw
      );
      if (!canonicalEqual(envelope.aggregateEvidence, aggregateEvidence)) {
        throw new Error(`formal blind batch ${planBatch.batchId} aggregate evidence 不是冻结 gold 的唯一重算结果。`);
      }
      const batchDecisions = deriveC137BlindBatchRelationshipDecisions(
        provenance.manifest,
        options,
        expectedProjection,
        derivedRaw
      );
      if (batchDecisions.length !== planBatch.caseIds.length) {
        throw new Error(`formal blind batch ${planBatch.batchId} decision 数量与 query 计划不一致。`);
      }
      batchDecisions.forEach((decision, decisionIndex) => {
        if (decision.caseId !== planBatch.caseIds[decisionIndex]) {
          throw new Error(`formal blind batch ${planBatch.batchId} decision 未保持 query manifest 顺序。`);
        }
        const replayFingerprint = digest(
          REPLAY_FINGERPRINT_DOMAIN,
          canonicalJson([decision.suiteId, decision.caseId])
        );
        if (replayFingerprints.has(replayFingerprint)) {
          throw new Error(
            `formal blind suite+case replay 重复：${decision.suiteId}/${decision.caseId}。`
          );
        }
        replayFingerprints.add(replayFingerprint);
        if (coveredCaseIds.has(decision.caseId)) {
          throw new Error(`formal blind duplicate case coverage：${decision.caseId}。`);
        }
        coveredCaseIds.add(decision.caseId);
        decisions.push(decision);
      });
    });

    const allCaseIds = provenance.manifest.cases.map((benchmarkCase) => benchmarkCase.id);
    const missingCaseIds = allCaseIds.filter((caseId) => !coveredCaseIds.has(caseId));
    if (missingCaseIds.length > 0) {
      return {
        valid: false,
        issues: [`formal blind query coverage 缺少：${missingCaseIds.join(", ")}。`],
        coverageValid: false,
        decisions: []
      };
    }
    return { valid: true, issues: [], coverageValid: true, decisions };
  } catch (error) {
    return {
      valid: false,
      issues: [error instanceof Error ? error.message : "formal blind provenance 校验失败。"],
      coverageValid: false,
      decisions: []
    };
  }
}

function parseProvenance(value: unknown): C137FormalBlindProvenanceV1 {
  const record = requireExactRecord(
    value,
    [
      "schemaVersion",
      "kind",
      "releaseEligible",
      "trustStatus",
      "manifest",
      "manifestDigest",
      "goldDigest",
      "mediaBindingsDigest",
      "plan",
      "batches",
      "provenanceDigest"
    ],
    "formal blind provenance"
  );
  if (
    record.schemaVersion !== C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION ||
    record.kind !== "c137-formal-blind-provenance" ||
    record.releaseEligible !== false ||
    record.trustStatus !== "untrusted-self-consistent-provenance"
  ) {
    throw new Error("formal blind provenance schema/kind/release/trust 标记无效。");
  }
  assertDigest(record.manifestDigest, "formal blind manifestDigest");
  assertDigest(record.goldDigest, "formal blind goldDigest");
  assertDigest(record.mediaBindingsDigest, "formal blind mediaBindingsDigest");
  assertDigest(record.provenanceDigest, "formal blind provenanceDigest");
  const plan = parsePlan(record.plan);
  assertArray(record.batches, "formal blind batches");
  const batches = record.batches.map((batch, index) => parseBatchEnvelope(batch, index));
  if (!isRecord(record.manifest)) {
    throw new Error("formal blind manifest 必须是对象。");
  }
  return {
    schemaVersion: C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION,
    kind: "c137-formal-blind-provenance",
    releaseEligible: false,
    trustStatus: "untrusted-self-consistent-provenance",
    manifest: record.manifest as unknown as RealMediaBenchmarkManifest,
    manifestDigest: record.manifestDigest,
    goldDigest: record.goldDigest,
    mediaBindingsDigest: record.mediaBindingsDigest,
    plan,
    batches,
    provenanceDigest: record.provenanceDigest
  };
}

function parsePlan(value: unknown): C137FormalBlindProvenancePlanV1 {
  const record = requireExactRecord(
    value,
    ["schemaVersion", "kind", "manifestDigest", "datasetVersion", "batches", "planDigest"],
    "formal blind plan"
  );
  if (
    record.schemaVersion !== C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION ||
    record.kind !== "c137-formal-blind-provenance-plan"
  ) {
    throw new Error("formal blind plan schema/kind 无效。");
  }
  assertDigest(record.manifestDigest, "formal blind plan.manifestDigest");
  assertNonemptyString(record.datasetVersion, "formal blind plan.datasetVersion");
  assertDigest(record.planDigest, "formal blind plan.planDigest");
  assertArray(record.batches, "formal blind plan.batches");
  if (record.batches.length === 0) throw new Error("formal blind plan 至少需要一个 batch。");
  return {
    schemaVersion: C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION,
    kind: "c137-formal-blind-provenance-plan",
    manifestDigest: record.manifestDigest,
    datasetVersion: record.datasetVersion,
    batches: record.batches.map((batch, index) => parsePlanBatch(batch, index)),
    planDigest: record.planDigest
  };
}

function parsePlanBatch(
  value: unknown,
  index: number
): C137FormalBlindProvenancePlanBatchV1 {
  const label = `formal blind plan.batches[${index}]`;
  const record = requireExactRecord(
    value,
    [
      "batchId",
      "caseIds",
      "candidateCaseIds",
      "relationshipAxis",
      "visualEvidenceEnabled",
      "topK"
    ],
    label
  );
  assertIdentifier(record.batchId, `${label}.batchId`);
  const caseIds = parseIdentifierArray(record.caseIds, `${label}.caseIds`);
  const candidateCaseIds = parseIdentifierArray(
    record.candidateCaseIds,
    `${label}.candidateCaseIds`
  );
  if (record.relationshipAxis !== "source" && record.relationshipAxis !== "target") {
    throw new Error(`${label}.relationshipAxis 无效。`);
  }
  if (typeof record.visualEvidenceEnabled !== "boolean") {
    throw new Error(`${label}.visualEvidenceEnabled 必须是 boolean。`);
  }
  assertTopK(record.topK, `${label}.topK`);
  return {
    batchId: record.batchId,
    caseIds,
    candidateCaseIds,
    relationshipAxis: record.relationshipAxis,
    visualEvidenceEnabled: record.visualEvidenceEnabled,
    topK: record.topK
  };
}

function parseBatchEnvelope(
  value: unknown,
  index: number
): C137FormalBlindProvenanceBatchEnvelopeV1 {
  const label = `formal blind batches[${index}]`;
  const record = requireExactRecord(
    value,
    [
      "schemaVersion",
      "kind",
      "batchId",
      "projection",
      "executionSuite",
      "nativeReceipt",
      "rawPrediction",
      "aggregateEvidence"
    ],
    label
  );
  if (
    record.schemaVersion !== C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION ||
    record.kind !== "c137-formal-blind-provenance-batch"
  ) {
    throw new Error(`${label} schema/kind 无效。`);
  }
  assertIdentifier(record.batchId, `${label}.batchId`);
  for (const field of [
    "projection",
    "executionSuite",
    "nativeReceipt",
    "rawPrediction",
    "aggregateEvidence"
  ] as const) {
    if (!isRecord(record[field])) throw new Error(`${label}.${field} 必须是对象。`);
  }
  return {
    schemaVersion: C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION,
    kind: "c137-formal-blind-provenance-batch",
    batchId: record.batchId,
    projection: record.projection as C137BlindBatchExecutionProjection,
    executionSuite: record.executionSuite as RealMediaBlindBatchExecutionSuite,
    nativeReceipt: record.nativeReceipt as RealMediaBlindBatchRunReceipt,
    rawPrediction: record.rawPrediction as C137BlindBatchRawPrediction,
    aggregateEvidence: record.aggregateEvidence as C137BlindBatchBenchmarkEvidence
  };
}

function validatePlan(
  plan: C137FormalBlindProvenancePlanV1,
  manifest: RealMediaBenchmarkManifest,
  manifestDigest: C137Digest
): void {
  if (
    plan.manifestDigest !== manifestDigest ||
    plan.datasetVersion !== manifest.datasetVersion
  ) {
    throw new Error("formal blind plan 未绑定同一 manifestDigest/datasetVersion。");
  }
  if (plan.planDigest !== computeC137FormalBlindPlanDigest(plan)) {
    throw new Error("formal blind planDigest 与有序计划内容不一致。");
  }
  const allCaseIds = manifest.cases.map((benchmarkCase) => benchmarkCase.id);
  for (const batch of plan.batches) {
    if (!sameOrderedStrings(batch.candidateCaseIds, allCaseIds)) {
      throw new Error(
        `formal blind batch ${batch.batchId} candidateCaseIds 必须严格等于完整 real frozen manifest 顺序；只允许切 query 轴。`
      );
    }
    assertManifestOrderedSubset(batch.caseIds, allCaseIds, batch.batchId);
  }
  validateUniqueQueryIdentities(plan, manifest);
}

function validateUniquePhysicalRelationships(manifest: RealMediaBenchmarkManifest): void {
  const relationships = new Map<string, string>();
  for (const benchmarkCase of manifest.cases) {
    const key = canonicalJson([
      fullFileIdentityKey(benchmarkCase.source, `${benchmarkCase.id}.source`),
      fullFileIdentityKey(benchmarkCase.target, `${benchmarkCase.id}.target`)
    ]);
    const previousCaseId = relationships.get(key);
    if (previousCaseId !== undefined && previousCaseId !== benchmarkCase.id) {
      throw new Error(
        `formal blind duplicate physical relationship：${previousCaseId}/${benchmarkCase.id} 绑定同一 source-target full-file identity。`
      );
    }
    relationships.set(key, benchmarkCase.id);
  }
}

function validateConsistentPathIdentities(manifest: RealMediaBenchmarkManifest): void {
  const identitiesByPath = new Map<
    string,
    { caseId: string; side: "source" | "target"; identityKey: string }
  >();
  for (const benchmarkCase of manifest.cases) {
    for (const side of ["source", "target"] as const) {
      const media = benchmarkCase[side];
      const pathKey = normalizePathForIdentityBinding(media.path);
      const identityKey = fullFileIdentityKey(media, `${benchmarkCase.id}.${side}`);
      const previous = identitiesByPath.get(pathKey);
      if (previous !== undefined && previous.identityKey !== identityKey) {
        throw new Error(
          `formal blind path identity conflict：${previous.caseId}.${previous.side}/${benchmarkCase.id}.${side} 的同一规范化路径绑定了不同 full-file identity。`
        );
      }
      identitiesByPath.set(pathKey, { caseId: benchmarkCase.id, side, identityKey });
    }
  }
}

function validateUniqueQueryIdentities(
  plan: C137FormalBlindProvenancePlanV1,
  manifest: RealMediaBenchmarkManifest
): void {
  const byCaseId = new Map(manifest.cases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase]));
  const identities = {
    source: new Map<string, { batchId: string; caseId: string }>(),
    target: new Map<string, { batchId: string; caseId: string }>()
  };
  for (const batch of plan.batches) {
    const side = batch.relationshipAxis;
    const sideIdentities = identities[side];
    for (const caseId of batch.caseIds) {
      const benchmarkCase = requireCase(byCaseId, caseId);
      const key = fullFileIdentityKey(benchmarkCase[side], `${caseId}.${side}`);
      const previous = sideIdentities.get(key);
      if (previous !== undefined && previous.batchId !== batch.batchId) {
        throw new Error(
          `formal blind ${side}-axis duplicate physical query identity：${previous.caseId}@${previous.batchId}/${caseId}@${batch.batchId}。`
        );
      }
      sideIdentities.set(key, { batchId: batch.batchId, caseId });
    }
  }
}

function validateExecutionManifestBinding(
  manifest: RealMediaBenchmarkManifest,
  planBatch: C137FormalBlindProvenancePlanBatchV1,
  projection: C137BlindBatchExecutionProjection,
  executionSuiteValue: unknown
): void {
  const executionSuite = validateRealMediaBlindBatchExecutionSuite(executionSuiteValue);
  if (executionSuite.datasetVersion !== manifest.datasetVersion) {
    throw new Error(`formal blind batch ${planBatch.batchId} execution datasetVersion 错配。`);
  }
  const byCaseId = new Map(manifest.cases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase]));
  const queryCases = planBatch.caseIds.map((caseId) => requireCase(byCaseId, caseId));
  const candidateCases = planBatch.candidateCaseIds.map((caseId) =>
    requireCase(byCaseId, caseId)
  );
  const sourceCases = planBatch.relationshipAxis === "source" ? queryCases : candidateCases;
  const targetCases = planBatch.relationshipAxis === "target" ? queryCases : candidateCases;
  validateExecutionSideBinding(
    manifest,
    "source",
    planBatch.visualEvidenceEnabled,
    sourceCases.map((benchmarkCase) => benchmarkCase.source),
    projection.sources,
    executionSuite.sources
  );
  validateExecutionSideBinding(
    manifest,
    "target",
    planBatch.visualEvidenceEnabled,
    targetCases.map((benchmarkCase) => benchmarkCase.target),
    projection.targets,
    executionSuite.targets
  );
}

function validateExecutionSideBinding(
  manifest: RealMediaBenchmarkManifest,
  side: "source" | "target",
  visualEvidenceEnabled: boolean,
  mediaInputs: readonly RealMediaBenchmarkMediaInput[],
  projectedMedia: readonly C137BlindBatchExecutionProjection["sources"][number][],
  executionMedia: readonly RealMediaBlindBatchExecutionSuite["sources"][number][]
): void {
  const ordered = orderC137BlindBatchMediaInputs(
    manifest.id,
    manifest.datasetVersion,
    side,
    visualEvidenceEnabled,
    mediaInputs
  );
  if (ordered.length !== projectedMedia.length || ordered.length !== executionMedia.length) {
    throw new Error(`formal blind ${side} manifest/projection/execution media 数量错配。`);
  }
  ordered.forEach((media, index) => {
    const projected = projectedMedia[index];
    const execution = executionMedia[index];
    const expectedVideoStreamIndex = visualEvidenceEnabled ? media.videoStreamIndex : null;
    const fullFileDigest = media.contentIdentity?.digest.toLowerCase();
    if (
      projected === undefined ||
      execution === undefined ||
      media.contentIdentity === null ||
      projected.bindingCommitment !==
        createC137BlindBatchMediaBindingCommitment(
          manifest.id,
          manifest.datasetVersion,
          side,
          visualEvidenceEnabled,
          media
        ) ||
      execution.mediaId !== projected.mediaId ||
      execution.path !== media.path ||
      execution.audioStreamIndex !== media.audioStreamIndex ||
      execution.videoStreamIndex !== expectedVideoStreamIndex ||
      execution.contentIdentity.algorithm !== media.contentIdentity.algorithm ||
      execution.contentIdentity.sizeBytes !== media.contentIdentity.sizeBytes ||
      execution.contentIdentity.firstSampleDigest.toLowerCase() !== fullFileDigest ||
      execution.contentIdentity.middleSampleDigest.toLowerCase() !== fullFileDigest ||
      execution.contentIdentity.lastSampleDigest.toLowerCase() !== fullFileDigest
    ) {
      throw new Error(
        `formal blind ${side}[${index}] 未精确绑定 manifest path/full identity commitment/streams。`
      );
    }
  });
}

function validateExpectations(expected: C137FormalBlindProvenanceExpectations): void {
  assertDigest(expected.manifestDigest, "formal blind expected.manifestDigest");
  assertNonemptyString(expected.datasetVersion, "formal blind expected.datasetVersion");
  assertDigest(expected.planDigest, "formal blind expected.planDigest");
  assertDigest(expected.parametersDigest, "formal blind expected.parametersDigest");
  assertTopK(expected.topK, "formal blind expected.topK");
}

function formalMediaBinding(media: RealMediaBenchmarkMediaInput): unknown {
  return {
    path: media.path,
    audioStreamIndex: media.audioStreamIndex,
    videoStreamIndex: media.videoStreamIndex,
    contentIdentity: media.contentIdentity
  };
}

function fullFileIdentityKey(media: RealMediaBenchmarkMediaInput, label: string): string {
  if (media.contentIdentity === null) {
    throw new Error(`formal blind ${label} 缺少 full-file identity。`);
  }
  return canonicalJson([
    media.contentIdentity.algorithm.toLowerCase(),
    media.contentIdentity.sizeBytes,
    media.contentIdentity.digest.toLowerCase()
  ]);
}

function normalizePathForIdentityBinding(path: string): string {
  return path.trim().split("/").join("\\").toLocaleLowerCase("en-US");
}

function requireCase(
  byCaseId: ReadonlyMap<string, RealMediaBenchmarkCase>,
  caseId: string
): RealMediaBenchmarkCase {
  const benchmarkCase = byCaseId.get(caseId);
  if (benchmarkCase === undefined) throw new Error(`formal blind case 不存在：${caseId}。`);
  return benchmarkCase;
}

function assertManifestOrderedSubset(
  caseIds: readonly string[],
  manifestCaseIds: readonly string[],
  batchId: string
): void {
  const requested = new Set(caseIds);
  const ordered = manifestCaseIds.filter((caseId) => requested.has(caseId));
  if (!sameOrderedStrings(caseIds, ordered)) {
    throw new Error(
      `formal blind batch ${batchId} caseIds 必须是非空、不重复的 manifest 顺序子集。`
    );
  }
}

function parseIdentifierArray(value: unknown, label: string): string[] {
  assertArray(value, label);
  if (value.length === 0) throw new Error(`${label} 不能为空。`);
  const result = value.map((item, index) => {
    assertIdentifier(item, `${label}[${index}]`);
    return item;
  });
  if (new Set(result).size !== result.length) throw new Error(`${label} 不得重复。`);
  return result;
}

function requireExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象。`);
  const actualKeys = Object.keys(value).sort(compareAscii);
  const expected = [...expectedKeys].sort(compareAscii);
  if (!sameOrderedStrings(actualKeys, expected)) {
    throw new Error(`${label} 含未知或缺失字段；formal schema 使用 exact keys。`);
  }
  return value;
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${label} 必须是规范标识符。`);
  }
}

function assertNonemptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} 必须是非空字符串。`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is C137Digest {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error(`${label} 必须是规范 sha256 digest。`);
  }
}

function assertTopK(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 2 || (value as number) > 20) {
    throw new Error(`${label} 必须是 2..20 的安全整数。`);
  }
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareAscii(left, right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

function digest(domain: string, payload: string): C137Digest {
  return `sha256:${sha256Hex(JSON.stringify([domain, payload]))}`;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
