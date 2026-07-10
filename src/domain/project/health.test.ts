import { describe, expect, it } from "vitest";
import type { DanmakuAsset, DanmakuItem } from "../danmaku/types";
import { createEmptyProject } from "./factory";
import { createProjectHealthSummary } from "./health";

describe("project health", () => {
  it("为空项目提示需要导入 XML", () => {
    const summary = createProjectHealthSummary(createEmptyProject());

    expect(summary.status).toBe("attention");
    expect(summary.metrics.assetCount).toBe(0);
    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        id: "no-assets",
        severity: "warning"
      })
    );
  });

  it("统计可用弹幕、片段和补偿规则", () => {
    const asset = createAsset("asset", [createItem("item-1"), { ...createItem("item-2"), enabled: false }]);
    const project = {
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        {
          id: "clip",
          assetId: "asset",
          name: "片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 3000,
          localOffsetMs: 0,
          enabled: true
        }
      ],
      cutMarkers: [{ id: "cut", name: "补偿", sourceAtMs: 1000, targetGapMs: 2500, note: "确认" }],
      syncAnchors: [{ id: "anchor", sourceMs: 1000, targetMs: 3500, confidence: 0.95, origin: "manual" as const }]
    };

    const summary = createProjectHealthSummary(project);

    expect(summary.status).toBe("ready");
    expect(summary.metrics).toMatchObject({
      assetCount: 1,
      itemCount: 2,
      enabledItemCount: 1,
      disabledItemCount: 1,
      clipCount: 1,
      activeClipCount: 1,
      cutMarkerCount: 1,
      totalCutGapMs: 2500,
      syncAnchorCount: 1
    });
    expect(summary.findings).toContainEqual(expect.objectContaining({ id: "ready" }));
  });

  it("阻断缺失资源引用和重复 ID", () => {
    const asset = createAsset("asset", [createItem("same-id"), createItem("same-id")]);
    const project = {
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        {
          id: "clip",
          assetId: "missing-asset",
          name: "坏片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 3000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    };

    const summary = createProjectHealthSummary(project);

    expect(summary.status).toBe("blocked");
    expect(summary.findings).toContainEqual(expect.objectContaining({ id: "item-id", severity: "error" }));
    expect(summary.findings).toContainEqual(expect.objectContaining({ id: "clip-missing-asset", severity: "error" }));
  });

  it("提示媒体重连、导入警告、低置信锚点和失效编辑引用", () => {
    const asset = createAsset("asset", [createItem("item-1")]);
    const project = {
      ...createEmptyProject(),
      media: {
        id: "media",
        name: "示例视频",
        fileName: "demo.mp4",
        objectUrl: null,
        durationMs: null
      },
      assets: [
        {
          ...asset,
          warnings: [
            {
              id: "warning",
              assetId: "asset",
              originalIndex: null,
              severity: "warning" as const,
              message: "跳过一条坏弹幕",
              rawSnippet: "<d/>"
            }
          ]
        }
      ],
      clips: [
        {
          id: "clip",
          assetId: "asset",
          name: "片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 3000,
          localOffsetMs: 0,
          enabled: true
        }
      ],
      syncAnchors: [{ id: "anchor", sourceMs: 1000, targetMs: 1200, confidence: 0.6, origin: "automatic" as const }],
      disabledItemIds: ["missing-item"],
      itemTimeAdjustments: { "missing-item": 100 }
    };

    const summary = createProjectHealthSummary(project);

    expect(summary.status).toBe("attention");
    expect(summary.metrics.mediaNeedsReconnect).toBe(true);
    expect(summary.metrics.orphanedEditReferenceCount).toBe(2);
    expect(summary.findings.map((finding) => finding.id)).toEqual(
      expect.arrayContaining([
        "media-needs-reconnect",
        "media-duration-missing",
        "import-warnings",
        "low-confidence-anchors",
        "orphaned-edits"
      ])
    );
  });
});

function createAsset(id: string, items: DanmakuItem[]): DanmakuAsset {
  return {
    id,
    name: id,
    fileName: `${id}.xml`,
    color: "#4cc9f0",
    items,
    warnings: [],
    importedAt: "2026-07-03T00:00:00.000Z"
  };
}

function createItem(id: string): DanmakuItem {
  return {
    id,
    assetId: "asset",
    originalIndex: 0,
    sourceTimeMs: 1000,
    mode: 1,
    fontSize: 25,
    color: 16_777_215,
    timestamp: 0,
    pool: 0,
    userHash: "u",
    rowId: "r",
    text: "测试",
    rawPFields: ["1", "1", "25", "16777215", "0", "0", "u", "r"],
    enabled: true
  };
}
