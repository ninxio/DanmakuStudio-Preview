import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const screenshotDir = resolve(process.cwd(), "artifacts", "screenshots");

interface MockDialogCall {
  title: string;
  multiple: boolean;
}

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-11T02:03:04.000Z"));
  await page.addInitScript(
    ({ sourcePaths, targetPaths, xmlPaths }) => {
      interface MockTauriWindow extends Window {
        isTauri: boolean;
        __C136_DIALOG_CALLS__: MockDialogCall[];
        __C137_VERIFICATION_CALLS__: string[];
        __C137_PERFORMANCE_CALLS__: string[];
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        };
      }

      const mediaIdentity = (digit: string, sizeBytes: number) => ({
        algorithm: "sha256-full-file-v2",
        sizeBytes,
        modifiedUnixMs: 1_700_000_000_000,
        firstSampleDigest: digit.repeat(64),
        middleSampleDigest: digit.repeat(64),
        lastSampleDigest: digit.repeat(64)
      });
      const createTimeMap = (currentIndex: number) => {
        const sourceStartMs = currentIndex * 60_000;
        const sourceEndMs = sourceStartMs + 60_000;
        const fourKindSpans = [
          {
            kind: "matched",
            sourceStartMs,
            sourceEndMs: sourceStartMs + 20_000,
            targetStartMs: 0,
            targetEndMs: 20_000
          },
          {
            kind: "sourceOnly",
            sourceStartMs: sourceStartMs + 20_000,
            sourceEndMs: sourceStartMs + 25_000,
            targetStartMs: 20_000,
            targetEndMs: 20_000
          },
          {
            kind: "targetOnly",
            sourceStartMs: sourceStartMs + 25_000,
            sourceEndMs: sourceStartMs + 25_000,
            targetStartMs: 20_000,
            targetEndMs: 26_000
          },
          {
            kind: "ambiguous",
            sourceStartMs: sourceStartMs + 25_000,
            sourceEndMs,
            targetStartMs: 26_000,
            targetEndMs: 61_000
          }
        ];
        const completeSpan = (span: (typeof fourKindSpans)[number], spanIndex: number) => {
          const isMatched = span.kind === "matched";
          const isSourceOnly = span.kind === "sourceOnly";
          const isTargetOnly = span.kind === "targetOnly";
          const boundaryAxis = isSourceOnly ? "source" : isTargetOnly ? "target" : "both";
          const boundaryStatus = isMatched
            ? "notApplicable"
            : span.kind === "ambiguous"
              ? "ambiguous"
              : "unsupported";
          const boundaryCoordinate = (side: "start" | "end") => {
            if (isSourceOnly) {
              return side === "start" ? span.sourceStartMs : span.sourceEndMs;
            }
            if (isTargetOnly) {
              return side === "start" ? span.targetStartMs : span.targetEndMs;
            }
            return null;
          };
          const boundary = (side: "start" | "end") => ({
            status: boundaryStatus,
            axis: boundaryAxis,
            contextSide: isMatched || span.kind === "ambiguous" ? null : side === "start" ? "before" : "after",
            coarseMs: boundaryCoordinate(side),
            refinedMs: null,
            uncertaintyStartMs: null,
            uncertaintyEndMs: null,
            supportDurationMs: 0,
            correlation: null,
            alternativeMargin: null,
            reason: isMatched
              ? "E2E 共同内容段不声明版本差异边界。"
              : "E2E 没有真实媒体边界测量，必须人工复核。"
          });
          return {
            ...span,
            id: `e2e-map-${currentIndex + 1}:span:${String(spanIndex + 1).padStart(4, "0")}`,
            reason: span.kind === "ambiguous" ? "insufficientEvidence" : "e2eMeasured",
            quality: {
              level: span.kind === "ambiguous" ? "blocked" : "review",
              metricSource: "measured",
              probability: null,
              coverage: isMatched ? 0.96 : 0.72,
              uniqueContentCoverage: 0.9,
              alternativeMargin: 0.32,
              anchorCount: isMatched ? 12 : 4,
              heldOutAnchorCount: isMatched ? 3 : 1,
              p50ResidualMs: 35,
              p95ResidualMs: 80,
              p99ResidualMs: 120,
              maxResidualMs: 140,
              boundaryUncertaintyMs: 180,
              leftSupport: isMatched ? "supported" : "unsupported",
              rightSupport: isMatched ? "supported" : "unsupported",
              signals: { audio: "used", visual: "used", danmaku: "blocked" },
              reasons: [
                span.kind === "ambiguous"
                  ? "E2E 保留无法判断段，必须人工分类。"
                  : "E2E 逐段证据仅用于验证产品门禁。"
              ]
            },
            boundaries: { start: boundary("start"), end: boundary("end") },
            alternatives:
              span.kind === "ambiguous"
                ? [
                    {
                      kind: "ambiguous",
                      score: 0.48,
                      sourceStartMs: span.sourceStartMs,
                      sourceEndMs: span.sourceEndMs,
                      targetStartMs: span.targetStartMs,
                      targetEndMs: span.targetEndMs,
                      reason: "E2E 无法区分删减与替换。"
                    }
                  ]
                : []
          };
        };
        return {
          sourceStartMs,
          sourceEndMs,
          targetStartMs: 0,
          targetEndMs: currentIndex === 0 ? 61_000 : 60_000,
          spans:
            currentIndex === 0
              ? fourKindSpans.map(completeSpan)
              : [
                  {
                    kind: "matched",
                    sourceStartMs,
                    sourceEndMs,
                    targetStartMs: 0,
                    targetEndMs: 60_000
                  }
                ].map(completeSpan),
          quality: {
            level: currentIndex === 0 ? "blocked" : "review",
            probability: null,
            metricSource: "measured",
            coverage: currentIndex === 0 ? 0.72 : 0.96,
            uniqueContentCoverage: 0.94,
            p50ResidualMs: 35,
            p95ResidualMs: 80,
            p99ResidualMs: 120,
            maxResidualMs: 140,
            boundaryUncertaintyMs: 180,
            alternativeMargin: 0.32,
            anchorCount: 36,
            anchorRegionCount: 3,
            heldOutAnchorCount: 6,
            reasons:
              currentIndex === 0
                ? ["存在无法唯一解释的歧义区间。"]
                : ["备选路径差距偏小，需要真实 A/B 试听复核。"]
          },
          evidence: {
            types: ["audio", "visual"],
            audioAnchorCount: 24,
            visualAnchorCount: 12,
            heldOutAnchorCount: 6,
            top1Top2Margin: 0.32,
            uniqueContentCoverage: 0.94,
            repeatedContentOnly: false,
            selectedTrackReason: "国语音轨覆盖完整且残差最低。",
            alternativeTrackScores: [
              {
                sourceStreamIndex: 1,
                targetStreamIndex: 2,
                score: 0.92,
                scale: 1,
                offsetMs: -sourceStartMs,
                inlierCount: 36
              },
              {
                sourceStreamIndex: 1,
                targetStreamIndex: 3,
                score: 0.6,
                scale: 1,
                offsetMs: -sourceStartMs + 5_000,
                inlierCount: 18
              }
            ],
            notes: []
          },
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
            language: "zh",
            title: "国语"
          },
          targetStream: {
            type: "audio",
            index: 2,
            codec: "flac",
            startMs: 0,
            timelineOffsetMs: 0,
            timeBase: "1/48000",
            sampleRate: 48_000,
            channels: 6,
            frameRate: null,
            language: "zh",
            title: "正片"
          },
          sourceIdentity: mediaIdentity("a", 8_000_000_000),
          targetIdentity: mediaIdentity(String(currentIndex + 1), 7_000_000_000 + currentIndex),
          engineVersion: "alignment-v2.4",
          featureVersion: "chroma-v2",
          parametersHash: `c137-e2e-${currentIndex + 1}`
        };
      };

      const mockWindow = window as unknown as MockTauriWindow;
      let batchJobIndex = 0;
      const completedBatchJobs = new Map<string, Record<string, unknown>>();
      mockWindow.isTauri = true;
      mockWindow.__C136_DIALOG_CALLS__ = [];
      mockWindow.__C137_VERIFICATION_CALLS__ = [];
      mockWindow.__C137_PERFORMANCE_CALLS__ = [];
      mockWindow.__TAURI_INTERNALS__ = {
        invoke: async (command, args = {}) => {
          await Promise.resolve();
          if (command.includes("alignment_benchmark")) {
            mockWindow.__C137_PERFORMANCE_CALLS__.push(command);
          }
          if (command === "load_app_settings_file") {
            return JSON.stringify({
              export: { defaultDirectory: "" },
              player: { mpvPath: "C:\\tools\\mpv.exe", preferredBackend: "nativeMpv" },
              emby: { serverUrl: "", pathPrefix: "/emby", username: "" },
              alignment: {
                ffmpegPath: "C:\\tools\\ffmpeg.exe",
                windowMs: 1000,
                minGapMs: 3000,
                matchThreshold: 0.35
              }
            });
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
            if (options.title === "选择弹幕 XML") {
              return xmlPaths;
            }
            return null;
          }
          if (command === "import_bilibili_xml_files") {
            const request = (args.request ?? {}) as { paths?: string[] };
            if (
              request.paths?.length !== 1 ||
              request.paths[0]?.toLocaleLowerCase("en-US") !==
                xmlPaths[0]?.toLocaleLowerCase("en-US")
            ) {
              throw new Error("E2E 原生 XML 导入没有收到对话框选中的唯一文件。");
            }
            return {
              files: [
                {
                  fileName: "normal.xml",
                  receipt: {
                    domain: "danmaku-xml-content-receipt-v1",
                    version: 1,
                    receiptId: `xmlr-sha256:${"1".repeat(64)}`,
                    contentDigest: `sha256:${"2".repeat(64)}`,
                    sizeBytes: 287,
                    parserVersion: "bilibili-xml-native-v1",
                    inventoryDigest: `sha256:${"3".repeat(64)}`,
                    issuerKeyId: `install-sha256:${"4".repeat(32)}`,
                    signatureAlgorithm: "hmac-sha256-v1",
                    signature: "5".repeat(64)
                  },
                  items: [
                    {
                      originalIndex: 0,
                      sourceTimeMs: 1_500,
                      mode: 1,
                      fontSize: 25,
                      color: 16_777_215,
                      timestamp: 1_700_000_000,
                      pool: 0,
                      userHash: "userA",
                      rowId: "row1",
                      text: "第一条滚动弹幕",
                      rawPFields: [
                        "1.500",
                        "1",
                        "25",
                        "16777215",
                        "1700000000",
                        "0",
                        "userA",
                        "row1"
                      ]
                    },
                    {
                      originalIndex: 1,
                      sourceTimeMs: 3_250,
                      mode: 5,
                      fontSize: 30,
                      color: 65_280,
                      timestamp: 1_700_000_001,
                      pool: 0,
                      userHash: "userB",
                      rowId: "row2",
                      text: "顶部弹幕",
                      rawPFields: [
                        "3.250",
                        "5",
                        "30",
                        "65280",
                        "1700000001",
                        "0",
                        "userB",
                        "row2"
                      ]
                    },
                    {
                      originalIndex: 2,
                      sourceTimeMs: 5_000,
                      mode: 4,
                      fontSize: 28,
                      color: 255,
                      timestamp: 1_700_000_002,
                      pool: 0,
                      userHash: "userC",
                      rowId: "row3",
                      text: "底部弹幕",
                      rawPFields: [
                        "5.000",
                        "4",
                        "28",
                        "255",
                        "1700000002",
                        "0",
                        "userC",
                        "row3"
                      ]
                    }
                  ],
                  warnings: []
                }
              ]
            };
          }
          if (command === "start_audio_alignment_batch_job") {
            const request = (args.request ?? {}) as {
              pairs?: Array<{ sourceMediaId: string; targetMediaId: string }>;
            };
            const pairs = request.pairs ?? [];
            batchJobIndex += 1;
            const jobId = `c137-batch-job-${batchJobIndex}`;
            const snapshot = {
              schemaVersion: 1,
              jobId,
              status: "completed",
              progress: 1,
              message: "批量分析完成",
              totalPairCount: pairs.length,
              processedPairCount: pairs.length,
              failedPairCount: 0,
              currentPairOrdinal: null,
              pairs: pairs.map((pair, currentIndex) => ({
                pairOrdinal: currentIndex + 1,
                sourceMediaId: pair.sourceMediaId,
                targetMediaId: pair.targetMediaId,
                status: "completed",
                progress: 1,
                message: "已定位对应片段",
                proposal: {
                  anchors: [
                    {
                      id: `anchor-${currentIndex + 1}`,
                      sourceMs: currentIndex * 60_000 + 5_000,
                      targetMs: 5_000,
                      confidence: 0.94,
                      origin: "automatic"
                    }
                  ],
                  cutCandidates: [],
                  confidence: 0.9,
                  diagnostics: ["E2E 使用确定性桌面批任务结果；真实定位由 Rust 测试覆盖。"],
                  timeMap: createTimeMap(currentIndex),
                  matchRange: {
                    sourceStartMs: currentIndex * 60_000,
                    sourceEndMs: (currentIndex + 1) * 60_000,
                    targetStartMs: 0,
                    targetEndMs: currentIndex === 0 ? 61_000 : 60_000,
                    coverage: currentIndex === 0 ? 0.72 : 0.96
                  }
                },
                error: null
              })),
              error: null,
              updatedAtMs: Date.now()
            };
            completedBatchJobs.set(jobId, snapshot);
            return snapshot;
          }
          if (command === "get_audio_alignment_batch_job") {
            const jobId = typeof args.jobId === "string" ? args.jobId : "";
            return completedBatchJobs.get(jobId) ?? null;
          }
          if (command === "cancel_audio_alignment_batch_job") {
            const jobId = typeof args.jobId === "string" ? args.jobId : "";
            return completedBatchJobs.get(jobId) ?? null;
          }
          if (command === "start_mpv_sidecar") {
            throw new Error("E2E 未连接真实 mpv 与真实媒体，播放证据不得成立。");
          }
          if (
            command === "issue_manual_time_map_verification" ||
            command === "verify_manual_time_map_verification" ||
            command === "revoke_manual_time_map_verification"
          ) {
            mockWindow.__C137_VERIFICATION_CALLS__.push(command);
            throw new Error(`E2E 不允许绕过人工复核门禁：${command}`);
          }
          throw new Error(`未处理的 Tauri E2E 命令：${command}`);
        }
      };
    },
    {
      sourcePaths: ["C:\\C136\\C136-reference.mkv"],
      targetPaths: Array.from({ length: 5 }, (_, index) => `C:\\C136\\C136-E0${index + 1}.mkv`),
      xmlPaths: ["C:\\C136\\normal.xml"]
    }
  );
});

test("北极星多素材流程覆盖四类判定、真实 A/B 失败与签发阻断", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "批量导入原片素材" }).click();
  await expect(page.getByTestId("status-bar")).toContainText("已导入 5 个原片素材");
  await page.getByRole("button", { name: "批量导入 B 站参考素材" }).click();
  await expect(page.getByTestId("status-bar")).toContainText("已导入 1 个B 站参考素材");
  await expect(page.getByText("C136-E01.mkv", { exact: true })).toBeVisible();
  await expect(page.getByText("C136-E05.mkv", { exact: true })).toBeVisible();
  await expect(page.getByText("C136-reference.mkv", { exact: true })).toBeVisible();

  const importXmlButton = page.getByRole("button", { name: "导入 XML" });
  await expect(importXmlButton).toBeVisible();
  await importXmlButton.click();
  await expect(page.getByTestId("status-bar")).toContainText(
    "已受验证导入 1 个 XML，共 3 条弹幕"
  );
  await expect(page.getByText("已受验证", { exact: true })).toBeVisible();

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
    { title: "选择 B 站参考素材", multiple: true },
    { title: "选择弹幕 XML", multiple: true }
  ]);

  await page.getByLabel("normal.xml 弹幕来源视频").selectOption({ label: "C136-reference" });
  await expect(page.getByTestId("status-bar")).toContainText("已绑定 XML 来源");
  await page.getByRole("heading", { name: "原片素材", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(screenshotDir, "c137-materials-batch.png"),
    fullPage: true
  });

  await page.getByTestId("workspace-nav-matching").click();
  const matchingPanel = page.getByTestId("media-matching-panel");
  const benchmarkPanel = page.getByTestId("real-media-benchmark-panel");
  await benchmarkPanel
    .getByRole("button", { name: /高级：C137 精度基准（开发与验收）/ })
    .click();
  await benchmarkPanel
    .getByLabel("选择 C137 benchmark manifest JSON")
    .setInputFiles(resolve("fixtures", "alignment", "c137-real-media-manifest.example.json"));
  await expect(benchmarkPanel).toContainText("示例 manifest 只用于理解格式");
  await expect(benchmarkPanel).toContainText("真实 0");
  await expect(
    benchmarkPanel.getByRole("button", { name: "运行真实媒体精度基准" })
  ).toBeDisabled();
  await expect(
    benchmarkPanel.getByRole("heading", { name: "原生性能 raw evidence（工程采集）" })
  ).toBeVisible();
  await expect(benchmarkPanel).toContainText(
    "当前没有批准的 production protocol 或 trust root"
  );
  const performanceButton = benchmarkPanel.getByRole("button", {
    name: "采集工程性能原始证据"
  });
  await expect(performanceButton).toBeDisabled();
  await expect(performanceButton).toHaveAttribute(
    "title",
    "示例 manifest 只用于理解格式，禁止执行或作为精度证据。"
  );
  await expect(
    benchmarkPanel.getByRole("region", { name: "性能 raw evidence 摘要" })
  ).toHaveCount(0);
  await expect(
    benchmarkPanel.getByRole("button", { name: "下载未审批 raw evidence" })
  ).toHaveCount(0);
  const examplePerformanceCalls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __C137_PERFORMANCE_CALLS__: string[];
        }
      ).__C137_PERFORMANCE_CALLS__
  );
  expect(examplePerformanceCalls).toEqual([]);
  await benchmarkPanel.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(screenshotDir, "c137-benchmark-governance-blocked.png"),
    fullPage: true
  });
  await benchmarkPanel
    .getByRole("button", { name: /高级：C137 精度基准（开发与验收）/ })
    .click();

  await expect(matchingPanel).toContainText("将分析 1 个参考 × 5 个原片，共 5 组");
  await matchingPanel.getByRole("button", { name: "开始批量匹配" }).click();
  await expect(page.getByTestId("media-match-candidate")).toHaveCount(5);
  await expect(page.getByTestId("status-bar")).toContainText(
    "找到 5 组可能对应片段，其中 4 组建议优先复核，1 组需要额外复核"
  );
  const firstCandidate = page.getByTestId("media-match-candidate").nth(0);
  await firstCandidate.getByText("来源↔原片时间图复核").click();
  await expect(firstCandidate.getByRole("img", { name: "来源与原片双时间轴分段图" })).toBeVisible();
  const firstReview = firstCandidate.getByTestId("time-map-review");
  await expect(firstReview).toContainText(
    "候选图 · 共同内容 1 · 参考独有 1 · 原片独有 1 · 无法判断 1"
  );

  const sourceOnlyButton = firstReview.getByRole("button", { name: /第 2 段 参考独有/ });
  const sourceOnlyItem = sourceOnlyButton.locator("..");
  await expect(sourceOnlyItem.getByRole("button", { name: "参考多出" })).toBeEnabled();
  await expect(sourceOnlyItem.getByRole("button", { name: "原片多出" })).toBeDisabled();
  await expect(sourceOnlyItem.getByRole("button", { name: "版本替换" })).toBeDisabled();
  await expect(sourceOnlyItem.getByRole("button", { name: "无法判断" })).toBeEnabled();
  await expect(sourceOnlyItem).toContainText("灰色选项不会改写边界");

  const targetOnlyButton = firstReview.getByRole("button", { name: /第 3 段 原片独有/ });
  const targetOnlyItem = targetOnlyButton.locator("..");
  await expect(targetOnlyItem.getByRole("button", { name: "参考多出" })).toBeDisabled();
  await expect(targetOnlyItem.getByRole("button", { name: "原片多出" })).toBeEnabled();
  await expect(targetOnlyItem.getByRole("button", { name: "版本替换" })).toBeDisabled();

  const ambiguousButton = firstReview.getByRole("button", { name: /第 4 段 无法判断/ });
  const ambiguousItem = ambiguousButton.locator("..");
  await expect(ambiguousItem.getByRole("button", { name: "版本替换" })).toBeEnabled();
  await sourceOnlyItem.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(screenshotDir, "c137-four-kind-review.png"),
    fullPage: true
  });

  await sourceOnlyItem.getByRole("button", { name: "参考多出" }).click();
  await targetOnlyItem.getByRole("button", { name: "原片多出" }).click();
  await ambiguousItem.getByRole("button", { name: "版本替换" }).click();
  await expect(ambiguousItem).toContainText("已保存：版本替换");
  await expect(
    firstCandidate.getByRole("button", { name: "保存关系供试听复核" })
  ).toBeEnabled();

  await firstReview.getByRole("button", { name: /第 1 段 共同内容/ }).click();
  const playbackReview = firstReview.getByTestId("time-map-playback-review");
  await playbackReview.getByRole("button", { name: "打开 A/B 复核" }).click();
  await expect(playbackReview).toContainText("任一时刻只播放当前 A 或 B 的声音");
  await expect(playbackReview.getByRole("button", { name: "播放当前段" })).toBeEnabled();
  await playbackReview.getByRole("button", { name: "播放当前段" }).click();
  await expect(playbackReview.getByRole("alert")).toContainText(
    "E2E 未连接真实 mpv 与真实媒体，播放证据不得成立"
  );
  await expect(playbackReview.getByRole("button", { name: "记录本段已复核" })).toBeDisabled();
  await page.screenshot({
    path: resolve(screenshotDir, "c137-ab-review-fail-closed.png"),
    fullPage: true
  });

  const candidateCards = page.getByTestId("media-match-candidate");
  for (let index = 0; index < 5; index += 1) {
    await candidateCards
      .nth(index)
      .getByRole("button", { name: "保存关系供试听复核" })
      .click();
  }
  await expect(page.getByTestId("confirmed-media-relations")).toContainText("C136-E01");
  await expect(page.getByTestId("confirmed-media-relations")).toContainText("C136-E05");
  await expect(matchingPanel).toContainText("5 / 5 个原片已有保存关系");

  const verification = candidateCards.nth(0).getByTestId("manual-time-map-verification");
  await expect(verification).toContainText("自动匹配和保存关系都不会触发签发");
  await expect(verification).toContainText("当前不能签发");
  await expect(verification.getByRole("button", { name: "完成复核并签发" })).toBeDisabled();
  const verificationCalls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __C137_VERIFICATION_CALLS__: string[];
        }
      ).__C137_VERIFICATION_CALLS__
  );
  expect(verificationCalls).toEqual([]);
  await verification.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(screenshotDir, "c137-manual-signing-fail-closed.png"),
    fullPage: true
  });

  await page.getByTestId("workspace-nav-export").click();
  const projectionExport = page.getByRole("region", { name: "按原片分集导出" });
  await expect(projectionExport).toContainText("可导出分集");
  await expect(projectionExport).toContainText("0 个");
  await expect(projectionExport).toContainText("不能导出");
  await expect(
    projectionExport.getByRole("button", { name: "导出全部分集 XML" })
  ).toBeDisabled();
  await projectionExport.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(screenshotDir, "c137-export-gate-blocked.png"),
    fullPage: true
  });
});

test("浏览器预览中的原生性能证据入口失败关闭", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    Reflect.set(window, "isTauri", false);
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  await page.getByTestId("workspace-nav-matching").click();
  const benchmarkPanel = page.getByTestId("real-media-benchmark-panel");
  await benchmarkPanel
    .getByRole("button", { name: /高级：C137 精度基准（开发与验收）/ })
    .click();

  await expect(
    benchmarkPanel.getByRole("heading", { name: "原生性能 raw evidence（工程采集）" })
  ).toBeVisible();
  await expect(benchmarkPanel).toContainText(
    "浏览器预览不能运行真实媒体基准；请在 Tauri 桌面端打开同一份清单。"
  );
  const performanceButton = benchmarkPanel.getByRole("button", {
    name: "采集工程性能原始证据"
  });
  await expect(performanceButton).toBeDisabled();
  await expect(performanceButton).toHaveAttribute(
    "title",
    "浏览器预览不能运行真实媒体基准；请在 Tauri 桌面端打开同一份清单。"
  );
  await expect(
    benchmarkPanel.getByRole("region", { name: "性能 raw evidence 摘要" })
  ).toHaveCount(0);
  await expect(
    benchmarkPanel.getByRole("button", { name: "下载未审批 raw evidence" })
  ).toHaveCount(0);
  const browserPerformanceCalls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __C137_PERFORMANCE_CALLS__: string[];
        }
      ).__C137_PERFORMANCE_CALLS__
  );
  expect(browserPerformanceCalls).toEqual([]);
});
