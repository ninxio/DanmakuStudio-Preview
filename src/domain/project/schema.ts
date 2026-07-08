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
    typeof value.globalOffsetMs !== "number" ||
    !Array.isArray(value.cutMarkers) ||
    !Array.isArray(value.syncAnchors) ||
    !isNumberRecord(value.itemTimeAdjustments) ||
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
    (typeof value.durationMs === "number" || value.durationMs === null)
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
    value.items.every(isDanmakuItem)
  );
}

function isDanmakuItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.assetId === "string" &&
    typeof value.originalIndex === "number" &&
    typeof value.sourceTimeMs === "number" &&
    typeof value.text === "string" &&
    Array.isArray(value.rawPFields) &&
    value.rawPFields.every((field) => typeof field === "string") &&
    typeof value.enabled === "boolean"
  );
}

function isDanmakuClip(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.assetId === "string" &&
    typeof value.name === "string" &&
    typeof value.timelineStartMs === "number" &&
    typeof value.sourceInMs === "number" &&
    typeof value.sourceOutMs === "number" &&
    typeof value.localOffsetMs === "number" &&
    typeof value.enabled === "boolean"
  );
}

function isTimelineState(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.pixelsPerSecond === "number" &&
    typeof value.scrollMs === "number" &&
    typeof value.playheadMs === "number"
  );
}

function isPreviewSettings(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.danmakuVisible === "boolean" &&
    typeof value.safeAreaVisible === "boolean" &&
    typeof value.opacity === "number"
  );
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNumberRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "number");
}
