import { describe, expect, it } from "vitest";
import { createDanmakuSourceSegment } from "./sourceTimeline";
import { createEmptyProject } from "./factory";
import type { DanmakuAsset, DanmakuItem } from "../danmaku/types";
import type { ProjectMediaReference } from "./types";
import { createWorkspaceProgress } from "./workspaceProgress";

function createItem(assetId: string, index: number, sourceTimeMs: number): DanmakuItem {
  return {
    id: `${assetId}_item_${index}`,
    assetId,
    originalIndex: index,
    sourceTimeMs,
    mode: 1,
    fontSize: 25,
    color: 16777215,
    timestamp: 0,
    pool: 0,
    userHash: "hash",
    rowId: `${index}`,
    text: `弹幕 ${index}`,
    rawPFields: [String(sourceTimeMs / 1000), "1", "25", "16777215", "0", "0", "hash", String(index)],
    enabled: true
  };
}

function createAsset(id: string): DanmakuAsset {
  return {
    id,
    name: id,
    fileName: `${id}.xml`,
    color: "#ffffff",
    items: [createItem(id, 0, 10_000), createItem(id, 1, 600_000)],
    warnings: [],
    importedAt: "2026-07-11T00:00:00.000Z"
  };
}

function createMedia(
  id: string,
  role: ProjectMediaReference["role"],
  overrides: Partial<ProjectMediaReference> = {}
): ProjectMediaReference {
  return {
    id,
    role,
    name: id,
    fileName: `${id}.mp4`,
    objectUrl: null,
    durationMs: 3_600_000,
    referenceKind: "localPath",
    connectionState: "connected",
    sourceSummary: "本地文件",
    localPath: `C:/media/${id}.mp4`,
    emby: null,
    episodeKey: null,
    episodeLabel: role === "targetOriginal" ? id : null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...overrides
  };
}

describe("createWorkspaceProgress", () => {
  it("空项目推荐从素材页开始", () => {
    const progress = createWorkspaceProgress(createEmptyProject());
    expect(progress.recommendedPage).toBe("materials");
    expect(progress.completeStepCount).toBe(0);
    expect(progress.steps.find((step) => step.id === "materials")?.state).toBe("active");
    expect(progress.steps.find((step) => step.id === "export")?.state).toBe("idle");
  });

  it("素材齐备且来源段完成后推荐导出", () => {
    const project = createEmptyProject("暗黑 S01");
    const asset = createAsset("xml_long");
    project.assets = [asset];
    project.mediaLibrary = [
      createMedia("ref_long", "bilibiliReference"),
      createMedia("ep1", "targetOriginal", { episodeLabel: "第 1 集" }),
      createMedia("ep2", "targetOriginal", { episodeLabel: "第 2 集" })
    ];
    project.danmakuSourceBindings = [
      {
        id: "binding-1",
        assetId: asset.id,
        sourceMediaId: "ref_long",
        linkedAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z"
      }
    ];
    project.danmakuSourceSegments = [
      createDanmakuSourceSegment("seg_ep1", {
        kind: "content",
        assetId: asset.id,
        sourceMediaId: "ref_long",
        sourceStartMs: 0,
        sourceEndMs: 1_200_000,
        targetMediaId: "ep1",
        episodeKey: null,
        episodeLabel: "第 1 集"
      }),
      createDanmakuSourceSegment("seg_ep2", {
        kind: "content",
        assetId: asset.id,
        sourceMediaId: "ref_long",
        sourceStartMs: 1_200_000,
        sourceEndMs: 2_400_000,
        targetMediaId: "ep2",
        episodeKey: null,
        episodeLabel: "第 2 集"
      })
    ];
    project.assets[0].items.push(createItem(project.assets[0].id, 2, 1_310_000));

    const progress = createWorkspaceProgress(project);
    expect(progress.steps.find((step) => step.id === "materials")?.state).toBe("complete");
    expect(progress.steps.find((step) => step.id === "matching")?.state).toBe("complete");
    expect(progress.exportableEpisodeCount).toBe(2);
    expect(progress.steps.find((step) => step.id === "export")?.state).toBe("active");
    expect(progress.recommendedPage).toBe("export");
  });

  it("未绑定 XML 会阻断素材页完成", () => {
    const project = createEmptyProject();
    project.assets = [createAsset("xml_1")];
    project.mediaLibrary = [
      createMedia("ref", "bilibiliReference"),
      createMedia("ep1", "targetOriginal")
    ];
    const progress = createWorkspaceProgress(project);
    expect(progress.steps.find((step) => step.id === "materials")?.state).toBe("active");
    expect(progress.steps.find((step) => step.id === "materials")?.blockers).toContain(
      "还有 1 个 XML 未关联参考视频。"
    );
  });

  it("只确认部分原片时匹配步骤保持进行中并显示精确进度", () => {
    const project = createEmptyProject();
    const asset = createAsset("xml_long");
    project.assets = [asset];
    project.mediaLibrary = [
      createMedia("ref", "bilibiliReference"),
      createMedia("ep1", "targetOriginal"),
      createMedia("ep2", "targetOriginal")
    ];
    project.danmakuSourceBindings = [
      {
        id: "binding",
        assetId: asset.id,
        sourceMediaId: "ref",
        linkedAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z"
      }
    ];
    project.danmakuSourceSegments = [
      createDanmakuSourceSegment("seg-1", {
        kind: "content",
        assetId: asset.id,
        sourceMediaId: "ref",
        sourceStartMs: 0,
        sourceEndMs: 700_000,
        targetMediaId: "ep1",
        episodeKey: null,
        episodeLabel: "第 1 集"
      })
    ];

    const progress = createWorkspaceProgress(project);
    const matching = progress.steps.find((step) => step.id === "matching");

    expect(progress.confirmedTargetCount).toBe(1);
    expect(matching?.state).toBe("active");
    expect(matching?.stateText).toBe("1 / 2 个原片已确认");
    expect(matching?.blockers).toContain("还有 1 个原片未确认匹配关系。");
  });
});
