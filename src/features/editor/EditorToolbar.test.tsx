import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("顶部保存项目时使用实际文件名更新状态", () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:toolbar-project");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });

    try {
      useEditorStore.setState({
        project: {
          ...createEmptyProject(),
          name: "保存/项目:草稿"
        }
      });

      render(<EditorToolbar />);
      fireEvent.click(screen.getByLabelText("保存项目"));

      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("顶部项目保存未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("保存_项目_草稿.danmaku-project.json");
      expect(useEditorStore.getState().status.message).toBe("已保存项目文件：保存_项目_草稿.danmaku-project.json。");
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:toolbar-project");
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

  it("顶部导出对齐提案时使用项目名生成文件名", () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:toolbar-alignment-proposal");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });

    try {
      useEditorStore.setState({
        project: {
          ...createEmptyProject(),
          name: "工具栏/对齐:项目"
        },
        alignmentProposal: {
          anchors: [{ id: "toolbar-anchor", sourceMs: 10_000, targetMs: 20_000, origin: "automatic" }],
          cutCandidates: [],
          confidence: 0.8,
          diagnostics: ["测试"]
        }
      });

      render(<EditorToolbar />);
      fireEvent.click(screen.getByRole("button", { name: "导出对齐" }));

      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("顶部对齐提案下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("工具栏_对齐_项目-alignment-proposal.json");
      expect(useEditorStore.getState().status.message).toBe(
        "已导出对齐提案 JSON：工具栏_对齐_项目-alignment-proposal.json。"
      );
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:toolbar-alignment-proposal");
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

  it("对齐提案复用当前项目 ID 时禁用顶部应用入口", () => {
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        syncAnchors: [{ id: "anchor-existing", sourceMs: 10_000, targetMs: 12_000, confidence: 1, origin: "manual" }],
        cutMarkers: [
          {
            id: "cut-existing",
            name: "已有补偿",
            sourceAtMs: 20_000,
            targetGapMs: 1000,
            note: ""
          }
        ]
      },
      alignmentProposal: {
        anchors: [{ id: "anchor-existing", sourceMs: 10_000, targetMs: 20_000, origin: "automatic" }],
        cutCandidates: [
          {
            id: "cut-existing",
            name: "冲突补偿",
            sourceAtMs: 20_000,
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

    const applyButton = screen.getByRole("button", { name: "应用对齐" });
    expect(applyButton).toBeDisabled();
    expect(applyButton).toHaveAttribute(
      "title",
      "1 个同步锚点 ID 已存在于当前项目（ID：anchor-existing），应用会丢失新锚点。"
    );
  });
});
