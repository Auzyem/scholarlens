import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { RecoveryRedirect } from "@/components/auth/RecoveryRedirect";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "ScholarLens",
  description: "AI-powered manuscript peer review",
};

export default function Layout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
          {/* Renders nothing. It lives at the root because a recovery link in the
              implicit flow lands on whatever the project's Site URL is — today the
              marketing page, tomorrow whatever someone types into the Supabase
              dashboard. Pinning the catcher to one page would make our auth
              depend on a setting that is not in this repo. */}
          <RecoveryRedirect />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
