import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BREACH — Destructible Arena",
  description: "Break cover. Hold your ground. A peer-hosted arena shooter with proximity voice.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
