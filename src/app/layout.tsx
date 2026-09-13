import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Glass Box",
  description:
    "See exactly what an AI agent did. Every plan, every tool call and every human decision from a real run, replayed and open to inspection.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/* Plain link rather than next/font so a build never depends on
            reaching Google, and the system stack carries the page if the
            request fails. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        {/* The rule below is about the pages router, where a font link in a
            single page loads only for that page. This is the root layout, so
            it applies to every route. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
