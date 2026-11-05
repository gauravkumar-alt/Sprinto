import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Aurora } from "@/components/motion";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: "Sprinto Outreach Agent",
  description: "Evidence-driven prospect research, ICP qualification and personalised outreach.",
};

/** Apply the saved light/dark choice before first paint (no theme flash). */
const themeScript = `try{var t=localStorage.getItem("theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Aurora />
        {children}
      </body>
    </html>
  );
}
