import type { Metadata } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n/provider";
import { ThemeProvider } from "@/lib/theme-provider";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";

export const metadata: Metadata = {
  title: "YouTube Channel AI VIP",
  description: "AI-powered YouTube channel analytics (local)",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <I18nProvider>
            <div className="flex h-screen overflow-hidden">
              <Sidebar />
              <div className="flex flex-1 flex-col overflow-hidden">
                <Topbar />
                <main className="flex-1 overflow-y-auto p-6">{children}</main>
              </div>
            </div>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
