import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DanmakuClip } from "../domain/danmaku/types";
import { DEFAULT_CUT_HINT_SEARCH_SETTINGS } from "../domain/danmaku/cutHints";
import { createHistoryState } from "../domain/history/history";
import { createEmptyProject } from "../domain/project/factory";
import type { EditorProject } from "../domain/project/types";
import { serializeProject } from "../domain/project/schema";
import { parseBilibiliXml } from "../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "./editorStore";

function resetStore(project: EditorProject = createEmptyProject()): void {
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
    timelineTool: "select"
  });
}

function createAsset(assetId: string, fileName: string) {
  return parseBilibiliXml(
    `<?xml version="1.0" encoding="UTF-8"?><i>
      <d p="0.000,1,25,16777215,0,0,u,a">开始</d>
      <d p="1.000,1,25,16777215,0,0,u,b">结束</d>
    </i>`,
    { assetId, fileName }
  );
}

function mockRevokeObjectUrl(): ReturnType<typeof vi.fn> {
  const revokeObjectUrl = vi.fn();
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectUrl
  });
  return revokeObjectUrl;
}

describe("editor store", () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });

  it("新建项目时释放旧视频 objectUrl", () => {
    const revokeSpy = mockRevokeObjectUrl();
    resetStore({
      ...createEmptyProject(),
      media: {
        id: "media",
        name: "demo",
        fileName: "demo.mp4",
        objectUrl: "blob:old",
        durationMs: 1000
      }
    });
    useEditorStore.getState().newProject();
    expect(revokeSpy).toHaveBeenCalledWith("blob:old");
    expect(useEditorStore.getState().project.media).toBeNull();
  });

  it("打开项目时释放旧视频 objectUrl", () => {
    const revokeSpy = mockRevokeObjectUrl();
    resetStore({
      ...createEmptyProject(),
      media: {
        id: "media",
        name: "old",
        fileName: "old.mp4",
        objectUrl: "blob:old-project",
        durationMs: 1000
      }
    });
    const nextProject = createEmptyProject("打开的项目");
    useEditorStore.getState().openProjectFromText(serializeProject(nextProject));
    expect(revokeSpy).toHaveBeenCalledWith("blob:old-project");
    expect(useEditorStore.getState().project.name).toBe("打开的项目");
  });

  it("追加片段时使用已有片段包含 localOffsetMs 的视觉结束点", () => {
    const firstAsset = createAsset("asset-a", "a.xml");
    const secondAsset = createAsset("asset-b", "b.xml");
    const existingClip: DanmakuClip = {
      id: "clip-a",
      assetId: firstAsset.id,
      name: firstAsset.name,
      timelineStartMs: 1000,
      sourceInMs: 0,
      sourceOutMs: 1000,
      localOffsetMs: 500,
      enabled: true
    };
    resetStore({
      ...createEmptyProject(),
      assets: [firstAsset, secondAsset],
      clips: [existingClip]
    });
    useEditorStore.getState().addAssetToTimeline(secondAsset.id);
    const addedClip = useEditorStore
      .getState()
      .project.clips.find((clip) => clip.assetId === secondAsset.id);
    expect(addedClip?.timelineStartMs).toBe(2500);
  });

  it("导入多个 XML 时按共享调色板顺序分配颜色", async () => {
    const firstFile = new File(
      ['<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,a">A</d></i>'],
      "a.xml",
      {
        type: "application/xml"
      }
    );
    const secondFile = new File(
      ['<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,b">B</d></i>'],
      "b.xml",
      {
        type: "application/xml"
      }
    );
    await useEditorStore.getState().importXmlFiles([firstFile, secondFile]);
    expect(useEditorStore.getState().project.assets.map((asset) => asset.color)).toEqual([
      "#4cc9f0",
      "#7bd88f"
    ]);
  });

  it("没有可导出弹幕时不会生成空 XML 草稿", () => {
    const asset = createAsset("asset-empty-export", "empty-export.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset]
    });

    useEditorStore.getState().prepareExport();

    expect(useEditorStore.getState().exportDraft).toBeNull();
    expect(useEditorStore.getState().status).toEqual({
      message: "当前没有可导出的弹幕，请先把 XML 放入时间轴。",
      tone: "warning"
    });
  });

  it("更新共享疑似删减扫描配置", () => {
    useEditorStore.getState().setCutHintSettings({
      keywordsText: "广告",
      windowSeconds: "30"
    });

    expect(useEditorStore.getState().cutHintSettings).toEqual({
      ...DEFAULT_CUT_HINT_SEARCH_SETTINGS,
      keywordsText: "广告",
      windowSeconds: "30"
    });
  });

  it("可把对齐提案发送到时间轴预览", () => {
    useEditorStore.getState().previewAlignmentProposalData({
      anchors: [{ id: "anchor", sourceMs: 10_000, targetMs: 20_000, confidence: 1, origin: "manual" }],
      cutCandidates: [],
      confidence: 0.5,
      diagnostics: []
    });

    expect(useEditorStore.getState().alignmentProposal?.anchors).toHaveLength(1);
    expect(useEditorStore.getState().status.message).toContain("时间轴预览");
  });

  it("阻止明显异常的对齐提案写入项目", () => {
    useEditorStore.getState().applyAlignmentProposalData({
      anchors: [{ id: "anchor", sourceMs: 10_000, targetMs: 20_000, confidence: 1, origin: "manual" }],
      cutCandidates: [
        {
          id: "cut",
          name: "异常区间",
          sourceAtMs: 20_000,
          sourceRangeStartMs: 22_000,
          sourceRangeEndMs: 18_000,
          targetGapMs: 20_000,
          confidence: 0.8,
          note: ""
        }
      ],
      confidence: 0.8,
      diagnostics: ["测试"]
    });

    expect(useEditorStore.getState().project.syncAnchors).toHaveLength(0);
    expect(useEditorStore.getState().project.cutMarkers).toHaveLength(0);
    expect(useEditorStore.getState().status).toEqual({
      message: "对齐提案存在应用阻断：1 个候选补偿的不确定区间起止顺序异常，请修正后再应用。",
      tone: "warning"
    });
  });

  it("更新和删除同步锚点", () => {
    resetStore({
      ...createEmptyProject(),
      syncAnchors: [{ id: "anchor", sourceMs: 1000, targetMs: 2000, confidence: 1, origin: "manual" }]
    });
    useEditorStore.setState({ selection: { kind: "anchor", ids: ["anchor"] } });

    useEditorStore.getState().updateSyncAnchor("anchor", { sourceMs: 1500, targetMs: 2600 });
    expect(useEditorStore.getState().project.syncAnchors[0]).toMatchObject({
      sourceMs: 1500,
      targetMs: 2600
    });

    useEditorStore.getState().deleteSyncAnchor("anchor");
    expect(useEditorStore.getState().project.syncAnchors).toHaveLength(0);
    expect(useEditorStore.getState().selection).toEqual({ kind: "none", ids: [] });
  });
});
