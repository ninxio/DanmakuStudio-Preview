import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

interface UsabilityPerformanceBaseline {
  measuredAt: string;
  startupMs: number;
  largeXmlImportMs: number;
  pageSwitchMs: Record<string, number>;
  importedDanmakuCount: number;
  domNodeCountAfterImport: number;
  viewport: {
    width: number;
    height: number;
  };
}

test("易用化阶段 0 记录启动、四页切换和一万条 XML 导入基线", async ({
  page
}, testInfo) => {
  const startupStartedAt = performance.now();
  await page.goto("/");
  await expect(page.getByTestId("app-root")).toBeVisible();
  await expect(page.getByTestId("status-bar")).toContainText("准备就绪");
  const startupMs = performance.now() - startupStartedAt;

  const pageSwitchMs: Record<string, number> = {};
  for (const pageId of ["matching", "editing", "export", "materials"] as const) {
    const switchStartedAt = performance.now();
    await page.getByTestId(`workspace-nav-${pageId}`).click();
    await expect(page.getByTestId(`workspace-${pageId}`)).toBeVisible();
    pageSwitchMs[pageId] = performance.now() - switchStartedAt;
  }

  const importStartedAt = performance.now();
  await page
    .getByTestId("xml-input")
    .setInputFiles(resolve("fixtures", "bilibili", "large-10000.xml"));
  await expect(page.getByTestId("status-bar")).toContainText("10000 条弹幕");
  await expect(page.getByTestId("asset-card")).toContainText("large-10000.xml");
  const largeXmlImportMs = performance.now() - importStartedAt;

  const runtime = await page.evaluate(() => ({
    domNodeCountAfterImport: document.getElementsByTagName("*").length,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    }
  }));
  const baseline: UsabilityPerformanceBaseline = {
    measuredAt: new Date().toISOString(),
    startupMs: roundMilliseconds(startupMs),
    largeXmlImportMs: roundMilliseconds(largeXmlImportMs),
    pageSwitchMs: Object.fromEntries(
      Object.entries(pageSwitchMs).map(([pageId, elapsedMs]) => [
        pageId,
        roundMilliseconds(elapsedMs)
      ])
    ),
    importedDanmakuCount: 10_000,
    domNodeCountAfterImport: runtime.domNodeCountAfterImport,
    viewport: runtime.viewport
  };

  await testInfo.attach("usability-performance-baseline.json", {
    body: Buffer.from(JSON.stringify(baseline, null, 2), "utf8"),
    contentType: "application/json"
  });
  console.info(`USABILITY_PERFORMANCE_BASELINE ${JSON.stringify(baseline)}`);

  expect(baseline.startupMs).toBeGreaterThanOrEqual(0);
  expect(baseline.largeXmlImportMs).toBeGreaterThanOrEqual(0);
  expect(Object.keys(baseline.pageSwitchMs)).toEqual([
    "matching",
    "editing",
    "export",
    "materials"
  ]);
});

test("易用化阶段 1 的四步壳层在最小视口可用并记住面板布局", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");

  await expect(page.getByTestId("workflow-stepper")).toBeVisible();
  await expect(page.getByTestId("project-sidebar")).toBeVisible();
  await expect(page.getByTestId("context-rail")).toBeVisible();
  await expect(page.getByTestId("workspace-materials")).toBeVisible();

  for (const pageId of ["materials", "matching", "editing", "export"] as const) {
    const step = page.getByTestId(`workspace-nav-${pageId}`);
    await expect(step).toBeVisible();
    await expect(step).toHaveText(
      pageId === "materials"
        ? /素材/
        : pageId === "matching"
          ? /智能匹配/
          : pageId === "editing"
            ? /校准/
            : /导出/
    );
  }

  await page.getByRole("button", { name: "隐藏项目侧栏" }).click();
  await page.getByRole("button", { name: "隐藏当前步骤面板" }).click();
  await expect(page.getByTestId("project-sidebar")).toHaveCount(0);
  await expect(page.getByTestId("context-rail")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("button", { name: "显示项目侧栏" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "显示当前步骤面板" })
  ).toBeVisible();
  await expect(page.getByTestId("project-sidebar")).toHaveCount(0);
  await expect(page.getByTestId("context-rail")).toHaveCount(0);

  await page.getByTestId("workspace-nav-matching").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("workspace-matching")).toBeVisible();
  await expect(page.getByTestId("workspace-nav-matching")).toHaveAttribute(
    "aria-current",
    "page"
  );
});

function roundMilliseconds(value: number): number {
  return Math.round(value * 10) / 10;
}
