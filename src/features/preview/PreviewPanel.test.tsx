import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  });

  afterEach(() => {
    cleanup();
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
});
