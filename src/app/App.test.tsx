import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUT_HINT_SEARCH_SETTINGS } from "../domain/danmaku/cutHints";
import { createHistoryState } from "../domain/history/history";
import { createEmptyProject } from "../domain/project/factory";
import { useEditorStore } from "../stores/editorStore";
import { App } from "./App";

vi.mock("../infrastructure/settings/desktopAppSettings", () => ({
  hydrateDesktopAppSettings: vi.fn(() => Promise.resolve(null)),
  formatDesktopSettingsError: (error: unknown) =>
    error instanceof Error ? error.message : String(error)
}));

describe("App 拖放导入", () => {
  beforeEach(() => {
    useEditorStore.setState({
      project: createEmptyProject(),
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
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn<(object: Blob | MediaSource) => string>((object) =>
        object instanceof File ? `blob:${object.name}` : "blob:dropped-video"
      )
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn<(url: string) => void>()
    });
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("拖放 XML 和视频时先确认视频角色，不再静默当作参考素材", async () => {
    render(<App />);
    const root = screen.getByTestId("app-root");
    const xmlFile = new File(
      ['<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,r">测试</d></i>'],
      "episode.xml",
      { type: "text/xml" }
    );
    const videoFiles = [
      new File(["video-a"], "bilibili-cut-a.mp4", { type: "video/mp4" }),
      new File(["video-b"], "bilibili-cut-b.webm", { type: "video/webm" })
    ];

    fireEvent.dragEnter(root, {
      dataTransfer: createFileDataTransfer([xmlFile, ...videoFiles])
    });
    expect(screen.getByText("拖放导入")).toBeInTheDocument();

    fireEvent.drop(root, { dataTransfer: createFileDataTransfer([xmlFile, ...videoFiles]) });

    await waitFor(() => expect(useEditorStore.getState().project.assets).toHaveLength(1));
    expect(useEditorStore.getState().project.assets[0].fileName).toBe("episode.xml");
    expect(useEditorStore.getState().project.mediaLibrary).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "确认视频角色" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "共 2 个视频。原片是最终观看的标准时间轴；B 站参考只用于确定弹幕原始时间和删减关系。"
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "作为 B 站参考导入" }));

    expect(useEditorStore.getState().project.mediaLibrary).toEqual([
      expect.objectContaining({
        role: "bilibiliReference",
        fileName: "bilibili-cut-a.mp4",
        objectUrl: "blob:bilibili-cut-a.mp4",
        referenceKind: "browserFile",
        sourceSummary: "本地浏览器文件引用",
        localPath: null
      }),
      expect.objectContaining({
        role: "bilibiliReference",
        fileName: "bilibili-cut-b.webm",
        objectUrl: "blob:bilibili-cut-b.webm",
        referenceKind: "browserFile",
        sourceSummary: "本地浏览器文件引用",
        localPath: null
      })
    ]);
    expect(useEditorStore.getState().project.media).toBeNull();
    expect(useEditorStore.getState().project.mediaBinding).toBeNull();
    expect(screen.queryByRole("dialog", { name: "确认视频角色" })).not.toBeInTheDocument();
    expect(screen.queryByText("拖放导入")).not.toBeInTheDocument();
  });
});

function createFileDataTransfer(files: File[]): DataTransfer {
  return {
    types: ["Files"],
    files,
    dropEffect: "none"
  } as unknown as DataTransfer;
}
