import type { EditorProject } from "../../domain/project/types";
import { parseProjectJson, serializeProject } from "../../domain/project/schema";
import { downloadTextFile } from "../file-system/browserFiles";

export function saveProjectToDownload(project: EditorProject): void {
  const safeName = project.name.trim() || "danmaku-project";
  downloadTextFile(`${safeName}.danmaku-project.json`, serializeProject(project), "application/json;charset=utf-8");
}

export function loadProjectFromText(text: string): EditorProject {
  return parseProjectJson(text);
}
