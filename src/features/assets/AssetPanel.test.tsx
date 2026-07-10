import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUT_HINT_SEARCH_SETTINGS } from "../../domain/danmaku/cutHints";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { createEmbyItemMediaBinding, createLocalPathMediaBinding } from "../../domain/project/mediaBinding";
import { CURRENT_SCHEMA_VERSION } from "../../domain/project/types";
import { startTauriAudioAlignmentJob } from "../../infrastructure/alignment/tauriAudioAlignment";
import { pickAlignmentMediaPath, pickFfmpegExecutablePath } from "../../infrastructure/file-system/nativeDialogs";
import { authenticateEmby, fetchEmbyItem } from "../../infrastructure/metadata/embyClient";
import { clearVolatileEmbyCredentials, saveVolatileEmbyPassword } from "../../infrastructure/settings/volatileEmbyCredentials";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "../../stores/editorStore";
import { AssetPanel } from "./AssetPanel";

vi.mock("../../infrastructure/file-system/nativeDialogs", () => ({
  pickAlignmentMediaPath: vi.fn(),
  pickFfmpegExecutablePath: vi.fn()
}));

vi.mock("../../infrastructure/alignment/tauriAudioAlignment", async () => {
  const actual = await vi.importActual("../../infrastructure/alignment/tauriAudioAlignment");
  return {
    ...actual,
    startTauriAudioAlignmentJob: vi.fn(),
    getTauriAudioAlignmentJob: vi.fn(),
    cancelTauriAudioAlignmentJob: vi.fn()
  };
});

vi.mock("../../infrastructure/metadata/embyClient", async () => {
  const actual = await vi.importActual("../../infrastructure/metadata/embyClient");
  return {
    ...actual,
    authenticateEmby: vi.fn(),
    fetchEmbyItem: vi.fn()
  };
});

describe("资源面板", () => {
  beforeEach(() => {
    vi.mocked(pickAlignmentMediaPath).mockReset();
    vi.mocked(pickFfmpegExecutablePath).mockReset();
    vi.mocked(startTauriAudioAlignmentJob).mockReset();
    vi.mocked(authenticateEmby).mockReset();
    vi.mocked(fetchEmbyItem).mockReset();
    clearVolatileEmbyCredentials();
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

  it("可以从资源栏删除已导入的弹幕素材", async () => {
    const user = userEvent.setup();
    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(useEditorStore.getState().project.assets).toHaveLength(0));
  });

  it("媒体页可以把当前本地视频绑定为目标原片", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        media: {
          id: "media-local",
          name: "本地完整版",
          fileName: "full.mp4",
          objectUrl: "blob:full",
          durationMs: 3_000_000
        }
      }
    });

    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: "媒体" }));
    await user.click(screen.getByRole("button", { name: "绑定当前视频" }));

    expect(useEditorStore.getState().project.mediaBinding).toMatchObject({
      kind: "localFile",
      displayName: "本地完整版",
      fileName: "full.mp4"
    });
    const targetPanel = getTargetMediaBindingPanel();
    expect(within(targetPanel).getByText("本地文件已连接")).toBeInTheDocument();
    expect(within(targetPanel).getByText("本地完整版")).toBeInTheDocument();
  });

  it("媒体页可以选择本地路径作为 mpv 目标原片", async () => {
    const user = userEvent.setup();
    vi.mocked(pickAlignmentMediaPath).mockResolvedValue("D:\\media\\full.mkv");

    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: "媒体" }));
    await user.click(screen.getByRole("button", { name: "选择本地路径" }));

    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaBinding).toMatchObject({
        kind: "localFile",
        displayName: "full",
        fileName: "full.mkv",
        localPath: "D:\\media\\full.mkv"
      })
    );
    const targetPanel = getTargetMediaBindingPanel();
    expect(within(targetPanel).getByText("本地文件已连接")).toBeInTheDocument();
    expect(within(targetPanel).getByText("D:\\media\\full.mkv")).toBeInTheDocument();
  });

  it("媒体页显示保存恢复的 Emby 目标原片绑定", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        mediaBinding: {
          id: "binding-emby",
          kind: "embyItem",
          displayName: "测试剧集 / S01E02 / 第二集",
          itemId: "emby-item-1",
          itemName: "第二集",
          itemType: "Episode",
          seriesName: "测试剧集",
          seasonNumber: 1,
          episodeNumber: 2,
          runtimeMs: 3_000_000,
          linkedAt: "2026-07-10T00:00:00.000Z",
          server: {
            serverUrl: "https://emby.example.test",
            pathPrefix: "/emby",
            username: "tester"
          },
          mediaSources: [
            {
              id: "source-1",
              name: "主媒体源",
              container: "mkv",
              videoCodec: "h264",
              audioCodec: "aac",
              width: 1920,
              height: 1080,
              bitrate: 8_000_000,
              sizeBytes: 1_000_000_000,
              runtimeMs: 3_000_000
            }
          ]
        }
      }
    });

    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: "媒体" }));

    const targetPanel = getTargetMediaBindingPanel();
    expect(within(targetPanel).getByText("Emby 条目已保存")).toBeInTheDocument();
    expect(within(targetPanel).getByText("测试剧集 / S01E02 / 第二集")).toBeInTheDocument();
    expect(within(targetPanel).getByText("主媒体源 / mkv / h264 / aac / 1920x1080")).toBeInTheDocument();
  });

  it("媒体页展示匹配评分并可发送评分提案到时间轴预览", async () => {
    const user = userEvent.setup();
    const asset = parseBilibiliXml(createTimedXml(240, 15), { fileName: "测试剧集 S01E02.xml" });
    useEditorStore.setState({
      project: {
        ...createEmptyProject("测试剧集 S01E02"),
        assets: [asset],
        mediaBinding: createEmbyItemMediaBinding(
          "binding-emby",
          {
            id: "emby-item-2",
            name: "第二集",
            type: "Episode",
            seriesName: "测试剧集",
            seasonNumber: 1,
            episodeNumber: 2,
            durationMs: 3_600_000,
            mediaSources: []
          },
          {
            serverUrl: "https://emby.example.test",
            pathPrefix: "/emby",
            username: "tester"
          },
          "2026-07-10T00:00:00.000Z"
        )
      }
    });

    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: "媒体" }));

    expect(screen.getByText("匹配评分")).toBeInTheDocument();
    expect(screen.getByText("很可能匹配")).toBeInTheDocument();
    expect(screen.getByText("片名与季集")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "预览评分提案" }));

    await waitFor(() => expect(useEditorStore.getState().alignmentProposal?.anchors).toHaveLength(1));
    expect(useEditorStore.getState().alignmentProposal?.diagnostics[0]).toContain("匹配评分");
    expect(useEditorStore.getState().status.message).toBe("已发送到时间轴预览：1 个同步线索，0 个候选版本差异。");
  });

  it("高级工具默认收起，展开后 Emby 时长面板只保留搜索入口", async () => {
    const user = userEvent.setup();
    render(<AssetPanel />);

    expect(screen.queryByText("Emby 时长")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /高级工具/ }));
    expect(screen.getByText("Emby 时长")).toBeInTheDocument();
    expect(screen.getByLabelText("搜索")).toBeInTheDocument();
    expect(screen.queryByLabelText("服务器")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("路径")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("用户名")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
  });

  it("高级工具展示剧集工作台状态摘要", async () => {
    const user = userEvent.setup();
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="12,1,25,16777215,0,0,u1,r1">第一集</d></i>`,
      { fileName: "S01E01.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [asset],
        mediaBinding: createLocalPathMediaBinding("binding-local", "D:\\media\\full.mkv", 3_000_000),
        cutMarkers: [
          {
            id: "cut-1",
            name: "片头差异",
            sourceAtMs: 10_000,
            targetGapMs: 45_000,
            note: ""
          }
        ]
      },
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null,
      alignmentProposal: null,
      cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS }
    });

    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: /高级工具/ }));

    const workbench = screen.getByRole("region", { name: "剧集工作台" });
    expect(within(workbench).getByText("批量导出就绪")).toBeInTheDocument();
    expect(within(workbench).getByText("导入 XML")).toBeInTheDocument();
    expect(within(workbench).getByText("绑定目标原片")).toBeInTheDocument();
    expect(within(workbench).getByText("导出分集 XML")).toBeInTheDocument();
    expect(within(workbench).getByText("下一步：导出分集 XML：可使用现有导出按钮生成分集 XML。")).toBeInTheDocument();
  });

  it("高级工具可以把当前目标原片绑定到分集输出", async () => {
    const user = userEvent.setup();
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="12,1,25,16777215,0,0,u1,r1">第一集</d></i>`,
      { fileName: "S01E01.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [asset],
        mediaBinding: createLocalPathMediaBinding("binding-local", "D:\\media\\full.mkv", 3_000_000)
      },
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null,
      alignmentProposal: null,
      cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS }
    });

    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: /高级工具/ }));

    const bindingPanel = screen.getByRole("region", { name: "逐集目标绑定" });
    expect(within(bindingPanel).getByText("当前目标：full")).toBeInTheDocument();
    await user.click(within(bindingPanel).getByRole("button", { name: "绑定当前目标" }));

    await waitFor(() => expect(useEditorStore.getState().project.seasonEpisodeBindings).toHaveLength(1));
    expect(useEditorStore.getState().project.seasonEpisodeBindings[0]).toMatchObject({
      episodeKey: "S01E01",
      episodeLabel: "第 1 集",
      targetBinding: {
        kind: "localFile",
        fileName: "full.mkv"
      }
    });
    expect(within(bindingPanel).getByText("已绑定")).toBeInTheDocument();

    await user.click(within(bindingPanel).getByRole("button", { name: "清除" }));
    await waitFor(() => expect(useEditorStore.getState().project.seasonEpisodeBindings).toHaveLength(0));
  });

  it("导出检查会展示人话摘要并按需显示诊断详情", async () => {
    const user = userEvent.setup();
    render(<AssetPanel />);

    await user.click(screen.getByRole("button", { name: "导出检查" }));

    expect(screen.getByTestId("project-health-panel")).toBeInTheDocument();
    expect(screen.getByText("导出前检查")).toBeInTheDocument();
    expect(screen.getByText("弹幕还没放到时间轴")).toBeInTheDocument();
    expect(screen.getByText("建议检查")).toBeInTheDocument();
    expect(screen.queryByText("项目版本")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看诊断详情" }));
    expect(screen.getByText("项目版本")).toBeInTheDocument();
    expect(screen.getByText(`v${CURRENT_SCHEMA_VERSION}`)).toBeInTheDocument();
    expect(screen.getByText("01 - 1.1.xml（1 条弹幕）")).toBeInTheDocument();
    expect(screen.getByText("视频重连")).toBeInTheDocument();
    expect(getDiagnosticMetricText("视频重连")).toContain("不需要");
    expect(getDiagnosticMetricText("目标重连")).toContain("不需要");
  });

  it("导出检查会展示重复 ID 的具体位置", async () => {
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

    await user.click(screen.getByRole("button", { name: "导出检查" }));

    expect(screen.getByText("项目内部 ID 有重复")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看诊断详情" }));
    expect(screen.getByText("重复 ID")).toBeInTheDocument();
    expect(screen.getByText(/资源 duplicate\.xml 的第 1 条弹幕；资源 duplicate\.xml 的第 2 条弹幕/)).toBeInTheDocument();
  });

  it("导出检查会展示负最终时间风险", async () => {
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

    await user.click(screen.getByRole("button", { name: "导出检查" }));

    expect(screen.getByText("有弹幕会被挤到 0 秒")).toBeInTheDocument();
    expect(screen.getByText(/负时间片段.*-00:00:01\.500/)).toBeInTheDocument();
  });

  it("可以从导出检查下载检查报告", async () => {
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
      await user.click(screen.getByRole("button", { name: "导出检查" }));
      await user.click(screen.getByRole("button", { name: "下载检查报告" }));

      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("检查报告下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("健康_报告_项目-health-report.txt");
      const [blob] = createObjectUrl.mock.calls[0];
      if (!(blob instanceof Blob)) {
        throw new Error("导出的检查报告不是 Blob。");
      }
      await expect(readBlobText(blob)).resolves.toContain("导出前检查报告");
      await expect(readBlobText(blob)).resolves.toContain(`项目版本：v${CURRENT_SCHEMA_VERSION}`);
      await expect(readBlobText(blob)).resolves.toContain("没有时间轴片段");
      await expect(readBlobText(blob)).resolves.toContain("01 - 1.1.xml（1 条弹幕）");
      expect(useEditorStore.getState().status.message).toBe("已导出检查报告：健康_报告_项目-health-report.txt。");
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

  it("可以从导出检查清理失效编辑引用", async () => {
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

    await user.click(screen.getByRole("button", { name: "导出检查" }));
    expect(screen.getByText("有失效的弹幕调整记录")).toBeInTheDocument();
    expect(screen.getByText("失效禁用：missing-disabled")).toBeInTheDocument();
    expect(screen.getByText("失效微调：missing-adjustment（+00:00:00.200）")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清理失效调整" }));

    expect(useEditorStore.getState().project.disabledItemIds).toEqual([validItemId]);
    expect(useEditorStore.getState().project.itemTimeAdjustments).toEqual({ [validItemId]: 100 });
    expect(screen.queryByText("有失效的弹幕调整记录")).not.toBeInTheDocument();
  });

  it("可以从导出检查清理缺失资源片段", async () => {
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

    await user.click(screen.getByRole("button", { name: "导出检查" }));
    expect(screen.getByText("有时间轴片段找不到原来的 XML")).toBeInTheDocument();
    expect(screen.getByText(/坏片段（片段 ID：clip-missing，缺失资源 ID：missing-asset/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "移除缺失片段" }));

    expect(useEditorStore.getState().project.clips.map((clip) => clip.id)).toEqual(["clip-valid"]);
    expect(useEditorStore.getState().selection).toEqual({ kind: "none", ids: [] });
    expect(screen.queryByText("有时间轴片段找不到原来的 XML")).not.toBeInTheDocument();
  });

  it("可以把疑似版本差异候选转为待确认版本差异", async () => {
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
    await user.click(screen.getByRole("button", { name: /高级工具/ }));
    expect(screen.getByText("疑似版本差异")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "转为版本差异" }));

    await waitFor(() => expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1));
    const marker = useEditorStore.getState().project.cutMarkers[0];
    expect(marker.name).toContain("待确认版本差异");
    expect(marker.sourceAtMs).toBe(20_000);
    expect(marker.note).toContain("第一季1-2.xml");
  });

  it("可以配置疑似版本差异扫描关键词", async () => {
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
    await user.click(screen.getByRole("button", { name: /高级工具/ }));
    expect(screen.getByText("暂无候选")).toBeInTheDocument();
    await user.type(screen.getByLabelText("疑似版本差异关键词"), "广告");
    expect(useEditorStore.getState().cutHintSettings.keywordsText).toBe("广告");
    await waitFor(() => expect(screen.getByRole("button", { name: "转为版本差异" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "转为版本差异" }));

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
      await user.click(screen.getByRole("button", { name: "弹幕素材" }));
      await user.click(screen.getByRole("button", { name: "导出分集 XML" }));

      await waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(1));
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
      await user.click(screen.getByRole("button", { name: "弹幕素材" }));
      await user.click(screen.getByRole("button", { name: "导出分集 XML" }));

      await waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(1));
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

  it("可以在版本差异列表定位、微调并删除版本差异", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({
      project: {
        ...useEditorStore.getState().project,
        cutMarkers: [
          {
            id: "cut-manual",
            name: "手动版本差异",
            sourceAtMs: 3000,
            targetGapMs: 45000,
            note: "人工确认"
          }
        ]
      },
      selection: { kind: "none", ids: [] }
    });

    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: /高级工具/ }));
    await user.click(screen.getByRole("button", { name: "定位版本差异 手动版本差异" }));
    expect(useEditorStore.getState().selection).toEqual({ kind: "cut", ids: ["cut-manual"] });
    expect(useEditorStore.getState().project.timeline.playheadMs).toBe(3000);

    fireEvent.change(screen.getByLabelText("手动版本差异 相差 ms"), { target: { value: "12000" } });
    expect(useEditorStore.getState().project.cutMarkers[0].targetGapMs).toBe(12000);

    await user.click(screen.getByRole("button", { name: "删除版本差异 手动版本差异" }));
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
    await user.click(screen.getByRole("button", { name: /高级工具/ }));
    await user.click(screen.getByRole("button", { name: "定位同步锚点 1" }));
    expect(useEditorStore.getState().project.timeline.playheadMs).toBe(4000);

    fireEvent.change(screen.getByLabelText("同步锚点 1 完整版时间 ms"), { target: { value: "12000" } });
    expect(useEditorStore.getState().project.syncAnchors[0].targetMs).toBe(12000);

    await user.click(screen.getByRole("button", { name: "删除同步锚点 1" }));
    expect(useEditorStore.getState().project.syncAnchors).toHaveLength(0);
  });

  it("可以应用锚点校准推断出的版本差异", async () => {
    const user = userEvent.setup();
    render(<AssetPanel />);

    await user.click(screen.getByRole("button", { name: /高级工具/ }));
    await user.type(screen.getByPlaceholderText(/每行一个对应点/), "00:10 -> 00:10\n00:20 -> 00:30");
    await user.click(screen.getByRole("button", { name: "应用线索与差异" }));

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

    await user.click(screen.getByRole("button", { name: /高级工具/ }));
    await user.type(screen.getByPlaceholderText(/每行一个对应点/), "00:10 -> 00:10\n00:20 -> 00:30");
    await user.click(screen.getByRole("button", { name: "预览到时间轴" }));

    await waitFor(() => expect(useEditorStore.getState().alignmentProposal?.cutCandidates).toHaveLength(1));
    expect(useEditorStore.getState().alignmentProposal?.anchors).toHaveLength(2);
    expect(useEditorStore.getState().status.message).toContain("时间轴预览");
  });

  it("会把项目内恢复的对齐提案同步到 JSON 文本框", async () => {
    const user = userEvent.setup();
    const proposal = {
      anchors: [{ id: "saved-anchor", sourceMs: 20_000, targetMs: 40_000, origin: "automatic" as const, confidence: 0.9 }],
      cutCandidates: [
        {
          id: "saved-gap",
          name: "已保存版本差异",
          sourceAtMs: 20_000,
          sourceRangeStartMs: 18_000,
          sourceRangeEndMs: 22_000,
          targetGapMs: 20_000,
          confidence: 0.82,
          note: "项目内恢复"
        }
      ],
      confidence: 0.9,
      diagnostics: ["项目内恢复的提案"]
    };
    const project = useEditorStore.getState().project;
    useEditorStore.setState({
      project: {
        ...project,
        alignmentProposal: proposal
      },
      alignmentProposal: proposal
    });

    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: /高级工具/ }));

    await waitFor(() =>
      expect(screen.getByPlaceholderText("AlignmentProposal JSON")).toHaveValue(`${JSON.stringify(proposal, null, 2)}\n`)
    );
    expect(screen.getByText("复核队列")).toBeInTheDocument();
  });

  it("可以从资源面板清空当前对齐提案和 JSON 文本框", async () => {
    const user = userEvent.setup();
    const proposal = {
      anchors: [{ id: "saved-anchor", sourceMs: 20_000, targetMs: 40_000, origin: "automatic" as const, confidence: 0.9 }],
      cutCandidates: [
        {
          id: "saved-gap",
          name: "已保存版本差异",
          sourceAtMs: 20_000,
          sourceRangeStartMs: 18_000,
          sourceRangeEndMs: 22_000,
          targetGapMs: 20_000,
          confidence: 0.82,
          note: "项目内恢复"
        }
      ],
      confidence: 0.9,
      diagnostics: ["项目内恢复的提案"]
    };
    const project = useEditorStore.getState().project;
    useEditorStore.setState({
      project: {
        ...project,
        alignmentProposal: proposal
      },
      alignmentProposal: proposal
    });

    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: /高级工具/ }));

    const textArea = screen.getByPlaceholderText("AlignmentProposal JSON");
    await waitFor(() => expect(textArea).toHaveValue(`${JSON.stringify(proposal, null, 2)}\n`));
    await user.click(screen.getByRole("button", { name: "清空提案" }));

    expect(textArea).toHaveValue("");
    expect(useEditorStore.getState().alignmentProposal).toBeNull();
    expect(useEditorStore.getState().project.alignmentProposal).toBeNull();
    expect(useEditorStore.getState().status).toEqual({
      message: "已清空当前对齐提案。",
      tone: "success"
    });
    expect(screen.queryByText("复核队列")).not.toBeInTheDocument();
  });

  it("可以导入并应用音频 CLI 输出的对齐提案", async () => {
    const user = userEvent.setup();
    const proposal = {
      anchors: [{ id: "audio-anchor-1", sourceMs: 20_000, targetMs: 40_000, origin: "automatic", confidence: 0.9 }],
      cutCandidates: [
        {
          id: "audio-gap-1",
          name: "音频推断差异 1",
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
    await user.click(screen.getByRole("button", { name: /高级工具/ }));

    fireEvent.change(screen.getByPlaceholderText("AlignmentProposal JSON"), {
      target: { value: JSON.stringify(proposal) }
    });
    await user.click(screen.getByRole("button", { name: "导入提案" }));
    await waitFor(() => expect(useEditorStore.getState().alignmentProposal?.cutCandidates).toHaveLength(1));
    expect(screen.getByText("复核提示")).toBeInTheDocument();
    expect(screen.getByText("待应用 2 / 已落点 0")).toBeInTheDocument();
    expect(screen.getByText("复核队列")).toBeInTheDocument();
    expect(screen.getByLabelText("对齐复核队列")).toHaveTextContent("优先复核");
    expect(screen.getByLabelText("对齐复核队列")).toHaveTextContent("候选版本差异置信度 72.0%");
    await user.click(screen.getByRole("button", { name: "定位复核项 1" }));
    expect(useEditorStore.getState().project.timeline.playheadMs).toBe(20_000);
    expect(useEditorStore.getState().status.message).toBe("已定位复核项：音频推断差异 1（00:00:20.000）。");
    expect(screen.getByText("落点状态")).toBeInTheDocument();
    expect(screen.getByLabelText("对齐落点状态")).toHaveTextContent("audio-anchor-1");
    expect(screen.getByLabelText("对齐落点状态")).toHaveTextContent("音频推断差异 1");
    expect(screen.getAllByText("待应用")).toHaveLength(2);
    expect(screen.getByText(/1 个候选版本差异置信度低于 75%/)).toBeInTheDocument();
    expect(screen.getByText(/1 个候选版本差异包含不确定区间/)).toBeInTheDocument();
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

  it("视频对齐实验室会使用已绑定本地目标原片路径", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({
      project: {
        ...useEditorStore.getState().project,
        mediaBinding: {
          id: "binding-local-path",
          kind: "localFile",
          displayName: "本地完整版",
          fileName: "full.mkv",
          mediaId: null,
          localPath: "D:\\media\\full.mkv",
          runtimeMs: 3_000_000,
          linkedAt: "2026-07-10T00:00:00.000Z"
        }
      }
    });

    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: /高级工具/ }));

    await waitFor(() => expect(screen.getByLabelText("完整版路径")).toHaveValue("D:\\media\\full.mkv"));
    expect(screen.getByText("已使用目标原片绑定中的本地路径作为完整版输入。")).toBeInTheDocument();
  });

  it("视频对齐实验室可用已绑定 Emby 原片生成临时授权输入", async () => {
    const user = userEvent.setup();
    saveVolatileEmbyPassword("secret");
    vi.mocked(authenticateEmby).mockResolvedValue({
      userId: "user-1",
      userName: "tester",
      accessToken: "token-secret"
    });
    vi.mocked(fetchEmbyItem).mockResolvedValue({
      id: "episode-1",
      name: "Episode 1",
      type: "Episode",
      seriesName: "Demo Series",
      seasonNumber: 1,
      episodeNumber: 1,
      durationMs: 3_000_000,
      mediaSources: [
        {
          id: "source-1",
          name: "1080p",
          container: "mkv",
          videoCodec: "h264",
          audioCodec: "aac",
          width: 1920,
          height: 1080,
          bitrate: 8_000_000,
          sizeBytes: 1_000_000_000,
          runtimeMs: 3_000_000
        }
      ]
    });
    vi.mocked(startTauriAudioAlignmentJob).mockResolvedValue({
      jobId: "job-emby",
      status: "completed",
      progress: 1,
      message: "本地音频对齐完成。",
      logs: ["本地音频对齐完成。"],
      proposal: {
        anchors: [],
        cutCandidates: [],
        confidence: 1,
        diagnostics: ["Emby 授权输入测试。"]
      },
      error: null,
      updatedAtMs: 1
    });
    useEditorStore.setState({
      project: {
        ...useEditorStore.getState().project,
        mediaBinding: createEmbyItemMediaBinding(
          "binding-emby",
          {
            id: "episode-1",
            name: "Episode 1",
            type: "Episode",
            seriesName: "Demo Series",
            seasonNumber: 1,
            episodeNumber: 1,
            durationMs: 3_000_000,
            mediaSources: []
          },
          { serverUrl: "https://emby.example.test", pathPrefix: "/emby", username: "tester" }
        )
      }
    });

    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: /高级工具/ }));
    await user.click(screen.getByRole("button", { name: "使用 Emby 授权输入" }));

    await waitFor(() =>
      expect(screen.getByText(/已准备 Emby 授权输入：Episode 1 \/ 媒体源 source-1/)).toBeInTheDocument()
    );
    expect(screen.getByLabelText("完整版路径")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("当前视频路径"), {
      target: { value: "D:\\media\\cut.mp4" }
    });
    await user.click(screen.getByRole("button", { name: "运行本地对齐" }));

    await waitFor(() => expect(startTauriAudioAlignmentJob).toHaveBeenCalled());
    const request = vi.mocked(startTauriAudioAlignmentJob).mock.calls[0][0];
    expect(request.completePath).toContain("https://emby.example.test/emby/Videos/episode-1/stream");
    expect(request.completePath).toContain("api_key=token-secret");
    expect(request.completePath).toContain("MediaSourceId=source-1");
    expect(screen.getByLabelText("完整版路径")).toHaveValue("");
  });

  it("可以逐个预览、修正、接受或跳过音频候选版本差异", async () => {
    const user = userEvent.setup();
    const proposal = {
      anchors: [],
      cutCandidates: [
        {
          id: "audio-gap-1",
          name: "音频推断差异 1",
          sourceAtMs: 20_000,
          sourceRangeStartMs: 18_000,
          sourceRangeEndMs: 22_000,
          targetGapMs: 20_000,
          confidence: 0.72,
          note: "音频对齐候选"
        },
        {
          id: "audio-gap-2",
          name: "音频推断差异 2",
          sourceAtMs: 40_000,
          sourceRangeStartMs: 39_000,
          sourceRangeEndMs: 41_000,
          targetGapMs: 10_000,
          confidence: 0.86,
          note: "第二个候选"
        }
      ],
      confidence: 0.8,
      diagnostics: ["音频特征匹配 8 / 8 帧。"]
    };
    render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: /高级工具/ }));
    fireEvent.change(screen.getByPlaceholderText("AlignmentProposal JSON"), {
      target: { value: JSON.stringify(proposal) }
    });
    await user.click(screen.getByRole("button", { name: "导入提案" }));

    expect(screen.getByText("候选版本差异复核")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "预览候选 1" }));
    expect(useEditorStore.getState().project.timeline.playheadMs).toBe(20_000);
    fireEvent.change(screen.getByLabelText("候选时间 音频推断差异 1"), {
      target: { value: "21000" }
    });
    fireEvent.change(screen.getByLabelText("差异时长 音频推断差异 1"), {
      target: { value: "25000" }
    });
    await user.click(screen.getAllByRole("button", { name: "接受" })[0]);

    await waitFor(() => expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1));
    expect(useEditorStore.getState().project.cutMarkers[0]).toMatchObject({
      sourceAtMs: 21_000,
      targetGapMs: 25_000
    });
    expect(useEditorStore.getState().project.cutMarkers[0].note).toContain("人工复核接受");

    await user.click(screen.getByRole("button", { name: "跳过" }));
    expect(screen.getByText("候选版本差异已全部处理：已处理 2 条。")).toBeInTheDocument();
  });

  it("导入音频对齐提案文件读取失败时显示入口上下文", async () => {
    const user = userEvent.setup();
    const file = createRejectingTextFile("bad-alignment.json", "读取被拒绝");
    const { container } = render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: /高级工具/ }));
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
    const user = userEvent.setup();
    const file = new File([JSON.stringify({})], "bad-alignment.json", { type: "application/json" });
    const { container } = render(<AssetPanel />);
    await user.click(screen.getByRole("button", { name: /高级工具/ }));
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
          name: "音频推断差异 1",
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
    await user.click(screen.getByRole("button", { name: /高级工具/ }));

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
            name: "已有版本差异",
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
          name: "音频推断差异 1",
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
    await user.click(screen.getByRole("button", { name: /高级工具/ }));

    fireEvent.change(screen.getByPlaceholderText("AlignmentProposal JSON"), {
      target: { value: JSON.stringify(proposal) }
    });
    await user.click(screen.getByRole("button", { name: "导入提案" }));

    expect(screen.getByText("应用已暂停")).toBeInTheDocument();
    expect(screen.getByText("待应用 0 / 已落点 0 / 阻断 2")).toBeInTheDocument();
    expect(screen.getByLabelText("对齐落点状态")).toHaveTextContent("阻断（当前项目已有同 ID 锚点）");
    expect(screen.getByLabelText("对齐落点状态")).toHaveTextContent("阻断（当前项目已有同 ID 版本差异）");
    expect(screen.getByText("1 个同步锚点 ID 已存在于当前项目（ID：audio-anchor-1），应用会丢失新锚点。")).toBeInTheDocument();
    expect(screen.getByText("1 个候选版本差异 ID 已存在于当前项目（ID：audio-gap-1），应用会丢失新的版本差异。")).toBeInTheDocument();
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
          name: "音频推断差异 1",
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
      await user.click(screen.getByRole("button", { name: /高级工具/ }));
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
          name: "音频推断差异 1",
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
              name: "已有版本差异",
              sourceAtMs: 20_000,
              targetGapMs: 5000,
              note: "已有项目版本差异"
            }
          ]
        }
      });
      render(<AssetPanel />);
      await user.click(screen.getByRole("button", { name: /高级工具/ }));
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
      await expect(readBlobText(blob)).resolves.toContain("1 个候选版本差异 ID 已存在于当前项目（ID：audio-gap-1）");
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
    await user.click(screen.getByRole("button", { name: /高级工具/ }));
    await user.click(screen.getByRole("button", { name: "选择完整版" }));
    await user.click(screen.getByRole("button", { name: "选择当前视频" }));
    await user.click(screen.getByRole("button", { name: "选择 FFmpeg" }));

    expect(screen.getByLabelText("完整版路径")).toHaveValue("D:\\media\\full.mkv");
    expect(screen.getByLabelText("当前视频路径")).toHaveValue("D:\\media\\cut.mp4");
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

function createTimedXml(count: number, intervalSeconds: number): string {
  const lines = Array.from(
    { length: count },
    (_, index) => `<d p="${index * intervalSeconds},1,25,16777215,0,0,u${index},r${index}">测试 ${index + 1}</d>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?><i>${lines.join("")}</i>`;
}

function getTargetMediaBindingPanel(): HTMLElement {
  const heading = screen.getByRole("heading", { name: "目标原片" });
  const panel = heading.closest("section");
  if (!(panel instanceof HTMLElement)) {
    throw new Error("未找到目标原片面板。");
  }
  return panel;
}

function getDiagnosticMetricText(label: string): string {
  const labelElement = screen.getByText(label);
  const metric = labelElement.closest("div");
  if (!(metric instanceof HTMLElement)) {
    throw new Error(`未找到诊断项：${label}`);
  }
  return metric.textContent ?? "";
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
