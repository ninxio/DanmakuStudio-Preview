import {
  applyAuthorityIssuedManualMediaTimeMapVerification,
  createManualMediaTimeMapVerificationRequest
} from "../domain/alignment/mediaTimeMap";
import {
  createTimeMapSpanPlaybackReviewToken,
  type TimeMapSpanPlaybackEvidence
} from "../domain/alignment/timeMapPlaybackReviewEvidence";
import type { MediaTimeMap } from "../domain/project/types";

interface TestManualVerificationInput {
  calibrationArtifactId: string;
  calibrationArtifactVersion: string;
  verifier: string;
  verifiedAt: string;
}

/** Test fixture helper. Production code must use the native manualVerificationAuthority bridge. */
export function applyTestManualMediaTimeMapVerification(
  map: MediaTimeMap,
  input: TestManualVerificationInput
): MediaTimeMap {
  if (map.spans.some((span) => span.kind === "ambiguous")) {
    // Some projection tests intentionally construct an impossible self-reported verified map to
    // assert that the export path still blocks it. Production issuance rejects this shape.
    return { ...map, quality: { ...map.quality, level: "verified" }, verification: null };
  }
  const reviewNotes = map.spans.flatMap((span, spanIndex) => {
    if (span.kind === "sourceOnly") {
      return [`manual-span-review:v1:${spanIndex}:source-extra:${input.verifiedAt}`];
    }
    if (span.kind === "targetOnly") {
      return [`manual-span-review:v1:${spanIndex}:target-extra:${input.verifiedAt}`];
    }
    return [];
  });
  const reviewedMap: MediaTimeMap = {
    ...map,
    evidence: {
      ...map.evidence,
      types: map.evidence.types.includes("manual")
        ? [...map.evidence.types]
        : [...map.evidence.types, "manual"],
      notes: [...map.evidence.notes, ...reviewNotes]
    }
  };
  reviewedMap.evidence.notes.push(
    ...reviewedMap.spans.map((span, spanIndex) =>
      createTimeMapSpanPlaybackReviewToken(
        reviewedMap,
        spanIndex,
        createCompletePlaybackEvidence(span.kind),
        input.verifiedAt
      )
    )
  );
  const completeInput = { ...input };
  const request = createManualMediaTimeMapVerificationRequest(reviewedMap, completeInput);
  return applyAuthorityIssuedManualMediaTimeMapVerification(reviewedMap, completeInput, {
    verificationId: `test-verification-${map.id}`,
    issuerKeyId: "vitest-install-key",
    issuerSequence: 1,
    signatureAlgorithm: "hmac-sha256-v1",
    signature: "1".repeat(64),
    requestDigest: request.requestDigest
  });
}

function createCompletePlaybackEvidence(
  kind: MediaTimeMap["spans"][number]["kind"]
): TimeMapSpanPlaybackEvidence {
  if (kind === "matched") {
    return {
      spanAxes: ["source", "target"],
      startBoundaryAxes: [],
      endBoundaryAxes: []
    };
  }
  return {
    spanAxes:
      kind === "sourceOnly"
        ? ["source"]
        : kind === "targetOnly"
          ? ["target"]
          : ["source", "target"],
    startBoundaryAxes: ["source", "target"],
    endBoundaryAxes: ["source", "target"]
  };
}
