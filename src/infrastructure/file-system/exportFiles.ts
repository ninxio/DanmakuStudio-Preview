import { invoke, isTauri } from "@tauri-apps/api/core";
import type { MediaContentIdentity } from "../../domain/project/types";
import {
  createStoredZip,
  downloadTextFile,
  downloadTextFiles,
  sanitizeDownloadFileName,
  type DownloadTextFilesResult
} from "./browserFiles";

export interface ExportTextFile {
  fileName: string;
  content: string;
}

export interface DesktopExportFileRequest {
  directoryPath: string;
  fileName: string;
  contentBytes: number[];
}

export interface VerifiedMediaDependency {
  mediaId: string;
  path: string;
  expectedIdentity: MediaContentIdentity;
  mapIds: string[];
}

export interface VerifiedExportVerification {
  projectId: string;
  projectUpdatedAt: string;
  snapshotDigest: string;
  dependencies: VerifiedMediaDependency[];
}

export interface DesktopVerifiedExportFileRequest extends DesktopExportFileRequest {
  verification: VerifiedExportVerification;
}

export interface DesktopExportFileResult {
  fileName: string;
  filePath: string;
  directoryPath: string;
  wasRenamed: boolean;
}

export interface ExportFilesBridge {
  isAvailable: () => boolean;
  saveFile: (request: DesktopExportFileRequest) => Promise<DesktopExportFileResult>;
  saveVerifiedFile?: (
    request: DesktopVerifiedExportFileRequest
  ) => Promise<DesktopExportFileResult>;
  openDirectory: (directoryPath: string) => Promise<void>;
}

export interface SaveTextExportOptions {
  directoryPath?: string;
  type?: string;
  /** Required for time-map-derived exports. Such exports never fall back to browser downloads. */
  verification?: VerifiedExportVerification;
  /** Re-evaluated immediately before the native verified-save request is sent. */
  isSnapshotCurrent?: () => boolean;
}

export interface SaveTextExportsOptions extends SaveTextExportOptions {
  archiveFileName?: string;
}

export type SaveTextExportResult =
  | {
      mode: "directory";
      fileCount: number;
      fileName: string;
      filePath: string;
      directoryPath: string;
      wasRenamed: boolean;
    }
  | {
      mode: "download";
      fileCount: number;
      fileName: string | null;
      archiveFileName: string | null;
      downloadedFileName: string | null;
    };

const DEFAULT_TEXT_EXPORT_TYPE = "text/plain;charset=utf-8";

const defaultExportFilesBridge: ExportFilesBridge = {
  isAvailable: () => isTauri(),
  saveFile: (request) => invoke<DesktopExportFileResult>("save_export_file", { request }),
  saveVerifiedFile: (request) =>
    invoke<DesktopExportFileResult>("save_verified_export_file", { request }),
  openDirectory: (directoryPath) => invoke<void>("open_export_directory", { directoryPath })
};

export function getVerifiedExportUnavailableReason(
  directoryPath: string | undefined,
  bridge: ExportFilesBridge = defaultExportFilesBridge
): string | null {
  if (!normalizeDirectoryPath(directoryPath)) {
    return "高精度分集导出必须先在设置中选择桌面导出文件夹。";
  }
  if (!bridge.isAvailable() || !bridge.saveVerifiedFile) {
    return "高精度分集导出仅可在支持写盘前媒体身份复核的桌面端使用。";
  }
  return null;
}

export async function saveTextExportFile(
  file: ExportTextFile,
  options: SaveTextExportOptions = {},
  bridge: ExportFilesBridge = defaultExportFilesBridge
): Promise<SaveTextExportResult> {
  const directoryPath = normalizeDirectoryPath(options.directoryPath);
  const safeFileName = sanitizeDownloadFileName(file.fileName, "export.xml");
  assertVerifiedSaveAvailable(directoryPath, options, bridge);
  if (directoryPath && bridge.isAvailable()) {
    const request: DesktopExportFileRequest = {
      directoryPath,
      fileName: safeFileName,
      contentBytes: Array.from(new TextEncoder().encode(file.content))
    };
    const result = await saveDesktopExport(request, options, bridge);
    return {
      mode: "directory",
      fileCount: 1,
      fileName: result.fileName,
      filePath: result.filePath,
      directoryPath: result.directoryPath,
      wasRenamed: result.wasRenamed
    };
  }
  const downloadedFileName = downloadTextFile(safeFileName, file.content, options.type ?? DEFAULT_TEXT_EXPORT_TYPE);
  return {
    mode: "download",
    fileCount: 1,
    fileName: downloadedFileName,
    archiveFileName: null,
    downloadedFileName
  };
}

export async function saveTextExportFiles(
  files: ExportTextFile[],
  options: SaveTextExportsOptions = {},
  bridge: ExportFilesBridge = defaultExportFilesBridge
): Promise<SaveTextExportResult> {
  const directoryPath = normalizeDirectoryPath(options.directoryPath);
  assertVerifiedSaveAvailable(directoryPath, options, bridge);
  if (files.length === 0) {
    return {
      mode: "download",
      fileCount: 0,
      fileName: null,
      archiveFileName: null,
      downloadedFileName: null
    };
  }
  if (directoryPath && bridge.isAvailable()) {
    if (files.length === 1) {
      return saveTextExportFile(files[0], options, bridge);
    }
    const archiveFileName = sanitizeDownloadFileName(options.archiveFileName ?? "danmaku-exports.zip", "danmaku-exports.zip");
    const zipBytes = await blobToBytes(createStoredZip(files));
    const result = await saveDesktopExport(
      {
        directoryPath,
        fileName: archiveFileName,
        contentBytes: Array.from(zipBytes)
      },
      options,
      bridge
    );
    return {
      mode: "directory",
      fileCount: files.length,
      fileName: result.fileName,
      filePath: result.filePath,
      directoryPath: result.directoryPath,
      wasRenamed: result.wasRenamed
    };
  }
  return downloadResultToSaveResult(
    downloadTextFiles(files, options.type ?? DEFAULT_TEXT_EXPORT_TYPE, options.archiveFileName ?? "danmaku-exports.zip")
  );
}

export async function openExportDirectoryPath(
  directoryPath: string,
  bridge: ExportFilesBridge = defaultExportFilesBridge
): Promise<void> {
  if (!bridge.isAvailable()) {
    throw new Error("打开目录需要在 Tauri 桌面端运行。");
  }
  await bridge.openDirectory(directoryPath);
}

export function formatExportFileError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDirectoryPath(path: string | undefined): string {
  return path?.trim() ?? "";
}

function assertVerifiedSaveAvailable(
  directoryPath: string,
  options: SaveTextExportOptions,
  bridge: ExportFilesBridge
): void {
  if (!options.verification) {
    return;
  }
  const unavailableReason = getVerifiedExportUnavailableReason(directoryPath, bridge);
  if (unavailableReason) {
    throw new Error(`${unavailableReason}不能降级为浏览器下载。`);
  }
}

async function saveDesktopExport(
  request: DesktopExportFileRequest,
  options: SaveTextExportOptions,
  bridge: ExportFilesBridge
): Promise<DesktopExportFileResult> {
  if (!options.verification) {
    return bridge.saveFile(request);
  }
  if (!options.isSnapshotCurrent?.()) {
    throw new Error("项目或导出内容在身份核验期间发生变化，已取消写盘；请重新导出。");
  }
  const saveVerifiedFile = bridge.saveVerifiedFile;
  if (!saveVerifiedFile) {
    throw new Error("桌面端身份复核写盘能力不可用，高精度分集导出已阻断。");
  }
  return saveVerifiedFile({ ...request, verification: options.verification });
}

function downloadResultToSaveResult(result: DownloadTextFilesResult): SaveTextExportResult {
  return {
    mode: "download",
    fileCount: result.fileCount,
    fileName: result.downloadedFileName,
    archiveFileName: result.archiveFileName,
    downloadedFileName: result.downloadedFileName
  };
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  const modernBlob = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof modernBlob.arrayBuffer === "function") {
    return new Uint8Array(await modernBlob.arrayBuffer());
  }
  return readBlobWithReader(blob);
}

function readBlobWithReader(blob: Blob): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
        return;
      }
      reject(new Error("导出 ZIP 数据读取失败。"));
    };
    reader.onerror = () => reject(new Error("导出 ZIP 数据读取失败。"));
    reader.readAsArrayBuffer(blob);
  });
}
