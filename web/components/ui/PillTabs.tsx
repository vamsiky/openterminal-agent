// Row of bordered pill tabs (the sub-navigation look: News, Comments, Options, ...).
// Props: tabs {id, label, count?}[], value (active id), onChange(id), size?: "md" | "sm",
// ariaLabel?, className?. Active pill is amber; each pill is its own bordered button.
"use client";

export type PillTab = { id: string; label: string; count?: number };

export default function PillTabs({
  tabs, value, onChange, ariaLabel, size = "md", className = "",
}: {
  tabs: PillTab[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
  size?: "md" | "sm";
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className={`flex items-center gap-1 overflow-x-auto ${className}`}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === value}
          className={`dtab ${size === "sm" ? "sm" : ""} ${t.id === value ? "on" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count !== undefined && <span className="dim ml-1.5">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
