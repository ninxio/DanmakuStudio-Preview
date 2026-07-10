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
    expect(screen.getByText("导出前健康检查")).toBeInTheDocument();
    expect(screen.getByText("导出 XML 可重新导入。 验证条数：1")).toBeInTheDocument();
  });

  it("显示导出前健康复核项并可下载健康报告", async () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:project-health-report");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    const project = useEditorStore.getState().project;
    useEditorStore.setState({
      project: {
        ...project,
        name: "健康复核项目",
        assets: [
          {
            ...project.assets[0],
            warnings: [
              {
                id: "warning",
                assetId: project.assets[0].id,
                originalIndex: null,
                severity: "warning" as const,
                message: "跳过一条坏弹幕",
                rawSnippet: "<d/>"
              }
            ]
          }
        ]
      }
    });

    try {
      useEditorStore.getState().prepareExport();
      render(<ExportDialog />);

      expect(screen.getAllByText("需复核").length).toBeGreaterThan(0);
      expect(screen.getByText("导入时存在警告")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "下载健康报告" }));

      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      const [blob] = createObjectUrl.mock.calls[0];
      if (!(blob instanceof Blob)) {
        throw new Error("健康报告下载对象不是 Blob。");
      }
      await expect(readBlobText(blob)).resolves.toContain("项目健康报告");
      await expect(readBlobText(blob)).resolves.toContain("导入时存在警告");
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:project-health-report");
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

  it("显示补偿明细并可下载导出报告", async () => {
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
      fireEvent.click(screen.getByRole("button", { name: "下载导出报告" }));

      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      const [blob] = createObjectUrl.mock.calls[0];
      if (!(blob instanceof Blob)) {
        throw new Error("导出报告下载对象不是 Blob。");
      }
      await expect(readBlobText(blob)).resolves.toContain("补偿明细");
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

  it("显示负时间限制明细", () => {
    const project = useEditorStore.getState().project;
    const baseItem = project.assets[0].items[0];
    useEditorStore.setState({
      project: {
        ...project,
        assets: [
          {
            ...project.assets[0],
            items: [
              { ...baseItem, id: "item-1", originalIndex: 0, sourceTimeMs: 1000, text: "导出弹幕" },
              { ...baseItem, id: "item-2", originalIndex: 1, sourceTimeMs: 1100, text: "第二条导出弹幕" },
              { ...baseItem, id: "item-3", originalIndex: 2, sourceTimeMs: 1200, text: "第三条导出弹幕" }
            ]
          }
        ],
        globalOffsetMs: -1500
      }
    });

    useEditorStore.getState().prepareExport();
    render(<ExportDialog />);

    expect(screen.getByText("负时间限制为 0")).toBeInTheDocument();
    expect(screen.getByText("3 项")).toBeInTheDocument();
    expect(screen.getByText("存在负最终时间")).toBeInTheDocument();
    expect(screen.getByText("asset.xml / clip / 第 1 条：-00:00:00.500，导出弹幕")).toBeInTheDocument();
    expect(screen.getByText("asset.xml / clip / 第 2 条：-00:00:00.400，第二条导出弹幕")).toBeInTheDocument();
    expect(screen.getByText("另有 1 条证据，可下载健康报告查看。")).toBeInTheDocument();
    expect(screen.getByText("负时间限制明细")).toBeInTheDocument();
    expect(screen.getByText("导出弹幕")).toBeInTheDocument();
    expect(screen.getByText("-00:00:00.500 -> 00:00:00.000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载导出报告" })).toBeInTheDocument();
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
