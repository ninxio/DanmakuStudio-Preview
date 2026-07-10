import { afterEach, describe, expect, it, vi } from "vitest";
import { TauriMpvMediaAdapter } from "./mediaAdapter";
import type { TauriMpvBridge } from "./tauriMpvPlayer";

describe("媒体适配器", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mpv 适配器通过 Tauri sidecar 加载和控制本地文件", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const adapter = new TauriMpvMediaAdapter("C:\\tools\\mpv.exe", bridge);

    await adapter.load({ kind: "file", name: "full.mkv", url: "D:\\media\\full.mkv" });
    expect(bridge.start).toHaveBeenCalledWith({
      mpvPath: "C:\\tools\\mpv.exe",
      mediaPath: "D:\\media\\full.mkv",
      startPositionMs: 0,
      startPaused: true
    });
    expect(adapter.getDurationMs()).toBe(3_000_000);

    await adapter.play();
    adapter.seek(12_345);
    adapter.pause();
    adapter.setPlaybackRate(1.25);
    expect(bridge.control).toHaveBeenCalledWith({ action: "play" });
    expect(bridge.control).toHaveBeenCalledWith({ action: "seek", positionMs: 12_345 });
    expect(bridge.control).toHaveBeenCalledWith({ action: "pause" });
    expect(bridge.control).toHaveBeenCalledWith({ action: "setPlaybackRate", playbackRate: 1.25 });

    adapter.dispose();
    expect(bridge.stop).toHaveBeenCalledTimes(1);
  });

  it("mpv 适配器拒绝 blob URL 和空 mpv 路径", async () => {
    const bridge = createBridge();
    await expect(new TauriMpvMediaAdapter("", bridge).load({ kind: "file", name: "demo", url: "D:\\demo.mkv" }))
      .rejects.toThrow("尚未配置 mpv 路径");
    await expect(
      new TauriMpvMediaAdapter("mpv", bridge).load({ kind: "file", name: "demo", url: "blob:demo" })
    ).rejects.toThrow("真实本地文件路径");
  });
});

function createBridge(): TauriMpvBridge {
  return {
    detectTool: vi.fn<TauriMpvBridge["detectTool"]>(),
    start: vi.fn<TauriMpvBridge["start"]>((request) =>
      Promise.resolve({
        running: true,
        backend: "native-mpv",
        playbackStatus: request.startPaused ? "paused" : "playing",
        mediaPath: request.mediaPath,
        positionMs: request.startPositionMs ?? 0,
        durationMs: 3_000_000,
        message: "mpv 已启动。",
        error: null,
        updatedAtMs: 1
      })
    ),
    stop: vi.fn<TauriMpvBridge["stop"]>(() =>
      Promise.resolve({
        running: false,
        backend: "native-mpv",
        playbackStatus: "stopped",
        mediaPath: null,
        positionMs: 0,
        durationMs: 0,
        message: "mpv 已停止。",
        error: null,
        updatedAtMs: 2
      })
    ),
    status: vi.fn<TauriMpvBridge["status"]>(() =>
      Promise.resolve({
        running: true,
        backend: "native-mpv",
        playbackStatus: "playing",
        mediaPath: "D:\\media\\full.mkv",
        positionMs: 12_345,
        durationMs: 3_000_000,
        message: "mpv 正在播放。",
        error: null,
        updatedAtMs: 3
      })
    ),
    control: vi.fn<TauriMpvBridge["control"]>((request) =>
      Promise.resolve({
        running: true,
        backend: "native-mpv",
        playbackStatus: request.action === "play" ? "playing" : "paused",
        mediaPath: "D:\\media\\full.mkv",
        positionMs: request.positionMs ?? 12_345,
        durationMs: 3_000_000,
        message: "mpv 控制命令已发送。",
        error: null,
        updatedAtMs: 4
      })
    )
  };
}
