import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: { default: "Aangan Enquiries", template: "%s · Aangan Enquiries" },
  description: "Internal enquiry dashboard for Aangan Studio",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN">
      <body className={`${inter.variable} font-sans antialiased`}>{children}</body>
    </html>
  );
}
