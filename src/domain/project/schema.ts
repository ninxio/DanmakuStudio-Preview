import {
  CURRENT_SCHEMA_VERSION,
  type EditorProject,
  type ProjectValidationResult
} from "./types";

export function validateProjectSchema(value: unknown): ProjectValidationResult {
  if (!isRecord(value)) {
    return { ok: false, version: null, message: "项目文件不是有效对象。" };
  }
  const version = value.schemaVersion;
  if (typeof version !== "number") {
    return { ok: false, version: null, message: "项目文件缺少 schemaVersion。" };
  }
  if (version !== CURRENT_SCHEMA_VERSION) {
    return {
      ok: false,
      version,
      message: `项目版本 ${version} 暂不支持，当前支持版本为 ${CURRENT_SCHEMA_VERSION}。`
    };
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !isMediaReference(value.media) ||
    !Array.isArray(value.assets) ||
    !Array.isArray(value.clips) ||
    !isIntegerMilliseconds(value.globalOffsetMs) ||
    !Array.isArray(value.cutMarkers) ||
    !Array.isArray(value.syncAnchors) ||
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
    return { ok: false, version, message: "项目文件中的删减补偿点结构不完整。" };
  }
  if (!value.syncAnchors.every(isSyncAnchor)) {
    return { ok: false, version, message: "项目文件中的同步锚点结构不完整。" };
  }
  return { ok: true, version, message: "项目文件可打开。" };
}

export function parseProjectJson(json: string): EditorProject {
  const parsed = JSON.parse(json) as unknown;
  const validation = validateProjectSchema(parsed);
  if (!validation.ok) {
    throw new Error(validation.message);
  }
  return parsed as EditorProject;
}

export function serializeProject(project: EditorProject): string {
  const savedProject: EditorProject = {
    ...project,
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
