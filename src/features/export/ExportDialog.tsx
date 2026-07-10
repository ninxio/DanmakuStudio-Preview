import { Download, X } from "lucide-react";
import { IconButton } from "../../components/IconButton";
import { TextButton } from "../../components/TextButton";
import {
  createCompensationReport,
  formatSignedCompensationDuration,
  type ExportCompensationDetail
} from "../../domain/danmaku/exportSummary";
import {
  createProjectHealthReport,
  createProjectHealthSummary,
  type ProjectHealthFinding,
  type ProjectHealthStatus,
  type ProjectHealthSummary
} from "../../domain/project/health";
import { formatTimecode } from "../../domain/shared/time";
import { downloadTextFile } from "../../infrastructure/file-system/browserFiles";
import { useEditorStore } from "../../stores/editorStore";

export function ExportDialog() {
  const project = useEditorStore((state) => state.project);
  const exportDraft = useEditorStore((state) => state.exportDraft);
  const clearExport = useEditorStore((state) => state.clearExport);
  if (!exportDraft) {
    return null;
  }
  const { summary, validation } = exportDraft;
  const healthSummary = createProjectHealthSummary(project);
  const previewCompensations = summary.compensationDetails.slice(0, 3);
  const hiddenCompensationCount = Math.max(0, summary.compensationDetails.length - previewCompensations.length);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65" role="dialog" aria-modal="true">
      <div className="flex max-h-[86vh] w-[560px] flex-col rounded border border-panel-line bg-panel-raised shadow-2xl" data-testid="export-dialog">
        <header className="flex h-12 items-center justify-between border-b border-panel-line px-4">
          <h2 className="text-sm font-semibold">导出 XML 摘要</h2>
          <IconButton label="关闭导出摘要" icon={<X size={16} />} onClick={clearExport} />
        </header>
        <div className="thin-scrollbar grid gap-3 overflow-auto p-4 text-sm">
          <SummaryRow label="原始弹幕数量" value={summary.originalCount.toLocaleString("zh-CN")} />
          <SummaryRow label="启用弹幕数量" value={summary.enabledCount.toLocaleString("zh-CN")} />
          <SummaryRow label="禁用弹幕数量" value={summary.disabledCount.toLocaleString("zh-CN")} />
          <SummaryRow label="最早最终时间" value={formatTimecode(summary.earliestFinalTimeMs)} />
          <SummaryRow label="最晚最终时间" value={formatTimecode(summary.latestFinalTimeMs)} />
          <SummaryRow label="应用删减标记" value={summary.cutMarkerCount.toString()} />
          <SummaryRow label="总补偿时长" value={formatSignedCompensationDuration(summary.totalCutGapMs)} />
          <SummaryRow label="存在导入警告" value={summary.hasImportWarnings ? "是" : "否"} />
          <SummaryRow label="负时间限制为 0" value={`${summary.negativeClampCount} 项`} />
          <ProjectHealthPreflight summary={healthSummary} />
          {previewCompensations.length > 0 ? (
            <section className="rounded border border-panel-line bg-[#111318] p-3 text-xs text-slate-300">
              <h3 className="font-medium text-slate-100">补偿明细</h3>
              <div className="mt-2 grid gap-2">
                {previewCompensations.map((detail) => (
                  <CompensationDetailRow key={detail.id} detail={detail} />
                ))}
                {hiddenCompensationCount > 0 ? (
                  <p className="text-slate-500">另有 {hiddenCompensationCount} 个补偿点，可下载报告查看完整明细。</p>
                ) : null}
              </div>
            </section>
          ) : null}
          <div
            className={`rounded border px-3 py-2 text-xs ${
              validation.ok
                ? "border-accent-green/40 bg-accent-green/10 text-accent-green"
                : "border-accent-red/40 bg-accent-red/10 text-accent-red"
            }`}
          >
            {validation.message} 验证条数：{validation.count}
          </div>
        </div>
        <footer className="flex flex-wrap justify-end gap-2 border-t border-panel-line p-4">
          <TextButton
            onClick={() =>
              downloadTextFile(
                `${project.name || "danmaku-export"}-health-report.txt`,
                createProjectHealthReport(project.name, healthSummary),
                "text/plain;charset=utf-8"
              )
            }
          >
            <Download size={14} />
            下载健康报告
          </TextButton>
          {summary.compensationDetails.length > 0 ? (
            <TextButton
              onClick={() =>
                downloadTextFile(
                  `${project.name || "danmaku-export"}-compensation-report.txt`,
                  createCompensationReport(project.name, summary),
                  "text/plain;charset=utf-8"
                )
              }
            >
              <Download size={14} />
              下载补偿报告
            </TextButton>
          ) : null}
          <TextButton onClick={clearExport}>取消</TextButton>
          <TextButton
            tone="primary"
            disabled={!validation.ok}
            onClick={() => {
              downloadTextFile(`${project.name || "danmaku-export"}.xml`, exportDraft.xml, "application/xml;charset=utf-8");
              clearExport();
            }}
          >
            <Download size={14} />
            下载 XML
          </TextButton>
        </footer>
      </div>
    </div>
  );
}

function ProjectHealthPreflight({ summary }: { summary: ProjectHealthSummary }) {
  const reviewFindings = summary.findings.filter((finding) => finding.id !== "ready");
  const previewFindings = reviewFindings.slice(0, 3);
  const hiddenFindingCount = Math.max(0, reviewFindings.length - previewFindings.length);
  return (
    <section className={`rounded border p-3 text-xs ${projectHealthPanelClass(summary.status)}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium">导出前健康检查</h3>
          <p className="mt-1 leading-5 opacity-80">{summary.statusDetail}</p>
        </div>
        <span className={`shrink-0 rounded border px-2 py-1 text-[11px] ${projectHealthBadgeClass(summary.status)}`}>
          {summary.statusLabel}
        </span>
      </div>
      {previewFindings.length > 0 ? (
        <ul className="mt-2 grid gap-2">
          {previewFindings.map((finding) => (
            <ProjectHealthFindingPreview key={finding.id} finding={finding} />
          ))}
          {hiddenFindingCount > 0 ? <li className="opacity-70">另有 {hiddenFindingCount} 项，可下载健康报告查看。</li> : null}
        </ul>
      ) : null}
    </section>
  );
}

function ProjectHealthFindingPreview({ finding }: { finding: ProjectHealthFinding }) {
  return (
    <li className="border-t border-current/15 pt-2 first:border-t-0 first:pt-0">
      <span className="font-medium">{projectHealthFindingSeverityLabel(finding.severity)}</span>
      <span className="mx-1">/</span>
      <span>{finding.title}</span>
    </li>
  );
}

function CompensationDetailRow({ detail }: { detail: ExportCompensationDetail }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t border-panel-line pt-2 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <div className="truncate text-slate-100" title={detail.name}>
          {detail.name}
        </div>
        <div className="mt-1 truncate font-mono text-[11px] text-slate-500">
          {formatTimecode(detail.sourceAtMs)} / {formatSignedCompensationDuration(detail.targetGapMs)}
        </div>
      </div>
      <span className="text-slate-500">后续整体平移</span>
    </div>
  );
}

function projectHealthPanelClass(status: ProjectHealthStatus): string {
  if (status === "blocked") {
    return "border-accent-red/40 bg-accent-red/10 text-red-100";
  }
  if (status === "attention") {
    return "border-amber-400/40 bg-amber-400/10 text-amber-100";
  }
  return "border-accent-green/40 bg-accent-green/10 text-accent-green";
}

function projectHealthBadgeClass(status: ProjectHealthStatus): string {
  if (status === "blocked") {
    return "border-red-300/50 bg-red-300/10 text-red-100";
  }
  if (status === "attention") {
    return "border-amber-300/50 bg-amber-300/10 text-amber-100";
  }
  return "border-accent-green/50 bg-accent-green/10 text-accent-green";
}

function projectHealthFindingSeverityLabel(severity: ProjectHealthFinding["severity"]): string {
  if (severity === "error") {
    return "需处理";
  }
  if (severity === "warning") {
    return "需复核";
  }
  return "信息";
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-3">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="truncate rounded border border-panel-line bg-[#111318] px-2 py-1.5 text-xs text-slate-100">
        {value}
      </dd>
    </div>
  );
}
