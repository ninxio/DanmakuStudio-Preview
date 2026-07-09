import { describe, expect, it } from "vitest";
import {
  cancelTauriAudioAlignmentJob,
  getTauriAudioAlignmentJob,
  isAudioAlignmentJobFinished,
  runTauriAudioAlignment,
  startTauriAudioAlignmentJob,
  type AudioAlignmentJobInvoker,
  type TauriAudioAlignmentRequest
} from "./tauriAudioAlignment";

describe("Tauri 音频对齐调用", () => {
  it("把请求交给注入的 invoker 并返回 proposal", async () => {
    const request: TauriAudioAlignmentRequest = {
      completePath: "full.mp4",
      sourcePath: "cut.mp4",
      ffmpegPath: null
    };
    const proposal = await runTauriAudioAlignment(request, (received) =>
      Promise.resolve({
        anchors: [{ id: "a", sourceMs: 1000, targetMs: 2000, origin: "automatic", confidence: 0.9 }],
        cutCandidates: [],
        confidence: received.completePath === "full.mp4" ? 1 : 0,
        diagnostics: []
      })
    );

    expect(proposal.anchors).toHaveLength(1);
    expect(proposal.confidence).toBe(1);
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
          message: "正在提取完整片源音频特征。",
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
          proposal: null,
          error: null,
          updatedAtMs: 3
        })
    };

    await expect(startTauriAudioAlignmentJob(request, invoker)).resolves.toMatchObject({
      jobId: "job-1",
      status: "running"
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
