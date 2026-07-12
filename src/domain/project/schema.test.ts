import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mapSourceTime } from "../alignment/timeMap";
import {
  clearRegisteredManualMediaTimeMapVerificationTrust,
  computeMediaTimeMapCoreDigest
} from "../alignment/mediaTimeMap";
import { applyTestManualMediaTimeMapVerification } from "../../test/manualVerification";
import { readTimeMapSpanPlaybackReview } from "../alignment/timeMapPlaybackReviewEvidence";
import { createEmptyProject } from "./factory";
import {
  parseProjectJson,
  parseProjectJsonWithMetadata,
  serializeProject,
  validateProjectSchema
} from "./schema";
import {
  CURRENT_SCHEMA_VERSION,
  type MediaTimeMap,
  type ProjectMediaReference,
  type ProjectMediaRole
} from "./types";

describe("project schema", () => {
  it("序列化后可重新打开，并清除临时 objectUrl", () => {
    const project = {
      ...createEmptyProject("测试项目"),
      media: {
        id: "media",
        name: "demo",
        fileName: "demo.mp4",
        objectUrl: "blob:test",
        durationMs: 1000
      },
      mediaLibrary: [
        createValidProjectMediaReference({
          id: "media",
          role: "bilibiliReference",
          objectUrl: "blob:test",
          connectionState: "connected"
        })
      ],
      mediaBinding: createValidLocalFileBinding(),
      alignmentProposal: createValidAlignmentProposal()
    };
    const json = serializeProject(project);
    expect(JSON.parse(json)).toMatchObject({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      mediaBinding: {
        kind: "localFile",
        fileName: "demo.mp4"
      },
      mediaLibrary: [
        {
          id: "media",
          role: "bilibiliReference",
          objectUrl: null,
          connectionState: "needsReconnect"
        }
      ],
      alignmentProposal: {
        anchors: [{ id: "proposal-anchor" }],
        cutCandidates: [{ id: "proposal-cut" }]
      }
    });
    const parsed = parseProjectJson(json);
    expect(parsed.name).toBe("测试项目");
    expect(parsed.media?.objectUrl).toBeNull();
    expect(parsed.mediaLibrary[0].objectUrl).toBeNull();
    expect(parsed.mediaLibrary[0].connectionState).toBe("needsReconnect");
    expect(parsed.mediaBinding?.kind).toBe("localFile");
    expect(parsed.alignmentProposal?.cutCandidates[0].id).toBe("proposal-cut");
  });

  it("localPath 素材序列化并重新打开后仍保持已连接", () => {
    const project = {
      ...createEmptyProject("桌面素材项目"),
      mediaLibrary: [
        createValidProjectMediaReference({
          id: "local-reference",
          role: "bilibiliReference",
          referenceKind: "localPath",
          connectionState: "connected",
          localPath: "D:\\media\\reference.mkv"
        })
      ]
    };

    const json = serializeProject(project);
    expect(JSON.parse(json) as unknown).toMatchObject({
      mediaLibrary: [
        {
          referenceKind: "localPath",
          connectionState: "connected",
          localPath: "D:\\media\\reference.mkv",
          objectUrl: null
        }
      ]
    });

    const parsed = parseProjectJson(json);
    expect(parsed.mediaLibrary[0]).toMatchObject({
      referenceKind: "localPath",
      connectionState: "connected",
      localPath: "D:\\media\\reference.mkv",
      objectUrl: null
    });
  });

  it("可打开仓库内三分 P 示例项目", () => {
    const fixture = readFileSync(
      resolve("fixtures", "projects", "three-part-demo.danmaku-project.json"),
      "utf8"
    );
    const { project: parsed, migration } = parseProjectJsonWithMetadata(fixture);

    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migration).toEqual({
      fromVersion: 8,
      toVersion: CURRENT_SCHEMA_VERSION,
      adjustedClipRangeCount: 0
    });
    expect(parsed.mediaMatchCandidates).toEqual([]);
    expect(parsed.assets).toHaveLength(3);
    expect(parsed.cutMarkers).toHaveLength(1);
  });

  it("允许包含合法版本差异和同步锚点的项目", () => {
    const project = {
      ...createEmptyProject("带版本差异项目"),
      cutMarkers: [
        {
          id: "cut-1",
          name: "缺失片段",
          sourceAtMs: 30_000,
          targetGapMs: 45_000,
          note: "复核通过"
        }
      ],
      syncAnchors: [
        {
          id: "anchor-1",
          sourceMs: 10_000,
          targetMs: 12_000,
          confidence: 0.9,
          origin: "manual" as const
        }
      ]
    };

    expect(validateProjectSchema(project)).toEqual({
      ok: true,
      version: CURRENT_SCHEMA_VERSION,
      message: "项目文件可打开。"
    });
  });

  it("允许保存 Emby 目标原片绑定摘要", () => {
    const project = {
      ...createEmptyProject("Emby 绑定项目"),
      mediaBinding: createValidEmbyBinding()
    };

    expect(validateProjectSchema(project)).toEqual({
      ok: true,
      version: CURRENT_SCHEMA_VERSION,
      message: "项目文件可打开。"
    });
    const parsed = parseProjectJson(serializeProject(project));
    expect(parsed.mediaBinding).toMatchObject({
      kind: "embyItem",
      itemId: "emby-item-1",
      seriesName: "测试剧集"
    });
    expect(JSON.stringify(parsed.mediaBinding)).not.toContain("token");
  });

  it("允许保存逐集目标原片绑定摘要", () => {
    const project = {
      ...createEmptyProject("逐集绑定项目"),
      seasonEpisodeBindings: [
        {
          id: "season-binding-1",
          episodeKey: "S01E02",
          episodeLabel: "第 2 集",
          targetBinding: createValidEmbyBinding(),
          linkedAt: "2026-07-10T00:00:00.000Z"
        }
      ]
    };

    expect(validateProjectSchema(project)).toEqual({
      ok: true,
      version: CURRENT_SCHEMA_VERSION,
      message: "项目文件可打开。"
    });
    const parsed = parseProjectJson(serializeProject(project));
    expect(parsed.seasonEpisodeBindings[0]).toMatchObject({
      episodeKey: "S01E02",
      episodeLabel: "第 2 集",
      targetBinding: {
        kind: "embyItem",
        itemId: "emby-item-1"
      }
    });
    expect(JSON.stringify(parsed.seasonEpisodeBindings)).not.toContain("token");
  });

  it("允许保存弹幕来源内容段", () => {
    const project = {
      ...createEmptyProject("来源内容段项目"),
      assets: [createValidAsset()],
      mediaLibrary: [
        createValidProjectMediaReference({ id: "source-media", role: "bilibiliReference" }),
        createValidProjectMediaReference({ id: "target-media", role: "targetOriginal" })
      ],
      danmakuSourceSegments: [
        {
          id: "source-segment-1",
          label: "第 1 集来源段",
          kind: "content" as const,
          assetId: "asset",
          sourceMediaId: "source-media",
          sourceStartMs: 7_200_000,
          sourceEndMs: 7_260_000,
          targetMediaId: "target-media",
          targetStartMs: 0,
          timingRules: [
            { id: "rule-1", sourceAtMs: 7_230_000, gapMs: 45_000, note: "审核删减补偿" }
          ],
          timeMapId: null,
          episodeKey: "S01E01",
          episodeLabel: "第 1 集",
          note: "B 站长视频两小时后进入正片",
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        },
        {
          id: "source-segment-ignored",
          label: "前置无意义片段",
          kind: "ignored" as const,
          assetId: "asset",
          sourceMediaId: "source-media",
          sourceStartMs: 0,
          sourceEndMs: 7_200_000,
          targetMediaId: null,
          targetStartMs: null,
          timingRules: [],
          timeMapId: null,
          episodeKey: null,
          episodeLabel: null,
          note: "",
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ]
    };

    expect(validateProjectSchema(project)).toEqual({
      ok: true,
      version: CURRENT_SCHEMA_VERSION,
      message: "项目文件可打开。"
    });
    const parsed = parseProjectJson(serializeProject(project));
    expect(parsed.danmakuSourceSegments).toHaveLength(2);
    expect(parsed.danmakuSourceSegments[0]).toMatchObject({
      kind: "content",
      episodeKey: "S01E01",
      sourceStartMs: 7_200_000
    });
  });

  it("允许保存带素材对上下文的媒体匹配候选并完整往返", () => {
    const project = {
      ...createEmptyProject("媒体匹配候选项目"),
      mediaLibrary: [
        createValidProjectMediaReference({ id: "source-media", role: "bilibiliReference" }),
        createValidProjectMediaReference({ id: "target-media", role: "targetOriginal" })
      ],
      mediaTimeMaps: [createValidMediaTimeMap()],
      mediaMatchCandidates: [createValidMediaMatchCandidate()]
    };

    expect(validateProjectSchema(project).ok).toBe(true);
    const parsed = parseProjectJson(serializeProject(project));
    expect(parsed.mediaMatchCandidates).toHaveLength(1);
    expect(parsed.mediaMatchCandidates[0]).toMatchObject({
      id: "candidate-1",
      batchId: "batch-1",
      sourceMediaId: "source-media",
      targetMediaId: "target-media",
      state: "pending",
      timingRules: [{ id: "candidate-1:rule:0" }],
      proposal: {
        matchRange: {
          sourceStartMs: 10_000,
          sourceEndMs: 70_000,
          targetStartMs: 0,
          targetEndMs: 65_000
        }
      }
    });
    expect(parsed.mediaTimeMaps[0]).toMatchObject({
      id: "candidate-map-1",
      sourceStream: { type: "audio", index: 1, sampleRate: 48_000 },
      quality: { level: "review", p95ResidualMs: 120 },
      state: "candidate"
    });
  });

  it("打开 v10 项目时重算时间图质量，只降级外部声明而不自动升级", () => {
    const overclaimed = createValidMediaTimeMap({ id: "map-overclaimed" });
    overclaimed.quality = {
      ...overclaimed.quality,
      level: "verified",
      probability: 0.999,
      p95ResidualMs: 80,
      reasons: ["外部声称已验证。"]
    };
    overclaimed.evidence = {
      ...overclaimed.evidence,
      types: ["audio", "visual"],
      visualAnchorCount: 10
    };
    const conservative = createValidMediaTimeMap({ id: "map-conservative" });
    conservative.quality = {
      ...conservative.quality,
      level: "review",
      probability: 0.999,
      p95ResidualMs: 80,
      reasons: ["保守地请求人工复核。"]
    };
    conservative.evidence = {
      ...conservative.evidence,
      types: ["audio", "visual"],
      visualAnchorCount: 10
    };
    const project = {
      ...createEmptyProject("外部时间图质量声明"),
      schemaVersion: 10,
      mediaLibrary: [
        createValidProjectMediaReference({ id: "source-media", role: "bilibiliReference" }),
        createValidProjectMediaReference({ id: "target-media", role: "targetOriginal" })
      ],
      mediaTimeMaps: [overclaimed, conservative]
    };

    expect(validateProjectSchema(project).ok).toBe(true);
    const result = parseProjectJsonWithMetadata(JSON.stringify(project));
    const parsed = result.project;
    expect(result.migration).toMatchObject({ fromVersion: 10, toVersion: 11 });
    expect(parsed.mediaTimeMaps[0].quality.level).toBe("review");
    expect(parsed.mediaTimeMaps[0].quality.reasons.join(" ")).toContain(
      "v10 没有可绑定时间图核心"
    );
    expect(parsed.mediaTimeMaps[0].verification).toBeNull();
    expect(parsed.mediaTimeMaps[1].quality.level).toBe("review");

    const reopened = parseProjectJson(serializeProject(parsed));
    expect(reopened.mediaTimeMaps[0].quality.level).toBe("review");
    expect(
      reopened.mediaTimeMaps[0].quality.reasons.filter((reason) =>
        reason.includes("v10 没有可绑定时间图核心")
      )
    ).toHaveLength(1);
  });

  it("v11 导入的自报 manual record 即使摘要正确也不会自动成为 trusted", () => {
    const map = createValidMediaTimeMap({
      id: "forged-manual-map",
      state: "confirmed",
      confirmedAt: "2026-07-12T00:00:00.000Z"
    });
    map.quality = {
      ...map.quality,
      level: "verified",
      probability: 0.999,
      p95ResidualMs: 80
    };
    map.evidence = {
      ...map.evidence,
      types: ["manual"],
      audioAnchorCount: 0
    };
    map.verification = {
      recordVersion: 1,
      method: "manual-review",
      mapCoreDigest: computeMediaTimeMapCoreDigest(map),
      mapRevision: map.revision,
      sourceIdentity: structuredClone(map.sourceIdentity!),
      targetIdentity: structuredClone(map.targetIdentity!),
      calibrationArtifactId: "manual-review-protocol",
      calibrationArtifactVersion: "1",
      verifier: "forged-json",
      verifiedAt: "2026-07-12T00:00:00.000Z"
    };
    const project = {
      ...createEmptyProject("伪造人工验证记录"),
      mediaLibrary: [
        createValidProjectMediaReference({ id: "source-media", role: "bilibiliReference" }),
        createValidProjectMediaReference({ id: "target-media", role: "targetOriginal" })
      ],
      mediaTimeMaps: [map]
    };

    expect(validateProjectSchema(project).ok).toBe(true);
    const reopened = parseProjectJson(JSON.stringify(project));
    expect(reopened.mediaTimeMaps[0].quality.level).toBe("review");
    expect(reopened.mediaTimeMaps[0].quality.reasons.join(" ")).toContain("没有安装级签名");
  });

  it("v11 签名人工凭据完整序列化，保存重开前先降为 review 并保留待 native 复核记录", () => {
    const map = createValidMediaTimeMap({
      id: "signed-manual-map",
      state: "confirmed",
      confirmedAt: "2026-07-12T00:00:00.000Z"
    });
    map.quality = {
      ...map.quality,
      level: "review",
      probability: 0.999,
      p95ResidualMs: 80
    };
    map.evidence = {
      ...map.evidence,
      types: ["audio", "visual", "manual"],
      visualAnchorCount: 12
    };
    const signed = applyTestManualMediaTimeMapVerification(map, {
      calibrationArtifactId: "test-manual-review",
      calibrationArtifactVersion: "1",
      verifier: "vitest",
      verifiedAt: "2026-07-12T00:00:00.000Z"
    });
    const project = {
      ...createEmptyProject("签名人工凭据往返"),
      mediaLibrary: [
        createValidProjectMediaReference({ id: "source-media", role: "bilibiliReference" }),
        createValidProjectMediaReference({ id: "target-media", role: "targetOriginal" })
      ],
      mediaTimeMaps: [signed]
    };
    const saved = serializeProject(project);
    clearRegisteredManualMediaTimeMapVerificationTrust();
    const reopened = parseProjectJson(saved);

    expect(reopened.mediaTimeMaps[0].quality.level).toBe("review");
    expect(reopened.mediaTimeMaps[0].verification).toMatchObject({
      recordVersion: 2,
      method: "manual-review",
      revocation: null
    });
    const verification = reopened.mediaTimeMaps[0].verification;
    if (!verification || verification.recordVersion !== 2) {
      throw new Error("签名人工验证记录没有完成往返");
    }
    expect(verification.requestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verification.reviewEvidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(validateProjectSchema(reopened).ok).toBe(true);
  });

  it("v11 时间图必须显式携带 verification=null 或合法 record", () => {
    const project = {
      ...createEmptyProject("缺少验证字段"),
      mediaLibrary: [
        createValidProjectMediaReference({ id: "source-media", role: "bilibiliReference" }),
        createValidProjectMediaReference({ id: "target-media", role: "targetOriginal" })
      ],
      mediaTimeMaps: [createValidMediaTimeMap()]
    };
    const withoutVerification = structuredClone(project) as unknown as {
      mediaTimeMaps: Array<Record<string, unknown>>;
    };
    delete withoutVerification.mediaTimeMaps[0].verification;

    expect(validateProjectSchema(withoutVerification).ok).toBe(false);
  });

  it("已接受和已拒绝的媒体匹配候选连同应用片段 ID 完整往返", () => {
    const acceptedCandidate = {
      ...createValidMediaMatchCandidate(),
      state: "accepted" as const,
      appliedSegmentIds: ["candidate-1:segment:asset-1"],
      confirmedTimeMapId: "confirmed-map-1"
    };
    const rejectedCandidate = {
      ...createValidMediaMatchCandidate(),
      id: "candidate-rejected",
      timeMapId: "candidate-map-rejected",
      state: "rejected" as const,
      appliedSegmentIds: []
    };
    const project = {
      ...createEmptyProject("候选状态往返项目"),
      mediaLibrary: [
        createValidProjectMediaReference({ id: "source-media", role: "bilibiliReference" }),
        createValidProjectMediaReference({ id: "target-media", role: "targetOriginal" })
      ],
      danmakuSourceSegments: [
        {
          id: "candidate-1:segment:asset-1",
          label: "已接受来源段",
          kind: "content" as const,
          assetId: "asset-1",
          sourceMediaId: "source-media",
          sourceStartMs: 10_000,
          sourceEndMs: 70_000,
          targetMediaId: "target-media",
          targetStartMs: 0,
          timingRules: [
            { id: "candidate-1:rule:0", sourceAtMs: 40_000, gapMs: 5_000, note: "测试" }
          ],
          timeMapId: "confirmed-map-1",
          episodeKey: null,
          episodeLabel: null,
          note: "",
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ],
      mediaTimeMaps: [
        createValidMediaTimeMap(),
        createValidMediaTimeMap({
          id: "confirmed-map-1",
          state: "confirmed",
          confirmedAt: "2026-07-11T00:00:00.000Z"
        }),
        createValidMediaTimeMap({ id: "candidate-map-rejected" })
      ],
      mediaMatchCandidates: [acceptedCandidate, rejectedCandidate]
    };

    expect(validateProjectSchema(project).ok).toBe(true);
    const parsed = parseProjectJson(serializeProject(project));

    expect(parsed.mediaMatchCandidates).toHaveLength(2);
    expect(parsed.mediaMatchCandidates[0]).toMatchObject({
      id: "candidate-1",
      state: "accepted",
      appliedSegmentIds: ["candidate-1:segment:asset-1"]
    });
    expect(parsed.mediaMatchCandidates[1]).toMatchObject({
      id: "candidate-rejected",
      state: "rejected",
      appliedSegmentIds: []
    });
  });

  it("打开 v1 项目时迁移闭区间片段 sourceOutMs", () => {
    const project = {
      ...createEmptyProject("旧项目"),
      schemaVersion: 1,
      assets: [createValidAsset()],
      clips: [
        {
          id: "clip",
          assetId: "asset",
          name: "旧片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    };

    const { project: parsed, migration } = parseProjectJsonWithMetadata(
      JSON.stringify(project)
    );

    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.clips[0].sourceOutMs).toBe(1001);
    expect(migration).toEqual({
      fromVersion: 1,
      toVersion: CURRENT_SCHEMA_VERSION,
      adjustedClipRangeCount: 1
    });
  });

  it("打开 v2 项目时补齐对齐提案和媒体绑定字段但不重复迁移片段边界", () => {
    const currentProject = {
      ...createEmptyProject("v2 项目"),
      schemaVersion: 2,
      assets: [createValidAsset()],
      clips: [
        {
          id: "clip",
          assetId: "asset",
          name: "v2 片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    };
    const v2Project = JSON.parse(JSON.stringify(currentProject)) as Record<string, unknown>;
    delete v2Project.alignmentProposal;

    const { project: parsed, migration } = parseProjectJsonWithMetadata(
      JSON.stringify(v2Project)
    );

    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.alignmentProposal).toBeNull();
    expect(parsed.mediaBinding).toBeNull();
    expect(parsed.clips[0].sourceOutMs).toBe(1000);
    expect(migration).toEqual({
      fromVersion: 2,
      toVersion: CURRENT_SCHEMA_VERSION,
      adjustedClipRangeCount: 0
    });
  });

  it("打开 v3 项目时补齐媒体绑定字段并保留对齐提案", () => {
    const currentProject = {
      ...createEmptyProject("v3 项目"),
      schemaVersion: 3,
      assets: [createValidAsset()],
      alignmentProposal: createValidAlignmentProposal()
    };
    const v3Project = JSON.parse(JSON.stringify(currentProject)) as Record<string, unknown>;
    delete v3Project.mediaBinding;

    const { project: parsed, migration } = parseProjectJsonWithMetadata(
      JSON.stringify(v3Project)
    );

    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.alignmentProposal?.anchors[0].id).toBe("proposal-anchor");
    expect(parsed.mediaBinding).toBeNull();
    expect(parsed.seasonEpisodeBindings).toEqual([]);
    expect(migration).toEqual({
      fromVersion: 3,
      toVersion: CURRENT_SCHEMA_VERSION,
      adjustedClipRangeCount: 0
    });
  });

  it("打开 v4 项目时补齐逐集目标绑定字段", () => {
    const currentProject = {
      ...createEmptyProject("v4 项目"),
      schemaVersion: 4,
      mediaBinding: createValidLocalFileBinding()
    };
    const v4Project = JSON.parse(JSON.stringify(currentProject)) as Record<string, unknown>;
    delete v4Project.seasonEpisodeBindings;

    const { project: parsed, migration } = parseProjectJsonWithMetadata(
      JSON.stringify(v4Project)
    );

    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.mediaBinding?.kind).toBe("localFile");
    expect(parsed.seasonEpisodeBindings).toEqual([]);
    expect(parsed.danmakuSourceSegments).toEqual([]);
    expect(migration).toEqual({
      fromVersion: 4,
      toVersion: CURRENT_SCHEMA_VERSION,
      adjustedClipRangeCount: 0
    });
  });

  it("打开 v5 项目时补齐弹幕来源内容段字段", () => {
    const currentProject = {
      ...createEmptyProject("v5 项目"),
      schemaVersion: 5,
      seasonEpisodeBindings: []
    };
    const v5Project = JSON.parse(JSON.stringify(currentProject)) as Record<string, unknown>;
    delete v5Project.danmakuSourceSegments;

    const { project: parsed, migration } = parseProjectJsonWithMetadata(
      JSON.stringify(v5Project)
    );

    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.seasonEpisodeBindings).toEqual([]);
    expect(parsed.danmakuSourceSegments).toEqual([]);
    expect(migration).toEqual({
      fromVersion: 5,
      toVersion: CURRENT_SCHEMA_VERSION,
      adjustedClipRangeCount: 0
    });
  });

  it("打开 v6 项目时迁移旧媒体、目标绑定和来源段关系", () => {
    const legacySourceSegment = {
      id: "legacy-segment",
      label: "第 1 集来源段",
      kind: "content" as const,
      sourceStartMs: 7_200_000,
      sourceEndMs: 7_260_000,
      episodeKey: "S01E01",
      episodeLabel: "第 1 集",
      note: "旧来源段",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    };
    const legacyProject = {
      ...createEmptyProject("v6 旧媒体项目"),
      schemaVersion: 6,
      assets: [createValidAsset()],
      media: {
        id: "legacy-source-media",
        name: "B 站参考",
        fileName: "reference.mp4",
        objectUrl: "blob:reference",
        durationMs: 8_000_000
      },
      mediaBinding: createValidLocalFileBinding(),
      danmakuSourceSegments: [legacySourceSegment]
    };
    const v6Project = JSON.parse(JSON.stringify(legacyProject)) as Record<string, unknown>;
    delete v6Project.mediaLibrary;
    delete v6Project.danmakuSourceBindings;

    const { project: parsed, migration } = parseProjectJsonWithMetadata(
      JSON.stringify(v6Project)
    );

    expect(migration).toEqual({
      fromVersion: 6,
      toVersion: CURRENT_SCHEMA_VERSION,
      adjustedClipRangeCount: 0
    });
    expect(parsed.mediaLibrary.map((media) => [media.id, media.role])).toEqual([
      ["legacy-source-media", "bilibiliReference"],
      ["migrated_target_binding-local", "targetOriginal"]
    ]);
    expect(parsed.mediaBinding).toMatchObject({
      kind: "localFile",
      mediaId: "migrated_target_binding-local"
    });
    expect(parsed.danmakuSourceBindings).toMatchObject([
      {
        assetId: "asset",
        sourceMediaId: "legacy-source-media"
      }
    ]);
    expect(parsed.danmakuSourceSegments[0]).toMatchObject({
      assetId: "asset",
      sourceMediaId: "legacy-source-media",
      targetMediaId: "migrated_target_binding-local"
    });

    const reopened = parseProjectJson(serializeProject(parsed));
    expect(reopened.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(reopened.mediaLibrary[0]).toMatchObject({
      id: "legacy-source-media",
      objectUrl: null,
      connectionState: "needsReconnect"
    });
    expect(reopened.danmakuSourceSegments[0]).toMatchObject({
      assetId: "asset",
      sourceMediaId: "legacy-source-media",
      targetMediaId: "migrated_target_binding-local"
    });
  });

  it("迁移 v6 项目时稳定避让旧媒体 ID 碰撞，避免重复或覆盖素材", () => {
    const legacyProject = {
      ...createEmptyProject("v6 ID 碰撞项目"),
      schemaVersion: 6,
      assets: [createValidAsset()],
      media: {
        id: "migrated_target_binding-local",
        name: "B 站参考",
        fileName: "reference.mp4",
        objectUrl: null,
        durationMs: 8_000_000
      },
      mediaBinding: createValidLocalFileBinding(),
      danmakuSourceSegments: [
        {
          id: "legacy-segment",
          label: "第 1 集来源段",
          kind: "content" as const,
          sourceStartMs: 0,
          sourceEndMs: 60_000,
          episodeKey: "S01E01",
          episodeLabel: "第 1 集",
          note: "",
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ]
    };
    const v6Project = JSON.parse(JSON.stringify(legacyProject)) as Record<string, unknown>;
    delete v6Project.mediaLibrary;
    delete v6Project.danmakuSourceBindings;

    const parsed = parseProjectJson(JSON.stringify(v6Project));

    expect(parsed.mediaLibrary.map((media) => [media.id, media.role])).toEqual([
      ["migrated_target_binding-local", "bilibiliReference"],
      ["migrated_target_binding-local_2", "targetOriginal"]
    ]);
    expect(new Set(parsed.mediaLibrary.map((media) => media.id)).size).toBe(
      parsed.mediaLibrary.length
    );
    expect(parsed.mediaBinding).toMatchObject({
      kind: "localFile",
      mediaId: "migrated_target_binding-local_2"
    });
    expect(parsed.danmakuSourceSegments[0]).toMatchObject({
      sourceMediaId: "migrated_target_binding-local",
      targetMediaId: "migrated_target_binding-local_2"
    });
  });

  it("打开 v7 项目时为来源段补齐投影字段", () => {
    const v7Segment = {
      id: "v7-segment",
      label: "第 1 集来源段",
      kind: "content" as const,
      assetId: "asset",
      sourceMediaId: "source-media",
      sourceStartMs: 0,
      sourceEndMs: 60_000,
      targetMediaId: "target-media",
      episodeKey: "S01E01",
      episodeLabel: "第 1 集",
      note: "",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    };
    const v7Project = {
      ...JSON.parse(JSON.stringify(createEmptyProject("v7 项目"))),
      schemaVersion: 7,
      assets: [createValidAsset()],
      mediaLibrary: [
        createValidProjectMediaReference({ id: "source-media", role: "bilibiliReference" }),
        createValidProjectMediaReference({ id: "target-media", role: "targetOriginal" })
      ],
      danmakuSourceSegments: [v7Segment]
    } as Record<string, unknown>;

    const { project: parsed, migration } = parseProjectJsonWithMetadata(
      JSON.stringify(v7Project)
    );

    expect(migration).toEqual({
      fromVersion: 7,
      toVersion: CURRENT_SCHEMA_VERSION,
      adjustedClipRangeCount: 0
    });
    expect(parsed.danmakuSourceSegments[0]).toMatchObject({
      id: "v7-segment",
      targetStartMs: null,
      timingRules: []
    });
    expect(parsed.danmakuSourceSegments[0].timeMapId).toContain(
      "migrated_v10_confirmed-segment"
    );
    expect(parsed.mediaTimeMaps).toMatchObject([
      { state: "confirmed", quality: { level: "legacy-unverified" } }
    ]);

    const reopened = parseProjectJson(serializeProject(parsed));
    expect(reopened.danmakuSourceSegments[0]).toMatchObject({
      targetStartMs: null,
      timingRules: []
    });
  });

  it("打开 v8 项目时补齐媒体匹配候选集合", () => {
    const v8Project = JSON.parse(JSON.stringify(createEmptyProject("v8 项目"))) as Record<
      string,
      unknown
    >;
    v8Project.schemaVersion = 8;
    delete v8Project.mediaMatchCandidates;

    const { project: parsed, migration } = parseProjectJsonWithMetadata(
      JSON.stringify(v8Project)
    );

    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.mediaMatchCandidates).toEqual([]);
    expect(migration).toEqual({
      fromVersion: 8,
      toVersion: CURRENT_SCHEMA_VERSION,
      adjustedClipRangeCount: 0
    });
    expect(parseProjectJson(serializeProject(parsed)).mediaMatchCandidates).toEqual([]);
  });

  it("打开 v9 项目时为候选和内容段生成相互独立的 legacy-unverified 时间图", () => {
    const segmentId = "candidate-1:segment:asset-1";
    const legacyProject = {
      ...createEmptyProject("v9 时间图迁移"),
      schemaVersion: 9,
      mediaLibrary: [
        createValidProjectMediaReference({ id: "source-media", role: "bilibiliReference" }),
        createValidProjectMediaReference({ id: "target-media", role: "targetOriginal" })
      ],
      danmakuSourceSegments: [
        {
          id: segmentId,
          label: "已接受来源段",
          kind: "content",
          assetId: "asset-1",
          sourceMediaId: "source-media",
          sourceStartMs: 10_000,
          sourceEndMs: 70_000,
          targetMediaId: "target-media",
          targetStartMs: 0,
          timingRules: [
            { id: "candidate-1:rule:0", sourceAtMs: 40_000, gapMs: 5_000, note: "旧规则" }
          ],
          episodeKey: null,
          episodeLabel: null,
          note: "",
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        },
        {
          id: "ignored",
          label: "片头",
          kind: "ignored",
          assetId: "asset-1",
          sourceMediaId: "source-media",
          sourceStartMs: 0,
          sourceEndMs: 10_000,
          targetMediaId: null,
          targetStartMs: null,
          timingRules: [],
          episodeKey: null,
          episodeLabel: null,
          note: "",
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ],
      mediaMatchCandidates: [
        {
          ...createValidMediaMatchCandidate(),
          state: "accepted",
          appliedSegmentIds: [segmentId]
        }
      ]
    } as Record<string, unknown>;
    delete legacyProject.mediaTimeMaps;
    const legacyCandidate = (
      legacyProject.mediaMatchCandidates as Array<Record<string, unknown>>
    )[0];
    delete legacyCandidate.timeMapId;
    delete legacyCandidate.confirmedTimeMapId;

    const parsed = parseProjectJson(JSON.stringify(legacyProject));

    expect(parsed.mediaTimeMaps).toHaveLength(2);
    const candidateMap = parsed.mediaTimeMaps.find((map) => map.state === "candidate");
    const confirmedMap = parsed.mediaTimeMaps.find((map) => map.state === "confirmed");
    expect(candidateMap).toMatchObject({
      quality: { level: "legacy-unverified", metricSource: "estimated" },
      sourceStream: null,
      targetStream: null,
      spans: [{ kind: "matched" }, { kind: "targetOnly" }, { kind: "matched" }]
    });
    expect(confirmedMap?.id).not.toBe(candidateMap?.id);
    expect(parsed.mediaMatchCandidates[0]).toMatchObject({
      timeMapId: candidateMap?.id,
      confirmedTimeMapId: confirmedMap?.id,
      state: "accepted"
    });
    expect(parsed.danmakuSourceSegments[0].timeMapId).toBe(confirmedMap?.id);
    expect(parsed.danmakuSourceSegments[1].timeMapId).toBeNull();
    expect(validateProjectSchema(parsed).ok).toBe(true);
    expect(parseProjectJson(serializeProject(parsed))).toEqual(parsed);
  });

  it("v9 已应用段规则与候选不一致时保留段自身投影语义并阻断候选复用", () => {
    const segmentId = "candidate-1:segment:asset-1";
    const legacyProject = {
      ...createEmptyProject("v9 不一致时间规则迁移"),
      schemaVersion: 9,
      mediaLibrary: [
        createValidProjectMediaReference({ id: "source-media", role: "bilibiliReference" }),
        createValidProjectMediaReference({ id: "target-media", role: "targetOriginal" })
      ],
      danmakuSourceSegments: [
        {
          id: segmentId,
          label: "实际采用七秒间隔的来源段",
          kind: "content",
          assetId: "asset-1",
          sourceMediaId: "source-media",
          sourceStartMs: 10_000,
          sourceEndMs: 70_000,
          targetMediaId: "target-media",
          targetStartMs: 0,
          timingRules: [
            { id: "segment-rule", sourceAtMs: 40_000, gapMs: 7_000, note: "段自身规则" }
          ],
          episodeKey: null,
          episodeLabel: null,
          note: "",
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ],
      mediaMatchCandidates: [
        {
          ...createValidMediaMatchCandidate(),
          state: "accepted",
          appliedSegmentIds: [segmentId]
        }
      ]
    } as Record<string, unknown>;
    delete legacyProject.mediaTimeMaps;
    const legacyCandidate = (
      legacyProject.mediaMatchCandidates as Array<Record<string, unknown>>
    )[0];
    delete legacyCandidate.timeMapId;
    delete legacyCandidate.confirmedTimeMapId;

    const parsed = parseProjectJson(JSON.stringify(legacyProject));
    const candidate = parsed.mediaMatchCandidates[0];
    const segment = parsed.danmakuSourceSegments[0];
    const candidateMap = parsed.mediaTimeMaps.find((map) => map.id === candidate.timeMapId);
    const segmentMap = parsed.mediaTimeMaps.find((map) => map.id === segment.timeMapId);

    expect(candidate).toMatchObject({
      state: "blocked",
      confirmedTimeMapId: null,
      appliedSegmentIds: []
    });
    expect(candidateMap).toMatchObject({ state: "candidate", quality: { level: "blocked" } });
    expect(segmentMap).toMatchObject({
      state: "confirmed",
      targetEndMs: 67_000,
      quality: { level: "legacy-unverified" }
    });
    expect(segment.timeMapId).not.toBe(candidate.timeMapId);
    expect(mapSourceTime(segmentMap?.spans ?? [], 50_000)).toEqual({
      status: "mapped",
      sourceTimeMs: 50_000,
      targetTimeMs: 47_000,
      spanIndex: 2
    });
    expect(validateProjectSchema(parsed).ok).toBe(true);
    expect(parseProjectJson(serializeProject(parsed))).toEqual(parsed);
  });

  it("迁移 v9 负 gap 时不猜测 sourceOnly，而是生成 blocked ambiguous 候选图", () => {
    const candidate = {
      ...createValidMediaMatchCandidate(),
      targetEndMs: 55_000,
      timingRules: [
        { id: "candidate-1:rule:negative", sourceAtMs: 40_000, gapMs: -5_000, note: "旧负值" }
      ],
      proposal: {
        ...createValidMediaMatchCandidate().proposal,
        matchRange: {
          ...createValidMediaMatchCandidate().proposal.matchRange,
          targetEndMs: 55_000
        }
      }
    };
    const legacyProject = {
      ...createEmptyProject("v9 负 gap"),
      schemaVersion: 9,
      mediaLibrary: [
        createValidProjectMediaReference({ id: "source-media", role: "bilibiliReference" }),
        createValidProjectMediaReference({ id: "target-media", role: "targetOriginal" })
      ],
      mediaMatchCandidates: [candidate]
    } as Record<string, unknown>;
    delete legacyProject.mediaTimeMaps;
    const legacyCandidate = (
      legacyProject.mediaMatchCandidates as Array<Record<string, unknown>>
    )[0];
    delete legacyCandidate.timeMapId;
    delete legacyCandidate.confirmedTimeMapId;

    const parsed = parseProjectJson(JSON.stringify(legacyProject));

    expect(parsed.mediaTimeMaps).toHaveLength(1);
    expect(parsed.mediaTimeMaps[0]).toMatchObject({
      state: "candidate",
      quality: { level: "blocked" },
      spans: [{ kind: "ambiguous", sourceStartMs: 10_000, sourceEndMs: 70_000 }]
    });
    expect(
      parsed.mediaTimeMaps[0].quality.reasons.some((reason) => reason.includes("负 gap"))
    ).toBe(true);
    expect(validateProjectSchema(parsed).ok).toBe(true);
  });

  it("拒绝 validateTimeMap 不通过或外层范围不一致的 v10 时间图", () => {
    const project = {
      ...createEmptyProject(),
      mediaLibrary: [
        createValidProjectMediaReference({ id: "source-media", role: "bilibiliReference" }),
        createValidProjectMediaReference({ id: "target-media", role: "targetOriginal" })
      ],
      mediaTimeMaps: [
        createValidMediaTimeMap({
          spans: [
            {
              kind: "matched",
              sourceStartMs: 10_000,
              sourceEndMs: 50_000,
              targetStartMs: 0,
              targetEndMs: 40_000
            },
            {
              kind: "matched",
              sourceStartMs: 49_000,
              sourceEndMs: 70_000,
              targetStartMs: 40_000,
              targetEndMs: 65_000
            }
          ]
        })
      ]
    };

    const validation = validateProjectSchema(project);
    expect(validation.ok).toBe(false);
    expect(validation.message).toContain("必要字段");
  });

  it("拒绝候选、确认段与错误 state 或错误范围的时间图引用", () => {
    const candidate = createValidMediaMatchCandidate();
    const missingCandidateMapProject = {
      ...createEmptyProject(),
      mediaLibrary: [
        createValidProjectMediaReference({ id: "source-media", role: "bilibiliReference" }),
        createValidProjectMediaReference({ id: "target-media", role: "targetOriginal" })
      ],
      mediaMatchCandidates: [candidate]
    };
    const missingReferenceValidation = validateProjectSchema(missingCandidateMapProject);
    expect(missingReferenceValidation.ok).toBe(false);
    expect(missingReferenceValidation.message).toContain("引用或范围");

    const wrongRangeMapProject = {
      ...missingCandidateMapProject,
      mediaTimeMaps: [createValidMediaTimeMap({ sourceEndMs: 69_000 })]
    };
    expect(validateProjectSchema(wrongRangeMapProject).ok).toBe(false);
  });

  it("拒绝 confirmedTimeMapId 下未登记到候选 appliedSegmentIds 的反向孤儿段", () => {
    const acceptedCandidate = {
      ...createValidMediaMatchCandidate(),
      state: "accepted" as const,
      confirmedTimeMapId: "confirmed-map-1",
      appliedSegmentIds: ["owned-segment"]
    };
    const ownedSegment = {
      id: "owned-segment",
      label: "候选已登记段",
      kind: "content" as const,
      assetId: "asset-1",
      sourceMediaId: "source-media",
      sourceStartMs: 10_000,
      sourceEndMs: 70_000,
      targetMediaId: "target-media",
      targetStartMs: 0,
      timingRules: [],
      timeMapId: "confirmed-map-1",
      episodeKey: null,
      episodeLabel: null,
      note: "",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    };
    const project = {
      ...createEmptyProject("反向时间图所有权"),
      mediaLibrary: [
        createValidProjectMediaReference({ id: "source-media", role: "bilibiliReference" }),
        createValidProjectMediaReference({ id: "target-media", role: "targetOriginal" })
      ],
      mediaMatchCandidates: [acceptedCandidate],
      mediaTimeMaps: [
        createValidMediaTimeMap(),
        createValidMediaTimeMap({
          id: "confirmed-map-1",
          state: "confirmed",
          confirmedAt: "2026-07-11T00:00:00.000Z"
        })
      ],
      danmakuSourceSegments: [ownedSegment]
    };
    expect(validateProjectSchema(project).ok).toBe(true);

    const withOrphan = {
      ...project,
      danmakuSourceSegments: [
        ownedSegment,
        { ...ownedSegment, id: "unregistered-orphan", label: "未登记孤儿段" }
      ]
    };
    expect(validateProjectSchema(withOrphan)).toMatchObject({
      ok: false,
      message: "项目文件中的时间映射引用或范围不一致。"
    });
  });

  it("打开当前版本项目时保留半开 sourceOutMs", () => {
    const project = {
      ...createEmptyProject("当前项目"),
      assets: [createValidAsset()],
      clips: [
        {
          id: "clip",
          assetId: "asset",
          name: "当前片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    };

    const { project: parsed, migration } = parseProjectJsonWithMetadata(
      JSON.stringify(project)
    );

    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.clips[0].sourceOutMs).toBe(1000);
    expect(migration).toBeNull();
  });

  it("保存重开时保留旧 v1 播放审计文本，但不会把一次启动迁移成有效 v2 证据", () => {
    const legacyPlaybackNote = `manual-playback-review:v1:0:${"a".repeat(64)}:source,target:::2026-07-11T00:00:00.000Z`;
    const map = createValidMediaTimeMap({
      evidence: {
        types: ["audio", "manual"],
        audioAnchorCount: 50,
        visualAnchorCount: 0,
        heldOutAnchorCount: 10,
        notes: ["测试音频证据。", legacyPlaybackNote]
      }
    });
    const project = {
      ...createEmptyProject("旧播放证据审计"),
      mediaLibrary: [
        createValidProjectMediaReference({ id: "source-media", role: "bilibiliReference" }),
        createValidProjectMediaReference({ id: "target-media", role: "targetOriginal" })
      ],
      mediaTimeMaps: [map]
    };

    const parsed = parseProjectJson(serializeProject(project));
    const reopenedMap = parsed.mediaTimeMaps[0];
    expect(reopenedMap?.evidence.notes).toContain(legacyPlaybackNote);
    expect(reopenedMap && readTimeMapSpanPlaybackReview(reopenedMap, 0)).toBeNull();
  });

  it("拒绝不支持的 schema 版本", () => {
    const project = createEmptyProject();
    expect(validateProjectSchema({ ...project, schemaVersion: 999 }).ok).toBe(false);
  });

  it("拒绝缺少 items 的弹幕资源", () => {
    const project = {
      ...createEmptyProject(),
      assets: [
        {
          id: "asset",
          name: "bad",
          fileName: "bad.xml",
          color: "#4cc9f0",
          warnings: [],
          importedAt: "2026-07-03T00:00:00.000Z"
        }
      ]
    };
    const validation = validateProjectSchema(project);
    expect(validation.ok).toBe(false);
    expect(validation.message).toContain("弹幕资源");
  });

  it("拒绝弹幕条目 metadata 类型错误的资源", () => {
    const project = {
      ...createEmptyProject(),
      assets: [
        {
          ...createValidAsset(),
          items: [
            {
              ...createValidDanmakuItem(),
              mode: "1"
            }
          ]
        }
      ]
    };
    const validation = validateProjectSchema(project);
    expect(validation.ok).toBe(false);
    expect(validation.message).toContain("弹幕资源");
  });

  it("拒绝导入警告结构错误的资源", () => {
    const project = {
      ...createEmptyProject(),
      assets: [
        {
          ...createValidAsset(),
          warnings: [
            {
              id: "warning",
              assetId: "asset",
              originalIndex: null,
              severity: "notice",
              message: "bad",
              rawSnippet: ""
            }
          ]
        }
      ]
    };
    const validation = validateProjectSchema(project);
    expect(validation.ok).toBe(false);
    expect(validation.message).toContain("弹幕资源");
  });

  it("拒绝关键字段类型错误的时间轴片段", () => {
    const project = {
      ...createEmptyProject(),
      clips: [
        {
          id: "clip",
          assetId: "asset",
          name: "bad",
          timelineStartMs: "0",
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    };
    const validation = validateProjectSchema(project);
    expect(validation.ok).toBe(false);
    expect(validation.message).toContain("时间轴片段");
  });

  it("拒绝字段类型错误的版本差异", () => {
    const project = {
      ...createEmptyProject(),
      cutMarkers: [
        {
          id: "cut",
          name: "bad",
          sourceAtMs: 30_000,
          targetGapMs: "45000",
          note: ""
        }
      ]
    };
    const validation = validateProjectSchema(project);
    expect(validation.ok).toBe(false);
    expect(validation.message).toContain("版本差异");
  });

  it("拒绝结构错误的同步锚点", () => {
    const project = {
      ...createEmptyProject(),
      syncAnchors: [
        {
          id: "anchor",
          sourceMs: 10_000,
          targetMs: 12_000,
          confidence: 1.5,
          origin: "automatic"
        }
      ]
    };
    const validation = validateProjectSchema(project);
    expect(validation.ok).toBe(false);
    expect(validation.message).toContain("同步锚点");
  });

  it("拒绝结构错误的持久化对齐提案", () => {
    const project = {
      ...createEmptyProject(),
      alignmentProposal: {
        ...createValidAlignmentProposal(),
        cutCandidates: [
          {
            ...createValidAlignmentProposal().cutCandidates[0],
            sourceAtMs: 10.5
          }
        ]
      }
    };
    const validation = validateProjectSchema(project);
    expect(validation.ok).toBe(false);
    expect(validation.message).toContain("必要字段");
  });

  it("拒绝区间或 proposal.matchRange 不一致的媒体匹配候选", () => {
    const candidate = createValidMediaMatchCandidate();
    const project = {
      ...createEmptyProject(),
      mediaLibrary: [
        createValidProjectMediaReference({ id: "source-media", role: "bilibiliReference" }),
        createValidProjectMediaReference({ id: "target-media", role: "targetOriginal" })
      ],
      mediaMatchCandidates: [
        {
          ...candidate,
          sourceEndMs: candidate.sourceStartMs
        }
      ]
    };
    expect(validateProjectSchema(project).ok).toBe(false);

    const mismatchedRangeProject = {
      ...project,
      mediaMatchCandidates: [
        {
          ...candidate,
          proposal: {
            ...candidate.proposal,
            matchRange: {
              ...candidate.proposal.matchRange,
              targetStartMs: 1_000
            }
          }
        }
      ]
    };
    expect(validateProjectSchema(mismatchedRangeProject).ok).toBe(false);
  });

  it("拒绝结构错误的目标原片绑定", () => {
    const validBinding = createValidEmbyBinding();
    const project = {
      ...createEmptyProject(),
      mediaBinding: {
        ...validBinding,
        mediaSources: [
          {
            ...validBinding.mediaSources[0],
            runtimeMs: 10.5
          }
        ]
      }
    };
    const validation = validateProjectSchema(project);
    expect(validation.ok).toBe(false);
    expect(validation.message).toContain("必要字段");
  });

  it("拒绝结构错误的弹幕来源内容段", () => {
    const project = {
      ...createEmptyProject(),
      danmakuSourceSegments: [
        {
          id: "source-segment",
          label: "bad",
          kind: "ignored",
          assetId: "asset",
          sourceMediaId: "source-media",
          sourceStartMs: 1000,
          sourceEndMs: 1000,
          targetMediaId: null,
          episodeKey: null,
          episodeLabel: null,
          note: "",
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ]
    };
    const validation = validateProjectSchema(project);
    expect(validation.ok).toBe(false);
    expect(validation.message).toContain("必要字段");
  });

  it("拒绝非整数毫秒的单条弹幕调整", () => {
    const project = {
      ...createEmptyProject(),
      itemTimeAdjustments: { item: 10.5 }
    };
    const validation = validateProjectSchema(project);
    expect(validation.ok).toBe(false);
    expect(validation.message).toContain("必要字段");
  });
});

function createValidAsset() {
  return {
    id: "asset",
    name: "valid",
    fileName: "valid.xml",
    color: "#4cc9f0",
    items: [createValidDanmakuItem()],
    warnings: [],
    importedAt: "2026-07-03T00:00:00.000Z"
  };
}

function createValidDanmakuItem() {
  return {
    id: "item",
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

function createValidAlignmentProposal() {
  return {
    anchors: [
      {
        id: "proposal-anchor",
        sourceMs: 10_000,
        targetMs: 12_000,
        confidence: 0.9,
        origin: "automatic" as const
      }
    ],
    cutCandidates: [
      {
        id: "proposal-cut",
        name: "候选版本差异",
        sourceAtMs: 20_000,
        sourceRangeStartMs: 18_000,
        sourceRangeEndMs: 22_000,
        targetGapMs: 5000,
        confidence: 0.8,
        note: "测试"
      }
    ],
    confidence: 0.85,
    diagnostics: ["测试诊断"]
  };
}

function createValidMediaMatchCandidate() {
  const proposal = {
    ...createValidAlignmentProposal(),
    anchors: [
      {
        id: "candidate-1:anchor:0",
        sourceMs: 15_000,
        targetMs: 5_000,
        confidence: 0.9,
        origin: "automatic" as const
      }
    ],
    cutCandidates: [
      {
        id: "candidate-1:cut:0",
        name: "候选版本差异",
        sourceAtMs: 40_000,
        sourceRangeStartMs: 39_000,
        sourceRangeEndMs: 41_000,
        targetGapMs: 5_000,
        confidence: 0.8,
        note: "测试"
      }
    ],
    matchRange: {
      sourceStartMs: 10_000,
      sourceEndMs: 70_000,
      targetStartMs: 0,
      targetEndMs: 65_000,
      coverage: 0.95
    }
  };
  return {
    id: "candidate-1",
    batchId: "batch-1",
    sourceMediaId: "source-media",
    targetMediaId: "target-media",
    sourceStartMs: 10_000,
    sourceEndMs: 70_000,
    targetStartMs: 0,
    targetEndMs: 65_000,
    timingRules: [{ id: "candidate-1:rule:0", sourceAtMs: 40_000, gapMs: 5_000, note: "测试" }],
    confidence: 0.85,
    proposal,
    timeMapId: "candidate-map-1",
    confirmedTimeMapId: null,
    state: "pending" as const,
    appliedSegmentIds: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z"
  };
}

function createValidMediaTimeMap(overrides: Partial<MediaTimeMap> = {}): MediaTimeMap {
  const state = overrides.state ?? "candidate";
  return {
    id: "candidate-map-1",
    revision: 1,
    sourceMediaId: "source-media",
    targetMediaId: "target-media",
    sourceStream: {
      type: "audio",
      index: 1,
      codec: "aac",
      startMs: 0,
      timelineOffsetMs: 0,
      timeBase: "1/48000",
      sampleRate: 48_000,
      channels: 2,
      frameRate: null,
      language: "jpn",
      title: "Original"
    },
    targetStream: {
      type: "audio",
      index: 1,
      codec: "flac",
      startMs: 0,
      timelineOffsetMs: 0,
      timeBase: "1/48000",
      sampleRate: 48_000,
      channels: 2,
      frameRate: null,
      language: "jpn",
      title: "Original"
    },
    sourceStartMs: 10_000,
    sourceEndMs: 70_000,
    targetStartMs: 0,
    targetEndMs: 65_000,
    spans: [
      {
        kind: "matched",
        sourceStartMs: 10_000,
        sourceEndMs: 40_000,
        targetStartMs: 0,
        targetEndMs: 30_000
      },
      {
        kind: "targetOnly",
        sourceStartMs: 40_000,
        sourceEndMs: 40_000,
        targetStartMs: 30_000,
        targetEndMs: 35_000
      },
      {
        kind: "matched",
        sourceStartMs: 40_000,
        sourceEndMs: 70_000,
        targetStartMs: 35_000,
        targetEndMs: 65_000
      }
    ],
    quality: {
      level: "review",
      probability: null,
      metricSource: "measured",
      coverage: 0.95,
      p50ResidualMs: 40,
      p95ResidualMs: 120,
      maxResidualMs: 240,
      boundaryUncertaintyMs: 200,
      alternativeMargin: 0.3,
      anchorCount: 50,
      heldOutAnchorCount: 10,
      reasons: ["测试映射仍需人工复核。"]
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 50,
      visualAnchorCount: 0,
      heldOutAnchorCount: 10,
      notes: ["测试音频证据。"]
    },
    engineVersion: "alignment-v2-test",
    featureVersion: "feature-v2-test",
    parametersHash: "sha256:test",
    state,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    confirmedAt:
      overrides.confirmedAt !== undefined
        ? overrides.confirmedAt
        : state === "candidate"
          ? null
          : "2026-07-11T00:00:00.000Z",
    ...overrides,
    sourceIdentity:
      "sourceIdentity" in overrides
        ? (overrides.sourceIdentity ?? null)
        : createValidMediaIdentity(),
    targetIdentity:
      "targetIdentity" in overrides
        ? (overrides.targetIdentity ?? null)
        : createValidMediaIdentity(),
    verification: "verification" in overrides ? (overrides.verification ?? null) : null
  };
}

function createValidLocalFileBinding() {
  return {
    id: "binding-local",
    kind: "localFile" as const,
    displayName: "demo",
    fileName: "demo.mp4",
    mediaId: "media",
    localPath: null,
    runtimeMs: 1000,
    linkedAt: "2026-07-10T00:00:00.000Z"
  };
}

function createValidEmbyBinding() {
  return {
    id: "binding-emby",
    kind: "embyItem" as const,
    displayName: "测试剧集 / S01E02 / 第二集",
    itemId: "emby-item-1",
    itemName: "第二集",
    itemType: "Episode",
    seriesName: "测试剧集",
    seasonNumber: 1,
    episodeNumber: 2,
    runtimeMs: 3_000_000,
    linkedAt: "2026-07-10T00:00:00.000Z",
    server: {
      serverUrl: "https://emby.example.test",
      pathPrefix: "/emby",
      username: "tester"
    },
    mediaSources: [
      {
        id: "source-1",
        name: "1080p",
        container: "mkv",
        videoCodec: "h264",
        audioCodec: "aac",
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
        sizeBytes: 1_000_000_000,
        runtimeMs: 3_000_000
      }
    ]
  };
}

function createValidProjectMediaReference(
  overrides: Partial<ProjectMediaReference> & { id: string; role: ProjectMediaRole }
): ProjectMediaReference {
  const roleDefaults =
    overrides.role === "bilibiliReference"
      ? { name: "B 站参考素材", fileName: "reference.mp4" }
      : { name: "目标原片", fileName: "target.mp4" };
  return {
    id: overrides.id,
    role: overrides.role,
    name: overrides.name ?? roleDefaults.name,
    fileName: overrides.fileName ?? roleDefaults.fileName,
    objectUrl: overrides.objectUrl ?? null,
    durationMs: overrides.durationMs ?? 120_000,
    contentIdentity:
      "contentIdentity" in overrides
        ? (overrides.contentIdentity ?? null)
        : createValidMediaIdentity(),
    referenceKind: overrides.referenceKind ?? "browserFile",
    connectionState: overrides.connectionState ?? "needsReconnect",
    sourceSummary: overrides.sourceSummary ?? "测试媒体",
    localPath: overrides.localPath ?? null,
    emby: overrides.emby ?? null,
    episodeKey: overrides.episodeKey ?? null,
    episodeLabel: overrides.episodeLabel ?? null,
    createdAt: overrides.createdAt ?? "2026-07-11T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-11T00:00:00.000Z"
  };
}

function createValidMediaIdentity() {
  return {
    algorithm: "fnv1a64-first-middle-last-64k-v1",
    sizeBytes: 1_000,
    modifiedUnixMs: 1_700_000_000_000,
    firstSampleDigest: "a".repeat(16),
    middleSampleDigest: "b".repeat(16),
    lastSampleDigest: "c".repeat(16)
  };
}
