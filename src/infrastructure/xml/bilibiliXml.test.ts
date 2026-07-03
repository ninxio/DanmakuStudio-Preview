import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBilibiliXml, serializeBilibiliXml, validateExportedXml } from "./bilibiliXml";

const fixtureRoot = join(process.cwd(), "fixtures", "bilibili");

function readFixture(name: string): string {
  return readFileSync(join(fixtureRoot, name), "utf8");
}

describe("Bilibili XML", () => {
  it("解析正常 XML 并把秒转换为整数毫秒", () => {
    const asset = parseBilibiliXml(readFixture("normal.xml"), { fileName: "normal.xml" });
    expect(asset.items).toHaveLength(3);
    expect(asset.items[0].sourceTimeMs).toBe(1500);
    expect(asset.items[1].mode).toBe(5);
    expect(asset.items[2].color).toBe(255);
    expect(asset.items[0].rawPFields).toHaveLength(8);
  });

  it("正确处理 XML entity 和特殊符号", () => {
    const asset = parseBilibiliXml(readFixture("special-chars.xml"), { fileName: "special.xml" });
    expect(asset.items[0].text).toContain("小于号 < 大于号 > 与 & 符号");
    const exported = serializeBilibiliXml(asset.items.map((item) => ({ item, finalTimeMs: item.sourceTimeMs })));
    expect(exported.xml).toContain("&lt;");
    expect(validateExportedXml(exported.xml).ok).toBe(true);
  });

  it("非法节点产生警告但不阻断导入", () => {
    const asset = parseBilibiliXml(readFixture("missing-fields.xml"), { fileName: "bad.xml" });
    expect(asset.items).toHaveLength(3);
    expect(asset.warnings.length).toBeGreaterThanOrEqual(3);
    expect(asset.items[0].sourceTimeMs).toBe(0);
  });

  it("保留中文、日文和 Emoji", () => {
    const asset = parseBilibiliXml(readFixture("multilingual.xml"), { fileName: "multi.xml" });
    expect(asset.items.map((item) => item.text).join(" ")).toContain("こんにちは");
    expect(asset.items.map((item) => item.text).join(" ")).toContain("🚀");
  });

  it("可解析一万条合成弹幕", () => {
    const asset = parseBilibiliXml(readFixture("large-10000.xml"), { fileName: "large.xml" });
    expect(asset.items).toHaveLength(10_000);
    expect(asset.items[9999].originalIndex).toBe(9999);
  });

  it("导出时按最终时间排序，相同时间按原始顺序排序，并限制负时间", () => {
    const asset = parseBilibiliXml(readFixture("normal.xml"), { fileName: "normal.xml" });
    const result = serializeBilibiliXml([
      { item: asset.items[2], finalTimeMs: 1000 },
      { item: asset.items[0], finalTimeMs: -50 },
      { item: asset.items[1], finalTimeMs: 1000 }
    ]);
    expect(result.negativeClampCount).toBe(1);
    const reparsed = parseBilibiliXml(result.xml, { fileName: "export.xml" });
    expect(reparsed.items.map((item) => item.sourceTimeMs)).toEqual([0, 1000, 1000]);
    expect(reparsed.items[1].text).toBe(asset.items[1].text);
    expect(reparsed.items[2].text).toBe(asset.items[2].text);
  });
});
