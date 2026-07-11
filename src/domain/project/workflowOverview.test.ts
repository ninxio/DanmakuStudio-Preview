import { describe, expect, it } from "vitest";
import type { AlignmentProposal } from "../alignment/types";
import type { DanmakuClip } from "../danmaku/types";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { createEmptyProject } from "./factory";
import { createDanmakuSourceSegment } from "./sourceTimeline";
import type { ProjectMediaReference } from "./types";
import { createWorkflowOverview } from "./workflowOverview";

describe("workflow overview", () => {
  it("空项目从素材页导入 XML 开始", () => {
    const overview = createWorkflowOverview(createEmptyProject(), null);

    expect(overview.progressPercent).toBe(0);
    expect(overview.nextActionId).toBe("import-xml");
    expect(overview.liveSummary).toContain("0 个 XML");
    expect(overview.stages.map((stage) => [stage.id, stage.state])).toEqual([
      ["materials", "active"],
      ["matching", "idle"],
      ["editing", "idle"],
      ["export", "idle"]
    ]);
    expect(overview.capabilities.map((capability) => capability.id)).toContain("raw-xml-safe");
    expect(overview.capabilities.map((capability) => capability.id)).toContain(
      "multi-media-library"
    );
    expect(overview.actions.find((action) => action.id === "export-xml")?.enabled).toBe(false);
  });

  it("多媒体素材库和 XML 绑定会进入素材阶段", () => {
    const asset = parseBilibiliXml(createTimedXml(240, 15), {
      fileName: "测试剧集 S01E02.xml"
    });
    const overview = createWorkflowOverview(
      {
        ...createEmptyProject(),
        assets: [asset],
        mediaLibrary: [
          createMedia("ref", "bilibiliReference"),
          createMedia("ep1", "targetOriginal", { episodeLabel: "第 1 集" })
        ],
        danmakuSourceBindings: [
          {
            id: "bind-1",
            assetId: asset.id,
            sourceMediaId: "ref",
            linkedAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z"
          }
        ]
      },
      null
    );

    expect(overview.stages.find((stage) => stage.id === "materials")?.state).toBe("complete");
    expect(overview.stages.find((stage) => stage.id === "matching")?.state).toBe("active");
    expect(overview.stages.find((stage) => stage.id === "materials")?.metrics).toContainEqual({
      label: "原片素材",
      value: "1 个"
    });
    expect(
      overview.capabilities.find((capability) => capability.id === "xml-binding")
    ).toMatchObject({
      active: true
    });
  });

  it("导入 XML 后总览同步资源和自动排布入口", () => {
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,r">测试</d></i>`,
      { fileName: "source.xml" }
    );
    const overview = createWorkflowOverview(
      {
        ...createEmptyProject(),
        assets: [asset],
        mediaLibrary: [
          createMedia("ref", "bilibiliReference"),
          createMedia("ep1", "targetOriginal")
        ]
      },
      null
    );

    expect(overview.stages.find((stage) => stage.id === "materials")?.state).toBe("active");
    expect(overview.stages.find((stage) => stage.id === "materials")?.metrics).toContainEqual({
      label: "XML",
      value: "1 个"
    });
    expect(overview.actions.find((action) => action.id === "auto-arrange")?.enabled).toBe(true);
    expect(
      overview.capabilities.find((capability) => capability.id === "cut-hints")?.active
    ).toBe(true);
  });

  it("来源段和投影就绪后导出阶段变为可导出", () => {
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,r">测试</d></i>`,
      { assetId: "asset-workflow", fileName: "workflow.xml" }
    );
    const clip: DanmakuClip = {
      id: "clip-workflow",
      assetId: asset.id,
      name: "workflow",
      timelineStartMs: 0,
      sourceInMs: 0,
      sourceOutMs: 1000,
      localOffsetMs: 0,
      enabled: true
    };
    const proposal: AlignmentProposal = {
      anchors: [
        { id: "anchor-new", sourceMs: 0, targetMs: 1000, origin: "automatic", confidence: 0.9 }
      ],
      cutCandidates: [],
      confidence: 0.9,
      diagnostics: ["测试提案"]
    };
    const overview = createWorkflowOverview(
      {
        ...createEmptyProject(),
        assets: [asset],
        clips: [clip],
        mediaLibrary: [
          createMedia("ref", "bilibiliReference"),
          createMedia("ep1", "targetOriginal", { episodeLabel: "第 1 集" })
        ],
        danmakuSourceBindings: [
          {
            id: "bind-1",
            assetId: asset.id,
            sourceMediaId: "ref",
            linkedAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z"
          }
        ],
        danmakuSourceSegments: [
          createDanmakuSourceSegment("seg-1", {
            kind: "content",
            assetId: asset.id,
            sourceMediaId: "ref",
            sourceStartMs: 0,
            sourceEndMs: 60_000,
            targetMediaId: "ep1",
            episodeKey: null,
            episodeLabel: "第 1 集"
          })
        ],
        alignmentProposal: proposal
      },
      proposal
    );

    expect(overview.actions.find((action) => action.id === "review-matches")?.enabled).toBe(
      true
    );
    expect(overview.actions.some((action) => action.label.includes("应用对齐"))).toBe(false);
    expect(overview.actions.find((action) => action.id === "export-xml")?.enabled).toBe(true);
    expect(overview.stages.find((stage) => stage.id === "matching")?.state).toBe("complete");
    expect(overview.stages.find((stage) => stage.id === "export")?.state).toBe("active");
    expect(
      overview.capabilities.find((capability) => capability.id === "projection-export")?.active
    ).toBe(true);
  });
});

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
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...overrides
  };
}

function createTimedXml(count: number, intervalSeconds: number): string {
  const lines = Array.from(
    { length: count },
    (_, index) =>
      `<d p="${index * intervalSeconds},1,25,16777215,0,0,u${index},r${index}">测试 ${index + 1}</d>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?><i>${lines.join("")}</i>`;
}
