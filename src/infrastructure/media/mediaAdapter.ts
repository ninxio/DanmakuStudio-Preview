import type { Milliseconds } from "../../domain/shared/time";
import {
  controlTauriMpvSidecar,
  getTauriMpvSidecarStatus,
  startTauriMpvSidecar,
  stopTauriMpvSidecar,
  type MpvTrackSummary,
  type MpvSidecarStatus,
  type TauriMpvBridge
} from "./tauriMpvPlayer";

export interface MediaSource {
  kind: "file" | "url";
  name: string;
  url: string;
}

export interface MediaAdapter {
  load(source: MediaSource): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(timeMs: Milliseconds): void;
  getCurrentTimeMs(): Milliseconds;
  getDurationMs(): Milliseconds;
  getTracks(): MpvTrackSummary[];
  setPlaybackRate(rate: number): void;
  dispose(): void;
}

export class HtmlVideoMediaAdapter implements MediaAdapter {
  private video: HTMLVideoElement;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  async load(source: MediaSource): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onLoaded = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("HTML Video 无法播放此视频。请改用 MP4/WebM；MKV 或复杂编码需要后续启用 mpv 播放器。"));
      };
      const cleanup = (): void => {
        this.video.removeEventListener("loadedmetadata", onLoaded);
        this.video.removeEventListener("error", onError);
      };
      this.video.addEventListener("loadedmetadata", onLoaded);
      this.video.addEventListener("error", onError);
      this.video.src = source.url;
      this.video.load();
    });
  }

  async play(): Promise<void> {
    await this.video.play();
  }

  pause(): void {
    this.video.pause();
  }

  seek(timeMs: Milliseconds): void {
    this.video.currentTime = Math.max(0, timeMs) / 1000;
  }

  getCurrentTimeMs(): Milliseconds {
    return Math.round(this.video.currentTime * 1000);
  }

  getDurationMs(): Milliseconds {
    if (!Number.isFinite(this.video.duration)) {
      return 0;
    }
    return Math.round(this.video.duration * 1000);
  }

  getTracks(): MpvTrackSummary[] {
    return [];
  }

  setPlaybackRate(rate: number): void {
    this.video.playbackRate = rate;
  }

  dispose(): void {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
}

export interface NativeMpvMediaAdapter extends MediaAdapter {
  readonly kind: "native-mpv";
  getSupportedContainerNote(): string;
}

export class TauriMpvMediaAdapter implements NativeMpvMediaAdapter {
  readonly kind = "native-mpv";

  private readonly mpvPath: string;
  private readonly bridge?: TauriMpvBridge;
  private currentTimeMs: Milliseconds = 0;
  private durationMs: Milliseconds = 0;
  private tracks: MpvTrackSummary[] = [];
  private pollTimer: number | null = null;

  constructor(mpvPath: string, bridge?: TauriMpvBridge) {
    this.mpvPath = mpvPath.trim();
    this.bridge = bridge;
  }

  async load(source: MediaSource): Promise<void> {
    if (this.mpvPath.length === 0) {
      throw new Error("尚未配置 mpv 路径。请在“设置中心 / 播放器与工具”里选择 mpv 可执行文件。");
    }
    if (!isSupportedMpvSource(source)) {
      throw new Error("mpv 播放需要真实本地文件路径，或本次会话生成的 Emby 授权播放地址。");
    }
    const status = await startTauriMpvSidecar(
      {
        mpvPath: this.mpvPath,
        mediaPath: source.url,
        startPositionMs: this.currentTimeMs,
        startPaused: true
      },
      this.bridge
    );
    this.updateFromStatus(status);
    this.startPolling();
  }

  async play(): Promise<void> {
    const status = await controlTauriMpvSidecar({ action: "play" }, this.bridge);
    this.updateFromStatus(status);
    this.startPolling();
  }

  pause(): void {
    void controlTauriMpvSidecar({ action: "pause" }, this.bridge)
      .then((status) => this.updateFromStatus(status))
      .catch(() => undefined);
  }

  seek(timeMs: Milliseconds): void {
    this.currentTimeMs = Math.max(0, Math.round(timeMs));
    void controlTauriMpvSidecar(
      {
        action: "seek",
        positionMs: this.currentTimeMs
      },
      this.bridge
    )
      .then((status) => this.updateFromStatus(status))
      .catch(() => undefined);
  }

  getCurrentTimeMs(): Milliseconds {
    return this.currentTimeMs;
  }

  getDurationMs(): Milliseconds {
    return this.durationMs;
  }

  getTracks(): MpvTrackSummary[] {
    return this.tracks;
  }

  setPlaybackRate(rate: number): void {
    void controlTauriMpvSidecar(
      {
        action: "setPlaybackRate",
        playbackRate: rate
      },
      this.bridge
    )
      .then((status) => this.updateFromStatus(status))
      .catch(() => undefined);
  }

  dispose(): void {
    this.stopPolling();
    void stopTauriMpvSidecar(this.bridge).catch(() => undefined);
  }

  getSupportedContainerNote(): string {
    return "mpv 后端用于本地 MKV、高码率、复杂编码视频和本次会话生成的 Emby 授权流；需要桌面端。";
  }

  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = window.setInterval(() => {
      void getTauriMpvSidecarStatus(this.bridge)
        .then((status) => this.updateFromStatus(status))
        .catch(() => this.stopPolling());
    }, 250);
  }

  private stopPolling(): void {
    if (!this.pollTimer) {
      return;
    }
    window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private updateFromStatus(status: MpvSidecarStatus): void {
    this.currentTimeMs = Math.max(0, Math.round(status.positionMs));
    this.durationMs = Math.max(0, Math.round(status.durationMs));
    this.tracks = status.tracks;
    if (!status.running) {
      this.stopPolling();
    }
  }
}

function isSupportedMpvSource(source: MediaSource): boolean {
  if (source.url.startsWith("blob:")) {
    return false;
  }
  if (source.kind === "file") {
    return source.url.trim().length > 0;
  }
  return source.kind === "url" && isHttpMediaUrl(source.url);
}

function isHttpMediaUrl(url: string): boolean {
  const normalized = url.trim().toLocaleLowerCase();
  return normalized.startsWith("http://") || normalized.startsWith("https://");
}
