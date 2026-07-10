import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const screenshotDir = resolve(process.cwd(), "artifacts", "screenshots");
const downloadDir = resolve(process.cwd(), "artifacts", "downloads");

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true });
  mkdirSync(downloadDir, { recursive: true });
});

test("核心编辑流程可导入、编辑、导出并重新导入 XML", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("status-bar")).toContainText("准备就绪");
  await page.screenshot({ path: screenshotPath("empty-project.png"), fullPage: true });

  await page.getByLabel("设置").click();
  await page.getByRole("button", { name: "隐私与本地数据" }).click();
  await expect(page.getByRole("dialog")).toContainText("隐私与本地数据");
  await page.screenshot({ path: screenshotPath("settings-privacy.png"), fullPage: true });
  const settingsDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出设置" }).click();
  const settingsDownload = await settingsDownloadPromise;
  const settingsBackupPath = resolve(downloadDir, settingsDownload.suggestedFilename());
  await settingsDownload.saveAs(settingsBackupPath);
  const settingsBackupText = readFileSync(settingsBackupPath, "utf8");
  expect(settingsBackupText).toContain("alignment");
  expect(settingsBackupText).not.toContain("password");
  expect(settingsBackupText).not.toContain("token");
  const settingsImportPath = resolve(downloadDir, "imported-settings.json");
  writeFileSync(
    settingsImportPath,
    JSON.stringify({
      emby: {
        serverUrl: "https://backup.example.test",
        pathPrefix: "emby",
        username: "tester",
        password: "secret-pass"
      },
      alignment: {
        ffmpegPath: "ffmpeg",
        windowMs: 600,
        minGapMs: 1500,
        matchThreshold: 0.3,
        token: "secret-token"
      }
    }),
    "utf8"
  );
  await page.getByTestId("settings-import-input").setInputFiles(settingsImportPath);
  await expect(page.getByTestId("status-bar")).toContainText("已导入设置");
  await page.getByLabel("关闭设置").click();

  await page.getByTestId("xml-input").setInputFiles(resolve("fixtures", "bilibili", "normal.xml"));
  await expect(page.getByTestId("status-bar")).toContainText("已导入 1 个 XML");
  await expect(page.getByTestId("asset-card")).toContainText("normal.xml");
  await page.screenshot({ path: screenshotPath("imported-project.png"), fullPage: true });

  await page.getByRole("button", { name: "放入时间轴" }).click();
  await expect(page.getByTestId("inspector-clip")).toContainText("片段检查器");
  await page.setViewportSize({ width: 1024, height: 720 });
  await expect(page.getByTestId("timeline-panel")).toBeVisible();
  await expectTimelineToolbarLayout(page);
  await page.screenshot({ path: screenshotPath("compact-editor.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  const projectDownloadPromise = page.waitForEvent("download");
  await page.getByLabel("保存项目").click();
  const projectDownload = await projectDownloadPromise;
  const projectFilePath = resolve(downloadDir, projectDownload.suggestedFilename());
  await projectDownload.saveAs(projectFilePath);
  expect(readFileSync(projectFilePath, "utf8")).toContain("normal.xml");

  await page.getByLabel("新建项目").click();
  await expect(page.getByTestId("status-bar")).toContainText("已创建新项目");
  await page.getByTestId("project-input").setInputFiles(projectFilePath);
  await expect(page.getByTestId("status-bar")).toContainText("已打开项目");
  await expect(page.getByTestId("asset-card")).toContainText("normal.xml");
  await page.getByRole("button", { name: "项目信息" }).click();
  await expect(page.getByTestId("project-health-panel")).toContainText("项目健康");
  await expect(page.getByTestId("project-health-panel")).toContainText("健康");
  await expect(page.getByTestId("project-health-panel")).toContainText("媒体重连");
  await page.screenshot({ path: screenshotPath("project-health.png"), fullPage: true });
  await page.getByRole("button", { name: "弹幕文件" }).click();

  const blockedAudioAlignmentProposal = {
    anchors: [{ id: "audio-anchor-1", sourceMs: 20_000, targetMs: 40_000, origin: "automatic", confidence: 0.9 }],
    cutCandidates: [
      {
        id: "audio-gap-1",
        name: "音频推断补偿 1",
        sourceAtMs: 20_000,
        sourceRangeStartMs: 22_000,
        sourceRangeEndMs: 18_000,
        targetGapMs: 20_000,
        confidence: 0.72,
        note: "音频对齐候选"
      }
    ],
    confidence: 0.82,
    diagnostics: ["音频特征匹配 4 / 4 帧。"]
  };
  await page.getByPlaceholder("AlignmentProposal JSON").fill(JSON.stringify(blockedAudioAlignmentProposal, null, 2));
  await page.getByRole("button", { name: "导入提案" }).click();
  await expect(page.getByText("应用已暂停")).toBeVisible();
  await expect(page.getByText(/不确定区间起止顺序异常/).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "应用候选" })).toBeDisabled();

  const audioAlignmentProposal = {
    anchors: [{ id: "audio-anchor-1", sourceMs: 20_000, targetMs: 40_000, origin: "automatic", confidence: 0.9 }],
    cutCandidates: [
      {
        id: "audio-gap-1",
        name: "音频推断补偿 1",
        sourceAtMs: 20_000,
        sourceRangeStartMs: 18_000,
        sourceRangeEndMs: 22_000,
        targetGapMs: 20_000,
        confidence: 0.72,
        note: "音频对齐候选"
      }
    ],
    confidence: 0.82,
    diagnostics: ["音频特征匹配 4 / 4 帧。"]
  };
  await page.getByPlaceholder("AlignmentProposal JSON").fill(JSON.stringify(audioAlignmentProposal, null, 2));
  await page.getByRole("button", { name: "导入提案" }).click();
  await expect(page.getByTestId("status-bar")).toContainText("已发送到时间轴预览");
  await expect(page.getByText("应用已暂停")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "应用候选" })).toBeEnabled();
  const alignmentReportDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出报告" }).click();
  const alignmentReportDownload = await alignmentReportDownloadPromise;
  const alignmentReportPath = resolve(downloadDir, alignmentReportDownload.suggestedFilename());
  await alignmentReportDownload.saveAs(alignmentReportPath);
  const alignmentReportText = readFileSync(alignmentReportPath, "utf8");
  expect(alignmentReportText).toContain("对齐提案复核报告");
  expect(alignmentReportText).toContain("audio-gap-1");
  expect(alignmentReportText).toContain("不确定区间：00:00:18.000");
  expect(alignmentReportText).toContain("音频特征匹配 4 / 4 帧。");

  await page.getByPlaceholder(/每行一个对应点/).fill("00:10 -> 00:10\n00:20 -> 00:30");
  await page.getByRole("button", { name: "应用锚点与补偿" }).click();
  await expect(page.getByTestId("status-bar")).toContainText("已应用对齐提案");
  const secondAnchorTargetInput = page.getByLabel("同步锚点 2 目标时间 ms");
  await expect(secondAnchorTargetInput).toHaveValue("30000");
  await secondAnchorTargetInput.fill("32000");
  await expect(secondAnchorTargetInput).toHaveValue("32000");
  await page.getByLabel("撤销").click();
  await expect(page.getByTestId("status-bar")).toContainText("已撤销");
  await expect(secondAnchorTargetInput).toHaveValue("30000");
  await page.getByLabel("重做").click();
  await expect(page.getByTestId("status-bar")).toContainText("已重做");
  await expect(secondAnchorTargetInput).toHaveValue("32000");

  const timeline = page.getByTestId("timeline-canvas");
  await expect(timeline).toBeVisible();
  await timeline.click({ position: { x: 420, y: 18 } });
  await page.screenshot({ path: screenshotPath("timeline-editing.png"), fullPage: true });

  await page.getByRole("button", { name: "添加删减点" }).click();
  await expect(page.getByTestId("inspector-cut")).toContainText("删减标记");
  await expect(page.getByTestId("status-bar")).toContainText("添加删减标记");
  await page.screenshot({ path: screenshotPath("cut-marker.png"), fullPage: true });

  await page.getByLabel("撤销").click();
  await expect(page.getByTestId("status-bar")).toContainText("已撤销");
  await page.getByLabel("重做").click();
  await expect(page.getByTestId("status-bar")).toContainText("已重做");

  const cutGapInput = page.getByLabel("缺失或新增时长");
  await expect(cutGapInput).toHaveValue("45000");
  await cutGapInput.fill("12000");
  await expect(cutGapInput).toHaveValue("12000");
  await page.getByLabel("撤销").click();
  await expect(page.getByTestId("status-bar")).toContainText("已撤销");
  await expect(cutGapInput).toHaveValue("45000");
  await page.getByLabel("重做").click();
  await expect(page.getByTestId("status-bar")).toContainText("已重做");
  await expect(cutGapInput).toHaveValue("12000");

  await page.getByLabel("导出 XML").click();
  await expect(page.getByTestId("export-dialog")).toContainText("导出 XML 摘要");
  await expect(page.getByTestId("export-dialog")).toContainText("验证条数");
  await expect(page.getByTestId("export-dialog")).toContainText("总补偿时长");
  const compensationReportDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载补偿报告" }).click();
  const compensationReportDownload = await compensationReportDownloadPromise;
  const compensationReportPath = resolve(downloadDir, compensationReportDownload.suggestedFilename());
  await compensationReportDownload.saveAs(compensationReportPath);
  expect(readFileSync(compensationReportPath, "utf8")).toContain("补偿明细");
  await page.screenshot({ path: screenshotPath("export-dialog.png"), fullPage: true });

  const exportedXmlDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 XML" }).click();
  const exportedXmlDownload = await exportedXmlDownloadPromise;
  const exportedXmlPath = resolve(downloadDir, exportedXmlDownload.suggestedFilename());
  await exportedXmlDownload.saveAs(exportedXmlPath);
  const exportedXmlText = readFileSync(exportedXmlPath, "utf8");
  expect(exportedXmlText).toContain("<i>");
  expect(exportedXmlText).toContain("<d p=");

  await page.getByLabel("新建项目").click();
  await expect(page.getByTestId("status-bar")).toContainText("已创建新项目");
  await page.getByTestId("xml-input").setInputFiles(exportedXmlPath);
  await expect(page.getByTestId("status-bar")).toContainText("已导入 1 个 XML");
  await expect(page.getByTestId("asset-card")).toContainText(exportedXmlDownload.suggestedFilename());
  await page.screenshot({ path: screenshotPath("reimported-export.png"), fullPage: true });
});

function screenshotPath(fileName: string): string {
  return resolve(screenshotDir, fileName);
}

interface ToolbarBox {
  label: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  toolbarLeft: number;
  toolbarRight: number;
  toolbarTop: number;
  toolbarBottom: number;
}

async function expectTimelineToolbarLayout(page: Page): Promise<void> {
  const boxes: ToolbarBox[] = await page.getByTestId("timeline-toolbar").evaluate((toolbar) => {
    const toolbarRect = toolbar.getBoundingClientRect();
    return Array.from(toolbar.querySelectorAll<HTMLElement>("button, [data-toolbar-chip='true']")).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        label: element.textContent?.trim() || element.getAttribute("aria-label") || "toolbar item",
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        toolbarLeft: toolbarRect.left,
        toolbarRight: toolbarRect.right,
        toolbarTop: toolbarRect.top,
        toolbarBottom: toolbarRect.bottom
      };
    });
  });
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.left, `${box.label} left edge`).toBeGreaterThanOrEqual(box.toolbarLeft - 1);
    expect(box.right, `${box.label} right edge`).toBeLessThanOrEqual(box.toolbarRight + 1);
    expect(box.top, `${box.label} top edge`).toBeGreaterThanOrEqual(box.toolbarTop - 1);
    expect(box.bottom, `${box.label} bottom edge`).toBeLessThanOrEqual(box.toolbarBottom + 1);
  }
  for (let firstIndex = 0; firstIndex < boxes.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < boxes.length; secondIndex += 1) {
      const first = boxes[firstIndex];
      const second = boxes[secondIndex];
      const horizontalOverlap = Math.min(first.right, second.right) - Math.max(first.left, second.left);
      const verticalOverlap = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
      expect(
        Math.min(horizontalOverlap, verticalOverlap),
        `${first.label} overlaps ${second.label}`
      ).toBeLessThanOrEqual(1);
    }
  }
}
