import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { DanmakuClip } from "../../domain/danmaku/types";
import { DEFAULT_CUT_HINT_SEARCH_SETTINGS } from "../../domain/danmaku/cutHints";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "../../stores/editorStore";
import { EditorToolbar } from "./EditorToolbar";

function resetToolbarStore(): void {
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
}

describe("编辑器工具栏", () => {
  beforeEach(() => {
    resetToolbarStore();
  });

  it("空项目禁用 XML 导出入口", () => {
    render(<EditorToolbar />);

    expect(screen.getByLabelText("请先添加时间轴片段再导出 XML")).toBeDisabled();
  });

  it("时间轴存在启用弹幕后允许导出 XML", () => {
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,r">测试</d></i>`,
      { assetId: "asset-exportable", fileName: "exportable.xml" }
    );
    const clip: DanmakuClip = {
      id: "clip-exportable",
      assetId: asset.id,
      name: asset.name,
      timelineStartMs: 0,
      sourceInMs: 0,
      sourceOutMs: 1000,
      localOffsetMs: 0,
      enabled: true
    };
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [asset],
        clips: [clip]
      }
    });

    render(<EditorToolbar />);

    expect(screen.getByLabelText("导出 XML")).toBeEnabled();
  });

  it("对齐提案存在应用阻断时禁用顶部应用入口", () => {
    useEditorStore.setState({
      alignmentProposal: {
        anchors: [{ id: "anchor", sourceMs: 10_000, targetMs: 20_000, origin: "automatic" }],
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
      }
    });

    render(<EditorToolbar />);

    expect(screen.getByRole("button", { name: "应用对齐" })).toBeDisabled();
  });
});
