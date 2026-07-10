import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CUT_HINT_SEARCH_SETTINGS } from "../../domain/danmaku/cutHints";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { useEditorStore } from "../../stores/editorStore";
import { TimelinePanel } from "./TimelinePanel";

describe("时间轴面板", () => {
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
  });

  it("对齐状态计数会区分待应用、已落点和阻断", () => {
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        syncAnchors: [{ id: "anchor-existing", sourceMs: 1000, targetMs: 2000, origin: "manual" }],
        cutMarkers: [{ id: "cut-existing", name: "已有补偿", sourceAtMs: 3000, targetGapMs: 1200, note: "" }]
      },
      alignmentProposal: {
        anchors: [{ id: "anchor-existing", sourceMs: 1200, targetMs: 2400, origin: "automatic" }],
        cutCandidates: [
          {
            id: "cut-existing",
            name: "同 ID 不同补偿",
            sourceAtMs: 3000,
            targetGapMs: 2400,
            confidence: 0.9,
            note: ""
          }
        ],
        confidence: 0.9,
        diagnostics: []
      }
    });

    render(<TimelinePanel />);

    expect(screen.getByText("对齐待应用 0 / 已落点 0 / 阻断 2")).toBeInTheDocument();
  });
});
