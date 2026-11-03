import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sprinto Outreach Agent",
  description: "Evidence-driven prospect research, ICP qualification and personalised outreach.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
