import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { useEditorStore } from "../../stores/editorStore";
import { PreviewPanel } from "./PreviewPanel";

describe("预览面板", () => {
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
      timelineTool: "select"
    });
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("无视频时显示占位提示", () => {
    render(<PreviewPanel />);
    expect(screen.getByText("尚未导入视频")).toBeInTheDocument();
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
  });

  it("可以切换弹幕显示状态", async () => {
    const user = userEvent.setup();
    render(<PreviewPanel />);
    await user.click(screen.getByRole("button", { name: "隐藏弹幕" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.preview.danmakuVisible).toBe(false)
    );
    expect(screen.getByRole("button", { name: "显示弹幕" })).toBeInTheDocument();
  });

  it("可以调整弹幕透明度", () => {
    render(<PreviewPanel />);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "0.5" } });
    expect(useEditorStore.getState().project.preview.opacity).toBe(0.5);
  });

  it("先打开空预览再导入视频时会加载预览并写入时长", async () => {
    render(<PreviewPanel />);
    expect(screen.getByText("尚未导入视频")).toBeInTheDocument();

    act(() => {
      useEditorStore.setState((state) => ({
        project: {
          ...state.project,
          media: {
            id: "media-local",
            name: "demo",
            fileName: "demo.mp4",
            objectUrl: "blob:demo-video",
            durationMs: null
          }
        }
      }));
    });

    const video = screen.getByTestId("preview-video");
    Object.defineProperty(video, "duration", { configurable: true, value: 12.345 });
    await screen.findByText("正在加载预览...");
    fireEvent.loadedMetadata(video);

    await waitFor(() =>
      expect(useEditorStore.getState().project.media?.durationMs).toBe(12_345)
    );
    expect(screen.getByText("demo.mp4")).toBeInTheDocument();
    expect(screen.getByText("预览已就绪 / 00:00:12.345")).toBeInTheDocument();
  });
});
