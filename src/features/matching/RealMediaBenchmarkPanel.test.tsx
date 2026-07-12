import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateRealMediaBenchmark,
  type RealMediaBenchmarkGold,
  type RealMediaBenchmarkManifest
} from "../../domain/alignment/realMediaBenchmark";
import {
  REAL_MEDIA_BENCHMARK_RUNNER_VERSION,
  type RealMediaBenchmarkCaseRunResult,
  type RealMediaBenchmarkRunReport
} from "../../infrastructure/alignment/realMediaBenchmarkRunner";
import {
  RealMediaBenchmarkPanel,
  type RealMediaBenchmarkPanelRunner
} from "./RealMediaBenchmarkPanel";

let restoreObjectUrls: (() => void) | null = null;

afterEach(() => {
  restoreObjectUrls?.();
  restoreObjectUrls = null;
  cleanup();
  vi.restoreAllMocks();
});

describe("C137 真实媒体 benchmark 面板", () => {
  it("默认折叠，并可用键盘展开到只选择 manifest 的空态", async () => {
    const user = userEvent.setup();
    render(<RealMediaBenchmarkPanel desktopAvailable={false} />);
    const toggle = screen.getByRole("button", {
      name: /高级：C137 精度基准（开发与验收）/
    });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByLabelText("选择 C137 benchmark manifest JSON")
    ).not.toBeInTheDocument();
    toggle.focus();
    await user.keyboard("{Enter}");

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/尚未选择清单/)).toBeInTheDocument();
    expect(screen.getByLabelText("选择 C137 benchmark manifest JSON")).toHaveAttribute(
      "accept",
      ".json,application/json"
    );
    expect(screen.getByText(/不会再次选择视频，也不会写入当前项目/)).toBeInTheDocument();
    expect(screen.getByText(/浏览器预览不能运行真实媒体基准/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行真实媒体精度基准" })).toBeDisabled();
  });

  it("无效 JSON fail-closed，显示原因且不调用 runner", async () => {
    const user = userEvent.setup();
    const runner = vi.fn<RealMediaBenchmarkPanelRunner>();
    render(<RealMediaBenchmarkPanel desktopAvailable runner={runner} />);
    await openPanel(user);

    await user.upload(
      screen.getByLabelText("选择 C137 benchmark manifest JSON"),
      new File(["{not-json"], "broken.json", { type: "application/json" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取清单");
    expect(screen.queryByLabelText("清单治理摘要")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行真实媒体精度基准" })).toBeDisabled();
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "浏览器",
      desktopAvailable: false,
      manifest: createRealManifest(1),
      messages: ["浏览器预览不能运行真实媒体基准"]
    },
    {
      name: "示例清单",
      desktopAvailable: true,
      manifest: createNonRealManifest(true),
      messages: ["示例 manifest 只用于理解格式", "0 个 mediaKind=real"]
    },
    {
      name: "零真实关系",
      desktopAvailable: true,
      manifest: createNonRealManifest(false),
      messages: ["0 个 mediaKind=real"]
    }
  ])("$name 明确阻断运行并保留治理摘要", async ({ desktopAvailable, manifest, messages }) => {
    const user = userEvent.setup();
    const runner = vi.fn<RealMediaBenchmarkPanelRunner>();
    render(<RealMediaBenchmarkPanel desktopAvailable={desktopAvailable} runner={runner} />);
    await openPanel(user);
    await uploadManifest(user, manifest);

    const summary = await screen.findByLabelText("清单治理摘要");
    expect(summary).toHaveTextContent(
      `共 ${manifest.cases.length}，真实 0`.replace(
        "真实 0",
        `真实 ${manifest.cases.filter((item) => item.mediaKind === "real").length}`
      )
    );
    for (const message of messages)
      expect(screen.getByText(new RegExp(message))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行真实媒体精度基准" })).toBeDisabled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("runner 异常会去除本地路径和身份摘要，并恢复可重试状态", async () => {
    const user = userEvent.setup();
    const manifest = createRealManifest(1);
    const source = manifest.cases[0]?.source;
    if (!source?.contentIdentity) throw new Error("异常去敏测试缺少媒体身份");
    const runner = vi.fn<RealMediaBenchmarkPanelRunner>(() =>
      Promise.reject(
        new Error(`无法分析 ${source.path}，摘要 ${source.contentIdentity?.digest}`)
      )
    );
    render(<RealMediaBenchmarkPanel desktopAvailable runner={runner} />);
    await openPanel(user);
    await uploadManifest(user, manifest);
    await user.click(await screen.findByRole("button", { name: "运行真实媒体精度基准" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("运行失败");
    expect(alert).toHaveTextContent("[已隐藏本地媒体]");
    expect(alert).not.toHaveTextContent(source.path);
    expect(alert).not.toHaveTextContent(source.contentIdentity.digest);
    expect(screen.getByRole("button", { name: "运行真实媒体精度基准" })).toBeEnabled();
  });

  it("取消会中止注入 runner，并等待其返回可审计的 cancelled 报告", async () => {
    const user = userEvent.setup();
    const manifest = createRealManifest(1);
    let signal: AbortSignal | undefined;
    let resolveRun: ((report: RealMediaBenchmarkRunReport) => void) | undefined;
    const runner = vi.fn<RealMediaBenchmarkPanelRunner>((_manifest, options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    });
    render(<RealMediaBenchmarkPanel desktopAvailable runner={runner} />);
    await openPanel(user);
    await uploadManifest(user, manifest);
    await user.click(await screen.findByRole("button", { name: "运行真实媒体精度基准" }));
    await user.click(await screen.findByRole("button", { name: "取消基准运行" }));

    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("等待活动分析任务安全退出");
    act(() => {
      resolveRun?.(createCancelledReport(manifest));
    });

    const report = await screen.findByLabelText("C137 真实媒体运行报告");
    expect(report).toHaveTextContent("运行报告：已取消");
    expect(report).toHaveTextContent("成功 0 · 失败 0 · 已取消 1");
    expect(report).toHaveTextContent("没有生成部分或推测性的组件质量结论");
  });

  it("显示 preflight 失败和 case 失败，不生成部分组件结论", async () => {
    const user = userEvent.setup();
    const manifest = createRealManifest(1);
    const runner = vi.fn<RealMediaBenchmarkPanelRunner>(() =>
      Promise.resolve(createPreflightFailedReport(manifest))
    );
    render(<RealMediaBenchmarkPanel desktopAvailable runner={runner} />);
    await openPanel(user);
    await uploadManifest(user, manifest);
    await user.click(await screen.findByRole("button", { name: "运行真实媒体精度基准" }));

    const report = await screen.findByLabelText("C137 真实媒体运行报告");
    expect(within(report).getByLabelText("媒体身份预检结果")).toHaveTextContent(
      "未通过 · 真实关系 1 · 已检查文件 2"
    );
    expect(report).toHaveTextContent("当前文件身份不一致");
    expect(report).toHaveTextContent("成功 0 · 失败 1 · 已取消 0");
    expect(report).toHaveTextContent(`${manifest.cases[0]?.id} · 失败`);
    expect(report).toHaveTextContent("没有生成部分或推测性的组件质量结论");
  });

  it("完成后显示组件子闸门与 release 限界，并下载不含路径和摘要的稳定报告", async () => {
    const user = userEvent.setup();
    const manifest = createRealManifest(1);
    const report = createCompletedReport(manifest);
    const runner = vi.fn<RealMediaBenchmarkPanelRunner>(() => Promise.resolve(report));
    let downloadedBlob: Blob | null = null;
    let downloadedName = "";
    restoreObjectUrls = installObjectUrlMocks((blob) => {
      downloadedBlob = blob;
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      downloadedName = this.download;
    });
    render(<RealMediaBenchmarkPanel desktopAvailable runner={runner} />);
    await openPanel(user);
    await uploadManifest(user, manifest);
    await user.click(await screen.findByRole("button", { name: "运行真实媒体精度基准" }));

    const reportView = await screen.findByLabelText("C137 真实媒体运行报告");
    expect(reportView).toHaveTextContent("媒体身份预检");
    expect(reportView).toHaveTextContent("成功 1 · 失败 0 · 已取消 0");
    expect(within(reportView).getByLabelText("TimeMap 组件子闸门")).toHaveTextContent(
      "状态：真实数据不足"
    );
    expect(reportView).toHaveTextContent("releaseEligible=false，绝不代表 release 通过");

    await user.click(screen.getByRole("button", { name: "下载去敏稳定报告" }));
    expect(downloadedName).toBe("c137-ui-manifest-ui-dataset-1-time-map-report.json");
    if (!downloadedBlob) throw new Error("下载测试没有捕获报告 Blob");
    const text = await readBlobText(downloadedBlob);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"releaseEligible": false');
    for (const secret of collectManifestSecrets(manifest)) expect(text).not.toContain(secret);
    expect(screen.getByRole("status")).toHaveTextContent("已下载去敏报告");
  });
});

async function openPanel(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: /高级：C137 精度基准（开发与验收）/ }));
}

async function uploadManifest(
  user: ReturnType<typeof userEvent.setup>,
  manifest: RealMediaBenchmarkManifest
): Promise<void> {
  await user.upload(
    screen.getByLabelText("选择 C137 benchmark manifest JSON"),
    new File([JSON.stringify(manifest)], "governed-manifest.json", {
      type: "application/json"
    })
  );
  await screen.findByLabelText("清单治理摘要");
}

function createRealManifest(count: number): RealMediaBenchmarkManifest {
  return {
    schemaVersion: 2,
    id: "ui-manifest",
    name: "UI 真实媒体清单",
    datasetVersion: "ui-dataset-1",
    description: "仅用于 UI 入口测试，不代表 release 精度。",
    isExample: false,
    licenseNotes: ["本地合法测试素材。"],
    cases: Array.from({ length: count }, (_, index) => createRealCase(index))
  };
}

function createNonRealManifest(isExample: boolean): RealMediaBenchmarkManifest {
  const benchmarkCase = createRealCase(0);
  return {
    ...createRealManifest(0),
    id: isExample ? "ui-example" : "ui-zero-real",
    isExample,
    cases: [
      {
        ...benchmarkCase,
        mediaKind: "placeholder",
        source: { ...benchmarkCase.source, contentIdentity: null },
        target: { ...benchmarkCase.target, contentIdentity: null },
        independentAnnotations: [],
        adjudication: null
      }
    ]
  };
}

function createRealCase(index: number): RealMediaBenchmarkManifest["cases"][number] {
  const gold = createGold();
  const sourceDigest = (index + 1).toString(16).repeat(64);
  const targetDigest = (index + 9).toString(16).repeat(64);
  return {
    id: `ui-real-${index + 1}`,
    title: `真实关系 ${index + 1}`,
    mediaKind: "real",
    split: "frozen-test",
    scenarios: ["global-offset"],
    source: {
      path: `C:\\private-c137\\source-${index + 1}.mkv`,
      audioStreamIndex: 1,
      videoStreamIndex: 0,
      contentIdentity: {
        algorithm: "sha256-full-file-v2",
        sizeBytes: 1_000 + index,
        digest: sourceDigest
      },
      versionNote: "固定参考版本。",
      licenseNote: "本地合法测试素材。"
    },
    target: {
      path: `C:\\private-c137\\target-${index + 1}.mkv`,
      audioStreamIndex: 2,
      videoStreamIndex: 0,
      contentIdentity: {
        algorithm: "sha256-full-file-v2",
        sizeBytes: 2_000 + index,
        digest: targetDigest
      },
      versionNote: "固定原片版本。",
      licenseNote: "本地合法测试素材。"
    },
    boundaryToleranceMs: 100,
    versionNotes: ["冻结测试版本。"],
    licenseNotes: ["本地合法测试素材。"],
    independentAnnotations: [
      { reviewerId: `reviewer-a-${index}`, gold: cloneGold(gold) },
      { reviewerId: `reviewer-b-${index}`, gold: cloneGold(gold) }
    ],
    adjudication: {
      status: "not-needed",
      adjudicatorId: null,
      note: "两份独立标注一致。"
    },
    gold
  };
}

function createGold(): RealMediaBenchmarkGold {
  return {
    sourceStartMs: 0,
    sourceEndMs: 10_000,
    targetStartMs: 0,
    targetEndMs: 10_000,
    matchedAnchors: Array.from({ length: 5 }, (_, index) => ({
      id: `anchor-${index}`,
      sourceMs: index * 2_000,
      targetMs: index * 2_000
    })),
    sourceOnlySpans: [],
    targetOnlySpans: [],
    ambiguousSpans: []
  };
}

function cloneGold(gold: RealMediaBenchmarkGold): RealMediaBenchmarkGold {
  return JSON.parse(JSON.stringify(gold)) as RealMediaBenchmarkGold;
}

function createCompletedReport(
  manifest: RealMediaBenchmarkManifest
): RealMediaBenchmarkRunReport {
  const benchmarkCase = manifest.cases[0];
  if (!benchmarkCase) throw new Error("完成报告测试缺少 case");
  const evaluation = evaluateRealMediaBenchmark(manifest, [
    {
      caseId: benchmarkCase.id,
      spans: [
        {
          kind: "matched",
          sourceStartMs: 0,
          sourceEndMs: 10_000,
          targetStartMs: 0,
          targetEndMs: 10_000
        }
      ]
    }
  ]);
  return createReport(manifest, {
    status: "completed",
    cases: [createCaseRunResult(benchmarkCase.id, "success")],
    evaluation,
    reasons: ["全部真实关系完成组件级评估；不代表 release 通过。"]
  });
}

function createCancelledReport(
  manifest: RealMediaBenchmarkManifest
): RealMediaBenchmarkRunReport {
  const caseId = manifest.cases[0]?.id ?? "cancelled-case";
  return createReport(manifest, {
    status: "cancelled",
    cases: [createCaseRunResult(caseId, "cancelled")],
    evaluation: null,
    reasons: ["运行被取消；没有生成部分质量结论。"]
  });
}

function createPreflightFailedReport(
  manifest: RealMediaBenchmarkManifest
): RealMediaBenchmarkRunReport {
  const caseId = manifest.cases[0]?.id ?? "failed-case";
  return createReport(
    manifest,
    {
      status: "preflight-failed",
      cases: [createCaseRunResult(caseId, "failed", "preflight-failed")],
      evaluation: null,
      reasons: ["预检失败，未启动生产分析。"]
    },
    {
      ok: false,
      realRelationCount: 1,
      checkedFileCount: 2,
      issues: [
        {
          caseId,
          side: "source",
          code: "identity-mismatch",
          message: "当前文件身份不一致。"
        }
      ]
    }
  );
}

function createReport(
  manifest: RealMediaBenchmarkManifest,
  input: Pick<RealMediaBenchmarkRunReport, "status" | "cases" | "evaluation" | "reasons">,
  preflight: RealMediaBenchmarkRunReport["preflight"] = {
    ok: true,
    realRelationCount: manifest.cases.filter((item) => item.mediaKind === "real").length,
    checkedFileCount: manifest.cases.length * 2,
    issues: []
  }
): RealMediaBenchmarkRunReport {
  return {
    schemaVersion: 1,
    reportKind: "c137-real-media-benchmark-run",
    scope: "time-map-component",
    releaseEligible: false,
    runnerVersion: REAL_MEDIA_BENCHMARK_RUNNER_VERSION,
    manifestId: manifest.id,
    datasetVersion: manifest.datasetVersion,
    runManifestDigest: `sha256:${"0".repeat(64)}`,
    wallElapsedMs: 1_500,
    skippedNonRealCaseCount: manifest.cases.filter((item) => item.mediaKind !== "real").length,
    preflight,
    ...input
  };
}

function createCaseRunResult(
  caseId: string,
  status: RealMediaBenchmarkCaseRunResult["status"],
  failureCode: NonNullable<RealMediaBenchmarkCaseRunResult["failure"]>["code"] = "run-cancelled"
): RealMediaBenchmarkCaseRunResult {
  const success = status === "success";
  return {
    caseId,
    status,
    wallElapsedMs: 1_000,
    engineVersion: success ? "alignment-v2-ui-test" : null,
    featureVersion: success ? "feature-v2-ui-test" : null,
    qualityLevel: success ? "review" : null,
    sourceVisualStreamIndex: null,
    targetVisualStreamIndex: null,
    parameters: {
      localizationMode: true,
      sampleRate: null,
      windowMs: 1_000,
      matchThreshold: 0.35,
      minGapMs: 3_000,
      maxCells: null,
      enableVisualEvidence: false,
      visualSampleIntervalMs: null,
      sourceAudioStreamIndex: 1,
      targetAudioStreamIndex: 2,
      sourceVideoStreamIndex: 0,
      targetVideoStreamIndex: 0
    },
    failure: success
      ? null
      : {
          code: failureCode,
          message: status === "cancelled" ? "用户取消了真实媒体运行。" : "预检阻断了生产分析。"
        }
  };
}

function collectManifestSecrets(manifest: RealMediaBenchmarkManifest): string[] {
  return manifest.cases
    .flatMap((benchmarkCase) =>
      [benchmarkCase.source, benchmarkCase.target].flatMap((media) => [
        media.path,
        media.contentIdentity?.digest ?? ""
      ])
    )
    .filter(Boolean);
}

function readBlobText(blob: Blob): Promise<string> {
  const modernBlob = blob as Blob & { text?: () => Promise<string> };
  if (typeof modernBlob.text === "function") return modernBlob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Blob 读取结果不是文本"));
    reader.onerror = () => reject(new Error("Blob 读取失败"));
    reader.readAsText(blob);
  });
}

function installObjectUrlMocks(onCreate: (blob: Blob) => void): () => void {
  const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const createObjectUrl = vi.fn<typeof URL.createObjectURL>((object) => {
    if (!(object instanceof Blob)) throw new Error("下载对象不是 Blob");
    onCreate(object);
    return "blob:c137-report";
  });
  const revokeObjectUrl = vi.fn<typeof URL.revokeObjectURL>();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectUrl
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectUrl
  });
  return () => {
    if (createDescriptor) {
      Object.defineProperty(URL, "createObjectURL", createDescriptor);
    } else {
      Reflect.deleteProperty(URL, "createObjectURL");
    }
    if (revokeDescriptor) {
      Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
    } else {
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  };
}
