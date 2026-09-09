import type { Metadata } from "next";
import { Sidebar } from "@/components/Sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "NexS Operations Console", template: "%s · NexS Console" },
  description: "Unified operational monitoring and lookup tools for NexS.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <Sidebar />
          <div className="app-column">
            <main className="main-content">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
