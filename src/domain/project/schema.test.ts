import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "./factory";
import { parseProjectJson, serializeProject, validateProjectSchema } from "./schema";
import { CURRENT_SCHEMA_VERSION } from "./types";

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
      }
    };
    const json = serializeProject(project);
    expect(JSON.parse(json)).toMatchObject({ schemaVersion: CURRENT_SCHEMA_VERSION });
    const parsed = parseProjectJson(json);
    expect(parsed.name).toBe("测试项目");
    expect(parsed.media?.objectUrl).toBeNull();
  });

  it("可打开仓库内三分 P 示例项目", () => {
    const fixture = readFileSync(resolve("fixtures", "projects", "three-part-demo.danmaku-project.json"), "utf8");
    const parsed = parseProjectJson(fixture);

    expect(parsed.assets).toHaveLength(3);
    expect(parsed.cutMarkers).toHaveLength(1);
  });

  it("允许包含合法补偿点和同步锚点的项目", () => {
    const project = {
      ...createEmptyProject("带补偿项目"),
      cutMarkers: [{ id: "cut-1", name: "缺失片段", sourceAtMs: 30_000, targetGapMs: 45_000, note: "复核通过" }],
      syncAnchors: [{ id: "anchor-1", sourceMs: 10_000, targetMs: 12_000, confidence: 0.9, origin: "manual" as const }]
    };

    expect(validateProjectSchema(project)).toEqual({
      ok: true,
      version: CURRENT_SCHEMA_VERSION,
      message: "项目文件可打开。"
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

    const parsed = parseProjectJson(JSON.stringify(project));

    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.clips[0].sourceOutMs).toBe(1001);
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

    const parsed = parseProjectJson(JSON.stringify(project));

    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.clips[0].sourceOutMs).toBe(1000);
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

  it("拒绝字段类型错误的删减补偿点", () => {
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
    expect(validation.message).toContain("删减补偿点");
  });

  it("拒绝结构错误的同步锚点", () => {
    const project = {
      ...createEmptyProject(),
      syncAnchors: [{ id: "anchor", sourceMs: 10_000, targetMs: 12_000, confidence: 1.5, origin: "automatic" }]
    };
    const validation = validateProjectSchema(project);
    expect(validation.ok).toBe(false);
    expect(validation.message).toContain("同步锚点");
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
