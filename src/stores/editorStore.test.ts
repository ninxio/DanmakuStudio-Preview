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
});
