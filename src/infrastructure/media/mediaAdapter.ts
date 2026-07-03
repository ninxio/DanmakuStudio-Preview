import type { Milliseconds } from "../../domain/shared/time";

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
        reject(new Error("视频加载失败，请确认格式为浏览器可播放的 MP4 或 WebM。"));
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
