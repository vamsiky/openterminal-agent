// Segmented control: one bordered group of mutually exclusive buttons (range 1D 5D 1M, chart type, ...).
// Props: options {id, label, title?}[], value (active id), onChange(id), ariaLabel?, className?.
"use client";

export type SegmentOption = { id: string; label: string; title?: string };

export default function Segmented({
  options, value, onChange, ariaLabel, className = "",
}: {
  options: SegmentOption[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className={`seggrp ${className}`}>
      {options.map((o) => (
        <button
          key={o.id}
          title={o.title}
          aria-pressed={o.id === value}
          className={`sg ${o.id === value ? "on" : ""}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
