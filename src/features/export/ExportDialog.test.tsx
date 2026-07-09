import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("显示补偿明细并可下载补偿报告", async () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:compensation-report");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    useEditorStore.setState({
      project: {
        ...useEditorStore.getState().project,
        name: "导出项目",
        cutMarkers: [
          {
            id: "cut-report",
            name: "手动补偿",
            sourceAtMs: 1000,
            targetGapMs: 12000,
            note: "复核说明"
          }
        ]
      }
    });

    try {
      useEditorStore.getState().prepareExport();
      render(<ExportDialog />);
      expect(screen.getByText("总补偿时长")).toBeInTheDocument();
      expect(screen.getByText("手动补偿")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "下载补偿报告" }));

      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      const [blob] = createObjectUrl.mock.calls[0];
      if (!(blob instanceof Blob)) {
        throw new Error("补偿报告下载对象不是 Blob。");
      }
      await expect(readBlobText(blob)).resolves.toContain("手动补偿");
      await expect(readBlobText(blob)).resolves.toContain("复核说明");
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:compensation-report");
    } finally {
      clickSpy.mockRestore();
      if (createDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
      if (revokeDescriptor) {
        Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  });
});

function readBlobText(blob: Blob): Promise<string> {
  const modernBlob = blob as Blob & { text?: () => Promise<string> };
  if (typeof modernBlob.text === "function") {
    return modernBlob.text();
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      if (reader.result instanceof ArrayBuffer) {
        resolve(new TextDecoder().decode(reader.result));
        return;
      }
      resolve("");
    };
    reader.onerror = () => reject(new Error("Blob 读取失败。"));
    reader.readAsText(blob);
  });
}
