import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") || "https";
  const origin = host ? `${protocol}://${host}` : "http://localhost:3000";
  const image = `${origin}/og.png`;

  return {
    title: "showmeplease — simple screen sharing",
    description: "Create a private screen share or join one with a short code.",
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
        {children}
      </body>
    </html>
  );
}
