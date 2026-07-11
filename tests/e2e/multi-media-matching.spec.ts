import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const screenshotDir = resolve(process.cwd(), "artifacts", "screenshots");
const downloadDir = resolve(process.cwd(), "artifacts", "downloads");

interface MockDialogCall {
  title: string;
  multiple: boolean;
}

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true });
  mkdirSync(downloadDir, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-11T02:03:04.000Z"));
  await page.addInitScript(
    ({ sourcePaths, targetPaths }) => {
      interface MockTauriWindow extends Window {
        isTauri: boolean;
        __C136_DIALOG_CALLS__: MockDialogCall[];
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        };
      }

      const mockWindow = window as unknown as MockTauriWindow;
      let jobIndex = 0;
      const completedJobs = new Map<string, Record<string, unknown>>();
      mockWindow.isTauri = true;
      mockWindow.__C136_DIALOG_CALLS__ = [];
      mockWindow.__TAURI_INTERNALS__ = {
        invoke: async (command, args = {}) => {
          await Promise.resolve();
          if (command === "load_app_settings_file") {
            return null;
          }
          if (command === "save_app_settings_file" || command === "clear_app_settings_file") {
            return null;
          }
          if (command === "plugin:dialog|open") {
            const options = (args.options ?? {}) as { title?: string; multiple?: boolean };
            mockWindow.__C136_DIALOG_CALLS__.push({
              title: options.title ?? "",
              multiple: options.multiple === true
            });
            if (options.title === "选择原片素材") {
              return targetPaths;
            }
            if (options.title === "选择 B 站参考素材") {
              return sourcePaths;
            }
            return null;
          }
          if (command === "start_audio_alignment_job") {
            const currentIndex = jobIndex;
            jobIndex += 1;
            const jobId = `c136-job-${currentIndex + 1}`;
            const snapshot = {
              jobId,
              status: "completed",
              progress: 1,
              message: "已定位对应片段",
              stageKey: "completed",
              stageLabel: "分析完成",
              stageIndex: 9,
              stageCount: 9,
              stageProgress: 1,
              logs: [`模拟桌面定位任务 ${currentIndex + 1}`],
              proposal: {
                anchors: [
                  {
                    id: `anchor-${currentIndex + 1}`,
                    sourceMs: 5_000,
                    targetMs: 5_000,
                    confidence: 0.94,
                    origin: "automatic"
                  }
                ],
                cutCandidates: [],
                confidence: 0.9,
                diagnostics: ["E2E 使用确定性桌面桥接结果；真实定位由 Rust 测试覆盖。"],
                matchRange: {
                  sourceStartMs: 0,
                  sourceEndMs: 60_000,
                  targetStartMs: 0,
                  targetEndMs: 60_000,
                  coverage: 1
                }
              },
              error: null,
              updatedAtMs: Date.now()
            };
            completedJobs.set(jobId, snapshot);
            return snapshot;
          }
          if (command === "get_audio_alignment_job") {
            const jobId = typeof args.jobId === "string" ? args.jobId : "";
            return completedJobs.get(jobId) ?? null;
          }
          if (command === "cancel_audio_alignment_job") {
            const jobId = typeof args.jobId === "string" ? args.jobId : "";
            return completedJobs.get(jobId) ?? null;
          }
          throw new Error(`未处理的 Tauri E2E 命令：${command}`);
        }
      };
    },
    {
      sourcePaths: ["C:\\C136\\C136-reference.mkv"],
      targetPaths: Array.from({ length: 5 }, (_, index) => `C:\\C136\\C136-E0${index + 1}.mkv`)
    }
  );
});

test("北极星多素材流程可批量导入、生成五组候选并按五个原片导出", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "批量导入原片素材" }).click();
  await expect(page.getByTestId("status-bar")).toContainText("已导入 5 个原片素材");
  await page.getByRole("button", { name: "批量导入 B 站参考素材" }).click();
  await expect(page.getByTestId("status-bar")).toContainText("已导入 1 个B 站参考素材");
  await expect(page.getByText("C136-E01.mkv", { exact: true })).toBeVisible();
  await expect(page.getByText("C136-E05.mkv", { exact: true })).toBeVisible();
  await expect(page.getByText("C136-reference.mkv", { exact: true })).toBeVisible();

  const dialogCalls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __C136_DIALOG_CALLS__: MockDialogCall[];
        }
      ).__C136_DIALOG_CALLS__
  );
  expect(dialogCalls).toEqual([
    { title: "选择原片素材", multiple: true },
    { title: "选择 B 站参考素材", multiple: true }
  ]);

  await page
    .getByTestId("xml-input")
    .setInputFiles(resolve("fixtures", "bilibili", "normal.xml"));
  await expect(page.getByTestId("status-bar")).toContainText("已导入 1 个 XML");
  await page.getByLabel("normal.xml 弹幕来源视频").selectOption({ label: "C136-reference" });
  await expect(page.getByTestId("status-bar")).toContainText("已绑定 XML 来源");
  await page.getByRole("heading", { name: "原片素材", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(screenshotDir, "c136-materials-batch.png"),
    fullPage: true
  });

  await page.getByTestId("workspace-nav-matching").click();
  const matchingPanel = page.getByTestId("media-matching-panel");
  await expect(matchingPanel).toContainText("将分析 1 个参考 × 5 个原片，共 5 组");
  await matchingPanel.getByRole("button", { name: "开始批量匹配" }).click();
  await expect(page.getByTestId("media-match-candidate")).toHaveCount(5);
  await expect(page.getByTestId("status-bar")).toContainText("5 组中新找到 5 个候选");
  await matchingPanel.getByRole("heading", { name: "候选复核" }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(screenshotDir, "c136-matching-candidates.png"),
    fullPage: true
  });

  await matchingPanel.getByRole("button", { name: "按各卡勾选确认高可信候选（5）" }).click();
  await expect(page.getByTestId("confirmed-media-relations")).toContainText("C136-E01");
  await expect(page.getByTestId("confirmed-media-relations")).toContainText("C136-E05");
  await expect(matchingPanel).toContainText("5 / 5 个原片已确认");

  await page.getByTestId("workspace-nav-export").click();
  const projectionExport = page.getByRole("region", { name: "按原片分集导出" });
  await expect(projectionExport).toContainText("可导出分集");
  await expect(projectionExport).toContainText("5 个");
  await expect(projectionExport).toContainText("15 条");
  await projectionExport.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(screenshotDir, "c136-export-multi-target.png"),
    fullPage: true
  });

  const downloadPromise = page.waitForEvent("download");
  await projectionExport.getByRole("button", { name: "导出全部分集 XML" }).click();
  const download = await downloadPromise;
  const archivePath = resolve(downloadDir, download.suggestedFilename());
  await download.saveAs(archivePath);
  expect(download.suggestedFilename()).toMatch(/-target-danmaku\.zip$/);
  expect(readFileSync(archivePath).byteLength).toBeGreaterThan(0);
  await expect(page.getByTestId("status-bar")).toContainText("已触发下载 5 个分集 XML");
});
