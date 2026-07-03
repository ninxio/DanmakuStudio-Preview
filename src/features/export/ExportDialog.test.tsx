import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { DanmakuAsset, DanmakuClip } from "../../domain/danmaku/types";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { useEditorStore } from "../../stores/editorStore";
import { ExportDialog } from "./ExportDialog";

describe("导出摘要", () => {
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
          text: "导出弹幕",
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
      selection: { kind: "none", ids: [] },
      exportDraft: null
    });
  });

  it("显示导出摘要和验证状态", () => {
    useEditorStore.getState().prepareExport();
    render(<ExportDialog />);
    expect(screen.getByText("导出 XML 摘要")).toBeInTheDocument();
    expect(screen.getByText("导出 XML 可重新导入。 验证条数：1")).toBeInTheDocument();
  });
});
