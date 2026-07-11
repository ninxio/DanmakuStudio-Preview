import { describe, expect, it } from "vitest";
import type { DanmakuAsset, DanmakuItem } from "../danmaku/types";
import { createEmptyProject } from "../project/factory";
import { createDanmakuSourceBinding } from "../project/mediaLibrary";
import { createDanmakuSourceSegment } from "../project/sourceTimeline";
import type { EditorProject, ProjectMediaReference } from "../project/types";
import { projectDanmakuToTargets } from "./sourceProjection";

function createItem(
  assetId: string,
  index: number,
  sourceTimeMs: number,
  text = `弹幕 ${index}`
): DanmakuItem {
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
    text,
    rawPFields: [
      String(sourceTimeMs / 1000),
      "1",
      "25",
      "16777215",
      "0",
      "0",
      "hash",
      String(index)
    ],
    enabled: true
  };
}

function createAsset(id: string, times: number[]): DanmakuAsset {
  return {
    id,
    name: id,
    fileName: `${id}.xml`,
    color: "#ffffff",
    items: times.map((timeMs, index) => createItem(id, index, timeMs)),
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
    episodeLabel: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...overrides
  };
}

function createProjectWithLongReference(): EditorProject {
  const project = createEmptyProject("投影测试");
  const asset = createAsset("asset_long", [
    10_000, // 集1 开头
    600_000, // 集1 中部
    1_310_000, // 集2 开头附近
    1_500_000, // 集2 内、位于删减点之后
    2_650_000, // 集3 内
    2_900_000 // 未覆盖区域（无来源段）
  ]);
  project.assets = [asset];
  project.mediaLibrary = [
    createMedia("ref_long", "bilibiliReference"),
    createMedia("ep1", "targetOriginal", { episodeLabel: "第 1 集" }),
    createMedia("ep2", "targetOriginal", { episodeLabel: "第 2 集" }),
    createMedia("ep3", "targetOriginal", { episodeLabel: "第 3 集" })
  ];
  project.danmakuSourceBindings = [
    createDanmakuSourceBinding("binding_asset_long", asset.id, "ref_long")
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
    createDanmakuSourceSegment("seg_gap", {
      kind: "ignored",
      assetId: asset.id,
      sourceMediaId: "ref_long",
      sourceStartMs: 1_200_000,
      sourceEndMs: 1_290_000,
      targetMediaId: null,
      episodeKey: null,
      episodeLabel: null
    }),
    createDanmakuSourceSegment("seg_ep2", {
      kind: "content",
      assetId: asset.id,
      sourceMediaId: "ref_long",
      sourceStartMs: 1_290_000,
      sourceEndMs: 2_400_000,
      targetMediaId: "ep2",
      episodeKey: null,
      episodeLabel: "第 2 集",
      timingRules: [{ sourceAtMs: 1_400_000, gapMs: 45_000, note: "审核删减补偿" }]
    }),
    createDanmakuSourceSegment("seg_ep3", {
      kind: "content",
      assetId: asset.id,
      sourceMediaId: "ref_long",
      sourceStartMs: 2_400_000,
      sourceEndMs: 2_800_000,
      targetMediaId: "ep3",
      episodeKey: null,
      episodeLabel: "第 3 集",
      targetStartMs: 90_000
    })
  ];
  return project;
}

describe("projectDanmakuToTargets", () => {
  it("把长参考视频的弹幕按来源段投影到多个原片", () => {
    const project = createProjectWithLongReference();
    const result = projectDanmakuToTargets(project);

    expect(result.status).toBe("readyWithWarnings");
    expect(result.groups).toHaveLength(3);
    expect(result.contentSegmentCount).toBe(3);
    expect(result.ignoredSegmentCount).toBe(1);

    const ep1 = result.groups.find((group) => group.targetMediaId === "ep1");
    expect(ep1).toBeDefined();
    expect(ep1?.entries.map((entry) => entry.finalTimeMs)).toEqual([10_000, 600_000]);

    const ep2 = result.groups.find((group) => group.targetMediaId === "ep2");
    // 1_310_000 - 1_290_000 = 20_000（删减点之前，不加 gap）
    // 1_500_000 - 1_290_000 + 45_000 = 255_000（删减点之后加 gap）
    expect(ep2?.entries.map((entry) => entry.finalTimeMs)).toEqual([20_000, 255_000]);
    expect(ep2?.appliedRules).toHaveLength(1);
    expect(ep2?.appliedRules[0].affectedCount).toBe(1);

    const ep3 = result.groups.find((group) => group.targetMediaId === "ep3");
    // 2_650_000 - 2_400_000 + 90_000（targetStartMs） = 340_000
    expect(ep3?.entries.map((entry) => entry.finalTimeMs)).toEqual([340_000]);

    expect(result.projectedItemCount).toBe(5);
    expect(result.unmappedItemCount).toBe(1);
    expect(result.issues.some((issue) => issue.id === "unmapped-items")).toBe(true);
  });

  it("忽略段内的弹幕不投影", () => {
    const project = createProjectWithLongReference();
    project.assets[0].items.push(createItem(project.assets[0].id, 100, 1_250_000, "忽略段内"));
    const result = projectDanmakuToTargets(project);
    const allEntryIds = result.groups.flatMap((group) =>
      group.entries.map((entry) => entry.item.id)
    );
    expect(allEntryIds).not.toContain(`${project.assets[0].id}_item_100`);
    expect(result.ignoredItemCount).toBe(1);
  });

  it("没有任何来源段的其他 XML 弹幕也计入未映射", () => {
    const project = createProjectWithLongReference();
    project.assets.push(createAsset("asset_without_segments", [5_000, 15_000]));

    const result = projectDanmakuToTargets(project);
    const unmappedIssue = result.issues.find((issue) => issue.id === "unmapped-items");

    expect(result.unmappedItemCount).toBe(3);
    expect(unmappedIssue?.severity).toBe("warning");
    expect(unmappedIssue?.message).toContain("3 条弹幕");
  });

  it("禁用弹幕不投影但计入统计", () => {
    const project = createProjectWithLongReference();
    project.disabledItemIds = [`${project.assets[0].id}_item_0`];
    const result = projectDanmakuToTargets(project);
    const ep1 = result.groups.find((group) => group.targetMediaId === "ep1");
    expect(ep1?.entries.map((entry) => entry.finalTimeMs)).toEqual([600_000]);
    expect(ep1?.disabledCount).toBe(1);
  });

  it("单条弹幕时间调整参与投影", () => {
    const project = createProjectWithLongReference();
    project.itemTimeAdjustments = { [`${project.assets[0].id}_item_0`]: -2_000 };
    const result = projectDanmakuToTargets(project);
    const ep1 = result.groups.find((group) => group.targetMediaId === "ep1");
    expect(ep1?.entries.map((entry) => entry.finalTimeMs)).toEqual([8_000, 600_000]);
  });

  it("缺少目标原片的正片段会阻断并给出可读错误", () => {
    const project = createProjectWithLongReference();
    project.danmakuSourceSegments = [
      createDanmakuSourceSegment("seg_no_target", {
        kind: "content",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 0,
        sourceEndMs: 1_200_000,
        targetMediaId: null,
        episodeKey: null,
        episodeLabel: null
      })
    ];
    const result = projectDanmakuToTargets(project);
    expect(result.status).toBe("blocked");
    expect(result.groups).toHaveLength(0);
    expect(result.issues[0].severity).toBe("error");
    expect(result.issues[0].message).toContain("目标原片");
  });

  it("XML 绑定的参考素材与来源段不一致时阻断投影", () => {
    const project = createProjectWithLongReference();
    project.mediaLibrary.push(createMedia("ref_bound", "bilibiliReference"));
    project.danmakuSourceBindings = [
      createDanmakuSourceBinding("binding_asset_long", project.assets[0].id, "ref_bound")
    ];
    project.danmakuSourceSegments = project.danmakuSourceSegments.filter(
      (segment) => segment.id === "seg_ep1"
    );

    const result = projectDanmakuToTargets(project);
    const mismatchIssue = result.issues.find((issue) => issue.segmentId === "seg_ep1");

    expect(result.status).toBe("blocked");
    expect(result.groups).toHaveLength(0);
    expect(mismatchIssue?.severity).toBe("error");
    expect(mismatchIssue?.message).toContain("与所属 XML 在素材页的绑定不一致");
  });

  it("来源段所属 XML 完全没有参考素材绑定时阻断投影", () => {
    const project = createProjectWithLongReference();
    project.danmakuSourceBindings = [];
    project.danmakuSourceSegments = project.danmakuSourceSegments.filter(
      (segment) => segment.id === "seg_ep1"
    );

    const result = projectDanmakuToTargets(project);
    const missingBindingIssue = result.issues.find((issue) => issue.segmentId === "seg_ep1");

    expect(result.status).toBe("blocked");
    expect(result.groups).toHaveLength(0);
    expect(missingBindingIssue?.severity).toBe("error");
    expect(missingBindingIssue?.message).toContain("尚未在素材页绑定 B 站参考素材");
  });

  it("忽略段使用与 XML 绑定不一致的参考素材时阻断且不静默吞掉弹幕", () => {
    const project = createProjectWithLongReference();
    project.mediaLibrary.push(createMedia("ref_other", "bilibiliReference"));
    project.danmakuSourceSegments.push(
      createDanmakuSourceSegment("ignored_wrong_source", {
        label: "错误参考忽略段",
        kind: "ignored",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_other",
        sourceStartMs: 2_800_000,
        sourceEndMs: 3_000_000,
        targetMediaId: null,
        episodeKey: null,
        episodeLabel: null
      })
    );

    const result = projectDanmakuToTargets(project);
    const issue = result.issues.find(
      (candidate) => candidate.segmentId === "ignored_wrong_source"
    );

    expect(result.status).toBe("blocked");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("绑定不一致");
    expect(result.unmappedItemCount).toBeGreaterThan(0);
  });

  it("忽略段所属 XML 没有参考绑定时阻断且不计为有效忽略覆盖", () => {
    const project = createProjectWithLongReference();
    const unboundAsset = createAsset("asset_unbound_ignored", [5_000]);
    project.assets.push(unboundAsset);
    project.danmakuSourceSegments.push(
      createDanmakuSourceSegment("ignored_without_binding", {
        label: "未绑定 XML 忽略段",
        kind: "ignored",
        assetId: unboundAsset.id,
        sourceMediaId: "ref_long",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetMediaId: null,
        episodeKey: null,
        episodeLabel: null
      })
    );

    const result = projectDanmakuToTargets(project);
    const issue = result.issues.find(
      (candidate) => candidate.segmentId === "ignored_without_binding"
    );

    expect(result.status).toBe("blocked");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("尚未在素材页绑定");
    expect(result.ignoredItemCount).toBe(0);
    expect(result.unmappedItemCount).toBeGreaterThanOrEqual(2);
  });

  it("没有任何正片段时返回 empty 状态", () => {
    const project = createEmptyProject("空项目");
    const result = projectDanmakuToTargets(project);
    expect(result.status).toBe("empty");
    expect(result.groups).toHaveLength(0);
  });

  it("多个来源段指向同一个原片时合并导出", () => {
    const project = createProjectWithLongReference();
    project.danmakuSourceSegments = [
      createDanmakuSourceSegment("seg_a", {
        kind: "content",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 0,
        sourceEndMs: 100_000,
        targetMediaId: "ep1",
        episodeKey: null,
        episodeLabel: "第 1 集"
      }),
      createDanmakuSourceSegment("seg_b", {
        kind: "content",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 500_000,
        sourceEndMs: 700_000,
        targetMediaId: "ep1",
        episodeKey: null,
        episodeLabel: "第 1 集",
        targetStartMs: 480_000
      })
    ];
    const result = projectDanmakuToTargets(project);
    const ep1 = result.groups.find((group) => group.targetMediaId === "ep1");
    expect(ep1?.segments).toHaveLength(2);
    // item_0 (10s) 来自 seg_a → 10_000；item_1 (600s) 来自 seg_b → 600_000-500_000+480_000=580_000
    expect(ep1?.entries.map((entry) => entry.finalTimeMs)).toEqual([10_000, 580_000]);
  });

  it("同一 XML、参考素材和目标原片的手工来源段重叠时阻断导出", () => {
    const project = createProjectWithLongReference();
    project.danmakuSourceSegments = [
      createDanmakuSourceSegment("seg_overlap_a", {
        kind: "content",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 0,
        sourceEndMs: 700_000,
        targetMediaId: "ep1",
        episodeKey: null,
        episodeLabel: null
      }),
      createDanmakuSourceSegment("seg_overlap_b", {
        kind: "content",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 500_000,
        sourceEndMs: 900_000,
        targetMediaId: "ep1",
        episodeKey: null,
        episodeLabel: null
      })
    ];

    const result = projectDanmakuToTargets(project);

    expect(result.status).toBe("blocked");
    expect(result.groups).toHaveLength(0);
    expect(result.projectedItemCount).toBe(0);
    expect(result.issues.some((issue) => issue.message.includes("会产生重复弹幕"))).toBe(true);
  });

  it("正片来源段覆盖同一 XML 的忽略范围时阻断导出", () => {
    const project = createProjectWithLongReference();
    project.danmakuSourceSegments = [
      createDanmakuSourceSegment("seg_content", {
        kind: "content",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 0,
        sourceEndMs: 700_000,
        targetMediaId: "ep1",
        episodeKey: null,
        episodeLabel: null
      }),
      createDanmakuSourceSegment("seg_ignored_overlap", {
        kind: "ignored",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 500_000,
        sourceEndMs: 650_000,
        targetMediaId: null,
        episodeKey: null,
        episodeLabel: null
      })
    ];

    const result = projectDanmakuToTargets(project);

    expect(result.status).toBe("blocked");
    expect(result.groups).toHaveLength(0);
    expect(result.issues.some((issue) => issue.message.includes("忽略范围"))).toBe(true);
  });

  it("同名目标原片的导出文件名会自动添加唯一序号", () => {
    const project = createProjectWithLongReference();
    project.mediaLibrary = project.mediaLibrary.map((media) =>
      media.id === "ep1" || media.id === "ep2"
        ? { ...media, fileName: "same-title.mkv" }
        : media
    );
    project.danmakuSourceSegments = project.danmakuSourceSegments.filter(
      (segment) => segment.id === "seg_ep1" || segment.id === "seg_ep2"
    );

    const result = projectDanmakuToTargets(project);

    expect(result.groups.map((group) => group.exportFileName)).toEqual([
      "same-title-1.xml",
      "same-title-2.xml"
    ]);
    expect(
      result.groups.every((group) =>
        group.warnings.some((warning) => warning.includes("导出文件名已自动添加序号"))
      )
    ).toBe(true);
  });

  it("同名自动后缀不会与另一个原片的原始文件名再次碰撞", () => {
    const project = createProjectWithLongReference();
    project.mediaLibrary = project.mediaLibrary.map((media) => {
      if (media.id === "ep1" || media.id === "ep2") {
        return { ...media, fileName: "foo.mkv" };
      }
      if (media.id === "ep3") {
        return { ...media, fileName: "foo-1.mkv" };
      }
      return media;
    });

    const result = projectDanmakuToTargets(project);
    const fileNames = result.groups.map((group) => group.exportFileName);

    expect(fileNames).toEqual(["foo-2.xml", "foo-3.xml", "foo-1.xml"]);
    expect(new Set(fileNames.map((name) => name.toLocaleLowerCase("en-US"))).size).toBe(3);
  });

  it("M4V 原片导出时会正确替换视频扩展名", () => {
    const project = createProjectWithLongReference();
    project.mediaLibrary = project.mediaLibrary.map((media) =>
      media.id === "ep1" ? { ...media, fileName: "episode.m4v" } : media
    );
    project.danmakuSourceSegments = project.danmakuSourceSegments.filter(
      (segment) => segment.id === "seg_ep1"
    );

    const result = projectDanmakuToTargets(project);

    expect(result.groups[0]?.exportFileName).toBe("episode.xml");
  });

  it("投影时间超出目标原片已知时长时给出警告", () => {
    const project = createProjectWithLongReference();
    project.mediaLibrary = project.mediaLibrary.map((media) =>
      media.id === "ep1" ? { ...media, durationMs: 100_000 } : media
    );

    const result = projectDanmakuToTargets(project);
    const ep1 = result.groups.find((group) => group.targetMediaId === "ep1");
    const overflowIssue = result.issues.find((issue) => issue.id === "target-overflow-ep1");

    expect(ep1?.entries.some((entry) => entry.finalTimeMs > 100_000)).toBe(true);
    expect(
      ep1?.warnings.some((warning) => warning.includes("1 条弹幕投影后超出原片时长"))
    ).toBe(true);
    expect(overflowIssue?.severity).toBe("warning");
    expect(overflowIssue?.message).toContain("1 条弹幕投影后超出原片时长");
  });

  it("负时间投影会给出警告", () => {
    const project = createProjectWithLongReference();
    project.itemTimeAdjustments = { [`${project.assets[0].id}_item_0`]: -60_000 };
    const result = projectDanmakuToTargets(project);
    const ep1 = result.groups.find((group) => group.targetMediaId === "ep1");
    expect(ep1?.warnings.some((warning) => warning.includes("时间为负"))).toBe(true);
  });
});
