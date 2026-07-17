import {
  verifyC137AuthorityProof,
  type C137AuthorityProofV1,
  type C137AuthorityTrustPolicyV1
} from "./c137Authority";
import {
  computeC137CanonicalDigest,
  type C137AcceptanceBundle,
  type C137Digest
} from "./c137Acceptance";
import {
  createC137AuthorityProofFixture,
  signC137AuthorityEnvelope
} from "../../test/c137Authority";

describe("C137 external authority proof", () => {
  it("验证外部 P-256 签名、一次性 challenge、有效期和连续 replay ledger", async () => {
    const fixture = await createAuthorityFixture();

    const result = await verifyC137AuthorityProof(
      fixture.bundle,
      fixture.proof,
      fixture.policy,
      new Date("2026-07-17T01:15:00.000Z")
    );

    expect(result).toMatchObject({ valid: true, issues: [] });
    expect(result.authorityKeyId).toBe(fixture.policy.authorityKeyId);
  });

  it("bundle 在签发后变化时即使内部自摘要一起重写也不能复用 authority proof", async () => {
    const fixture = await createAuthorityFixture();
    const tampered = structuredClone(fixture.bundle);
    tampered.runner.parametersDigest = digest("9");

    const result = await verifyC137AuthorityProof(
      tampered,
      fixture.proof,
      fixture.policy,
      new Date("2026-07-17T01:15:00.000Z")
    );

    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toContain("预运行 binding");
    expect(result.issues.join("\n")).toContain("运行后 binding");
  });

  it("调用方自建另一把有效密钥不能命中外部固定 trust policy", async () => {
    const fixture = await createAuthorityFixture();
    const attacker = await createAuthorityFixture();

    const result = await verifyC137AuthorityProof(
      fixture.bundle,
      attacker.proof,
      fixture.policy,
      new Date("2026-07-17T01:15:00.000Z")
    );

    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toMatch(/trust policy|签名无效/);
  });

  it("拒绝过期 attestation、重复 consumed 和跨 bundle ledger 重放", async () => {
    const fixture = await createAuthorityFixture();
    const expired = await verifyC137AuthorityProof(
      fixture.bundle,
      fixture.proof,
      fixture.policy,
      new Date("2026-08-18T01:00:00.000Z")
    );
    expect(expired.valid).toBe(false);
    expect(expired.issues).toContain("authority attestation 已过期。");

    const replayProof = structuredClone(fixture.proof);
    const consumed = replayProof.ledgerCheckpoint.payload.actions[1];
    if (consumed === undefined) throw new Error("missing consumed action");
    replayProof.ledgerCheckpoint.payload.actions.push({
      ...consumed,
      sequence: 3,
      bundleDigest: digest("8")
    });
    replayProof.ledgerCheckpoint.payload.sequence = 3;
    replayProof.ledgerCheckpoint.payload.actionsDigest = computeC137CanonicalDigest(
      replayProof.ledgerCheckpoint.payload.actions
    );
    replayProof.ledgerCheckpoint = await signC137AuthorityEnvelope(
      replayProof.ledgerCheckpoint.payload,
      fixture.privateKey
    );

    const replay = await verifyC137AuthorityProof(
      fixture.bundle,
      replayProof,
      fixture.policy,
      new Date("2026-07-17T01:15:00.000Z")
    );
    expect(replay.valid).toBe(false);
    expect(replay.issues.join("\n")).toContain("一次 consumed");
  });

  it("拒绝回滚到低于外部最低序列或未命中固定 checkpoint 的旧账本", async () => {
    const fixture = await createAuthorityFixture();
    const strictPolicy: C137AuthorityTrustPolicyV1 = {
      ...fixture.policy,
      minimumLedgerSequence: 3,
      requiredCheckpointDigest: digest("f")
    };

    const result = await verifyC137AuthorityProof(
      fixture.bundle,
      fixture.proof,
      strictPolicy,
      new Date("2026-07-17T01:15:00.000Z")
    );

    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toContain("最低序列");
    expect(result.issues.join("\n")).toContain("外部固定摘要");
  });
});

async function createAuthorityFixture(): Promise<{
  bundle: C137AcceptanceBundle;
  proof: C137AuthorityProofV1;
  policy: C137AuthorityTrustPolicyV1;
  privateKey: CryptoKey;
}> {
  const bundle = createMinimalBundle();
  return { bundle, ...(await createC137AuthorityProofFixture(bundle)) };
}

function createMinimalBundle(): C137AcceptanceBundle {
  const nativeExecutableDigest = digest("a");
  return {
    schemaVersion: 4,
    kind: "c137-acceptance-bundle",
    manifestDigest: digest("1"),
    datasetVersion: "frozen-v1",
    certificationClass: "real-frozen",
    protocol: {
      blindRankingPlanDigest: digest("2"),
      performancePlanDigest: digest("3")
    },
    environment: { digest: digest("4") },
    runner: { buildDigest: digest("5"), parametersDigest: digest("6") },
    receipts: {},
    formalEvidence: {
      blindRelationship: {
        provenanceDigest: digest("7"),
        batches: [
          {
            nativeReceipt: {
              pairOutcomes: [
                {
                  relationRanking: {
                    executionIdentity: { nativeExecutableDigest }
                  }
                }
              ]
            }
          }
        ]
      }
    },
    reports: {
      performance: { rawEvidence: { evidenceDigest: digest("8") } }
    }
  } as unknown as C137AcceptanceBundle;
}

function digest(character: string): C137Digest {
  return `sha256:${character.repeat(64)}`;
}
