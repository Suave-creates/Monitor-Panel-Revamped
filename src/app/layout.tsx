import type { Metadata } from "next";
import { Sidebar } from "@/components/Sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "NexS Operations Console", template: "%s · NexS Console" },
  description: "Unified operational monitoring and lookup tools for NexS.",
};

// Applies the saved theme to <html> before first paint, so a light-mode
// pick doesn't flash dark on load. Dark is the default look — this only
// ever adds data-theme="light", never removes it (the stylesheet's base
// :root is already dark). Kept as a plain string run via a blocking
// inline <script> (not a React effect) since it must execute before the
// browser paints the page.
const THEME_INIT_SCRIPT = `try{if(localStorage.getItem("nexs-theme")==="light"){document.documentElement.setAttribute("data-theme","light")}}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
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
