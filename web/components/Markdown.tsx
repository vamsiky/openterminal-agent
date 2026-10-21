import { Fragment, type ReactNode } from "react";

/** Inline **bold**, *italic* and `code`; everything else is plain text (React escapes it, no raw HTML). */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

type Block = { type: "h"; level: number; text: string } | { type: "ul" | "ol"; items: string[] } | { type: "p"; text: string };

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "p", text: para.join(" ") });
    para = [];
  };
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (h) {
      flush();
      blocks.push({ type: "h", level: h[1].length, text: h[2] });
    } else if (li) {
      flush();
      const type = li[1] ? "ol" : "ul";
      const last = blocks[blocks.length - 1];
      if (last && last.type === type) last.items.push(li[2]);
      else blocks.push({ type, items: [li[2]] });
    } else para.push(line);
  }
  flush();
  return blocks;
}

/** Minimal safe markdown: headings, lists, bold/italic/code, paragraphs. */
export default function Markdown({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-1">
      {parseMarkdown(text).map((b, i) => {
        if (b.type === "h") return <div key={i} className={b.level <= 2 ? "amber uppercase mt-1" : "amber mt-1"}>{inline(b.text)}</div>;
        if (b.type === "p") return <p key={i}>{inline(b.text)}</p>;
        const Tag = b.type;
        return (
          <Tag key={i} className={`${b.type === "ul" ? "list-disc" : "list-decimal"} pl-4`}>
            {b.items.map((x, j) => <li key={j}>{inline(x)}</li>)}
          </Tag>
        );
      })}
    </div>
  );
}
