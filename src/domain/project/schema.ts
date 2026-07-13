import {
  CURRENT_SCHEMA_VERSION,
  type DanmakuSourceSegment,
  type EditorProject,
  type MediaBinding,
  type MediaMatchCandidate,
  type MediaTimeMap,
  type MediaTimeMapVerificationRecord,
  type ProjectMediaReference,
  type SegmentTimingRule,
  type ProjectValidationResult
} from "./types";
import {
  isCompleteTimeMapSpanEvidence,
  normalizeLegacyUnverifiedTimeMapSpanEvidence,
  validateTimeMap,
  type TimeMapSpan
} from "../alignment/timeMap";
import {
  createLegacyMediaTimeMap as createLegacyMediaTimeMapRecord,
  reconcileMediaTimeMapQuality
} from "../alignment/mediaTimeMap";
import {
  isAlignmentTimeMapProposal,
  reconcileAlignmentTimeMapProposalQuality
} from "../alignment/timeMapProposal";
import {
  createDanmakuSourceBinding,
  createMediaReferenceFromBinding,
  createMediaReferenceFromLegacyMedia,
  sanitizeMediaReferencesForSave
} from "./mediaLibrary";
import {
  cloneMediaContentIdentity,
  isMediaContentIdentity
} from "./mediaIdentity";

const MIN_SUPPORTED_SCHEMA_VERSION = 1;

export interface ProjectSchemaMigration {
  fromVersion: number;
  toVersion: number;
  adjustedClipRangeCount: number;
}

export interface ProjectParseResult {
  project: EditorProject;
  migration: ProjectSchemaMigration | null;
}

type LegacyDanmakuSourceSegment = Omit<DanmakuSourceSegment, "timeMapId"> & {
  timeMapId?: string | null;
};

type LegacyMediaMatchCandidate = Omit<
  MediaMatchCandidate,
  "timeMapId" | "confirmedTimeMapId"
> & {
  timeMapId?: string;
  confirmedTimeMapId?: string | null;
};

type LegacyMediaTimeMap = Omit<MediaTimeMap, "verification"> & {
  verification?: MediaTimeMapVerificationRecord | null;
};

type LegacyEditorProject = Omit<
  EditorProject,
  | "mediaLibrary"
  | "danmakuSourceBindings"
  | "danmakuSourceSegments"
  | "mediaMatchCandidates"
  | "mediaTimeMaps"
> & {
  mediaLibrary?: ProjectMediaReference[];
  danmakuSourceBindings?: EditorProject["danmakuSourceBindings"];
  danmakuSourceSegments: LegacyDanmakuSourceSegment[];
  mediaMatchCandidates?: LegacyMediaMatchCandidate[];
  mediaTimeMaps?: LegacyMediaTimeMap[];
};

interface MediaSchemaMigrationResult {
  mediaLibrary: ProjectMediaReference[];
  mediaBinding: MediaBinding | null;
  danmakuSourceBindings: EditorProject["danmakuSourceBindings"];
  defaultSourceMediaId: string | null;
  defaultTargetMediaId: string | null;
  defaultAssetId: string | null;
}

export function validateProjectSchema(value: unknown): ProjectValidationResult {
  if (!isRecord(value)) {
    return { ok: false, version: null, message: "项目文件不是有效对象。" };
  }
  const version = value.schemaVersion;
  if (typeof version !== "number") {
    return { ok: false, version: null, message: "项目文件缺少 schemaVersion。" };
  }
  if (version < MIN_SUPPORTED_SCHEMA_VERSION || version > CURRENT_SCHEMA_VERSION) {
    return {
      ok: false,
      version,
      message: `项目版本 ${version} 暂不支持，当前支持版本为 ${MIN_SUPPORTED_SCHEMA_VERSION} 到 ${CURRENT_SCHEMA_VERSION}。`
    };
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !isMediaReference(value.media) ||
    (version >= 7 && !isProjectMediaReferences(value.mediaLibrary)) ||
    (version >= 4 && !isMediaBindingOrNull(value.mediaBinding)) ||
    (version >= 5 && !isSeasonEpisodeBindings(value.seasonEpisodeBindings)) ||
    (version >= 7 && !isDanmakuSourceBindings(value.danmakuSourceBindings)) ||
    (version >= 6 && !isDanmakuSourceSegments(value.danmakuSourceSegments, version)) ||
    (version >= 9 && !isMediaMatchCandidates(value.mediaMatchCandidates, version)) ||
    (version >= 10 && !isMediaTimeMaps(value.mediaTimeMaps, version)) ||
    !Array.isArray(value.assets) ||
    !Array.isArray(value.clips) ||
    !isIntegerMilliseconds(value.globalOffsetMs) ||
    !Array.isArray(value.cutMarkers) ||
    !Array.isArray(value.syncAnchors) ||
    (version >= 3 && !isAlignmentProposalOrNull(value.alignmentProposal, version)) ||
    !isMillisecondsRecord(value.itemTimeAdjustments) ||
    !isStringArray(value.disabledItemIds) ||
    !isTimelineState(value.timeline) ||
    !isPreviewSettings(value.preview) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return { ok: false, version, message: "项目文件缺少必要字段。" };
  }
  if (!value.assets.every(isDanmakuAsset)) {
    return { ok: false, version, message: "项目文件中的弹幕资源结构不完整。" };
  }
  if (!value.clips.every(isDanmakuClip)) {
    return { ok: false, version, message: "项目文件中的时间轴片段结构不完整。" };
  }
  if (!value.cutMarkers.every(isCutMarker)) {
    return { ok: false, version, message: "项目文件中的版本差异结构不完整。" };
  }
  if (!value.syncAnchors.every(isSyncAnchor)) {
    return { ok: false, version, message: "项目文件中的同步锚点结构不完整。" };
  }
  if (version >= 10 && !hasValidTimeMapReferences(value as unknown as EditorProject)) {
    return { ok: false, version, message: "项目文件中的时间映射引用或范围不一致。" };
  }
  return { ok: true, version, message: "项目文件可打开。" };
}

export function parseProjectJson(json: string): EditorProject {
  return parseProjectJsonWithMetadata(json).project;
}

export function parseProjectJsonWithMetadata(json: string): ProjectParseResult {
  const parsed = JSON.parse(json) as unknown;
  const validation = validateProjectSchema(parsed);
  if (!validation.ok) {
    throw new Error(validation.message);
  }
  if (validation.version === null) {
    throw new Error("项目文件缺少 schemaVersion。");
  }
  return migrateProjectToCurrentSchema(parsed as LegacyEditorProject, validation.version);
}

export function serializeProject(project: EditorProject): string {
  const reconciledProject = repairStaleAcceptedCandidateReferences(
    reconcileProjectTimeMapQualities(project)
  );
  const savedMediaLibrary = sanitizeMediaReferencesForSave(reconciledProject.mediaLibrary);
  const savedProject: EditorProject = {
    ...reconciledProject,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    mediaLibrary: savedMediaLibrary,
    media: reconciledProject.media
      ? {
          ...reconciledProject.media,
          objectUrl: null
        }
      : null
  };
  const validation = validateProjectSchema(savedProject);
  if (!validation.ok) {
    throw new Error(`项目保存前验证失败：${validation.message}`);
  }
  return `${JSON.stringify(savedProject, null, 2)}\n`;
}

function repairStaleAcceptedCandidateReferences(project: EditorProject): EditorProject {
  const segmentsById = new Map(
    project.danmakuSourceSegments.map((segment) => [segment.id, segment])
  );
  const referencedTimeMapIds = new Set(
    project.danmakuSourceSegments.flatMap((segment) =>
      segment.timeMapId ? [segment.timeMapId] : []
    )
  );
  const supersededMapIds = new Set<string>();
  let changed = false;
  const mediaMatchCandidates = project.mediaMatchCandidates.map((candidate) => {
    if (candidate.state !== "accepted") {
      return candidate;
    }
    const appliedSegmentIds = candidate.appliedSegmentIds.filter((segmentId) => {
      const segment = segmentsById.get(segmentId);
      return (
        segment?.kind === "content" &&
        candidate.confirmedTimeMapId !== null &&
        segment.timeMapId === candidate.confirmedTimeMapId
      );
    });
    if (appliedSegmentIds.length > 0) {
      if (appliedSegmentIds.length === candidate.appliedSegmentIds.length) {
        return candidate;
      }
      changed = true;
      return { ...candidate, appliedSegmentIds };
    }
    if (candidate.confirmedTimeMapId) {
      supersededMapIds.add(candidate.confirmedTimeMapId);
    }
    const hasBoundAsset = project.danmakuSourceBindings.some(
      (binding) =>
        binding.sourceMediaId === candidate.sourceMediaId &&
        project.assets.some((asset) => asset.id === binding.assetId)
    );
    changed = true;
    return {
      ...candidate,
      state: hasBoundAsset ? ("pending" as const) : ("blocked" as const),
      confirmedTimeMapId: null,
      appliedSegmentIds: [],
      updatedAt: project.updatedAt
    };
  });
  if (!changed) {
    return project;
  }
  const mediaTimeMaps = project.mediaTimeMaps.map((map) =>
    supersededMapIds.has(map.id) &&
    map.state === "confirmed" &&
    !referencedTimeMapIds.has(map.id)
      ? { ...map, state: "superseded" as const, updatedAt: project.updatedAt }
      : map
  );
  return { ...project, mediaMatchCandidates, mediaTimeMaps };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function migrateProjectToCurrentSchema(
  project: LegacyEditorProject,
  parsedVersion: number
): ProjectParseResult {
  if (parsedVersion === CURRENT_SCHEMA_VERSION) {
    return {
      project: reconcileProjectTimeMapQualities(project as EditorProject),
      migration: null
    };
  }
  const legacyClipRanges =
    parsedVersion < 2
      ? migrateLegacyClosedClipRanges(project)
      : { clips: project.clips, adjustedClipRangeCount: 0 };
  const mediaMigration = migrateProjectMediaState(project, parsedVersion);
  const migratedSegments =
    parsedVersion >= 6
      ? migrateLegacyDanmakuSourceSegments(
          project.danmakuSourceSegments,
          mediaMigration,
          parsedVersion
        )
      : [];
  const legacyCandidates =
    parsedVersion >= 9 && project.mediaMatchCandidates ? project.mediaMatchCandidates : [];
  const timeMapMigration =
    parsedVersion >= 10
      ? migrateExistingProjectTimeMaps(
          migratedSegments,
          legacyCandidates,
          project.mediaTimeMaps ?? [],
          parsedVersion
        )
      : migrateLegacyProjectTimeMaps(
          migratedSegments,
          legacyCandidates,
          normalizeMigrationTimestamp(project.updatedAt, project.createdAt)
        );
  const migratedProject = migrateProjectToSpanEvidenceV12({
      ...project,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      clips: legacyClipRanges.clips,
      alignmentProposal: parsedVersion >= 3 ? project.alignmentProposal : null,
      mediaLibrary: mediaMigration.mediaLibrary,
      mediaBinding: mediaMigration.mediaBinding,
      seasonEpisodeBindings: parsedVersion >= 5 ? project.seasonEpisodeBindings : [],
      danmakuSourceBindings: mediaMigration.danmakuSourceBindings,
      danmakuSourceSegments: timeMapMigration.segments,
      mediaMatchCandidates: timeMapMigration.candidates,
      mediaTimeMaps: timeMapMigration.mediaTimeMaps
    });
  return {
    project: reconcileProjectTimeMapQualities(migratedProject),
    migration: {
      fromVersion: parsedVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
      adjustedClipRangeCount: legacyClipRanges.adjustedClipRangeCount
    }
  };
}

function reconcileProjectTimeMapQualities(project: EditorProject): EditorProject {
  const reconcileProposal = (
    proposal: EditorProject["alignmentProposal"]
  ): EditorProject["alignmentProposal"] => {
    if (!proposal?.timeMap) {
      return proposal;
    }
    return {
      ...proposal,
      timeMap: reconcileAlignmentTimeMapProposalQuality(proposal.timeMap)
    };
  };
  return {
    ...project,
    mediaLibrary: project.mediaLibrary.map((media) => ({
      ...media,
      contentIdentity: cloneMediaContentIdentity(media.contentIdentity)
    })),
    alignmentProposal: reconcileProposal(project.alignmentProposal),
    mediaMatchCandidates: project.mediaMatchCandidates.map((candidate) => ({
      ...candidate,
      proposal: reconcileProposal(candidate.proposal) as MediaMatchCandidate["proposal"]
    })),
    mediaTimeMaps: project.mediaTimeMaps.map((timeMap) =>
      reconcileMediaTimeMapQuality({
        ...timeMap,
        sourceIdentity: cloneMediaContentIdentity(timeMap.sourceIdentity),
        targetIdentity: cloneMediaContentIdentity(timeMap.targetIdentity)
      })
    )
  };
}

function migrateProjectMediaState(
  project: LegacyEditorProject,
  parsedVersion: number
): MediaSchemaMigrationResult {
  const timestamp = normalizeMigrationTimestamp(project.updatedAt, project.createdAt);
  const existingMedia = parsedVersion >= 7 && project.mediaLibrary ? project.mediaLibrary : [];
  const mediaLibrary: ProjectMediaReference[] = uniqueMediaReferences(existingMedia);
  const legacySourceMediaId = project.media?.id ?? null;
  if (parsedVersion < 7 && project.media) {
    upsertMediaReference(
      mediaLibrary,
      createMediaReferenceFromLegacyMedia(project.media, timestamp)
    );
  }
  let mediaBinding = parsedVersion >= 4 ? project.mediaBinding : null;
  let defaultTargetMediaId: string | null = null;
  if (parsedVersion < 7 && mediaBinding) {
    const targetMediaId = createUniqueMigratedMediaId(
      mediaLibrary,
      createMigratedMediaId("migrated_target", mediaBinding.id)
    );
    upsertMediaReference(
      mediaLibrary,
      createMediaReferenceFromBinding(targetMediaId, mediaBinding)
    );
    defaultTargetMediaId = targetMediaId;
    if (mediaBinding.kind === "localFile") {
      mediaBinding = {
        ...mediaBinding,
        mediaId: targetMediaId
      };
    }
  }
  const defaultSourceMediaId =
    legacySourceMediaId &&
    mediaLibrary.some(
      (media) => media.id === legacySourceMediaId && media.role === "bilibiliReference"
    )
      ? legacySourceMediaId
      : (mediaLibrary.find((media) => media.role === "bilibiliReference")?.id ?? null);
  const defaultAssetId = project.assets.length === 1 ? project.assets[0].id : null;
  const danmakuSourceBindings =
    parsedVersion >= 7 && project.danmakuSourceBindings
      ? project.danmakuSourceBindings
      : createMigratedDanmakuSourceBindings(project, defaultSourceMediaId, timestamp);
  return {
    mediaLibrary,
    mediaBinding,
    danmakuSourceBindings,
    defaultSourceMediaId,
    defaultTargetMediaId,
    defaultAssetId
  };
}

function migrateLegacyDanmakuSourceSegments(
  segments: LegacyDanmakuSourceSegment[],
  mediaMigration: MediaSchemaMigrationResult,
  parsedVersion: number
): LegacyDanmakuSourceSegment[] {
  return segments.map((segment) => ({
    ...segment,
    assetId: segment.assetId ?? mediaMigration.defaultAssetId,
    sourceMediaId: segment.sourceMediaId ?? mediaMigration.defaultSourceMediaId,
    targetMediaId:
      segment.kind === "content"
        ? (segment.targetMediaId ?? mediaMigration.defaultTargetMediaId)
        : null,
    targetStartMs:
      parsedVersion >= 8 && segment.kind === "content" ? segment.targetStartMs : null,
    timingRules: parsedVersion >= 8 && segment.kind === "content" ? segment.timingRules : [],
    timeMapId: parsedVersion >= 10 ? (segment.timeMapId ?? null) : null
  }));
}

interface LegacyProjectTimeMapMigrationResult {
  segments: DanmakuSourceSegment[];
  candidates: MediaMatchCandidate[];
  mediaTimeMaps: MediaTimeMap[];
}

const V10_VERIFIED_PROVENANCE_BLOCKER =
  "v10 没有可绑定时间图核心、revision、媒体身份与 calibration artifact 的验证记录；原 verified 声明已降级为 review。";

function migrateExistingProjectTimeMaps(
  segments: LegacyDanmakuSourceSegment[],
  candidates: LegacyMediaMatchCandidate[],
  maps: LegacyMediaTimeMap[],
  parsedVersion: number
): LegacyProjectTimeMapMigrationResult {
  return {
    segments: segments.map((segment) => ({ ...segment, timeMapId: segment.timeMapId ?? null })),
    candidates: candidates.map((candidate) => ({
      ...candidate,
      timeMapId: candidate.timeMapId as string,
      confirmedTimeMapId: candidate.confirmedTimeMapId ?? null
    })),
    mediaTimeMaps: maps.map((map) => {
      const needsV10VerificationBlocker = parsedVersion < 11 && map.quality.level === "verified";
      return {
        ...map,
        verification: parsedVersion < 11 ? null : (map.verification ?? null),
        quality: {
          ...map.quality,
          level: needsV10VerificationBlocker ? "review" : map.quality.level,
          reasons: needsV10VerificationBlocker
            ? [...new Set([...map.quality.reasons, V10_VERIFIED_PROVENANCE_BLOCKER])]
            : [...map.quality.reasons]
        }
      };
    })
  };
}

const V12_SPAN_EVIDENCE_MIGRATION_REASON =
  "项目早于 v12，没有保存可独立复核的逐段残差、留出锚点、边界支持和备选路径；原验证已失效，必须重新分析或人工复核。";

function migrateProjectToSpanEvidenceV12(project: EditorProject): EditorProject {
  const migrateProposal = (
    proposal: EditorProject["alignmentProposal"],
    ownerId: string
  ): EditorProject["alignmentProposal"] => {
    if (!proposal?.timeMap) {
      return proposal;
    }
    const blocked = proposal.timeMap.quality.level === "blocked";
    return {
      ...proposal,
      timeMap: {
        ...proposal.timeMap,
        spans: proposal.timeMap.spans.map((span, index) =>
          normalizeLegacyUnverifiedTimeMapSpanEvidence(span, {
            id: `${ownerId}:span:${String(index + 1).padStart(4, "0")}`,
            blocked,
            reason: V12_SPAN_EVIDENCE_MIGRATION_REASON
          })
        ),
        quality: {
          ...proposal.timeMap.quality,
          level: blocked ? "blocked" : "legacy-unverified",
          probability: null,
          uniqueContentCoverage: null,
          p99ResidualMs: null,
          anchorRegionCount: 0,
          reasons: [
            ...new Set([
              ...proposal.timeMap.quality.reasons,
              V12_SPAN_EVIDENCE_MIGRATION_REASON
            ])
          ]
        },
        evidence: {
          ...proposal.timeMap.evidence,
          types: [...new Set([...proposal.timeMap.evidence.types, "legacy" as const])],
          top1Top2Margin: proposal.timeMap.evidence.top1Top2Margin ?? null,
          uniqueContentCoverage: null,
          repeatedContentOnly: false,
          selectedTrackReason: "旧项目没有保存可复核的轨道排序与独特内容覆盖证据。",
          alternativeTrackScores: [],
          notes: [
            ...new Set([
              ...proposal.timeMap.evidence.notes,
              V12_SPAN_EVIDENCE_MIGRATION_REASON
            ])
          ]
        }
      }
    };
  };

  return {
    ...project,
    alignmentProposal: migrateProposal(
      project.alignmentProposal,
      `project:${project.id}:alignment-time-map`
    ),
    mediaMatchCandidates: project.mediaMatchCandidates.map((candidate) => ({
      ...candidate,
      proposal: migrateProposal(candidate.proposal, candidate.timeMapId) as MediaMatchCandidate["proposal"]
    })),
    mediaTimeMaps: project.mediaTimeMaps.map((map) => {
      const blocked = map.quality.level === "blocked";
      return {
        ...map,
        spans: map.spans.map((span, index) =>
          normalizeLegacyUnverifiedTimeMapSpanEvidence(span, {
            id: `${map.id}:span:${String(index + 1).padStart(4, "0")}`,
            blocked,
            reason: V12_SPAN_EVIDENCE_MIGRATION_REASON
          })
        ),
        quality: {
          ...map.quality,
          level: blocked ? "blocked" : "legacy-unverified",
          probability: null,
          uniqueContentCoverage: null,
          p99ResidualMs: null,
          anchorRegionCount: 0,
          reasons: [
            ...new Set([...map.quality.reasons, V12_SPAN_EVIDENCE_MIGRATION_REASON])
          ]
        },
        evidence: {
          ...map.evidence,
          types: [...new Set([...map.evidence.types, "legacy" as const])],
          top1Top2Margin: map.evidence.top1Top2Margin ?? null,
          uniqueContentCoverage: null,
          repeatedContentOnly: false,
          selectedTrackReason: "旧项目没有保存可复核的轨道排序与独特内容覆盖证据。",
          alternativeTrackScores: [],
          notes: [...new Set([...map.evidence.notes, V12_SPAN_EVIDENCE_MIGRATION_REASON])]
        },
        verification: null
      };
    })
  };
}

interface LegacyTimeMapDraft {
  id: string;
  sourceMediaId: string;
  targetMediaId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  expectedTargetEndMs: number | null;
  timingRules: readonly SegmentTimingRule[];
  state: MediaTimeMap["state"];
  timestamp: string;
  legacyCoverage: number | null;
  legacyAnchorCount: number;
}

function migrateLegacyProjectTimeMaps(
  legacySegments: LegacyDanmakuSourceSegment[],
  legacyCandidates: LegacyMediaMatchCandidate[],
  timestamp: string
): LegacyProjectTimeMapMigrationResult {
  const mediaTimeMaps: MediaTimeMap[] = [];
  const candidateMaps = legacyCandidates.map((candidate, index) => {
    const map = createLegacyMediaTimeMap({
      id: createMigratedTimeMapId("candidate", index, candidate.id),
      sourceMediaId: candidate.sourceMediaId,
      targetMediaId: candidate.targetMediaId,
      sourceStartMs: candidate.sourceStartMs,
      sourceEndMs: candidate.sourceEndMs,
      targetStartMs: candidate.targetStartMs,
      expectedTargetEndMs: candidate.targetEndMs,
      timingRules: candidate.timingRules,
      state: "candidate",
      timestamp,
      legacyCoverage: candidate.proposal.matchRange?.coverage ?? null,
      legacyAnchorCount: candidate.proposal.anchors.length
    });
    mediaTimeMaps.push(map);
    return map;
  });

  const segmentAssignments = new Map<number, string>();
  const confirmedMapIds = new Map<number, string>();
  const reusableAcceptedCandidates = new Set<number>();

  legacyCandidates.forEach((candidate, candidateIndex) => {
    if (candidate.state !== "accepted") {
      return;
    }
    const assignedIndexes = candidate.appliedSegmentIds.map((segmentId) =>
      legacySegments.findIndex((segment) => segment.id === segmentId)
    );
    const canReuse =
      assignedIndexes.length > 0 &&
      assignedIndexes.every((segmentIndex) => segmentIndex >= 0) &&
      new Set(assignedIndexes).size === assignedIndexes.length &&
      assignedIndexes.every((segmentIndex) =>
        doesLegacySegmentMatchCandidate(
          legacySegments[segmentIndex],
          candidate,
          candidateMaps[candidateIndex],
          segmentIndex,
          timestamp
        )
      ) &&
      assignedIndexes.every((segmentIndex) => !segmentAssignments.has(segmentIndex));
    if (!canReuse) {
      const reason =
        "旧候选的已应用片段引用缺失、重复，或完整时间规则/映射语义不一致，迁移时已降级为 blocked。";
      candidateMaps[candidateIndex].quality = {
        ...candidateMaps[candidateIndex].quality,
        level: "blocked",
        reasons: [...candidateMaps[candidateIndex].quality.reasons, reason]
      };
      candidateMaps[candidateIndex].evidence = {
        ...candidateMaps[candidateIndex].evidence,
        notes: [...candidateMaps[candidateIndex].evidence.notes, reason]
      };
      candidateMaps[candidateIndex].quality = reconcileMediaTimeMapQuality(
        candidateMaps[candidateIndex]
      ).quality;
      return;
    }

    const candidateMap = candidateMaps[candidateIndex];
    const confirmedMapId = createMigratedTimeMapId(
      "confirmed-candidate",
      candidateIndex,
      candidate.id
    );
    mediaTimeMaps.push({
      ...candidateMap,
      id: confirmedMapId,
      spans: candidateMap.spans.map((span) => ({ ...span })),
      quality: {
        ...candidateMap.quality,
        reasons: [...candidateMap.quality.reasons]
      },
      evidence: {
        ...candidateMap.evidence,
        types: [...candidateMap.evidence.types],
        notes: [...candidateMap.evidence.notes]
      },
      state: "confirmed",
      confirmedAt: timestamp
    });
    confirmedMapIds.set(candidateIndex, confirmedMapId);
    reusableAcceptedCandidates.add(candidateIndex);
    assignedIndexes.forEach((segmentIndex) =>
      segmentAssignments.set(segmentIndex, confirmedMapId)
    );
  });

  const segments: DanmakuSourceSegment[] = legacySegments.map((segment, segmentIndex) => {
    if (segment.kind === "ignored") {
      return { ...segment, timeMapId: null };
    }
    const assignedMapId = segmentAssignments.get(segmentIndex);
    if (assignedMapId) {
      return { ...segment, timeMapId: assignedMapId };
    }
    if (!segment.sourceMediaId || !segment.targetMediaId) {
      return { ...segment, timeMapId: null };
    }

    const map = createLegacyMediaTimeMap({
      id: createMigratedTimeMapId("confirmed-segment", segmentIndex, segment.id),
      sourceMediaId: segment.sourceMediaId,
      targetMediaId: segment.targetMediaId,
      sourceStartMs: segment.sourceStartMs,
      sourceEndMs: segment.sourceEndMs,
      targetStartMs: segment.targetStartMs ?? 0,
      expectedTargetEndMs: null,
      timingRules: segment.timingRules,
      state: "confirmed",
      timestamp,
      legacyCoverage: null,
      legacyAnchorCount: 0
    });
    mediaTimeMaps.push(map);
    return { ...segment, timeMapId: map.id };
  });

  const candidates: MediaMatchCandidate[] = legacyCandidates.map((candidate, index) => {
    const canKeepAcceptedState =
      candidate.state !== "accepted" || reusableAcceptedCandidates.has(index);
    return {
      ...candidate,
      timeMapId: candidateMaps[index].id,
      confirmedTimeMapId: confirmedMapIds.get(index) ?? null,
      state: canKeepAcceptedState ? candidate.state : "blocked",
      appliedSegmentIds: canKeepAcceptedState ? candidate.appliedSegmentIds : []
    };
  });

  return { segments, candidates, mediaTimeMaps };
}

function createLegacyMediaTimeMap(draft: LegacyTimeMapDraft): MediaTimeMap {
  return createLegacyMediaTimeMapRecord({
    id: draft.id,
    sourceMediaId: draft.sourceMediaId,
    targetMediaId: draft.targetMediaId,
    sourceStartMs: draft.sourceStartMs,
    sourceEndMs: draft.sourceEndMs,
    targetStartMs: draft.targetStartMs,
    expectedTargetEndMs: draft.expectedTargetEndMs,
    timingRules: draft.timingRules,
    state: draft.state,
    timestamp: draft.timestamp,
    coverage: draft.legacyCoverage,
    anchorCount: draft.legacyAnchorCount
  });
}

function doesLegacySegmentMatchCandidate(
  segment: LegacyDanmakuSourceSegment,
  candidate: LegacyMediaMatchCandidate,
  candidateMap: MediaTimeMap,
  segmentIndex: number,
  timestamp: string
): boolean {
  if (
    !(
      segment.kind === "content" &&
      segment.sourceMediaId === candidate.sourceMediaId &&
      segment.targetMediaId === candidate.targetMediaId &&
      segment.sourceStartMs === candidate.sourceStartMs &&
      segment.sourceEndMs === candidate.sourceEndMs &&
      (segment.targetStartMs ?? 0) === candidate.targetStartMs &&
      haveSameLegacyTimingRuleSemantics(segment.timingRules, candidate.timingRules)
    )
  ) {
    return false;
  }

  // v9 的 segment 才是实际投影来源。即使外层范围相同，也不能把候选的规则图
  // 复用于规则语义或推导终点不同的 segment，否则升级后会静默改变弹幕时间。
  const segmentMap = createLegacyMediaTimeMap({
    id: createMigratedTimeMapId("confirmed-segment", segmentIndex, segment.id),
    sourceMediaId: segment.sourceMediaId,
    targetMediaId: segment.targetMediaId,
    sourceStartMs: segment.sourceStartMs,
    sourceEndMs: segment.sourceEndMs,
    targetStartMs: segment.targetStartMs ?? 0,
    expectedTargetEndMs: null,
    timingRules: segment.timingRules,
    state: "confirmed",
    timestamp,
    legacyCoverage: null,
    legacyAnchorCount: 0
  });
  return haveSameTimeMapSemantics(segmentMap, candidateMap);
}

function haveSameLegacyTimingRuleSemantics(
  left: readonly SegmentTimingRule[],
  right: readonly SegmentTimingRule[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortRules = (rules: readonly SegmentTimingRule[]) =>
    [...rules].sort(
      (first, second) =>
        first.sourceAtMs - second.sourceAtMs ||
        first.gapMs - second.gapMs ||
        first.id.localeCompare(second.id)
    );
  const sortedLeft = sortRules(left);
  const sortedRight = sortRules(right);
  return sortedLeft.every(
    (rule, index) =>
      rule.sourceAtMs === sortedRight[index]?.sourceAtMs &&
      rule.gapMs === sortedRight[index]?.gapMs
  );
}

function haveSameTimeMapSemantics(left: MediaTimeMap, right: MediaTimeMap): boolean {
  return (
    left.sourceStartMs === right.sourceStartMs &&
    left.sourceEndMs === right.sourceEndMs &&
    left.targetStartMs === right.targetStartMs &&
    left.targetEndMs === right.targetEndMs &&
    left.spans.length === right.spans.length &&
    left.spans.every((span, index) => {
      const other = right.spans[index];
      return (
        span.kind === other?.kind &&
        span.sourceStartMs === other.sourceStartMs &&
        span.sourceEndMs === other.sourceEndMs &&
        span.targetStartMs === other.targetStartMs &&
        span.targetEndMs === other.targetEndMs
      );
    })
  );
}

function createMigratedTimeMapId(kind: string, index: number, legacyId: string): string {
  return createMigratedMediaId(`migrated_v10_${kind}_${index + 1}`, legacyId);
}

function createMigratedDanmakuSourceBindings(
  project: LegacyEditorProject,
  sourceMediaId: string | null,
  timestamp: string
): EditorProject["danmakuSourceBindings"] {
  if (!sourceMediaId) {
    return [];
  }
  return project.assets.map((asset) =>
    createDanmakuSourceBinding(
      createMigratedMediaId("migrated_xml_binding", `${asset.id}_${sourceMediaId}`),
      asset.id,
      sourceMediaId,
      timestamp
    )
  );
}

function uniqueMediaReferences(
  mediaLibrary: readonly ProjectMediaReference[]
): ProjectMediaReference[] {
  const result: ProjectMediaReference[] = [];
  mediaLibrary.forEach((media) => upsertMediaReference(result, media));
  return result;
}

function upsertMediaReference(
  mediaLibrary: ProjectMediaReference[],
  media: ProjectMediaReference
): void {
  const index = mediaLibrary.findIndex((candidate) => candidate.id === media.id);
  if (index >= 0) {
    mediaLibrary[index] = media;
    return;
  }
  mediaLibrary.push(media);
}

function createMigratedMediaId(prefix: string, id: string): string {
  return `${prefix}_${id.replace(/[^A-Za-z0-9_-]+/g, "_")}`;
}

function createUniqueMigratedMediaId(
  mediaLibrary: readonly ProjectMediaReference[],
  preferredId: string
): string {
  if (!mediaLibrary.some((media) => media.id === preferredId)) {
    return preferredId;
  }
  for (let index = 2; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = `${preferredId}_${index}`;
    if (!mediaLibrary.some((media) => media.id === candidate)) {
      return candidate;
    }
  }
  throw new Error("无法为迁移媒体生成唯一 ID。");
}

function normalizeMigrationTimestamp(updatedAt: string, createdAt: string): string {
  return updatedAt.trim().length > 0 ? updatedAt : createdAt;
}

function migrateLegacyClosedClipRanges(project: LegacyEditorProject): {
  clips: EditorProject["clips"];
  adjustedClipRangeCount: number;
} {
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  let adjustedClipRangeCount = 0;
  const clips = project.clips.map((clip) => {
    const asset = assetsById.get(clip.assetId);
    const hasBoundaryItem = asset?.items.some(
      (item) => item.sourceTimeMs >= clip.sourceInMs && item.sourceTimeMs === clip.sourceOutMs
    );
    if (!hasBoundaryItem) {
      return clip;
    }
    adjustedClipRangeCount += 1;
    return { ...clip, sourceOutMs: clip.sourceOutMs + 1 };
  });
  return { clips, adjustedClipRangeCount };
}

function isMediaReference(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.fileName === "string" &&
    (typeof value.objectUrl === "string" || value.objectUrl === null) &&
    (isNonNegativeIntegerMilliseconds(value.durationMs) || value.durationMs === null)
  );
}

function isProjectMediaReferences(value: unknown): boolean {
  return Array.isArray(value) && value.every(isProjectMediaReference);
}

function isMediaContentIdentityOrNullOrMissing(value: unknown): boolean {
  return value === undefined || value === null || isMediaContentIdentity(value);
}

function isProjectMediaReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.role === "targetOriginal" || value.role === "bilibiliReference") &&
    typeof value.name === "string" &&
    typeof value.fileName === "string" &&
    (typeof value.objectUrl === "string" || value.objectUrl === null) &&
    (isNonNegativeIntegerMilliseconds(value.durationMs) || value.durationMs === null) &&
    isMediaContentIdentityOrNullOrMissing(value.contentIdentity) &&
    (value.referenceKind === "browserFile" ||
      value.referenceKind === "localPath" ||
      value.referenceKind === "embyItem") &&
    (value.connectionState === "connected" ||
      value.connectionState === "needsReconnect" ||
      value.connectionState === "metadataOnly") &&
    typeof value.sourceSummary === "string" &&
    (typeof value.localPath === "string" || value.localPath === null) &&
    isProjectMediaEmbyReferenceOrNull(value.emby) &&
    (typeof value.episodeKey === "string" || value.episodeKey === null) &&
    (typeof value.episodeLabel === "string" || value.episodeLabel === null) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isProjectMediaEmbyReferenceOrNull(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  return (
    isRecord(value) &&
    typeof value.itemId === "string" &&
    typeof value.itemName === "string" &&
    typeof value.itemType === "string" &&
    (typeof value.seriesName === "string" || value.seriesName === null) &&
    (isNonNegativeInteger(value.seasonNumber) || value.seasonNumber === null) &&
    (isNonNegativeInteger(value.episodeNumber) || value.episodeNumber === null) &&
    isEmbyServerReference(value.server) &&
    Array.isArray(value.mediaSources) &&
    value.mediaSources.every(isEmbyMediaSourceSummary)
  );
}

function isMediaBindingOrNull(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.displayName !== "string" ||
    (value.runtimeMs !== null && !isNonNegativeIntegerMilliseconds(value.runtimeMs)) ||
    typeof value.linkedAt !== "string"
  ) {
    return false;
  }
  if (value.kind === "localFile") {
    return (
      typeof value.fileName === "string" &&
      (typeof value.mediaId === "string" || value.mediaId === null) &&
      (typeof value.localPath === "string" || value.localPath === null)
    );
  }
  if (value.kind === "embyItem") {
    return (
      typeof value.itemId === "string" &&
      typeof value.itemName === "string" &&
      typeof value.itemType === "string" &&
      (typeof value.seriesName === "string" || value.seriesName === null) &&
      (isNonNegativeInteger(value.seasonNumber) || value.seasonNumber === null) &&
      (isNonNegativeInteger(value.episodeNumber) || value.episodeNumber === null) &&
      isEmbyServerReference(value.server) &&
      Array.isArray(value.mediaSources) &&
      value.mediaSources.every(isEmbyMediaSourceSummary)
    );
  }
  return false;
}

function isEmbyServerReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.serverUrl === "string" &&
    typeof value.pathPrefix === "string" &&
    typeof value.username === "string"
  );
}

function isEmbyMediaSourceSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    (typeof value.id === "string" || value.id === null) &&
    (typeof value.name === "string" || value.name === null) &&
    (typeof value.container === "string" || value.container === null) &&
    (typeof value.videoCodec === "string" || value.videoCodec === null) &&
    (typeof value.audioCodec === "string" || value.audioCodec === null) &&
    (isNonNegativeInteger(value.width) || value.width === null) &&
    (isNonNegativeInteger(value.height) || value.height === null) &&
    (isNonNegativeInteger(value.bitrate) || value.bitrate === null) &&
    (isNonNegativeInteger(value.sizeBytes) || value.sizeBytes === null) &&
    (isNonNegativeIntegerMilliseconds(value.runtimeMs) || value.runtimeMs === null)
  );
}

function isSeasonEpisodeBindings(value: unknown): boolean {
  return Array.isArray(value) && value.every(isSeasonEpisodeBinding);
}

function isSeasonEpisodeBinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.episodeKey === "string" &&
    typeof value.episodeLabel === "string" &&
    isMediaBindingOrNull(value.targetBinding) &&
    value.targetBinding !== null &&
    typeof value.linkedAt === "string"
  );
}

function isDanmakuSourceBindings(value: unknown): boolean {
  return Array.isArray(value) && value.every(isDanmakuSourceBinding);
}

function isDanmakuSourceBinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.assetId === "string" &&
    typeof value.sourceMediaId === "string" &&
    typeof value.linkedAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isDanmakuSourceSegments(value: unknown, version: number): boolean {
  return (
    Array.isArray(value) && value.every((segment) => isDanmakuSourceSegment(segment, version))
  );
}

function isDanmakuSourceSegment(value: unknown, version: number): boolean {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.label !== "string" ||
    (version >= 7 && typeof value.assetId !== "string" && value.assetId !== null) ||
    (version >= 7 && typeof value.sourceMediaId !== "string" && value.sourceMediaId !== null) ||
    !isNonNegativeIntegerMilliseconds(value.sourceStartMs) ||
    !isNonNegativeIntegerMilliseconds(value.sourceEndMs) ||
    value.sourceEndMs <= value.sourceStartMs ||
    (version >= 7 && typeof value.targetMediaId !== "string" && value.targetMediaId !== null) ||
    (version >= 8 &&
      !isNonNegativeIntegerMilliseconds(value.targetStartMs) &&
      value.targetStartMs !== null) ||
    (version >= 8 && !isSegmentTimingRules(value.timingRules)) ||
    (version >= 10 && typeof value.timeMapId !== "string" && value.timeMapId !== null) ||
    typeof value.note !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return false;
  }
  if (value.kind === "content") {
    return (
      (typeof value.episodeKey === "string" || value.episodeKey === null) &&
      (typeof value.episodeLabel === "string" || value.episodeLabel === null)
    );
  }
  if (value.kind === "ignored") {
    return (
      value.episodeKey === null &&
      value.episodeLabel === null &&
      (version < 7 || value.targetMediaId === null) &&
      (version < 10 || value.timeMapId === null)
    );
  }
  return false;
}

function isSegmentTimingRules(value: unknown): boolean {
  return Array.isArray(value) && value.every(isSegmentTimingRule);
}

function isSegmentTimingRule(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isNonNegativeIntegerMilliseconds(value.sourceAtMs) &&
    isIntegerMilliseconds(value.gapMs) &&
    typeof value.note === "string"
  );
}

function isMediaMatchCandidates(value: unknown, version: number): boolean {
  return (
    Array.isArray(value) &&
    value.every((candidate) => isMediaMatchCandidate(candidate, version))
  );
}

function isMediaMatchCandidate(value: unknown, version: number): boolean {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.batchId !== "string" ||
    typeof value.sourceMediaId !== "string" ||
    typeof value.targetMediaId !== "string" ||
    !isNonNegativeIntegerMilliseconds(value.sourceStartMs) ||
    !isNonNegativeIntegerMilliseconds(value.sourceEndMs) ||
    value.sourceEndMs <= value.sourceStartMs ||
    !isNonNegativeIntegerMilliseconds(value.targetStartMs) ||
    !isNonNegativeIntegerMilliseconds(value.targetEndMs) ||
    value.targetEndMs <= value.targetStartMs ||
    !Array.isArray(value.timingRules) ||
    !value.timingRules.every(isSegmentTimingRule) ||
    !isUnitNumber(value.confidence) ||
    !isAlignmentProposal(value.proposal, version) ||
    !isRecord(value.proposal) ||
    !isRecord(value.proposal.matchRange) ||
    value.proposal.matchRange.sourceStartMs !== value.sourceStartMs ||
    value.proposal.matchRange.sourceEndMs !== value.sourceEndMs ||
    value.proposal.matchRange.targetStartMs !== value.targetStartMs ||
    value.proposal.matchRange.targetEndMs !== value.targetEndMs ||
    (version >= 10 && typeof value.timeMapId !== "string") ||
    (version >= 10 &&
      typeof value.confirmedTimeMapId !== "string" &&
      value.confirmedTimeMapId !== null) ||
    (value.state !== "pending" &&
      value.state !== "accepted" &&
      value.state !== "rejected" &&
      value.state !== "blocked") ||
    !isStringArray(value.appliedSegmentIds) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return false;
  }
  const sourceStartMs = value.sourceStartMs;
  const sourceEndMs = value.sourceEndMs;
  const timingRulesInRange = value.timingRules.every(
    (rule) =>
      isRecord(rule) &&
      typeof rule.sourceAtMs === "number" &&
      rule.sourceAtMs >= sourceStartMs &&
      rule.sourceAtMs < sourceEndMs
  );
  const appliedSegmentIds = value.appliedSegmentIds;
  if (!timingRulesInRange || new Set(appliedSegmentIds).size !== appliedSegmentIds.length) {
    return false;
  }
  return value.state === "accepted"
    ? appliedSegmentIds.length > 0
    : appliedSegmentIds.length === 0;
}

function isMediaTimeMaps(value: unknown, version: number): boolean {
  return Array.isArray(value) && value.every((map) => isMediaTimeMap(map, version));
}

function isMediaTimeMap(value: unknown, version: number): boolean {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    !isPositiveInteger(value.revision) ||
    typeof value.sourceMediaId !== "string" ||
    typeof value.targetMediaId !== "string" ||
    value.sourceMediaId === value.targetMediaId ||
    !isMediaTimeMapStreamIdentityOrNull(value.sourceStream) ||
    !isMediaTimeMapStreamIdentityOrNull(value.targetStream) ||
    !isMediaContentIdentityOrNullOrMissing(value.sourceIdentity) ||
    !isMediaContentIdentityOrNullOrMissing(value.targetIdentity) ||
    !isNonNegativeIntegerMilliseconds(value.sourceStartMs) ||
    !isNonNegativeIntegerMilliseconds(value.sourceEndMs) ||
    value.sourceEndMs < value.sourceStartMs ||
    !isNonNegativeIntegerMilliseconds(value.targetStartMs) ||
    !isNonNegativeIntegerMilliseconds(value.targetEndMs) ||
    value.targetEndMs < value.targetStartMs ||
    !Array.isArray(value.spans) ||
    value.spans.length === 0 ||
    !value.spans.every((span) => isTimeMapSpan(span, version >= 12)) ||
    !isMediaTimeMapQuality(value.quality, version >= 12) ||
    !isCompactMediaTimeMapEvidence(value.evidence, version >= 12) ||
    (version >= 11 && !isMediaTimeMapVerificationRecordOrNull(value.verification)) ||
    !isNonEmptyString(value.engineVersion) ||
    !isNonEmptyString(value.featureVersion) ||
    !isNonEmptyString(value.parametersHash) ||
    (value.state !== "candidate" &&
      value.state !== "confirmed" &&
      value.state !== "superseded") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (typeof value.confirmedAt !== "string" && value.confirmedAt !== null)
  ) {
    return false;
  }
  if (
    (value.state === "candidate" && value.confirmedAt !== null) ||
    (value.state !== "candidate" && typeof value.confirmedAt !== "string")
  ) {
    return false;
  }
  const spans = value.spans as TimeMapSpan[];
  const quality = value.quality;
  const evidence = value.evidence as MediaTimeMap["evidence"];
  const firstSpan = spans[0];
  const lastSpan = spans[spans.length - 1];
  return (
    validateTimeMap(spans).valid &&
    (version < 12 || quality.uniqueContentCoverage === evidence.uniqueContentCoverage) &&
    firstSpan.sourceStartMs === value.sourceStartMs &&
    firstSpan.targetStartMs === value.targetStartMs &&
    lastSpan.sourceEndMs === value.sourceEndMs &&
    lastSpan.targetEndMs === value.targetEndMs
  );
}

function isMediaTimeMapVerificationRecordOrNull(
  value: unknown
): value is MediaTimeMapVerificationRecord | null {
  if (value === null) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  if (value.recordVersion === 2) {
    return (
      value.method === "manual-review" &&
      isNonEmptyString(value.verificationId) &&
      isNonEmptyString(value.issuerKeyId) &&
      isPositiveInteger(value.issuerSequence) &&
      value.signatureAlgorithm === "hmac-sha256-v1" &&
      isLowerHex(value.signature, 64) &&
      isSha256Digest(value.requestDigest) &&
      isSha256Digest(value.mapCoreDigest) &&
      isPositiveInteger(value.mapRevision) &&
      isMediaContentIdentity(value.sourceIdentity) &&
      isMediaContentIdentity(value.targetIdentity) &&
      isNonEmptyString(value.calibrationArtifactId) &&
      isNonEmptyString(value.calibrationArtifactVersion) &&
      isSha256Digest(value.reviewEvidenceDigest) &&
      isNonEmptyString(value.verifier) &&
      isNonEmptyString(value.verifiedAt) &&
      isMediaTimeMapVerificationRevocationOrNull(
        value.revocation,
        value.verificationId,
        value.issuerKeyId,
        value.issuerSequence
      )
    );
  }
  return (
    value.recordVersion === 1 &&
    (value.method === "automatic-calibration" || value.method === "manual-review") &&
    typeof value.mapCoreDigest === "string" &&
    (/^fnv1a64:[0-9a-f]{16}$/.test(value.mapCoreDigest) ||
      isSha256Digest(value.mapCoreDigest)) &&
    isPositiveInteger(value.mapRevision) &&
    isMediaContentIdentity(value.sourceIdentity) &&
    isMediaContentIdentity(value.targetIdentity) &&
    isNonEmptyString(value.calibrationArtifactId) &&
    isNonEmptyString(value.calibrationArtifactVersion) &&
    isNonEmptyString(value.verifier) &&
    isNonEmptyString(value.verifiedAt)
  );
}

function isMediaTimeMapVerificationRevocationOrNull(
  value: unknown,
  verificationId: string,
  issuerKeyId: string,
  issueSequence: number
): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      value.recordVersion === 1 &&
      value.verificationId === verificationId &&
      value.issuerKeyId === issuerKeyId &&
      isPositiveInteger(value.issuerSequence) &&
      value.issuerSequence > issueSequence &&
      value.signatureAlgorithm === "hmac-sha256-v1" &&
      isLowerHex(value.signature, 64) &&
      isNonEmptyString(value.reason) &&
      isNonEmptyString(value.revokedBy) &&
      isNonEmptyString(value.revokedAt))
  );
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isLowerHex(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

function isTimeMapSpan(value: unknown, requireCompleteEvidence: boolean): boolean {
  const validCoordinates =
    isRecord(value) &&
    (value.kind === "matched" ||
      value.kind === "sourceOnly" ||
      value.kind === "targetOnly" ||
      value.kind === "ambiguous") &&
    isNonNegativeIntegerMilliseconds(value.sourceStartMs) &&
    isNonNegativeIntegerMilliseconds(value.sourceEndMs) &&
    isNonNegativeIntegerMilliseconds(value.targetStartMs) &&
    isNonNegativeIntegerMilliseconds(value.targetEndMs);
  return (
    validCoordinates &&
    (!requireCompleteEvidence || isCompleteTimeMapSpanEvidence(value))
  );
}

function isMediaTimeMapStreamIdentityOrNull(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (
    !isRecord(value) ||
    (value.type !== "audio" && value.type !== "video") ||
    !isNonNegativeInteger(value.index) ||
    !isStringOrNull(value.codec) ||
    !isIntegerMillisecondsOrNull(value.startMs) ||
    !isIntegerMillisecondsOrNull(value.timelineOffsetMs) ||
    !isStringOrNull(value.timeBase) ||
    !isPositiveIntegerOrNull(value.sampleRate) ||
    !isPositiveIntegerOrNull(value.channels) ||
    !isPositiveFiniteNumberOrNull(value.frameRate) ||
    !isStringOrNull(value.language) ||
    !isStringOrNull(value.title)
  ) {
    return false;
  }
  return value.type === "audio"
    ? value.frameRate === null
    : value.sampleRate === null && value.channels === null;
}

function isMediaTimeMapQuality(
  value: unknown,
  requireV12Fields: boolean
): value is MediaTimeMap["quality"] {
  if (
    !isRecord(value) ||
    (value.level !== "verified" &&
      value.level !== "review" &&
      value.level !== "blocked" &&
      value.level !== "legacy-unverified") ||
    !isUnitNumberOrNull(value.probability) ||
    (value.metricSource !== "measured" &&
      value.metricSource !== "estimated" &&
      value.metricSource !== "missing") ||
    !isUnitNumberOrNull(value.coverage) ||
    (value.uniqueContentCoverage !== undefined &&
      !isUnitNumberOrNull(value.uniqueContentCoverage)) ||
    !isNonNegativeIntegerMillisecondsOrNull(value.p50ResidualMs) ||
    !isNonNegativeIntegerMillisecondsOrNull(value.p95ResidualMs) ||
    (value.p99ResidualMs !== undefined &&
      !isNonNegativeIntegerMillisecondsOrNull(value.p99ResidualMs)) ||
    !isNonNegativeIntegerMillisecondsOrNull(value.maxResidualMs) ||
    !isNonNegativeIntegerMillisecondsOrNull(value.boundaryUncertaintyMs) ||
    !isUnitNumberOrNull(value.alternativeMargin) ||
    !isNonNegativeInteger(value.anchorCount) ||
    (value.anchorRegionCount !== undefined &&
      (!isNonNegativeInteger(value.anchorRegionCount) || value.anchorRegionCount > 3)) ||
    !isNonNegativeInteger(value.heldOutAnchorCount) ||
    !isNonEmptyStringArray(value.reasons)
  ) {
    return false;
  }
  return (
    (!requireV12Fields ||
      ("uniqueContentCoverage" in value &&
        "p99ResidualMs" in value &&
        "anchorRegionCount" in value)) &&
    value.heldOutAnchorCount <= value.anchorCount &&
    (value.p50ResidualMs === undefined ||
      value.p50ResidualMs === null ||
      value.p95ResidualMs === undefined ||
      value.p95ResidualMs === null ||
      value.p50ResidualMs <= value.p95ResidualMs) &&
    (value.p95ResidualMs === undefined ||
      value.p95ResidualMs === null ||
      value.p99ResidualMs === undefined ||
      value.p99ResidualMs === null ||
      value.p95ResidualMs <= value.p99ResidualMs) &&
    (value.p99ResidualMs === undefined ||
      value.p99ResidualMs === null ||
      value.maxResidualMs === undefined ||
      value.maxResidualMs === null ||
      value.p99ResidualMs <= value.maxResidualMs)
  );
}

function isCompactMediaTimeMapEvidence(value: unknown, requireV12Fields: boolean): boolean {
  if (
    !isRecord(value) ||
    !Array.isArray(value.types) ||
    !value.types.every(
      (type) =>
        type === "audio" ||
        type === "visual" ||
        type === "manual" ||
        type === "danmaku" ||
        type === "legacy"
    ) ||
    new Set(value.types).size !== value.types.length ||
    !isNonNegativeInteger(value.audioAnchorCount) ||
    !isNonNegativeInteger(value.visualAnchorCount) ||
    !isNonNegativeInteger(value.heldOutAnchorCount) ||
    (value.top1Top2Margin !== undefined && !isUnitNumberOrNull(value.top1Top2Margin)) ||
    (value.uniqueContentCoverage !== undefined &&
      !isUnitNumberOrNull(value.uniqueContentCoverage)) ||
    (value.repeatedContentOnly !== undefined &&
      typeof value.repeatedContentOnly !== "boolean") ||
    (value.selectedTrackReason !== undefined && typeof value.selectedTrackReason !== "string") ||
    (value.alternativeTrackScores !== undefined &&
      (!Array.isArray(value.alternativeTrackScores) ||
        !value.alternativeTrackScores.every((alternative) =>
          isMediaTimeMapTrackAlternative(alternative, requireV12Fields)
        ))) ||
    !isStringArray(value.notes)
  ) {
    return false;
  }
  return (
    value.types.length > 0 &&
    (!requireV12Fields ||
      ("top1Top2Margin" in value &&
        "uniqueContentCoverage" in value &&
        "repeatedContentOnly" in value &&
        "selectedTrackReason" in value &&
        "alternativeTrackScores" in value))
  );
}

function isMediaTimeMapTrackAlternative(value: unknown, requireV12Fields: boolean): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.sourceStreamIndex) &&
    isNonNegativeInteger(value.targetStreamIndex) &&
    isUnitNumber(value.score) &&
    (value.scale === undefined ||
      (typeof value.scale === "number" && Number.isFinite(value.scale) && value.scale > 0)) &&
    (value.offsetMs === undefined ||
      (typeof value.offsetMs === "number" && Number.isSafeInteger(value.offsetMs))) &&
    (value.inlierCount === undefined || isNonNegativeInteger(value.inlierCount)) &&
    (!requireV12Fields ||
      ("scale" in value && "offsetMs" in value && "inlierCount" in value))
  );
}

function hasValidTimeMapReferences(project: EditorProject): boolean {
  if (
    !hasUniqueIds(project.mediaLibrary) ||
    !hasUniqueIds(project.mediaTimeMaps) ||
    !hasUniqueIds(project.mediaMatchCandidates) ||
    !hasUniqueIds(project.danmakuSourceSegments) ||
    new Set(project.mediaMatchCandidates.map((candidate) => candidate.timeMapId)).size !==
      project.mediaMatchCandidates.length
  ) {
    return false;
  }
  const mediaById = new Map(project.mediaLibrary.map((media) => [media.id, media]));
  const mapsById = new Map(project.mediaTimeMaps.map((map) => [map.id, map]));
  const segmentsById = new Map(
    project.danmakuSourceSegments.map((segment) => [segment.id, segment])
  );

  const mapsReferenceValidMedia = project.mediaTimeMaps.every((map) => {
    const source = mediaById.get(map.sourceMediaId);
    const target = mediaById.get(map.targetMediaId);
    return source?.role === "bilibiliReference" && target?.role === "targetOriginal";
  });
  if (!mapsReferenceValidMedia) {
    return false;
  }

  const segmentsReferenceValidMaps = project.danmakuSourceSegments.every((segment) => {
    if (segment.kind === "ignored") {
      return segment.timeMapId === null;
    }
    if (segment.timeMapId === null) {
      return true;
    }
    const map = mapsById.get(segment.timeMapId);
    return (
      map?.state === "confirmed" &&
      map.sourceMediaId === segment.sourceMediaId &&
      map.targetMediaId === segment.targetMediaId &&
      map.sourceStartMs === segment.sourceStartMs &&
      map.sourceEndMs === segment.sourceEndMs &&
      map.targetStartMs === (segment.targetStartMs ?? 0)
    );
  });
  if (!segmentsReferenceValidMaps) {
    return false;
  }

  const candidateReferencesAreValid = project.mediaMatchCandidates.every((candidate) => {
    const candidateMap = mapsById.get(candidate.timeMapId);
    if (
      candidateMap?.state !== "candidate" ||
      !doesCandidateRangeMatchMap(candidate, candidateMap)
    ) {
      return false;
    }
    if (candidate.state !== "accepted") {
      return candidate.confirmedTimeMapId === null;
    }
    if (
      candidate.confirmedTimeMapId === null ||
      candidate.confirmedTimeMapId === candidate.timeMapId
    ) {
      return false;
    }
    const confirmedMap = mapsById.get(candidate.confirmedTimeMapId);
    if (
      confirmedMap?.state !== "confirmed" ||
      !doesCandidateRangeMatchMap(candidate, confirmedMap)
    ) {
      return false;
    }
    return candidate.appliedSegmentIds.every((segmentId) => {
      const segment = segmentsById.get(segmentId);
      return segment?.kind === "content" && segment.timeMapId === confirmedMap.id;
    });
  });
  if (!candidateReferencesAreValid) {
    return false;
  }

  const confirmedMapOwners = new Map<string, MediaMatchCandidate>();
  for (const candidate of project.mediaMatchCandidates) {
    if (candidate.state !== "accepted" || candidate.confirmedTimeMapId === null) {
      continue;
    }
    if (confirmedMapOwners.has(candidate.confirmedTimeMapId)) {
      return false;
    }
    confirmedMapOwners.set(candidate.confirmedTimeMapId, candidate);
  }

  // 正向校验保证 appliedSegmentIds 都指向确认图；这里补齐反向所有权，禁止同一
  // confirmed map 下存在未被候选登记的可导出孤儿段。
  return project.danmakuSourceSegments.every((segment) => {
    if (segment.timeMapId === null) {
      return true;
    }
    const owner = confirmedMapOwners.get(segment.timeMapId);
    return owner === undefined || owner.appliedSegmentIds.includes(segment.id);
  });
}

function doesCandidateRangeMatchMap(
  candidate: MediaMatchCandidate,
  map: MediaTimeMap
): boolean {
  return (
    map.sourceMediaId === candidate.sourceMediaId &&
    map.targetMediaId === candidate.targetMediaId &&
    map.sourceStartMs === candidate.sourceStartMs &&
    map.sourceEndMs === candidate.sourceEndMs &&
    map.targetStartMs === candidate.targetStartMs &&
    map.targetEndMs === candidate.targetEndMs
  );
}

function hasUniqueIds(items: readonly { id: string }[]): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

function isDanmakuAsset(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.fileName === "string" &&
    typeof value.color === "string" &&
    Array.isArray(value.items) &&
    Array.isArray(value.warnings) &&
    typeof value.importedAt === "string" &&
    value.items.every(isDanmakuItem) &&
    value.warnings.every(isImportWarning)
  );
}

function isDanmakuItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.assetId === "string" &&
    isNonNegativeInteger(value.originalIndex) &&
    isNonNegativeIntegerMilliseconds(value.sourceTimeMs) &&
    isFiniteNumberOrNull(value.mode) &&
    isFiniteNumberOrNull(value.fontSize) &&
    isFiniteNumberOrNull(value.color) &&
    isFiniteNumberOrNull(value.timestamp) &&
    isFiniteNumberOrNull(value.pool) &&
    isStringOrNull(value.userHash) &&
    isStringOrNull(value.rowId) &&
    typeof value.text === "string" &&
    Array.isArray(value.rawPFields) &&
    value.rawPFields.every((field) => typeof field === "string") &&
    typeof value.enabled === "boolean"
  );
}

function isImportWarning(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.assetId === "string" &&
    (isNonNegativeInteger(value.originalIndex) || value.originalIndex === null) &&
    (value.severity === "info" || value.severity === "warning" || value.severity === "error") &&
    typeof value.message === "string" &&
    typeof value.rawSnippet === "string"
  );
}

function isDanmakuClip(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.assetId === "string" &&
    typeof value.name === "string" &&
    isIntegerMilliseconds(value.timelineStartMs) &&
    isNonNegativeIntegerMilliseconds(value.sourceInMs) &&
    isNonNegativeIntegerMilliseconds(value.sourceOutMs) &&
    value.sourceOutMs > value.sourceInMs &&
    isIntegerMilliseconds(value.localOffsetMs) &&
    typeof value.enabled === "boolean"
  );
}

function isCutMarker(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isNonNegativeIntegerMilliseconds(value.sourceAtMs) &&
    isIntegerMilliseconds(value.targetGapMs) &&
    typeof value.note === "string"
  );
}

function isSyncAnchor(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isNonNegativeIntegerMilliseconds(value.sourceMs) &&
    isNonNegativeIntegerMilliseconds(value.targetMs) &&
    (value.origin === "manual" || value.origin === "automatic") &&
    (value.confidence === undefined || isUnitNumber(value.confidence))
  );
}

function isAlignmentProposalOrNull(value: unknown, version: number): boolean {
  return value === null || isAlignmentProposal(value, version);
}

function isAlignmentProposal(value: unknown, version: number): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.anchors) &&
    value.anchors.every(isSyncAnchor) &&
    Array.isArray(value.cutCandidates) &&
    value.cutCandidates.every(isCutCandidate) &&
    isUnitNumber(value.confidence) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every((diagnostic) => typeof diagnostic === "string") &&
    (value.evidence === undefined || isAlignmentEvidence(value.evidence)) &&
    (value.matchRange === undefined || isAlignmentMatchRange(value.matchRange)) &&
    (value.timeMap === undefined ||
      isAlignmentTimeMapProposal(value.timeMap, version >= 12))
  );
}

function isAlignmentMatchRange(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeIntegerMilliseconds(value.sourceStartMs) &&
    isNonNegativeIntegerMilliseconds(value.sourceEndMs) &&
    value.sourceEndMs > value.sourceStartMs &&
    isNonNegativeIntegerMilliseconds(value.targetStartMs) &&
    isNonNegativeIntegerMilliseconds(value.targetEndMs) &&
    value.targetEndMs > value.targetStartMs &&
    isUnitNumber(value.coverage)
  );
}

function isAlignmentEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.algorithm === "alignment-v2-edit-map" ||
      value.algorithm === "time-map-audio" ||
      value.algorithm === "offset-path" ||
      value.algorithm === "sparse-fingerprint" ||
      value.algorithm === "sparse-fingerprint-fallback" ||
      value.algorithm === "dense-dp") &&
    isNonNegativeInteger(value.completeFingerprintCount) &&
    isNonNegativeInteger(value.sourceFingerprintCount) &&
    isNonNegativeInteger(value.fingerprintMatchCount) &&
    isNonNegativeInteger(value.monotonicMatchCount) &&
    isNonNegativeInteger(value.strongAnchorCount) &&
    isNonNegativeInteger(value.weakAnchorCount) &&
    isNonNegativeInteger(value.offsetClusterCount) &&
    isNonNegativeInteger(value.refinedCandidateCount) &&
    isNonNegativeInteger(value.lowConfidenceRegionCount) &&
    (value.timeMappingSegmentCount === undefined ||
      isNonNegativeInteger(value.timeMappingSegmentCount)) &&
    (value.confirmedChangeCount === undefined ||
      isNonNegativeInteger(value.confirmedChangeCount)) &&
    (value.signals === undefined ||
      (Array.isArray(value.signals) && value.signals.every(isEvidenceSignal))) &&
    (value.quality === "high" ||
      value.quality === "medium" ||
      value.quality === "low" ||
      value.quality === "blocked")
  );
}

function isEvidenceSignal(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.kind === "audio" || value.kind === "visual" || value.kind === "danmaku") &&
    (value.status === "used" ||
      value.status === "notConfigured" ||
      value.status === "blocked") &&
    typeof value.label === "string" &&
    isNonNegativeInteger(value.observations) &&
    typeof value.weight === "number" &&
    Number.isFinite(value.weight) &&
    value.weight >= 0 &&
    value.weight <= 1 &&
    typeof value.note === "string"
  );
}

function isCutCandidate(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isNonNegativeIntegerMilliseconds(value.sourceAtMs) &&
    (value.sourceRangeStartMs === undefined ||
      isNonNegativeIntegerMilliseconds(value.sourceRangeStartMs)) &&
    (value.sourceRangeEndMs === undefined ||
      isNonNegativeIntegerMilliseconds(value.sourceRangeEndMs)) &&
    isIntegerMilliseconds(value.targetGapMs) &&
    isUnitNumber(value.confidence) &&
    typeof value.note === "string"
  );
}

function isTimelineState(value: unknown): boolean {
  return (
    isRecord(value) &&
    isPositiveFiniteNumber(value.pixelsPerSecond) &&
    isNonNegativeIntegerMilliseconds(value.scrollMs) &&
    isNonNegativeIntegerMilliseconds(value.playheadMs)
  );
}

function isPreviewSettings(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.danmakuVisible === "boolean" &&
    typeof value.safeAreaVisible === "boolean" &&
    isUnitNumber(value.opacity)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.length > 0 && value.every((item) => item.length > 0);
}

function isMillisecondsRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isIntegerMilliseconds);
}

function isIntegerMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isIntegerMillisecondsOrNull(value: unknown): boolean {
  return value === null || isIntegerMilliseconds(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPositiveIntegerOrNull(value: unknown): boolean {
  return value === null || isPositiveInteger(value);
}

function isNonNegativeIntegerMilliseconds(value: unknown): value is number {
  return isIntegerMilliseconds(value) && value >= 0;
}

function isNonNegativeIntegerMillisecondsOrNull(value: unknown): boolean {
  return value === null || isNonNegativeIntegerMilliseconds(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPositiveFiniteNumberOrNull(value: unknown): boolean {
  return value === null || isPositiveFiniteNumber(value);
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isUnitNumberOrNull(value: unknown): boolean {
  return value === null || isUnitNumber(value);
}

function isFiniteNumberOrNull(value: unknown): boolean {
  return (typeof value === "number" && Number.isFinite(value)) || value === null;
}

function isStringOrNull(value: unknown): boolean {
  return typeof value === "string" || value === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
