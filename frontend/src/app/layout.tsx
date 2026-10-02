import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "TripplePay || Merchants",
  description:
    "Accept fast, non-custodial payments on Quai Network.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // data-scroll-behavior is Next's opt-in for `scroll-behavior: smooth` in globals.css. Without it
    // Next disables smooth scrolling on every route change and logs a warning on each navigation.
    <html lang="en" data-scroll-behavior="smooth">
      <body className={`${spaceGrotesk.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}