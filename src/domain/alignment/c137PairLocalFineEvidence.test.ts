import { describe, expect, it } from "vitest";
import { createC137FormalBlindProvenanceFixture } from "../../test/c137FormalBlindProvenance";
import {
  c137TimeMapCasesEqualPairLocalEvidence,
  deriveC137PairLocalFineEvidence,
  deriveC137TimeMapCasesFromPairLocalFineEvidence
} from "./c137PairLocalFineEvidence";

describe("C137 pair-local fine evidence", () => {
  it("从同一 formal provenance 唯一定位 frozen gold pair 并绑定实际 fine window/TimeMap", () => {
    const fixture = createC137FormalBlindProvenanceFixture();

    const evidence = deriveC137PairLocalFineEvidence(fixture.provenance);

    expect(evidence.cases).toHaveLength(fixture.manifest.cases.length);
    expect(evidence.cases.every((item) => item.status === "measured")).toBe(true);
    expect(evidence.cases.every((item) => item.frontierResolutionProven)).toBe(true);
    expect(evidence.cases.every((item) => item.selectedSourceWindow !== null)).toBe(true);
    expect(evidence.cases.every((item) => item.selectedTargetWindow !== null)).toBe(true);
    expect(
      evidence.cases.every((item) =>
        item.timeMap?.matchedProjectionErrorsMs.every((errorMs) => errorMs === 0)
      )
    ).toBe(true);
  });

  it("不会把 component 总候选数冒充为某个 pair 的完整多窗口清单", () => {
    const fixture = createC137FormalBlindProvenanceFixture();

    const evidence = deriveC137PairLocalFineEvidence(fixture.provenance);

    expect(
      evidence.cases.every((item) => item.completePairCandidateInventoryEnumerated === false)
    ).toBe(true);
    expect(evidence.cases.every((item) => item.pairCandidateCountLowerBound === 1)).toBe(true);
    expect(evidence.cases.every((item) => !item.samePairAlternativeObserved)).toBe(true);
  });

  it("锚点误差由 frozen Gold 与 native proposal 重算，报告数字被修改后不再相等", () => {
    const fixture = createC137FormalBlindProvenanceFixture({
      mutateManifest: (manifest) => {
        const benchmarkCase = manifest.cases[0];
        if (benchmarkCase === undefined) throw new Error("fixture case missing");
        benchmarkCase.gold.matchedAnchors[0].targetMs += 50;
        for (const annotation of benchmarkCase.independentAnnotations) {
          annotation.gold.matchedAnchors[0].targetMs += 50;
        }
      }
    });
    const evidence = deriveC137PairLocalFineEvidence(fixture.provenance);
    const cases = deriveC137TimeMapCasesFromPairLocalFineEvidence(evidence);

    expect(cases[0]?.matchedProjectionErrorsMs[0]).toBe(50);
    expect(c137TimeMapCasesEqualPairLocalEvidence(cases, evidence)).toBe(true);
    cases[0].matchedProjectionErrorsMs[0] = 0;
    expect(c137TimeMapCasesEqualPairLocalEvidence(cases, evidence)).toBe(false);
  });
});
