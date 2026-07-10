import { fireEvent, render } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type { DanmakuAsset, DanmakuClip } from "../../domain/danmaku/types";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { useEditorStore } from "../../stores/editorStore";
import { KeyboardShortcuts } from "./KeyboardShortcuts";

describe("快捷键", () => {
  beforeEach(() => {
    const asset: DanmakuAsset = {
      id: "asset",
      name: "asset",
      fileName: "asset.xml",
      color: "#4cc9f0",
      importedAt: "now",
      warnings: [],
      items: [
        {
          id: "item",
          assetId: "asset",
          originalIndex: 0,
          sourceTimeMs: 1000,
          mode: 1,
          fontSize: 25,
          color: 16_777_215,
          timestamp: 0,
          pool: 0,
          userHash: "user",
          rowId: "row",
          text: "快捷键弹幕",
          rawPFields: ["1.000", "1", "25", "16777215", "0", "0", "user", "row"],
          enabled: true
        }
      ]
    };
    const clip: DanmakuClip = {
      id: "clip",
      assetId: "asset",
      name: "clip",
      timelineStartMs: 0,
      sourceInMs: 0,
      sourceOutMs: 5000,
      localOffsetMs: 0,
      enabled: true
    };
    useEditorStore.setState({
      project: { ...createEmptyProject(), assets: [asset], clips: [clip] },
      history: createHistoryState(),
      selection: { kind: "danmaku", ids: ["item"] },
      isPlaying: false
    });
  });

  it("方向键微调、M 标记版本差异、Ctrl+Z 撤销", () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(useEditorStore.getState().project.itemTimeAdjustments.item).toBe(10);
    fireEvent.keyDown(window, { key: "m" });
    expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(useEditorStore.getState().project.cutMarkers).toHaveLength(0);
  });

  it("支持工具切换、全选片段和删除片段", () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(window, { key: "b" });
    expect(useEditorStore.getState().timelineTool).toBe("blade");
    fireEvent.keyDown(window, { key: "v" });
    expect(useEditorStore.getState().timelineTool).toBe("select");
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    expect(useEditorStore.getState().selection).toEqual({ kind: "clip", ids: ["clip"] });
    act(() => {
      useEditorStore.setState({
        project: {
          ...useEditorStore.getState().project,
          timeline: { ...useEditorStore.getState().project.timeline, playheadMs: 2000 }
        }
      });
    });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(useEditorStore.getState().project.clips).toHaveLength(2);
    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    expect(useEditorStore.getState().project.clips).toHaveLength(1);
    fireEvent.keyDown(window, { key: "Delete" });
    expect(useEditorStore.getState().project.clips).toHaveLength(0);
  });
});
