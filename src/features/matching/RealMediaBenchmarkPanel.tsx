import { isTauri } from "@tauri-apps/api/core";
import { Cpu, Download, FileJson, Gauge, Play, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { TextButton } from "../../components/TextButton";
import {
  parseRealMediaBenchmarkManifestJson,
  type C137BenchmarkGateCheck,
  type RealMediaBenchmarkManifest
} from "../../domain/alignment/realMediaBenchmark";
import {
  getC137PerformanceMeasuredRuns,
  getC137PerformancePeakRss,
  serializeC137PerformanceEvidence,
  validateC137PerformanceEvidence,
  type C137PerformanceRawEvidence,
  type C137PerformanceRawEvidenceV2
} from "../../domain/alignment/c137PerformanceEvidence";
import { downloadTextFile, readTextFile } from "../../infrastructure/file-system/browserFiles";
import {
  createRealMediaBenchmarkRunManifestDigest,
  projectRealMediaBenchmarkRunManifest,
  runRealMediaBenchmarkManifest,
  serializeRealMediaBenchmarkRunReport,
  validateRealMediaBenchmarkRunReport,
  type RealMediaBenchmarkRunReport,
  type RealMediaBenchmarkRunnerOptions
} from "../../infrastructure/alignment/realMediaBenchmarkRunner";
import {
  collectRealMediaPerformanceEvidence,
  createC137PerformanceRawEvidenceFromJournal,
  createEngineeringRealMediaPerformancePlan,
  createRealMediaPerformanceWorkloadDigest,
  type RealMediaPerformancePhase
} from "../../infrastructure/alignment/realMediaPerformanceRunner";
import { loadAppSettings } from "../../infrastructure/settings/appSettings";

export type RealMediaBenchmarkPanelRunner = (
  manifest: RealMediaBenchmarkManifest,
  options: RealMediaBenchmarkRunnerOptions
) => Promise<RealMediaBenchmarkRunReport>;

export interface RealMediaPerformancePanelRunOptions {
  signal: AbortSignal;
  ffmpegPath: string | null;
  onProgress: (phase: RealMediaPerformancePhase) => void;
}

export type RealMediaPerformancePanelRunner = (
  manifest: RealMediaBenchmarkManifest,
  options: RealMediaPerformancePanelRunOptions
) => Promise<C137PerformanceRawEvidence>;

interface RealMediaBenchmarkPanelProps {
  runner?: RealMediaBenchmarkPanelRunner;
  performanceRunner?: RealMediaPerformancePanelRunner;
  desktopAvailable?: boolean;
}

type RunPhase = "idle" | "running" | "cancelling";

export function RealMediaBenchmarkPanel({
  runner = runRealMediaBenchmarkManifest,
  performanceRunner = defaultPerformancePanelRunner,
  desktopAvailable: desktopAvailableOverride
}: RealMediaBenchmarkPanelProps) {
  const desktopAvailable = desktopAvailableOverride ?? isTauri();
  const [open, setOpen] = useState(false);
  const [manifestFileName, setManifestFileName] = useState<string | null>(null);
  const [manifest, setManifest] = useState<RealMediaBenchmarkManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [report, setReport] = useState<RealMediaBenchmarkRunReport | null>(null);
  const [runPhase, setRunPhase] = useState<RunPhase>("idle");
  const [performanceBusy, setPerformanceBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const operationRef = useRef(0);
  const realCases = useMemo(
    () => manifest?.cases.filter((benchmarkCase) => benchmarkCase.mediaKind === "real") ?? [],
    [manifest]
  );
  const blockers = createRunBlockers(desktopAvailable, manifest, realCases.length);
  const precisionRunning = runPhase !== "idle";
  const running = precisionRunning || performanceBusy;

  useEffect(
    () => () => {
      operationRef.current += 1;
      abortControllerRef.current?.abort();
    },
    []
  );

  const loadManifestFile = async (file: File): Promise<void> => {
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    setManifestFileName(file.name);
    setManifest(null);
    setManifestError(null);
    setReport(null);
    setRunError(null);
    setDownloadStatus(null);
    try {
      const text = await readTextFile(file);
      const parsed = parseRealMediaBenchmarkManifestJson(text);
      if (operationRef.current !== operation) return;
      setManifest(parsed);
    } catch (error: unknown) {
      if (operationRef.current !== operation) return;
      setManifestError(formatError(error));
    }
  };

  const runBenchmark = async (): Promise<void> => {
    if (!manifest || blockers.length > 0 || running) return;
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setRunPhase("running");
    setRunError(null);
    setReport(null);
    setDownloadStatus(null);
    const settings = loadAppSettings().alignment;
    try {
      const nextReport = await runner(manifest, {
        signal: controller.signal,
        ffmpegPath: settings.ffmpegPath.trim() || null,
        windowMs: settings.windowMs,
        minGapMs: settings.minGapMs,
        matchThreshold: settings.matchThreshold
      });
      if (operationRef.current !== operation) return;
      const validation = validateRealMediaBenchmarkRunReport(nextReport);
      if (!validation.valid) {
        throw new Error(`runner 返回的报告无效：${validation.issues.join("；")}`);
      }
      assertBenchmarkReportMatchesManifest(nextReport, manifest);
      assertReportContainsNoManifestSecrets(
        serializeRealMediaBenchmarkRunReport(nextReport),
        manifest
      );
      setReport(nextReport);
    } catch (error: unknown) {
      if (operationRef.current !== operation) return;
      setRunError(
        sanitizeManifestSecrets(
          controller.signal.aborted
            ? `取消后未生成可审计报告：${formatError(error)}`
            : `运行失败：${formatError(error)}`,
          manifest
        )
      );
    } finally {
      if (operationRef.current === operation) {
        abortControllerRef.current = null;
        setRunPhase("idle");
      }
    }
  };

  const cancelBenchmark = (): void => {
    const controller = abortControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    setRunPhase("cancelling");
  };

  const clearManifest = (): void => {
    if (running) return;
    operationRef.current += 1;
    setManifestFileName(null);
    setManifest(null);
    setManifestError(null);
    setReport(null);
    setRunError(null);
    setDownloadStatus(null);
  };

  const downloadReport = (): void => {
    if (!manifest || !report) return;
    try {
      assertBenchmarkReportMatchesManifest(report, manifest);
      const text = serializeRealMediaBenchmarkRunReport(report);
      assertReportContainsNoManifestSecrets(text, manifest);
      const fileName = downloadTextFile(
        `c137-${manifest.id}-${manifest.datasetVersion}-time-map-report.json`,
        text,
        "application/json;charset=utf-8"
      );
      setDownloadStatus(`已下载已移除本地路径与单媒体内容哈希的稳定报告：${fileName}。`);
      setRunError(null);
    } catch (error: unknown) {
      setRunError(`无法下载报告：${formatError(error)}`);
    }
  };

  return (
    <section
      className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-slate-300"
      data-testid="real-media-benchmark-panel"
    >
      <button
        type="button"
        disabled={running}
        className="flex w-full items-center justify-between gap-3 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan"
        aria-expanded={open}
        title={running ? "基准运行期间请先取消并等待原生清理完成。" : undefined}
        onClick={() => {
          if (!running) setOpen((current) => !current);
        }}
      >
        <span className="flex items-center gap-2 text-sm font-medium text-slate-100">
          <Gauge size={15} className="text-accent-cyan" aria-hidden="true" />
          高级：C137 精度基准（开发与验收）
        </span>
        <span className="shrink-0 rounded border border-panel-line px-2 py-1 text-[11px] text-slate-400">
          {open ? "收起" : "展开"}
        </span>
      </button>

      {open ? (
        <div className="mt-3 grid gap-3">
          <div className="rounded border border-amber-400/35 bg-amber-400/10 p-2 leading-5 text-amber-100">
            <p className="font-medium">这是 TimeMap 组件级开发验收，不是普通项目操作。</p>
            <p className="mt-1">
              它只读取一份受治理的 manifest
              JSON；媒体路径、身份和流选择必须已写在清单中，本页不会再次选择视频，也不会写入当前项目。
            </p>
            <p className="mt-1 font-medium">
              即使组件子闸门显示通过，也绝不代表 release 通过，更不会授予 verified 资格。
            </p>
          </div>

          <label className="grid gap-1.5 text-slate-400">
            <span className="font-medium text-slate-300">选择 benchmark manifest JSON</span>
            <input
              type="file"
              accept=".json,application/json"
              disabled={running}
              aria-label="选择 C137 benchmark manifest JSON"
              className="rounded border border-panel-line bg-black/20 p-2 text-slate-300 file:mr-3 file:rounded file:border file:border-panel-line file:bg-panel-soft file:px-2 file:py-1 file:text-xs file:text-slate-200"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void loadManifestFile(file);
              }}
            />
          </label>

          {!manifest && !manifestError ? (
            <div className="rounded border border-dashed border-panel-line p-3 leading-5 text-slate-500">
              尚未选择清单。这里只选择一次 manifest JSON；真实媒体文件由清单中的本地路径引用。
            </div>
          ) : null}
          {manifestError ? (
            <p
              className="rounded border border-red-400/35 bg-red-400/10 p-2 leading-5 text-red-100"
              role="alert"
            >
              无法读取清单：{manifestError}
            </p>
          ) : null}

          {manifest ? (
            <ManifestGovernanceSummary
              manifest={manifest}
              fileName={manifestFileName ?? "manifest.json"}
            />
          ) : null}

          {blockers.length > 0 ? (
            <div className="grid gap-1.5" aria-label="运行阻断条件">
              {blockers.map((blocker) => (
                <p
                  key={blocker}
                  className="rounded border border-amber-400/30 bg-amber-400/10 p-2 leading-5 text-amber-100"
                >
                  {blocker}
                </p>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {precisionRunning ? (
              <TextButton
                tone="danger"
                disabled={runPhase === "cancelling"}
                onClick={cancelBenchmark}
              >
                <Square size={13} />
                {runPhase === "cancelling" ? "正在取消…" : "取消基准运行"}
              </TextButton>
            ) : (
              <TextButton
                tone="primary"
                disabled={!manifest || blockers.length > 0 || performanceBusy}
                title={blockers[0] ?? (!manifest ? "请先选择有效 manifest JSON。" : undefined)}
                onClick={() => void runBenchmark()}
              >
                <Play size={13} />
                运行真实媒体精度基准
              </TextButton>
            )}
            {manifestFileName || manifestError ? (
              <TextButton disabled={running} onClick={clearManifest}>
                清除清单
              </TextButton>
            ) : null}
          </div>

          {precisionRunning ? (
            <p className="leading-5 text-slate-400" role="status" aria-live="polite">
              {runPhase === "cancelling"
                ? "已请求取消；正在等待活动分析任务安全退出并生成可审计的取消报告。"
                : "正在依次完成媒体身份预检和真实 case 分析；完成后才显示组件子闸门。"}
            </p>
          ) : null}
          {runError ? (
            <p
              className="rounded border border-red-400/35 bg-red-400/10 p-2 leading-5 text-red-100"
              role="alert"
            >
              {runError}
            </p>
          ) : null}

          {report ? <BenchmarkRunReportView report={report} /> : null}

          {report ? (
            <div className="grid gap-2">
              <p className="leading-5 text-amber-100">
                已移除本地路径与单媒体内容哈希，但 path-free
                不等于匿名；清单标识与稳定摘要仍可能关联同一数据集或多次运行。
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <TextButton tone="primary" onClick={downloadReport}>
                  <Download size={13} />
                  下载已移除路径与单媒体哈希的稳定报告
                </TextButton>
                {downloadStatus ? (
                  <span className="text-emerald-100" role="status">
                    {downloadStatus}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          <PerformanceEvidencePanel
            manifest={manifest}
            blockers={blockers}
            disabled={precisionRunning}
            runner={performanceRunner}
            onBusyChange={setPerformanceBusy}
          />
        </div>
      ) : null}
    </section>
  );
}

function PerformanceEvidencePanel({
  manifest,
  blockers,
  disabled,
  runner,
  onBusyChange
}: {
  manifest: RealMediaBenchmarkManifest | null;
  blockers: string[];
  disabled: boolean;
  runner: RealMediaPerformancePanelRunner;
  onBusyChange: (busy: boolean) => void;
}) {
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [phase, setPhase] = useState<RealMediaPerformancePhase | null>(null);
  const [evidence, setEvidence] = useState<C137PerformanceRawEvidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const operationRef = useRef(0);

  useEffect(
    () => () => {
      operationRef.current += 1;
      abortRef.current?.abort();
      onBusyChange(false);
    },
    [onBusyChange]
  );

  useEffect(() => {
    operationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setCancelling(false);
    onBusyChange(false);
    setEvidence(null);
    setError(null);
    setDownloadStatus(null);
    setPhase(null);
  }, [manifest, onBusyChange]);

  const runPerformance = async (): Promise<void> => {
    if (!manifest || blockers.length > 0 || disabled || running) return;
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setCancelling(false);
    setError(null);
    setDownloadStatus(null);
    onBusyChange(true);
    const settings = loadAppSettings().alignment;
    try {
      const rawEvidence = await runner(manifest, {
        signal: controller.signal,
        ffmpegPath: settings.ffmpegPath.trim() || null,
        onProgress: (nextPhase) => {
          if (operationRef.current === operation) setPhase(nextPhase);
        }
      });
      if (operationRef.current !== operation) return;
      const validation = validateC137PerformanceEvidence(rawEvidence);
      if (!validation.valid) {
        throw new Error(`raw evidence 严格校验失败：${validation.issues.join("；")}`);
      }
      assertPerformanceEvidenceMatchesManifest(rawEvidence, manifest);
      const serialized = serializeC137PerformanceEvidence(rawEvidence);
      assertReportContainsNoManifestSecrets(serialized, manifest);
      setEvidence(rawEvidence);
      if (!validation.complete) {
        setError(
          `采集已结束，但不具备正式性能证据条件：${validation.completenessIssues.join("；")}`
        );
      }
    } catch (reason: unknown) {
      if (operationRef.current !== operation) return;
      setError(
        sanitizeManifestSecrets(
          controller.signal.aborted
            ? "性能采集已请求取消；尚未取得可分享的安全终态。"
            : `性能采集失败：${formatError(reason)}`,
          manifest
        )
      );
    } finally {
      if (operationRef.current === operation) {
        abortRef.current = null;
        setRunning(false);
        setCancelling(false);
        onBusyChange(false);
      }
    }
  };

  const cancelPerformance = (): void => {
    const controller = abortRef.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    setCancelling(true);
  };

  const downloadEvidence = (): void => {
    if (!manifest || !evidence) return;
    try {
      assertPerformanceEvidenceMatchesManifest(evidence, manifest);
      const serialized = serializeC137PerformanceEvidence(evidence);
      assertReportContainsNoManifestSecrets(serialized, manifest);
      const fileName = downloadTextFile(
        `c137-performance-${evidence.plan.planId}.json`,
        serialized,
        "application/json;charset=utf-8"
      );
      setDownloadStatus(`已下载未审批 raw evidence：${fileName}。`);
    } catch (reason: unknown) {
      setError(`无法下载性能 evidence：${formatError(reason)}`);
    }
  };

  return (
    <section
      className="grid gap-3 rounded border border-cyan-400/25 bg-cyan-400/5 p-3"
      aria-label="C137 原生性能证据采集"
    >
      <div className="flex items-center gap-2">
        <Cpu size={14} className="text-accent-cyan" aria-hidden="true" />
        <h4 className="font-medium text-slate-100">原生性能 raw evidence（工程采集）</h4>
      </div>
      <p className="leading-5 text-slate-400">
        按预注册顺序独占运行冷缓存、完整预热、热缓存和取消探针；耗时、阶段、缓存与进程树 RSS
        均来自 Rust 单调时钟和原生采集器。运行期间普通匹配会被原生 lease 阻止。
      </p>
      <p className="rounded border border-amber-400/35 bg-amber-400/10 p-2 font-medium leading-5 text-amber-100">
        当前没有批准的 production protocol 或 trust root。本入口只生成 releaseEligible=false
        的未审批原始证据，不能自行让 C137 或自动 verified 通过。
      </p>
      <p className="leading-5 text-slate-400">
        下载文件会移除本地路径与单媒体内容哈希，但 path-free 不等于匿名；文件仍含
        CPU、操作系统、内存、工具二进制摘要与运行标识，其中的 runManifestDigest、mediaSetDigest
        等稳定摘要也可能关联同一数据集或多次运行。
      </p>

      <div className="flex flex-wrap gap-2">
        {running ? (
          <TextButton tone="danger" disabled={cancelling} onClick={cancelPerformance}>
            <Square size={13} />
            {cancelling ? "正在取消并清理…" : "取消性能采集"}
          </TextButton>
        ) : (
          <TextButton
            tone="primary"
            disabled={!manifest || blockers.length > 0 || disabled}
            title={blockers[0] ?? (disabled ? "另一项基准正在运行。" : undefined)}
            onClick={() => void runPerformance()}
          >
            <Play size={13} />
            采集工程性能原始证据
          </TextButton>
        )}
      </div>

      {running ? (
        <p className="leading-5 text-slate-300" role="status" aria-live="polite">
          {cancelling
            ? "正在等待活动作业、FFmpeg/FFprobe 后代和采样线程进入真实终态。"
            : `当前阶段：${formatPerformancePhase(phase)}。`}
        </p>
      ) : null}
      {error ? (
        <p
          className="rounded border border-amber-400/35 bg-amber-400/10 p-2 leading-5 text-amber-100"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {evidence ? <PerformanceEvidenceSummary evidence={evidence} /> : null}
      {evidence ? (
        <div className="flex flex-wrap items-center gap-2">
          <TextButton tone="primary" onClick={downloadEvidence}>
            <Download size={13} />
            下载未审批 raw evidence
          </TextButton>
          {downloadStatus ? (
            <span className="text-emerald-100" role="status">
              {downloadStatus}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function PerformanceEvidenceSummary({ evidence }: { evidence: C137PerformanceRawEvidence }) {
  const validation = validateC137PerformanceEvidence(evidence);
  const measured =
    evidence.schemaVersion === 2
      ? getC137PerformanceMeasuredRuns(evidence)
      : getC137PerformanceMeasuredRuns(evidence);
  const cold = measured.filter((run) => run.runKind === "cold");
  const hot = measured.filter((run) => run.runKind === "hot");
  const peaks = measured.map(getC137PerformancePeakRss).filter((value) => value !== null);
  const cancellations = evidence.trials.filter((trial) => trial.trialType === "cancellation");
  return (
    <section
      className="grid gap-2 rounded border border-panel-line/70 bg-black/20 p-2"
      aria-label="性能 raw evidence 摘要"
    >
      <p className="text-amber-100">
        {validation.complete
          ? "工程采集记录结构完整；正式证据链仍未完成，不能进入正式验收。"
          : "工程采集记录结构不完整；正式证据链未完成，禁止进入正式验收。"}
      </p>
      {evidence.collector.sampler === "windows-toolhelp-working-set-v1" ||
      evidence.environment.storageScope === "system-volume" ? (
        <p className="rounded border border-amber-400/35 bg-amber-400/10 p-2 text-amber-100">
          {evidence.schemaVersion === 2
            ? "实际媒体卷收据已由 native v2 采集并闭合，但进程归属仍是 ToolHelp（工程）；正式性能验收仍要求 Job Object 完整归属与外部 trust root。"
            : "当前仍是 ToolHelp 进程枚举和系统卷探测，只能用于工程回归；正式性能验收要求 Job Object 进程归属与实际媒体卷环境收据。"}
        </p>
      ) : null}
      <dl className="grid gap-1 leading-5 sm:grid-cols-2">
        <div>
          <dt className="inline text-slate-500">目标环境：</dt>
          <dd className="inline">
            {evidence.environment.operatingSystem} · {evidence.environment.physicalCoreCount}{" "}
            物理核
          </dd>
        </div>
        <div>
          <dt className="inline text-slate-500">采样：</dt>
          <dd className="inline">{evidence.plan.memorySampleIntervalMs}ms · 进程树 RSS</dd>
        </div>
        <div>
          <dt className="inline text-slate-500">进程归属：</dt>
          <dd className="inline">
            {evidence.collector.sampler === "windows-job-object-working-set-v1"
              ? "Job Object"
              : evidence.collector.sampler === "windows-toolhelp-working-set-v1"
                ? "ToolHelp（工程）"
                : "不受支持"}
          </dd>
        </div>
        <div>
          <dt className="inline text-slate-500">存储范围：</dt>
          <dd className="inline">
            {evidence.schemaVersion === 2
              ? `实际媒体卷（${evidence.environment.workloadStorage.volumeCount} 卷）`
              : evidence.environment.storageScope === "workload-media-volumes"
                ? "实际媒体卷（旧版未绑定）"
                : "系统卷（工程）"}
          </dd>
        </div>
        <div>
          <dt className="inline text-slate-500">冷缓存最大：</dt>
          <dd className="inline">{formatMaximumElapsed(cold)}</dd>
        </div>
        <div>
          <dt className="inline text-slate-500">热缓存最大：</dt>
          <dd className="inline">{formatMaximumElapsed(hot)}</dd>
        </div>
        <div>
          <dt className="inline text-slate-500">峰值 RSS：</dt>
          <dd className="inline">
            {peaks.length > 0 ? formatBytes(Math.max(...peaks)) : "缺失"}
          </dd>
        </div>
        <div>
          <dt className="inline text-slate-500">取消探针：</dt>
          <dd className="inline">
            {cancellations.length} 次
            {cancellations.length > 0
              ? ` · 最大 ${Math.max(...cancellations.map((trial) => trial.latencyMs)).toFixed(0)}ms`
              : ""}
          </dd>
        </div>
      </dl>
      <p className="text-slate-500">evidence digest：{evidence.evidenceDigest}</p>
    </section>
  );
}

function ManifestGovernanceSummary({
  manifest,
  fileName
}: {
  manifest: RealMediaBenchmarkManifest;
  fileName: string;
}) {
  const realCases = manifest.cases.filter(
    (benchmarkCase) => benchmarkCase.mediaKind === "real"
  );
  const frozenCount = realCases.filter(
    (benchmarkCase) => benchmarkCase.split === "frozen-test"
  ).length;
  const identityReadyCount = realCases.filter(
    (benchmarkCase) =>
      benchmarkCase.source.contentIdentity !== null &&
      benchmarkCase.target.contentIdentity !== null
  ).length;
  return (
    <section
      className="rounded border border-panel-line/70 bg-black/20 p-2"
      aria-label="清单治理摘要"
    >
      <div className="flex items-center gap-2">
        <FileJson size={14} className="text-accent-cyan" aria-hidden="true" />
        <span className="font-medium text-slate-200">清单治理摘要</span>
      </div>
      <dl className="mt-2 grid gap-1 leading-5 sm:grid-cols-2">
        <div>
          <dt className="inline text-slate-500">文件：</dt>
          <dd className="inline">{fileName}</dd>
        </div>
        <div>
          <dt className="inline text-slate-500">数据集：</dt>
          <dd className="inline">
            {manifest.name} · {manifest.datasetVersion}
          </dd>
        </div>
        <div>
          <dt className="inline text-slate-500">关系：</dt>
          <dd className="inline">
            共 {manifest.cases.length}，真实 {realCases.length}
          </dd>
        </div>
        <div>
          <dt className="inline text-slate-500">冻结集：</dt>
          <dd className="inline">
            {frozenCount} · 开发集 {realCases.length - frozenCount}
          </dd>
        </div>
        <div>
          <dt className="inline text-slate-500">双侧身份完整：</dt>
          <dd className="inline">
            {identityReadyCount} / {realCases.length}
          </dd>
        </div>
        <div>
          <dt className="inline text-slate-500">清单类型：</dt>
          <dd className="inline">{manifest.isExample ? "示例清单" : "受治理清单"}</dd>
        </div>
      </dl>
    </section>
  );
}

function BenchmarkRunReportView({ report }: { report: RealMediaBenchmarkRunReport }) {
  const succeeded = report.cases.filter((item) => item.status === "success").length;
  const failed = report.cases.filter((item) => item.status === "failed").length;
  const cancelled = report.cases.filter((item) => item.status === "cancelled").length;
  const gate = report.evaluation?.gate ?? null;
  return (
    <section
      className="grid gap-3 rounded border border-panel-line bg-black/20 p-3"
      aria-label="C137 真实媒体运行报告"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium text-slate-100">
          运行报告：{formatRunStatus(report.status)}
        </h4>
        <span className="text-slate-500">
          协调器观测耗时 {(report.wallElapsedMs / 1_000).toFixed(1)} 秒（非性能证据）
        </span>
      </div>
      <p className="rounded border border-red-400/40 bg-red-400/10 p-2 font-medium leading-5 text-red-100">
        报告范围仅为 TimeMap 组件；releaseEligible=false，绝不代表 release 通过。
      </p>

      <section aria-label="媒体身份预检结果">
        <h5 className="font-medium text-slate-200">媒体身份预检</h5>
        <p className="mt-1 leading-5 text-slate-400">
          {report.preflight.ok ? "通过" : "未通过"} · 真实关系{" "}
          {report.preflight.realRelationCount} · 已检查文件 {report.preflight.checkedFileCount}
        </p>
        {report.preflight.issues.length > 0 ? (
          <ul className="mt-1 grid gap-1 text-amber-100">
            {report.preflight.issues.map((issue, index) => (
              <li
                key={`${issue.caseId ?? "manifest"}:${issue.side ?? "all"}:${issue.code}:${index}`}
              >
                {issue.caseId ?? "清单"} · {formatIssueSide(issue.side)}：{issue.message}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-label="真实 case 结果">
        <h5 className="font-medium text-slate-200">真实 case 结果</h5>
        <p className="mt-1 leading-5 text-slate-400">
          成功 {succeeded} · 失败 {failed} · 已取消 {cancelled}
        </p>
        {report.cases.length > 0 ? (
          <ul className="mt-1 grid gap-1.5">
            {report.cases.map((item) => (
              <li
                key={item.caseId}
                className="rounded border border-panel-line/60 px-2 py-1.5 leading-5"
              >
                <span
                  className={
                    item.status === "success"
                      ? "text-emerald-100"
                      : item.status === "failed"
                        ? "text-red-100"
                        : "text-amber-100"
                  }
                >
                  {item.caseId} · {formatCaseStatus(item.status)}
                </span>
                {item.failure ? (
                  <span className="ml-2 text-slate-400">{item.failure.message}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 leading-5 text-slate-500">没有启动任何真实 case。</p>
        )}
      </section>

      <section aria-label="TimeMap 组件子闸门">
        <h5 className="font-medium text-slate-200">TimeMap 组件子闸门</h5>
        {gate ? (
          <>
            <p className="mt-1 leading-5 text-slate-400">
              状态：{formatGateStatus(gate.status)}
            </p>
            <GateChecks title="数据门槛" checks={gate.dataChecks} />
            <GateChecks title="质量门槛" checks={gate.qualityChecks} />
            <ul className="mt-1 grid gap-1 text-slate-500">
              {gate.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-1 leading-5 text-slate-500">
            本次运行未完成全部真实 case，没有生成部分或推测性的组件质量结论。
          </p>
        )}
      </section>
    </section>
  );
}

function GateChecks({ title, checks }: { title: string; checks: C137BenchmarkGateCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <div className="mt-2">
      <h6 className="text-slate-400">{title}</h6>
      <ul className="mt-1 grid gap-1">
        {checks.map((check) => (
          <li key={check.id} className={check.passed ? "text-emerald-100" : "text-amber-100"}>
            {check.passed ? "通过" : "未通过"} · {check.id}：{formatGateActual(check.actual)}
            ；要求 {check.requirement}
          </li>
        ))}
      </ul>
    </div>
  );
}

function createRunBlockers(
  desktopAvailable: boolean,
  manifest: RealMediaBenchmarkManifest | null,
  realCaseCount: number
): string[] {
  const blockers: string[] = [];
  if (!desktopAvailable) {
    blockers.push("浏览器预览不能运行真实媒体基准；请在 Tauri 桌面端打开同一份清单。");
  }
  if (!manifest) return blockers;
  if (manifest.isExample) {
    blockers.push("示例 manifest 只用于理解格式，禁止执行或作为精度证据。");
  }
  if (realCaseCount === 0) {
    blockers.push("清单包含 0 个 mediaKind=real 关系，不能运行真实媒体精度基准。");
  }
  return blockers;
}

function assertReportContainsNoManifestSecrets(
  reportText: string,
  manifest: RealMediaBenchmarkManifest
): void {
  const leaked = collectManifestSecrets(manifest).some((secret) =>
    createSerializedSecretVariants(secret).some((variant) => reportText.includes(variant))
  );
  if (leaked) {
    throw new Error("报告仍含本地媒体路径或身份摘要，已阻止下载。");
  }
}

function createSerializedSecretVariants(secret: string): string[] {
  const jsonEscaped = JSON.stringify(secret).slice(1, -1);
  return jsonEscaped === secret ? [secret] : [secret, jsonEscaped];
}

function sanitizeManifestSecrets(text: string, manifest: RealMediaBenchmarkManifest): string {
  let sanitized = text;
  for (const secret of collectManifestSecrets(manifest)) {
    for (const variant of createSerializedSecretVariants(secret)) {
      sanitized = sanitized.split(variant).join("[已隐藏本地媒体]");
    }
  }
  return sanitized.replace(/\b[a-f0-9]{64}\b/giu, "[已隐藏 SHA-256]");
}

function collectManifestSecrets(manifest: RealMediaBenchmarkManifest): string[] {
  return [
    ...new Set(
      manifest.cases.flatMap((benchmarkCase) =>
        [benchmarkCase.source, benchmarkCase.target].flatMap((media) => [
          media.path,
          media.contentIdentity?.digest ?? ""
        ])
      )
    )
  ].filter((secret) => secret.length > 0);
}

function formatRunStatus(status: RealMediaBenchmarkRunReport["status"]): string {
  if (status === "completed") return "全部完成";
  if (status === "completed-with-errors") return "完成但有失败";
  if (status === "cancelled") return "已取消";
  if (status === "preflight-failed") return "预检未通过";
  return "真实数据不足";
}

function formatCaseStatus(
  status: RealMediaBenchmarkRunReport["cases"][number]["status"]
): string {
  return status === "success" ? "成功" : status === "failed" ? "失败" : "已取消";
}

function formatIssueSide(
  side: RealMediaBenchmarkRunReport["preflight"]["issues"][number]["side"]
): string {
  return side === "source" ? "参考侧" : side === "target" ? "原片侧" : "整体";
}

function formatGateStatus(status: "insufficient-data" | "pass" | "fail"): string {
  return status === "pass" ? "通过" : status === "fail" ? "未通过" : "真实数据不足";
}

function formatGateActual(value: string | number | boolean): string {
  return typeof value === "number" && !Number.isInteger(value)
    ? value.toFixed(4)
    : String(value);
}

function formatPerformancePhase(phase: RealMediaPerformancePhase | null): string {
  if (phase === "acquiring-session") return "取得原生独占会话";
  if (phase === "preflight") return "核验媒体身份与显式流";
  if (phase === "resetting-cache") return "原子清空应用特征缓存";
  if (phase === "running-cold") return "冷缓存测量";
  if (phase === "running-warmup") return "完整预热（不计入冷/热门槛）";
  if (phase === "running-hot") return "热缓存测量";
  if (phase === "running-cancellation") return "协议化取消探针";
  if (phase === "cleaning-up") return "确认后代退出并清理 session";
  if (phase === "completed") return "完成";
  return "准备中";
}

async function defaultPerformancePanelRunner(
  manifest: RealMediaBenchmarkManifest,
  options: RealMediaPerformancePanelRunOptions
): Promise<C137PerformanceRawEvidenceV2> {
  const plan = createEngineeringRealMediaPerformancePlan(
    manifest,
    `performance-${createOpaqueRunId()}`
  );
  const journal = await collectRealMediaPerformanceEvidence(manifest, plan, {
    signal: options.signal,
    ffmpegPath: options.ffmpegPath,
    onProgress: (progress) => options.onProgress(progress.phase)
  });
  if (journal.status === "cancelled") {
    throw new Error("本次性能采集已取消并进入原生清理；上一份完整结果保持不变。");
  }
  return createC137PerformanceRawEvidenceFromJournal(journal);
}

function formatMaximumElapsed(runs: Array<{ elapsedMs: number }>): string {
  if (runs.length === 0) return "缺失";
  const milliseconds = Math.max(...runs.map((run) => run.elapsedMs));
  return milliseconds >= 60_000
    ? `${(milliseconds / 60_000).toFixed(2)} 分钟`
    : `${(milliseconds / 1_000).toFixed(2)} 秒`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(2)} GiB`;
}

function createOpaqueRunId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `fallback-${Date.now().toString(36)}`;
}

function assertPerformanceEvidenceMatchesManifest(
  evidence: C137PerformanceRawEvidence,
  manifest: RealMediaBenchmarkManifest
): void {
  const expectedWorkloadDigest = createRealMediaPerformanceWorkloadDigest(manifest);
  if (evidence.plan.workloadDigest !== expectedWorkloadDigest) {
    throw new Error("raw evidence 工作负载摘要与当前 manifest 不一致。");
  }
  const expectedCaseCount = manifest.cases.filter(
    (benchmarkCase) => benchmarkCase.mediaKind === "real"
  ).length;
  if (evidence.plan.expectedCaseCount !== expectedCaseCount) {
    throw new Error("raw evidence 计划 case 数与当前 manifest 的真实关系数不一致。");
  }
}

function assertBenchmarkReportMatchesManifest(
  report: RealMediaBenchmarkRunReport,
  manifest: RealMediaBenchmarkManifest
): void {
  const expectedDigest = createRealMediaBenchmarkRunManifestDigest(
    projectRealMediaBenchmarkRunManifest(manifest)
  );
  if (
    report.manifestId !== manifest.id ||
    report.datasetVersion !== manifest.datasetVersion ||
    report.runManifestDigest !== expectedDigest
  ) {
    throw new Error("runner 返回的报告与当前 manifest 的 blind workload 摘要不一致。");
  }
}

function formatError(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}
