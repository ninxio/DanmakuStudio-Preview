import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlignmentProposal } from "../../domain/alignment/types";
import {
  cancelTauriAudioAlignmentBatchJob,
  cancelTauriAudioAlignmentJob,
  getTauriAudioAlignmentBatchJob,
  getTauriAudioAlignmentJob,
  isAudioAlignmentJobFinished,
  runTauriAudioAlignment,
  startTauriAudioAlignmentBatchJob,
  startTauriAudioAlignmentJob,
  type AudioAlignmentBatchJobInvoker,
  type AudioAlignmentBatchJobSnapshot,
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

  it("批任务一次发送全部媒体并规范化流索引", async () => {
    tauriMocks.invoke.mockResolvedValue({
      schemaVersion: 1,
      evidenceVersion: 1,
      jobId: "batch-1",
      pairingMode: "fullCartesian",
      sourceMediaIds: ["source"],
      targetMediaIds: ["target-1", "target-2"],
      status: "queued",
      progress: 0,
      message: "已排队",
      totalPairCount: 2,
      processedPairCount: 0,
      failedPairCount: 0,
      currentPairOrdinal: null,
      pairs: [
        batchPairSnapshot(1, "source", "target-1", "queued"),
        batchPairSnapshot(2, "source", "target-2", "queued")
      ],
      error: null,
      updatedAtMs: 1
    });

    await startTauriAudioAlignmentBatchJob({
      sources: [{ mediaId: "source", path: "D:\\media\\source.mkv" }],
      targets: [
        { mediaId: "target-1", path: "D:\\media\\ep1.mkv", audioStreamIndex: 2 },
        { mediaId: "target-2", path: "D:\\media\\ep2.mkv", videoStreamIndex: 4 }
      ],
      ffmpegPath: null,
      localizationMode: true
    });

    expect(tauriMocks.invoke).toHaveBeenCalledWith("start_audio_alignment_batch_job", {
      request: {
        schemaVersion: 1,
        sources: [
          {
            mediaId: "source",
            path: "D:\\media\\source.mkv",
            audioStreamIndex: null,
            videoStreamIndex: null
          }
        ],
        targets: [
          {
            mediaId: "target-1",
            path: "D:\\media\\ep1.mkv",
            audioStreamIndex: 2,
            videoStreamIndex: null
          },
          {
            mediaId: "target-2",
            path: "D:\\media\\ep2.mkv",
            audioStreamIndex: null,
            videoStreamIndex: 4
          }
        ],
        ffmpegPath: null,
        ffprobePath: null,
        localizationMode: true
      }
    });
  });

  it("批任务限制空集合、重复媒体和 256 个组合上限", async () => {
    const invoker = vi.fn<AudioAlignmentBatchJobInvoker["start"]>();
    const jobInvoker: AudioAlignmentBatchJobInvoker = {
      start: invoker,
      get: vi.fn(),
      cancel: vi.fn()
    };

    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: [],
          targets: [{ mediaId: "target", path: "target.mkv" }],
          ffmpegPath: null,
          localizationMode: true
        },
        jobInvoker
      )
    ).rejects.toThrow("B 站参考素材不能为空");
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: [
            { mediaId: "source", path: "a.mkv" },
            { mediaId: " source ", path: "b.mkv" }
          ],
          targets: [{ mediaId: "target", path: "target.mkv" }],
          ffmpegPath: null,
          localizationMode: true
        },
        jobInvoker
      )
    ).rejects.toThrow("包含重复媒体 ID");
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: [{ mediaId: "shared", path: "source.mkv" }],
          targets: [{ mediaId: "shared", path: "target.mkv" }],
          ffmpegPath: null,
          localizationMode: true
        },
        jobInvoker
      )
    ).rejects.toThrow("媒体 ID 必须全局唯一");
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: Array.from({ length: 17 }, (_, index) => ({
            mediaId: `source-${index}`,
            path: `${index}.mkv`
          })),
          targets: Array.from({ length: 16 }, (_, index) => ({
            mediaId: `target-${index}`,
            path: `${index}.mkv`
          })),
          ffmpegPath: null,
          localizationMode: true
        },
        jobInvoker
      )
    ).rejects.toThrow("最多分析 256 个素材组合");
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: [{ mediaId: "集".repeat(257), path: "source.mkv" }],
          targets: [{ mediaId: "target", path: "target.mkv" }],
          ffmpegPath: null,
          localizationMode: true
        },
        jobInvoker
      )
    ).rejects.toThrow("最多 512 UTF-8 bytes");
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: [{ mediaId: "source", path: "source.mkv", audioStreamIndex: 0x1_0000_0000 }],
          targets: [{ mediaId: "target", path: "target.mkv" }],
          ffmpegPath: null,
          localizationMode: true
        },
        jobInvoker
      )
    ).rejects.toThrow("u32");
    expect(invoker).not.toHaveBeenCalled();
  });

  it("批任务可显式指定未完成 pair，并拒绝重复或越界引用", async () => {
    const snapshot = {
      schemaVersion: 1 as const,
      evidenceVersion: 1 as const,
      jobId: "batch-explicit",
      pairingMode: "explicit" as const,
      sourceMediaIds: ["source"],
      targetMediaIds: ["target"],
      status: "queued" as const,
      progress: 0,
      message: "已排队",
      totalPairCount: 1,
      processedPairCount: 0,
      failedPairCount: 0,
      currentPairOrdinal: null,
      pairs: [batchPairSnapshot(1, "source", "target", "queued")],
      error: null,
      updatedAtMs: 1
    };
    const start = vi.fn<AudioAlignmentBatchJobInvoker["start"]>(() =>
      Promise.resolve(snapshot)
    );
    const invoker: AudioAlignmentBatchJobInvoker = {
      start,
      get: vi.fn(),
      cancel: vi.fn()
    };
    const base = {
      sources: [{ mediaId: "source", path: "source.mkv" }],
      targets: [{ mediaId: "target", path: "target.mkv" }],
      ffmpegPath: null,
      localizationMode: true as const
    };

    await startTauriAudioAlignmentBatchJob(
      {
        ...base,
        pairs: [{ sourceMediaId: "source", targetMediaId: "target" }]
      },
      invoker
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        pairs: [{ sourceMediaId: "source", targetMediaId: "target" }]
      })
    );

    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          ...base,
          pairs: [{ sourceMediaId: "missing", targetMediaId: "target" }]
        },
        invoker
      )
    ).rejects.toThrow("引用了未纳入批次的媒体");
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          ...base,
          pairs: [
            { sourceMediaId: "source", targetMediaId: "target" },
            { sourceMediaId: "source", targetMediaId: "target" }
          ]
        },
        invoker
      )
    ).rejects.toThrow("包含重复素材组合");
  });

  it("支持读取和取消原生批任务", async () => {
    const snapshot = {
      schemaVersion: 1 as const,
      evidenceVersion: 1 as const,
      jobId: "batch-2",
      pairingMode: "fullCartesian" as const,
      sourceMediaIds: ["source"],
      targetMediaIds: ["target-1", "target-2"],
      status: "cancelled" as const,
      progress: 1,
      message: "已取消",
      totalPairCount: 2,
      processedPairCount: 1,
      failedPairCount: 0,
      currentPairOrdinal: null,
      pairs: [
        batchPairSnapshot(1, "source", "target-1", "completed"),
        batchPairSnapshot(2, "source", "target-2", "cancelled")
      ],
      error: null,
      updatedAtMs: 2
    };
    const invoker: AudioAlignmentBatchJobInvoker = {
      start: () => Promise.resolve(snapshot),
      get: () => Promise.resolve(snapshot),
      cancel: () => Promise.resolve(snapshot)
    };

    await expect(getTauriAudioAlignmentBatchJob("batch-2", invoker)).resolves.toBe(snapshot);
    await expect(cancelTauriAudioAlignmentBatchJob("batch-2", invoker)).resolves.toBe(snapshot);
  });

  it("拒绝计数矛盾或 jobId 不匹配的原生批任务响应", async () => {
    const invalidSnapshot = {
      schemaVersion: 1 as const,
      evidenceVersion: 1 as const,
      jobId: "wrong-job",
      pairingMode: "fullCartesian" as const,
      sourceMediaIds: ["source"],
      targetMediaIds: ["target"],
      status: "running" as const,
      progress: 0.5,
      message: "运行中",
      totalPairCount: 1,
      processedPairCount: 1,
      failedPairCount: 0,
      currentPairOrdinal: 1,
      pairs: [batchPairSnapshot(1, "source", "target", "running")],
      error: null,
      updatedAtMs: 3
    };
    const invoker: AudioAlignmentBatchJobInvoker = {
      start: () => Promise.resolve(invalidSnapshot),
      get: () => Promise.resolve(invalidSnapshot),
      cancel: () => Promise.resolve(invalidSnapshot)
    };

    await expect(getTauriAudioAlignmentBatchJob("expected-job", invoker)).rejects.toThrow(
      "jobId 与请求不一致"
    );
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: [{ mediaId: "source", path: "source.mkv" }],
          targets: [{ mediaId: "target", path: "target.mkv" }],
          ffmpegPath: null,
          localizationMode: true
        },
        invoker
      )
    ).rejects.toThrow("processed/failed 计数与 pair 状态不一致");
  });

  it("启动响应必须绑定请求 inventory，completed 终态不得夹带 cancelled pair", async () => {
    const wrongInventory = {
      schemaVersion: 1 as const,
      evidenceVersion: 1 as const,
      jobId: "batch-boundary",
      pairingMode: "fullCartesian" as const,
      sourceMediaIds: ["other-source"],
      targetMediaIds: ["target"],
      status: "queued" as const,
      progress: 0,
      message: "queued",
      totalPairCount: 1,
      processedPairCount: 0,
      failedPairCount: 0,
      currentPairOrdinal: null,
      pairs: [batchPairSnapshot(1, "other-source", "target", "queued")],
      error: null,
      updatedAtMs: 1
    };
    const inventoryInvoker: AudioAlignmentBatchJobInvoker = {
      start: () => Promise.resolve(wrongInventory),
      get: vi.fn(),
      cancel: vi.fn()
    };
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: [{ mediaId: "source", path: "source.mkv" }],
          targets: [{ mediaId: "target", path: "target.mkv" }],
          ffmpegPath: null,
          localizationMode: true
        },
        inventoryInvoker
      )
    ).rejects.toThrow("未绑定本次请求");

    const inconsistentCompleted = {
      ...wrongInventory,
      jobId: "batch-completed",
      sourceMediaIds: ["source"],
      status: "completed" as const,
      progress: 1,
      pairs: [batchPairSnapshot(1, "source", "target", "cancelled")]
    };
    const terminalInvoker: AudioAlignmentBatchJobInvoker = {
      start: vi.fn(),
      get: () => Promise.resolve(inconsistentCompleted),
      cancel: vi.fn()
    };
    await expect(getTauriAudioAlignmentBatchJob("batch-completed", terminalInvoker)).rejects.toThrow(
      "标记 completed"
    );
  });

  it("接受 fine 失败后保留的 coarse 证据，并严格校验失败状态与完整 Top-K", async () => {
    const failedSnapshot: AudioAlignmentBatchJobSnapshot = {
      schemaVersion: 1,
      evidenceVersion: 1,
      jobId: "batch-fine-failed",
      pairingMode: "fullCartesian",
      sourceMediaIds: ["source"],
      targetMediaIds: ["target"],
      status: "failed",
      progress: 1,
      message: "fine failed",
      totalPairCount: 1,
      processedPairCount: 1,
      failedPairCount: 1,
      currentPairOrdinal: null,
      pairs: [
        {
          ...batchPairSnapshot(1, "source", "target", "failed"),
          globalSelection: failedBatchGlobalSelectionWithCoarseEvidence()
        }
      ],
      error: "batch failed",
      updatedAtMs: 4
    };
    const read = (snapshot: AudioAlignmentBatchJobSnapshot) =>
      getTauriAudioAlignmentBatchJob("batch-fine-failed", {
        start: vi.fn(),
        get: () => Promise.resolve(snapshot),
        cancel: vi.fn()
      });

    await expect(read(failedSnapshot)).resolves.toEqual(failedSnapshot);

    const completedWithErrors = structuredClone(failedSnapshot);
    completedWithErrors.status = "completed";
    completedWithErrors.message = "batch completed with one failed pair";
    completedWithErrors.error = null;
    await expect(read(completedWithErrors)).resolves.toEqual(completedWithErrors);

    const wrongState = structuredClone(failedSnapshot);
    wrongState.pairs[0].globalSelection.state = "blocked";
    await expect(read(wrongState)).rejects.toThrow("失败 pair 必须发布 failed");

    const truncatedTopK = structuredClone(failedSnapshot);
    truncatedTopK.pairs[0].globalSelection.topK = [];
    await expect(read(truncatedTopK)).rejects.toThrow("topK 数量无效");

    const mismatchedDecision = structuredClone(failedSnapshot);
    const decisionCandidate = mismatchedDecision.pairs[0].globalSelection.decisionCandidate;
    if (decisionCandidate === null) throw new Error("fixture decision candidate missing");
    decisionCandidate.offsetMs = 1;
    await expect(read(mismatchedDecision)).rejects.toThrow("与 Top-K 同 rank 候选不一致");
  });
});

function batchPairSnapshot(
  pairOrdinal: number,
  sourceMediaId: string,
  targetMediaId: string,
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
) {
  return {
    pairIndex: pairOrdinal - 1,
    pairOrdinal,
    sourceMediaId,
    targetMediaId,
    status,
    progress: status === "queued" ? 0 : status === "running" ? 0.5 : 1,
    message: status,
    globalSelection: batchGlobalSelection(status),
    proposal: status === "completed" ? emptyProposal : null,
    error: status === "failed" ? "pair failed" : null
  };
}

function batchGlobalSelection(
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
) {
  if (status === "completed") {
    const candidate = {
      rank: 1,
      sourceStreamIndex: 0,
      targetStreamIndex: 0,
      score: 0.9,
      globalScore: 0.8,
      scale: 1,
      offsetMs: 0,
      sourceStartMs: 0,
      sourceEndMs: 1_000,
      targetStartMs: 0,
      targetEndMs: 1_000,
      inlierCount: 20,
      temporalCoverage: 0.8,
      uniqueSourceCoverage: 0.7,
      eligible: true,
      globalSelected: true
    };
    return {
      state: "selected" as const,
      selected: true,
      selectedRank: 1,
      selectedScore: 0.8,
      decisionRank: 1,
      decisionScore: 0.8,
      margin: 1,
      candidateCount: 1,
      eligibleCandidateCount: 1,
      topK: [candidate],
      decisionCandidate: candidate
    };
  }
  return {
    state: status === "failed" ? ("failed" as const) : status === "cancelled" ? ("cancelled" as const) : ("pending" as const),
    selected: false,
    selectedRank: null,
    selectedScore: null,
    decisionRank: null,
    decisionScore: null,
    margin: null,
    candidateCount: 0,
    eligibleCandidateCount: 0,
    topK: [],
    decisionCandidate: null
  };
}

function failedBatchGlobalSelectionWithCoarseEvidence() {
  const completed = batchGlobalSelection("completed");
  if (completed.decisionCandidate === null) {
    throw new Error("测试 fixture 缺少 coarse decision candidate。");
  }
  return {
    ...completed,
    state: "failed" as const,
    selected: false,
    selectedRank: null,
    selectedScore: null,
    topK: completed.topK.map((candidate) => ({ ...candidate, globalSelected: false })),
    decisionCandidate: { ...completed.decisionCandidate, globalSelected: false }
  };
}
