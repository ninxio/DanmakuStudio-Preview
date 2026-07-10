import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DanmakuClip } from "../domain/danmaku/types";
import { DEFAULT_CUT_HINT_SEARCH_SETTINGS } from "../domain/danmaku/cutHints";
import { createHistoryState } from "../domain/history/history";
import { createEmptyProject } from "../domain/project/factory";
import { CURRENT_SCHEMA_VERSION, type EditorProject } from "../domain/project/types";
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

function createAlignmentProposal() {
  return {
    anchors: [
      {
        id: "proposal-anchor",
        sourceMs: 10_000,
        targetMs: 12_000,
        confidence: 0.9,
        origin: "automatic" as const
      }
    ],
    cutCandidates: [
      {
        id: "proposal-cut",
        name: "候选补偿",
        sourceAtMs: 20_000,
        sourceRangeStartMs: 18_000,
        sourceRangeEndMs: 22_000,
        targetGapMs: 5000,
        confidence: 0.8,
        note: "测试"
      }
    ],
    confidence: 0.85,
    diagnostics: ["测试诊断"]
  };
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

  it("打开旧版项目时提示 schema 迁移和片段边界兼容", () => {
    const asset = createAsset("asset-legacy-open", "legacy.xml");
    const legacyProject: EditorProject = {
      ...createEmptyProject("旧版项目"),
      schemaVersion: 1,
      assets: [asset],
      clips: [
        {
          id: "clip-legacy-open",
          assetId: asset.id,
          name: "旧片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    };

    useEditorStore.getState().openProjectFromText(JSON.stringify(legacyProject));

    expect(useEditorStore.getState().project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(useEditorStore.getState().project.clips[0].sourceOutMs).toBe(1001);
    expect(useEditorStore.getState().status).toEqual({
      message: `已打开旧版项目：旧版项目。已从 v1 升级到 v${CURRENT_SCHEMA_VERSION}，并兼容调整 1 个片段边界。`,
      tone: "warning"
    });
  });

  it("打开项目时恢复持久化的对齐提案", () => {
    const project = {
      ...createEmptyProject("带提案项目"),
      alignmentProposal: createAlignmentProposal()
    };

    useEditorStore.getState().openProjectFromText(serializeProject(project));

    expect(useEditorStore.getState().alignmentProposal?.cutCandidates[0].id).toBe("proposal-cut");
    expect(useEditorStore.getState().project.alignmentProposal?.anchors[0].id).toBe("proposal-anchor");
  });

  it("预览对齐提案时同步写入项目文件状态", () => {
    const proposal = createAlignmentProposal();

    useEditorStore.getState().previewAlignmentProposalData(proposal);

    expect(useEditorStore.getState().alignmentProposal).toBe(proposal);
    expect(useEditorStore.getState().project.alignmentProposal).toBe(proposal);
  });

  it("清空对齐提案时同步项目状态并支持撤销重做", () => {
    const proposal = createAlignmentProposal();
    useEditorStore.getState().previewAlignmentProposalData(proposal);

    useEditorStore.getState().clearAlignmentProposal();

    expect(useEditorStore.getState().alignmentProposal).toBeNull();
    expect(useEditorStore.getState().project.alignmentProposal).toBeNull();
    expect(useEditorStore.getState().status).toEqual({
      message: "已清空当前对齐提案。",
      tone: "success"
    });

    useEditorStore.getState().undo();

    expect(useEditorStore.getState().alignmentProposal?.anchors[0].id).toBe("proposal-anchor");
    expect(useEditorStore.getState().project.alignmentProposal?.cutCandidates[0].id).toBe("proposal-cut");

    useEditorStore.getState().redo();

    expect(useEditorStore.getState().alignmentProposal).toBeNull();
    expect(useEditorStore.getState().project.alignmentProposal).toBeNull();
  });

  it("撤销和重做项目快照时同步顶层对齐提案", () => {
    const asset = createAsset("asset-with-preview", "preview.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset]
    });
    useEditorStore.getState().addAssetToTimeline(asset.id);
    useEditorStore.getState().previewAlignmentProposalData(createAlignmentProposal());

    expect(useEditorStore.getState().alignmentProposal?.anchors[0].id).toBe("proposal-anchor");
    expect(useEditorStore.getState().project.alignmentProposal?.anchors[0].id).toBe("proposal-anchor");

    useEditorStore.getState().undo();

    expect(useEditorStore.getState().project.alignmentProposal).toBeNull();
    expect(useEditorStore.getState().alignmentProposal).toBeNull();

    useEditorStore.getState().redo();

    expect(useEditorStore.getState().project.alignmentProposal).toBeNull();
    expect(useEditorStore.getState().alignmentProposal).toBeNull();
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

  it("新增片段使用半开源区间并覆盖最后一条弹幕", () => {
    const asset = createAsset("asset-source-range", "source-range.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset]
    });

    useEditorStore.getState().addAssetToTimeline(asset.id);

    const clip = useEditorStore.getState().project.clips[0];
    expect(clip.sourceInMs).toBe(0);
    expect(clip.sourceOutMs).toBe(1001);
    useEditorStore.getState().prepareExport();
    expect(useEditorStore.getState().exportDraft?.summary.enabledCount).toBe(2);
  });

  it("自动排列片段使用半开源区间并覆盖最后一条弹幕", () => {
    const asset = createAsset("asset-auto-range", "auto-range.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset]
    });

    useEditorStore.getState().autoArrangeClips();

    const clip = useEditorStore.getState().project.clips[0];
    expect(clip.sourceInMs).toBe(0);
    expect(clip.sourceOutMs).toBe(1001);
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

  it("XML 文件读取失败时清除导入进度并显示错误", async () => {
    const file = new File([""], "broken.xml", { type: "application/xml" });
    Object.defineProperty(file, "text", {
      configurable: true,
      value: vi.fn<() => Promise<string>>(() => Promise.reject(new Error("读取被拒绝")))
    });

    await useEditorStore.getState().importXmlFiles([file]);

    expect(useEditorStore.getState().project.assets).toHaveLength(0);
    expect(useEditorStore.getState().importProgress).toBeNull();
    expect(useEditorStore.getState().status).toEqual({
      message: "XML 导入失败：读取文件 broken.xml 失败：读取被拒绝",
      tone: "error"
    });
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

  it("项目健康存在阻断项时不会生成导出草稿", () => {
    const asset = createAsset("asset-blocked-export", "blocked-export.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        {
          id: "clip-missing-asset",
          assetId: "missing-asset",
          name: "坏片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    });

    useEditorStore.getState().prepareExport();

    expect(useEditorStore.getState().exportDraft).toBeNull();
    expect(useEditorStore.getState().status).toEqual({
      message: "项目健康检查未通过：片段引用了缺失资源。请在项目信息中处理后再导出。",
      tone: "warning"
    });
  });

  it("项目健康存在多个阻断项时导出提示会汇总标题", () => {
    const asset = createAsset("asset-multi-blocked-export", "multi-blocked-export.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [
        {
          ...asset,
          items: asset.items.map((item, index) => (index === 1 ? { ...item, id: asset.items[0].id } : item))
        }
      ],
      clips: [
        {
          id: "clip-missing-asset",
          assetId: "missing-asset",
          name: "坏片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    });

    useEditorStore.getState().prepareExport();

    expect(useEditorStore.getState().exportDraft).toBeNull();
    expect(useEditorStore.getState().status).toEqual({
      message: "项目健康检查未通过：弹幕 ID 重复、片段引用了缺失资源。请在项目信息中处理后再导出。",
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

  it("清理失效编辑引用并写入历史", () => {
    const asset = createAsset("asset-cleanup", "cleanup.xml");
    const validItemId = asset.items[0].id;
    resetStore({
      ...createEmptyProject(),
      assets: [asset],
      disabledItemIds: [validItemId, "missing-disabled"],
      itemTimeAdjustments: {
        [validItemId]: 100,
        "missing-adjustment": 200
      }
    });

    useEditorStore.getState().cleanupProjectEditReferences();

    expect(useEditorStore.getState().project.disabledItemIds).toEqual([validItemId]);
    expect(useEditorStore.getState().project.itemTimeAdjustments).toEqual({ [validItemId]: 100 });
    expect(useEditorStore.getState().history.past.at(-1)?.label).toBe("清理失效编辑引用");
    expect(useEditorStore.getState().status).toEqual({
      message: "已清理 2 条失效编辑引用。",
      tone: "success"
    });
  });

  it("没有失效编辑引用时不写入历史", () => {
    const asset = createAsset("asset-no-cleanup", "no-cleanup.xml");
    const validItemId = asset.items[0].id;
    resetStore({
      ...createEmptyProject(),
      assets: [asset],
      disabledItemIds: [validItemId],
      itemTimeAdjustments: {
        [validItemId]: 100
      }
    });

    useEditorStore.getState().cleanupProjectEditReferences();

    expect(useEditorStore.getState().history.past).toHaveLength(0);
    expect(useEditorStore.getState().status).toEqual({
      message: "当前没有需要清理的失效编辑引用。",
      tone: "neutral"
    });
  });

  it("清理缺失资源片段并过滤选择状态", () => {
    const asset = createAsset("asset-missing-clip-cleanup", "missing-clip-cleanup.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        {
          id: "clip-valid",
          assetId: asset.id,
          name: "有效片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        },
        {
          id: "clip-missing",
          assetId: "missing-asset",
          name: "坏片段",
          timelineStartMs: 1000,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    });
    useEditorStore.setState({ selection: { kind: "clip", ids: ["clip-valid", "clip-missing"] } });

    useEditorStore.getState().cleanupProjectMissingAssetClips();

    expect(useEditorStore.getState().project.clips.map((clip) => clip.id)).toEqual(["clip-valid"]);
    expect(useEditorStore.getState().selection).toEqual({ kind: "clip", ids: ["clip-valid"] });
    expect(useEditorStore.getState().history.past.at(-1)?.label).toBe("清理缺失资源片段");
    expect(useEditorStore.getState().status).toEqual({
      message: "已清理 1 个缺失资源片段。",
      tone: "success"
    });
  });

  it("没有缺失资源片段时不写入历史", () => {
    const asset = createAsset("asset-valid-clip-cleanup", "valid-clip-cleanup.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        {
          id: "clip-valid",
          assetId: asset.id,
          name: "有效片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    });

    useEditorStore.getState().cleanupProjectMissingAssetClips();

    expect(useEditorStore.getState().history.past).toHaveLength(0);
    expect(useEditorStore.getState().status).toEqual({
      message: "当前没有需要清理的缺失资源片段。",
      tone: "neutral"
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

  it("阻止对齐提案使用当前项目已有 ID", () => {
    resetStore({
      ...createEmptyProject(),
      syncAnchors: [{ id: "anchor-existing", sourceMs: 1000, targetMs: 2000, confidence: 1, origin: "manual" }],
      cutMarkers: [{ id: "cut-existing", name: "已有补偿", sourceAtMs: 3000, targetGapMs: 1200, note: "" }]
    });

    useEditorStore.getState().applyAlignmentProposalData({
      anchors: [{ id: "anchor-existing", sourceMs: 4000, targetMs: 6000, confidence: 0.9, origin: "automatic" }],
      cutCandidates: [
        {
          id: "cut-existing",
          name: "冲突补偿",
          sourceAtMs: 7000,
          targetGapMs: 2000,
          confidence: 0.9,
          note: ""
        }
      ],
      confidence: 0.9,
      diagnostics: ["测试"]
    });

    expect(useEditorStore.getState().project.syncAnchors).toHaveLength(1);
    expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1);
    expect(useEditorStore.getState().history.past).toHaveLength(0);
    expect(useEditorStore.getState().status).toEqual({
      message: "对齐提案存在应用阻断：1 个同步锚点 ID 已存在于当前项目（ID：anchor-existing），应用会丢失新锚点。",
      tone: "warning"
    });
  });

  it("应用对齐提案时跳过已经按时间落点的项目", () => {
    resetStore({
      ...createEmptyProject(),
      syncAnchors: [{ id: "anchor-existing", sourceMs: 10_000, targetMs: 20_000, confidence: 1, origin: "manual" }],
      cutMarkers: [{ id: "cut-existing", name: "已有补偿", sourceAtMs: 30_000, targetGapMs: 12_000, note: "" }]
    });

    useEditorStore.getState().applyAlignmentProposalData({
      anchors: [
        { id: "anchor-duplicate-time", sourceMs: 10_000, targetMs: 20_000, confidence: 0.8, origin: "automatic" },
        { id: "anchor-new", sourceMs: 40_000, targetMs: 52_000, confidence: 0.8, origin: "automatic" }
      ],
      cutCandidates: [
        {
          id: "cut-duplicate-time",
          name: "重复时间补偿",
          sourceAtMs: 30_000,
          targetGapMs: 12_000,
          confidence: 0.8,
          note: ""
        },
        {
          id: "cut-new",
          name: "新补偿",
          sourceAtMs: 60_000,
          targetGapMs: 15_000,
          confidence: 0.8,
          note: ""
        }
      ],
      confidence: 0.8,
      diagnostics: []
    });

    expect(useEditorStore.getState().project.syncAnchors.map((anchor) => anchor.id)).toEqual([
      "anchor-existing",
      "anchor-new"
    ]);
    expect(useEditorStore.getState().project.cutMarkers.map((marker) => marker.id)).toEqual([
      "cut-existing",
      "cut-new"
    ]);
    expect(useEditorStore.getState().history.past).toHaveLength(1);
    expect(useEditorStore.getState().status).toEqual({
      message: "已应用对齐提案：新增 1 个锚点，1 个补偿点。",
      tone: "success"
    });
  });

  it("对齐提案全部已落点时不写入历史", () => {
    resetStore({
      ...createEmptyProject(),
      syncAnchors: [{ id: "anchor-existing", sourceMs: 10_000, targetMs: 20_000, confidence: 1, origin: "manual" }],
      cutMarkers: [{ id: "cut-existing", name: "已有补偿", sourceAtMs: 30_000, targetGapMs: 12_000, note: "" }]
    });

    useEditorStore.getState().applyAlignmentProposalData({
      anchors: [{ id: "anchor-existing", sourceMs: 10_000, targetMs: 20_000, confidence: 0.8, origin: "automatic" }],
      cutCandidates: [
        {
          id: "cut-existing",
          name: "重复时间补偿",
          sourceAtMs: 30_000,
          targetGapMs: 12_000,
          confidence: 0.8,
          note: ""
        }
      ],
      confidence: 0.8,
      diagnostics: []
    });

    expect(useEditorStore.getState().project.syncAnchors.map((anchor) => anchor.id)).toEqual(["anchor-existing"]);
    expect(useEditorStore.getState().project.cutMarkers.map((marker) => marker.id)).toEqual(["cut-existing"]);
    expect(useEditorStore.getState().history.past).toHaveLength(0);
    expect(useEditorStore.getState().status).toEqual({
      message: "对齐提案没有新的可应用项。",
      tone: "neutral"
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
