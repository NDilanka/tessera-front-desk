import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tessera Front Desk — Voice Booking",
  description:
    "A browser-native voice assistant that books Tessera product-demo calls: push to talk, hear it back, get a confirmation code. Runs at $0 on free-tier LLMs.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
