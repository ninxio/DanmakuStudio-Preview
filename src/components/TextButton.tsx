import type { ButtonHTMLAttributes, ReactNode } from "react";

interface TextButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  tone?: "neutral" | "primary" | "danger";
}

export function TextButton({ children, tone = "neutral", className = "", ...props }: TextButtonProps) {
  const toneClass =
    tone === "primary"
      ? "border-accent-cyan bg-accent-cyan/20 text-accent-cyan hover:bg-accent-cyan/30"
      : tone === "danger"
        ? "border-accent-red/40 bg-accent-red/10 text-accent-red hover:bg-accent-red/20"
        : "border-panel-line bg-panel-soft text-slate-200 hover:border-slate-500 hover:bg-slate-700";
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      className={`inline-flex h-8 items-center justify-center gap-2 rounded border px-3 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${toneClass} ${className}`}
    >
      {children}
    </button>
  );
}
