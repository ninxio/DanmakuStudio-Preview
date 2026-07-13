import { describe, expect, it } from "vitest";
import {
  createC137FormalBlindBatchEnvelopeFixture as createBatchEnvelope,
  createC137FormalBlindProvenanceFixture,
  resealC137FormalBlindAggregateEvidenceFixture as resealAggregateEvidence,
  resealC137FormalBlindPlanAndProvenanceFixture as resealPlanAndProvenance,
  resealC137FormalBlindProjectionFixture as resealProjection,
  resealC137FormalBlindProvenanceFixture as resealProvenance
} from "../../test/c137FormalBlindProvenance";
import {
  computeC137FormalBlindManifestDigest,
  computeC137FormalBlindMediaBindingsDigest,
  computeC137FormalBlindParametersDigest,
  evaluateC137FormalBlindProvenance,
  validateC137FormalBlindProvenance,
  type C137FormalBlindProvenancePlanBatchV1,
  type C137FormalBlindProvenanceV1
} from "./c137FormalBlindProvenance";

describe("C137 formal blind structural provenance v1", () => {
  it("validates a six-case full-universe structural smoke and derives every decision", () => {
    const fixture = createC137FormalBlindProvenanceFixture();
    const { provenance } = fixture;
    const validation = validateC137FormalBlindProvenance(provenance);
    const evaluation = evaluateC137FormalBlindProvenance(provenance, fixture.expectations);

    expect(validation).toMatchObject({ valid: true, issues: [], coverageValid: true });
    expect(evaluation).toMatchObject({ valid: true, issues: [], coverageValid: true });
    expect(fixture.evaluation).toEqual(evaluation);
    expect(fixture.decisions).toEqual(evaluation.decisions);
    expect(evaluation.decisions).toHaveLength(6);
    expect(new Set(evaluation.decisions.map((decision) => decision.caseId))).toEqual(
      new Set(provenance.manifest.cases.map((benchmarkCase) => benchmarkCase.id))
    );
    expect(new Set(evaluation.decisions.map((decision) => decision.provenanceRef)).size).toBe(6);
    expect(provenance.releaseEligible).toBe(false);
    expect(provenance.trustStatus).toBe("untrusted-self-consistent-provenance");
  });

  it("fails closed when the plan omits one frozen query even though every batch is self-consistent", () => {
    const provenance = createFormalProvenance([
      ["formal-case-1", "formal-case-2"],
      ["formal-case-3", "formal-case-4"],
      ["formal-case-5"]
    ]);

    expect(validateC137FormalBlindProvenance(provenance)).toMatchObject({
      valid: false,
      coverageValid: false,
      decisions: []
    });
    expect(validateC137FormalBlindProvenance(provenance).issues.join("\n")).toMatch(
      /coverage.*formal-case-6/i
    );
  });

  it("rejects duplicate batch ids and suite+case replay under a renamed batch", () => {
    const duplicateId = createFormalProvenance();
    duplicateId.plan.batches[1].batchId = duplicateId.plan.batches[0].batchId;
    duplicateId.batches[1].batchId = duplicateId.batches[0].batchId;
    resealPlanAndProvenance(duplicateId);
    expect(validateC137FormalBlindProvenance(duplicateId).issues.join("\n")).toMatch(
      /batchId 重复/
    );

    const replay = createFormalProvenance();
    const replayPlan = structuredClone(replay.plan.batches[0]);
    replayPlan.batchId = "formal-batch-replay";
    const replayEnvelope = structuredClone(replay.batches[0]);
    replayEnvelope.batchId = replayPlan.batchId;
    replay.plan.batches.push(replayPlan);
    replay.batches.push(replayEnvelope);
    resealPlanAndProvenance(replay);
    expect(validateC137FormalBlindProvenance(replay).issues.join("\n")).toMatch(
      /suite\+case replay|duplicate physical query identity/
    );
  });

  it("rejects candidate-universe cropping even when query cases remain included", () => {
    const provenance = createFormalProvenance();
    provenance.plan.batches[0].candidateCaseIds.pop();
    resealPlanAndProvenance(provenance);

    const result = validateC137FormalBlindProvenance(provenance);
    expect(result).toMatchObject({ valid: false, coverageValid: false, decisions: [] });
    expect(result.issues.join("\n")).toMatch(/candidateCaseIds.*完整 real frozen manifest/);
  });

  it("rejects duplicate case coverage across different batches and relationship axes", () => {
    const provenance = createFormalProvenance([
      ["formal-case-1", "formal-case-2"],
      ["formal-case-1", "formal-case-3", "formal-case-4"],
      ["formal-case-5", "formal-case-6"]
    ]);
    const secondPlanBatch = provenance.plan.batches[1];
    if (secondPlanBatch === undefined) throw new Error("fixture second plan batch missing");
    secondPlanBatch.relationshipAxis = "target";
    provenance.batches[1] = createBatchEnvelope(provenance.manifest, secondPlanBatch);
    resealPlanAndProvenance(provenance);

    const result = validateC137FormalBlindProvenance(provenance);
    expect(result).toMatchObject({ valid: false, coverageValid: false, decisions: [] });
    expect(result.issues.join("\n")).toMatch(/duplicate case coverage.*formal-case-1/);
  });

  it("rejects copied physical relationships and cross-batch query identities", () => {
    const queryGroups = [
      ["formal-case-1"],
      ["formal-case-2"],
      ["formal-case-3", "formal-case-4"],
      ["formal-case-5", "formal-case-6"]
    ] as const;
    const duplicatedPair = createC137FormalBlindProvenanceFixture({
      queryGroups,
      mutateManifest(manifest) {
        const first = manifest.cases[0];
        const second = manifest.cases[1];
        if (first === undefined || second === undefined) throw new Error("fixture case missing");
        second.source.contentIdentity = structuredClone(first.source.contentIdentity);
        second.target.contentIdentity = structuredClone(first.target.contentIdentity);
      }
    }).provenance;
    expect(validateC137FormalBlindProvenance(duplicatedPair).issues.join("\n")).toMatch(
      /duplicate physical relationship.*formal-case-1\/formal-case-2/
    );

    const duplicatedQuery = createC137FormalBlindProvenanceFixture({
      queryGroups,
      mutateManifest(manifest) {
        const first = manifest.cases[0];
        const second = manifest.cases[1];
        if (first === undefined || second === undefined) throw new Error("fixture case missing");
        second.source.contentIdentity = structuredClone(first.source.contentIdentity);
      }
    }).provenance;
    expect(validateC137FormalBlindProvenance(duplicatedQuery).issues.join("\n")).toMatch(
      /source-axis duplicate physical query identity/
    );
  });

  it.each(["digest", "sizeBytes"] as const)(
    "rejects one normalized path whose %s differs across query shards",
    (differentField) => {
      const conflictingPath = createC137FormalBlindProvenanceFixture({
        mutateManifest(manifest) {
          const first = manifest.cases[0];
          const third = manifest.cases[2];
          if (first === undefined || third === undefined) throw new Error("fixture case missing");
          if (first.source.contentIdentity === null) throw new Error("fixture identity missing");
          third.source.path = first.source.path.toUpperCase().split("\\").join("/");
          third.source.contentIdentity = structuredClone(first.source.contentIdentity);
          if (differentField === "digest") {
            third.source.contentIdentity.digest = "fe".repeat(32);
          } else {
            third.source.contentIdentity.sizeBytes += 1;
          }
        }
      }).provenance;

      const result = validateC137FormalBlindProvenance(conflictingPath);
      expect(result).toMatchObject({ valid: false, coverageValid: false, decisions: [] });
      expect(result.issues.join("\n")).toMatch(
        /path identity conflict.*同一规范化路径绑定了不同 full-file identity/
      );
    }
  );

  it("rejects full-file identity algorithm drift before path binding can pass", () => {
    const provenance = createFormalProvenance();
    const first = provenance.manifest.cases[0];
    const third = provenance.manifest.cases[2];
    if (first === undefined || third === undefined) throw new Error("fixture case missing");
    if (third.source.contentIdentity === null) throw new Error("fixture identity missing");
    third.source.path = first.source.path;
    (third.source.contentIdentity as { algorithm: string }).algorithm =
      "sha256-full-file-v3";
    provenance.manifestDigest = computeC137FormalBlindManifestDigest(provenance.manifest);
    provenance.mediaBindingsDigest = computeC137FormalBlindMediaBindingsDigest(
      provenance.manifest
    );
    provenance.plan.manifestDigest = provenance.manifestDigest;
    resealPlanAndProvenance(provenance);

    const result = validateC137FormalBlindProvenance(provenance);
    expect(result).toMatchObject({ valid: false, coverageValid: false, decisions: [] });
    expect(result.issues.join("\n")).toMatch(/manifest 无效.*contentIdentity/);
  });

  it.each([
    ["relationshipAxis", (batch: C137FormalBlindProvenancePlanBatchV1) => {
      batch.relationshipAxis = "target";
    }],
    ["visualEvidenceEnabled", (batch: C137FormalBlindProvenancePlanBatchV1) => {
      batch.visualEvidenceEnabled = true;
    }],
    ["topK", (batch: C137FormalBlindProvenancePlanBatchV1) => {
      batch.topK = 3;
    }]
  ] as const)("rejects a resealed plan whose %s no longer binds the envelope", (_label, mutate) => {
    const provenance = createFormalProvenance();
    mutate(provenance.plan.batches[0]);
    resealPlanAndProvenance(provenance);

    const result = evaluateC137FormalBlindProvenance(provenance, {
      manifestDigest: provenance.manifestDigest,
      datasetVersion: provenance.manifest.datasetVersion,
      planDigest: provenance.plan.planDigest,
      parametersDigest: computeC137FormalBlindParametersDigest(provenance),
      topK: 2
    });
    expect(result).toMatchObject({ valid: false, coverageValid: false, decisions: [] });
  });

  it("rejects suite, native receipt, raw prediction and aggregate evidence tampering", () => {
    const suiteTamper = createFormalProvenance();
    const projection = suiteTamper.batches[0].projection;
    projection.suiteId = "suite-replayed";
    resealProjection(projection);
    resealProvenance(suiteTamper);
    expect(validateC137FormalBlindProvenance(suiteTamper).issues.join("\n")).toMatch(
      /projection 不是唯一重建结果/
    );

    const receiptTamper = createFormalProvenance();
    receiptTamper.batches[0].nativeReceipt.receiptDigest = `sha256:${"0".repeat(64)}`;
    resealProvenance(receiptTamper);
    expect(validateC137FormalBlindProvenance(receiptTamper).issues.join("\n")).toMatch(
      /receiptDigest/
    );

    const rawTamper = createFormalProvenance();
    rawTamper.batches[0].rawPrediction.nativeReceiptDigest = `sha256:${"1".repeat(64)}`;
    resealProvenance(rawTamper);
    expect(validateC137FormalBlindProvenance(rawTamper).issues.join("\n")).toMatch(
      /rawPrediction 不是 native receipt/
    );

    const evidenceTamper = createFormalProvenance();
    evidenceTamper.batches[0].aggregateEvidence.top1HitCount -= 1;
    resealAggregateEvidence(evidenceTamper.batches[0].aggregateEvidence);
    resealProvenance(evidenceTamper);
    expect(validateC137FormalBlindProvenance(evidenceTamper).issues.join("\n")).toMatch(
      /aggregate evidence 不是冻结 gold/
    );
  });

  it("rejects execution media identity that no longer matches the manifest full file", () => {
    const provenance = createFormalProvenance();
    const tamperedIdentity = provenance.batches[0].executionSuite.sources[0].contentIdentity;
    tamperedIdentity.firstSampleDigest = "f".repeat(64);
    tamperedIdentity.middleSampleDigest = "f".repeat(64);
    tamperedIdentity.lastSampleDigest = "f".repeat(64);
    resealProvenance(provenance);

    expect(validateC137FormalBlindProvenance(provenance).issues.join("\n")).toMatch(
      /manifest path\/full identity commitment\/streams/
    );
  });

  it("rejects resealed execution parameters that miss the external parameter digest", () => {
    const provenance = createFormalProvenance();
    const expectedParametersDigest = computeC137FormalBlindParametersDigest(provenance);
    provenance.batches[0].executionSuite.parameters.matchThreshold = 0.81;
    resealProvenance(provenance);

    const result = evaluateC137FormalBlindProvenance(provenance, {
      manifestDigest: provenance.manifestDigest,
      datasetVersion: provenance.manifest.datasetVersion,
      planDigest: provenance.plan.planDigest,
      parametersDigest: expectedParametersDigest,
      topK: 2
    });
    expect(result).toMatchObject({ valid: false, coverageValid: false, decisions: [] });
    expect(result.issues.join("\n")).toMatch(/parametersDigest 未命中外部期望/);
  });

  it("rejects an envelope replay and unknown formal schema fields", () => {
    const reordered = createFormalProvenance();
    [reordered.batches[0], reordered.batches[1]] = [
      reordered.batches[1],
      reordered.batches[0]
    ];
    resealProvenance(reordered);
    expect(validateC137FormalBlindProvenance(reordered).issues.join("\n")).toMatch(
      /按序.*一一对应/
    );

    const injected = structuredClone(createFormalProvenance()) as unknown as Record<
      string,
      unknown
    >;
    injected.claimedAuthority = true;
    expect(validateC137FormalBlindProvenance(injected).issues.join("\n")).toMatch(
      /exact keys/
    );
  });
});

function createFormalProvenance(
  queryGroups?: readonly (readonly string[])[]
): C137FormalBlindProvenanceV1 {
  return createC137FormalBlindProvenanceFixture(
    queryGroups === undefined ? {} : { queryGroups }
  ).provenance;
}
