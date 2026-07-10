import { describe, expect, it } from "vitest";
import type { AlignmentProposal } from "../alignment/types";
import type { DanmakuClip } from "../danmaku/types";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { createEmptyProject } from "./factory";
import { createWorkflowOverview } from "./workflowOverview";

describe("workflow overview", () => {
  it("空项目从导入 XML 开始，并展示下一步", () => {
    const overview = createWorkflowOverview(createEmptyProject(), null);

    expect(overview.progressPercent).toBe(0);
    expect(overview.nextActionId).toBe("import-xml");
    expect(overview.liveSummary).toContain("0 个 XML");
    expect(overview.stages.map((stage) => [stage.id, stage.state])).toEqual([
      ["source", "active"],
      ["timeline", "blocked"],
      ["alignment", "idle"],
      ["review", "active"],
      ["export", "idle"]
    ]);
    expect(overview.capabilities.map((capability) => capability.id)).toContain("raw-xml-safe");
    expect(overview.capabilities.map((capability) => capability.id)).toContain("target-media");
    expect(overview.actions.find((action) => action.id === "export-xml")?.reason).toBe("需要先把 XML 放入时间轴。");
  });

  it("目标原片绑定会进入来源阶段和能力地图", () => {
    const overview = createWorkflowOverview(
      {
        ...createEmptyProject(),
        mediaBinding: {
          id: "binding-emby",
          kind: "embyItem",
          displayName: "测试剧集 / S01E02 / 第二集",
          itemId: "item-1",
          itemName: "第二集",
          itemType: "Episode",
          seriesName: "测试剧集",
          seasonNumber: 1,
          episodeNumber: 2,
          runtimeMs: 3_000_000,
          linkedAt: "2026-07-10T00:00:00.000Z",
          server: { serverUrl: "https://emby.example.test", pathPrefix: "/emby", username: "tester" },
          mediaSources: []
        }
      },
      null
    );

    expect(overview.stages.find((stage) => stage.id === "source")?.metrics).toContainEqual({
      label: "目标原片",
      value: "测试剧集 / S01E02 / 第二集"
    });
    expect(overview.capabilities.find((capability) => capability.id === "target-media")).toMatchObject({
      stateText: "已绑定",
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
        assets: [asset]
      },
      null
    );

    expect(overview.nextActionId).toBe("auto-arrange");
    expect(overview.stages.find((stage) => stage.id === "source")?.metrics).toContainEqual({
      label: "XML",
      value: "1 个"
    });
    expect(overview.actions.find((action) => action.id === "auto-arrange")?.enabled).toBe(true);
    expect(overview.capabilities.find((capability) => capability.id === "cut-hints")?.active).toBe(true);
  });

  it("时间轴和对齐提案会让导出、复核和应用状态实时变化", () => {
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
      anchors: [{ id: "anchor-new", sourceMs: 0, targetMs: 1000, origin: "automatic", confidence: 0.9 }],
      cutCandidates: [],
      confidence: 0.9,
      diagnostics: ["测试提案"]
    };
    const overview = createWorkflowOverview(
      {
        ...createEmptyProject(),
        assets: [asset],
        clips: [clip],
        alignmentProposal: proposal
      },
      proposal
    );

    expect(overview.actions.find((action) => action.id === "apply-alignment")?.enabled).toBe(true);
    expect(overview.actions.find((action) => action.id === "export-xml")?.enabled).toBe(true);
    expect(overview.stages.find((stage) => stage.id === "alignment")?.stateText).toBe("已有差异线索");
    expect(overview.stages.find((stage) => stage.id === "export")?.stateText).toBe("可导出");
    expect(overview.capabilities.find((capability) => capability.id === "alignment-review")?.active).toBe(true);
  });
});
