import { Download, Files, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { TextButton } from "../../components/TextButton";
import {
  createRealMediaGoldDevelopmentDataset,
  serializeRealMediaGoldDevelopmentDataset,
  type RealMediaGoldDevelopmentDataset
} from "../../domain/alignment/realMediaGoldDevelopmentDataset";
import {
  parseRealMediaGoldBenchmarkBundleJson,
  type RealMediaGoldBenchmarkBundle
} from "../../domain/alignment/realMediaGoldBenchmarkBundle";
import {
  downloadTextFile,
  readFilesAsText
} from "../../infrastructure/file-system/browserFiles";

interface LoadedBundle {
  fileName: string;
  bundle: RealMediaGoldBenchmarkBundle;
}

interface RealMediaGoldDatasetPanelProps {
  downloader?: typeof downloadTextFile;
}

interface DatasetDraftResult {
  dataset: RealMediaGoldDevelopmentDataset | null;
  error: string | null;
}

export function RealMediaGoldDatasetPanel({
  downloader = downloadTextFile
}: RealMediaGoldDatasetPanelProps) {
  const [open, setOpen] = useState(false);
  const [loadedBundles, setLoadedBundles] = useState<LoadedBundle[]>([]);
  const [reading, setReading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);
  const [datasetId, setDatasetId] = useState("local-reviewed-development");
  const [datasetName, setDatasetName] = useState("本机复核 development 数据集");
  const [datasetVersion, setDatasetVersion] = useState("development-v1");
  const [description, setDescription] = useState(
    "由多个已复核的单 case 治理 bundle 确定合并。"
  );
  const [licenseNotes, setLicenseNotes] = useState("仅限获授权本机开发验收。");

  const draft = useMemo<DatasetDraftResult>(() => {
    if (loadedBundles.length < 2) return { dataset: null, error: null };
    try {
      return {
        dataset: createRealMediaGoldDevelopmentDataset({
          metadata: {
            id: datasetId,
            name: datasetName,
            datasetVersion,
            description,
            licenseNotes: splitNonEmptyLines(licenseNotes)
          },
          bundles: loadedBundles.map((item) => item.bundle)
        }),
        error: null
      };
    } catch (error: unknown) {
      return { dataset: null, error: formatError(error) };
    }
  }, [datasetId, datasetName, datasetVersion, description, licenseNotes, loadedBundles]);

  const loadBundles = async (files: FileList): Promise<void> => {
    setReading(true);
    setLoadError(null);
    setDownloadStatus(null);
    try {
      const loaded = await readFilesAsText(files);
      const parsed = loaded.map(({ file, text }) => ({
        fileName: file.name,
        bundle: parseRealMediaGoldBenchmarkBundleJson(text)
      }));
      setLoadedBundles(parsed);
    } catch (error: unknown) {
      setLoadedBundles([]);
      setLoadError(formatError(error));
    } finally {
      setReading(false);
    }
  };

  const downloadDataset = (): void => {
    if (!draft.dataset) return;
    try {
      const fileName = downloader(
        `c137-${safeToken(draft.dataset.manifest.id)}-${safeToken(draft.dataset.manifest.datasetVersion)}-development-dataset.json`,
        serializeRealMediaGoldDevelopmentDataset(draft.dataset),
        "application/json;charset=utf-8"
      );
      setDownloadStatus(`已下载：${fileName}`);
    } catch (error: unknown) {
      setDownloadStatus(`下载失败：${formatError(error)}`);
    }
  };

  return (
    <section
      className="rounded border border-panel-line/80 bg-black/15 p-2"
      aria-label="多 case development 数据集"
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="flex items-center gap-2 font-medium text-slate-200">
          <Files size={14} className="text-accent-cyan" aria-hidden="true" />
          3. 合并多个已复核 case（development）
        </span>
        <span className="rounded border border-panel-line px-2 py-1 text-[11px] text-slate-400">
          {open ? "收起" : "展开"}
        </span>
      </button>

      {open ? (
        <div className="mt-3 grid gap-3">
          <p className="leading-5 text-slate-400">
            一次选择 2–1000 个由上一步导出的单 case 治理 bundle。应用会验证每份证明、阻止重复
            case/媒体关系，并生成确定顺序的本机 development 数据集。
          </p>
          <p className="rounded border border-amber-400/30 bg-amber-400/10 p-2 leading-5 text-amber-100">
            生成文件内含本地绝对路径、媒体身份和复核记录，不适合直接分享；它始终
            releaseEligible=false，也不会被计作 frozen-test 或“20 组北极星采集”。
          </p>

          <label className="grid gap-1.5 text-slate-400">
            <span className="font-medium text-slate-300">
              选择单 case 治理 bundle（可多选）
            </span>
            <input
              type="file"
              multiple
              accept=".json,application/json"
              disabled={reading}
              aria-label="选择多个单 case 治理 bundle"
              className="rounded border border-panel-line bg-black/20 p-2 text-slate-300 file:mr-3 file:rounded file:border file:border-panel-line file:bg-panel-soft file:px-2 file:py-1 file:text-xs file:text-slate-200"
              onChange={(event) => {
                const files = event.currentTarget.files;
                event.currentTarget.value = "";
                if (files && files.length > 0) void loadBundles(files);
              }}
            />
          </label>

          {loadError ? (
            <p
              className="rounded border border-red-400/35 bg-red-400/10 p-2 text-red-100"
              role="alert"
            >
              无法读取治理 bundle：{loadError}
            </p>
          ) : null}

          {loadedBundles.length > 0 ? (
            <div className="grid gap-2 rounded border border-panel-line/70 bg-black/20 p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium text-slate-200">
                  已载入 {loadedBundles.length} 个单 case bundle
                </p>
                <TextButton
                  disabled={reading}
                  onClick={() => {
                    setLoadedBundles([]);
                    setLoadError(null);
                    setDownloadStatus(null);
                  }}
                >
                  <Trash2 size={13} />
                  清除
                </TextButton>
              </div>
              <ul className="grid gap-1 text-slate-500">
                {loadedBundles.map((item) => (
                  <li
                    key={`${item.fileName}-${item.bundle.bundleDigest}`}
                    className="break-all"
                  >
                    {item.bundle.manifest.cases[0]?.id ?? "未知 case"} · {item.fileName}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2">
            <DatasetInput label="数据集 ID" value={datasetId} onChange={setDatasetId} />
            <DatasetInput label="数据集名称" value={datasetName} onChange={setDatasetName} />
            <DatasetInput
              label="数据集版本"
              value={datasetVersion}
              onChange={setDatasetVersion}
            />
            <DatasetInput label="描述" value={description} onChange={setDescription} />
          </div>
          <label className="grid gap-1.5 text-slate-400">
            <span>授权说明（每行一条）</span>
            <textarea
              value={licenseNotes}
              aria-label="development 数据集授权说明"
              className="min-h-16 rounded border border-panel-line bg-black/20 px-2 py-1.5 text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-cyan"
              onChange={(event) => setLicenseNotes(event.currentTarget.value)}
            />
          </label>

          {draft.error ? (
            <p
              className="rounded border border-red-400/35 bg-red-400/10 p-2 leading-5 text-red-100"
              role="alert"
            >
              无法合并：{draft.error}
            </p>
          ) : null}
          {draft.dataset ? <DatasetCoverage dataset={draft.dataset} /> : null}

          <div className="flex flex-wrap items-center gap-2">
            <TextButton
              tone="primary"
              disabled={!draft.dataset || reading}
              onClick={downloadDataset}
            >
              <Download size={13} />
              下载多 case development 数据集
            </TextButton>
            {loadedBundles.length < 2 ? (
              <span className="text-slate-500">至少选择 2 个 bundle 后才能合并。</span>
            ) : null}
          </div>
          {downloadStatus ? (
            <p className="break-all text-slate-400" role="status">
              {downloadStatus}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function DatasetInput({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5 text-slate-400">
      <span>{label}</span>
      <input
        value={value}
        aria-label={label}
        className="rounded border border-panel-line bg-black/20 px-2 py-1.5 text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-cyan"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function DatasetCoverage({ dataset }: { dataset: RealMediaGoldDevelopmentDataset }) {
  const scenarios = Object.entries(dataset.coverage.scenarioCaseCounts).filter(
    ([, count]) => count > 0
  );
  return (
    <section
      className="rounded border border-emerald-400/30 bg-emerald-400/10 p-2"
      aria-label="合并覆盖摘要"
    >
      <p className="font-medium text-emerald-100">
        可生成：{dataset.coverage.caseCount} 个 development case
      </p>
      <p className="mt-1 leading-5 text-emerald-100/80">
        双端媒体身份：源 {dataset.coverage.distinctSourceBindingCount} / 目标{" "}
        {dataset.coverage.distinctTargetBindingCount}
        ；复核者 {dataset.coverage.distinctReviewerCount}；source-only{" "}
        {dataset.coverage.sourceOnlyEventCount}
        ，target-only {dataset.coverage.targetOnlyEventCount}，ambiguous{" "}
        {dataset.coverage.ambiguousEventCount}。
      </p>
      <p className="mt-1 text-emerald-100/70">
        场景：
        {scenarios.map(([scenario, count]) => `${scenario} ${count}`).join(" · ") || "未标注"}
      </p>
      <p className="mt-1 break-all text-emerald-100/60">
        dataset digest：{dataset.datasetDigest}
      </p>
    </section>
  );
}

function splitNonEmptyLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function safeToken(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "dataset"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
