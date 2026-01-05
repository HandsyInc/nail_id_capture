import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Handsy - Nail ID Capture",
  description: "Create your Nail ID with a few simple photos",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

