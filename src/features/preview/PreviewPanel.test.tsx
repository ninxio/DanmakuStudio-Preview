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

  it("本地目标原片缺少当前会话视频时提示重新连接", () => {
    useEditorStore.setState((state) => ({
      project: {
        ...state.project,
        mediaBinding: {
          id: "binding-local",
          kind: "localFile",
          displayName: "本地完整版",
          fileName: "full.mp4",
          mediaId: "media-local",
          localPath: null,
          runtimeMs: 3_000_000,
          linkedAt: "2026-07-10T00:00:00.000Z"
        }
      }
    }));

    render(<PreviewPanel />);

    expect(screen.getByText("需要重新连接视频")).toBeInTheDocument();
    expect(screen.getByText("项目保存了目标原片引用，但没有保存视频内容。请重新导入同一份本地视频。")).toBeInTheDocument();
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

  it("可以在当前播放点标记版本差异", async () => {
    const user = userEvent.setup();
    useEditorStore.setState((state) => ({
      project: {
        ...state.project,
        timeline: {
          ...state.project.timeline,
          playheadMs: 2500
        }
      }
    }));
    render(<PreviewPanel />);

    await user.click(screen.getByRole("button", { name: "添加播放点差异" }));

    expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1);
    expect(useEditorStore.getState().project.cutMarkers[0]).toMatchObject({
      sourceAtMs: 2500,
      targetGapMs: 45_000
    });
    expect(useEditorStore.getState().selection.kind).toBe("cut");
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

  it("视频格式不支持时说明 HTML Video 限制和 mpv 后续方向", async () => {
    render(<PreviewPanel />);
    act(() => {
      useEditorStore.setState((state) => ({
        project: {
          ...state.project,
          media: {
            id: "media-local",
            name: "demo",
            fileName: "demo.mkv",
            objectUrl: "blob:demo-video",
            durationMs: null
          }
        }
      }));
    });

    const video = screen.getByTestId("preview-video");
    await screen.findByText("正在加载预览...");
    fireEvent.error(video);

    await screen.findAllByText("格式不支持");
    expect(screen.getByText("HTML Video 无法播放此视频。请改用 MP4/WebM；MKV 或复杂编码需要后续启用 mpv 播放器。")).toBeInTheDocument();
  });
});
