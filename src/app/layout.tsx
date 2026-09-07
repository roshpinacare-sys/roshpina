import type { Metadata, Viewport } from "next";
import { Frank_Ruhl_Libre, Heebo, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const franklin = Frank_Ruhl_Libre({
  variable: "--font-franklin",
  subsets: ["hebrew", "latin"],
  weight: ["300", "400", "500", "700", "900"],
});

const heebo = Heebo({
  variable: "--font-heebo",
  subsets: ["hebrew", "latin"],
  weight: ["300", "400", "500", "700", "800"],
});

const jet = JetBrains_Mono({
  variable: "--font-jet",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: "רושפינה — פלטפורמת האמון והערך",
  description:
    "רושפינה (ראש-הפינה): פלטפורמת אמון וערך ריבונית — רווח (מנוע-עמלות וארביטראז'-עלויות), הגנה (guard fail-closed + ביקורת hash-linked + דרכוני Ed25519), ואינטליגנציה (מנוע-פוטנציאל). kernel: TFA Sovereign Trust-as-a-Service.",
  keywords: ["רושפינה", "Roshpina", "TFA", "escrow", "דרכוני-פעולה", "ביקורת", "SAOS"],
};

export const viewport: Viewport = {
  themeColor: "#0a0907",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="he" dir="rtl" suppressHydrationWarning>
      <body
        className={`${franklin.variable} ${heebo.variable} ${jet.variable} font-sans antialiased bg-background text-foreground min-h-screen flex flex-col`}
      >
        {children}
        <Toaster position="bottom-left" richColors />
      </body>
    </html>
  );
}
