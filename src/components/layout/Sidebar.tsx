import { ReactNode } from "react";

interface SidebarProps {
  children: ReactNode;
}

export function Sidebar({ children }: SidebarProps) {
  return (
    <div className="h-full bg-[var(--surface)] border-r border-[var(--border)] overflow-hidden flex flex-col">
      {children}
    </div>
  );
}

Sidebar.defaultSize = (props: { children: ReactNode; minSize?: number; maxSize?: number }) => (
  <div className="h-full bg-[var(--surface)] border-r border-[var(--border)] overflow-hidden flex flex-col" style={{
    minWidth: props.minSize ? `${props.minSize}%` : undefined,
    maxWidth: props.maxSize ? `${props.maxSize}%` : undefined,
  }}>
    {props.children}
  </div>
);