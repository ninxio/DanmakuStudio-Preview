import { describe, expect, it } from "vitest";
import type { DanmakuAsset, DanmakuItem } from "../danmaku/types";
import { createEmptyProject } from "./factory";
import {
  cleanupProjectEditReferences,
  cleanupProjectMissingAssetClips,
  createProjectHealthReport,
  createProjectHealthSummary
} from "./health";

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
      syncAnchorCount: 1,
      negativeFinalTimeItemCount: 0
    });
    expect(summary.findings).toContainEqual(expect.objectContaining({ id: "ready" }));
  });

  it("阻断缺失资源引用和重复 ID，并记录重复位置", () => {
    const asset = createAsset("asset", [createItem("same-id"), { ...createItem("same-id"), originalIndex: 1 }]);
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
    expect(summary.metrics.missingAssetClipCount).toBe(1);
    expect(summary.metrics.duplicateIdCount).toBe(1);
    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        id: "item-id",
        severity: "error",
        evidence: ["same-id：资源 asset.xml 的第 1 条弹幕；资源 asset.xml 的第 2 条弹幕"]
      })
    );
    expect(summary.findings).toContainEqual(expect.objectContaining({ id: "clip-missing-asset", severity: "error" }));

    const report = createProjectHealthReport("重复项目", summary);
    expect(report).toContain("重复 ID：1 个");
    expect(report).toContain("same-id：资源 asset.xml 的第 1 条弹幕；资源 asset.xml 的第 2 条弹幕");
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

  it("提示会在导出时被限制为 0ms 的负最终时间", () => {
    const asset = createAsset("asset", [createItem("item-1")]);
    const project = {
      ...createEmptyProject(),
      globalOffsetMs: -1500,
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
      ]
    };

    const summary = createProjectHealthSummary(project);
    const report = createProjectHealthReport("负时间项目", summary);

    expect(summary.status).toBe("attention");
    expect(summary.metrics.negativeFinalTimeItemCount).toBe(1);
    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        id: "negative-final-times",
        severity: "warning",
        evidence: ["asset.xml / 片段 / 第 1 条：-00:00:00.500，测试"]
      })
    );
    expect(report).toContain("负最终时间：1 条");
    expect(report).toContain("[需复核] 存在负最终时间");
  });

  it("可清理指向不存在弹幕的禁用和微调引用", () => {
    const asset = createAsset("asset", [createItem("item-1")]);
    const project = {
      ...createEmptyProject(),
      assets: [asset],
      disabledItemIds: ["item-1", "missing-disabled"],
      itemTimeAdjustments: {
        "item-1": 100,
        "missing-adjustment": 200
      }
    };

    const cleanup = cleanupProjectEditReferences(project);

    expect(cleanup.changed).toBe(true);
    expect(cleanup.removedDisabledItemIds).toBe(1);
    expect(cleanup.removedItemAdjustments).toBe(1);
    expect(cleanup.project.disabledItemIds).toEqual(["item-1"]);
    expect(cleanup.project.itemTimeAdjustments).toEqual({ "item-1": 100 });
  });

  it("可清理引用缺失资源的片段", () => {
    const asset = createAsset("asset", [createItem("item-1")]);
    const project = {
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        {
          id: "clip-valid",
          assetId: "asset",
          name: "有效片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 3000,
          localOffsetMs: 0,
          enabled: true
        },
        {
          id: "clip-missing",
          assetId: "missing-asset",
          name: "坏片段",
          timelineStartMs: 3000,
          sourceInMs: 0,
          sourceOutMs: 3000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    };

    const cleanup = cleanupProjectMissingAssetClips(project);

    expect(cleanup.changed).toBe(true);
    expect(cleanup.removedClipIds).toEqual(["clip-missing"]);
    expect(cleanup.removedClipCount).toBe(1);
    expect(cleanup.project.clips.map((clip) => clip.id)).toEqual(["clip-valid"]);
  });

  it("可生成项目健康报告文本", () => {
    const summary = createProjectHealthSummary({
      ...createEmptyProject("报告项目"),
      assets: [createAsset("asset", [createItem("item-1")])],
      disabledItemIds: ["missing-disabled"]
    });

    const report = createProjectHealthReport("报告项目", summary);

    expect(report).toContain("项目健康报告");
    expect(report).toContain("项目：报告项目");
    expect(report).toContain("状态：需复核");
    expect(report).toContain("失效编辑引用：1 条");
    expect(report).toContain("缺失资源片段：0 个");
    expect(report).toContain("重复 ID：0 个");
    expect(report).toContain("负最终时间：0 条");
    expect(report).toContain("[需复核] 存在失效编辑引用");
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
