import type { Metadata } from "next";
import "./globals.css";
import { IBM_Plex_Sans, JetBrains_Mono } from "next/font/google";
import Providers from "./providers";

const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex", display: "swap" });

export const metadata: Metadata = {
  title: "OpenTerminal",
  description: "Bloomberg-style financial terminal on free data sources",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${sans.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
