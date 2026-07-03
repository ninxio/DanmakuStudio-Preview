import { Download, X } from "lucide-react";
import { IconButton } from "../../components/IconButton";
import { TextButton } from "../../components/TextButton";
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65" role="dialog" aria-modal="true">
      <div className="w-[520px] rounded border border-panel-line bg-panel-raised shadow-2xl" data-testid="export-dialog">
        <header className="flex h-12 items-center justify-between border-b border-panel-line px-4">
          <h2 className="text-sm font-semibold">导出 XML 摘要</h2>
          <IconButton label="关闭导出摘要" icon={<X size={16} />} onClick={clearExport} />
        </header>
        <div className="grid gap-3 p-4 text-sm">
          <SummaryRow label="原始弹幕数量" value={summary.originalCount.toLocaleString("zh-CN")} />
          <SummaryRow label="启用弹幕数量" value={summary.enabledCount.toLocaleString("zh-CN")} />
          <SummaryRow label="禁用弹幕数量" value={summary.disabledCount.toLocaleString("zh-CN")} />
          <SummaryRow label="最早最终时间" value={formatTimecode(summary.earliestFinalTimeMs)} />
          <SummaryRow label="最晚最终时间" value={formatTimecode(summary.latestFinalTimeMs)} />
          <SummaryRow label="应用删减标记" value={summary.cutMarkerCount.toString()} />
          <SummaryRow label="存在导入警告" value={summary.hasImportWarnings ? "是" : "否"} />
          <SummaryRow label="负时间限制为 0" value={`${summary.negativeClampCount} 项`} />
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
        <footer className="flex justify-end gap-2 border-t border-panel-line p-4">
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
