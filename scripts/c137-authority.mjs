import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIGNATURE_ALGORITHM = "ecdsa-p256-sha256-ieee-p1363";
const MAX_LEDGER_ACTIONS = 100_000;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

main().catch((error) => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const [command, ...tokens] = process.argv.slice(2);
  const options = parseOptions(tokens);
  if (command === "init") return initAuthority(options);
  if (command === "issue") return issueChallenge(options);
  if (command === "attest") return attestBundle(options);
  if (command === "verify") return verifyProofCommand(options);
  throw new Error("用法：node scripts/c137-authority.mjs <init|issue|attest|verify> --参数 值");
}

async function initAuthority(options) {
  const privateKeyPath = requirePath(options, "private-key");
  assertPrivateKeyOutsideProject(privateKeyPath);
  const policyPath = requirePath(options, "policy");
  const ledgerPath = requirePath(options, "ledger");
  const authorityId = requireIdentifier(options, "authority-id");
  const ledgerId = requireIdentifier(options, "ledger-id");
  await assertAbsent(privateKeyPath);
  await assertAbsent(policyPath);
  await assertAbsent(ledgerPath);

  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1"
  });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicJwk = publicKey.export({ format: "jwk" });
  if (
    publicJwk.kty !== "EC" ||
    publicJwk.crv !== "P-256" ||
    typeof publicJwk.x !== "string" ||
    typeof publicJwk.y !== "string"
  ) {
    throw new Error("无法导出 P-256 authority public JWK。");
  }
  const publicKeyValue = {
    kty: "EC",
    crv: "P-256",
    x: publicJwk.x,
    y: publicJwk.y
  };
  const authorityKeyId = digest({
    domain: "c137-authority-public-key-v1",
    key: publicKeyValue
  });
  const policy = {
    schemaVersion: 1,
    kind: "c137-authority-trust-policy",
    authorityId,
    ledgerId,
    authorityKeyId,
    publicKey: publicKeyValue,
    minimumLedgerSequence: 0,
    requiredCheckpointDigest: null
  };
  const ledger = {
    schemaVersion: 1,
    kind: "c137-authority-ledger",
    authorityId,
    ledgerId,
    authorityKeyId,
    previousCheckpointDigest: null,
    actions: []
  };
  await writeExclusive(privateKeyPath, privatePem);
  await chmod(privateKeyPath, 0o600);
  await writeJsonExclusive(policyPath, policy);
  await writeJsonExclusive(ledgerPath, ledger);
  process.stdout.write(
    `${JSON.stringify({ status: "initialized", authorityKeyId, policyPath, ledgerPath })}\n`
  );
}

async function issueChallenge(options) {
  const privateKeyPath = requirePath(options, "private-key");
  assertPrivateKeyOutsideProject(privateKeyPath);
  const policyPath = requirePath(options, "policy");
  const ledgerPath = requirePath(options, "ledger");
  const bundlePath = requirePath(options, "bundle");
  const outputPath = requirePath(options, "out");
  const ttlMinutes = requireInteger(options, "ttl-minutes", 1, 24 * 60);
  await assertAbsent(outputPath);
  const policy = await readJson(policyPath);
  const ledger = await readJson(ledgerPath);
  const bundle = await readJson(bundlePath);
  validateAuthorityFiles(policy, ledger);
  const privateKey = await readPrivateKey(privateKeyPath, policy);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + ttlMinutes * 60_000);
  const sequence = ledger.actions.length + 1;
  if (sequence > MAX_LEDGER_ACTIONS) throw new Error("authority ledger 已达到动作上限。");
  const challengePayload = {
    schemaVersion: 1,
    kind: "c137-authority-challenge",
    authorityId: policy.authorityId,
    ledgerId: policy.ledgerId,
    authorityKeyId: policy.authorityKeyId,
    challengeId: `challenge-${randomBytes(16).toString("hex")}`,
    nonce: randomBytes(32).toString("base64url"),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    issuedLedgerSequence: sequence,
    binding: createPreRunBinding(bundle)
  };
  const challenge = signEnvelope(challengePayload, privateKey);
  const challengeDigest = digest(challengePayload);
  ledger.actions.push({
    sequence,
    action: "issued",
    challengeId: challengePayload.challengeId,
    challengeDigest,
    attestationDigest: null,
    bundleDigest: null,
    recordedAt: challengePayload.issuedAt
  });
  await writeJsonAtomic(ledgerPath, ledger);
  await writeJsonExclusive(outputPath, challenge);
  process.stdout.write(
    `${JSON.stringify({ status: "issued", challengeId: challengePayload.challengeId, challengeDigest, expiresAt: challengePayload.expiresAt })}\n`
  );
}

async function attestBundle(options) {
  const privateKeyPath = requirePath(options, "private-key");
  assertPrivateKeyOutsideProject(privateKeyPath);
  const policyPath = requirePath(options, "policy");
  const ledgerPath = requirePath(options, "ledger");
  const challengePath = requirePath(options, "challenge");
  const bundlePath = requirePath(options, "bundle");
  const outputPath = requirePath(options, "out");
  const validityDays = requireInteger(options, "valid-days", 1, 365);
  await assertAbsent(outputPath);
  const policy = await readJson(policyPath);
  const ledger = await readJson(ledgerPath);
  const challenge = await readJson(challengePath);
  const bundle = await readJson(bundlePath);
  validateAuthorityFiles(policy, ledger);
  validateEnvelope(challenge, "c137-authority-challenge", policy);
  const publicKey = createPublicKey({ key: { ...policy.publicKey }, format: "jwk" });
  if (!verifyEnvelope(challenge, publicKey)) throw new Error("challenge authority 签名无效。");
  if (canonical(challenge.payload.binding) !== canonical(createPreRunBinding(bundle))) {
    throw new Error("challenge 预运行 binding 与完整 bundle 不一致。");
  }
  const now = new Date();
  if (
    now.getTime() < Date.parse(challenge.payload.issuedAt) ||
    now.getTime() > Date.parse(challenge.payload.expiresAt)
  ) {
    throw new Error("challenge 尚未生效或已经过期。");
  }
  const matchingActions = ledger.actions.filter(
    (action) => action.challengeId === challenge.payload.challengeId
  );
  if (
    matchingActions.length !== 1 ||
    matchingActions[0].action !== "issued" ||
    matchingActions[0].challengeDigest !== digest(challenge.payload)
  ) {
    throw new Error("challenge 未在当前 authority ledger 中处于唯一 issued 状态。");
  }
  const privateKey = await readPrivateKey(privateKeyPath, policy);
  const sequence = ledger.actions.length + 1;
  if (sequence > MAX_LEDGER_ACTIONS) throw new Error("authority ledger 已达到动作上限。");
  const attestationPayload = {
    schemaVersion: 1,
    kind: "c137-authority-attestation",
    authorityId: policy.authorityId,
    ledgerId: policy.ledgerId,
    authorityKeyId: policy.authorityKeyId,
    challengeId: challenge.payload.challengeId,
    challengeDigest: digest(challenge.payload),
    issuedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + validityDays * 86_400_000).toISOString(),
    consumedLedgerSequence: sequence,
    binding: createPostRunBinding(bundle)
  };
  const attestation = signEnvelope(attestationPayload, privateKey);
  ledger.actions.push({
    sequence,
    action: "consumed",
    challengeId: challenge.payload.challengeId,
    challengeDigest: attestationPayload.challengeDigest,
    attestationDigest: digest(attestationPayload),
    bundleDigest: attestationPayload.binding.bundleDigest,
    recordedAt: attestationPayload.issuedAt
  });
  const checkpointPayload = {
    schemaVersion: 1,
    kind: "c137-authority-ledger-checkpoint",
    authorityId: policy.authorityId,
    ledgerId: policy.ledgerId,
    authorityKeyId: policy.authorityKeyId,
    sequence,
    previousCheckpointDigest: ledger.previousCheckpointDigest,
    issuedAt: new Date().toISOString(),
    actionsDigest: digest(ledger.actions),
    actions: ledger.actions
  };
  const ledgerCheckpoint = signEnvelope(checkpointPayload, privateKey);
  const proof = {
    schemaVersion: 1,
    kind: "c137-authority-proof",
    challenge,
    attestation,
    ledgerCheckpoint
  };
  ledger.previousCheckpointDigest = digest(checkpointPayload);
  const temporaryProofPath = `${outputPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeJsonExclusive(temporaryProofPath, proof);
  try {
    await writeJsonAtomic(ledgerPath, ledger);
    await rename(temporaryProofPath, outputPath);
  } catch (error) {
    throw new Error(`authority ledger/proof 原子提交失败：${safeError(error)}`);
  }
  process.stdout.write(
    `${JSON.stringify({ status: "attested", challengeId: challenge.payload.challengeId, attestationDigest: digest(attestationPayload), checkpointDigest: digest(checkpointPayload) })}\n`
  );
}

async function verifyProofCommand(options) {
  const policy = await readJson(requirePath(options, "policy"));
  const proof = await readJson(requirePath(options, "proof"));
  const bundle = await readJson(requirePath(options, "bundle"));
  const minimumSequence =
    options.get("minimum-sequence") === undefined
      ? policy.minimumLedgerSequence
      : requireInteger(options, "minimum-sequence", 0, MAX_LEDGER_ACTIONS);
  const issues = verifyProof(bundle, proof, {
    ...policy,
    minimumLedgerSequence: minimumSequence
  });
  if (issues.length > 0) throw new Error(`authority proof 验证失败：${issues.join("；")}`);
  process.stdout.write(
    `${JSON.stringify({ status: "verified", authorityKeyId: policy.authorityKeyId, checkpointDigest: digest(proof.ledgerCheckpoint.payload) })}\n`
  );
}

function verifyProof(bundle, proof, policy) {
  const issues = [];
  try {
    if (proof.schemaVersion !== 1 || proof.kind !== "c137-authority-proof") {
      issues.push("proof schema/kind 无效");
      return issues;
    }
    const publicKey = createPublicKey({ key: { ...policy.publicKey }, format: "jwk" });
    for (const envelope of [proof.challenge, proof.attestation, proof.ledgerCheckpoint]) {
      validateEnvelope(envelope, envelope.payload.kind, policy);
      if (!verifyEnvelope(envelope, publicKey))
        issues.push(`${envelope.payload.kind} 签名无效`);
    }
    const challenge = proof.challenge.payload;
    const attestation = proof.attestation.payload;
    const checkpoint = proof.ledgerCheckpoint.payload;
    if (attestation.challengeDigest !== digest(challenge)) issues.push("challenge digest 漂移");
    if (canonical(challenge.binding) !== canonical(createPreRunBinding(bundle)))
      issues.push("pre-run binding 漂移");
    if (canonical(attestation.binding) !== canonical(createPostRunBinding(bundle)))
      issues.push("post-run binding 漂移");
    if (Date.parse(attestation.issuedAt) > Date.parse(challenge.expiresAt))
      issues.push("challenge 过期后签发");
    if (Date.now() > Date.parse(attestation.validUntil)) issues.push("attestation 已过期");
    if (
      checkpoint.sequence !== checkpoint.actions.length ||
      checkpoint.sequence < policy.minimumLedgerSequence
    )
      issues.push("ledger sequence 无效或回滚");
    if (digest(checkpoint.actions) !== checkpoint.actionsDigest)
      issues.push("ledger actions digest 无效");
    if (
      policy.requiredCheckpointDigest !== null &&
      digest(checkpoint) !== policy.requiredCheckpointDigest
    )
      issues.push("checkpoint 未命中固定摘要");
    const actions = checkpoint.actions.filter(
      (item) => item.challengeId === challenge.challengeId
    );
    const issued = actions.filter((item) => item.action === "issued");
    const consumed = actions.filter((item) => item.action === "consumed");
    if (issued.length !== 1 || consumed.length !== 1)
      issues.push("challenge 不是唯一 issued/consumed");
    if (
      consumed[0]?.attestationDigest !== digest(attestation) ||
      consumed[0]?.bundleDigest !== attestation.binding.bundleDigest
    )
      issues.push("consumed 动作未绑定 attestation/bundle");
  } catch (error) {
    issues.push(safeError(error));
  }
  return issues;
}

function createPreRunBinding(bundle) {
  requireDigestValue(bundle.manifestDigest, "bundle.manifestDigest");
  return {
    protocolDigest: digest(bundle.protocol),
    manifestDigest: bundle.manifestDigest,
    datasetVersion: requireStringValue(bundle.datasetVersion, "bundle.datasetVersion"),
    certificationClass: requireStringValue(
      bundle.certificationClass,
      "bundle.certificationClass"
    ),
    blindPlanDigest: requireDigestValue(
      bundle.protocol?.blindRankingPlanDigest,
      "blindRankingPlanDigest"
    ),
    performancePlanDigest: requireDigestValue(
      bundle.protocol?.performancePlanDigest,
      "performancePlanDigest"
    ),
    environmentDigest: requireDigestValue(bundle.environment?.digest, "environment.digest"),
    runnerBuildDigest: requireDigestValue(bundle.runner?.buildDigest, "runner.buildDigest"),
    runnerParametersDigest: requireDigestValue(
      bundle.runner?.parametersDigest,
      "runner.parametersDigest"
    )
  };
}

function createPostRunBinding(bundle) {
  const provenance = bundle.formalEvidence?.blindRelationship;
  const performance = bundle.reports?.performance;
  if (!provenance || !performance)
    throw new Error("bundle 缺少 formal blind 或 performance evidence。");
  const nativeDigests = new Set();
  for (const batch of provenance.batches ?? []) {
    for (const outcome of batch.nativeReceipt?.pairOutcomes ?? []) {
      const value = outcome.relationRanking?.executionIdentity?.nativeExecutableDigest;
      if (value) nativeDigests.add(requireDigestValue(value, "nativeExecutableDigest"));
    }
  }
  if (nativeDigests.size !== 1)
    throw new Error("bundle 必须只有一个 native executable digest。");
  return {
    ...createPreRunBinding(bundle),
    bundleDigest: digest(bundle),
    blindProvenanceDigest: requireDigestValue(provenance.provenanceDigest, "provenanceDigest"),
    performanceEvidenceDigest: requireDigestValue(
      performance.rawEvidence?.evidenceDigest,
      "performance evidenceDigest"
    ),
    nativeExecutableDigest: [...nativeDigests][0]
  };
}

function signEnvelope(payload, privateKey) {
  return {
    payload,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signature: sign("sha256", Buffer.from(digest(payload)), {
      key: privateKey,
      dsaEncoding: "ieee-p1363"
    }).toString("base64url")
  };
}

function verifyEnvelope(envelope, publicKey) {
  return verify(
    "sha256",
    Buffer.from(digest(envelope.payload)),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(envelope.signature, "base64url")
  );
}

function validateEnvelope(envelope, kind, policy) {
  if (
    !envelope ||
    envelope.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
    typeof envelope.signature !== "string" ||
    envelope.payload?.kind !== kind
  )
    throw new Error(`${kind} envelope 无效。`);
  if (
    envelope.payload.authorityId !== policy.authorityId ||
    envelope.payload.ledgerId !== policy.ledgerId ||
    envelope.payload.authorityKeyId !== policy.authorityKeyId
  )
    throw new Error(`${kind} 未绑定 trust policy。`);
}

function validateAuthorityFiles(policy, ledger) {
  if (policy.schemaVersion !== 1 || policy.kind !== "c137-authority-trust-policy")
    throw new Error("authority policy 无效。");
  if (
    ledger.schemaVersion !== 1 ||
    ledger.kind !== "c137-authority-ledger" ||
    ledger.authorityId !== policy.authorityId ||
    ledger.ledgerId !== policy.ledgerId ||
    ledger.authorityKeyId !== policy.authorityKeyId ||
    !Array.isArray(ledger.actions) ||
    ledger.actions.length > MAX_LEDGER_ACTIONS
  )
    throw new Error("authority ledger 与 policy 不一致。");
}

async function readPrivateKey(path, policy) {
  const key = createPrivateKey(await readFile(path, "utf8"));
  const publicJwk = createPublicKey(key).export({ format: "jwk" });
  const keyId = digest({
    domain: "c137-authority-public-key-v1",
    key: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y }
  });
  if (keyId !== policy.authorityKeyId)
    throw new Error("private key 不属于当前 authority policy。");
  return key;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON 不接受非有限数。");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  throw new Error("canonical JSON 不接受该值。");
}

function parseOptions(tokens) {
  const values = new Map();
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--"))
      throw new Error("参数必须使用 --名称 值。\n");
    const name = key.slice(2);
    if (values.has(name)) throw new Error(`参数 --${name} 重复。`);
    values.set(name, value);
  }
  return values;
}

function requirePath(options, name) {
  const value = options.get(name);
  if (!value) throw new Error(`缺少 --${name}。`);
  return resolve(value);
}

function assertPrivateKeyOutsideProject(path) {
  const relativePath = relative(PROJECT_ROOT, path);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    throw new Error("authority private key 必须保存在项目仓库之外。");
  }
}

function requireIdentifier(options, name) {
  const value = options.get(name);
  if (!value || !IDENTIFIER.test(value)) throw new Error(`--${name} 必须是规范标识符。`);
  return value;
}

function requireInteger(options, name, minimum, maximum) {
  const value = Number(options.get(name));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`--${name} 必须是 ${minimum}..${maximum} 的整数。`);
  return value;
}

function requireDigestValue(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value))
    throw new Error(`${label} 必须是规范 SHA-256。`);
  return value;
}

function requireStringValue(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096)
    throw new Error(`${label} 必须是有界非空字符串。`);
  return value;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonExclusive(path, value) {
  await writeExclusive(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeExclusive(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, { encoding: "utf8", flag: "wx" });
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  await rename(temporaryPath, path);
}

async function assertAbsent(path) {
  try {
    await access(path, fsConstants.F_OK);
  } catch {
    return;
  }
  throw new Error(`拒绝覆盖现有文件：${path}`);
}

function safeError(error) {
  return error instanceof Error ? error.message : "unknown authority failure";
}
