import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateRealMediaBenchmark,
  type RealMediaBenchmarkGold,
  type RealMediaBenchmarkManifest
} from "../../domain/alignment/realMediaBenchmark";
import {
  createRealMediaGoldBenchmarkBundle,
  serializeRealMediaGoldBenchmarkBundle
} from "../../domain/alignment/realMediaGoldBenchmarkBundle";
import {
  createRealMediaGoldDevelopmentDataset,
  parseRealMediaGoldDevelopmentDatasetJson,
  serializeRealMediaGoldDevelopmentDataset
} from "../../domain/alignment/realMediaGoldDevelopmentDataset";
import {
  createRealMediaGoldAnnotationEnvelope,
  freezeRealMediaGoldCase,
  type RealMediaGoldReviewVerification
} from "../../domain/alignment/realMediaGoldGovernance";
import {
  computeC137PerformanceEvidenceDigestV2,
  computeC137PerformanceEnvironmentDigestV2,
  computeC137PerformanceWorkloadStorageReceiptDigest,
  createC137PerformancePlanDigest,
  type C137PerformanceRawEvidenceV1,
  type C137PerformanceRawEvidenceV2
} from "../../domain/alignment/c137PerformanceEvidence";
import {
  createCompleteC137PerformanceEvidenceFixture,
  createCompleteC137PerformanceEvidenceV2Fixture
} from "../../test/c137PerformanceEvidence";
import { createRealMediaPerformanceWorkloadDigest } from "../../infrastructure/alignment/realMediaPerformanceRunner";
import {
  DEFAULT_APP_SETTINGS,
  saveAppSettings
} from "../../infrastructure/settings/appSettings";
import {
  REAL_MEDIA_BENCHMARK_RUNNER_VERSION,
  createRealMediaBenchmarkRunManifestDigest,
  projectRealMediaBenchmarkRunManifest,
  type RealMediaBenchmarkCaseRunResult,
  type RealMediaBenchmarkRunReport
} from "../../infrastructure/alignment/realMediaBenchmarkRunner";
import {
  RealMediaBenchmarkPanel,
  type RealMediaBenchmarkPanelRunner,
  type RealMediaPerformancePanelRunner
} from "./RealMediaBenchmarkPanel";

let restoreObjectUrls: (() => void) | null = null;

afterEach(() => {
  restoreObjectUrls?.();
  restoreObjectUrls = null;
  cleanup();
  window.localStorage.clear();
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
    const goldToggle = screen.getByRole("button", {
      name: /建立真实 Gold：双人独立标注与冻结/
    });
    await user.click(goldToggle);
    expect(
      screen.getByText(/这里不会重新选择视频。标注始终绑定素材页已导入路径/)
    ).toBeInTheDocument();
    expect(screen.getByText(/当前没有已确认且仍连接本地媒体的时间关系/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载独立标注 JSON" })).toBeDisabled();
    expect(screen.getByText(/浏览器预览不能运行真实媒体基准/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行真实媒体精度基准" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "采集工程性能原始证据" })).toBeDisabled();
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

  it("精度与性能入口都从持久设置传递声谱计算策略", async () => {
    const user = userEvent.setup();
    const manifest = createRealManifest(1);
    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      alignment: {
        ...DEFAULT_APP_SETTINGS.alignment,
        spectralBackend: "cuda"
      }
    });
    const runner = vi.fn<RealMediaBenchmarkPanelRunner>((input, options) =>
      Promise.resolve(createCompletedReport(input, options.spectralBackend ?? "auto"))
    );
    const performanceRunner = vi.fn<RealMediaPerformancePanelRunner>((input, options) =>
      Promise.resolve(
        bindPerformanceEvidenceToManifest(input, options.spectralBackend ?? "auto")
      )
    );
    render(
      <RealMediaBenchmarkPanel
        desktopAvailable
        runner={runner}
        performanceRunner={performanceRunner}
      />
    );
    await openPanel(user);
    await uploadManifest(user, manifest);

    await user.click(screen.getByRole("button", { name: "运行真实媒体精度基准" }));
    await screen.findByLabelText("C137 真实媒体运行报告");
    expect(runner.mock.calls[0]?.[1].spectralBackend).toBe("cuda");

    await user.click(screen.getByRole("button", { name: "采集工程性能原始证据" }));
    await screen.findByLabelText("性能 raw evidence 摘要");
    expect(performanceRunner.mock.calls[0]?.[1].spectralBackend).toBe("cuda");
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
    const performanceRunner = vi.fn<RealMediaPerformancePanelRunner>();
    render(
      <RealMediaBenchmarkPanel
        desktopAvailable={desktopAvailable}
        runner={runner}
        performanceRunner={performanceRunner}
      />
    );
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
    expect(screen.getByRole("button", { name: "采集工程性能原始证据" })).toBeDisabled();
    expect(runner).not.toHaveBeenCalled();
    expect(performanceRunner).not.toHaveBeenCalled();
  });

  it("raw manifest 不能绕过 formal frozen-test authority 门禁", async () => {
    const user = userEvent.setup();
    const manifest = createRealManifest(1);
    if (!manifest.cases[0]) throw new Error("冻结阻断测试缺少 case。");
    manifest.cases[0].split = "frozen-test";
    const runner = vi.fn<RealMediaBenchmarkPanelRunner>();
    render(<RealMediaBenchmarkPanel desktopAvailable runner={runner} />);
    await openPanel(user);
    await uploadManifest(user, manifest);

    expect(
      screen.getByText(/formal frozen-test 仍缺外部签名与撤销 authority/)
    ).toBeInTheDocument();
    expect(screen.getByText(/raw development manifest/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行真实媒体精度基准" })).toBeDisabled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("完整治理 bundle 验证 receipt 后允许运行 development", async () => {
    const user = userEvent.setup();
    const bundle = createGovernedBundle();
    render(<RealMediaBenchmarkPanel desktopAvailable />);
    await openPanel(user);
    await user.upload(
      screen.getByLabelText("选择 C137 benchmark manifest JSON"),
      new File([serializeRealMediaGoldBenchmarkBundle(bundle)], "governed-bundle.json", {
        type: "application/json"
      })
    );

    const summary = await screen.findByLabelText("清单治理摘要");
    expect(summary).toHaveTextContent("完整治理 bundle（内部自洽，非发布授权）");
    expect(summary).toHaveTextContent(bundle.bundleDigest);
    expect(
      screen.queryByText(/formal frozen-test 仍缺外部签名与撤销 authority/)
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行真实媒体精度基准" })).toBeEnabled();
  });

  it("可多选单 case bundle，生成确定的 development 数据集并直接载入运行入口", async () => {
    const user = userEvent.setup();
    const first = createGovernedBundle("development", 0);
    const second = createGovernedBundle("development", 1);
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
    render(<RealMediaBenchmarkPanel desktopAvailable />);
    await openPanel(user);
    await user.click(
      screen.getByRole("button", { name: /合并多个已复核 case（development）/ })
    );

    const multiInput = screen.getByLabelText("选择多个单 case 治理 bundle");
    expect(multiInput).toHaveAttribute("multiple");
    await user.upload(multiInput, [
      new File([serializeRealMediaGoldBenchmarkBundle(first)], "case-one.json", {
        type: "application/json"
      }),
      new File([serializeRealMediaGoldBenchmarkBundle(second)], "case-two.json", {
        type: "application/json"
      })
    ]);

    const coverage = await screen.findByLabelText("合并覆盖摘要");
    expect(coverage).toHaveTextContent("可生成：2 个 development case");
    expect(coverage).toHaveTextContent("源 2 / 目标 2");
    await user.click(screen.getByRole("button", { name: "下载多 case development 数据集" }));
    expect(downloadedName).toBe(
      "c137-local-reviewed-development-development-v1-development-dataset.json"
    );
    if (!downloadedBlob) throw new Error("下载测试没有捕获 development dataset Blob");
    const downloadedText = await readBlobText(downloadedBlob);
    const dataset = parseRealMediaGoldDevelopmentDatasetJson(downloadedText);
    expect(dataset.manifest.cases).toHaveLength(2);
    expect(dataset.releaseEligible).toBe(false);

    await user.upload(
      screen.getByLabelText("选择 C137 benchmark manifest JSON"),
      new File([downloadedText], "development-dataset.json", {
        type: "application/json"
      })
    );
    const summary = await screen.findByLabelText("清单治理摘要");
    expect(summary).toHaveTextContent("多 case development 治理包（内部自洽，非发布授权）");
    expect(summary).toHaveTextContent(dataset.datasetDigest);
    expect(summary).toHaveTextContent("共 2，真实 2");
    expect(screen.getByRole("button", { name: "运行真实媒体精度基准" })).toBeEnabled();
  });

  it("可直接载入由领域层创建的多 case development 数据集", async () => {
    const user = userEvent.setup();
    const dataset = createRealMediaGoldDevelopmentDataset({
      metadata: {
        id: "direct-development",
        name: "直接载入 development 数据集",
        datasetVersion: "v1",
        description: "UI loader 测试。",
        licenseNotes: ["本机授权。"]
      },
      bundles: [createGovernedBundle("development", 0), createGovernedBundle("development", 1)]
    });
    render(<RealMediaBenchmarkPanel desktopAvailable />);
    await openPanel(user);
    await user.upload(
      screen.getByLabelText("选择 C137 benchmark manifest JSON"),
      new File([serializeRealMediaGoldDevelopmentDataset(dataset)], "direct-development.json", {
        type: "application/json"
      })
    );

    const summary = await screen.findByLabelText("清单治理摘要");
    expect(summary).toHaveTextContent(dataset.datasetDigest);
    expect(summary).toHaveTextContent("多 case development 治理包");
  });

  it("本机自洽 bundle 也不能把 formal frozen-test 提升为可运行", async () => {
    const user = userEvent.setup();
    const bundle = createGovernedBundle("frozen-test");
    render(<RealMediaBenchmarkPanel desktopAvailable />);
    await openPanel(user);
    await user.upload(
      screen.getByLabelText("选择 C137 benchmark manifest JSON"),
      new File([serializeRealMediaGoldBenchmarkBundle(bundle)], "local-frozen-bundle.json", {
        type: "application/json"
      })
    );

    expect(
      await screen.findByText(/formal frozen-test 仍缺外部签名与撤销 authority/)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行真实媒体精度基准" })).toBeDisabled();
  });

  it("runner 异常会去除本地路径和身份摘要，并恢复可重试状态", async () => {
    const user = userEvent.setup();
    const manifest = createRealManifest(1);
    const source = manifest.cases[0]?.source;
    if (!source?.contentIdentity) throw new Error("异常去敏测试缺少媒体身份");
    const equivalentForwardPath = source.path.replace(/\\/gu, "/").toUpperCase();
    const runner = vi.fn<RealMediaBenchmarkPanelRunner>(() =>
      Promise.reject(
        new Error(
          `无法分析 //?/${equivalentForwardPath}，摘要 ${source.contentIdentity?.digest}`
        )
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
    expect(alert).not.toHaveTextContent(equivalentForwardPath);
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

  it("完成后显示组件子闸门与 release 限界，并提示稳定摘要仍可关联运行", async () => {
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

    expect(screen.getByText(/清单标识与稳定摘要/)).toHaveTextContent(
      "清单标识与稳定摘要仍可能关联同一数据集或多次运行"
    );
    await user.click(
      screen.getByRole("button", { name: "下载已移除路径与单媒体哈希的稳定报告" })
    );
    expect(downloadedName).toBe("c137-ui-manifest-ui-dataset-1-time-map-report.json");
    if (!downloadedBlob) throw new Error("下载测试没有捕获报告 Blob");
    const text = await readBlobText(downloadedBlob);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"releaseEligible": false');
    for (const secret of collectManifestSecrets(manifest)) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(JSON.stringify(secret).slice(1, -1));
    }
    expect(screen.getByRole("status")).toHaveTextContent(
      "已下载已移除本地路径与单媒体内容哈希的稳定报告"
    );
  });

  it("合法报告字符串字段含 JSON 转义的 Windows 路径时仍阻止展示与下载", async () => {
    const user = userEvent.setup();
    const manifest = createRealManifest(1);
    const sourcePath = manifest.cases[0]?.source.path;
    if (!sourcePath) throw new Error("路径泄漏测试缺少参考媒体路径");
    const report = createCompletedReport(manifest);
    report.reasons = [`合法字符串字段意外回显 ${sourcePath}`];
    const runner = vi.fn<RealMediaBenchmarkPanelRunner>(() => Promise.resolve(report));
    render(<RealMediaBenchmarkPanel desktopAvailable runner={runner} />);
    await openPanel(user);
    await uploadManifest(user, manifest);

    await user.click(screen.getByRole("button", { name: "运行真实媒体精度基准" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("报告仍含本地媒体路径或身份摘要，已阻止下载");
    expect(alert).not.toHaveTextContent(sourcePath);
    expect(screen.queryByLabelText("C137 真实媒体运行报告")).not.toBeInTheDocument();
  });

  it("拒绝复用相同 ID/version 但 blind workload 摘要属于另一清单的报告", async () => {
    const user = userEvent.setup();
    const manifest = createRealManifest(1);
    const otherManifest = structuredClone(manifest);
    otherManifest.cases[0].source.path = "C:\\private-benchmark\\other-source.mkv";
    const runner = vi.fn<RealMediaBenchmarkPanelRunner>(() =>
      Promise.resolve(createCompletedReport(otherManifest))
    );
    render(<RealMediaBenchmarkPanel desktopAvailable runner={runner} />);
    await openPanel(user);
    await uploadManifest(user, manifest);
    await user.click(await screen.findByRole("button", { name: "运行真实媒体精度基准" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("blind workload 摘要不一致");
    expect(screen.queryByLabelText("C137 真实媒体运行报告")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "下载已移除路径与单媒体哈希的稳定报告"
      })
    ).not.toBeInTheDocument();
  });

  it("性能 raw evidence 与当前 manifest 绑定后才展示并下载去敏文件", async () => {
    const user = userEvent.setup();
    const manifest = createRealManifest(1);
    const evidence = bindPerformanceEvidenceToManifest(manifest);
    const performanceRunner = vi.fn<RealMediaPerformancePanelRunner>(() =>
      Promise.resolve(evidence)
    );
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
    render(<RealMediaBenchmarkPanel desktopAvailable performanceRunner={performanceRunner} />);
    await openPanel(user);
    await uploadManifest(user, manifest);
    await user.click(await screen.findByRole("button", { name: "采集工程性能原始证据" }));

    const summary = await screen.findByLabelText("性能 raw evidence 摘要");
    expect(screen.getByText(/runManifestDigest、mediaSetDigest/)).toHaveTextContent(
      "稳定摘要也可能关联同一数据集或多次运行"
    );
    expect(screen.getByText(/CPU、操作系统、内存/)).toHaveTextContent(
      "CPU、操作系统、内存、工具二进制摘要与运行标识"
    );
    expect(summary).toHaveTextContent(
      "工程采集记录结构完整；正式证据链仍未完成，不能进入正式验收"
    );
    expect(
      within(summary).getByText("工程采集记录结构完整；正式证据链仍未完成，不能进入正式验收。")
    ).toHaveClass("text-amber-100");
    expect(summary).toHaveTextContent("Windows · 4 物理核");
    expect(summary).toHaveTextContent("ToolHelp（工程）");
    expect(summary).toHaveTextContent("实际媒体卷（1 卷）");
    expect(summary).toHaveTextContent("实际媒体卷收据已由 native v2 采集并闭合");
    expect(summary).toHaveTextContent("正式性能验收仍要求 Job Object");
    expect(summary).toHaveTextContent("1.00 GiB");
    expect(summary).toHaveTextContent("1 次 · 最大 100ms");
    expect(summary).toHaveTextContent("任务收尾：缺少终态清理凭证");
    expect(screen.getByText(/releaseEligible=false/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "下载未审批 raw evidence" }));
    expect(downloadedName).toBe("c137-performance-plan-fixture-000001.json");
    if (!downloadedBlob) throw new Error("下载测试没有捕获性能 evidence Blob");
    const text = await readBlobText(downloadedBlob);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"reportKind":"c137-performance-raw-evidence"');
    expect(text).toContain('"releaseEligible":false');
    expect(text).toContain('"trustStatus":"untrusted-raw-evidence"');
    for (const secret of collectManifestSecrets(manifest)) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(JSON.stringify(secret).slice(1, -1));
    }
    expect(screen.getByRole("status")).toHaveTextContent("已下载未审批 raw evidence");
  });

  it("拒绝工作负载摘要不属于当前 manifest 的有效 raw evidence", async () => {
    const user = userEvent.setup();
    const manifest = createRealManifest(1);
    const performanceRunner = vi.fn<RealMediaPerformancePanelRunner>(() =>
      Promise.resolve(createCompleteC137PerformanceEvidenceFixture())
    );
    render(<RealMediaBenchmarkPanel desktopAvailable performanceRunner={performanceRunner} />);
    await openPanel(user);
    await uploadManifest(user, manifest);
    await user.click(await screen.findByRole("button", { name: "采集工程性能原始证据" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "raw evidence 工作负载摘要与当前 manifest 不一致"
    );
    expect(screen.queryByLabelText("性能 raw evidence 摘要")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "下载未审批 raw evidence" })
    ).not.toBeInTheDocument();
  });

  it("拒绝计划 case 数与当前 manifest 真实关系数不一致的 raw evidence", async () => {
    const user = userEvent.setup();
    const manifest = createRealManifest(2);
    const evidence = bindPerformanceEvidenceToManifest(manifest);
    const performanceRunner = vi.fn<RealMediaPerformancePanelRunner>(() =>
      Promise.resolve(evidence)
    );
    render(<RealMediaBenchmarkPanel desktopAvailable performanceRunner={performanceRunner} />);
    await openPanel(user);
    await uploadManifest(user, manifest);
    await user.click(await screen.findByRole("button", { name: "采集工程性能原始证据" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "raw evidence 计划 case 数与当前 manifest 的真实关系数不一致"
    );
    expect(screen.queryByLabelText("性能 raw evidence 摘要")).not.toBeInTheDocument();
  });

  it("manifest 版本变化会立即 abort 旧采集并阻止旧 promise 回写", async () => {
    const user = userEvent.setup();
    const firstManifest = createRealManifest(1);
    const nextManifest = structuredClone(firstManifest);
    nextManifest.datasetVersion = "ui-dataset-2";
    nextManifest.name = "UI 真实基准 v2";
    let firstSignal: AbortSignal | undefined;
    let resolveFirst: ((evidence: C137PerformanceRawEvidenceV2) => void) | undefined;
    let invocation = 0;
    const performanceRunner = vi.fn<RealMediaPerformancePanelRunner>((manifest, options) => {
      invocation += 1;
      if (invocation === 1) {
        firstSignal = options.signal;
        return new Promise<C137PerformanceRawEvidenceV2>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(bindPerformanceEvidenceToManifest(manifest));
    });
    render(<RealMediaBenchmarkPanel desktopAvailable performanceRunner={performanceRunner} />);
    await openPanel(user);
    await uploadManifest(user, firstManifest);
    await user.click(await screen.findByRole("button", { name: "采集工程性能原始证据" }));

    const manifestInput = screen.getByLabelText("选择 C137 benchmark manifest JSON");
    manifestInput.removeAttribute("disabled");
    fireEvent.change(manifestInput, {
      target: {
        files: [
          new File([JSON.stringify(nextManifest)], "governed-manifest-v2.json", {
            type: "application/json"
          })
        ]
      }
    });

    await screen.findByText(`${nextManifest.name} · ${nextManifest.datasetVersion}`);
    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    await act(async () => {
      resolveFirst?.(bindPerformanceEvidenceToManifest(firstManifest));
      await Promise.resolve();
    });

    expect(screen.queryByLabelText("性能 raw evidence 摘要")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "采集工程性能原始证据" }));
    expect(await screen.findByLabelText("性能 raw evidence 摘要")).toHaveTextContent(
      "工程采集记录结构完整"
    );
    expect(performanceRunner).toHaveBeenCalledTimes(2);
    expect(performanceRunner.mock.calls[1]?.[0].datasetVersion).toBe("ui-dataset-2");
  });

  it("取消性能采集会 abort 注入 runner，并等待原生资源进入终态", async () => {
    const user = userEvent.setup();
    const manifest = createRealManifest(1);
    let signal: AbortSignal | undefined;
    let rejectRun: ((reason?: unknown) => void) | undefined;
    const performanceRunner = vi.fn<RealMediaPerformancePanelRunner>((_manifest, options) => {
      signal = options.signal;
      return new Promise<C137PerformanceRawEvidenceV1>((_resolve, reject) => {
        rejectRun = reject;
      });
    });
    render(<RealMediaBenchmarkPanel desktopAvailable performanceRunner={performanceRunner} />);
    await openPanel(user);
    await uploadManifest(user, manifest);
    await user.click(await screen.findByRole("button", { name: "采集工程性能原始证据" }));

    expect(screen.getByRole("button", { name: "运行真实媒体精度基准" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "取消性能采集" }));
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent(
      "等待活动作业、FFmpeg/FFprobe 后代和采样线程进入真实终态"
    );
    act(() => {
      rejectRun?.(new Error("native cancellation terminal"));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "性能采集已请求取消；尚未取得可分享的安全终态"
    );
    expect(screen.getByRole("button", { name: "采集工程性能原始证据" })).toBeEnabled();
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

function createGovernedBundle(
  split: "development" | "frozen-test" = "development",
  caseIndex = 0
) {
  const draftCase = createRealCase(caseIndex);
  draftCase.split = split;
  const sourceIdentity = draftCase.source.contentIdentity;
  const targetIdentity = draftCase.target.contentIdentity;
  if (!sourceIdentity || !targetIdentity) {
    throw new Error("治理 bundle 测试缺少媒体身份。");
  }
  const source = {
    contentIdentity: { ...sourceIdentity },
    audioStreamIndex: draftCase.source.audioStreamIndex,
    videoStreamIndex: draftCase.source.videoStreamIndex
  };
  const target = {
    contentIdentity: { ...targetIdentity },
    audioStreamIndex: draftCase.target.audioStreamIndex,
    videoStreamIndex: draftCase.target.videoStreamIndex
  };
  const annotations = [
    createRealMediaGoldAnnotationEnvelope({
      caseId: draftCase.id,
      source,
      target,
      boundaryToleranceMs: draftCase.boundaryToleranceMs,
      reviewerId: "reviewer-a",
      reviewVerification: createReviewVerification("a", "reviewer-a"),
      gold: cloneGold(draftCase.gold)
    }),
    createRealMediaGoldAnnotationEnvelope({
      caseId: draftCase.id,
      source,
      target,
      boundaryToleranceMs: draftCase.boundaryToleranceMs,
      reviewerId: "reviewer-b",
      reviewVerification: createReviewVerification("b", "reviewer-b"),
      gold: cloneGold(draftCase.gold)
    })
  ] as const;
  const frozen = freezeRealMediaGoldCase({
    annotations,
    caseInput: {
      id: draftCase.id,
      title: draftCase.title,
      split,
      scenarios: [...draftCase.scenarios],
      source: structuredClone(draftCase.source),
      target: structuredClone(draftCase.target),
      boundaryToleranceMs: draftCase.boundaryToleranceMs,
      versionNotes: [...draftCase.versionNotes],
      licenseNotes: [...draftCase.licenseNotes]
    },
    resolution: {
      kind: "consensus",
      selectedAnnotationDigest: annotations[0].annotationDigest,
      note: "测试中两份独立标注完全一致，并显式选择第一份。"
    }
  });
  const manifest: RealMediaBenchmarkManifest = {
    ...createRealManifest(0),
    id: `ui-governed-${split}-${caseIndex + 1}`,
    datasetVersion: `ui-governed-${split}-${caseIndex + 1}-v1`,
    cases: [frozen.manifestCase]
  };
  return createRealMediaGoldBenchmarkBundle({
    manifest,
    annotations,
    adjudicationAnnotation: null,
    receipt: frozen.receipt
  });
}

function createReviewVerification(
  seed: "a" | "b",
  verifier: string
): RealMediaGoldReviewVerification {
  const digit = seed === "a" ? "1" : "2";
  return {
    recordVersion: 2,
    method: "manual-review",
    verificationId: `verification-${seed}`,
    issuerKeyId: "install-key-ui-test",
    issuerSequence: seed === "a" ? 1 : 2,
    signatureAlgorithm: "hmac-sha256-v1",
    signature: digit.repeat(64),
    requestDigest: `sha256:${digit.repeat(64)}`,
    reviewEvidenceDigest: `sha256:${seed.repeat(64)}`,
    verifier
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
    split: "development",
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

function bindPerformanceEvidenceToManifest(
  manifest: RealMediaBenchmarkManifest,
  spectralBackend: "auto" | "cuda" | "cpu" = "auto"
): C137PerformanceRawEvidenceV2 {
  const evidence = createCompleteC137PerformanceEvidenceV2Fixture();
  const workloadDigest = createRealMediaPerformanceWorkloadDigest(manifest);
  evidence.runManifestDigest = workloadDigest;
  evidence.plan.workloadDigest = workloadDigest;
  evidence.plan.parameters.spectralBackend = spectralBackend;
  for (const trial of evidence.trials) trial.workloadDigest = workloadDigest;
  evidence.environment.workloadStorage.runManifestDigest = workloadDigest;
  evidence.environment.workloadStorage.workloadDigest = workloadDigest;
  evidence.environment.workloadStorage.receiptDigest =
    computeC137PerformanceWorkloadStorageReceiptDigest(evidence.environment.workloadStorage);
  const { digest, ...environmentWithoutDigest } = evidence.environment;
  void digest;
  evidence.environment.digest =
    computeC137PerformanceEnvironmentDigestV2(environmentWithoutDigest);
  evidence.collector.runManifestDigest = workloadDigest;
  evidence.collector.workloadDigest = workloadDigest;
  evidence.collector.workloadStorageReceiptDigest =
    evidence.environment.workloadStorage.receiptDigest;
  evidence.assurance.workloadStorageReceiptDigest =
    evidence.environment.workloadStorage.receiptDigest;
  evidence.planDigest = createC137PerformancePlanDigest(evidence.plan);
  evidence.evidenceDigest = computeC137PerformanceEvidenceDigestV2(evidence);
  return evidence;
}

function createCompletedReport(
  manifest: RealMediaBenchmarkManifest,
  spectralBackend: "auto" | "cuda" | "cpu" = "auto"
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
    cases: [createCaseRunResult(benchmarkCase.id, "success", "run-cancelled", spectralBackend)],
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
    runManifestDigest: createRealMediaBenchmarkRunManifestDigest(
      projectRealMediaBenchmarkRunManifest(manifest)
    ),
    wallElapsedMs: 1_500,
    skippedNonRealCaseCount: manifest.cases.filter((item) => item.mediaKind !== "real").length,
    preflight,
    ...input
  };
}

function createCaseRunResult(
  caseId: string,
  status: RealMediaBenchmarkCaseRunResult["status"],
  failureCode: NonNullable<
    RealMediaBenchmarkCaseRunResult["failure"]
  >["code"] = "run-cancelled",
  spectralBackend: "auto" | "cuda" | "cpu" = "auto"
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
      spectralBackend,
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
