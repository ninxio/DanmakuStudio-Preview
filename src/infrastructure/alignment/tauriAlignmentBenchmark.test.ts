import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginAlignmentBenchmarkSession,
  cancelAlignmentBenchmarkJob,
  finishAlignmentBenchmarkSession,
  getActiveAlignmentBenchmarkSession,
  getAlignmentBenchmarkJob,
  isAlignmentBenchmarkJobFinished,
  resetAlignmentBenchmarkCaches,
  startAlignmentBenchmarkJob,
  type AlignmentBenchmarkCacheResetReceipt,
  type AlignmentBenchmarkInvoker,
  type AlignmentBenchmarkJobSnapshot,
  type AlignmentBenchmarkSessionSnapshot
} from "./tauriAlignmentBenchmark";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri
}));

describe("C137 原生性能采集 bridge", () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.isTauri.mockReset();
    tauriMocks.isTauri.mockReturnValue(true);
  });

  it("调用独立 session/cache/job 命令并规范化显式流", async () => {
    const session = createSession();
    const job = createJob();
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "begin_alignment_benchmark_session") return Promise.resolve(session);
      if (command === "get_active_alignment_benchmark_session") return Promise.resolve(session);
      if (command === "reset_alignment_benchmark_caches") {
        return Promise.resolve({
          schemaVersion: 1,
          sessionId: session.sessionId,
          resetTickNs: "10",
          previousGeneration: 0,
          cacheGeneration: 1,
          before: createCacheCounts(2),
          after: createCacheCounts(0),
          allCachesEmpty: true
        });
      }
      if (
        command === "start_alignment_benchmark_job" ||
        command === "get_alignment_benchmark_job" ||
        command === "cancel_alignment_benchmark_job"
      ) {
        return Promise.resolve(job);
      }
      if (command === "finish_alignment_benchmark_session") {
        return Promise.resolve({ ...session, status: "released" });
      }
      throw new Error(`unexpected ${command}`);
    });

    await beginAlignmentBenchmarkSession({
      ffmpegPath: " C:\\tools\\ffmpeg.exe ",
      ffprobePath: " ",
      memorySampleIntervalMs: 20
    });
    await getActiveAlignmentBenchmarkSession();
    await resetAlignmentBenchmarkCaches(session.sessionId);
    await startAlignmentBenchmarkJob(session.sessionId, {
      completePath: "D:\\private\\target.mkv",
      sourcePath: "D:\\private\\source.mkv",
      ffmpegPath: "C:\\tools\\ffmpeg.exe",
      completeAudioStreamIndex: 2,
      sourceAudioStreamIndex: 3,
      localizationMode: true
    });
    await getAlignmentBenchmarkJob(session.sessionId, job.jobId);
    await cancelAlignmentBenchmarkJob(session.sessionId, job.jobId);
    await finishAlignmentBenchmarkSession(session.sessionId);

    expect(tauriMocks.invoke).toHaveBeenCalledWith("begin_alignment_benchmark_session", {
      request: {
        ffmpegPath: "C:\\tools\\ffmpeg.exe",
        ffprobePath: null,
        memorySampleIntervalMs: 20
      }
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith("start_alignment_benchmark_job", {
      sessionId: session.sessionId,
      request: {
        completePath: "D:\\private\\target.mkv",
        sourcePath: "D:\\private\\source.mkv",
        ffmpegPath: "C:\\tools\\ffmpeg.exe",
        localizationMode: true,
        completeAudioStreamIndex: 2,
        sourceAudioStreamIndex: 3,
        completeVideoStreamIndex: null,
        sourceVideoStreamIndex: null,
        ffprobePath: null
      }
    });
  });

  it("浏览器不能调用默认原生采集器，但注入 invoker 仍可单测", async () => {
    tauriMocks.isTauri.mockReturnValue(false);
    await expect(
      beginAlignmentBenchmarkSession({
        ffmpegPath: null,
        ffprobePath: null,
        memorySampleIntervalMs: 20
      })
    ).rejects.toThrow("只能在 Tauri 桌面端");

    const injected = createInvoker();
    await expect(
      beginAlignmentBenchmarkSession(
        { ffmpegPath: null, ffprobePath: null, memorySampleIntervalMs: 20 },
        injected
      )
    ).resolves.toMatchObject({ status: "active" });
  });

  it.each([0, 9, 1_001, 20.5, Number.NaN])("拒绝非法采样间隔 %s", async (interval) => {
    await expect(
      beginAlignmentBenchmarkSession(
        { ffmpegPath: null, ffprobePath: null, memorySampleIntervalMs: interval },
        createInvoker()
      )
    ).rejects.toThrow("采样间隔");
  });

  it("原生错误不会把媒体路径或工具输出带进可分享错误", async () => {
    const invoker = createInvoker({
      startJob: () =>
        Promise.reject(
          new Error("D:\\private\\episode.mkv: ffmpeg stderr contains user secret")
        )
    });

    const error = await startAlignmentBenchmarkJob(
      "benchmark-session-1",
      {
        completePath: "D:\\private\\target.mkv",
        sourcePath: "D:\\private\\episode.mkv",
        ffmpegPath: null
      },
      invoker
    ).catch((reason: unknown) => String(reason));

    expect(error).toContain("媒体路径和工具输出未进入错误");
    expect(error).not.toContain("episode.mkv");
    expect(error).not.toContain("user secret");
  });

  it("finish 只接受 released 或 cleanup-blocked，作业终态判断独立", async () => {
    const invoker = createInvoker({
      finish: () => Promise.resolve(createSession())
    });
    await expect(
      finishAlignmentBenchmarkSession("benchmark-session-1", invoker)
    ).rejects.toThrow("未得到可信终态");
    expect(isAlignmentBenchmarkJobFinished("running")).toBe(false);
    expect(isAlignmentBenchmarkJobFinished("completed")).toBe(true);
    expect(isAlignmentBenchmarkJobFinished("cancelled")).toBe(true);
  });

  it("深层拒绝伪造环境、非规范 ID/tick、越界数组和不可信摘要，且错误保持去敏", async () => {
    const session = createSession();
    const secret = "D:\\private\\secret-ffmpeg.exe";
    const maliciousResponses: unknown[] = [
      { ...session, sessionId: " bad-session-id " },
      { ...session, sessionOriginTickNs: "00" },
      {
        ...session,
        environment: { ...session.environment, storageScope: "system-disk" }
      },
      {
        ...session,
        environment: {
          ...session.environment,
          physicalCoreCount: Number.MAX_SAFE_INTEGER + 1
        }
      },
      {
        ...session,
        environment: {
          ...session.environment,
          issues: Array.from({ length: 129 }, (_, index) => `issue-${index}`),
          measurementStatus: "incomplete"
        }
      },
      {
        ...session,
        environment: {
          ...session.environment,
          ffmpeg: { ...session.environment.ffmpeg, binaryDigest: secret }
        }
      }
    ];

    for (const response of maliciousResponses) {
      const error = await getActiveAlignmentBenchmarkSession(
        createInvoker({
          getActive: () =>
            Promise.resolve(
              unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>(response)
            )
        })
      ).catch((reason: unknown) => String(reason));
      expect(error).toContain("详细系统信息未进入可分享错误");
      expect(error).not.toContain(secret);
    }
  });

  it("深层拒绝伪造缓存重置回执", async () => {
    const receipt = createCacheResetReceipt();
    const maliciousResponses: unknown[] = [
      { ...receipt, resetTickNs: "01" },
      { ...receipt, cacheGeneration: receipt.previousGeneration },
      { ...receipt, allCachesEmpty: false },
      {
        ...receipt,
        after: { ...receipt.after, audioFeatureEntries: 1 }
      },
      {
        ...receipt,
        before: { ...receipt.before, landmarkEntries: Number.POSITIVE_INFINITY }
      }
    ];

    for (const response of maliciousResponses) {
      await expect(
        resetAlignmentBenchmarkCaches(
          receipt.sessionId,
          createInvoker({
            resetCaches: () =>
              Promise.resolve(
                unsafeNativeResponse<AlignmentBenchmarkCacheResetReceipt>(response)
              )
          })
        )
      ).rejects.toThrow("缓存重置失败");
    }
  });

  it("深层拒绝伪造 stage/cache/memory/proposal，并限制数组规模", async () => {
    const job = createJob();
    const stage = createStageTiming();
    const maliciousResponses: unknown[] = [
      { ...job, stageKey: "extracting-secret" },
      { ...job, proposal: [] },
      { ...job, errorCode: "D:\\private\\secret-error" },
      {
        ...job,
        telemetry: { ...job.telemetry, clock: "date-now" }
      },
      {
        ...job,
        telemetry: { ...job.telemetry, elapsedMs: Number.NaN }
      },
      {
        ...job,
        telemetry: {
          ...job.telemetry,
          stages: Array.from({ length: 513 }, () => stage)
        }
      },
      {
        ...job,
        telemetry: {
          ...job.telemetry,
          stages: [{ ...stage, occurrence: 0 }]
        }
      },
      {
        ...job,
        telemetry: {
          ...job.telemetry,
          cache: {
            ...job.telemetry.cache,
            landmarks: { ...job.telemetry.cache.landmarks, hits: -1 }
          }
        }
      },
      {
        ...job,
        telemetry: {
          ...job.telemetry,
          memory: { ...job.telemetry.memory, sampler: "browser-performance-memory" }
        }
      },
      {
        ...job,
        telemetry: {
          ...job.telemetry,
          memory: {
            ...job.telemetry.memory,
            maximumSampleGapMs: Number.POSITIVE_INFINITY
          }
        }
      }
    ];

    for (const response of maliciousResponses) {
      await expect(
        getAlignmentBenchmarkJob(
          job.sessionId,
          job.jobId,
          createInvoker({
            getJob: () =>
              Promise.resolve(unsafeNativeResponse<AlignmentBenchmarkJobSnapshot>(response))
          })
        )
      ).rejects.toThrow("详细系统信息未进入可分享错误");
    }
  });

  it("取消中只接受受限空 tick sentinel，终态要求 canonical tick 与耗时自洽", async () => {
    const running = createJob();
    const pendingCancellation: AlignmentBenchmarkJobSnapshot = {
      ...running,
      telemetry: {
        ...running.telemetry,
        memory: {
          ...running.telemetry.memory,
          sampler: "windows-job-object-working-set-v1"
        },
        cancellation: {
          requestTickNs: "101",
          terminalTickNs: "",
          latencyMs: 0,
          commandAccepted: true
        }
      }
    };
    await expect(
      cancelAlignmentBenchmarkJob(
        running.sessionId,
        running.jobId,
        createInvoker({ cancelJob: () => Promise.resolve(pendingCancellation) })
      )
    ).resolves.toMatchObject({ status: "running" });

    const cancelled = createCancelledJob();
    await expect(
      cancelAlignmentBenchmarkJob(
        cancelled.sessionId,
        cancelled.jobId,
        createInvoker({ cancelJob: () => Promise.resolve(cancelled) })
      )
    ).resolves.toMatchObject({ status: "cancelled" });

    const invalidTerminalSentinel = {
      ...cancelled,
      telemetry: {
        ...cancelled.telemetry,
        cancellation: {
          ...createCancellationTelemetry(),
          terminalTickNs: "",
          latencyMs: 0
        }
      }
    };
    const invalidElapsed = {
      ...cancelled,
      telemetry: {
        ...cancelled.telemetry,
        cancellation: {
          ...createCancellationTelemetry(),
          requestTickNs: "0500000000"
        }
      }
    };
    for (const response of [invalidTerminalSentinel, invalidElapsed]) {
      await expect(
        cancelAlignmentBenchmarkJob(
          cancelled.sessionId,
          cancelled.jobId,
          createInvoker({
            cancelJob: () =>
              Promise.resolve(unsafeNativeResponse<AlignmentBenchmarkJobSnapshot>(response))
          })
        )
      ).rejects.toThrow("任务取消失败");
    }
  });

  it("所有带请求 ID 的 wrapper 都拒绝响应 ID 错配", async () => {
    const session = createSession();
    const job = createJob();
    const wrongSessionId = "benchmark-session-2";
    const wrongJobId = "benchmark-job-2";

    await expect(
      resetAlignmentBenchmarkCaches(
        session.sessionId,
        createInvoker({
          resetCaches: () =>
            Promise.resolve({ ...createCacheResetReceipt(), sessionId: wrongSessionId })
        })
      )
    ).rejects.toThrow("缓存重置失败");
    await expect(
      startAlignmentBenchmarkJob(
        session.sessionId,
        createAlignmentRequest(),
        createInvoker({
          startJob: () => Promise.resolve({ ...job, sessionId: wrongSessionId })
        })
      )
    ).rejects.toThrow("任务启动失败");
    await expect(
      getAlignmentBenchmarkJob(
        session.sessionId,
        job.jobId,
        createInvoker({
          getJob: () => Promise.resolve({ ...job, jobId: wrongJobId })
        })
      )
    ).rejects.toThrow("任务状态读取失败");
    await expect(
      getAlignmentBenchmarkJob(
        session.sessionId,
        job.jobId,
        createInvoker({
          getJob: () => Promise.resolve({ ...job, sessionId: wrongSessionId })
        })
      )
    ).rejects.toThrow("任务状态读取失败");
    await expect(
      cancelAlignmentBenchmarkJob(
        session.sessionId,
        job.jobId,
        createInvoker({
          cancelJob: () => Promise.resolve({ ...job, sessionId: wrongSessionId })
        })
      )
    ).rejects.toThrow("任务取消失败");
    await expect(
      cancelAlignmentBenchmarkJob(
        session.sessionId,
        job.jobId,
        createInvoker({
          cancelJob: () => Promise.resolve({ ...job, jobId: wrongJobId })
        })
      )
    ).rejects.toThrow("任务取消失败");
    await expect(
      finishAlignmentBenchmarkSession(
        session.sessionId,
        createInvoker({
          finish: () =>
            Promise.resolve({ ...session, sessionId: wrongSessionId, status: "released" })
        })
      )
    ).rejects.toThrow("未得到可信终态");
  });
});

function createInvoker(
  overrides: Partial<AlignmentBenchmarkInvoker> = {}
): AlignmentBenchmarkInvoker {
  const session = createSession();
  const job = createJob();
  return {
    begin: () => Promise.resolve(session),
    getActive: () => Promise.resolve(session),
    resetCaches: () =>
      Promise.resolve({
        schemaVersion: 1,
        sessionId: session.sessionId,
        resetTickNs: "10",
        previousGeneration: 0,
        cacheGeneration: 1,
        before: createCacheCounts(1),
        after: createCacheCounts(0),
        allCachesEmpty: true
      }),
    startJob: () => Promise.resolve(job),
    getJob: () => Promise.resolve(job),
    cancelJob: () => Promise.resolve(job),
    finish: () => Promise.resolve({ ...session, status: "released" }),
    ...overrides
  };
}

function createCacheResetReceipt(): AlignmentBenchmarkCacheResetReceipt {
  return {
    schemaVersion: 1,
    sessionId: "benchmark-session-1",
    resetTickNs: "10",
    previousGeneration: 0,
    cacheGeneration: 1,
    before: createCacheCounts(1),
    after: createCacheCounts(0),
    allCachesEmpty: true
  };
}

function createAlignmentRequest() {
  return {
    completePath: "D:\\private\\target.mkv",
    sourcePath: "D:\\private\\source.mkv",
    ffmpegPath: null
  };
}

function createSession(): AlignmentBenchmarkSessionSnapshot {
  return {
    schemaVersion: 1,
    sessionId: "benchmark-session-1",
    status: "active",
    sessionOriginTickNs: "0",
    cacheGeneration: 0,
    memoryScope: "application-process-tree",
    memorySampleIntervalMs: 20,
    environment: {
      schemaVersion: 1,
      collectorVersion: "windows-process-tree-rss-v1",
      measurementStatus: "complete",
      issues: [],
      operatingSystem: "windows",
      operatingSystemVersion: "11",
      architecture: "x86_64",
      cpuModel: "Test CPU",
      physicalCoreCount: 4,
      logicalCoreCount: 8,
      totalMemoryBytes: 16_000_000_000,
      storageScope: "system-volume",
      storageKind: "fixed-local",
      powerProfile: "balanced",
      ffmpeg: { version: "ffmpeg 7", binaryDigest: `sha256:${"a".repeat(64)}` },
      ffprobe: { version: "ffprobe 7", binaryDigest: `sha256:${"b".repeat(64)}` }
    },
    activeJobId: null,
    cleanupIssue: null
  };
}

function createJob(): AlignmentBenchmarkJobSnapshot {
  return {
    schemaVersion: 1,
    sessionId: "benchmark-session-1",
    jobId: "benchmark-job-1",
    status: "running",
    stageKey: "extracting-source",
    stageLabel: "提取参考特征",
    proposal: null,
    errorCode: null,
    telemetry: {
      schemaVersion: 1,
      clock: "rust-std-instant-session-relative-v1",
      startTickNs: "100",
      endTickNs: null,
      elapsedMs: 1,
      stages: [],
      cache: {
        generation: 1,
        before: createCacheCounts(0),
        after: createCacheCounts(0),
        audioFeatures: createCacheCounter(),
        landmarks: createCacheCounter(),
        visualFeatures: createCacheCounter()
      },
      memory: {
        scope: "application-process-tree",
        sampler: "windows-toolhelp-working-set-v1",
        sampleIntervalMs: 20,
        sampleCount: 2,
        failedSampleCount: 0,
        maximumSampleGapMs: 20,
        peakProcessTreeRssBytes: 123_456,
        coverageComplete: true,
        processTreeEmptyAtTerminal: false,
        residualProcessCount: 1
      },
      cancellation: null
    }
  };
}

function createCancelledJob(): AlignmentBenchmarkJobSnapshot {
  const running = createJob();
  return {
    ...running,
    status: "cancelled",
    stageKey: "cancelled",
    stageLabel: "已取消",
    telemetry: {
      ...running.telemetry,
      startTickNs: "100000000",
      endTickNs: "600000000",
      elapsedMs: 500,
      stages: [{ ...createStageTiming(), status: "cancelled" }],
      memory: {
        ...running.telemetry.memory,
        sampler: "windows-job-object-working-set-v1",
        processTreeEmptyAtTerminal: true,
        residualProcessCount: 0
      },
      cancellation: createCancellationTelemetry()
    }
  };
}

function createStageTiming() {
  return {
    stageKey: "extracting-source" as const,
    occurrence: 1,
    startTickNs: "100000000",
    endTickNs: "600000000",
    elapsedMs: 500,
    status: "completed" as const
  };
}

function createCancellationTelemetry() {
  return {
    requestTickNs: "500000000",
    terminalTickNs: "600000000",
    latencyMs: 100,
    commandAccepted: true
  };
}

function createCacheCounts(value: number) {
  return {
    audioFeatureEntries: value,
    landmarkEntries: value,
    visualFeatureEntries: value
  };
}

function createCacheCounter() {
  return { hits: 0, misses: 0, writes: 0, evictions: 0 };
}

function unsafeNativeResponse<T>(value: unknown): T {
  return value as T;
}
