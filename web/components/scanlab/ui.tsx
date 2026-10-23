import type { ButtonHTMLAttributes, ReactNode } from "react";

export const CARD = "border border-[var(--border)] rounded-md bg-[var(--panel)] min-w-0";
export const H = "text-[10px] uppercase tracking-wider text-[var(--text-dim)] font-semibold";
export const NOTE = "text-[12px] leading-relaxed text-[#d6d6d6]";
export const ROW = "grid gap-2 items-center px-3 py-1.5 border-t border-[#1c1c1c] text-[11.5px]";

export function Btn({ primary, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      {...rest}
      className={`px-3 py-1.5 min-h-8 rounded-md border text-[12px] font-medium disabled:opacity-45 disabled:cursor-not-allowed ${
        primary
          ? "bg-[var(--amber)] border-[var(--amber)] text-black font-semibold"
          : "bg-[#161616] border-[#474747] text-[#ececec] hover:border-[#6a6a6a]"
      } ${className}`}
    />
  );
}

const TONES = {
  new: "text-[#3ee07f] border-[#1f5e37]",
  up: "text-[#3ee07f] border-[#1f5e37]",
  gone: "text-[#ff8a8a] border-[#6b2a2a]",
  down: "text-[#ff8a8a] border-[#6b2a2a]",
  chg: "text-[#ffb84d] border-[#6b4a14]",
  kept: "text-[#a3a3a3] border-[#3a3a3a]",
  "": "",
} as const;

export function Tag({ tone, children }: { tone: keyof typeof TONES; children: ReactNode }) {
  if (!children) return <span />;
  return <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border justify-self-start whitespace-nowrap ${TONES[tone]}`}>{children}</span>;
}

export function Panel({ role, children }: { role?: string; children: ReactNode }) {
  return <div role={role} className="px-3 pb-3 flex flex-col gap-2.5">{children}</div>;
}
