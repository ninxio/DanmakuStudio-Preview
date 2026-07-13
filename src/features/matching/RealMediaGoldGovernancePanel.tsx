import { Download, Scale } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { TextButton } from "../../components/TextButton";
import { assessMediaTimeMapVerification } from "../../domain/alignment/mediaTimeMap";
import {
  createRealMediaGoldBenchmarkBundle,
  serializeRealMediaGoldBenchmarkBundle
} from "../../domain/alignment/realMediaGoldBenchmarkBundle";
import {
  assertRealMediaGoldFreezeReceiptMatchesCase,
  collectRealMediaGoldDisagreements,
  createRealMediaGoldAnnotationEnvelope,
  freezeRealMediaGoldCase,
  parseRealMediaGoldAnnotationEnvelopeJson,
  serializeRealMediaGoldAnnotationEnvelope,
  serializeRealMediaGoldFreezeReceipt,
  type RealMediaGoldAnnotationEnvelope,
  type RealMediaGoldDigest,
  type RealMediaGoldMediaBinding,
  type RealMediaGoldReviewVerification
} from "../../domain/alignment/realMediaGoldGovernance";
import {
  createRealMediaBenchmarkContentIdentity,
  createRealMediaBenchmarkGoldFromConfirmedTimeMap
} from "../../domain/alignment/realMediaGoldFromTimeMap";
import {
  REAL_MEDIA_BENCHMARK_SCHEMA_VERSION,
  validateRealMediaBenchmarkManifest,
  type RealMediaBenchmarkManifest
} from "../../domain/alignment/realMediaBenchmark";
import { deriveRealMediaBenchmarkScenarios } from "../../domain/alignment/realMediaBenchmarkScenarios";
import type {
  EditorProject,
  MediaTimeMap,
  ProjectMediaReference
} from "../../domain/project/types";
import {
  downloadTextFile,
  downloadTextFiles,
  readFilesAsText,
  readTextFile,
  type DownloadTextFilesResult
} from "../../infrastructure/file-system/browserFiles";
import {
  probeTauriMediaTimeline,
  type MediaTimelineProbeInvoker,
  type MediaTimelineProbeResult
} from "../../infrastructure/media/tauriMediaProbe";
import { loadAppSettings } from "../../infrastructure/settings/appSettings";

type TimelineProbe = (
  request: Parameters<typeof probeTauriMediaTimeline>[0],
  invoker?: MediaTimelineProbeInvoker
) => Promise<MediaTimelineProbeResult>;

interface RealMediaGoldGovernancePanelProps {
  project: EditorProject | null;
  desktopAvailable: boolean;
  timelineProbe?: TimelineProbe;
  downloadAnnotation?: typeof downloadTextFile;
  downloadBundle?: typeof downloadTextFiles;
}

export function RealMediaGoldGovernancePanel({
  project,
  desktopAvailable,
  timelineProbe = probeTauriMediaTimeline,
  downloadAnnotation = downloadTextFile,
  downloadBundle = downloadTextFiles
}: RealMediaGoldGovernancePanelProps) {
  const [open, setOpen] = useState(false);
  const [selectedMapId, setSelectedMapId] = useState("");
  const [caseId, setCaseId] = useState("");
  const [toleranceText, setToleranceText] = useState("80");
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const [annotationStatus, setAnnotationStatus] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<RealMediaGoldAnnotationEnvelope[]>([]);
  const [annotationFileNames, setAnnotationFileNames] = useState<string[]>([]);
  const [adjudication, setAdjudication] = useState<RealMediaGoldAnnotationEnvelope | null>(
    null
  );
  const [selectedConsensusDigest, setSelectedConsensusDigest] = useState("");
  const [caseTitle, setCaseTitle] = useState("");
  const [sourceLicense, setSourceLicense] = useState("");
  const [targetLicense, setTargetLicense] = useState("");
  const [datasetLicense, setDatasetLicense] = useState("");
  const [freezeBusy, setFreezeBusy] = useState(false);
  const [freezeStatus, setFreezeStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const confirmedRelations = useMemo(
    () =>
      project?.mediaTimeMaps.filter(
        (timeMap) =>
          timeMap.state === "confirmed" &&
          findProjectMedia(project, timeMap.sourceMediaId)?.localPath &&
          findProjectMedia(project, timeMap.targetMediaId)?.localPath
      ) ?? [],
    [project]
  );
  const disagreements = useMemo(
    () => (annotations.length >= 2 ? collectRealMediaGoldDisagreements(annotations) : []),
    [annotations]
  );

  useEffect(() => {
    if (confirmedRelations.some((timeMap) => timeMap.id === selectedMapId)) return;
    setSelectedMapId(confirmedRelations[0]?.id ?? "");
  }, [confirmedRelations, selectedMapId]);

  useEffect(() => {
    setSelectedConsensusDigest("");
    if (annotations[0]) {
      setCaseId(annotations[0].caseId);
      setCaseTitle((current) => current || annotations[0]?.caseId || "");
    }
  }, [annotations]);

  const exportAnnotation = async (): Promise<void> => {
    if (!project || !desktopAvailable || annotationBusy) return;
    setError(null);
    setAnnotationStatus(null);
    const timeMap = confirmedRelations.find((item) => item.id === selectedMapId);
    if (!timeMap) {
      setError("请选择一条已确认并连接本地媒体的时间关系。");
      return;
    }
    const verification = assessMediaTimeMapVerification(timeMap);
    if (
      !verification.trusted ||
      timeMap.verification?.method !== "manual-review" ||
      timeMap.verification.recordVersion !== 2
    ) {
      setError(
        `该关系尚未完成受信的逐段 A/B 人工复核，不能作为独立 Gold 标注：${verification.reason ?? "缺少人工复核签名。"}`
      );
      return;
    }
    const boundaryToleranceMs = Number(toleranceText);
    if (
      !Number.isSafeInteger(boundaryToleranceMs) ||
      boundaryToleranceMs < 40 ||
      boundaryToleranceMs > 100
    ) {
      setError("真实媒体边界容差必须是 40–100ms 的整数。");
      return;
    }
    if (!caseId.trim()) {
      setError("请填写稳定 case ID。");
      return;
    }
    const sourceMedia = findProjectMedia(project, timeMap.sourceMediaId);
    const targetMedia = findProjectMedia(project, timeMap.targetMediaId);
    if (!sourceMedia?.localPath || !targetMedia?.localPath) {
      setError("该关系的两端媒体必须仍连接到素材页已导入的本地路径。");
      return;
    }
    setAnnotationBusy(true);
    try {
      const settings = loadAppSettings().alignment;
      const [sourceProbe, targetProbe] = await Promise.all([
        timelineProbe({
          path: sourceMedia.localPath,
          ffmpegPath: settings.ffmpegPath.trim() || null
        }),
        timelineProbe({
          path: targetMedia.localPath,
          ffmpegPath: settings.ffmpegPath.trim() || null
        })
      ]);
      const sourceBinding = createBinding(timeMap, "source", sourceProbe);
      const targetBinding = createBinding(timeMap, "target", targetProbe);
      const reviewVerification = createGoldReviewVerification(timeMap);
      const envelope = createRealMediaGoldAnnotationEnvelope({
        caseId: caseId.trim(),
        reviewerId: reviewVerification.verifier,
        reviewVerification,
        boundaryToleranceMs,
        source: sourceBinding,
        target: targetBinding,
        gold: createRealMediaBenchmarkGoldFromConfirmedTimeMap(timeMap)
      });
      const fileName = downloadAnnotation(
        `c137-${safeToken(envelope.caseId)}-${safeToken(envelope.reviewerId)}-annotation.json`,
        serializeRealMediaGoldAnnotationEnvelope(envelope),
        "application/json;charset=utf-8"
      );
      setAnnotationStatus(
        `已生成路径无关的独立标注 ${fileName}；请由另一名 reviewer 在独立项目副本中重复 A/B 复核。`
      );
    } catch (reason: unknown) {
      setError(formatError(reason));
    } finally {
      setAnnotationBusy(false);
    }
  };

  const loadIndependentAnnotations = async (files: FileList | File[]): Promise<void> => {
    setError(null);
    setFreezeStatus(null);
    setAdjudication(null);
    try {
      const loaded = await readFilesAsText(files);
      if (loaded.length !== 2) {
        throw new Error("冻结前必须一次选择恰好两份独立标注 JSON。");
      }
      const parsed = loaded.map((item) => parseRealMediaGoldAnnotationEnvelopeJson(item.text));
      collectRealMediaGoldDisagreements(parsed);
      setAnnotations(parsed);
      setAnnotationFileNames(loaded.map((item) => item.file.name));
    } catch (reason: unknown) {
      setAnnotations([]);
      setAnnotationFileNames([]);
      setError(formatError(reason));
    }
  };

  const loadAdjudication = async (file: File): Promise<void> => {
    setError(null);
    try {
      setAdjudication(parseRealMediaGoldAnnotationEnvelopeJson(await readTextFile(file)));
    } catch (reason: unknown) {
      setAdjudication(null);
      setError(formatError(reason));
    }
  };

  const freezeCase = (): void => {
    if (!project || freezeBusy || annotations.length !== 2) return;
    setError(null);
    setFreezeStatus(null);
    setFreezeBusy(true);
    try {
      const first = annotations[0];
      if (!first) throw new Error("缺少独立标注。");
      const sourceMedia = findMediaByBinding(project, first.source, "bilibiliReference");
      const targetMedia = findMediaByBinding(project, first.target, "targetOriginal");
      if (!sourceMedia?.localPath || !targetMedia?.localPath) {
        throw new Error("两份标注绑定的媒体未在当前项目中唯一连接；请回素材页重新连接原路径。");
      }
      if (
        !caseTitle.trim() ||
        !sourceLicense.trim() ||
        !targetLicense.trim() ||
        !datasetLicense.trim()
      ) {
        throw new Error("生成治理候选前必须填写关系标题及来源、原片和数据集许可说明。");
      }
      const finalGold =
        disagreements.length === 0
          ? annotations.find((item) => item.annotationDigest === selectedConsensusDigest)?.gold
          : adjudication?.gold;
      if (!finalGold) {
        throw new Error(
          disagreements.length === 0
            ? "请选择两份独立标注之一作为共识 Gold。"
            : "标注存在超容差分歧，必须导入第三名 reviewer 的仲裁标注。"
        );
      }
      if (disagreements.length > 0 && adjudication) {
        assertAdjudicationMatchesCase(adjudication, first);
      }
      const scenarios = deriveRealMediaBenchmarkScenarios(
        finalGold,
        first.source.contentIdentity,
        first.target.contentIdentity
      );
      const result = freezeRealMediaGoldCase({
        annotations,
        caseInput: {
          id: first.caseId,
          title: caseTitle.trim(),
          split: "development",
          scenarios,
          source: {
            path: sourceMedia.localPath,
            ...first.source,
            versionNote: createVersionNote(sourceMedia, first.source),
            licenseNote: sourceLicense.trim()
          },
          target: {
            path: targetMedia.localPath,
            ...first.target,
            versionNote: createVersionNote(targetMedia, first.target),
            licenseNote: targetLicense.trim()
          },
          boundaryToleranceMs: first.boundaryToleranceMs,
          versionNotes: ["由两份本机 A/B 标注及显式共识/仲裁结果生成治理候选。"],
          licenseNotes: [sourceLicense.trim(), targetLicense.trim()]
        },
        resolution:
          disagreements.length === 0
            ? {
                kind: "consensus",
                selectedAnnotationDigest: selectedConsensusDigest as `sha256:${string}`,
                note: "两名 reviewer 的全部坐标均位于预注册容差内，显式选择共识 Gold。"
              }
            : {
                kind: "adjudicated",
                adjudicationAnnotation: adjudication ?? first,
                note: "两份独立标注存在超容差或结构分歧，由第三名 reviewer 完成仲裁。"
              }
      });
      assertRealMediaGoldFreezeReceiptMatchesCase(
        result.receipt,
        annotations,
        result.manifestCase,
        disagreements.length > 0 ? adjudication : null
      );
      const manifest: RealMediaBenchmarkManifest = {
        schemaVersion: REAL_MEDIA_BENCHMARK_SCHEMA_VERSION,
        id: `c137-governed-${safeToken(first.caseId)}-${result.receipt.receiptDigest.slice(7, 19)}`,
        name: `${caseTitle.trim()} · 本机治理候选基准`,
        datasetVersion: `gold-v1-${result.receipt.receiptDigest.slice(7, 19)}`,
        description:
          "由本机人工复核元数据、确定性差异检查和显式共识或第三人仲裁生成；无跨机 trust root，仅限 development。",
        isExample: false,
        licenseNotes: [datasetLicense.trim()],
        cases: [result.manifestCase]
      };
      const validation = validateRealMediaBenchmarkManifest(manifest);
      if (!validation.valid) {
        throw new Error(`冻结后的 manifest 无效：${validation.issues.join("；")}`);
      }
      const bundle = createRealMediaGoldBenchmarkBundle({
        manifest,
        annotations,
        adjudicationAnnotation: disagreements.length > 0 ? adjudication : null,
        receipt: result.receipt
      });
      const files = [
        {
          fileName: "governed-benchmark-bundle.json",
          content: serializeRealMediaGoldBenchmarkBundle(bundle)
        },
        ...annotations.map((annotation, index) => ({
          fileName: `annotation-${index + 1}-${safeToken(annotation.reviewerId)}.json`,
          content: serializeRealMediaGoldAnnotationEnvelope(annotation)
        })),
        ...(adjudication
          ? [
              {
                fileName: `adjudication-${safeToken(adjudication.reviewerId)}.json`,
                content: serializeRealMediaGoldAnnotationEnvelope(adjudication)
              }
            ]
          : []),
        {
          fileName: "gold-freeze-receipt.json",
          content: serializeRealMediaGoldFreezeReceipt(result.receipt)
        },
        {
          fileName: "benchmark-manifest.json",
          content: `${JSON.stringify(manifest, null, 2)}\n`
        },
        {
          fileName: "LOCAL-RUN-PACKAGE-README.txt",
          content:
            "本包仅供当前机器运行 C137 development。benchmark-manifest.json 与 governed-benchmark-bundle.json 含本机绝对媒体路径，不可分享。\r\n请在应用中载入 governed-benchmark-bundle.json；当前 raw manifest 和本机 bundle 都不能运行 formal frozen-test。\r\nreceipt/bundle 仅证明文件内部自洽，不能认证现实人员身份，也不授予 release 资格。\r\n"
        }
      ];
      const downloaded = downloadBundle(
        files,
        "application/json;charset=utf-8",
        `c137-${safeToken(first.caseId)}-governed-gold.zip`
      );
      setFreezeStatus(formatBundleStatus(downloaded));
    } catch (reason: unknown) {
      setError(formatError(reason));
    } finally {
      setFreezeBusy(false);
    }
  };

  return (
    <section
      className="rounded border border-panel-line/80 bg-black/15 p-3"
      aria-label="C137 Gold 治理"
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="flex items-center gap-2 font-medium text-slate-200">
          <Scale size={14} className="text-accent-cyan" aria-hidden="true" />
          建立真实 Gold：双人独立标注与冻结（development 候选）
        </span>
        <span className="rounded border border-panel-line px-2 py-1 text-[11px] text-slate-400">
          {open ? "收起" : "展开"}
        </span>
      </button>

      {open ? (
        <div className="mt-3 grid gap-4">
          <p className="rounded border border-amber-400/30 bg-amber-400/10 p-2 leading-5 text-amber-100">
            这里不会重新选择视频。标注始终绑定素材页已导入路径、全文件 SHA-256、明确音频流和受信
            A/B 复核；两份标注不能互相覆盖，超出容差必须第三人仲裁。 当前 receipt
            只能证明文件内部自洽，不能认证现实中的人员身份，也不能单独授予 release 或 formal
            frozen-test 资格。
          </p>

          <section
            className="grid gap-2 rounded border border-panel-line/70 p-3"
            aria-label="生成独立 Gold 标注"
          >
            <h4 className="font-medium text-slate-100">1. 每名 reviewer 独立生成标注</h4>
            {confirmedRelations.length === 0 ? (
              <p className="leading-5 text-slate-500">
                当前没有已确认且仍连接本地媒体的时间关系。先在匹配页完成逐段 A/B
                复核和人工签发。
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <LabeledSelect
                  label="已确认关系"
                  value={selectedMapId}
                  onChange={setSelectedMapId}
                >
                  {confirmedRelations.map((timeMap) => (
                    <option key={timeMap.id} value={timeMap.id}>
                      {project ? describeRelation(project, timeMap) : timeMap.id}
                    </option>
                  ))}
                </LabeledSelect>
                <LabeledInput
                  label="稳定 case ID"
                  value={caseId}
                  onChange={setCaseId}
                  placeholder="series-s01e01-v1"
                />
                <p className="grid content-center gap-1.5 text-slate-400">
                  <span className="font-medium text-slate-300">reviewer 身份</span>
                  <span>沿用该关系人工签发记录中的 verifier，不接受手工改名。</span>
                </p>
                <LabeledInput
                  label="边界容差（40–100ms）"
                  value={toleranceText}
                  onChange={setToleranceText}
                  inputMode="numeric"
                />
              </div>
            )}
            <div>
              <TextButton
                tone="primary"
                disabled={
                  !desktopAvailable || confirmedRelations.length === 0 || annotationBusy
                }
                onClick={() => void exportAnnotation()}
              >
                <Download size={13} />
                {annotationBusy ? "正在核对媒体身份…" : "下载独立标注 JSON"}
              </TextButton>
            </div>
            {annotationStatus ? (
              <p className="leading-5 text-emerald-100" role="status">
                {annotationStatus}
              </p>
            ) : null}
          </section>

          <section
            className="grid gap-2 rounded border border-panel-line/70 p-3"
            aria-label="生成 Gold development 治理候选"
          >
            <h4 className="font-medium text-slate-100">
              2. 比较两份标注并生成 development 治理候选
            </h4>
            <label className="grid gap-1.5 text-slate-400">
              <span className="font-medium text-slate-300">一次选择两份独立标注 JSON</span>
              <input
                type="file"
                multiple
                accept=".json,application/json"
                aria-label="选择两份独立 Gold 标注"
                className="rounded border border-panel-line bg-black/20 p-2"
                onChange={(event) => {
                  const files = event.currentTarget.files;
                  event.currentTarget.value = "";
                  if (files) void loadIndependentAnnotations(files);
                }}
              />
            </label>
            {annotations.length === 2 ? (
              <div className="grid gap-2">
                <p className="leading-5 text-slate-300">
                  已读取 {annotationFileNames.join("、")}；reviewer：
                  {annotations.map((item) => item.reviewerId).join("、")}。
                </p>
                {disagreements.length === 0 ? (
                  <fieldset className="grid gap-1 rounded border border-emerald-400/25 bg-emerald-400/5 p-2">
                    <legend className="px-1 text-emerald-100">
                      全部坐标在容差内，请显式选择最终 Gold
                    </legend>
                    {annotations.map((annotation) => (
                      <label
                        key={annotation.annotationDigest}
                        className="flex items-center gap-2"
                      >
                        <input
                          type="radio"
                          name="consensus-gold"
                          checked={selectedConsensusDigest === annotation.annotationDigest}
                          onChange={() =>
                            setSelectedConsensusDigest(annotation.annotationDigest)
                          }
                        />
                        {annotation.reviewerId} · {annotation.annotationDigest.slice(0, 20)}…
                      </label>
                    ))}
                  </fieldset>
                ) : (
                  <div className="grid gap-2 rounded border border-amber-400/30 bg-amber-400/10 p-2 text-amber-100">
                    <p>发现 {disagreements.length} 个超容差或结构分歧，禁止共识冻结。</p>
                    <ul className="list-disc pl-5">
                      {disagreements.slice(0, 8).map((item) => (
                        <li key={`${item.path}-${item.annotationDigests.join("-")}`}>
                          {item.path}：
                          {item.reason === "missing" ? "一侧缺失" : `相差 ${item.deltaMs}ms`}
                        </li>
                      ))}
                    </ul>
                    <label className="grid gap-1.5">
                      <span className="font-medium">导入第三名 reviewer 的仲裁标注</span>
                      <input
                        type="file"
                        accept=".json,application/json"
                        aria-label="选择第三人仲裁 Gold 标注"
                        className="rounded border border-amber-300/30 bg-black/20 p-2"
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = "";
                          if (file) void loadAdjudication(file);
                        }}
                      />
                    </label>
                    {adjudication ? <p>仲裁者：{adjudication.reviewerId}。</p> : null}
                  </div>
                )}
                <div className="grid gap-2 sm:grid-cols-2">
                  <LabeledInput
                    label="关系标题"
                    value={caseTitle}
                    onChange={setCaseTitle}
                    placeholder="第 1 集：参考版 ↔ 原片"
                  />
                  <p className="grid content-center gap-1.5 text-slate-400">
                    <span className="font-medium text-slate-300">数据划分</span>
                    <span>
                      development（当前 HMAC 无跨机信任根，禁止生成 formal frozen-test）
                    </span>
                  </p>
                  <LabeledInput
                    label="参考素材许可说明"
                    value={sourceLicense}
                    onChange={setSourceLicense}
                    placeholder="合法本地测试依据与限制"
                  />
                  <LabeledInput
                    label="原片许可说明"
                    value={targetLicense}
                    onChange={setTargetLicense}
                    placeholder="合法本地测试依据与限制"
                  />
                  <div className="sm:col-span-2">
                    <LabeledInput
                      label="数据集许可与保密说明"
                      value={datasetLicense}
                      onChange={setDatasetLicense}
                      placeholder="媒体不进入仓库；仅保存哈希、标注与本地路径清单"
                    />
                  </div>
                </div>
                <p className="rounded border border-panel-line/70 p-2 leading-5 text-slate-300">
                  场景标签由 Gold
                  结构、双端身份和时长确定性派生，不接受操作员自由勾选。多音轨、视觉回退、重复内容与
                  PTS 场景尚缺可签名的 probe evidence，本工具不会宣称这些覆盖率。
                </p>
                <p className="rounded border border-amber-400/30 bg-amber-400/10 p-2 leading-5 text-amber-100">
                  下载的是本机运行包：manifest
                  含本机绝对媒体路径，不可分享。可分享报告仍会移除路径；治理 receipt
                  仅提供未受外部信任的自洽性证明。
                </p>
                <div>
                  <TextButton
                    tone="primary"
                    disabled={
                      freezeBusy ||
                      (disagreements.length === 0 && !selectedConsensusDigest) ||
                      (disagreements.length > 0 && !adjudication)
                    }
                    onClick={freezeCase}
                  >
                    <Download size={13} />
                    {freezeBusy ? "正在生成…" : "下载本机 development 治理包（不可分享）"}
                  </TextButton>
                </div>
                {freezeStatus ? (
                  <p className="leading-5 text-emerald-100" role="status">
                    {freezeStatus}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="leading-5 text-slate-500">尚未导入两份可比较的标注。</p>
            )}
          </section>

          {error ? (
            <p
              className="rounded border border-red-400/35 bg-red-400/10 p-2 leading-5 text-red-100"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function createBinding(
  timeMap: MediaTimeMap,
  side: "source" | "target",
  probe: MediaTimelineProbeResult
): RealMediaGoldMediaBinding {
  const stream = side === "source" ? timeMap.sourceStream : timeMap.targetStream;
  const expectedIdentity = createRealMediaBenchmarkContentIdentity(
    side === "source" ? timeMap.sourceIdentity : timeMap.targetIdentity
  );
  const actualIdentity = createRealMediaBenchmarkContentIdentity(probe.contentIdentity);
  if (
    expectedIdentity.sizeBytes !== actualIdentity.sizeBytes ||
    expectedIdentity.digest !== actualIdentity.digest
  ) {
    throw new Error(
      `${side === "source" ? "参考" : "原片"}媒体自确认后已发生变化，必须重新分析。`
    );
  }
  if (
    !stream ||
    stream.type !== "audio" ||
    !probe.audioStreams.some((item) => item.index === stream.index)
  ) {
    throw new Error(`${side === "source" ? "参考" : "原片"}媒体缺少时间图绑定的实际音频流。`);
  }
  return {
    contentIdentity: actualIdentity,
    audioStreamIndex: stream.index,
    videoStreamIndex: null
  };
}

function createGoldReviewVerification(timeMap: MediaTimeMap): RealMediaGoldReviewVerification {
  const record = timeMap.verification;
  if (!record || record.recordVersion !== 2 || record.method !== "manual-review") {
    throw new Error("当前时间关系没有可绑定的 v2 人工复核签名。");
  }
  return {
    recordVersion: 2,
    method: "manual-review",
    verificationId: record.verificationId,
    issuerKeyId: record.issuerKeyId,
    issuerSequence: record.issuerSequence,
    signatureAlgorithm: record.signatureAlgorithm,
    signature: record.signature,
    requestDigest: toGoldDigest(record.requestDigest, "人工复核 requestDigest"),
    reviewEvidenceDigest: toGoldDigest(
      record.reviewEvidenceDigest,
      "人工复核 reviewEvidenceDigest"
    ),
    verifier: record.verifier
  };
}

function toGoldDigest(value: string, label: string): RealMediaGoldDigest {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} 不是规范的小写 SHA-256 摘要。`);
  }
  return value as RealMediaGoldDigest;
}

function findProjectMedia(
  project: EditorProject,
  mediaId: string
): ProjectMediaReference | undefined {
  return project.mediaLibrary.find((media) => media.id === mediaId);
}

function findMediaByBinding(
  project: EditorProject,
  binding: RealMediaGoldMediaBinding,
  role: ProjectMediaReference["role"]
): ProjectMediaReference | null {
  const matches = project.mediaLibrary.filter((media) => {
    if (media.role !== role || !media.localPath) return false;
    try {
      const identity = createRealMediaBenchmarkContentIdentity(media.contentIdentity);
      return (
        identity.sizeBytes === binding.contentIdentity.sizeBytes &&
        identity.digest === binding.contentIdentity.digest
      );
    } catch {
      return false;
    }
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function assertAdjudicationMatchesCase(
  adjudication: RealMediaGoldAnnotationEnvelope,
  first: RealMediaGoldAnnotationEnvelope
): void {
  if (
    adjudication.caseId !== first.caseId ||
    adjudication.boundaryToleranceMs !== first.boundaryToleranceMs ||
    JSON.stringify(adjudication.source) !== JSON.stringify(first.source) ||
    JSON.stringify(adjudication.target) !== JSON.stringify(first.target)
  ) {
    throw new Error("第三人仲裁标注必须绑定同一 case、双端全文件身份、显式流和边界容差。");
  }
}

function createVersionNote(
  media: ProjectMediaReference,
  binding: RealMediaGoldMediaBinding
): string {
  return `${media.fileName}；音频流 #${binding.audioStreamIndex}；视频流 ${binding.videoStreamIndex === null ? "无" : `#${binding.videoStreamIndex}`}；${media.sourceSummary}`;
}

function describeRelation(project: EditorProject, timeMap: MediaTimeMap): string {
  const source =
    findProjectMedia(project, timeMap.sourceMediaId)?.name ?? timeMap.sourceMediaId;
  const target =
    findProjectMedia(project, timeMap.targetMediaId)?.name ?? timeMap.targetMediaId;
  return `${target} ← ${source}`;
}

function safeToken(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "case"
  );
}

function formatBundleStatus(result: DownloadTextFilesResult): string {
  return result.archiveFileName
    ? `已下载本机治理运行包 ${result.archiveFileName}；它含绝对路径，不可分享。`
    : `已下载治理文件 ${result.downloadedFileName ?? ""}。`;
}

function formatError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  inputMode
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputMode?: "numeric";
}) {
  return (
    <label className="grid gap-1.5 text-slate-400">
      <span className="font-medium text-slate-300">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        className="rounded border border-panel-line bg-black/20 px-2 py-1.5 text-slate-200"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function LabeledSelect({
  label,
  value,
  onChange,
  children
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-slate-400">
      <span className="font-medium text-slate-300">{label}</span>
      <select
        value={value}
        className="rounded border border-panel-line bg-[#111318] px-2 py-1.5 text-slate-200"
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {children}
      </select>
    </label>
  );
}
