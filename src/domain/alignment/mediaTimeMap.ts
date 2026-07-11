import type {
  CompactMediaTimeMapEvidence,
  MediaContentIdentity,
  MediaTimeMap,
  MediaTimeMapQuality,
  MediaTimeMapState,
  MediaTimeMapVerificationRecord,
  SegmentTimingRule
} from "../project/types";
import { areMediaContentIdentitiesEqual, cloneMediaContentIdentity } from "../project/mediaIdentity";
import type { Milliseconds } from "../shared/time";
import {
  migrateLegacyTimeMap,
  reconcileTimeMapQualityClaim,
  type TimeMapQualityInput,
  type TimeMapSpan
} from "./timeMap";

export const LEGACY_ALIGNMENT_ENGINE_VERSION = "legacy-v9";
export const LEGACY_ALIGNMENT_FEATURE_VERSION = "legacy-v9";

const TIME_MAP_CORE_DIGEST_PREFIX = "fnv1a64";
const VERIFICATION_RECORD_REQUIRED_REASON =
  "缺少与当前时间图核心、revision 和媒体身份绑定的可信验证记录；已阻断“已验证”资格，必须重新校准或完成明确人工复核。";

/**
 * 受信自动校准产物必须随应用代码发布。C137 尚无真实金标准 calibration，
 * 因而当前白名单有意保持为空，Alignment V2 最多只能进入 review。
 */
const TRUSTED_AUTOMATIC_CALIBRATION_ARTIFACTS: readonly {
  id: string;
  version: string;
}[] = [];

/** JSON 反序列化无法恢复 WeakSet 身份，因此手写/导入的 manual record 永不自动受信。 */
const domainIssuedManualVerificationRecords = new WeakSet<MediaTimeMapVerificationRecord>();

export interface ManualMediaTimeMapVerificationInput {
  calibrationArtifactId: string;
  calibrationArtifactVersion: string;
  verifier: string;
  verifiedAt: string;
}

export interface MediaTimeMapVerificationAssessment {
  trusted: boolean;
  reason: string | null;
}

export interface LegacyMediaTimeMapInput {
  id: string;
  sourceMediaId: string;
  targetMediaId: string;
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetStartMs: Milliseconds;
  expectedTargetEndMs: Milliseconds | null;
  timingRules: readonly SegmentTimingRule[];
  state: MediaTimeMapState;
  timestamp: string;
  coverage: number | null;
  anchorCount: number;
}

/**
 * 把旧引擎的“段首 + 累计 gap”封装成显式时间图。
 * 该函数只负责无损迁移，结果永远不会被标为 verified。
 */
export function createLegacyMediaTimeMap(input: LegacyMediaTimeMapInput): MediaTimeMap {
  const migration = migrateLegacyTimeMap({
    sourceStartMs: input.sourceStartMs,
    sourceEndMs: input.sourceEndMs,
    targetStartMs: input.targetStartMs,
    timingRules: input.timingRules
  });
  const migratedSpans = [...migration.spans];
  const migratedEnd = migratedSpans.at(-1);
  const expectedRangeMismatch =
    input.expectedTargetEndMs !== null &&
    (!migratedEnd || migratedEnd.targetEndMs !== input.expectedTargetEndMs);
  const blocked = migration.status === "blocked" || expectedRangeMismatch;
  const spans: TimeMapSpan[] = blocked
    ? [
        {
          kind: "ambiguous",
          sourceStartMs: input.sourceStartMs,
          sourceEndMs: input.sourceEndMs,
          targetStartMs: input.targetStartMs,
          targetEndMs:
            input.expectedTargetEndMs ?? migratedEnd?.targetEndMs ?? input.targetStartMs
        }
      ]
    : migratedSpans;
  const finalSpan = spans.at(-1);
  const reasons = ["由旧阶跃规则迁移，未经真实媒体重新分析或精度验证。"];
  migration.issues.forEach((issue) => reasons.push(issue.message));
  if (expectedRangeMismatch) {
    reasons.push("旧候选声明的目标范围与 timingRules 推导范围不一致，已阻断并标记为 ambiguous。");
  }

  return {
    id: input.id,
    revision: 1,
    sourceMediaId: input.sourceMediaId,
    targetMediaId: input.targetMediaId,
    sourceStream: null,
    targetStream: null,
    sourceIdentity: null,
    targetIdentity: null,
    sourceStartMs: input.sourceStartMs,
    sourceEndMs: input.sourceEndMs,
    targetStartMs: input.targetStartMs,
    targetEndMs: finalSpan?.targetEndMs ?? input.targetStartMs,
    spans,
    quality: {
      level: blocked ? "blocked" : "legacy-unverified",
      probability: null,
      metricSource: input.coverage === null ? "missing" : "estimated",
      coverage: input.coverage,
      p50ResidualMs: null,
      p95ResidualMs: null,
      maxResidualMs: null,
      boundaryUncertaintyMs: null,
      alternativeMargin: null,
      anchorCount: input.anchorCount,
      heldOutAnchorCount: 0,
      reasons
    },
    evidence: {
      types: ["legacy"],
      audioAnchorCount: 0,
      visualAnchorCount: 0,
      heldOutAnchorCount: 0,
      notes: reasons
    },
    verification: null,
    engineVersion: LEGACY_ALIGNMENT_ENGINE_VERSION,
    featureVersion: LEGACY_ALIGNMENT_FEATURE_VERSION,
    parametersHash: `${LEGACY_ALIGNMENT_ENGINE_VERSION}:${input.id}`,
    state: input.state,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    confirmedAt: input.state === "candidate" ? null : input.timestamp
  };
}

export function createCandidateTimeMapId(candidateId: string): string {
  return `${candidateId}:time-map:candidate`;
}

export function createConfirmedTimeMapId(candidateId: string, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RangeError("时间图 revision 必须是正整数。");
  }
  return `${candidateId}:time-map:confirmed:${revision}`;
}

/**
 * 对正式映射核心生成稳定摘要。固定顺序的数组编码避免对象键顺序影响结果；质量等级、
 * 原因和备注不参与摘要，但所有会影响映射、校准判断或证据完整性的字段都会参与。
 */
export function computeMediaTimeMapCoreDigest(map: MediaTimeMap): string {
  const canonical = JSON.stringify([
    "media-time-map-core-v1",
    map.id,
    map.revision,
    map.sourceMediaId,
    map.targetMediaId,
    canonicalStreamIdentity(map.sourceStream),
    canonicalStreamIdentity(map.targetStream),
    canonicalContentIdentity(map.sourceIdentity),
    canonicalContentIdentity(map.targetIdentity),
    map.sourceStartMs,
    map.sourceEndMs,
    map.targetStartMs,
    map.targetEndMs,
    map.spans.map((span) => [
      span.kind,
      span.sourceStartMs,
      span.sourceEndMs,
      span.targetStartMs,
      span.targetEndMs
    ]),
    canonicalQualityMetrics(map.quality),
    canonicalEvidence(map.evidence),
    map.engineVersion,
    map.featureVersion,
    map.parametersHash
  ]);
  return `${TIME_MAP_CORE_DIGEST_PREFIX}:${fnv1a64(canonical)}`;
}

/** 检查 record 是否仍精确绑定当前 map，并且其签发来源受信。 */
export function assessMediaTimeMapVerification(
  map: MediaTimeMap
): MediaTimeMapVerificationAssessment {
  const record = map.verification;
  if (!record) {
    return { trusted: false, reason: VERIFICATION_RECORD_REQUIRED_REASON };
  }
  if (map.state !== "confirmed") {
    return {
      trusted: false,
      reason: "验证记录只能绑定 state=confirmed 的正式时间图，候选或已替代 revision 不能保持已验证资格。"
    };
  }
  if (record.mapRevision !== map.revision) {
    return {
      trusted: false,
      reason: "验证记录绑定的 revision 与当前时间图不一致，必须重新验证。"
    };
  }
  if (
    !map.sourceIdentity ||
    !map.targetIdentity ||
    !areMediaContentIdentitiesEqual(record.sourceIdentity, map.sourceIdentity) ||
    !areMediaContentIdentitiesEqual(record.targetIdentity, map.targetIdentity)
  ) {
    return {
      trusted: false,
      reason: "验证记录绑定的源/目标媒体身份与当前时间图不一致，必须重新分析。"
    };
  }
  if (record.mapCoreDigest !== computeMediaTimeMapCoreDigest(map)) {
    return {
      trusted: false,
      reason: "验证记录的核心摘要与当前时间图范围、spans、指标或引擎 provenance 不一致。"
    };
  }
  if (record.method === "automatic-calibration") {
    const trustedArtifact = TRUSTED_AUTOMATIC_CALIBRATION_ARTIFACTS.some(
      (artifact) =>
        artifact.id === record.calibrationArtifactId &&
        artifact.version === record.calibrationArtifactVersion
    );
    return trustedArtifact
      ? { trusted: true, reason: null }
      : {
          trusted: false,
          reason: "自动验证所声明的 calibration artifact/version 不在应用内置受信列表中。"
        };
  }
  if (!domainIssuedManualVerificationRecords.has(record)) {
    return {
      trusted: false,
      reason: "人工验证记录不是由本次运行的明确领域复核函数签发，导入 JSON 不能自动取得可信状态。"
    };
  }
  return { trusted: true, reason: null };
}

/**
 * 人工复核唯一签发入口。当前 UI 尚未接入该闭环；调用方必须先提供完整 manual 证据和
 * 达标实测指标。记录在序列化后不会自动恢复运行时信任，避免任意 JSON 冒充人工签发。
 */
export function applyManualMediaTimeMapVerification(
  map: MediaTimeMap,
  input: ManualMediaTimeMapVerificationInput
): MediaTimeMap {
  if (map.state !== "confirmed") {
    throw new Error("只能人工验证 state=confirmed 的正式时间图。");
  }
  const sourceIdentity = map.sourceIdentity;
  const targetIdentity = map.targetIdentity;
  if (!sourceIdentity || !targetIdentity) {
    throw new Error("人工验证前必须记录源文件与目标文件的内容身份。");
  }
  if (!map.evidence.types.includes("manual")) {
    throw new Error("人工验证前必须先写入真实 manual 复核证据。");
  }
  for (const [label, value] of [
    ["calibrationArtifactId", input.calibrationArtifactId],
    ["calibrationArtifactVersion", input.calibrationArtifactVersion],
    ["verifier", input.verifier],
    ["verifiedAt", input.verifiedAt]
  ] as const) {
    if (value.trim().length === 0) {
      throw new Error(`人工验证字段 ${label} 不能为空。`);
    }
  }
  const declaredVerified: MediaTimeMap = {
    ...map,
    quality: { ...map.quality, level: "verified" },
    verification: null
  };
  const central = reconcileTimeMapQualityClaim(
    "verified",
    declaredVerified.quality.reasons,
    toTimeMapQualityInput(declaredVerified)
  );
  if (central.assessment.level !== "verified") {
    throw new Error("时间图的实测指标与独立证据尚未达到中央 verified 门槛。");
  }
  const record: MediaTimeMapVerificationRecord = {
    recordVersion: 1,
    method: "manual-review",
    mapCoreDigest: computeMediaTimeMapCoreDigest(declaredVerified),
    mapRevision: declaredVerified.revision,
    sourceIdentity: cloneRequiredIdentity(sourceIdentity),
    targetIdentity: cloneRequiredIdentity(targetIdentity),
    calibrationArtifactId: input.calibrationArtifactId,
    calibrationArtifactVersion: input.calibrationArtifactVersion,
    verifier: input.verifier,
    verifiedAt: input.verifiedAt
  };
  domainIssuedManualVerificationRecords.add(record);
  return reconcileMediaTimeMapQuality({ ...declaredVerified, verification: record });
}

/** 对持久化或外部输入的质量声明执行中央重算，且绝不自动提高声明等级。 */
export function reconcileMediaTimeMapQuality(map: MediaTimeMap): MediaTimeMap {
  const reconciliation = reconcileTimeMapQualityClaim(
    map.quality.level,
    map.quality.reasons,
    toTimeMapQualityInput(map)
  );
  const missingIdentity = map.sourceIdentity === null || map.targetIdentity === null;
  let level = reconciliation.level === "verified" && missingIdentity
    ? "blocked"
    : reconciliation.level;
  const reasons = [...reconciliation.reasons];
  if (level === "blocked" && reconciliation.level === "verified" && missingIdentity) {
    reasons.push("时间图缺少源文件或目标文件的内容身份快照，不能确认它仍对应当前媒体文件。");
  }
  if (map.quality.level === "verified") {
    const verification = assessMediaTimeMapVerification(map);
    if (!verification.trusted && level === "verified") {
      level = "review";
    }
    if (!verification.trusted && verification.reason) {
      reasons.push(verification.reason);
    }
  }
  return {
    ...map,
    verification: level === "legacy-unverified" ? null : (map.verification ?? null),
    quality: {
      ...map.quality,
      level,
      reasons: uniqueReasons(reasons)
    }
  };
}

export function confirmCandidateTimeMap(
  candidateMap: MediaTimeMap,
  id: string,
  revision: number,
  timestamp: string
): MediaTimeMap {
  if (candidateMap.state !== "candidate") {
    throw new Error("只能从候选时间图创建确认 revision。");
  }
  return {
    ...structuredClone(candidateMap),
    id,
    revision,
    verification: null,
    state: "confirmed",
    createdAt: timestamp,
    updatedAt: timestamp,
    confirmedAt: timestamp
  };
}

function toTimeMapQualityInput(map: MediaTimeMap): TimeMapQualityInput {
  return {
    probability: map.quality.probability,
    metricSource: map.quality.metricSource,
    coverage: map.quality.coverage,
    p50ResidualMs: map.quality.p50ResidualMs,
    p95ResidualMs: map.quality.p95ResidualMs,
    maxResidualMs: map.quality.maxResidualMs,
    boundaryUncertaintyMs: map.quality.boundaryUncertaintyMs,
    alternativeMargin: map.quality.alternativeMargin,
    anchorCount: map.quality.anchorCount,
    heldOutAnchorCount: map.quality.heldOutAnchorCount,
    evidenceTypes: map.evidence.types,
    audioAnchorCount: map.evidence.audioAnchorCount,
    visualAnchorCount: map.evidence.visualAnchorCount,
    evidenceHeldOutAnchorCount: map.evidence.heldOutAnchorCount,
    sourceStreamType: map.sourceStream?.type ?? null,
    targetStreamType: map.targetStream?.type ?? null
  };
}

function canonicalStreamIdentity(stream: MediaTimeMap["sourceStream"]): readonly unknown[] | null {
  return stream
    ? [
        stream.type,
        stream.index,
        stream.codec,
        stream.startMs,
        stream.timelineOffsetMs,
        stream.timeBase,
        stream.sampleRate,
        stream.channels,
        stream.frameRate,
        stream.language,
        stream.title
      ]
    : null;
}

function canonicalContentIdentity(identity: MediaContentIdentity | null): readonly unknown[] | null {
  return identity
    ? [
        identity.algorithm,
        identity.sizeBytes,
        identity.modifiedUnixMs,
        identity.firstSampleDigest,
        identity.middleSampleDigest,
        identity.lastSampleDigest
      ]
    : null;
}

function canonicalQualityMetrics(quality: MediaTimeMapQuality): readonly unknown[] {
  return [
    quality.probability,
    quality.metricSource,
    quality.coverage,
    quality.p50ResidualMs,
    quality.p95ResidualMs,
    quality.maxResidualMs,
    quality.boundaryUncertaintyMs,
    quality.alternativeMargin,
    quality.anchorCount,
    quality.heldOutAnchorCount
  ];
}

function canonicalEvidence(evidence: CompactMediaTimeMapEvidence): readonly unknown[] {
  return [
    [...evidence.types].sort(),
    evidence.audioAnchorCount,
    evidence.visualAnchorCount,
    evidence.heldOutAnchorCount
  ];
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function cloneRequiredIdentity(identity: MediaContentIdentity): MediaContentIdentity {
  return cloneMediaContentIdentity(identity) as MediaContentIdentity;
}

function uniqueReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons.map((reason) => reason.trim()).filter((reason) => reason.length > 0))];
}

export function supersedeMediaTimeMap(map: MediaTimeMap, timestamp: string): MediaTimeMap {
  if (map.state === "superseded") {
    return map;
  }
  if (map.state !== "confirmed") {
    throw new Error("只有已确认时间图可以被替代。");
  }
  return {
    ...map,
    state: "superseded",
    updatedAt: timestamp
  };
}
