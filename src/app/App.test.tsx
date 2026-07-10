import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUT_HINT_SEARCH_SETTINGS } from "../domain/danmaku/cutHints";
import { createHistoryState } from "../domain/history/history";
import { createEmptyProject } from "../domain/project/factory";
import { useEditorStore } from "../stores/editorStore";
import { App } from "./App";

vi.mock("../infrastructure/settings/desktopAppSettings", () => ({
  hydrateDesktopAppSettings: vi.fn(() => Promise.resolve(null)),
  formatDesktopSettingsError: (error: unknown) => (error instanceof Error ? error.message : String(error))
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
      value: vi.fn<(object: Blob | MediaSource) => string>(() => "blob:dropped-video")
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

  it("拖放 XML 和 MP4 时同时导入弹幕与参考视频", async () => {
    render(<App />);
    const root = screen.getByTestId("app-root");
    const xmlFile = new File(
      ['<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,r">测试</d></i>'],
      "episode.xml",
      { type: "text/xml" }
    );
    const videoFile = new File(["video"], "bilibili-cut.mp4", { type: "video/mp4" });

    fireEvent.dragEnter(root, { dataTransfer: createFileDataTransfer([xmlFile, videoFile]) });
    expect(screen.getByText("拖放导入")).toBeInTheDocument();

    fireEvent.drop(root, { dataTransfer: createFileDataTransfer([xmlFile, videoFile]) });

    await waitFor(() => expect(useEditorStore.getState().project.assets).toHaveLength(1));
    expect(useEditorStore.getState().project.assets[0].fileName).toBe("episode.xml");
    expect(useEditorStore.getState().project.media).toMatchObject({
      fileName: "bilibili-cut.mp4",
      objectUrl: "blob:dropped-video"
    });
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
