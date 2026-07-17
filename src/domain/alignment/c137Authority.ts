import type { C137FormalBlindProvenanceV3 } from "./c137FormalBlindProvenance";
import {
  computeC137CanonicalDigest,
  computeC137ReportEvidenceDigest,
  evaluateC137AcceptanceBundle,
  type C137AcceptanceBundle,
  type C137AcceptanceGate,
  type C137AcceptanceTrustContext,
  type C137Digest
} from "./c137Acceptance";

export const C137_AUTHORITY_SCHEMA_VERSION = 1 as const;
export const C137_AUTHORITY_SIGNATURE_ALGORITHM = "ecdsa-p256-sha256-ieee-p1363" as const;

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const BASE64_URL = /^[A-Za-z0-9_-]+$/;
const MAX_LEDGER_ACTIONS = 100_000;

export interface C137AuthorityPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface C137AuthorityTrustPolicyV1 {
  schemaVersion: typeof C137_AUTHORITY_SCHEMA_VERSION;
  kind: "c137-authority-trust-policy";
  authorityId: string;
  ledgerId: string;
  authorityKeyId: C137Digest;
  publicKey: C137AuthorityPublicJwk;
  minimumLedgerSequence: number;
  requiredCheckpointDigest: C137Digest | null;
}

export interface C137AuthorityPreRunBindingV1 {
  protocolDigest: C137Digest;
  manifestDigest: C137Digest;
  datasetVersion: string;
  certificationClass: C137AcceptanceBundle["certificationClass"];
  blindPlanDigest: C137Digest;
  performancePlanDigest: C137Digest;
  environmentDigest: C137Digest;
  runnerBuildDigest: C137Digest;
  runnerParametersDigest: C137Digest;
}

export interface C137AuthorityChallengePayloadV1 {
  schemaVersion: typeof C137_AUTHORITY_SCHEMA_VERSION;
  kind: "c137-authority-challenge";
  authorityId: string;
  ledgerId: string;
  authorityKeyId: C137Digest;
  challengeId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  issuedLedgerSequence: number;
  binding: C137AuthorityPreRunBindingV1;
}

export interface C137AuthorityPostRunBindingV1 extends C137AuthorityPreRunBindingV1 {
  bundleDigest: C137Digest;
  blindProvenanceDigest: C137Digest;
  performanceEvidenceDigest: C137Digest;
  nativeExecutableDigest: C137Digest;
}

export interface C137AuthorityAttestationPayloadV1 {
  schemaVersion: typeof C137_AUTHORITY_SCHEMA_VERSION;
  kind: "c137-authority-attestation";
  authorityId: string;
  ledgerId: string;
  authorityKeyId: C137Digest;
  challengeId: string;
  challengeDigest: C137Digest;
  issuedAt: string;
  validUntil: string;
  consumedLedgerSequence: number;
  binding: C137AuthorityPostRunBindingV1;
}

export interface C137AuthorityLedgerActionV1 {
  sequence: number;
  action: "issued" | "consumed";
  challengeId: string;
  challengeDigest: C137Digest;
  attestationDigest: C137Digest | null;
  bundleDigest: C137Digest | null;
  recordedAt: string;
}

export interface C137AuthorityLedgerCheckpointPayloadV1 {
  schemaVersion: typeof C137_AUTHORITY_SCHEMA_VERSION;
  kind: "c137-authority-ledger-checkpoint";
  authorityId: string;
  ledgerId: string;
  authorityKeyId: C137Digest;
  sequence: number;
  previousCheckpointDigest: C137Digest | null;
  issuedAt: string;
  actionsDigest: C137Digest;
  actions: C137AuthorityLedgerActionV1[];
}

export interface C137AuthoritySignedEnvelopeV1<T> {
  payload: T;
  signatureAlgorithm: typeof C137_AUTHORITY_SIGNATURE_ALGORITHM;
  signature: string;
}

export interface C137AuthorityProofV1 {
  schemaVersion: typeof C137_AUTHORITY_SCHEMA_VERSION;
  kind: "c137-authority-proof";
  challenge: C137AuthoritySignedEnvelopeV1<C137AuthorityChallengePayloadV1>;
  attestation: C137AuthoritySignedEnvelopeV1<C137AuthorityAttestationPayloadV1>;
  ledgerCheckpoint: C137AuthoritySignedEnvelopeV1<C137AuthorityLedgerCheckpointPayloadV1>;
}

export interface C137AuthorityProofVerification {
  valid: boolean;
  issues: string[];
  authorityKeyId: C137Digest | null;
  challengeDigest: C137Digest | null;
  attestationDigest: C137Digest | null;
  checkpointDigest: C137Digest | null;
}

export async function evaluateC137AcceptanceBundleWithAuthority(
  bundle: C137AcceptanceBundle,
  proof: unknown,
  policy: unknown,
  now = new Date()
): Promise<{ gate: C137AcceptanceGate; verification: C137AuthorityProofVerification }> {
  const verification = await verifyC137AuthorityProof(bundle, proof, policy, now);
  let baseGate: C137AcceptanceGate;
  try {
    baseGate = evaluateC137AcceptanceBundle(
      bundle,
      verification.valid ? createC137AuthorityTrustContext(bundle) : undefined
    );
  } catch (error) {
    const actual = error instanceof Error ? error.message : "authority trust snapshot 构造失败";
    baseGate = evaluateC137AcceptanceBundle(bundle);
    verification.valid = false;
    verification.issues.push(actual);
  }
  return { gate: applyC137AuthorityVerificationToGate(baseGate, verification), verification };
}

export function createC137AuthorityPublicKeyId(key: C137AuthorityPublicJwk): C137Digest {
  return computeC137CanonicalDigest({
    domain: "c137-authority-public-key-v1",
    key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y }
  });
}

export function createC137AuthorityPreRunBinding(
  bundle: C137AcceptanceBundle
): C137AuthorityPreRunBindingV1 {
  return {
    protocolDigest: computeC137CanonicalDigest(bundle.protocol),
    manifestDigest: bundle.manifestDigest,
    datasetVersion: bundle.datasetVersion,
    certificationClass: bundle.certificationClass,
    blindPlanDigest: bundle.protocol.blindRankingPlanDigest,
    performancePlanDigest: bundle.protocol.performancePlanDigest,
    environmentDigest: bundle.environment.digest,
    runnerBuildDigest: bundle.runner.buildDigest,
    runnerParametersDigest: bundle.runner.parametersDigest
  };
}

export function createC137AuthorityPostRunBinding(
  bundle: C137AcceptanceBundle
): C137AuthorityPostRunBindingV1 {
  const provenance = bundle.formalEvidence.blindRelationship;
  const performance = bundle.reports.performance;
  if (provenance === null || performance === null) {
    throw new Error(
      "authority attestation 只接受同时包含 formal blind 与 performance evidence 的 bundle。"
    );
  }
  return {
    ...createC137AuthorityPreRunBinding(bundle),
    bundleDigest: computeC137CanonicalDigest(bundle),
    blindProvenanceDigest: provenance.provenanceDigest,
    performanceEvidenceDigest: performance.rawEvidence.evidenceDigest,
    nativeExecutableDigest: extractSingleNativeExecutableDigest(provenance)
  };
}

export function createC137AuthorityTrustContext(
  bundle: C137AcceptanceBundle
): C137AcceptanceTrustContext {
  const requireReportDigest = (
    report: C137AcceptanceBundle["reports"][keyof C137AcceptanceBundle["reports"]],
    label: string
  ): C137Digest => {
    if (report === null) throw new Error(`authority proof 缺少 ${label} report。`);
    return computeC137ReportEvidenceDigest(report);
  };
  const receipts = bundle.receipts;
  if (
    receipts.datasetApproval === null ||
    receipts.preflight === null ||
    receipts.predictionRun === null
  ) {
    throw new Error("authority proof 缺少完整 acceptance receipts。");
  }
  return {
    trustedProtocolDigest: computeC137CanonicalDigest(bundle.protocol),
    trustedReceiptDigests: {
      datasetApproval: computeC137CanonicalDigest(receipts.datasetApproval),
      preflight: computeC137CanonicalDigest(receipts.preflight),
      predictionRun: computeC137CanonicalDigest(receipts.predictionRun)
    },
    trustedReportEvidenceDigests: {
      dataset: requireReportDigest(bundle.reports.dataset, "dataset"),
      relationshipRanking: requireReportDigest(
        bundle.reports.relationshipRanking,
        "relationshipRanking"
      ),
      timeMap: requireReportDigest(bundle.reports.timeMap, "timeMap"),
      calibration: requireReportDigest(bundle.reports.calibration, "calibration"),
      visualFallback: requireReportDigest(bundle.reports.visualFallback, "visualFallback"),
      degradation: requireReportDigest(bundle.reports.degradation, "degradation"),
      northStar: requireReportDigest(bundle.reports.northStar, "northStar"),
      performance: requireReportDigest(bundle.reports.performance, "performance"),
      uiWalkthrough: requireReportDigest(bundle.reports.uiWalkthrough, "uiWalkthrough"),
      releaseVerification: requireReportDigest(
        bundle.reports.releaseVerification,
        "releaseVerification"
      )
    }
  };
}

export async function verifyC137AuthorityProof(
  bundle: C137AcceptanceBundle,
  proof: unknown,
  policy: unknown,
  now = new Date()
): Promise<C137AuthorityProofVerification> {
  const issues: string[] = [];
  const parsedPolicy = parsePolicy(policy, issues);
  const parsedProof = parseProof(proof, issues);
  if (parsedPolicy === null || parsedProof === null) {
    return emptyVerification(issues);
  }

  const keyId = createC137AuthorityPublicKeyId(parsedPolicy.publicKey);
  if (keyId !== parsedPolicy.authorityKeyId) {
    issues.push("authority trust policy 的 keyId 与 public key 不一致。");
  }
  for (const envelope of [
    parsedProof.challenge,
    parsedProof.attestation,
    parsedProof.ledgerCheckpoint
  ]) {
    if (
      envelope.payload.authorityId !== parsedPolicy.authorityId ||
      envelope.payload.ledgerId !== parsedPolicy.ledgerId ||
      envelope.payload.authorityKeyId !== parsedPolicy.authorityKeyId
    ) {
      issues.push("authority envelope 未绑定外部 trust policy 的 authority/ledger/key。");
    }
  }

  const challengeDigest = computeC137CanonicalDigest(parsedProof.challenge.payload);
  const attestationDigest = computeC137CanonicalDigest(parsedProof.attestation.payload);
  const checkpointDigest = computeC137CanonicalDigest(parsedProof.ledgerCheckpoint.payload);
  const signaturesValid = await verifyAllSignatures(parsedProof, parsedPolicy, issues);
  if (!signaturesValid) issues.push("authority proof 至少一个 ECDSA P-256 签名无效。");

  const challenge = parsedProof.challenge.payload;
  const attestation = parsedProof.attestation.payload;
  const checkpoint = parsedProof.ledgerCheckpoint.payload;
  if (challengeDigest !== attestation.challengeDigest) {
    issues.push("authority attestation 未绑定当前 challenge digest。");
  }
  if (challenge.challengeId !== attestation.challengeId) {
    issues.push("authority challengeId 在 attestation 中发生漂移。");
  }
  if (!equalJson(challenge.binding, createC137AuthorityPreRunBinding(bundle))) {
    issues.push("authority challenge 的预运行 binding 与当前 bundle 不一致。");
  }
  try {
    if (!equalJson(attestation.binding, createC137AuthorityPostRunBinding(bundle))) {
      issues.push("authority attestation 的运行后 binding 与当前 bundle 不一致。");
    }
  } catch (error) {
    issues.push(
      error instanceof Error ? error.message : "无法重建 authority post-run binding。"
    );
  }

  const challengeIssuedAt = parseCanonicalDate(
    challenge.issuedAt,
    "challenge.issuedAt",
    issues
  );
  const challengeExpiresAt = parseCanonicalDate(
    challenge.expiresAt,
    "challenge.expiresAt",
    issues
  );
  const attestationIssuedAt = parseCanonicalDate(
    attestation.issuedAt,
    "attestation.issuedAt",
    issues
  );
  const attestationValidUntil = parseCanonicalDate(
    attestation.validUntil,
    "attestation.validUntil",
    issues
  );
  if (
    challengeIssuedAt !== null &&
    challengeExpiresAt !== null &&
    challengeIssuedAt.getTime() >= challengeExpiresAt.getTime()
  ) {
    issues.push("authority challenge 的有效期必须晚于签发时间。");
  }
  if (
    challengeIssuedAt !== null &&
    challengeExpiresAt !== null &&
    attestationIssuedAt !== null &&
    (attestationIssuedAt.getTime() < challengeIssuedAt.getTime() ||
      attestationIssuedAt.getTime() > challengeExpiresAt.getTime())
  ) {
    issues.push("authority attestation 必须在一次性 challenge 有效期内签发。");
  }
  if (
    attestationIssuedAt !== null &&
    attestationValidUntil !== null &&
    attestationIssuedAt.getTime() >= attestationValidUntil.getTime()
  ) {
    issues.push("authority attestation 的有效期必须晚于签发时间。");
  }
  if (attestationValidUntil !== null && now.getTime() > attestationValidUntil.getTime()) {
    issues.push("authority attestation 已过期。");
  }

  validateLedger(
    checkpoint,
    parsedPolicy,
    challenge,
    challengeDigest,
    attestation,
    attestationDigest,
    checkpointDigest,
    issues
  );
  return {
    valid: issues.length === 0,
    issues,
    authorityKeyId: parsedPolicy.authorityKeyId,
    challengeDigest,
    attestationDigest,
    checkpointDigest
  };
}

function applyC137AuthorityVerificationToGate(
  gate: C137AcceptanceGate,
  verification: C137AuthorityProofVerification
): C137AcceptanceGate {
  const passed = verification.valid;
  const authorityActual = passed
    ? (verification.authorityKeyId ?? "missing")
    : verification.issues.join("；") || "invalid";
  const passIds = new Set([
    "external-trust-authority",
    "external-trust-context",
    "native-blind-plan-authority",
    "native-blind-challenge-freshness",
    "native-blind-replay-ledger"
  ]);
  const checks = gate.checks.map((check) =>
    passIds.has(check.id)
      ? {
          ...check,
          status: passed ? ("pass" as const) : ("incomplete" as const),
          actual: authorityActual
        }
      : check
  );
  const hasFail = checks.some((check) => check.status === "fail");
  const hasIncomplete = checks.some((check) => check.status === "incomplete");
  const status = hasFail ? "fail" : hasIncomplete ? "incomplete-evidence" : "pass";
  return {
    ...gate,
    checks,
    status,
    verifiedEligible: status === "pass",
    reasons: checks
      .filter((check) => check.status !== "pass")
      .map((check) => `${check.id}: ${check.requirement}`)
  };
}

function extractSingleNativeExecutableDigest(
  provenance: C137FormalBlindProvenanceV3
): C137Digest {
  const digests = new Set<C137Digest>();
  for (const batch of provenance.batches) {
    for (const outcome of batch.nativeReceipt.pairOutcomes) {
      const identity = outcome.relationRanking.executionIdentity;
      if (identity !== null) digests.add(identity.nativeExecutableDigest);
    }
  }
  if (digests.size !== 1) {
    throw new Error("formal blind provenance 必须只包含一个实际 native executable digest。");
  }
  const [digest] = digests;
  if (digest === undefined)
    throw new Error("formal blind provenance 缺少 native executable digest。");
  return digest;
}

async function verifyAllSignatures(
  proof: C137AuthorityProofV1,
  policy: C137AuthorityTrustPolicyV1,
  issues: string[]
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      {
        ...policy.publicKey,
        ext: true,
        key_ops: ["verify"]
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const envelopes = [proof.challenge, proof.attestation, proof.ledgerCheckpoint];
    const results = await Promise.all(
      envelopes.map((envelope) =>
        crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          toBufferSource(decodeBase64Url(envelope.signature)),
          new TextEncoder().encode(computeC137CanonicalDigest(envelope.payload))
        )
      )
    );
    return results.every(Boolean);
  } catch (error) {
    issues.push(
      `authority signature verifier 不可用：${error instanceof Error ? error.message : "unknown"}`
    );
    return false;
  }
}

function validateLedger(
  checkpoint: C137AuthorityLedgerCheckpointPayloadV1,
  policy: C137AuthorityTrustPolicyV1,
  challenge: C137AuthorityChallengePayloadV1,
  challengeDigest: C137Digest,
  attestation: C137AuthorityAttestationPayloadV1,
  attestationDigest: C137Digest,
  checkpointDigest: C137Digest,
  issues: string[]
): void {
  if (checkpoint.sequence < policy.minimumLedgerSequence) {
    issues.push("authority ledger checkpoint 早于外部 trust policy 的最低序列。");
  }
  if (
    policy.requiredCheckpointDigest !== null &&
    checkpointDigest !== policy.requiredCheckpointDigest
  ) {
    issues.push("authority ledger checkpoint 未命中外部固定摘要。");
  }
  if (checkpoint.sequence !== checkpoint.actions.length) {
    issues.push("authority ledger sequence 与动作库存长度不一致。");
  }
  if (computeC137CanonicalDigest(checkpoint.actions) !== checkpoint.actionsDigest) {
    issues.push("authority ledger actionsDigest 与动作库存不一致。");
  }
  const challengeActions = checkpoint.actions.filter(
    (action) => action.challengeId === challenge.challengeId
  );
  const issued = challengeActions.filter((action) => action.action === "issued");
  const consumed = challengeActions.filter((action) => action.action === "consumed");
  if (issued.length !== 1 || consumed.length !== 1) {
    issues.push("authority ledger 必须且只能登记一次 challenge issued 和一次 consumed。");
  }
  const issuedAction = issued[0];
  const consumedAction = consumed[0];
  if (
    issuedAction === undefined ||
    issuedAction.sequence !== challenge.issuedLedgerSequence ||
    issuedAction.challengeDigest !== challengeDigest ||
    issuedAction.attestationDigest !== null ||
    issuedAction.bundleDigest !== null
  ) {
    issues.push("authority ledger 的 issued 动作未精确绑定 challenge。");
  }
  if (
    consumedAction === undefined ||
    consumedAction.sequence !== attestation.consumedLedgerSequence ||
    consumedAction.challengeDigest !== challengeDigest ||
    consumedAction.attestationDigest !== attestationDigest ||
    consumedAction.bundleDigest !== attestation.binding.bundleDigest
  ) {
    issues.push("authority ledger 的 consumed 动作未精确绑定 attestation/bundle。");
  }
  const seenChallengeIds = new Set<string>();
  const issuedIds = new Set<string>();
  const consumedIds = new Set<string>();
  for (let index = 0; index < checkpoint.actions.length; index += 1) {
    const action = checkpoint.actions[index];
    if (action === undefined || action.sequence !== index + 1) {
      issues.push("authority ledger 动作必须按 1..N 连续排序。");
      break;
    }
    if (action.action === "issued") {
      if (issuedIds.has(action.challengeId)) {
        issues.push("authority ledger 重复签发了相同 challengeId。");
      }
      issuedIds.add(action.challengeId);
      seenChallengeIds.add(action.challengeId);
    } else {
      if (!seenChallengeIds.has(action.challengeId)) {
        issues.push("authority ledger 在 issued 前出现 consumed 动作。");
      }
      if (consumedIds.has(action.challengeId)) {
        issues.push("authority ledger 对同一 challenge 重复登记 consumed。");
      }
      consumedIds.add(action.challengeId);
    }
  }
}

function parsePolicy(value: unknown, issues: string[]): C137AuthorityTrustPolicyV1 | null {
  const record = strictRecord(
    value,
    "authorityPolicy",
    [
      "schemaVersion",
      "kind",
      "authorityId",
      "ledgerId",
      "authorityKeyId",
      "publicKey",
      "minimumLedgerSequence",
      "requiredCheckpointDigest"
    ],
    issues
  );
  if (record === null) return null;
  const key = strictRecord(
    record.publicKey,
    "authorityPolicy.publicKey",
    ["kty", "crv", "x", "y"],
    issues
  );
  if (key === null) return null;
  const authorityId = requireIdentifier(
    record.authorityId,
    "authorityPolicy.authorityId",
    issues
  );
  const ledgerId = requireIdentifier(record.ledgerId, "authorityPolicy.ledgerId", issues);
  const authorityKeyId = requireDigest(
    record.authorityKeyId,
    "authorityPolicy.authorityKeyId",
    issues
  );
  const x = requireBase64Url(
    record.publicKey && key.x,
    "authorityPolicy.publicKey.x",
    43,
    issues
  );
  const y = requireBase64Url(
    record.publicKey && key.y,
    "authorityPolicy.publicKey.y",
    43,
    issues
  );
  const minimumLedgerSequence = requireSafeInteger(
    record.minimumLedgerSequence,
    "authorityPolicy.minimumLedgerSequence",
    0,
    Number.MAX_SAFE_INTEGER,
    issues
  );
  const requiredCheckpointDigest =
    record.requiredCheckpointDigest === null
      ? null
      : requireDigest(
          record.requiredCheckpointDigest,
          "authorityPolicy.requiredCheckpointDigest",
          issues
        );
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "c137-authority-trust-policy" ||
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    authorityId === null ||
    ledgerId === null ||
    authorityKeyId === null ||
    x === null ||
    y === null ||
    minimumLedgerSequence === null ||
    (record.requiredCheckpointDigest !== null && requiredCheckpointDigest === null)
  ) {
    issues.push("authority trust policy 字段值不符合 schema v1。");
    return null;
  }
  return {
    schemaVersion: 1,
    kind: "c137-authority-trust-policy",
    authorityId,
    ledgerId,
    authorityKeyId,
    publicKey: { kty: "EC", crv: "P-256", x, y },
    minimumLedgerSequence,
    requiredCheckpointDigest
  };
}

function parseProof(value: unknown, issues: string[]): C137AuthorityProofV1 | null {
  const record = strictRecord(
    value,
    "authorityProof",
    ["schemaVersion", "kind", "challenge", "attestation", "ledgerCheckpoint"],
    issues
  );
  if (record === null) return null;
  const challenge = parseEnvelope(
    record.challenge,
    "authorityProof.challenge",
    parseChallenge,
    issues
  );
  const attestation = parseEnvelope(
    record.attestation,
    "authorityProof.attestation",
    parseAttestation,
    issues
  );
  const ledgerCheckpoint = parseEnvelope(
    record.ledgerCheckpoint,
    "authorityProof.ledgerCheckpoint",
    parseCheckpoint,
    issues
  );
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "c137-authority-proof" ||
    challenge === null ||
    attestation === null ||
    ledgerCheckpoint === null
  ) {
    issues.push("authority proof 字段值不符合 schema v1。");
    return null;
  }
  return {
    schemaVersion: 1,
    kind: "c137-authority-proof",
    challenge,
    attestation,
    ledgerCheckpoint
  };
}

function parseEnvelope<T>(
  value: unknown,
  path: string,
  parsePayload: (value: unknown, path: string, issues: string[]) => T | null,
  issues: string[]
): C137AuthoritySignedEnvelopeV1<T> | null {
  const record = strictRecord(
    value,
    path,
    ["payload", "signatureAlgorithm", "signature"],
    issues
  );
  if (record === null) return null;
  const payload = parsePayload(record.payload, `${path}.payload`, issues);
  const signature = requireBase64Url(record.signature, `${path}.signature`, 86, issues);
  if (
    record.signatureAlgorithm !== C137_AUTHORITY_SIGNATURE_ALGORITHM ||
    payload === null ||
    signature === null ||
    decodeBase64Url(signature).byteLength !== 64
  ) {
    issues.push(`${path} 不是有效 ECDSA P-256 signed envelope。`);
    return null;
  }
  return { payload, signatureAlgorithm: C137_AUTHORITY_SIGNATURE_ALGORITHM, signature };
}

function parseChallenge(
  value: unknown,
  path: string,
  issues: string[]
): C137AuthorityChallengePayloadV1 | null {
  const record = strictRecord(
    value,
    path,
    [
      "schemaVersion",
      "kind",
      "authorityId",
      "ledgerId",
      "authorityKeyId",
      "challengeId",
      "nonce",
      "issuedAt",
      "expiresAt",
      "issuedLedgerSequence",
      "binding"
    ],
    issues
  );
  if (record === null) return null;
  const common = parseCommonAuthorityFields(record, path, issues);
  const challengeId = requireIdentifier(record.challengeId, `${path}.challengeId`, issues);
  const nonce = requireBase64Url(record.nonce, `${path}.nonce`, 43, issues);
  const issuedAt = requireString(record.issuedAt, `${path}.issuedAt`, issues);
  const expiresAt = requireString(record.expiresAt, `${path}.expiresAt`, issues);
  const issuedLedgerSequence = requireSafeInteger(
    record.issuedLedgerSequence,
    `${path}.issuedLedgerSequence`,
    1,
    Number.MAX_SAFE_INTEGER,
    issues
  );
  const binding = parsePreRunBinding(record.binding, `${path}.binding`, issues);
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "c137-authority-challenge" ||
    common === null ||
    challengeId === null ||
    nonce === null ||
    decodeBase64Url(nonce).byteLength !== 32 ||
    issuedAt === null ||
    expiresAt === null ||
    issuedLedgerSequence === null ||
    binding === null
  )
    return null;
  return {
    schemaVersion: 1,
    kind: "c137-authority-challenge",
    ...common,
    challengeId,
    nonce,
    issuedAt,
    expiresAt,
    issuedLedgerSequence,
    binding
  };
}

function parseAttestation(
  value: unknown,
  path: string,
  issues: string[]
): C137AuthorityAttestationPayloadV1 | null {
  const record = strictRecord(
    value,
    path,
    [
      "schemaVersion",
      "kind",
      "authorityId",
      "ledgerId",
      "authorityKeyId",
      "challengeId",
      "challengeDigest",
      "issuedAt",
      "validUntil",
      "consumedLedgerSequence",
      "binding"
    ],
    issues
  );
  if (record === null) return null;
  const common = parseCommonAuthorityFields(record, path, issues);
  const challengeId = requireIdentifier(record.challengeId, `${path}.challengeId`, issues);
  const challengeDigest = requireDigest(
    record.challengeDigest,
    `${path}.challengeDigest`,
    issues
  );
  const issuedAt = requireString(record.issuedAt, `${path}.issuedAt`, issues);
  const validUntil = requireString(record.validUntil, `${path}.validUntil`, issues);
  const consumedLedgerSequence = requireSafeInteger(
    record.consumedLedgerSequence,
    `${path}.consumedLedgerSequence`,
    1,
    Number.MAX_SAFE_INTEGER,
    issues
  );
  const binding = parsePostRunBinding(record.binding, `${path}.binding`, issues);
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "c137-authority-attestation" ||
    common === null ||
    challengeId === null ||
    challengeDigest === null ||
    issuedAt === null ||
    validUntil === null ||
    consumedLedgerSequence === null ||
    binding === null
  )
    return null;
  return {
    schemaVersion: 1,
    kind: "c137-authority-attestation",
    ...common,
    challengeId,
    challengeDigest,
    issuedAt,
    validUntil,
    consumedLedgerSequence,
    binding
  };
}

function parseCheckpoint(
  value: unknown,
  path: string,
  issues: string[]
): C137AuthorityLedgerCheckpointPayloadV1 | null {
  const record = strictRecord(
    value,
    path,
    [
      "schemaVersion",
      "kind",
      "authorityId",
      "ledgerId",
      "authorityKeyId",
      "sequence",
      "previousCheckpointDigest",
      "issuedAt",
      "actionsDigest",
      "actions"
    ],
    issues
  );
  if (record === null) return null;
  const common = parseCommonAuthorityFields(record, path, issues);
  const sequence = requireSafeInteger(
    record.sequence,
    `${path}.sequence`,
    0,
    MAX_LEDGER_ACTIONS,
    issues
  );
  const previousCheckpointDigest =
    record.previousCheckpointDigest === null
      ? null
      : requireDigest(
          record.previousCheckpointDigest,
          `${path}.previousCheckpointDigest`,
          issues
        );
  const issuedAt = requireString(record.issuedAt, `${path}.issuedAt`, issues);
  const actionsDigest = requireDigest(record.actionsDigest, `${path}.actionsDigest`, issues);
  const actions = parseLedgerActions(record.actions, `${path}.actions`, issues);
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "c137-authority-ledger-checkpoint" ||
    common === null ||
    sequence === null ||
    (record.previousCheckpointDigest !== null && previousCheckpointDigest === null) ||
    issuedAt === null ||
    actionsDigest === null ||
    actions === null
  )
    return null;
  if (issuedAt !== null) parseCanonicalDate(issuedAt, `${path}.issuedAt`, issues);
  return {
    schemaVersion: 1,
    kind: "c137-authority-ledger-checkpoint",
    ...common,
    sequence,
    previousCheckpointDigest,
    issuedAt,
    actionsDigest,
    actions
  };
}

function parseLedgerActions(
  value: unknown,
  path: string,
  issues: string[]
): C137AuthorityLedgerActionV1[] | null {
  if (!Array.isArray(value) || value.length > MAX_LEDGER_ACTIONS) {
    issues.push(`${path} 必须是不超过 ${MAX_LEDGER_ACTIONS} 项的数组。`);
    return null;
  }
  const actions: C137AuthorityLedgerActionV1[] = [];
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = strictRecord(
      item,
      itemPath,
      [
        "sequence",
        "action",
        "challengeId",
        "challengeDigest",
        "attestationDigest",
        "bundleDigest",
        "recordedAt"
      ],
      issues
    );
    if (record === null) return;
    const sequence = requireSafeInteger(
      record.sequence,
      `${itemPath}.sequence`,
      1,
      MAX_LEDGER_ACTIONS,
      issues
    );
    const challengeId = requireIdentifier(
      record.challengeId,
      `${itemPath}.challengeId`,
      issues
    );
    const challengeDigest = requireDigest(
      record.challengeDigest,
      `${itemPath}.challengeDigest`,
      issues
    );
    const attestationDigest =
      record.attestationDigest === null
        ? null
        : requireDigest(record.attestationDigest, `${itemPath}.attestationDigest`, issues);
    const bundleDigest =
      record.bundleDigest === null
        ? null
        : requireDigest(record.bundleDigest, `${itemPath}.bundleDigest`, issues);
    const recordedAt = requireString(record.recordedAt, `${itemPath}.recordedAt`, issues);
    const actionClaimsValid =
      record.action === "issued"
        ? attestationDigest === null && bundleDigest === null
        : attestationDigest !== null && bundleDigest !== null;
    if (
      (record.action !== "issued" && record.action !== "consumed") ||
      sequence === null ||
      challengeId === null ||
      challengeDigest === null ||
      (record.attestationDigest !== null && attestationDigest === null) ||
      (record.bundleDigest !== null && bundleDigest === null) ||
      recordedAt === null ||
      !actionClaimsValid
    )
      return;
    parseCanonicalDate(recordedAt, `${itemPath}.recordedAt`, issues);
    actions.push({
      sequence,
      action: record.action,
      challengeId,
      challengeDigest,
      attestationDigest,
      bundleDigest,
      recordedAt
    });
  });
  return actions.length === value.length ? actions : null;
}

function parsePreRunBinding(
  value: unknown,
  path: string,
  issues: string[]
): C137AuthorityPreRunBindingV1 | null {
  const keys = [
    "protocolDigest",
    "manifestDigest",
    "datasetVersion",
    "certificationClass",
    "blindPlanDigest",
    "performancePlanDigest",
    "environmentDigest",
    "runnerBuildDigest",
    "runnerParametersDigest"
  ];
  const record = strictRecord(value, path, keys, issues);
  if (record === null) return null;
  const protocolDigest = requireDigest(record.protocolDigest, `${path}.protocolDigest`, issues);
  const manifestDigest = requireDigest(record.manifestDigest, `${path}.manifestDigest`, issues);
  const datasetVersion = requireString(record.datasetVersion, `${path}.datasetVersion`, issues);
  const blindPlanDigest = requireDigest(
    record.blindPlanDigest,
    `${path}.blindPlanDigest`,
    issues
  );
  const performancePlanDigest = requireDigest(
    record.performancePlanDigest,
    `${path}.performancePlanDigest`,
    issues
  );
  const environmentDigest = requireDigest(
    record.environmentDigest,
    `${path}.environmentDigest`,
    issues
  );
  const runnerBuildDigest = requireDigest(
    record.runnerBuildDigest,
    `${path}.runnerBuildDigest`,
    issues
  );
  const runnerParametersDigest = requireDigest(
    record.runnerParametersDigest,
    `${path}.runnerParametersDigest`,
    issues
  );
  if (
    protocolDigest === null ||
    manifestDigest === null ||
    datasetVersion === null ||
    (record.certificationClass !== "synthetic-smoke" &&
      record.certificationClass !== "real-development" &&
      record.certificationClass !== "real-frozen") ||
    blindPlanDigest === null ||
    performancePlanDigest === null ||
    environmentDigest === null ||
    runnerBuildDigest === null ||
    runnerParametersDigest === null
  )
    return null;
  return {
    protocolDigest,
    manifestDigest,
    datasetVersion,
    certificationClass: record.certificationClass,
    blindPlanDigest,
    performancePlanDigest,
    environmentDigest,
    runnerBuildDigest,
    runnerParametersDigest
  };
}

function parsePostRunBinding(
  value: unknown,
  path: string,
  issues: string[]
): C137AuthorityPostRunBindingV1 | null {
  const record = strictRecord(
    value,
    path,
    [
      "protocolDigest",
      "manifestDigest",
      "datasetVersion",
      "certificationClass",
      "blindPlanDigest",
      "performancePlanDigest",
      "environmentDigest",
      "runnerBuildDigest",
      "runnerParametersDigest",
      "bundleDigest",
      "blindProvenanceDigest",
      "performanceEvidenceDigest",
      "nativeExecutableDigest"
    ],
    issues
  );
  if (record === null) return null;
  const pre = parsePreRunBinding(
    Object.fromEntries(
      Object.entries(record).filter(
        ([key]) =>
          ![
            "bundleDigest",
            "blindProvenanceDigest",
            "performanceEvidenceDigest",
            "nativeExecutableDigest"
          ].includes(key)
      )
    ),
    path,
    issues
  );
  const bundleDigest = requireDigest(record.bundleDigest, `${path}.bundleDigest`, issues);
  const blindProvenanceDigest = requireDigest(
    record.blindProvenanceDigest,
    `${path}.blindProvenanceDigest`,
    issues
  );
  const performanceEvidenceDigest = requireDigest(
    record.performanceEvidenceDigest,
    `${path}.performanceEvidenceDigest`,
    issues
  );
  const nativeExecutableDigest = requireDigest(
    record.nativeExecutableDigest,
    `${path}.nativeExecutableDigest`,
    issues
  );
  if (
    pre === null ||
    bundleDigest === null ||
    blindProvenanceDigest === null ||
    performanceEvidenceDigest === null ||
    nativeExecutableDigest === null
  )
    return null;
  return {
    ...pre,
    bundleDigest,
    blindProvenanceDigest,
    performanceEvidenceDigest,
    nativeExecutableDigest
  };
}

function parseCommonAuthorityFields(
  record: Record<string, unknown>,
  path: string,
  issues: string[]
): { authorityId: string; ledgerId: string; authorityKeyId: C137Digest } | null {
  const authorityId = requireIdentifier(record.authorityId, `${path}.authorityId`, issues);
  const ledgerId = requireIdentifier(record.ledgerId, `${path}.ledgerId`, issues);
  const authorityKeyId = requireDigest(record.authorityKeyId, `${path}.authorityKeyId`, issues);
  return authorityId === null || ledgerId === null || authorityKeyId === null
    ? null
    : { authorityId, ledgerId, authorityKeyId };
}

function strictRecord(
  value: unknown,
  path: string,
  keys: readonly string[],
  issues: string[]
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push(`${path} 必须是对象。`);
    return null;
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (!equalJson(actual, expected))
    issues.push(`${path} 字段必须精确为 ${expected.join(",")}。`);
  return record;
}

function requireIdentifier(value: unknown, path: string, issues: string[]): string | null {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    issues.push(`${path} 必须是规范标识符。`);
    return null;
  }
  return value;
}

function requireString(value: unknown, path: string, issues: string[]): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    issues.push(`${path} 必须是有界非空字符串。`);
    return null;
  }
  return value;
}

function requireDigest(value: unknown, path: string, issues: string[]): C137Digest | null {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    issues.push(`${path} 必须是规范 SHA-256。`);
    return null;
  }
  return value as C137Digest;
}

function requireBase64Url(
  value: unknown,
  path: string,
  expectedLength: number,
  issues: string[]
): string | null {
  if (typeof value !== "string" || value.length !== expectedLength || !BASE64_URL.test(value)) {
    issues.push(`${path} 必须是无填充 base64url。`);
    return null;
  }
  return value;
}

function requireSafeInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  issues: string[]
): number | null {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    issues.push(`${path} 必须是 ${minimum}..${maximum} 的安全整数。`);
    return null;
  }
  return value as number;
}

function parseCanonicalDate(value: string, path: string, issues: string[]): Date | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    issues.push(`${path} 必须是 canonical UTC ISO-8601。`);
    return null;
  }
  return date;
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBufferSource(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}

function equalJson(left: unknown, right: unknown): boolean {
  return computeC137CanonicalDigest(left) === computeC137CanonicalDigest(right);
}

function emptyVerification(issues: string[]): C137AuthorityProofVerification {
  return {
    valid: false,
    issues,
    authorityKeyId: null,
    challengeDigest: null,
    attestationDigest: null,
    checkpointDigest: null
  };
}
