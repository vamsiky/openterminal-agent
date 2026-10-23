"use client";

import type { WidgetInstance } from "../../store/terminal";
import WidgetErrorBoundary from "../WidgetErrorBoundary";
import { WIDGETS } from "./registry";

/** One widget inside its error boundary; used by panes and the pop-out window. */
export default function WidgetHost({ widget }: { widget: WidgetInstance }) {
  const def = WIDGETS[widget.type];
  if (!def) return <div className="p-3 dim">Unknown widget “{widget.type}”.</div>;
  const Body = def.component;
  return (
    <WidgetErrorBoundary name={def.label}>
      <Body widget={widget} />
    </WidgetErrorBoundary>
  );
}
