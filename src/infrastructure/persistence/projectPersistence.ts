import type { EditorProject } from "../../domain/project/types";
import { createProjectDownloadFileName } from "../../domain/project/fileNames";
import { parseProjectJson, serializeProject } from "../../domain/project/schema";
import { downloadTextFile } from "../file-system/browserFiles";

export function saveProjectToDownload(project: EditorProject): void {
  downloadTextFile(
    createProjectDownloadFileName(project.name, ".danmaku-project.json"),
    serializeProject(project),
    "application/json;charset=utf-8"
  );
}

export function loadProjectFromText(text: string): EditorProject {
  return parseProjectJson(text);
}
