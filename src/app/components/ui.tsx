"use client";
/** 前端共享 UI 组件与请求封装。 */
import { useEffect, useState, createContext, useContext, useCallback } from "react";
import { getUserId } from "./user";

// ---------------- 请求封装（自动带 x-user-id；超时提示，不无限转圈） ----------------

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  const ctrl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 15000;
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method: opts.method ?? "GET",
      headers: {
        "x-user-id": getUserId(),
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => null)) as T | null;
    return {
      ok: res.ok,
      status: res.status,
      data,
      error: res.ok ? undefined : ((data as { message?: string })?.message ?? `请求失败（${res.status}）`),
    };
  } catch (e) {
    const err = e as Error;
    return {
      ok: false,
      status: 0,
      data: null,
      error: err.name === "AbortError" ? `请求超时（>${timeoutMs}ms），请稍后重试` : `网络错误：${err.message}`,
    };
  } finally {
    clearTimeout(t);
  }
}

/** 生成幂等操作令牌（客户端） */
export function newOpToken(): string {
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------- Toast ----------------

interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  msg: string;
}
const ToastCtx = createContext<{ push: (kind: Toast["kind"], msg: string) => void }>({ push: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast["kind"], msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`animate-[fadeIn_.15s] rounded-lg px-4 py-2.5 text-sm shadow-card-hover ${
              t.kind === "success"
                ? "bg-emerald-600 text-white"
                : t.kind === "error"
                ? "bg-rose-600 text-white"
                : "bg-ink text-white"
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  return useContext(ToastCtx);
}

// ---------------- Badge ----------------

export function Badge({ children, tone = "gray" }: { children: React.ReactNode; tone?: string }) {
  const tones: Record<string, string> = {
    gray: "bg-slate-100 text-slate-600",
    brand: "bg-brand-tint text-brand-dark",
    green: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
    red: "bg-rose-50 text-rose-700",
    blue: "bg-sky-50 text-sky-700",
    purple: "bg-violet-50 text-violet-700",
  };
  return <span className={`badge ${tones[tone] ?? tones.gray}`}>{children}</span>;
}

// ---------------- Modal ----------------

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-line bg-white shadow-card-hover"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <button onClick={onClose} className="text-ink-faint hover:text-ink">✕</button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ---------------- Spinner ----------------

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-ink-faint">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      {label ?? "处理中…"}
    </span>
  );
}
