import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUT_HINT_SEARCH_SETTINGS } from "../../domain/danmaku/cutHints";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { CURRENT_SCHEMA_VERSION } from "../../domain/project/types";
import { pickAlignmentMediaPath, pickFfmpegExecutablePath } from "../../infrastructure/file-system/nativeDialogs";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "../../stores/editorStore";
import { AssetPanel } from "./AssetPanel";

vi.mock("../../infrastructure/file-system/nativeDialogs", () => ({
  pickAlignmentMediaPath: vi.fn(),
  pickFfmpegExecutablePath: vi.fn()
}));

describe("资源面板", () => {
  beforeEach(() => {
    vi.mocked(pickAlignmentMediaPath).mockReset();
    vi.mocked(pickFfmpegExecutablePath).mockReset();
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,r">测试</d></i>`,
      { fileName: "01 - 1.1.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [asset]
      },
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null,
      alignmentProposal: null,
      cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS }
    });
  });

  it("可以从资源栏删除已导入的弹幕文件", async () => {
    const user = userEvent.setup();
    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(useEditorStore.getState().project.assets).toHaveLength(0));
  });

  it("主界面的 Emby 时长面板只保留搜索入口", () => {
    render(<AssetPanel />);

    expect(screen.getByText("Emby 时长")).toBeInTheDocument();
    expect(screen.getByLabelText("搜索")).toBeInTheDocument();
    expect(screen.queryByLabelText("服务器")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("路径")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("用户名")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
  });

  it("项目信息会展示项目健康摘要", async () => {
    const user = userEvent.setup();
    render(<AssetPanel />);

    await user.click(screen.getByRole("button", { name: "项目信息" }));

    expect(screen.getByTestId("project-health-panel")).toBeInTheDocument();
    expect(screen.getByText("项目健康")).toBeInTheDocument();
    expect(screen.getByText("项目版本")).toBeInTheDocument();
    expect(screen.getByText(`v${CURRENT_SCHEMA_VERSION}`)).toBeInTheDocument();
    expect(screen.getByText("需复核")).toBeInTheDocument();
    expect(screen.getByText("没有时间轴片段")).toBeInTheDocument();
    expect(screen.getByText("01 - 1.1.xml（1 条弹幕）")).toBeInTheDocument();
    expect(screen.getByText("媒体重连")).toBeInTheDocument();
    expect(screen.getByText("不需要")).toBeInTheDocument();
  });

  it("项目健康摘要会展示重复 ID 的具体位置", async () => {
    const user = userEvent.setup();
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i>
        <d p="1,1,25,16777215,0,0,u1,r1">第一条</d>
        <d p="2,1,25,16777215,0,0,u2,r2">第二条</d>
      </i>`,
      { fileName: "duplicate.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [
          {
            ...asset,
            items: asset.items.map((item, index) => (index === 1 ? { ...item, id: asset.items[0].id } : item))
          }
        ]
      }
    });
    render(<AssetPanel />);

    await user.click(screen.getByRole("button", { name: "项目信息" }));

    expect(screen.getByText("弹幕 ID 重复")).toBeInTheDocument();
    expect(screen.getByText("重复 ID")).toBeInTheDocument();
    expect(screen.getByText(/资源 duplicate\.xml 的第 1 条弹幕；资源 duplicate\.xml 的第 2 条弹幕/)).toBeInTheDocument();
  });

  it("项目健康摘要会展示负最终时间风险", async () => {
    const user = userEvent.setup();
    const project = useEditorStore.getState().project;
    const assetId = project.assets[0].id;
    useEditorStore.setState({
      project: {
        ...project,
        globalOffsetMs: -1500,
        clips: [
          {
            id: "clip-negative",
            assetId,
            name: "负时间片段",
            timelineStartMs: 0,
            sourceInMs: 0,
            sourceOutMs: 3000,
            localOffsetMs: 0,
            enabled: true
          }
        ]
      }
    });
    render(<AssetPanel />);

    await user.click(screen.getByRole("button", { name: "项目信息" }));

    expect(screen.getByText("负最终时间")).toBeInTheDocument();
    expect(screen.getByText("存在负最终时间")).toBeInTheDocument();
    expect(screen.getByText(/负时间片段.*-00:00:01\.500/)).toBeInTheDocument();
  });

  it("可以从项目健康摘要导出健康报告", async () => {
    const user = userEvent.setup();
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:project-health-report");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });

    try {
      useEditorStore.setState({
        project: {
          ...useEditorStore.getState().project,
          name: "健康/报告:项目"
        }
      });
      render(<AssetPanel />);
      await user.click(screen.getByRole("button", { name: "项目信息" }));
      await user.click(screen.getByRole("button", { name: "导出健康报告" }));

      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("健康报告下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("健康_报告_项目-health-report.txt");
      const [blob] = createObjectUrl.mock.calls[0];
      if (!(blob instanceof Blob)) {
        throw new Error("导出的健康报告不是 Blob。");
      }
      await expect(readBlobText(blob)).resolves.toContain("项目健康报告");
      await expect(readBlobText(blob)).resolves.toContain(`项目版本：v${CURRENT_SCHEMA_VERSION}`);
      await expect(readBlobText(blob)).resolves.toContain("没有时间轴片段");
      await expect(readBlobText(blob)).resolves.toContain("01 - 1.1.xml（1 条弹幕）");
      expect(useEditorStore.getState().status.message).toBe("已导出项目健康报告：健康_报告_项目-health-report.txt。");
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:project-health-report");
    } finally {
      clickSpy.mockRestore();
      if (createDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
      if (revokeDescriptor) {
        Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  });

  it("可以从项目健康摘要清理失效编辑引用", async () => {
    const user = userEvent.setup();
    const project = useEditorStore.getState().project;
    const validItemId = project.assets[0].items[0].id;
    useEditorStore.setState({
      project: {
        ...project,
        disabledItemIds: [validItemId, "missing-disabled"],
        itemTimeAdjustments: {
          [validItemId]: 100,
          "missing-adjustment": 200
        }
      }
    });
    render(<AssetPanel />);

    await user.click(screen.getByRole("button", { name: "项目信息" }));
    expect(screen.getByText("存在失效编辑引用")).toBeInTheDocument();
    expect(screen.getByText("失效禁用：missing-disabled")).toBeInTheDocument();
    expect(screen.getByText("失效微调：missing-adjustment（+00:00:00.200）")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清理失效引用" }));

    expect(useEditorStore.getState().project.disabledItemIds).toEqual([validItemId]);
    expect(useEditorStore.getState().project.itemTimeAdjustments).toEqual({ [validItemId]: 100 });
    expect(screen.queryByText("存在失效编辑引用")).not.toBeInTheDocument();
  });

  it("可以从项目健康摘要清理缺失资源片段", async () => {
    const user = userEvent.setup();
    const project = useEditorStore.getState().project;
    const assetId = project.assets[0].id;
    useEditorStore.setState({
      project: {
        ...project,
        clips: [
          {
            id: "clip-valid",
            assetId,
            name: "有效片段",
            timelineStartMs: 0,
            sourceInMs: 0,
            sourceOutMs: 1,
            localOffsetMs: 0,
            enabled: true
          },
          {
            id: "clip-missing",
            assetId: "missing-asset",
            name: "坏片段",
            timelineStartMs: 1,
            sourceInMs: 0,
            sourceOutMs: 1,
            localOffsetMs: 0,
            enabled: true
          }
        ]
      },
      selection: { kind: "clip", ids: ["clip-missing"] }
    });
    render(<AssetPanel />);

    await user.click(screen.getByRole("button", { name: "项目信息" }));
    expect(screen.getByText("片段引用了缺失资源")).toBeInTheDocument();
    expect(screen.getByText(/坏片段（片段 ID：clip-missing，缺失资源 ID：missing-asset/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清理缺失片段" }));

    expect(useEditorStore.getState().project.clips.map((clip) => clip.id)).toEqual(["clip-valid"]);
    expect(useEditorStore.getState().selection).toEqual({ kind: "none", ids: [] });
    expect(screen.queryByText("片段引用了缺失资源")).not.toBeInTheDocument();
  });

  it("可以把疑似删减候选转为待确认补偿点", async () => {
    const user = userEvent.setup();
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i>
        <d p="10,1,25,16777215,0,0,u1,r1">这里是不是删了</d>
        <d p="20,1,25,16777215,0,0,u2,r2">刚才怎么跳了</d>
        <d p="25,1,25,16777215,0,0,u3,r3">少了一段吧</d>
      </i>`,
      { fileName: "第一季1-2.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [asset]
      },
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null,
      alignmentProposal: null,
      cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS }
    });

    render(<AssetPanel />);
    expect(screen.getByText("疑似删减点")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "转为补偿点" }));

    await waitFor(() => expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1));
    const marker = useEditorStore.getState().project.cutMarkers[0];
    expect(marker.name).toContain("待确认补偿");
    expect(marker.sourceAtMs).toBe(20_000);
    expect(marker.note).toContain("第一季1-2.xml");
  });

  it("可以配置疑似删减扫描关键词", async () => {
    const user = userEvent.setup();
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i>
        <d p="10,1,25,16777215,0,0,u1,r1">广告时间没了</d>
        <d p="20,1,25,16777215,0,0,u2,r2">广告被处理了吗</d>
      </i>`,
      { fileName: "custom.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [asset]
      },
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null,
      alignmentProposal: null,
      cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS }
    });

    render(<AssetPanel />);
    expect(screen.getByText("暂无候选")).toBeInTheDocument();
    await user.type(screen.getByLabelText("疑似删减关键词"), "广告");
    expect(useEditorStore.getState().cutHintSettings.keywordsText).toBe("广告");
    await waitFor(() => expect(screen.getByRole("button", { name: "转为补偿点" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "转为补偿点" }));

    await waitFor(() => expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1));
    expect(useEditorStore.getState().project.cutMarkers[0].note).toContain("广告");
  });

  it("导出多分集时使用项目名生成 ZIP 文件名", async () => {
    const user = userEvent.setup();
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:batch-merge-archive");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    const firstAsset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u1,r1">第一集</d></i>`,
      { fileName: "S01E01.xml" }
    );
    const secondAsset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u2,r2">第二集</d></i>`,
      { fileName: "S01E02.xml" }
    );

    try {
      useEditorStore.setState({
        project: {
          ...createEmptyProject(),
          name: "合集/导出:项目",
          assets: [firstAsset, secondAsset]
        },
        history: createHistoryState(),
        selection: { kind: "none", ids: [] }
      });

      render(<AssetPanel />);
      await user.click(screen.getByRole("button", { name: "弹幕文件" }));
      await user.click(screen.getByRole("button", { name: "导出分集" }));

      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("分集 ZIP 下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("合集_导出_项目-danmaku-exports.zip");
      expect(useEditorStore.getState().status.message).toContain("合集_导出_项目-danmaku-exports.zip");
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:batch-merge-archive");
    } finally {
      clickSpy.mockRestore();
      if (createDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
      if (revokeDescriptor) {
        Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  });

  it("导出单个分集时状态显示实际 XML 文件名", async () => {
    const user = userEvent.setup();
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:single-batch-merge");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u1,r1">单集</d></i>`,
      { fileName: "01 - 1.1.xml" }
    );

    try {
      useEditorStore.setState({
        project: {
          ...createEmptyProject(),
          name: "单集/导出:项目",
          assets: [asset]
        },
        history: createHistoryState(),
        selection: { kind: "none", ids: [] }
      });

      render(<AssetPanel />);
      await user.click(screen.getByRole("button", { name: "弹幕文件" }));
      await user.click(screen.getByRole("button", { name: "导出分集" }));

      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("单分集 XML 下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("1 - 1.xml");
      expect(useEditorStore.getState().status.message).toBe("已触发下载 1 个分集 XML：1 - 1.xml。");
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:single-batch-merge");
    } finally {
      clickSpy.mockRestore();
      if (createDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
      if (revokeDescriptor) {
        Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  });

  it("可以在补偿点管理面板定位、微调并删除补偿点", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({
      project: {
        ...useEditorStore.getState().project,
        cutMarkers: [
          {
            id: "cut-manual",
            name: "手动补偿",
            sourceAtMs: 3000,
            targetGapMs: 45000,
            note: "人工确认"
          }
        ]
      },
      selection: { kind: "none", ids: [] }
    });

    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: "定位补偿点 手动补偿" }));
    expect(useEditorStore.getState().selection).toEqual({ kind: "cut", ids: ["cut-manual"] });
    expect(useEditorStore.getState().project.timeline.playheadMs).toBe(3000);

    fireEvent.change(screen.getByLabelText("手动补偿 补偿 ms"), { target: { value: "12000" } });
    expect(useEditorStore.getState().project.cutMarkers[0].targetGapMs).toBe(12000);

    await user.click(screen.getByRole("button", { name: "删除补偿点 手动补偿" }));
    expect(useEditorStore.getState().project.cutMarkers).toHaveLength(0);
  });

  it("可以在同步锚点管理面板定位、微调并删除锚点", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({
      project: {
        ...useEditorStore.getState().project,
        syncAnchors: [{ id: "anchor-manual", sourceMs: 4000, targetMs: 9000, confidence: 1, origin: "manual" }]
      }
    });

    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: "定位同步锚点 1" }));
    expect(useEditorStore.getState().project.timeline.playheadMs).toBe(4000);

    fireEvent.change(screen.getByLabelText("同步锚点 1 目标时间 ms"), { target: { value: "12000" } });
    expect(useEditorStore.getState().project.syncAnchors[0].targetMs).toBe(12000);

    await user.click(screen.getByRole("button", { name: "删除同步锚点 1" }));
    expect(useEditorStore.getState().project.syncAnchors).toHaveLength(0);
  });

  it("可以应用锚点校准推断出的补偿点", async () => {
    const user = userEvent.setup();
    render(<AssetPanel />);

    await user.type(screen.getByPlaceholderText(/每行一个对应点/), "00:10 -> 00:10\n00:20 -> 00:30");
    await user.click(screen.getByRole("button", { name: "应用锚点与补偿" }));

    await waitFor(() => expect(useEditorStore.getState().project.syncAnchors).toHaveLength(2));
    expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1);
    expect(useEditorStore.getState().project.cutMarkers[0]).toMatchObject({
      sourceAtMs: 20_000,
      targetGapMs: 10_000
    });
  });

  it("可以把锚点校准提案发送到时间轴预览", async () => {
    const user = userEvent.setup();
    render(<AssetPanel />);

    await user.type(screen.getByPlaceholderText(/每行一个对应点/), "00:10 -> 00:10\n00:20 -> 00:30");
    await user.click(screen.getByRole("button", { name: "预览到时间轴" }));

    await waitFor(() => expect(useEditorStore.getState().alignmentProposal?.cutCandidates).toHaveLength(1));
    expect(useEditorStore.getState().alignmentProposal?.anchors).toHaveLength(2);
    expect(useEditorStore.getState().status.message).toContain("时间轴预览");
  });

  it("可以导入并应用音频 CLI 输出的对齐提案", async () => {
    const user = userEvent.setup();
    const proposal = {
      anchors: [{ id: "audio-anchor-1", sourceMs: 20_000, targetMs: 40_000, origin: "automatic", confidence: 0.9 }],
      cutCandidates: [
        {
          id: "audio-gap-1",
          name: "音频推断补偿 1",
          sourceAtMs: 20_000,
          sourceRangeStartMs: 18_000,
          sourceRangeEndMs: 22_000,
          targetGapMs: 20_000,
          confidence: 0.72,
          note: "音频对齐候选"
        }
      ],
      confidence: 0.9,
      diagnostics: ["音频特征匹配 4 / 4 帧。"]
    };
    render(<AssetPanel />);

    fireEvent.change(screen.getByPlaceholderText("AlignmentProposal JSON"), {
      target: { value: JSON.stringify(proposal) }
    });
    await user.click(screen.getByRole("button", { name: "导入提案" }));
    await waitFor(() => expect(useEditorStore.getState().alignmentProposal?.cutCandidates).toHaveLength(1));
    expect(screen.getByText("复核提示")).toBeInTheDocument();
    expect(screen.getByText("待应用 2 / 已落点 0")).toBeInTheDocument();
    expect(screen.getByText("复核队列")).toBeInTheDocument();
    expect(screen.getByLabelText("对齐复核队列")).toHaveTextContent("优先复核");
    expect(screen.getByLabelText("对齐复核队列")).toHaveTextContent("候选补偿置信度 72.0%");
    expect(screen.getByText("落点状态")).toBeInTheDocument();
    expect(screen.getByLabelText("对齐落点状态")).toHaveTextContent("audio-anchor-1");
    expect(screen.getByLabelText("对齐落点状态")).toHaveTextContent("音频推断补偿 1");
    expect(screen.getAllByText("待应用")).toHaveLength(2);
    expect(screen.getByText(/1 个候选补偿置信度低于 75%/)).toBeInTheDocument();
    expect(screen.getByText(/1 个候选补偿包含不确定区间/)).toBeInTheDocument();
    expect(screen.getAllByText(/区间 00:00:18\.000-00:00:22\.000/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "应用候选" }));

    await waitFor(() => expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1));
    expect(useEditorStore.getState().project.syncAnchors).toHaveLength(1);
    expect(useEditorStore.getState().project.cutMarkers[0]).toMatchObject({
      sourceAtMs: 20_000,
      targetGapMs: 20_000,
      note: "音频对齐候选"
    });
  });

  it("导入音频对齐提案文件读取失败时显示入口上下文", async () => {
    const file = createRejectingTextFile("bad-alignment.json", "读取被拒绝");
    const { container } = render(<AssetPanel />);
    const input = container.querySelector('input[type="file"][accept=".json,application/json"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("未找到对齐提案文件输入。");
    }

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(useEditorStore.getState().status).toEqual({
        message: "对齐提案文件读取失败：读取文件 bad-alignment.json 失败：读取被拒绝",
        tone: "error"
      })
    );
  });

  it("导入音频对齐提案文件校验失败时显示来源文件名", async () => {
    const file = new File([JSON.stringify({})], "bad-alignment.json", { type: "application/json" });
    const { container } = render(<AssetPanel />);
    const input = container.querySelector('input[type="file"][accept=".json,application/json"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("未找到对齐提案文件输入。");
    }

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(useEditorStore.getState().status).toEqual({
        message: "对齐提案导入失败：bad-alignment.json：对齐提案 JSON 格式不正确。",
        tone: "error"
      })
    );
  });

  it("会暂停应用区间异常的对齐提案", async () => {
    const user = userEvent.setup();
    const proposal = {
      anchors: [{ id: "audio-anchor-1", sourceMs: 20_000, targetMs: 40_000, origin: "automatic", confidence: 0.9 }],
      cutCandidates: [
        {
          id: "audio-gap-1",
          name: "音频推断补偿 1",
          sourceAtMs: 20_000,
          sourceRangeStartMs: 22_000,
          sourceRangeEndMs: 18_000,
          targetGapMs: 20_000,
          confidence: 0.9,
          note: "音频对齐候选"
        }
      ],
      confidence: 0.9,
      diagnostics: ["音频特征匹配 4 / 4 帧。"]
    };
    render(<AssetPanel />);

    fireEvent.change(screen.getByPlaceholderText("AlignmentProposal JSON"), {
      target: { value: JSON.stringify(proposal) }
    });
    await user.click(screen.getByRole("button", { name: "导入提案" }));

    expect(screen.getByText("应用已暂停")).toBeInTheDocument();
    expect(screen.getByText("待应用 1 / 已落点 0 / 阻断 1")).toBeInTheDocument();
    expect(screen.getByLabelText("对齐复核队列")).toHaveTextContent("先修阻断");
    expect(screen.getByLabelText("对齐复核队列")).toHaveTextContent("不确定区间起止异常");
    expect(screen.getByLabelText("对齐落点状态")).toHaveTextContent("阻断（不确定区间起止异常）");
    expect(screen.getAllByText(/不确定区间起止顺序异常/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "应用候选" })).toBeDisabled();
    expect(useEditorStore.getState().project.cutMarkers).toHaveLength(0);
  });

  it("会暂停应用复用当前项目 ID 的对齐提案", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({
      project: {
        ...useEditorStore.getState().project,
        syncAnchors: [{ id: "audio-anchor-1", sourceMs: 10_000, targetMs: 15_000, confidence: 1, origin: "manual" }],
        cutMarkers: [
          {
            id: "audio-gap-1",
            name: "已有补偿",
            sourceAtMs: 20_000,
            targetGapMs: 5000,
            note: ""
          }
        ]
      }
    });
    const proposal = {
      anchors: [{ id: "audio-anchor-1", sourceMs: 20_000, targetMs: 40_000, origin: "automatic", confidence: 0.9 }],
      cutCandidates: [
        {
          id: "audio-gap-1",
          name: "音频推断补偿 1",
          sourceAtMs: 20_000,
          targetGapMs: 20_000,
          confidence: 0.9,
          note: "音频对齐候选"
        }
      ],
      confidence: 0.9,
      diagnostics: ["音频特征匹配 4 / 4 帧。"]
    };
    render(<AssetPanel />);

    fireEvent.change(screen.getByPlaceholderText("AlignmentProposal JSON"), {
      target: { value: JSON.stringify(proposal) }
    });
    await user.click(screen.getByRole("button", { name: "导入提案" }));

    expect(screen.getByText("应用已暂停")).toBeInTheDocument();
    expect(screen.getByText("待应用 0 / 已落点 0 / 阻断 2")).toBeInTheDocument();
    expect(screen.getByLabelText("对齐落点状态")).toHaveTextContent("阻断（当前项目已有同 ID 锚点）");
    expect(screen.getByLabelText("对齐落点状态")).toHaveTextContent("阻断（当前项目已有同 ID 补偿点）");
    expect(screen.getByText("1 个同步锚点 ID 已存在于当前项目（ID：audio-anchor-1），应用会丢失新锚点。")).toBeInTheDocument();
    expect(screen.getByText("1 个候选补偿 ID 已存在于当前项目（ID：audio-gap-1），应用会丢失新补偿。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用候选" })).toBeDisabled();
    expect(useEditorStore.getState().project.syncAnchors).toHaveLength(1);
    expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1);
  });

  it("可以导出当前音频对齐提案 JSON", async () => {
    const user = userEvent.setup();
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:alignment-proposal");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    const proposal = {
      anchors: [{ id: "audio-anchor-1", sourceMs: 20_000, targetMs: 40_000, origin: "automatic", confidence: 0.9 }],
      cutCandidates: [
        {
          id: "audio-gap-1",
          name: "音频推断补偿 1",
          sourceAtMs: 20_000,
          targetGapMs: 20_000,
          confidence: 0.9,
          note: "音频对齐候选"
        }
      ],
      confidence: 0.9,
      diagnostics: ["音频特征匹配 4 / 4 帧。"]
    };

    try {
      useEditorStore.setState({
        project: {
          ...useEditorStore.getState().project,
          name: "对齐/提案:项目"
        }
      });
      render(<AssetPanel />);
      fireEvent.change(screen.getByPlaceholderText("AlignmentProposal JSON"), {
        target: { value: JSON.stringify(proposal) }
      });
      await user.click(screen.getByRole("button", { name: "导入提案" }));
      await user.click(screen.getByRole("button", { name: "导出提案" }));

      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      const [blob] = createObjectUrl.mock.calls[0];
      if (!(blob instanceof Blob)) {
        throw new Error("导出的对象不是 Blob。");
      }
      await expect(readBlobText(blob)).resolves.toContain("audio-gap-1");
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("对齐提案下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("对齐_提案_项目-alignment-proposal.json");
      expect(useEditorStore.getState().status.message).toBe(
        "已导出对齐提案 JSON：对齐_提案_项目-alignment-proposal.json。"
      );
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:alignment-proposal");
    } finally {
      clickSpy.mockRestore();
      if (createDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
      if (revokeDescriptor) {
        Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  });

  it("可以导出当前音频对齐复核报告", async () => {
    const user = userEvent.setup();
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:alignment-report");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    const proposal = {
      anchors: [{ id: "audio-anchor-1", sourceMs: 20_000, targetMs: 40_000, origin: "automatic", confidence: 0.9 }],
      cutCandidates: [
        {
          id: "audio-gap-1",
          name: "音频推断补偿 1",
          sourceAtMs: 20_000,
          sourceRangeStartMs: 18_000,
          sourceRangeEndMs: 22_000,
          targetGapMs: 20_000,
          confidence: 0.72,
          note: "音频对齐候选"
        }
      ],
      confidence: 0.82,
      diagnostics: ["音频特征匹配 4 / 4 帧。"]
    };

    try {
      useEditorStore.setState({
        project: {
          ...useEditorStore.getState().project,
          name: "对齐/报告:项目",
          syncAnchors: [{ id: "audio-anchor-1", sourceMs: 10_000, targetMs: 15_000, confidence: 1, origin: "manual" }],
          cutMarkers: [
            {
              id: "audio-gap-1",
              name: "已有补偿",
              sourceAtMs: 20_000,
              targetGapMs: 5000,
              note: "已有项目补偿"
            }
          ]
        }
      });
      render(<AssetPanel />);
      fireEvent.change(screen.getByPlaceholderText("AlignmentProposal JSON"), {
        target: { value: JSON.stringify(proposal) }
      });
      await user.click(screen.getByRole("button", { name: "导入提案" }));
      await user.click(screen.getByRole("button", { name: "导出报告" }));

      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      const [blob] = createObjectUrl.mock.calls[0];
      if (!(blob instanceof Blob)) {
        throw new Error("导出的对象不是 Blob。");
      }
      await expect(readBlobText(blob)).resolves.toContain("对齐提案复核报告");
      await expect(readBlobText(blob)).resolves.toContain("应用阻断");
      await expect(readBlobText(blob)).resolves.toContain("1 个同步锚点 ID 已存在于当前项目（ID：audio-anchor-1）");
      await expect(readBlobText(blob)).resolves.toContain("1 个候选补偿 ID 已存在于当前项目（ID：audio-gap-1）");
      await expect(readBlobText(blob)).resolves.toContain("audio-gap-1");
      await expect(readBlobText(blob)).resolves.toContain("不确定区间：00:00:18.000");
      await expect(readBlobText(blob)).resolves.toContain("音频特征匹配 4 / 4 帧。");
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("对齐复核报告下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("对齐_报告_项目-alignment-review-report.txt");
      expect(useEditorStore.getState().status.message).toBe(
        "已导出对齐复核报告：对齐_报告_项目-alignment-review-report.txt。"
      );
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:alignment-report");
    } finally {
      clickSpy.mockRestore();
      if (createDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
      if (revokeDescriptor) {
        Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  });

  it("可以通过原生文件选择器填入视频对齐路径", async () => {
    const user = userEvent.setup();
    vi.mocked(pickAlignmentMediaPath)
      .mockResolvedValueOnce("D:\\media\\full.mkv")
      .mockResolvedValueOnce("D:\\media\\cut.mp4");
    vi.mocked(pickFfmpegExecutablePath).mockResolvedValueOnce("C:\\tools\\ffmpeg.exe");

    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: "选择完整片源" }));
    await user.click(screen.getByRole("button", { name: "选择删减版" }));
    await user.click(screen.getByRole("button", { name: "选择 FFmpeg" }));

    expect(screen.getByLabelText("完整片源路径")).toHaveValue("D:\\media\\full.mkv");
    expect(screen.getByLabelText("删减版路径")).toHaveValue("D:\\media\\cut.mp4");
    expect(screen.getByLabelText("FFmpeg 路径")).toHaveValue("C:\\tools\\ffmpeg.exe");
    expect(pickAlignmentMediaPath).toHaveBeenNthCalledWith(1, "");
    expect(pickAlignmentMediaPath).toHaveBeenNthCalledWith(2, "");
    expect(pickFfmpegExecutablePath).toHaveBeenCalledWith("");
  });
});

function createRejectingTextFile(fileName: string, message: string): File {
  const file = new File([""], fileName, { type: "application/json" });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: vi.fn<() => Promise<string>>(() => Promise.reject(new Error(message)))
  });
  return file;
}

function readBlobText(blob: Blob): Promise<string> {
  const modernBlob = blob as Blob & { text?: () => Promise<string> };
  if (typeof modernBlob.text === "function") {
    return modernBlob.text();
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      if (reader.result instanceof ArrayBuffer) {
        resolve(new TextDecoder().decode(reader.result));
        return;
      }
      resolve("");
    };
    reader.onerror = () => reject(new Error("Blob 读取失败。"));
    reader.readAsText(blob);
  });
}
