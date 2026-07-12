import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlignmentProposal } from "../../domain/alignment/types";
import {
  cancelTauriAudioAlignmentJob,
  getTauriAudioAlignmentJob,
  isAudioAlignmentJobFinished,
  runTauriAudioAlignment,
  startTauriAudioAlignmentJob,
  type AudioAlignmentInvoker,
  type AudioAlignmentJobInvoker,
  type NormalizedTauriAudioAlignmentRequest,
  type TauriAudioAlignmentRequest
} from "./tauriAudioAlignment";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri
}));

const emptyProposal: AlignmentProposal = {
  anchors: [],
  cutCandidates: [],
  confidence: 0,
  diagnostics: []
};

describe("Tauri 音频对齐调用", () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.isTauri.mockReset();
    tauriMocks.isTauri.mockReturnValue(true);
  });

  it("把请求交给注入的 invoker 并返回 proposal", async () => {
    const request: TauriAudioAlignmentRequest = {
      completePath: "full.mp4",
      sourcePath: "cut.mp4",
      ffmpegPath: null,
      localizationMode: true
    };
    const proposal = await runTauriAudioAlignment(request, (received) =>
      Promise.resolve({
        anchors: [
          { id: "a", sourceMs: 1000, targetMs: 2000, origin: "automatic", confidence: 0.9 }
        ],
        cutCandidates: [],
        confidence: received.completePath === "full.mp4" ? 1 : 0,
        diagnostics: [],
        matchRange: received.localizationMode
          ? {
              sourceStartMs: 500_000,
              sourceEndMs: 620_000,
              targetStartMs: 0,
              targetEndMs: 120_000,
              coverage: 1
            }
          : undefined
      })
    );

    expect(proposal.anchors).toHaveLength(1);
    expect(proposal.confidence).toBe(1);
    expect(proposal.matchRange).toEqual({
      sourceStartMs: 500_000,
      sourceEndMs: 620_000,
      targetStartMs: 0,
      targetEndMs: 120_000,
      coverage: 1
    });
  });

  it("以 camelCase 把 FFprobe 与显式音视频流索引传给 Rust", async () => {
    const request: TauriAudioAlignmentRequest = {
      completePath: "D:\\media\\full.mkv",
      sourcePath: "D:\\media\\reference.mkv",
      ffmpegPath: "C:\\tools\\ffmpeg.exe",
      ffprobePath: "C:\\tools\\ffprobe.exe",
      completeAudioStreamIndex: 2,
      sourceAudioStreamIndex: 4,
      completeVideoStreamIndex: 6,
      sourceVideoStreamIndex: 8,
      localizationMode: true
    };
    tauriMocks.invoke.mockResolvedValue(emptyProposal);

    await expect(runTauriAudioAlignment(request)).resolves.toBe(emptyProposal);

    expect(tauriMocks.invoke).toHaveBeenCalledWith("align_audio_files", {
      request: {
        completePath: "D:\\media\\full.mkv",
        sourcePath: "D:\\media\\reference.mkv",
        ffmpegPath: "C:\\tools\\ffmpeg.exe",
        ffprobePath: "C:\\tools\\ffprobe.exe",
        completeAudioStreamIndex: 2,
        sourceAudioStreamIndex: 4,
        completeVideoStreamIndex: 6,
        sourceVideoStreamIndex: 8,
        localizationMode: true
      }
    });
  });

  it("省略音轨设置时规范为 null 并保持自动选轨", async () => {
    const received: NormalizedTauriAudioAlignmentRequest[] = [];
    const invoker: AudioAlignmentInvoker = (request) => {
      received.push(request);
      return Promise.resolve(emptyProposal);
    };

    await runTauriAudioAlignment(
      {
        completePath: "full.mp4",
        sourcePath: "reference.mp4",
        ffmpegPath: null
      },
      invoker
    );

    expect(received).toMatchObject([
      {
        ffprobePath: null,
        completeAudioStreamIndex: null,
        sourceAudioStreamIndex: null,
        completeVideoStreamIndex: null,
        sourceVideoStreamIndex: null
      }
    ]);
  });

  it("后台任务默认调用同样发送 camelCase 的自动选轨 null", async () => {
    tauriMocks.invoke.mockResolvedValue({
      jobId: "job-auto-track",
      status: "queued",
      progress: 0,
      message: "已排队",
      logs: [],
      proposal: null,
      error: null,
      updatedAtMs: 1
    });

    await startTauriAudioAlignmentJob({
      completePath: "full.mp4",
      sourcePath: "reference.mp4",
      ffmpegPath: null
    });

    expect(tauriMocks.invoke).toHaveBeenCalledWith("start_audio_alignment_job", {
      request: {
        completePath: "full.mp4",
        sourcePath: "reference.mp4",
        ffmpegPath: null,
        ffprobePath: null,
        completeAudioStreamIndex: null,
        sourceAudioStreamIndex: null,
        completeVideoStreamIndex: null,
        sourceVideoStreamIndex: null
      }
    });
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "拒绝非法音轨索引 %s，且不会调用 Rust",
    async (invalidIndex) => {
      const invoker = vi.fn<AudioAlignmentInvoker>(() => Promise.resolve(emptyProposal));

      await expect(
        runTauriAudioAlignment(
          {
            completePath: "full.mp4",
            sourcePath: "reference.mp4",
            ffmpegPath: null,
            completeAudioStreamIndex: invalidIndex
          },
          invoker
        )
      ).rejects.toThrow("原片音轨索引必须是非负安全整数或 null。");
      expect(invoker).not.toHaveBeenCalled();
    }
  );

  it("分别校验参考视频音轨索引", async () => {
    const invoker = vi.fn<AudioAlignmentInvoker>(() => Promise.resolve(emptyProposal));

    await expect(
      runTauriAudioAlignment(
        {
          completePath: "full.mp4",
          sourcePath: "reference.mp4",
          ffmpegPath: null,
          sourceAudioStreamIndex: -1
        },
        invoker
      )
    ).rejects.toThrow("参考视频音轨索引必须是非负安全整数或 null。");
    expect(invoker).not.toHaveBeenCalled();
  });

  it("分别校验原片与参考视频流索引", async () => {
    const invoker = vi.fn<AudioAlignmentInvoker>(() => Promise.resolve(emptyProposal));

    await expect(
      runTauriAudioAlignment(
        {
          completePath: "full.mp4",
          sourcePath: "reference.mp4",
          ffmpegPath: null,
          completeVideoStreamIndex: -1
        },
        invoker
      )
    ).rejects.toThrow("原片视频流索引必须是非负安全整数或 null。");
    await expect(
      runTauriAudioAlignment(
        {
          completePath: "full.mp4",
          sourcePath: "reference.mp4",
          ffmpegPath: null,
          sourceVideoStreamIndex: 1.5
        },
        invoker
      )
    ).rejects.toThrow("参考视频流索引必须是非负安全整数或 null。");
    expect(invoker).not.toHaveBeenCalled();
  });

  it("为同步分析和后台任务失败补充调用上下文", async () => {
    const request: TauriAudioAlignmentRequest = {
      completePath: "full.mp4",
      sourcePath: "reference.mp4",
      ffmpegPath: null
    };
    const alignmentInvoker: AudioAlignmentInvoker = () =>
      Promise.reject(new Error("FFmpeg 无法解码"));
    const jobInvoker: AudioAlignmentJobInvoker = {
      start: () => Promise.reject(new Error("FFprobe 不可用")),
      get: () => Promise.reject(new Error("不应调用")),
      cancel: () => Promise.reject(new Error("不应调用"))
    };

    await expect(runTauriAudioAlignment(request, alignmentInvoker)).rejects.toThrow(
      "本地音频对齐失败：FFmpeg 无法解码"
    );
    await expect(startTauriAudioAlignmentJob(request, jobInvoker)).rejects.toThrow(
      "音频对齐任务启动失败：FFprobe 不可用"
    );
  });

  it("支持启动、查询和取消后台任务", async () => {
    const request: TauriAudioAlignmentRequest = {
      completePath: "full.mp4",
      sourcePath: "cut.mp4",
      ffmpegPath: null
    };
    const invoker: AudioAlignmentJobInvoker = {
      start: (received) =>
        Promise.resolve({
          jobId: received.completePath === "full.mp4" ? "job-1" : "job-x",
          status: "running",
          progress: 0.25,
          message: "正在提取完整版音频特征。",
          logs: ["音频对齐任务已加入队列。", "正在提取完整版音频特征。"],
          proposal: null,
          error: null,
          updatedAtMs: 1
        }),
      get: (jobId) =>
        Promise.resolve({
          jobId,
          status: "completed",
          progress: 1,
          message: "本地音频对齐完成。",
          logs: ["本地音频对齐完成。"],
          proposal: {
            anchors: [],
            cutCandidates: [],
            confidence: 1,
            diagnostics: []
          },
          error: null,
          updatedAtMs: 2
        }),
      cancel: (jobId) =>
        Promise.resolve({
          jobId,
          status: "cancelled",
          progress: 1,
          message: "已请求取消音频对齐任务。",
          logs: ["已请求取消音频对齐任务。"],
          proposal: null,
          error: null,
          updatedAtMs: 3
        })
    };

    await expect(startTauriAudioAlignmentJob(request, invoker)).resolves.toMatchObject({
      jobId: "job-1",
      status: "running",
      logs: ["音频对齐任务已加入队列。", "正在提取完整版音频特征。"]
    });
    await expect(getTauriAudioAlignmentJob("job-1", invoker)).resolves.toMatchObject({
      status: "completed",
      progress: 1
    });
    await expect(cancelTauriAudioAlignmentJob("job-1", invoker)).resolves.toMatchObject({
      status: "cancelled"
    });
    expect(isAudioAlignmentJobFinished("completed")).toBe(true);
    expect(isAudioAlignmentJobFinished("running")).toBe(false);
  });
});
