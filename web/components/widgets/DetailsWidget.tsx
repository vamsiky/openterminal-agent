"use client";

import type { WidgetInstance } from "../../store/terminal";

// Placeholder: the stock-details squad replaces this file.
export default function DetailsWidget({ widget }: { widget: WidgetInstance }) {
  return <div className="p-3 dim" data-widget={widget.id}>Stock details placeholder.</div>;
}
