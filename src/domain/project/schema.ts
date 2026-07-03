import { CURRENT_SCHEMA_VERSION, type EditorProject, type ProjectValidationResult } from "./types";

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
  if (typeof value.name !== "string" || !Array.isArray(value.assets) || !Array.isArray(value.clips)) {
    return { ok: false, version, message: "项目文件缺少必要字段。" };
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
