import type { Metadata } from "next";
import "./globals.css";
import NavBar from "./components/NavBar";
import { ToastProvider } from "./components/ui";

export const metadata: Metadata = {
  title: "运单全流程管理 V3 · 扫描品控 · 分级审批",
  description:
    "承接 V2 录单，覆盖扫描品控 → 异常上报 → 分级审批 → 执行联动的运单全生命周期管理系统",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">
        <ToastProvider>
          <NavBar />
          <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
          <footer className="mx-auto max-w-7xl px-6 py-8 text-center text-xs text-slate-400">
            运单全流程管理系统 V3 · 独立部署 · 通过接口对接 V2（万能导入）
          </footer>
        </ToastProvider>
      </body>
    </html>
  );
}
