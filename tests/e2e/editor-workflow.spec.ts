import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const screenshotDir = resolve(process.cwd(), "artifacts", "screenshots");

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true });
});

test("核心编辑流程可导入、编辑并生成导出摘要", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("status-bar")).toContainText("准备就绪");
  await page.screenshot({ path: screenshotPath("empty-project.png"), fullPage: true });

  await page.getByTestId("xml-input").setInputFiles(resolve("fixtures", "bilibili", "normal.xml"));
  await expect(page.getByTestId("status-bar")).toContainText("已导入 1 个 XML");
  await expect(page.getByTestId("asset-card")).toContainText("normal.xml");
  await page.screenshot({ path: screenshotPath("imported-project.png"), fullPage: true });

  await page.getByRole("button", { name: "放入时间轴" }).click();
  await expect(page.getByTestId("inspector-clip")).toContainText("片段检查器");

  const timeline = page.getByTestId("timeline-canvas");
  await expect(timeline).toBeVisible();
  await timeline.click({ position: { x: 420, y: 18 } });
  await page.screenshot({ path: screenshotPath("timeline-editing.png"), fullPage: true });

  await page.getByRole("button", { name: "添加删减点" }).click();
  await expect(page.getByTestId("inspector-cut")).toContainText("删减标记");
  await expect(page.getByTestId("status-bar")).toContainText("添加删减标记");
  await page.screenshot({ path: screenshotPath("cut-marker.png"), fullPage: true });

  await page.getByLabel("导出 XML").click();
  await expect(page.getByTestId("export-dialog")).toContainText("导出 XML 摘要");
  await expect(page.getByTestId("export-dialog")).toContainText("验证条数");
  await page.screenshot({ path: screenshotPath("export-dialog.png"), fullPage: true });
});

function screenshotPath(fileName: string): string {
  return resolve(screenshotDir, fileName);
}
