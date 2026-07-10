import { isTauri } from "@tauri-apps/api/core";
import { open, type OpenDialogOptions } from "@tauri-apps/plugin-dialog";

export type NativeOpenDialog = (options: OpenDialogOptions) => Promise<string | string[] | null>;

const alignmentMediaFilters = [
  {
    name: "视频文件",
    extensions: ["mp4", "mkv", "webm", "mov", "m4v", "avi", "flv", "ts", "m2ts"]
  }
];

export async function pickAlignmentMediaPath(
  defaultPath = "",
  dialog: NativeOpenDialog = defaultNativeOpenDialog
): Promise<string | null> {
  return pickSingleNativePath(
    {
      title: "选择完整版或当前视频",
      filters: alignmentMediaFilters,
      defaultPath: normalizeDefaultPath(defaultPath)
    },
    dialog
  );
}

export async function pickFfmpegExecutablePath(
  defaultPath = "",
  dialog: NativeOpenDialog = defaultNativeOpenDialog
): Promise<string | null> {
  return pickSingleNativePath(
    {
      title: "选择 FFmpeg 可执行文件",
      defaultPath: normalizeDefaultPath(defaultPath)
    },
    dialog
  );
}

export async function pickExportDirectoryPath(
  defaultPath = "",
  dialog: NativeOpenDialog = defaultNativeOpenDialog
): Promise<string | null> {
  return pickSingleNativeDirectoryPath(
    {
      title: "选择导出文件夹",
      defaultPath: normalizeDefaultPath(defaultPath)
    },
    dialog
  );
}

export async function pickSingleNativePath(
  options: OpenDialogOptions,
  dialog: NativeOpenDialog = defaultNativeOpenDialog
): Promise<string | null> {
  if (dialog === defaultNativeOpenDialog && !isTauri()) {
    throw new Error("原生文件选择器需要在 Tauri 桌面端运行。");
  }
  const selected = await dialog({
    ...options,
    multiple: false,
    directory: false
  });
  const path = Array.isArray(selected) ? selected[0] : selected;
  return path && path.trim().length > 0 ? path : null;
}

export async function pickSingleNativeDirectoryPath(
  options: OpenDialogOptions,
  dialog: NativeOpenDialog = defaultNativeOpenDialog
): Promise<string | null> {
  if (dialog === defaultNativeOpenDialog && !isTauri()) {
    throw new Error("原生目录选择器需要在 Tauri 桌面端运行。");
  }
  const selected = await dialog({
    ...options,
    multiple: false,
    directory: true
  });
  const path = Array.isArray(selected) ? selected[0] : selected;
  return path && path.trim().length > 0 ? path : null;
}

function defaultNativeOpenDialog(options: OpenDialogOptions): Promise<string | string[] | null> {
  return open(options);
}

function normalizeDefaultPath(path: string): string | undefined {
  const trimmed = path.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
