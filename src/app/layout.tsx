import type { Metadata, Viewport } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ServiceWorkerRegistration } from "@/components/service-worker-registration";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export const metadata: Metadata = {
  title: "ALO Labs AgentOS — AI Agent Operating System",
  description: "A secure, multi-tenant AI agent operating system for managing, orchestrating, and monitoring autonomous AI agents at scale.",
  keywords: [
    'AI agent', 'agent operating system', 'multi-tenant AI', 'AI orchestration',
    'autonomous agents', 'AI CRM', 'agent management', 'ALO Labs', 'AgentOS',
    'AI workflows', 'real-time analytics', 'agent monitoring',
  ],
  manifest: "/manifest.json",
  icons: {
    icon: "/icons/icon-192.svg",
  },
  other: {
    "mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
    "apple-mobile-web-app-title": "ALO AgentOS",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#003ABC" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="ALO AgentOS" />
        <link rel="apple-touch-icon" href="/icons/icon-192.svg" />
      </head>
      <body
        className={`${inter.variable} ${geistMono.variable} font-sans antialiased bg-[#F8FAFC] text-[#1E293B]`}
      >
        <div className="min-h-screen flex flex-col">
          <ServiceWorkerRegistration />
          <script dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='dark')document.documentElement.classList.add('dark')}catch(e){}})()`
          }} />
          {children}
          <Toaster />
        </div>
      </body>
    </html>
  );
}