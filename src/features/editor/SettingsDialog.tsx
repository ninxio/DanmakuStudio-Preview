import { X } from "lucide-react";
import { IconButton } from "../../components/IconButton";
import { Field } from "../../components/Field";
import { TextButton } from "../../components/TextButton";
import { useEditorStore } from "../../stores/editorStore";

interface SettingsDialogProps {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const project = useEditorStore((state) => state.project);
  const setGlobalOffset = useEditorStore((state) => state.setGlobalOffset);
  const updatePreview = useEditorStore((state) => state.updatePreview);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60" role="dialog" aria-modal="true">
      <div className="w-[420px] rounded border border-panel-line bg-panel-raised shadow-2xl">
        <header className="flex h-11 items-center justify-between border-b border-panel-line px-3">
          <h2 className="text-sm font-semibold">设置</h2>
          <IconButton label="关闭设置" icon={<X size={16} />} onClick={onClose} />
        </header>
        <div className="grid gap-4 p-4">
          <Field
            label="全局偏移"
            type="number"
            value={project.globalOffsetMs}
            suffix="ms"
            onChange={(event) => setGlobalOffset(Number(event.target.value))}
          />
          <label className="flex items-center justify-between text-xs text-slate-300">
            弹幕叠加
            <input
              type="checkbox"
              checked={project.preview.danmakuVisible}
              onChange={(event) => updatePreview({ danmakuVisible: event.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between text-xs text-slate-300">
            显示安全区
            <input
              type="checkbox"
              checked={project.preview.safeAreaVisible}
              onChange={(event) => updatePreview({ safeAreaVisible: event.target.checked })}
            />
          </label>
          <label className="grid gap-2 text-xs text-slate-300">
            预览弹幕透明度
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={project.preview.opacity}
              className="accent-accent-cyan"
              onChange={(event) => updatePreview({ opacity: Number(event.target.value) })}
            />
          </label>
          <TextButton tone="primary" onClick={onClose}>
            完成
          </TextButton>
        </div>
      </div>
    </div>
  );
}
