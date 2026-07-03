import type { ReactNode } from "react";

interface PanelProps {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Panel({ title, action, children, className = "" }: PanelProps) {
  return (
    <section className={`flex min-h-0 flex-col border-panel-line bg-panel-base ${className}`}>
      {title ? (
        <header className="flex h-10 shrink-0 items-center justify-between border-b border-panel-line px-3">
          <h2 className="truncate text-xs font-semibold text-slate-200">{title}</h2>
          {action}
        </header>
      ) : null}
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}
