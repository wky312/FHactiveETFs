import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "00998A 復華全球金融股票主動式ETF — 持股報告",
  description: "每日持股清單、持股比較、國家配置分析",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-TW">
      <body>
        {children}
        <Script
          src="https://cdn.plot.ly/plotly-2.27.0.min.js"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
