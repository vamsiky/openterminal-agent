"use client";

import dynamic from "next/dynamic";

const WindowView = dynamic(() => import("../../components/workspace/WindowView"), { ssr: false });

export default function WindowPage() {
  return <WindowView />;
}
