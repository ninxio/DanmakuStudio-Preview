import { describe, expect, it, vi } from "vitest";
import {
  pickAlignmentMediaPath,
  pickExportDirectoryPath,
  pickFfmpegExecutablePath,
  pickMpvExecutablePath,
  pickSingleNativeDirectoryPath,
  pickSingleNativePath
} from "./nativeDialogs";

describe("原生文件选择器封装", () => {
  it("网页模式下不会伪装成可选择真实本地路径", async () => {
    await expect(pickSingleNativePath({ title: "选择文件" })).rejects.toThrow("Tauri 桌面端");
    await expect(pickSingleNativeDirectoryPath({ title: "选择目录" })).rejects.toThrow("Tauri 桌面端");
  });

  it("为音频对齐视频路径传递标题、过滤器和默认路径", async () => {
    const dialog = vi.fn().mockResolvedValue("D:\\media\\full.mkv");
    const path = await pickAlignmentMediaPath(" D:\\media ", dialog);

    expect(path).toBe("D:\\media\\full.mkv");
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "选择完整版或当前视频",
        defaultPath: "D:\\media",
        multiple: false,
        directory: false,
        filters: [
          {
            name: "视频文件",
            extensions: ["mp4", "mkv", "webm", "mov", "m4v", "avi", "flv", "ts", "m2ts"]
          }
        ]
      })
    );
  });

  it("为 FFmpeg 路径选择保留用户当前输入并处理取消", async () => {
    const dialog = vi.fn().mockResolvedValue(null);
    const path = await pickFfmpegExecutablePath("C:\\tools\\ffmpeg.exe", dialog);

    expect(path).toBeNull();
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "选择 FFmpeg 可执行文件",
        defaultPath: "C:\\tools\\ffmpeg.exe",
        multiple: false,
        directory: false
      })
    );
  });

  it("为 mpv 路径选择保留用户当前输入", async () => {
    const dialog = vi.fn().mockResolvedValue("C:\\tools\\mpv.exe");
    const path = await pickMpvExecutablePath(" C:\\tools ", dialog);

    expect(path).toBe("C:\\tools\\mpv.exe");
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "选择 mpv 可执行文件",
        defaultPath: "C:\\tools",
        multiple: false,
        directory: false
      })
    );
  });

  it("为默认导出目录使用原生目录选择器", async () => {
    const dialog = vi.fn().mockResolvedValue("D:\\exports");
    const path = await pickExportDirectoryPath(" D:\\old-exports ", dialog);

    expect(path).toBe("D:\\exports");
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "选择导出文件夹",
        defaultPath: "D:\\old-exports",
        multiple: false,
        directory: true
      })
    );
  });
});
