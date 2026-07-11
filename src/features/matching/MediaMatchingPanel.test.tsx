import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  MediaTimeMapQualityLevel,
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
    expect(useEditorStore.getState().status.message).toBe(
      "批量匹配完成：pairwise 找到 2、全局采用 2、阻断备选 0。"
    );
    expect(
      useEditorStore
        .getState()
        .project.mediaMatchCandidates.every(
          (candidate) =>
            candidate.state === "pending" &&
            candidate.proposal.diagnostics.includes("全局分配：进入本批次最佳无冲突组合。")
        )
    ).toBe(true);

    fireEvent.click(screen.getAllByRole("button", { name: "保存关系供试听复核" })[0]);
    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(1)
    );
    fireEvent.click(screen.getAllByRole("button", { name: "保存关系供试听复核" })[0]);

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
      "批量匹配完成：pairwise 找到 3、全局采用 1、阻断备选 2，1 组失败。"
    );
    expect(
      useEditorStore
        .getState()
        .project.mediaMatchCandidates.every((candidate) => candidate.state === "blocked")
    ).toBe(false);
    expect(
      useEditorStore
        .getState()
        .project.mediaMatchCandidates.filter((candidate) => candidate.state === "blocked")
    ).toHaveLength(2);
  });

  it("多条参考竞争同一原片重叠区间时全局择优并阻断弱 V2 备选", async () => {
    const project = createMatchingProject();
    addSecondSource(project);
    project.mediaLibrary = project.mediaLibrary.filter((media) => media.id !== "target-ep2");
    useEditorStore.setState({ project });
    vi.mocked(startTauriAudioAlignmentJob).mockImplementation((request) => {
      const probability = request.sourcePath.includes("collection-b") ? 0.62 : 0.999;
      return Promise.resolve({
        jobId: `job-n-to-1-${probability}`,
        status: "completed",
        progress: 1,
        message: "完成",
        logs: [],
        proposal: createV2ProposalWithProbability(0, probability),
        error: null,
        updatedAtMs: 1
      });
    });
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );

    const candidates = useEditorStore.getState().project.mediaMatchCandidates;
    const strong = candidates.find((candidate) => candidate.sourceMediaId === "source-long");
    const weak = candidates.find((candidate) => candidate.sourceMediaId === "source-long-b");
    expect(strong).toMatchObject({
      state: "pending",
      proposal: { timeMap: { quality: { level: "verified" } } }
    });
    expect(weak).toMatchObject({
      state: "blocked",
      proposal: { timeMap: { quality: { level: "blocked", probability: null } } }
    });
    expect(weak?.proposal.timeMap?.quality.reasons.join(" ")).toContain("同一原片时间范围冲突");
    expect(useEditorStore.getState().status.message).toBe(
      "批量匹配完成：pairwise 找到 2、全局采用 1、阻断备选 1。"
    );
    const taskList = screen.getByLabelText("批量匹配任务");
    expect(within(taskList).getByText(/全局采用/)).toBeInTheDocument();
    expect(within(taskList).getByText(/全局阻断备选/)).toBeInTheDocument();
    const weakCard = screen
      .getAllByTestId("media-match-candidate")
      .find((card) => card.textContent?.includes("source-long-b"));
    expect(weakCard).toBeDefined();
    expect(within(weakCard!).getAllByText("已阻断").length).toBeGreaterThanOrEqual(1);
    expect(within(weakCard!).getByRole("button", { name: "此候选不能确认" })).toBeDisabled();
  });

  it("N×M 全局分配选择无冲突最佳组合并保留旧引擎阻断备选", async () => {
    const project = createMatchingProject();
    addSecondSource(project);
    useEditorStore.setState({ project });
    const scores = new Map([
      ["collection.mkv|ep1.mkv", 0.98],
      ["collection.mkv|ep2.mkv", 0.2],
      ["collection-b.mkv|ep1.mkv", 0.1],
      ["collection-b.mkv|ep2.mkv", 0.9]
    ]);
    vi.mocked(startTauriAudioAlignmentJob).mockImplementation((request) => {
      const sourceName = request.sourcePath.split("\\").at(-1) ?? "";
      const targetName = request.completePath.split("\\").at(-1) ?? "";
      const proposal = createProposal(0);
      proposal.confidence = scores.get(`${sourceName}|${targetName}`) ?? 0;
      return Promise.resolve({
        jobId: `job-nxm-${sourceName}-${targetName}`,
        status: "completed",
        progress: 1,
        message: "完成",
        logs: [],
        proposal,
        error: null,
        updatedAtMs: 1
      });
    });
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(4)
    );

    const candidates = useEditorStore.getState().project.mediaMatchCandidates;
    const adoptedPairs = candidates
      .filter((candidate) => candidate.state === "pending")
      .map((candidate) => `${candidate.sourceMediaId}->${candidate.targetMediaId}`)
      .sort();
    const blocked = candidates.filter((candidate) => candidate.state === "blocked");
    expect(adoptedPairs).toEqual(["source-long->target-ep1", "source-long-b->target-ep2"]);
    expect(blocked).toHaveLength(2);
    expect(
      blocked.every(
        (candidate) =>
          candidate.proposal.timeMap?.engineVersion === "legacy-global-guard-v1" &&
          candidate.proposal.timeMap.quality.level === "blocked" &&
          candidate.proposal.timeMap.quality.probability === null &&
          candidate.proposal.timeMap.spans[0]?.kind === "ambiguous" &&
          candidate.proposal.diagnostics.some((line) => line.includes("全局分配阻断"))
      )
    ).toBe(true);
    expect(useEditorStore.getState().status.message).toBe(
      "批量匹配完成：pairwise 找到 4、全局采用 2、阻断备选 2。"
    );
  });

  it("全局 Top1/Top2 近同分时不假装唯一并阻断全部 V2 候选", async () => {
    const project = createMatchingProject();
    addSecondSource(project);
    project.mediaLibrary = project.mediaLibrary.filter((media) => media.id !== "target-ep2");
    useEditorStore.setState({ project });
    vi.mocked(startTauriAudioAlignmentJob).mockImplementation((request) => {
      const probability = request.sourcePath.includes("collection-b") ? 0.895 : 0.9;
      return Promise.resolve({
        jobId: `job-ambiguous-${probability}`,
        status: "completed",
        progress: 1,
        message: "完成",
        logs: [],
        proposal: createV2ProposalWithProbability(0, probability),
        error: null,
        updatedAtMs: 1
      });
    });
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );

    const candidates = useEditorStore.getState().project.mediaMatchCandidates;
    expect(
      candidates.every(
        (candidate) =>
          candidate.state === "blocked" &&
          candidate.proposal.timeMap?.quality.level === "blocked" &&
          candidate.proposal.timeMap.quality.probability === null &&
          candidate.proposal.timeMap.quality.reasons.some((reason) =>
            reason.includes("全局 Top1/Top2")
          )
      )
    ).toBe(true);
    expect(useEditorStore.getState().status.message).toBe(
      "批量匹配完成：pairwise 找到 2、全局采用 0、阻断备选 2。"
    );
    expect(
      within(screen.getByLabelText("批量匹配任务")).getAllByText(/全局 Top1\/Top2/)
    ).toHaveLength(2);
    screen.getAllByRole("button", { name: "此候选不能确认" }).forEach((button) => {
      expect(button).toBeDisabled();
    });
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
    expect(useEditorStore.getState().project.mediaMatchCandidates).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "取消剩余任务" }));

    await waitFor(() =>
      expect(cancelTauriAudioAlignmentJob).toHaveBeenCalledWith("job-cancel")
    );
    await waitFor(() =>
      expect(useEditorStore.getState().status.message).toContain("批量匹配已取消")
    );
    expect(useEditorStore.getState().status.message).toContain(
      "pairwise 找到 1、全局采用 1、阻断备选 0"
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

    const legacyQuality = screen.getByTestId("confirmed-time-map-quality");
    expect(legacyQuality).toHaveTextContent("确认时间图缺失");
    expect(legacyQuality).toHaveTextContent("导出闸门：已阻断");
    expect(legacyQuality).toHaveTextContent("正式导出已停用旧规则兼容投影");

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

  it("明确警告旧引擎未经真实媒体精度基准，并且不提供高可信批量确认", async () => {
    render(<MatchingHarness />);

    const warning = screen.getByTestId("legacy-alignment-warning");
    expect(warning).toHaveTextContent("实验性定位线索");
    expect(warning).toHaveTextContent("尚未通过真实媒体精度基准");
    expect(warning).toHaveTextContent("必须逐项试听或预览复核");
    expect(warning).toHaveTextContent("自动结果不能直接作为导出依据");
    expect(screen.queryByText(/高可信候选/)).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(screen.getAllByTestId("media-match-candidate")).toHaveLength(2));

    expect(screen.getAllByText("旧引擎分数 90% · 未校准")).toHaveLength(2);
    expect(screen.queryByText(/高可信候选/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /批量.*确认|确认.*高可信/ })
    ).not.toBeInTheDocument();
    expect(
      useEditorStore.getState().project.mediaMatchCandidates.map((candidate) => candidate.state)
    ).toEqual(["pending", "pending"]);
  });

  it.each([
    ["verified", "需复核", "保存关系供试听复核", false, "仍不能导出", true],
    ["review", "需复核", "保存关系供试听复核", false, "仍不能导出", false],
    ["blocked", "已阻断", "此候选不能确认", true, "不能确认，也不能导出", false],
    ["legacy-unverified", "旧版未验证", "保存关系供试听复核", false, "仍不能导出", false]
  ] as const)(
    "V2 自报质量等级 %s 经过 provenance 重算后显示对应导出闸门",
    async (level, label, buttonName, disabled, gateMessage, keepsReportedProbability) => {
      configureSingleTargetV2Project(level);
      render(<MatchingHarness />);

      fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
      const card = await screen.findByTestId("media-match-candidate");
      const qualityPanel = within(card).getByTestId("candidate-time-map-quality");
      const action = within(card).getByRole("button", { name: buttonName });

      expect(within(qualityPanel).getByTestId("time-map-quality-label")).toHaveTextContent(
        label
      );
      expect(qualityPanel).toHaveTextContent(gateMessage);
      expect(qualityPanel).toHaveTextContent(
        level === "verified" ? "校准概率：99.9%" : "校准概率：尚未完成真实基准校准"
      );
      expect(action).toHaveProperty("disabled", disabled);
      expect(qualityPanel).toHaveTextContent(
        keepsReportedProbability ? "可信验证记录" : gateMessage
      );
      if (level === "blocked") {
        fireEvent.click(action);
        expect(useEditorStore.getState().project.danmakuSourceSegments).toEqual([]);
      }
    }
  );

  it("在折叠详情展示 V2 指标、分段、音轨和主要原因", async () => {
    configureSingleTargetV2Project("verified");
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    const card = await screen.findByTestId("media-match-candidate");
    const qualityPanel = within(card).getByTestId("candidate-time-map-quality");

    expect(qualityPanel).toHaveTextContent("引擎 / 特征：alignment-v2.4 / chroma-v2");
    expect(qualityPanel).toHaveTextContent("覆盖率：96%");
    expect(qualityPanel).toHaveTextContent("P95 残差：80 毫秒");
    expect(qualityPanel).toHaveTextContent("边界不确定度：180 毫秒");
    expect(qualityPanel).toHaveTextContent("Top1/Top2 差距：32%");
    expect(qualityPanel).toHaveTextContent(
      "时间图片段：matched 1 · sourceOnly 0 · targetOnly 0 · ambiguous 0"
    );
    expect(qualityPanel).toHaveTextContent(
      "选中音轨：参考音轨 #1 · AAC · 48000 Hz · 2 声道 · zh · 国语；原片音轨 #2 · FLAC · 48000 Hz · 6 声道 · zh · 正片"
    );
    expect(qualityPanel).toHaveTextContent("双证据和留出锚点均达到门槛。");
    expect(within(qualityPanel).getByText("时间图证据详情")).toHaveClass(
      "focus-visible:outline"
    );
  });

  it("用双时间轴和结果语言展示四类分段，并让分段按钮可点击和键盘定位", async () => {
    const user = userEvent.setup();
    const project = createMatchingProject();
    project.mediaLibrary = project.mediaLibrary.filter((media) => media.id !== "target-ep2");
    useEditorStore.setState({ project });
    vi.mocked(startTauriAudioAlignmentJob).mockResolvedValue({
      jobId: "job-v2-four-span-kinds",
      status: "completed",
      progress: 1,
      message: "完成",
      logs: [],
      proposal: createFourKindV2Proposal(),
      error: null,
      updatedAtMs: 1
    });
    render(<MatchingHarness />);

    await user.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    const card = await screen.findByTestId("media-match-candidate");
    const review = within(card).getByTestId("time-map-review");
    const disclosure = within(review).getByText("来源↔原片时间图复核");

    expect(review).not.toHaveAttribute("open");
    expect(review).toHaveTextContent(
      "候选图 · 共同内容 1 · 参考独有 1 · 原片独有 1 · 无法判断 1"
    );
    await user.click(disclosure);

    expect(review).toHaveAttribute("open");
    expect(
      within(review).getByRole("img", { name: "来源与原片双时间轴分段图" })
    ).toBeInTheDocument();
    expect(within(review).getByText("参考轨道")).toBeInTheDocument();
    expect(within(review).getByText("原片轨道")).toBeInTheDocument();
    expect(review).toHaveTextContent("伸缩比例：1.000×");
    expect(review).toHaveTextContent("伸缩比例：不适用");
    expect(review).toHaveTextContent("边界不确定度：180 毫秒");
    expect(review).toHaveTextContent("P95 残差：80 毫秒");
    expect(review).toHaveTextContent("导出阻断原因：存在无法唯一解释的歧义区间。");

    const matchedButton = within(review).getByRole("button", {
      name: /第 1 段 共同内容.*定位到参考起点 00:00:05\.000/
    });
    const sourceOnlyButton = within(review).getByRole("button", {
      name: /第 2 段 参考独有.*定位到参考起点 00:00:15\.000/
    });
    expect(
      within(review).getByRole("button", { name: /第 3 段 原片独有/ })
    ).toBeInTheDocument();
    expect(
      within(review).getByRole("button", { name: /第 4 段 无法判断/ })
    ).toBeInTheDocument();

    await user.click(matchedButton);
    expect(useEditorStore.getState().project.timeline.playheadMs).toBe(5_000);
    expect(useEditorStore.getState().status.message).toContain(
      "仅完成时间定位，未执行 A/B 播放"
    );

    act(() => useEditorStore.getState().setPlaying(true));
    sourceOnlyButton.focus();
    await user.keyboard("{Enter}");
    expect(sourceOnlyButton).toHaveFocus();
    expect(useEditorStore.getState().project.timeline.playheadMs).toBe(15_000);
    expect(useEditorStore.getState().isPlaying).toBe(false);
    expect(useEditorStore.getState().status.message).toContain("第 2 段“参考独有”起点");
  });

  it("候选保存后卡片改用独立的已确认时间图复核", async () => {
    const user = userEvent.setup();
    configureSingleTargetV2Project("review");
    render(<MatchingHarness />);

    await user.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    const card = await screen.findByTestId("media-match-candidate");
    await user.click(within(card).getByRole("button", { name: "保存关系供试听复核" }));

    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates[0]?.state).toBe("accepted")
    );
    const acceptedReview = within(card).getByTestId("time-map-review");
    expect(acceptedReview).toHaveTextContent("已确认图 · 共同内容 1");
    expect(
      useEditorStore.getState().project.mediaMatchCandidates[0]?.confirmedTimeMapId
    ).not.toBeNull();
    expect(
      useEditorStore
        .getState()
        .project.mediaTimeMaps.find((timeMap) => timeMap.state === "confirmed")
    ).toBeDefined();
    expect(
      within(acceptedReview).getByRole("button", { name: /第 1 段 共同内容/ })
    ).toBeInTheDocument();
  });

  it("候选时间图缺失时明确报错并禁止确认", async () => {
    configureSingleTargetV2Project("verified");
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await screen.findByTestId("media-match-candidate");
    act(() => {
      useEditorStore.setState((state) => ({
        project: { ...state.project, mediaTimeMaps: [] }
      }));
    });

    const card = await screen.findByTestId("media-match-candidate");
    const qualityPanel = within(card).getByTestId("candidate-time-map-quality");
    expect(qualityPanel).toHaveTextContent("时间图缺失");
    expect(qualityPanel).toHaveTextContent("不能确认或导出");
    expect(within(card).getByTestId("time-map-review")).toHaveTextContent(
      "时间图缺失，无法安全绘制或定位分段"
    );
    expect(within(card).getByRole("button", { name: "此候选不能确认" })).toBeDisabled();
  });

  it("时间图分段越界时停止绘制和定位，不生成可误触的分段按钮", async () => {
    configureSingleTargetV2Project("review");
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await screen.findByTestId("media-match-candidate");
    act(() => {
      useEditorStore.setState((state) => {
        const timeMap = state.project.mediaTimeMaps[0];
        if (!timeMap || !timeMap.spans[0]) {
          throw new Error("测试候选缺少时间图分段。");
        }
        return {
          project: {
            ...state.project,
            mediaTimeMaps: [
              {
                ...timeMap,
                spans: [
                  {
                    ...timeMap.spans[0],
                    targetEndMs: timeMap.targetEndMs + 1_000
                  }
                ]
              }
            ]
          }
        };
      });
    });

    const review = screen.getByTestId("time-map-review");
    expect(review).toHaveAttribute("role", "alert");
    expect(review).toHaveTextContent("时间图结构无效，已停止绘制和定位");
    expect(review).toHaveTextContent("分段没有完整覆盖时间图声明的双方范围");
    expect(within(review).queryByRole("button")).not.toBeInTheDocument();
  });

  it("blocked 状态只有在质量阻断时显示已阻断，缺 XML 时仍显示缺少绑定", async () => {
    configureSingleTargetV2Project("verified");
    const project = useEditorStore.getState().project;
    useEditorStore.setState({
      project: { ...project, danmakuSourceBindings: [] }
    });
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    const card = await screen.findByTestId("media-match-candidate");

    expect(within(card).getByText("缺少 XML 绑定")).toBeInTheDocument();
    expect(within(card).queryByText("已阻断")).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "保存关系供试听复核" })).toBeDisabled();
  });

  it.each([
    ["verified", "review", "需复核", "保存关系供试听复核", "导出闸门：未通过", "仍不能导出"],
    ["review", "review", "需复核", "保存关系供试听复核", "导出闸门：未通过", "仍不能导出"],
    [
      "legacy-unverified",
      "legacy-unverified",
      "旧版未验证",
      "保存关系供试听复核",
      "导出闸门：未通过",
      "仍不能导出"
    ]
  ] as const)(
    "%s 候选保存后在已确认关系显示 provenance 重算后的确认图质量",
    async (level, expectedLevel, label, buttonName, gateText, message) => {
      configureSingleTargetV2Project(level);
      render(<MatchingHarness />);

      fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
      const card = await screen.findByTestId("media-match-candidate");
      fireEvent.click(within(card).getByRole("button", { name: buttonName }));

      const relations = await screen.findByTestId("confirmed-media-relations");
      const confirmedQuality = within(relations).getByTestId("confirmed-time-map-quality");
      expect(within(confirmedQuality).getByTestId("time-map-quality-label")).toHaveTextContent(
        label
      );
      expect(confirmedQuality).toHaveTextContent(gateText);
      expect(confirmedQuality).toHaveTextContent(message);
      expect(
        useEditorStore
          .getState()
          .project.mediaTimeMaps.find((timeMap) => timeMap.state === "confirmed")?.quality.level
      ).toBe(expectedLevel);
    }
  );

  it("候选只能逐卡确认，并严格采用当前卡片的 XML 勾选", async () => {
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
    fireEvent.click(
      within(episodeOneCard!).getByRole("button", { name: "保存关系供试听复核" })
    );

    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(1)
    );
    const segments = useEditorStore.getState().project.danmakuSourceSegments;
    expect(segments.map((segment) => segment.assetId)).toEqual(["asset-long"]);
    expect(segments[0]?.targetMediaId).toBe("target-ep1");
    expect(
      useEditorStore
        .getState()
        .project.mediaMatchCandidates.map((candidate) => candidate.state)
        .sort()
    ).toEqual(["accepted", "pending"]);

    const confirmedRelations = screen.getByTestId("confirmed-media-relations");
    expect(
      within(confirmedRelations).getByText("target-ep1 · collection.xml")
    ).toBeInTheDocument();
    expect(
      within(confirmedRelations).getByText("作用 XML：collection.xml")
    ).toBeInTheDocument();
    expect(
      within(confirmedRelations).queryByText("作用 XML：collection-extra.xml")
    ).not.toBeInTheDocument();
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

  it("组件卸载后即使迟到任务已经完成也不会写入全局候选", async () => {
    const startDeferred = createDeferred<AudioAlignmentJobSnapshot>();
    vi.mocked(startTauriAudioAlignmentJob).mockReturnValue(startDeferred.promise);
    const { unmount } = render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(startTauriAudioAlignmentJob).toHaveBeenCalledTimes(1));
    unmount();
    startDeferred.resolve({
      jobId: "job-completed-after-unmount",
      status: "completed",
      progress: 1,
      message: "完成",
      logs: [],
      proposal: createProposal(0),
      error: null,
      updatedAtMs: 1
    });

    await new Promise((resolve) => window.setTimeout(resolve, 50));
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

function configureSingleTargetV2Project(level: MediaTimeMapQualityLevel): void {
  const project = createMatchingProject();
  project.mediaLibrary = project.mediaLibrary.filter((media) => media.id !== "target-ep2");
  useEditorStore.setState({ project });
  vi.mocked(startTauriAudioAlignmentJob).mockResolvedValue({
    jobId: `job-v2-${level}`,
    status: "completed",
    progress: 1,
    message: "完成",
    logs: [],
    proposal: createV2Proposal(0, level),
    error: null,
    updatedAtMs: 1
  });
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
    contentIdentity: null,
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

function createV2Proposal(
  sourceStartMs: number,
  level: MediaTimeMapQualityLevel
): AlignmentProposal {
  const sourceEndMs = sourceStartMs + 60_000;
  const qualityReasons: Record<MediaTimeMapQualityLevel, string[]> = {
    verified: ["双证据和留出锚点均达到门槛。"],
    review: ["备选路径差距偏小，需要试听复核。"],
    blocked: ["存在无法唯一解释的歧义区间。"],
    "legacy-unverified": ["由旧版规则迁移，尚未经过真实媒体验证。"]
  };
  return {
    ...createProposal(sourceStartMs),
    confidence: 0.91,
    timeMap: {
      sourceStartMs,
      sourceEndMs,
      targetStartMs: 0,
      targetEndMs: 60_000,
      spans: [
        {
          kind: "matched",
          sourceStartMs,
          sourceEndMs,
          targetStartMs: 0,
          targetEndMs: 60_000
        }
      ],
      quality: {
        level,
        probability: level === "verified" ? 0.999 : null,
        metricSource: level === "legacy-unverified" ? "estimated" : "measured",
        coverage: 0.96,
        p50ResidualMs: 35,
        p95ResidualMs: 80,
        maxResidualMs: 140,
        boundaryUncertaintyMs: 180,
        alternativeMargin: 0.32,
        anchorCount: 24,
        heldOutAnchorCount: 6,
        reasons: qualityReasons[level]
      },
      evidence: {
        types: level === "legacy-unverified" ? ["legacy"] : ["audio", "visual"],
        audioAnchorCount: 24,
        visualAnchorCount: level === "legacy-unverified" ? 0 : 12,
        heldOutAnchorCount: 6,
        top1Top2Margin: 0.32,
        uniqueContentCoverage: 0.94,
        repeatedContentOnly: false,
        selectedTrackReason: "国语音轨覆盖完整且残差最低。",
        alternativeTrackScores: [
          { sourceStreamIndex: 1, targetStreamIndex: 2, score: 0.92 },
          { sourceStreamIndex: 1, targetStreamIndex: 3, score: 0.6 }
        ],
        notes: []
      },
      sourceStream: {
        type: "audio",
        index: 1,
        codec: "aac",
        startMs: 0,
        timelineOffsetMs: 0,
        timeBase: "1/48000",
        sampleRate: 48_000,
        channels: 2,
        frameRate: null,
        language: "zh",
        title: "国语"
      },
      targetStream: {
        type: "audio",
        index: 2,
        codec: "flac",
        startMs: 0,
        timelineOffsetMs: 0,
        timeBase: "1/48000",
        sampleRate: 48_000,
        channels: 6,
        frameRate: null,
        language: "zh",
        title: "正片"
      },
      sourceIdentity: testContentIdentity("source"),
      targetIdentity: testContentIdentity("target"),
      engineVersion: "alignment-v2.4",
      featureVersion: "chroma-v2",
      parametersHash: `v2-test-${level}`
    }
  };
}

function createFourKindV2Proposal(): AlignmentProposal {
  const proposal = createV2Proposal(5_000, "blocked");
  if (!proposal.timeMap) {
    throw new Error("测试 V2 提案缺少时间图。");
  }
  return {
    ...proposal,
    anchors: [
      {
        id: "audio-anchor-four-kinds-1",
        sourceMs: 6_000,
        targetMs: 1_000,
        origin: "automatic",
        confidence: 0.9
      },
      {
        id: "audio-anchor-four-kinds-2",
        sourceMs: 14_000,
        targetMs: 9_000,
        origin: "automatic",
        confidence: 0.9
      }
    ],
    matchRange: {
      sourceStartMs: 5_000,
      sourceEndMs: 25_000,
      targetStartMs: 0,
      targetEndMs: 21_000,
      coverage: 0.72
    },
    timeMap: {
      ...proposal.timeMap,
      sourceStartMs: 5_000,
      sourceEndMs: 25_000,
      targetStartMs: 0,
      targetEndMs: 21_000,
      spans: [
        {
          kind: "matched",
          sourceStartMs: 5_000,
          sourceEndMs: 15_000,
          targetStartMs: 0,
          targetEndMs: 10_000
        },
        {
          kind: "sourceOnly",
          sourceStartMs: 15_000,
          sourceEndMs: 17_000,
          targetStartMs: 10_000,
          targetEndMs: 10_000
        },
        {
          kind: "targetOnly",
          sourceStartMs: 17_000,
          sourceEndMs: 17_000,
          targetStartMs: 10_000,
          targetEndMs: 13_000
        },
        {
          kind: "ambiguous",
          sourceStartMs: 17_000,
          sourceEndMs: 25_000,
          targetStartMs: 13_000,
          targetEndMs: 21_000
        }
      ],
      quality: {
        ...proposal.timeMap.quality,
        level: "blocked",
        probability: null,
        coverage: 0.72,
        reasons: ["存在无法唯一解释的歧义区间。"]
      },
      parametersHash: "v2-test-four-span-kinds"
    }
  };
}

function testContentIdentity(seed: string) {
  const digit = seed === "source" ? "1" : "2";
  return {
    algorithm: "fnv1a64-first-middle-last-64k-v1",
    sizeBytes: seed === "source" ? 1_000_000 : 2_000_000,
    modifiedUnixMs: seed === "source" ? 1_000 : 2_000,
    firstSampleDigest: digit.repeat(16),
    middleSampleDigest: (seed === "source" ? "3" : "4").repeat(16),
    lastSampleDigest: (seed === "source" ? "5" : "6").repeat(16)
  };
}

function createV2ProposalWithProbability(
  sourceStartMs: number,
  probability: number
): AlignmentProposal {
  const proposal = createV2Proposal(sourceStartMs, "verified");
  if (!proposal.timeMap) {
    throw new Error("测试 V2 提案缺少时间图。");
  }
  return {
    ...proposal,
    confidence: probability,
    timeMap: {
      ...proposal.timeMap,
      quality: {
        ...proposal.timeMap.quality,
        probability
      }
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
