import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const fixtureDir = join(root, "fixtures", "bilibili");
const projectDir = join(root, "fixtures", "projects");
mkdirSync(projectDir, { recursive: true });

const files = ["part-1.xml", "part-2.xml", "part-3.xml"];
const colors = ["#4cc9f0", "#7bd88f", "#f2c94c"];
const now = "2026-07-03T00:00:00.000Z";

function decodeXml(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function parseItems(fileName, assetId) {
  const xml = readFileSync(join(fixtureDir, fileName), "utf8");
  const matches = Array.from(xml.matchAll(/<d\s+p="([^"]*)">([\s\S]*?)<\/d>/g));
  return matches.map((match, index) => {
    const fields = match[1].split(",");
    return {
      id: `${assetId}_item_${index}`,
      assetId,
      originalIndex: index,
      sourceTimeMs: Math.round(Number(fields[0]) * 1000),
      mode: Number(fields[1]),
      fontSize: Number(fields[2]),
      color: Number(fields[3]),
      timestamp: Number(fields[4]),
      pool: Number(fields[5]),
      userHash: fields[6],
      rowId: fields[7],
      text: decodeXml(match[2]),
      rawPFields: fields,
      enabled: true
    };
  });
}

const assets = files.map((fileName, index) => {
  const assetId = `demo_asset_${index + 1}`;
  return {
    id: assetId,
    name: fileName.replace(".xml", ""),
    fileName,
    color: colors[index],
    items: parseItems(fileName, assetId),
    warnings: [],
    importedAt: now
  };
});

let cursor = 0;
const clips = assets.map((asset, index) => {
  const latest = Math.max(...asset.items.map((item) => item.sourceTimeMs));
  const clip = {
    id: `demo_clip_${index + 1}`,
    assetId: asset.id,
    name: `${asset.name} 时间轴片段`,
    timelineStartMs: cursor,
    sourceInMs: 0,
    sourceOutMs: latest,
    localOffsetMs: 0,
    enabled: true
  };
  cursor += latest;
  return clip;
});

const project = {
  schemaVersion: 1,
  id: "demo_three_part_project",
  name: "三分P合并示例",
  media: null,
  assets,
  clips,
  globalOffsetMs: 0,
  cutMarkers: [
    {
      id: "demo_cut_1",
      name: "示例删减点",
      sourceAtMs: 30_000,
      targetGapMs: 45_000,
      note: "示例：完整版在此处额外存在 45 秒内容。"
    }
  ],
  syncAnchors: [],
  itemTimeAdjustments: {},
  disabledItemIds: [],
  timeline: {
    pixelsPerSecond: 90,
    scrollMs: 0,
    playheadMs: 0
  },
  preview: {
    danmakuVisible: true,
    safeAreaVisible: false,
    opacity: 0.88
  },
  createdAt: now,
  updatedAt: now
};

writeFileSync(
  join(projectDir, "three-part-demo.danmaku-project.json"),
  `${JSON.stringify(project, null, 2)}\n`,
  "utf8"
);
