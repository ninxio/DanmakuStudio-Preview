import { createTestCompleteTimeMapSpan } from "./timeMapEvidence";
import {
  compileC137BlindBatchBenchmarkEvidence,
  computeC137BlindBatchBenchmarkEvidenceDigest,
  computeC137BlindBatchProjectionDigest,
  createC137BlindBatchExecutionProjection,
  createC137BlindBatchMediaBindingCommitment,
  deriveC137BlindBatchRawPredictionFromNativeReceipt,
  orderC137BlindBatchMediaInputs,
  type C137BlindBatchBenchmarkEvidence,
  type C137BlindBatchExecutionProjection
} from "../domain/alignment/c137BlindBatchEvidence";
import {
  computeC137FormalBlindGoldDigest,
  computeC137FormalBlindManifestDigest,
  computeC137FormalBlindMediaBindingsDigest,
  computeC137FormalBlindParametersDigest,
  computeC137FormalBlindPlanDigest,
  computeC137FormalBlindProvenanceDigest,
  evaluateC137FormalBlindProvenance,
  type C137FormalBlindProvenanceBatchEnvelopeV1,
  type C137FormalBlindProvenanceEvaluation,
  type C137FormalBlindProvenanceExpectations,
  type C137FormalBlindProvenancePlanBatchV1,
  type C137FormalBlindProvenancePlanV1,
  type C137FormalBlindProvenanceV1
} from "../domain/alignment/c137FormalBlindProvenance";
import type {
  RealMediaBenchmarkCase,
  RealMediaBenchmarkGold,
  RealMediaBenchmarkManifest,
  RealMediaBenchmarkMediaInput
} from "../domain/alignment/realMediaBenchmark";
import {
  REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION,
  REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION,
  REAL_MEDIA_BLIND_BATCH_RUNNER_VERSION,
  createRealMediaBlindBatchExecutionDigest,
  createRealMediaBlindBatchRunReceiptDigest,
  createRealMediaBlindBatchSourceRanking,
  createRealMediaBlindBatchTargetRanking,
  type NativeBatchGlobalCandidateEvidence,
  type NativeBatchGlobalSelectionEvidence,
  type RealMediaBlindBatchExecutionMedia,
  type RealMediaBlindBatchExecutionSuite,
  type RealMediaBlindBatchPairOutcome,
  type RealMediaBlindBatchRunReceipt
} from "../domain/alignment/realMediaBlindBatchContract";
import type { AlignmentTimeMapProposal } from "../domain/alignment/types";
import type { MediaContentIdentity } from "../domain/project/types";

const DEFAULT_QUERY_GROUPS: readonly (readonly string[])[] = [
  ["formal-case-1", "formal-case-2"],
  ["formal-case-3", "formal-case-4"],
  ["formal-case-5", "formal-case-6"]
];

export interface C137FormalBlindProvenanceFixtureOptions {
  queryGroups?: readonly (readonly string[])[];
  mutateManifest?: (manifest: RealMediaBenchmarkManifest) => void;
}

export interface C137FormalBlindProvenanceFixture {
  provenance: C137FormalBlindProvenanceV1;
  manifest: RealMediaBenchmarkManifest;
  plan: C137FormalBlindProvenancePlanV1;
  expectations: C137FormalBlindProvenanceExpectations;
  evaluation: C137FormalBlindProvenanceEvaluation;
  decisions: C137FormalBlindProvenanceEvaluation["decisions"];
}

export function createC137FormalBlindProvenanceFixture(
  options: C137FormalBlindProvenanceFixtureOptions = {}
): C137FormalBlindProvenanceFixture {
  const manifest = createManifest();
  options.mutateManifest?.(manifest);
  const manifestDigest = computeC137FormalBlindManifestDigest(manifest);
  const candidateCaseIds = manifest.cases.map((benchmarkCase) => benchmarkCase.id);
  const queryGroups = options.queryGroups ?? DEFAULT_QUERY_GROUPS;
  const planDraft: Omit<C137FormalBlindProvenancePlanV1, "planDigest"> = {
    schemaVersion: 1,
    kind: "c137-formal-blind-provenance-plan",
    manifestDigest,
    datasetVersion: manifest.datasetVersion,
    batches: queryGroups.map((caseIds, index) => ({
      batchId: `formal-batch-${index + 1}`,
      caseIds: [...caseIds],
      candidateCaseIds: [...candidateCaseIds],
      relationshipAxis: "source",
      visualEvidenceEnabled: false,
      topK: 2
    }))
  };
  const plan: C137FormalBlindProvenancePlanV1 = {
    ...planDraft,
    planDigest: computeC137FormalBlindPlanDigest(planDraft)
  };
  const batches = plan.batches.map((batch) =>
    createC137FormalBlindBatchEnvelopeFixture(manifest, batch)
  );
  const draft: Omit<C137FormalBlindProvenanceV1, "provenanceDigest"> = {
    schemaVersion: 1,
    kind: "c137-formal-blind-provenance",
    releaseEligible: false,
    trustStatus: "untrusted-self-consistent-provenance",
    manifest,
    manifestDigest,
    goldDigest: computeC137FormalBlindGoldDigest(manifest),
    mediaBindingsDigest: computeC137FormalBlindMediaBindingsDigest(manifest),
    plan,
    batches
  };
  const provenance: C137FormalBlindProvenanceV1 = {
    ...draft,
    provenanceDigest: computeC137FormalBlindProvenanceDigest(draft)
  };
  const expectations: C137FormalBlindProvenanceExpectations = {
    manifestDigest,
    datasetVersion: manifest.datasetVersion,
    planDigest: plan.planDigest,
    parametersDigest: computeC137FormalBlindParametersDigest(provenance),
    topK: 2
  };
  const evaluation = evaluateC137FormalBlindProvenance(provenance, expectations);
  return {
    provenance,
    manifest,
    plan,
    expectations,
    evaluation,
    decisions: evaluation.decisions
  };
}

export function createC137FormalBlindBatchEnvelopeFixture(
  manifest: RealMediaBenchmarkManifest,
  planBatch: C137FormalBlindProvenancePlanBatchV1
): C137FormalBlindProvenanceBatchEnvelopeV1 {
  const options = {
    caseIds: planBatch.caseIds,
    candidateCaseIds: planBatch.candidateCaseIds,
    relationshipAxis: planBatch.relationshipAxis,
    visualEvidenceEnabled: planBatch.visualEvidenceEnabled,
    topK: planBatch.topK
  } as const;
  const projection = createC137BlindBatchExecutionProjection(manifest, options);
  const executionSuite = createExecutionSuite(manifest, planBatch, projection);
  const nativeReceipt = createNativeReceipt(manifest, planBatch, projection, executionSuite);
  const rawPrediction = deriveC137BlindBatchRawPredictionFromNativeReceipt(
    projection,
    executionSuite,
    nativeReceipt
  );
  const aggregateEvidence = compileC137BlindBatchBenchmarkEvidence(
    manifest,
    options,
    projection,
    rawPrediction
  );
  return {
    schemaVersion: 1,
    kind: "c137-formal-blind-provenance-batch",
    batchId: planBatch.batchId,
    projection,
    executionSuite,
    nativeReceipt,
    rawPrediction,
    aggregateEvidence
  };
}

function createExecutionSuite(
  manifest: RealMediaBenchmarkManifest,
  planBatch: C137FormalBlindProvenancePlanBatchV1,
  projection: C137BlindBatchExecutionProjection
): RealMediaBlindBatchExecutionSuite {
  const byId = new Map(manifest.cases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase]));
  const queries = planBatch.caseIds.map((caseId) => requireCase(byId, caseId));
  const candidates = planBatch.candidateCaseIds.map((caseId) => requireCase(byId, caseId));
  const sourceCases = planBatch.relationshipAxis === "source" ? queries : candidates;
  const targetCases = planBatch.relationshipAxis === "target" ? queries : candidates;
  return {
    schemaVersion: 1,
    suiteId: projection.suiteId,
    datasetVersion: manifest.datasetVersion,
    topK: planBatch.topK,
    sources: createExecutionMedia(
      manifest,
      "source",
      planBatch.visualEvidenceEnabled,
      sourceCases.map((benchmarkCase) => benchmarkCase.source),
      projection.sources
    ),
    targets: createExecutionMedia(
      manifest,
      "target",
      planBatch.visualEvidenceEnabled,
      targetCases.map((benchmarkCase) => benchmarkCase.target),
      projection.targets
    ),
    pairs: projection.pairs.map((pair, index) => ({
      pairOrdinal: index + 1,
      sourceMediaId: pair.sourceMediaId,
      targetMediaId: pair.targetMediaId
    })),
    parameters: {
      ffmpegPath: "C:\\tools\\ffmpeg.exe",
      ffprobePath: "C:\\tools\\ffprobe.exe",
      sampleRate: 16_000,
      windowMs: 32,
      matchThreshold: 0.72,
      minGapMs: 250,
      maxCells: 20_000,
      enableVisualEvidence: planBatch.visualEvidenceEnabled,
      visualSampleIntervalMs: planBatch.visualEvidenceEnabled ? 500 : null
    }
  };
}

function createExecutionMedia(
  manifest: RealMediaBenchmarkManifest,
  side: "source" | "target",
  visualEvidenceEnabled: boolean,
  mediaInputs: readonly RealMediaBenchmarkMediaInput[],
  projected: readonly C137BlindBatchExecutionProjection["sources"][number][]
): RealMediaBlindBatchExecutionMedia[] {
  const ordered = orderC137BlindBatchMediaInputs(
    manifest.id,
    manifest.datasetVersion,
    side,
    visualEvidenceEnabled,
    mediaInputs
  );
  return ordered.map((media, index) => {
    const projectionMedia = projected[index];
    if (projectionMedia === undefined || media.contentIdentity === null) {
      throw new Error("fixture projected media missing");
    }
    const expectedCommitment = createC137BlindBatchMediaBindingCommitment(
      manifest.id,
      manifest.datasetVersion,
      side,
      visualEvidenceEnabled,
      media
    );
    if (projectionMedia.bindingCommitment !== expectedCommitment) {
      throw new Error("fixture projected media binding commitment mismatch");
    }
    return {
      mediaId: projectionMedia.mediaId,
      path: media.path,
      contentIdentity: createExecutionIdentity(media),
      audioStreamIndex: media.audioStreamIndex,
      videoStreamIndex: visualEvidenceEnabled ? media.videoStreamIndex : null
    };
  });
}

function createNativeReceipt(
  manifest: RealMediaBenchmarkManifest,
  planBatch: C137FormalBlindProvenancePlanBatchV1,
  projection: C137BlindBatchExecutionProjection,
  suite: RealMediaBlindBatchExecutionSuite
): RealMediaBlindBatchRunReceipt {
  const selectedPairIds = new Set(
    planBatch.caseIds.map((caseId) =>
      goldPairId(manifest, projection, requireCaseById(manifest, caseId))
    )
  );
  const pairOutcomes: RealMediaBlindBatchPairOutcome[] = suite.pairs.map((pair, index) => {
    const source = requireExecutionMedia(suite.sources, pair.sourceMediaId);
    const target = requireExecutionMedia(suite.targets, pair.targetMediaId);
    const projectedPair = projection.pairs[index];
    if (projectedPair === undefined) throw new Error("fixture projected pair missing");
    const selected = selectedPairIds.has(projectedPair.pairId);
    const score = selected ? 0.95 : 0.25 - index / 1_000;
    return {
      pairIndex: index,
      pairOrdinal: pair.pairOrdinal,
      sourceMediaId: pair.sourceMediaId,
      targetMediaId: pair.targetMediaId,
      nativeStatus: "completed",
      failureCode: null,
      globalSelected: selected,
      globalSelection: createSelection(source, target, score, selected),
      proposalTimeMap: createProposal(source, target)
    };
  });
  const withoutDigest: Omit<RealMediaBlindBatchRunReceipt, "receiptDigest"> = {
    schemaVersion: REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION,
    receiptKind: "c137-real-media-blind-batch-run",
    runnerVersion: REAL_MEDIA_BLIND_BATCH_RUNNER_VERSION,
    suiteId: suite.suiteId,
    datasetVersion: suite.datasetVersion,
    executionDigest: createRealMediaBlindBatchExecutionDigest(suite),
    nativeJobId: `native-${planBatch.batchId}`,
    nativeEvidenceVersion: REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION,
    pairingMode: "fullCartesian",
    status: "completed",
    terminationReason: "native-terminal",
    wallElapsedMs: 1_000,
    sourceCount: suite.sources.length,
    targetCount: suite.targets.length,
    pairCount: suite.pairs.length,
    topK: suite.topK,
    pairOutcomes,
    sourceRankings: suite.sources.map((source) =>
      createRealMediaBlindBatchSourceRanking(source.mediaId, pairOutcomes, suite.topK)
    ),
    targetRankings: suite.targets.map((target) =>
      createRealMediaBlindBatchTargetRanking(
        target.mediaId,
        pairOutcomes,
        Math.min(suite.topK, suite.sources.length)
      )
    )
  };
  return {
    ...withoutDigest,
    receiptDigest: createRealMediaBlindBatchRunReceiptDigest(withoutDigest)
  };
}

function createSelection(
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  score: number,
  selected: boolean
): NativeBatchGlobalSelectionEvidence {
  const candidate = createGlobalCandidate(source, target, score, selected);
  return {
    state: selected ? "selected" : "blocked",
    selected,
    selectedRank: selected ? 1 : null,
    selectedScore: selected ? score : null,
    decisionRank: 1,
    decisionScore: score,
    margin: 0.25,
    candidateCount: 1,
    eligibleCandidateCount: 1,
    topK: [{ ...candidate }],
    decisionCandidate: { ...candidate }
  };
}

function createGlobalCandidate(
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  score: number,
  selected: boolean
): NativeBatchGlobalCandidateEvidence {
  return {
    rank: 1,
    sourceStreamIndex: source.audioStreamIndex,
    targetStreamIndex: target.audioStreamIndex,
    score: Math.max(0, score - 0.05),
    globalScore: score,
    scale: 1,
    offsetMs: 0,
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    inlierCount: 40,
    temporalCoverage: 0.95,
    uniqueSourceCoverage: 0.9,
    eligible: true,
    globalSelected: selected
  };
}

function createProposal(
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia
): AlignmentTimeMapProposal {
  return {
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    spans: [
      createTestCompleteTimeMapSpan(
        {
          kind: "matched",
          sourceStartMs: 0,
          sourceEndMs: 60_000,
          targetStartMs: 0,
          targetEndMs: 60_000
        },
        `${source.mediaId}-${target.mediaId}-span`
      )
    ],
    quality: {
      level: "review",
      probability: 0.91,
      metricSource: "measured",
      coverage: 0.95,
      uniqueContentCoverage: 0.9,
      p50ResidualMs: 30,
      p95ResidualMs: 80,
      p99ResidualMs: 120,
      maxResidualMs: 150,
      boundaryUncertaintyMs: 200,
      alternativeMargin: 0.25,
      anchorCount: 40,
      anchorRegionCount: 3,
      heldOutAnchorCount: 8,
      reasons: ["formal fixture review"]
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 40,
      visualAnchorCount: 0,
      heldOutAnchorCount: 8,
      top1Top2Margin: 0.25,
      uniqueContentCoverage: 0.9,
      repeatedContentOnly: false,
      selectedTrackReason: "formal fixture",
      alternativeTrackScores: [
        {
          sourceStreamIndex: source.audioStreamIndex,
          targetStreamIndex: target.audioStreamIndex,
          score: 0.9,
          scale: 1,
          offsetMs: 0,
          inlierCount: 40
        }
      ],
      notes: []
    },
    sourceStream: createAudioStream(source.audioStreamIndex),
    targetStream: createAudioStream(target.audioStreamIndex),
    sourceVisualStream: null,
    targetVisualStream: null,
    sourceIdentity: { ...source.contentIdentity },
    targetIdentity: { ...target.contentIdentity },
    engineVersion: "alignment-v2.0-rust",
    featureVersion: "c137-formal-provenance-fixture-v1",
    parametersHash: "sha256:test-parameters"
  };
}

function createAudioStream(index: number) {
  return {
    type: "audio" as const,
    index,
    codec: "flac",
    startMs: 0,
    timelineOffsetMs: 0,
    timeBase: "1/48000",
    sampleRate: 48_000,
    channels: 2,
    frameRate: null,
    language: "zh",
    title: "main"
  };
}

function createManifest(): RealMediaBenchmarkManifest {
  return {
    schemaVersion: 2,
    id: "formal-blind-unit-suite",
    name: "正式盲测结构证据单元测试",
    datasetVersion: "formal-frozen-v1",
    description: "程序构造的六关系冻结 manifest。",
    isExample: false,
    licenseNotes: ["不包含真实媒体内容。"],
    cases: Array.from({ length: 6 }, (_, index) => createCase(index + 1))
  };
}

function createCase(index: number): RealMediaBenchmarkCase {
  const gold = createGold(index);
  return {
    id: `formal-case-${index}`,
    title: `冻结关系 ${index}`,
    mediaKind: "real",
    split: "frozen-test",
    scenarios: ["global-offset"],
    source: createMedia("source", index),
    target: createMedia("target", index),
    boundaryToleranceMs: 100,
    versionNotes: [`关系 ${index} 的程序构造版本。`],
    licenseNotes: ["不包含真实媒体内容。"],
    independentAnnotations: [
      { reviewerId: `reviewer-alpha-${index}`, gold: structuredClone(gold) },
      { reviewerId: `reviewer-beta-${index}`, gold: structuredClone(gold) }
    ],
    adjudication: {
      status: "not-needed",
      adjudicatorId: null,
      note: "两份独立标注一致。"
    },
    gold
  };
}

function createMedia(
  side: "source" | "target",
  index: number
): RealMediaBenchmarkMediaInput {
  const digestByte = side === "source" ? index : index + 64;
  return {
    path: `C:\\formal-suite\\${side}-${index}.mkv`,
    audioStreamIndex: side === "source" ? index - 1 : index + 6,
    videoStreamIndex: 0,
    contentIdentity: {
      algorithm: "sha256-full-file-v2",
      sizeBytes: side === "source" ? 1_000 + index : 2_000 + index,
      digest: digestByte.toString(16).padStart(2, "0").repeat(32)
    },
    versionNote: `${side} ${index} 的冻结版本。`,
    licenseNote: "程序构造路径。"
  };
}

function createExecutionIdentity(media: RealMediaBenchmarkMediaInput): MediaContentIdentity {
  if (media.contentIdentity === null) throw new Error("fixture full identity missing");
  return {
    algorithm: "sha256-full-file-v2",
    sizeBytes: media.contentIdentity.sizeBytes,
    modifiedUnixMs: media.contentIdentity.sizeBytes,
    firstSampleDigest: media.contentIdentity.digest,
    middleSampleDigest: media.contentIdentity.digest,
    lastSampleDigest: media.contentIdentity.digest
  };
}

function createGold(index: number): RealMediaBenchmarkGold {
  return {
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    matchedAnchors: [1_000, 15_000, 30_000, 45_000, 59_000].map(
      (timeMs, anchorIndex) => ({
        id: `formal-${index}-anchor-${anchorIndex}`,
        sourceMs: timeMs,
        targetMs: timeMs
      })
    ),
    sourceOnlySpans: [],
    targetOnlySpans: [],
    ambiguousSpans: []
  };
}

function goldPairId(
  manifest: RealMediaBenchmarkManifest,
  projection: C137BlindBatchExecutionProjection,
  benchmarkCase: RealMediaBenchmarkCase
): string {
  const sourceCommitment = createC137BlindBatchMediaBindingCommitment(
    manifest.id,
    manifest.datasetVersion,
    "source",
    projection.visualEvidenceEnabled,
    benchmarkCase.source
  );
  const targetCommitment = createC137BlindBatchMediaBindingCommitment(
    manifest.id,
    manifest.datasetVersion,
    "target",
    projection.visualEvidenceEnabled,
    benchmarkCase.target
  );
  const source = projection.sources.find(
    (media) => media.bindingCommitment === sourceCommitment
  );
  const target = projection.targets.find(
    (media) => media.bindingCommitment === targetCommitment
  );
  const pair = projection.pairs.find(
    (candidate) =>
      candidate.sourceMediaId === source?.mediaId &&
      candidate.targetMediaId === target?.mediaId
  );
  if (pair === undefined) throw new Error("fixture gold pair missing");
  return pair.pairId;
}

function requireCase(
  cases: ReadonlyMap<string, RealMediaBenchmarkCase>,
  caseId: string
): RealMediaBenchmarkCase {
  const benchmarkCase = cases.get(caseId);
  if (benchmarkCase === undefined) throw new Error(`fixture case missing: ${caseId}`);
  return benchmarkCase;
}

function requireCaseById(
  manifest: RealMediaBenchmarkManifest,
  caseId: string
): RealMediaBenchmarkCase {
  const benchmarkCase = manifest.cases.find((item) => item.id === caseId);
  if (benchmarkCase === undefined) throw new Error(`fixture case missing: ${caseId}`);
  return benchmarkCase;
}

function requireExecutionMedia(
  media: readonly RealMediaBlindBatchExecutionMedia[],
  mediaId: string
): RealMediaBlindBatchExecutionMedia {
  const result = media.find((item) => item.mediaId === mediaId);
  if (result === undefined) throw new Error(`fixture media missing: ${mediaId}`);
  return result;
}

export function resealC137FormalBlindPlanAndProvenanceFixture(
  provenance: C137FormalBlindProvenanceV1
): void {
  const { planDigest, ...planDraft } = provenance.plan;
  void planDigest;
  provenance.plan.planDigest = computeC137FormalBlindPlanDigest(planDraft);
  resealC137FormalBlindProvenanceFixture(provenance);
}

export function resealC137FormalBlindProvenanceFixture(
  provenance: C137FormalBlindProvenanceV1
): void {
  const { provenanceDigest, ...draft } = provenance;
  void provenanceDigest;
  provenance.provenanceDigest = computeC137FormalBlindProvenanceDigest(draft);
}

export function resealC137FormalBlindProjectionFixture(
  projection: C137BlindBatchExecutionProjection
): void {
  const { projectionDigest, ...draft } = projection;
  void projectionDigest;
  projection.projectionDigest = computeC137BlindBatchProjectionDigest(draft);
}

export function resealC137FormalBlindAggregateEvidenceFixture(
  evidence: C137BlindBatchBenchmarkEvidence
): void {
  const { evidenceDigest, ...draft } = evidence;
  void evidenceDigest;
  evidence.evidenceDigest = computeC137BlindBatchBenchmarkEvidenceDigest(draft);
}
