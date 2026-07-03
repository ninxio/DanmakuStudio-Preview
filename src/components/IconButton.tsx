import type { ButtonHTMLAttributes, ReactNode } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ReactNode;
  active?: boolean;
  danger?: boolean;
}

export function IconButton({ label, icon, active = false, danger = false, className = "", ...props }: IconButtonProps) {
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      title={label}
      aria-label={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded border text-sm transition ${
        active
          ? "border-accent-cyan bg-accent-cyan/20 text-accent-cyan"
          : danger
            ? "border-accent-red/40 bg-accent-red/10 text-accent-red hover:bg-accent-red/20"
            : "border-panel-line bg-panel-soft text-slate-200 hover:border-slate-500 hover:bg-slate-700"
      } disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {icon}
    </button>
  );
}
