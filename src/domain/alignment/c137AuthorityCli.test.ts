import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import type { C137AcceptanceBundle, C137Digest } from "./c137Acceptance";

describe("C137 authority external CLI", () => {
  it("拒绝把 authority 私钥写入项目仓库", () => {
    const result = runCli([
      "init",
      "--private-key",
      resolve("authority-private-do-not-create.pem"),
      "--policy",
      join(tmpdir(), "c137-policy-do-not-create.json"),
      "--ledger",
      join(tmpdir(), "c137-ledger-do-not-create.json"),
      "--authority-id",
      "c137-test-authority",
      "--ledger-id",
      "c137-test-ledger"
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("必须保存在项目仓库之外");
  });

  it("用仓库外私钥签发 challenge、原子消费 ledger、生成并验证 proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "c137-authority-"));
    try {
      const paths = {
        privateKey: join(root, "authority-private.pem"),
        policy: join(root, "authority-policy.json"),
        ledger: join(root, "authority-ledger.json"),
        bundle: join(root, "bundle.json"),
        challenge: join(root, "challenge.json"),
        proof: join(root, "proof.json"),
        replayProof: join(root, "replay-proof.json")
      };
      const nodeExecutableDigest: C137Digest = `sha256:${createHash("sha256")
        .update(await readFile(process.execPath))
        .digest("hex")}`;
      const inspected = runCli([
        "inspect-native",
        "--native-executable",
        process.execPath
      ]);
      if (inspected.status !== 0) throw new Error(inspected.stderr);
      const signerCertificateDigest = (
        JSON.parse(inspected.stdout) as { signerCertificateDigest: C137Digest }
      ).signerCertificateDigest;
      await writeFile(
        paths.bundle,
        `${JSON.stringify(createMinimalBundle(nodeExecutableDigest), null, 2)}\n`,
        "utf8"
      );

      expect(
        runCli([
          "init",
          "--private-key",
          paths.privateKey,
          "--policy",
          paths.policy,
          "--ledger",
          paths.ledger,
          "--authority-id",
          "c137-test-authority",
          "--ledger-id",
          "c137-test-ledger",
          "--native-signer-cert-sha256",
          signerCertificateDigest
        ]).status
      ).toBe(0);
      expect(
        runCli([
          "issue",
          "--private-key",
          paths.privateKey,
          "--policy",
          paths.policy,
          "--ledger",
          paths.ledger,
          "--bundle",
          paths.bundle,
          "--out",
          paths.challenge,
          "--ttl-minutes",
          "60"
        ]).status
      ).toBe(0);
      expect(
        runCli([
          "attest",
          "--private-key",
          paths.privateKey,
          "--policy",
          paths.policy,
          "--ledger",
          paths.ledger,
          "--challenge",
          paths.challenge,
          "--bundle",
          paths.bundle,
          "--native-executable",
          process.execPath,
          "--out",
          paths.proof,
          "--valid-days",
          "30"
        ]).status
      ).toBe(0);
      const verified = runCli([
        "verify",
        "--policy",
        paths.policy,
        "--proof",
        paths.proof,
        "--bundle",
        paths.bundle,
        "--native-executable",
        process.execPath,
        "--minimum-sequence",
        "2"
      ]);
      expect(verified.status).toBe(0);
      expect(verified.stdout).toContain('"status":"verified"');

      const ledger = JSON.parse(await readFile(paths.ledger, "utf8")) as {
        actions: Array<{ action: string }>;
      };
      expect(ledger.actions.map((item) => item.action)).toEqual(["issued", "consumed"]);

      const replay = runCli([
        "attest",
        "--private-key",
        paths.privateKey,
        "--policy",
        paths.policy,
        "--ledger",
        paths.ledger,
        "--challenge",
        paths.challenge,
        "--bundle",
        paths.bundle,
        "--native-executable",
        process.execPath,
        "--out",
        paths.replayProof,
        "--valid-days",
        "30"
      ]);
      expect(replay.status).not.toBe(0);
      expect(replay.stderr).toContain("唯一 issued 状态");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("未签名或签名损坏的 EXE 不能生成 native artifact attestation", async () => {
    const root = await mkdtemp(join(tmpdir(), "c137-unsigned-native-"));
    try {
      const unsignedPath = join(root, "unsigned.exe");
      await writeFile(unsignedPath, "not-an-authenticode-executable", "utf8");

      const result = runCli([
        "inspect-native",
        "--native-executable",
        unsignedPath
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Authenticode 状态不是 Valid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [resolve("scripts/c137-authority.mjs"), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function createMinimalBundle(nativeExecutableDigest: C137Digest): C137AcceptanceBundle {
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
