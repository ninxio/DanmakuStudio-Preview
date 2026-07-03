import { useId, type InputHTMLAttributes, type ReactNode } from "react";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  suffix?: ReactNode;
}

export function Field({ label, suffix, className = "", ...props }: FieldProps) {
  const generatedId = useId();
  const inputId = props.id ?? generatedId;
  return (
    <label className="grid gap-1 text-xs text-slate-400" htmlFor={inputId}>
      <span>{label}</span>
      <span className="flex items-center gap-2">
        <input
          {...props}
          id={inputId}
          aria-label={props["aria-label"] ?? label}
          className={`h-8 min-w-0 flex-1 rounded border border-panel-line bg-[#111318] px-2 text-sm text-slate-100 ${className}`}
        />
        {suffix ? <span className="text-slate-500">{suffix}</span> : null}
      </span>
    </label>
  );
}
