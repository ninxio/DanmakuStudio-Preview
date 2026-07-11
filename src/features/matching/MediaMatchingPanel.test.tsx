import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CUT_HINT_SEARCH_SETTINGS,
  type SuspectedCutCandidate
} from "../../domain/danmaku/cutHints";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { serializeProject } from "../../domain/project/schema";
import { createDanmakuSourceSegment } from "../../domain/project/sourceTimeline";
import type {
  EditorProject,
  ProjectMediaReference,
  ProjectMediaRole
} from "../../domain/project/types";
import type { AlignmentProposal } from "../../domain/alignment/types";
import {
  cancelTauriAudioAlignmentJob,
  startTauriAudioAlignmentJob,
  type AudioAlignmentJobSnapshot
} from "../../infrastructure/alignment/tauriAudioAlignment";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "../../stores/editorStore";
import { MediaMatchingPanel } from "./MediaMatchingPanel";

vi.mock("../../infrastructure/alignment/tauriAudioAlignment", async () => {
  const actual = await vi.importActual("../../infrastructure/alignment/tauriAudioAlignment");
  return {
    ...actual,
    startTauriAudioAlignmentJob: vi.fn(),
    getTauriAudioAlignmentJob: vi.fn(),
    cancelTauriAudioAlignmentJob: vi.fn()
  };
});

describe("多媒体自动匹配工作台", () => {
  beforeEach(() => {
    const project = createMatchingProject();
    useEditorStore.setState({
      project,
      selection: { kind: "none", ids: [] },
      history: createHistoryState(),
      isPlaying: false,
      status: { message: "准备就绪", tone: "neutral" },
      importProgress: null,
      exportDraft: null,
      alignmentProposal: null,
      cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS },
      timelineTool: "select",
      workspacePage: "matching"
    });
    vi.mocked(startTauriAudioAlignmentJob).mockImplementation((request) =>
      Promise.resolve({
        jobId: request.completePath.includes("ep1") ? "job-ep1" : "job-ep2",
        status: "completed",
        progress: 1,
        message: "完成",
        logs: ["使用缓存音频特征"],
        proposal: createProposal(request.completePath.includes("ep1") ? 0 : 60_000),
        error: null,
        updatedAtMs: 1
      })
    );
    vi.mocked(cancelTauriAudioAlignmentJob).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("直接使用项目素材批量生成并确认一对多候选", async () => {
    render(<MatchingHarness />);

    await waitFor(() => expect(screen.getByText(/共 2 组/)).toBeInTheDocument());
    expect(screen.queryByLabelText("完整版输入")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "选择当前视频" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));

    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );
    expect(startTauriAudioAlignmentJob).toHaveBeenCalledTimes(2);
    expect(startTauriAudioAlignmentJob).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sourcePath: "D:\\video\\collection.mkv",
        completePath: "D:\\video\\ep1.mkv",
        localizationMode: true
      })
    );
    expect(screen.getAllByTestId("media-match-candidate")).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "确认并生成来源段" })[0]);
    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(1)
    );
    fireEvent.click(screen.getAllByRole("button", { name: "确认并生成来源段" })[0]);

    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(2)
    );
    expect(
      useEditorStore
        .getState()
        .project.danmakuSourceSegments.map((segment) => segment.targetMediaId)
    ).toEqual(expect.arrayContaining(["target-ep1", "target-ep2"]));
    expect(useEditorStore.getState().project.cutMarkers).toEqual([]);
    expect(useEditorStore.getState().project.syncAnchors).toEqual([]);

    const revokeButtons = screen.getAllByRole("button", { name: "撤销确认并删除来源段" });
    expect(revokeButtons).toHaveLength(2);
    fireEvent.click(revokeButtons[0]);
    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(1)
    );
    expect(
      useEditorStore
        .getState()
        .project.mediaMatchCandidates.map((candidate) => candidate.state)
        .sort()
    ).toEqual(["accepted", "pending"]);
  });

  it("缺少本地路径的素材会禁用并提示回素材页重连", async () => {
    const project = createMatchingProject();
    project.mediaLibrary[0] = {
      ...project.mediaLibrary[0],
      localPath: null,
      referenceKind: "browserFile",
      connectionState: "needsReconnect"
    };
    useEditorStore.setState({ project });

    render(<MatchingHarness />);

    expect(
      await screen.findByText("临时浏览器引用；自动匹配请回素材页删除后用桌面批量导入")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始批量匹配" })).toBeDisabled();
  });

  it("按多参考与多原片生成笛卡尔任务，单组失败后继续处理其余组合", async () => {
    const project = createMatchingProject();
    addSecondSource(project);
    useEditorStore.setState({ project });
    vi.mocked(startTauriAudioAlignmentJob)
      .mockRejectedValueOnce(new Error("第一组音轨不可用"))
      .mockImplementation((request) =>
        Promise.resolve({
          jobId: `job-${request.sourcePath}-${request.completePath}`,
          status: "completed",
          progress: 1,
          message: "完成",
          logs: [],
          proposal: createProposal(request.completePath.includes("ep1") ? 0 : 60_000),
          error: null,
          updatedAtMs: 1
        })
      );

    render(<MatchingHarness />);

    await waitFor(() => expect(screen.getByText(/共 4 组/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));

    await waitFor(() => expect(startTauriAudioAlignmentJob).toHaveBeenCalledTimes(4));
    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(3)
    );
    expect(
      vi
        .mocked(startTauriAudioAlignmentJob)
        .mock.calls.map(([request]) => [request.sourcePath, request.completePath])
    ).toEqual([
      ["D:\\video\\collection.mkv", "D:\\video\\ep1.mkv"],
      ["D:\\video\\collection.mkv", "D:\\video\\ep2.mkv"],
      ["D:\\video\\collection-b.mkv", "D:\\video\\ep1.mkv"],
      ["D:\\video\\collection-b.mkv", "D:\\video\\ep2.mkv"]
    ]);
    expect(
      within(screen.getByLabelText("批量匹配任务")).getByText("第一组音轨不可用")
    ).toBeInTheDocument();
    expect(useEditorStore.getState().status.message).toBe(
      "批量匹配完成：4 组中新找到 3 个候选。"
    );
  });

  it("取消后可继续剩余任务，并始终跳过已有候选组合", async () => {
    const project = createMatchingProject();
    project.mediaLibrary.push(
      createMedia("target-ep3", "targetOriginal", "D:\\video\\ep3.mkv", 60_000)
    );
    useEditorStore.setState({ project });
    vi.mocked(startTauriAudioAlignmentJob)
      .mockResolvedValueOnce({
        jobId: "job-completed",
        status: "completed",
        progress: 1,
        message: "完成",
        logs: [],
        proposal: createProposal(0),
        error: null,
        updatedAtMs: 1
      })
      .mockResolvedValueOnce({
        jobId: "job-cancel",
        status: "running",
        progress: 0.4,
        message: "正在分析第二组",
        logs: [],
        proposal: null,
        error: null,
        updatedAtMs: 2
      });
    vi.mocked(cancelTauriAudioAlignmentJob).mockResolvedValue({
      jobId: "job-cancel",
      status: "cancelled",
      progress: 0.4,
      message: "已取消",
      logs: [],
      proposal: null,
      error: null,
      updatedAtMs: 3
    });

    render(<MatchingHarness />);

    await waitFor(() => expect(screen.getByText(/共 3 组/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));
    await screen.findByText("正在分析第二组");
    fireEvent.click(screen.getByRole("button", { name: "取消剩余任务" }));

    await waitFor(() =>
      expect(cancelTauriAudioAlignmentJob).toHaveBeenCalledWith("job-cancel")
    );
    await waitFor(() =>
      expect(useEditorStore.getState().status.message).toContain("批量匹配已取消")
    );
    expect(startTauriAudioAlignmentJob).toHaveBeenCalledTimes(2);
    expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(1);
    const taskList = screen.getByLabelText("批量匹配任务");
    expect(within(taskList).getByText("批次已取消")).toBeInTheDocument();
    expect(within(taskList).getAllByText("已取消").length).toBeGreaterThanOrEqual(2);

    const continueButton = await screen.findByRole("button", { name: "继续剩余任务" });
    vi.mocked(startTauriAudioAlignmentJob).mockImplementation((request) =>
      Promise.resolve({
        jobId: `job-resume-${request.completePath}`,
        status: "completed",
        progress: 1,
        message: "完成",
        logs: [],
        proposal: createProposal(request.completePath.includes("ep2") ? 60_000 : 120_000),
        error: null,
        updatedAtMs: 4
      })
    );

    fireEvent.click(continueButton);

    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(3)
    );
    await waitFor(() => expect(startTauriAudioAlignmentJob).toHaveBeenCalledTimes(4));
    expect(
      vi.mocked(startTauriAudioAlignmentJob).mock.calls.map(([request]) => request.completePath)
    ).toEqual([
      "D:\\video\\ep1.mkv",
      "D:\\video\\ep2.mkv",
      "D:\\video\\ep2.mkv",
      "D:\\video\\ep3.mkv"
    ]);
    expect(screen.getByRole("button", { name: "开始批量匹配" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));

    await waitFor(() =>
      expect(useEditorStore.getState().status.message).toBe(
        "所选 3 组素材已有候选或确认关系，无需重复分析。"
      )
    );
    expect(startTauriAudioAlignmentJob).toHaveBeenCalledTimes(4);
    expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(3);
  });

  it("旧项目已有确认来源段但没有候选记录时跳过对应素材对", async () => {
    const project = createMatchingProject();
    project.danmakuSourceSegments = [
      createDanmakuSourceSegment("legacy-segment", {
        kind: "content",
        assetId: "asset-long",
        sourceMediaId: "source-long",
        sourceStartMs: 0,
        sourceEndMs: 60_000,
        targetMediaId: "target-ep1",
        targetStartMs: 0,
        timingRules: [],
        episodeKey: null,
        episodeLabel: null
      })
    ];
    useEditorStore.setState({ project });
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));

    await waitFor(() => expect(startTauriAudioAlignmentJob).toHaveBeenCalledTimes(1));
    expect(startTauriAudioAlignmentJob).toHaveBeenCalledWith(
      expect.objectContaining({ completePath: "D:\\video\\ep2.mkv" })
    );
    expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(1);
    expect(useEditorStore.getState().project.mediaMatchCandidates[0].targetMediaId).toBe(
      "target-ep2"
    );
    expect(
      within(screen.getByLabelText("批量匹配任务")).getByText(
        "已有候选或已确认关系，未重复分析"
      )
    ).toBeInTheDocument();
  });

  it("批量确认严格采用每张候选卡的 XML 勾选，并在已确认关系显示段名和 XML", async () => {
    const project = createMatchingProject();
    const extraAsset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="20,1,25,16777215,0,0,u,r">附加弹幕</d></i>`,
      { assetId: "asset-extra", fileName: "collection-extra.xml" }
    );
    project.assets.push(extraAsset);
    project.danmakuSourceBindings.push({
      id: "binding-extra",
      assetId: extraAsset.id,
      sourceMediaId: "source-long",
      linkedAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });
    useEditorStore.setState({ project });
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(screen.getAllByTestId("media-match-candidate")).toHaveLength(2));
    const episodeOneCard = screen
      .getAllByTestId("media-match-candidate")
      .find((card) => card.textContent?.includes("target-ep1"));
    expect(episodeOneCard).toBeDefined();
    fireEvent.click(within(episodeOneCard!).getByLabelText("collection-extra.xml"));

    fireEvent.click(screen.getByRole("button", { name: "按各卡勾选确认高可信候选（2）" }));

    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(3)
    );
    const segments = useEditorStore.getState().project.danmakuSourceSegments;
    expect(
      segments
        .filter((segment) => segment.targetMediaId === "target-ep1")
        .map((segment) => segment.assetId)
    ).toEqual(["asset-long"]);
    expect(
      segments
        .filter((segment) => segment.targetMediaId === "target-ep2")
        .map((segment) => segment.assetId)
        .sort()
    ).toEqual(["asset-extra", "asset-long"]);
    expect(useEditorStore.getState().status.message).toContain("已按各卡 XML 勾选确认 2 个");

    const confirmedRelations = screen.getByTestId("confirmed-media-relations");
    expect(
      within(confirmedRelations).getByText("target-ep1 · collection.xml")
    ).toBeInTheDocument();
    expect(within(confirmedRelations).getAllByText("作用 XML：collection.xml")).toHaveLength(2);
    expect(
      within(confirmedRelations).getByText("作用 XML：collection-extra.xml")
    ).toBeInTheDocument();
  });

  it("批量确认遇到已有重叠来源段时只统计真正接受的候选", async () => {
    render(<MatchingHarness />);
    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );
    act(() =>
      useEditorStore.getState().addDanmakuSourceSegment({
        label: "人工已确认第一集",
        kind: "content",
        assetId: "asset-long",
        sourceMediaId: "source-long",
        sourceStartMs: 0,
        sourceEndMs: 60_000,
        targetMediaId: "target-ep1",
        targetStartMs: 0,
        timingRules: [],
        episodeKey: null,
        episodeLabel: null
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "按各卡勾选确认高可信候选（2）" }));

    await waitFor(() =>
      expect(
        useEditorStore
          .getState()
          .project.mediaMatchCandidates.map((candidate) => candidate.state)
          .sort()
      ).toEqual(["accepted", "pending"])
    );
    expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(2);
    expect(useEditorStore.getState().status.message).toContain("确认 1 个高可信候选");
    expect(useEditorStore.getState().status.message).toContain(
      "1 个因已有重叠关系或校验失败而未确认"
    );
    expect(useEditorStore.getState().status.tone).toBe("warning");
  });

  it("每组自动匹配只融合当前参考素材所绑定 XML 的弹幕证据", async () => {
    const project = createMatchingProject();
    addSecondSource(project);
    project.mediaLibrary = project.mediaLibrary.filter((media) => media.id !== "target-ep2");
    useEditorStore.setState({ project });
    vi.mocked(startTauriAudioAlignmentJob).mockImplementation((request) =>
      Promise.resolve({
        jobId: `job-${request.sourcePath}`,
        status: "completed",
        progress: 1,
        message: "完成",
        logs: [],
        proposal: createProposalWithCut(),
        error: null,
        updatedAtMs: 1
      })
    );
    render(
      <MatchingHarness
        suspectedCutCandidates={[
          createSuspectedCut("hint-a", "asset-long", "collection.xml", 100_000),
          createSuspectedCut("hint-b", "asset-long-b", "collection-b.xml", 20_000)
        ]}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );
    const candidates = useEditorStore.getState().project.mediaMatchCandidates;
    const sourceA = candidates.find((candidate) => candidate.sourceMediaId === "source-long");
    const sourceB = candidates.find((candidate) => candidate.sourceMediaId === "source-long-b");
    expect(sourceA?.proposal.cutCandidates[0]?.confidence).toBe(0.72);
    expect(sourceA?.proposal.diagnostics).toContain(
      "弹幕证据：未发现与候选版本差异相邻的文本聚类。"
    );
    expect(sourceB?.proposal.cutCandidates[0]?.confidence).toBeCloseTo(0.75);
    expect(sourceB?.proposal.diagnostics).toContain(
      "弹幕证据：1 个文本聚类支持 1 个候选版本差异。"
    );
    expect(
      candidates.map(
        (candidate) =>
          candidate.proposal.evidence?.signals?.find((signal) => signal.kind === "danmaku")
            ?.observations
      )
    ).toEqual([1, 1]);
  });

  it("在启动接口返回 jobId 前取消，拿到 jobId 后仍会取消后端任务且不落候选", async () => {
    const startDeferred = createDeferred<AudioAlignmentJobSnapshot>();
    vi.mocked(startTauriAudioAlignmentJob).mockReturnValue(startDeferred.promise);
    vi.mocked(cancelTauriAudioAlignmentJob).mockResolvedValue({
      jobId: "job-returned-after-cancel",
      status: "cancelled",
      progress: 0,
      message: "已取消",
      logs: [],
      proposal: null,
      error: null,
      updatedAtMs: 2
    });
    render(<MatchingHarness />);

    await waitFor(() => expect(screen.getByText(/共 2 组/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(startTauriAudioAlignmentJob).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "取消剩余任务" }));
    expect(cancelTauriAudioAlignmentJob).not.toHaveBeenCalled();

    startDeferred.resolve({
      jobId: "job-returned-after-cancel",
      status: "running",
      progress: 0,
      message: "后端任务刚刚启动",
      logs: [],
      proposal: null,
      error: null,
      updatedAtMs: 1
    });

    await waitFor(() =>
      expect(cancelTauriAudioAlignmentJob).toHaveBeenCalledWith("job-returned-after-cancel")
    );
    await waitFor(() =>
      expect(useEditorStore.getState().status.message).toContain("批量匹配已取消")
    );
    expect(useEditorStore.getState().project.mediaMatchCandidates).toEqual([]);
  });

  it("组件卸载会取消活动中的后端任务，并阻止迟到候选写入项目", async () => {
    vi.mocked(startTauriAudioAlignmentJob).mockResolvedValue({
      jobId: "job-active-on-unmount",
      status: "running",
      progress: 0.25,
      message: "后端任务运行中",
      logs: [],
      proposal: null,
      error: null,
      updatedAtMs: 1
    });
    vi.mocked(cancelTauriAudioAlignmentJob).mockResolvedValue({
      jobId: "job-active-on-unmount",
      status: "cancelled",
      progress: 0.25,
      message: "已取消",
      logs: [],
      proposal: null,
      error: null,
      updatedAtMs: 2
    });
    const { unmount } = render(<MatchingHarness />);

    await waitFor(() => expect(screen.getByText(/共 2 组/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));
    await screen.findByText("后端任务运行中");

    unmount();

    await waitFor(() =>
      expect(cancelTauriAudioAlignmentJob).toHaveBeenCalledWith("job-active-on-unmount")
    );
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    expect(useEditorStore.getState().project.mediaMatchCandidates).toEqual([]);
  });

  it("运行中打开同 ID 的另一项目版本会取消旧任务且不跨项目写入候选或状态", async () => {
    const startDeferred = createDeferred<AudioAlignmentJobSnapshot>();
    vi.mocked(startTauriAudioAlignmentJob).mockReturnValue(startDeferred.promise);
    vi.mocked(cancelTauriAudioAlignmentJob).mockResolvedValue({
      jobId: "job-from-old-project",
      status: "cancelled",
      progress: 0,
      message: "已取消",
      logs: [],
      proposal: null,
      error: null,
      updatedAtMs: 2
    });
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(startTauriAudioAlignmentJob).toHaveBeenCalledTimes(1));

    const previousProject = useEditorStore.getState().project;
    const replacement = createMatchingProject();
    replacement.id = previousProject.id;
    replacement.name = "同 ID 的重开版本";
    replacement.mediaLibrary = replacement.mediaLibrary.map((media) =>
      media.id === "source-long" ? { ...media, localPath: "D:\\video\\replacement.mkv" } : media
    );
    act(() =>
      useEditorStore
        .getState()
        .openProjectFromText(serializeProject(replacement), "replacement.json")
    );

    startDeferred.resolve({
      jobId: "job-from-old-project",
      status: "running",
      progress: 0.3,
      message: "旧项目任务迟到",
      logs: [],
      proposal: null,
      error: null,
      updatedAtMs: 1
    });

    await waitFor(() =>
      expect(cancelTauriAudioAlignmentJob).toHaveBeenCalledWith("job-from-old-project")
    );
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    expect(useEditorStore.getState().project.name).toBe("同 ID 的重开版本");
    expect(useEditorStore.getState().project.mediaMatchCandidates).toEqual([]);
    expect(useEditorStore.getState().status.message).toContain("已打开项目");
  });

  it("旧项目 start 迟到时不会覆盖新批次活动 job，取消仍终止新任务", async () => {
    const oldStartDeferred = createDeferred<AudioAlignmentJobSnapshot>();
    vi.mocked(startTauriAudioAlignmentJob)
      .mockReturnValueOnce(oldStartDeferred.promise)
      .mockResolvedValueOnce({
        jobId: "job-new-project",
        status: "running",
        progress: 0.2,
        message: "新项目任务运行中",
        logs: [],
        proposal: null,
        error: null,
        updatedAtMs: 2
      });
    vi.mocked(cancelTauriAudioAlignmentJob).mockImplementation((jobId) =>
      Promise.resolve({
        jobId,
        status: "cancelled",
        progress: 0.2,
        message: "已取消",
        logs: [],
        proposal: null,
        error: null,
        updatedAtMs: 3
      })
    );
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(startTauriAudioAlignmentJob).toHaveBeenCalledTimes(1));

    const replacement = createMatchingProject();
    replacement.id = useEditorStore.getState().project.id;
    replacement.name = "并发切换后的项目";
    act(() =>
      useEditorStore
        .getState()
        .openProjectFromText(serializeProject(replacement), "replacement.json")
    );
    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await screen.findByText("新项目任务运行中");

    oldStartDeferred.resolve({
      jobId: "job-old-project",
      status: "running",
      progress: 0.8,
      message: "旧项目任务迟到",
      logs: [],
      proposal: null,
      error: null,
      updatedAtMs: 1
    });
    await waitFor(() =>
      expect(cancelTauriAudioAlignmentJob).toHaveBeenCalledWith("job-old-project")
    );
    expect(screen.queryByText("旧项目任务迟到")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消剩余任务" }));
    await waitFor(() =>
      expect(cancelTauriAudioAlignmentJob).toHaveBeenCalledWith("job-new-project")
    );
    expect(useEditorStore.getState().project.name).toBe("并发切换后的项目");
    expect(useEditorStore.getState().project.mediaMatchCandidates).toEqual([]);
  });

  it("打开同项目 ID 但媒体 ID 已变化的版本时重新默认选择全部新素材", async () => {
    render(<MatchingHarness />);
    await waitFor(() => expect(screen.getByText(/共 2 组/)).toBeInTheDocument());

    const replacement = createMatchingProject();
    replacement.id = useEditorStore.getState().project.id;
    replacement.mediaLibrary = [
      createMedia(
        "source-reopened",
        "bilibiliReference",
        "D:\\video\\reopened-source.mkv",
        180_000
      ),
      createMedia("target-reopened", "targetOriginal", "D:\\video\\reopened-target.mkv", 60_000)
    ];
    replacement.danmakuSourceBindings = replacement.danmakuSourceBindings.map((binding) => ({
      ...binding,
      sourceMediaId: "source-reopened"
    }));
    act(() =>
      useEditorStore
        .getState()
        .openProjectFromText(serializeProject(replacement), "reopened.json")
    );

    await waitFor(() =>
      expect(screen.getByText(/将分析 1 个参考 × 1 个原片，共 1 组/)).toBeInTheDocument()
    );
  });
});

function MatchingHarness({
  suspectedCutCandidates = []
}: {
  suspectedCutCandidates?: SuspectedCutCandidate[];
}) {
  const project = useEditorStore((state) => state.project);
  return (
    <MediaMatchingPanel project={project} suspectedCutCandidates={suspectedCutCandidates} />
  );
}

function createMatchingProject(): EditorProject {
  const project = createEmptyProject("暗黑 S01");
  const asset = parseBilibiliXml(
    `<?xml version="1.0" encoding="UTF-8"?><i><d p="10,1,25,16777215,0,0,u,r">测试</d></i>`,
    { assetId: "asset-long", fileName: "collection.xml" }
  );
  project.assets = [asset];
  project.mediaLibrary = [
    createMedia("source-long", "bilibiliReference", "D:\\video\\collection.mkv", 180_000),
    createMedia("target-ep1", "targetOriginal", "D:\\video\\ep1.mkv", 60_000),
    createMedia("target-ep2", "targetOriginal", "D:\\video\\ep2.mkv", 60_000)
  ];
  project.danmakuSourceBindings = [
    {
      id: "binding-long",
      assetId: asset.id,
      sourceMediaId: "source-long",
      linkedAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    }
  ];
  return project;
}

function addSecondSource(project: EditorProject): void {
  const asset = parseBilibiliXml(
    `<?xml version="1.0" encoding="UTF-8"?><i><d p="15,1,25,16777215,0,0,u,r">测试 B</d></i>`,
    { assetId: "asset-long-b", fileName: "collection-b.xml" }
  );
  project.assets.push(asset);
  project.mediaLibrary.push(
    createMedia("source-long-b", "bilibiliReference", "D:\\video\\collection-b.mkv", 180_000)
  );
  project.danmakuSourceBindings.push({
    id: "binding-long-b",
    assetId: asset.id,
    sourceMediaId: "source-long-b",
    linkedAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z"
  });
}

function createMedia(
  id: string,
  role: ProjectMediaRole,
  localPath: string,
  durationMs: number
): ProjectMediaReference {
  return {
    id,
    role,
    name: id,
    fileName: localPath.split("\\").at(-1) ?? id,
    objectUrl: null,
    durationMs,
    referenceKind: "localPath",
    connectionState: "connected",
    sourceSummary: "本地文件路径",
    localPath,
    emby: null,
    episodeKey: role === "targetOriginal" ? id : null,
    episodeLabel: role === "targetOriginal" ? id : null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z"
  };
}

function createProposal(sourceStartMs: number): AlignmentProposal {
  return {
    anchors: [
      {
        id: "audio-anchor-1",
        sourceMs: sourceStartMs,
        targetMs: 0,
        origin: "automatic",
        confidence: 0.9
      },
      {
        id: "audio-anchor-2",
        sourceMs: sourceStartMs + 50_000,
        targetMs: 50_000,
        origin: "automatic",
        confidence: 0.9
      }
    ],
    cutCandidates: [],
    confidence: 0.9,
    diagnostics: ["长参考定位成功"],
    matchRange: {
      sourceStartMs,
      sourceEndMs: sourceStartMs + 60_000,
      targetStartMs: 0,
      targetEndMs: 60_000,
      coverage: 0.9
    }
  };
}

function createProposalWithCut(): AlignmentProposal {
  return {
    anchors: [],
    cutCandidates: [
      {
        id: "audio-gap",
        name: "音频差异",
        sourceAtMs: 20_000,
        sourceRangeStartMs: 19_000,
        sourceRangeEndMs: 21_000,
        targetGapMs: 5_000,
        confidence: 0.72,
        note: "音频候选"
      }
    ],
    confidence: 0.9,
    diagnostics: [],
    matchRange: {
      sourceStartMs: 0,
      sourceEndMs: 60_000,
      targetStartMs: 0,
      targetEndMs: 60_000,
      coverage: 0.9
    },
    evidence: {
      algorithm: "time-map-audio",
      completeFingerprintCount: 10,
      sourceFingerprintCount: 8,
      fingerprintMatchCount: 8,
      monotonicMatchCount: 8,
      strongAnchorCount: 6,
      weakAnchorCount: 2,
      offsetClusterCount: 2,
      refinedCandidateCount: 1,
      lowConfidenceRegionCount: 0,
      quality: "medium",
      timeMappingSegmentCount: 2,
      confirmedChangeCount: 1,
      signals: []
    }
  };
}

function createSuspectedCut(
  id: string,
  assetId: string,
  assetFileName: string,
  sourceAtMs: number
): SuspectedCutCandidate {
  return {
    id,
    assetId,
    assetFileName,
    sourceAtMs,
    startMs: sourceAtMs - 1_000,
    endMs: sourceAtMs + 1_000,
    hitCount: 2,
    score: 6,
    confidence: "medium",
    keywords: ["删了"],
    sampleTexts: ["这里是不是删了"],
    itemIds: [`${assetId}-item`]
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
