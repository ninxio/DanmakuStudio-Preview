import { isTauri } from "@tauri-apps/api/core";
import { Download, FileJson, Gauge, Play, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { TextButton } from "../../components/TextButton";
import {
  parseRealMediaBenchmarkManifestJson,
  type C137BenchmarkGateCheck,
  type RealMediaBenchmarkManifest
} from "../../domain/alignment/realMediaBenchmark";
import { downloadTextFile, readTextFile } from "../../infrastructure/file-system/browserFiles";
import {
  runRealMediaBenchmarkManifest,
  serializeRealMediaBenchmarkRunReport,
  validateRealMediaBenchmarkRunReport,
  type RealMediaBenchmarkRunReport,
  type RealMediaBenchmarkRunnerOptions
} from "../../infrastructure/alignment/realMediaBenchmarkRunner";
import { loadAppSettings } from "../../infrastructure/settings/appSettings";

export type RealMediaBenchmarkPanelRunner = (
  manifest: RealMediaBenchmarkManifest,
  options: RealMediaBenchmarkRunnerOptions
) => Promise<RealMediaBenchmarkRunReport>;

interface RealMediaBenchmarkPanelProps {
  runner?: RealMediaBenchmarkPanelRunner;
  desktopAvailable?: boolean;
}

type RunPhase = "idle" | "running" | "cancelling";

export function RealMediaBenchmarkPanel({
  runner = runRealMediaBenchmarkManifest,
  desktopAvailable: desktopAvailableOverride
}: RealMediaBenchmarkPanelProps) {
  const desktopAvailable = desktopAvailableOverride ?? isTauri();
  const [open, setOpen] = useState(false);
  const [manifestFileName, setManifestFileName] = useState<string | null>(null);
  const [manifest, setManifest] = useState<RealMediaBenchmarkManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [report, setReport] = useState<RealMediaBenchmarkRunReport | null>(null);
  const [runPhase, setRunPhase] = useState<RunPhase>("idle");
  const [runError, setRunError] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const operationRef = useRef(0);
  const realCases = useMemo(
    () => manifest?.cases.filter((benchmarkCase) => benchmarkCase.mediaKind === "real") ?? [],
    [manifest]
  );
  const blockers = createRunBlockers(desktopAvailable, manifest, realCases.length);
  const running = runPhase !== "idle";

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
      if (
        nextReport.manifestId !== manifest.id ||
        nextReport.datasetVersion !== manifest.datasetVersion
      ) {
        throw new Error("runner 返回的报告与当前 manifest 身份不一致。");
      }
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
      const text = serializeRealMediaBenchmarkRunReport(report);
      assertReportContainsNoManifestSecrets(text, manifest);
      const fileName = downloadTextFile(
        `c137-${manifest.id}-${manifest.datasetVersion}-time-map-report.json`,
        text,
        "application/json;charset=utf-8"
      );
      setDownloadStatus(`已下载去敏报告：${fileName}。`);
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
        className="flex w-full items-center justify-between gap-3 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
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
            {running ? (
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
                disabled={!manifest || blockers.length > 0}
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

          {running ? (
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
            <div className="flex flex-wrap items-center gap-2">
              <TextButton tone="primary" onClick={downloadReport}>
                <Download size={13} />
                下载去敏稳定报告
              </TextButton>
              {downloadStatus ? (
                <span className="text-emerald-100" role="status">
                  {downloadStatus}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
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
          耗时 {(report.wallElapsedMs / 1_000).toFixed(1)} 秒
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
  const leaked = collectManifestSecrets(manifest).some((secret) => reportText.includes(secret));
  if (leaked) {
    throw new Error("报告仍含本地媒体路径或身份摘要，已阻止下载。");
  }
}

function sanitizeManifestSecrets(text: string, manifest: RealMediaBenchmarkManifest): string {
  let sanitized = text;
  for (const secret of collectManifestSecrets(manifest)) {
    sanitized = sanitized.split(secret).join("[已隐藏本地媒体]");
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

function formatError(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}
