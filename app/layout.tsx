import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppProviders } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  // The static export bakes this placeholder origin into the HTML; the Node
  // backend rewrites it to the requesting host at serve time.
  const origin = "http://localhost:3000";
  const image = `${origin}/og.png`;

  return {
    title: "showmeplease — simple screen sharing",
    description: "Create a private screen share or join one with a short code.",
    icons: { icon: "/favicon.svg" },
    openGraph: {
      title: "showmeplease",
      description: "Simple screen sharing.",
      type: "website",
      images: [{ url: image, width: 1734, height: 907, alt: "showmeplease" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "showmeplease",
      description: "Simple screen sharing.",
      images: [image],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
