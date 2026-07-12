import {
  appendC137PerformanceCacheResetReceipt,
  appendC137PerformanceTrial,
  computeC137PerformanceCacheResetReceiptDigest,
  computeC137PerformanceCaseOutputDigest,
  computeC137PerformanceCanonicalDigest,
  computeC137PerformanceEnvironmentDigest,
  createC137PerformanceEvidenceDraft,
  finalizeC137PerformanceEvidence,
  type C137PerformanceCacheCountsV1,
  type C137PerformanceCacheResetReceiptV1,
  type C137PerformanceCacheTelemetryV1,
  type C137PerformanceEnvironmentV1,
  type C137PerformanceMemoryTelemetryV1,
  type C137PerformanceNativeTelemetryV1,
  type C137PerformancePlanV1,
  type C137PerformanceRawEvidenceV1,
  type C137PerformanceRunKindV1,
  type C137PerformanceRunV1,
  type C137PerformanceStageTimingV1
} from "../domain/alignment/c137PerformanceEvidence";

const SESSION_ID = "session-fixture-0001";
const PLAN_ID = "plan-fixture-000001";
const COLD_ID = "trial-cold-fixture-1";
const WARMUP_ID = "trial-warm-fixture-1";
const HOT_ID = "trial-hot-fixture-01";
const CANCEL_ID = "trial-cancel-fixture";
const WORKLOAD_DIGEST = digest("1");
const REQUEST_PARAMETERS_DIGEST = digest("2");
const TIME_MAP_DIGEST = digest("3");
const TIME_MAP_PARAMETERS_HASH = "fnv1a64:0123456789abcdef";
const OUTPUT_DIGEST = computeC137PerformanceCaseOutputDigest({
  caseOrdinal: 0,
  requestParametersDigest: REQUEST_PARAMETERS_DIGEST,
  timeMapParametersHash: TIME_MAP_PARAMETERS_HASH,
  timeMapDigest: TIME_MAP_DIGEST
});
const EMPTY_CACHE: C137PerformanceCacheCountsV1 = {
  audioFeatureEntries: 0,
  landmarkEntries: 0,
  visualFeatureEntries: 0
};

export function createCompleteC137PerformanceEvidenceFixture(): C137PerformanceRawEvidenceV1 {
  const plan = createFixturePlan();
  let draft = createC137PerformanceEvidenceDraft({
    plan,
    environment: createEnvironment(),
    collector: {
      schemaVersion: 1,
      collectorVersion: "c137-native-collector-fixture-v1",
      nativeSchemaVersion: 1,
      clock: "rust-std-instant-session-relative-v1",
      memoryScope: "application-process-tree",
      sampler: "windows-toolhelp-working-set-v1",
      sessionId: SESSION_ID,
      sessionOriginTickNs: "0",
      memorySampleIntervalMs: 100,
      terminalSessionStatus: "released"
    },
    preflight: { ok: true, realRelationCount: 1, checkedFileCount: 2, issueCodes: [] }
  });
  const coldReset = createReset(COLD_ID, 0, 1, 100);
  const cancelReset = createReset(CANCEL_ID, 1, 2, 4_000_000_000);
  draft = appendC137PerformanceCacheResetReceipt(draft, coldReset);
  draft = appendC137PerformanceCacheResetReceipt(draft, cancelReset);
  draft = appendC137PerformanceTrial(
    draft,
    createRun("cold", COLD_ID, 1, 1_000_000_000, 600_000, coldReset.receiptDigest, null)
  );
  draft = appendC137PerformanceTrial(
    draft,
    createRun("warmup", WARMUP_ID, 1, 2_000_000_000, 60_000, null, null)
  );
  draft = appendC137PerformanceTrial(
    draft,
    createRun("hot", HOT_ID, 1, 3_000_000_000, 120_000, null, WARMUP_ID)
  );
  draft = appendC137PerformanceTrial(draft, createCancellation(cancelReset));
  return finalizeC137PerformanceEvidence(draft, "complete");
}

export function createFixturePlan(): C137PerformancePlanV1 {
  return {
    schemaVersion: 1,
    planId: PLAN_ID,
    workloadDigest: WORKLOAD_DIGEST,
    expectedCaseCount: 1,
    trialOrder: [
      { trialId: COLD_ID, kind: "cold", repetition: 1, warmupTrialId: null, cancellationStageKey: null, cancellationCaseOrdinal: null },
      { trialId: WARMUP_ID, kind: "warmup", repetition: 1, warmupTrialId: null, cancellationStageKey: null, cancellationCaseOrdinal: null },
      { trialId: HOT_ID, kind: "hot", repetition: 1, warmupTrialId: WARMUP_ID, cancellationStageKey: null, cancellationCaseOrdinal: null },
      { trialId: CANCEL_ID, kind: "cancellation", repetition: 1, warmupTrialId: null, cancellationStageKey: "matching", cancellationCaseOrdinal: 0 }
    ],
    requiredStageKeys: ["validating", "matching", "completed"],
    memorySampleIntervalMs: 100,
    maximumMemorySampleGapMs: 100,
    outputCanonicalization: "c137-time-map-output-digest-v1",
    parameters: {
      sampleRate: 8_000,
      windowMs: 250,
      matchThreshold: 0.7,
      minGapMs: 200,
      maxCells: 1_000_000,
      enableVisualEvidence: true,
      visualSampleIntervalMs: 1_000
    }
  };
}

function createEnvironment(): C137PerformanceEnvironmentV1 {
  const unsigned: Omit<C137PerformanceEnvironmentV1, "digest"> = {
    schemaVersion: 1,
    measurementStatus: "complete",
    issues: [],
    operatingSystem: "Windows",
    operatingSystemVersion: "11-test",
    architecture: "x86_64",
    cpuModel: "4-core fixture",
    physicalCoreCount: 4,
    logicalCoreCount: 8,
    totalMemoryBytes: 16 * 1_073_741_824,
    storageScope: "system-volume",
    storageKind: "ssd",
    powerProfile: "fixture",
    ffmpeg: { version: "ffmpeg-fixture", binaryDigest: digest("a") },
    ffprobe: { version: "ffprobe-fixture", binaryDigest: digest("b") }
  };
  return { ...unsigned, digest: computeC137PerformanceEnvironmentDigest(unsigned) };
}

function createReset(
  trialId: string,
  previousGeneration: number,
  cacheGeneration: number,
  resetTickNs: number
): C137PerformanceCacheResetReceiptV1 {
  const unsigned: Omit<C137PerformanceCacheResetReceiptV1, "receiptDigest"> = {
    schemaVersion: 1,
    trialId,
    sessionId: SESSION_ID,
    resetTickNs: String(resetTickNs),
    previousGeneration,
    cacheGeneration,
    before: { audioFeatureEntries: 3, landmarkEntries: 3, visualFeatureEntries: 3 },
    after: { ...EMPTY_CACHE },
    allCachesEmpty: true
  };
  return {
    ...unsigned,
    receiptDigest: computeC137PerformanceCacheResetReceiptDigest(unsigned)
  };
}

function createRun(
  runKind: C137PerformanceRunKindV1,
  trialId: string,
  generation: number,
  startTickNs: number,
  elapsedMs: number,
  cacheResetReceiptDigest: C137PerformanceCacheResetReceiptV1["receiptDigest"] | null,
  warmupTrialId: string | null
): C137PerformanceRunV1 {
  const outputDigest = computeC137PerformanceCanonicalDigest({
    domain: "c137-time-map-output-suite-v1",
    cases: [{ caseOrdinal: 0, digest: OUTPUT_DIGEST }]
  });
  return {
    trialType: "run",
    trialId,
    runKind,
    repetition: 1,
    sessionId: SESSION_ID,
    workloadDigest: WORKLOAD_DIGEST,
    status: "completed",
    startTickNs: String(startTickNs),
    endTickNs: String(startTickNs + elapsedMs * 1_000_000),
    elapsedMs,
    cacheResetReceiptDigest,
    warmupTrialId,
    outputDigest,
    cases: [
      {
        caseOrdinal: 0,
        jobId: `job-${trialId}`,
        status: "completed",
        requestParametersDigest: REQUEST_PARAMETERS_DIGEST,
        timeMapParametersHash: TIME_MAP_PARAMETERS_HASH,
        timeMapDigest: TIME_MAP_DIGEST,
        outputDigest: OUTPUT_DIGEST,
        telemetry: createTelemetry(runKind, generation, startTickNs, elapsedMs)
      }
    ]
  };
}

function createTelemetry(
  runKind: C137PerformanceRunKindV1,
  generation: number,
  startTickNs: number,
  elapsedMs: number
): C137PerformanceNativeTelemetryV1 {
  return {
    schemaVersion: 1,
    clock: "rust-std-instant-session-relative-v1",
    startTickNs: String(startTickNs),
    endTickNs: String(startTickNs + elapsedMs * 1_000_000),
    elapsedMs,
    stages: createStages(startTickNs, elapsedMs),
    cache: createCache(runKind, generation),
    memory: createMemory(1_073_741_824),
    cancellation: null
  };
}

function createStages(startTickNs: number, elapsedMs: number): C137PerformanceStageTimingV1[] {
  const first = Math.floor(elapsedMs / 3);
  const second = Math.floor(elapsedMs / 3);
  const third = elapsedMs - first - second;
  return [
    createStage("validating", startTickNs, first),
    createStage("matching", startTickNs + first * 1_000_000, second),
    createStage("completed", startTickNs + (first + second) * 1_000_000, third)
  ];
}

function createStage(
  stageKey: C137PerformanceStageTimingV1["stageKey"],
  startTickNs: number,
  elapsedMs: number
): C137PerformanceStageTimingV1 {
  return {
    stageKey,
    occurrence: 1,
    startTickNs: String(startTickNs),
    endTickNs: String(startTickNs + elapsedMs * 1_000_000),
    elapsedMs,
    status: "completed"
  };
}

function createCache(
  runKind: C137PerformanceRunKindV1,
  generation: number
): C137PerformanceCacheTelemetryV1 {
  const hot = runKind === "hot";
  const counter = hot
    ? { hits: 1, misses: 0, writes: 0, evictions: 0 }
    : { hits: 0, misses: 1, writes: 1, evictions: 0 };
  return {
    generation,
    before: hot
      ? { audioFeatureEntries: 1, landmarkEntries: 1, visualFeatureEntries: 1 }
      : { ...EMPTY_CACHE },
    after: { audioFeatureEntries: 1, landmarkEntries: 1, visualFeatureEntries: 1 },
    audioFeatures: { ...counter },
    landmarks: { ...counter },
    visualFeatures: { ...counter }
  };
}

function createMemory(peakProcessTreeRssBytes: number): C137PerformanceMemoryTelemetryV1 {
  return {
    scope: "application-process-tree",
    sampler: "windows-toolhelp-working-set-v1",
    sampleIntervalMs: 100,
    sampleCount: 10,
    failedSampleCount: 0,
    maximumSampleGapMs: 100,
    peakProcessTreeRssBytes,
    coverageComplete: true,
    processTreeEmptyAtTerminal: true,
    residualProcessCount: 0
  };
}

function createCancellation(reset: C137PerformanceCacheResetReceiptV1) {
  const start = 4_100_000_000;
  const request = 4_200_000_000;
  const terminal = 4_300_000_000;
  return {
    trialType: "cancellation" as const,
    trialId: CANCEL_ID,
    repetition: 1,
    sessionId: SESSION_ID,
    workloadDigest: WORKLOAD_DIGEST,
    caseOrdinal: 0,
    jobId: "job-cancellation-fixture",
    triggerStageKey: "matching" as const,
    requestTickNs: String(request),
    terminalTickNs: String(terminal),
    latencyMs: 100,
    commandAccepted: true,
    terminalStatus: "cancelled" as const,
    processTreeEmpty: true,
    residualProcessCount: 0,
    cacheResetReceiptDigest: reset.receiptDigest,
    telemetry: {
      schemaVersion: 1 as const,
      clock: "rust-std-instant-session-relative-v1" as const,
      startTickNs: String(start),
      endTickNs: String(terminal),
      elapsedMs: 200,
      stages: [
        createStage("validating", start, 50),
        {
          ...createStage("matching", start + 50_000_000, 150),
          status: "cancelled" as const
        }
      ],
      cache: createCache("cold", reset.cacheGeneration),
      memory: createMemory(512 * 1_048_576),
      cancellation: {
        requestTickNs: String(request),
        terminalTickNs: String(terminal),
        latencyMs: 100,
        commandAccepted: true
      }
    }
  };
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
