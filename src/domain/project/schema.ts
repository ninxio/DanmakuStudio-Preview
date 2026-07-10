import {
  CURRENT_SCHEMA_VERSION,
  type EditorProject,
  type MediaBinding,
  type ProjectMediaReference,
  type ProjectValidationResult
} from "./types";
import {
  createDanmakuSourceBinding,
  createMediaReferenceFromBinding,
  createMediaReferenceFromLegacyMedia,
  sanitizeMediaReferencesForSave
} from "./mediaLibrary";

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

type LegacyEditorProject = Omit<EditorProject, "mediaLibrary" | "danmakuSourceBindings"> &
  Partial<Pick<EditorProject, "mediaLibrary" | "danmakuSourceBindings">>;

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
    !Array.isArray(value.assets) ||
    !Array.isArray(value.clips) ||
    !isIntegerMilliseconds(value.globalOffsetMs) ||
    !Array.isArray(value.cutMarkers) ||
    !Array.isArray(value.syncAnchors) ||
    (version >= 3 && !isAlignmentProposalOrNull(value.alignmentProposal)) ||
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
  return migrateProjectToCurrentSchema(parsed as EditorProject, validation.version);
}

export function serializeProject(project: EditorProject): string {
  const savedMediaLibrary = sanitizeMediaReferencesForSave(project.mediaLibrary);
  const savedProject: EditorProject = {
    ...project,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    mediaLibrary: savedMediaLibrary,
    media: project.media
      ? {
          ...project.media,
          objectUrl: null
        }
      : null
  };
  return `${JSON.stringify(savedProject, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function migrateProjectToCurrentSchema(project: EditorProject, parsedVersion: number): ProjectParseResult {
  if (parsedVersion === CURRENT_SCHEMA_VERSION) {
    return { project, migration: null };
  }
  const legacyProject = project as LegacyEditorProject;
  const legacyClipRanges =
    parsedVersion < 2
      ? migrateLegacyClosedClipRanges(project)
      : { clips: project.clips, adjustedClipRangeCount: 0 };
  const mediaMigration = migrateProjectMediaState(legacyProject, parsedVersion);
  return {
    project: {
      ...project,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      clips: legacyClipRanges.clips,
      alignmentProposal: parsedVersion >= 3 ? project.alignmentProposal : null,
      mediaLibrary: mediaMigration.mediaLibrary,
      mediaBinding: mediaMigration.mediaBinding,
      seasonEpisodeBindings: parsedVersion >= 5 ? project.seasonEpisodeBindings : [],
      danmakuSourceBindings: mediaMigration.danmakuSourceBindings,
      danmakuSourceSegments:
        parsedVersion >= 6
          ? migrateLegacyDanmakuSourceSegments(project.danmakuSourceSegments, mediaMigration)
          : []
    },
    migration: {
      fromVersion: parsedVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
      adjustedClipRangeCount: legacyClipRanges.adjustedClipRangeCount
    }
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
    upsertMediaReference(mediaLibrary, createMediaReferenceFromLegacyMedia(project.media, timestamp));
  }
  let mediaBinding = parsedVersion >= 4 ? project.mediaBinding : null;
  let defaultTargetMediaId: string | null = null;
  if (parsedVersion < 7 && mediaBinding) {
    const targetMediaId = createUniqueMigratedMediaId(
      mediaLibrary,
      createMigratedMediaId("migrated_target", mediaBinding.id)
    );
    upsertMediaReference(mediaLibrary, createMediaReferenceFromBinding(targetMediaId, mediaBinding));
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
    mediaLibrary.some((media) => media.id === legacySourceMediaId && media.role === "bilibiliReference")
      ? legacySourceMediaId
      : mediaLibrary.find((media) => media.role === "bilibiliReference")?.id ?? null;
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
  segments: EditorProject["danmakuSourceSegments"],
  mediaMigration: MediaSchemaMigrationResult
): EditorProject["danmakuSourceSegments"] {
  return segments.map((segment) => ({
    ...segment,
    assetId: segment.assetId ?? mediaMigration.defaultAssetId,
    sourceMediaId: segment.sourceMediaId ?? mediaMigration.defaultSourceMediaId,
    targetMediaId:
      segment.kind === "content"
        ? segment.targetMediaId ?? mediaMigration.defaultTargetMediaId
        : null
  }));
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

function uniqueMediaReferences(mediaLibrary: readonly ProjectMediaReference[]): ProjectMediaReference[] {
  const result: ProjectMediaReference[] = [];
  mediaLibrary.forEach((media) => upsertMediaReference(result, media));
  return result;
}

function upsertMediaReference(mediaLibrary: ProjectMediaReference[], media: ProjectMediaReference): void {
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

function createUniqueMigratedMediaId(mediaLibrary: readonly ProjectMediaReference[], preferredId: string): string {
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

function migrateLegacyClosedClipRanges(project: EditorProject): {
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

function isProjectMediaReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.role === "targetOriginal" || value.role === "bilibiliReference") &&
    typeof value.name === "string" &&
    typeof value.fileName === "string" &&
    (typeof value.objectUrl === "string" || value.objectUrl === null) &&
    (isNonNegativeIntegerMilliseconds(value.durationMs) || value.durationMs === null) &&
    (value.referenceKind === "browserFile" || value.referenceKind === "localPath" || value.referenceKind === "embyItem") &&
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
  return Array.isArray(value) && value.every((segment) => isDanmakuSourceSegment(segment, version));
}

function isDanmakuSourceSegment(value: unknown, version: number): boolean {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.label !== "string" ||
    (version >= 7 && (typeof value.assetId !== "string" && value.assetId !== null)) ||
    (version >= 7 && (typeof value.sourceMediaId !== "string" && value.sourceMediaId !== null)) ||
    !isNonNegativeIntegerMilliseconds(value.sourceStartMs) ||
    !isNonNegativeIntegerMilliseconds(value.sourceEndMs) ||
    value.sourceEndMs <= value.sourceStartMs ||
    (version >= 7 && (typeof value.targetMediaId !== "string" && value.targetMediaId !== null)) ||
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
    return value.episodeKey === null && value.episodeLabel === null && (version < 7 || value.targetMediaId === null);
  }
  return false;
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

function isAlignmentProposalOrNull(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  return (
    isRecord(value) &&
    Array.isArray(value.anchors) &&
    value.anchors.every(isSyncAnchor) &&
    Array.isArray(value.cutCandidates) &&
    value.cutCandidates.every(isCutCandidate) &&
    isUnitNumber(value.confidence) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every((diagnostic) => typeof diagnostic === "string") &&
    (value.evidence === undefined || isAlignmentEvidence(value.evidence))
  );
}

function isAlignmentEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.algorithm === "time-map-audio" ||
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
    (value.timeMappingSegmentCount === undefined || isNonNegativeInteger(value.timeMappingSegmentCount)) &&
    (value.confirmedChangeCount === undefined || isNonNegativeInteger(value.confirmedChangeCount)) &&
    (value.signals === undefined || (Array.isArray(value.signals) && value.signals.every(isEvidenceSignal))) &&
    (value.quality === "high" || value.quality === "medium" || value.quality === "low" || value.quality === "blocked")
  );
}

function isEvidenceSignal(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.kind === "audio" || value.kind === "visual" || value.kind === "danmaku") &&
    (value.status === "used" || value.status === "notConfigured" || value.status === "blocked") &&
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
    (value.sourceRangeStartMs === undefined || isNonNegativeIntegerMilliseconds(value.sourceRangeStartMs)) &&
    (value.sourceRangeEndMs === undefined || isNonNegativeIntegerMilliseconds(value.sourceRangeEndMs)) &&
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

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isMillisecondsRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isIntegerMilliseconds);
}

function isIntegerMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeIntegerMilliseconds(value: unknown): value is number {
  return isIntegerMilliseconds(value) && value >= 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isFiniteNumberOrNull(value: unknown): boolean {
  return (typeof value === "number" && Number.isFinite(value)) || value === null;
}

function isStringOrNull(value: unknown): boolean {
  return typeof value === "string" || value === null;
}
