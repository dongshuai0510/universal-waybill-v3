"use client";
import { useEffect, useState, useCallback } from "react";
import { api, useToast, Badge, Spinner } from "../components/ui";

interface SyncLog {
  requestId: string;
  api: string;
  method: string;
  params: string;
  statusCode: number | null;
  success: boolean;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}
interface SyncData {
  v2: { V2_BASE: string; TIMEOUT_MS: number; MAX_RETRY: number };
  lastSuccessSyncAt: string | null;
  successRate: number | null;
  totalCalls: number;
  successCalls: number;
  logs: SyncLog[];
}

export default function MonitorPage() {
  const toast = useToast();
  const [data, setData] = useState<SyncData | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const r = await api<SyncData>("/api/sync");
    if (r.ok && r.data) setData(r.data);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function triggerSync() {
    setSyncing(true);
    const r = await api<{ ok: boolean; synced: number; message: string; degraded: boolean }>("/api/sync", { method: "POST" });
    setSyncing(false);
    if (r.data) toast.push(r.data.degraded ? "info" : "success", r.data.message);
    load();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink">跨系统接口与数据一致性监控</h1>
          <p className="mt-1 text-sm text-ink-soft">V3 → V2 接口调用链路追踪，排查“数据为什么对不上”。</p>
        </div>
        <button className="btn-primary" onClick={triggerSync} disabled={syncing}>
          {syncing ? <Spinner label="同步中…" /> : "立即同步运单快照"}
        </button>
      </div>

      {!data ? (
        <div className="card p-8 text-center text-ink-faint"><Spinner label="加载中…" /></div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <Stat label="V2 接口地址" value={<span className="break-all text-xs font-mono">{data.v2.V2_BASE}</span>} />
            <Stat label="调用成功率" value={data.successRate === null ? "—" : `${data.successRate}%`}
              tone={data.successRate === null ? "gray" : data.successRate >= 90 ? "green" : data.successRate >= 50 ? "amber" : "red"} />
            <Stat label="总调用 / 成功" value={`${data.totalCalls} / ${data.successCalls}`} />
            <Stat label="最近成功同步" value={<span className="text-xs">{data.lastSuccessSyncAt ? new Date(data.lastSuccessSyncAt).toLocaleString("zh-CN") : "尚无"}</span>} />
          </div>

          <div className="card p-4 text-xs text-ink-soft">
            <b>超时与重试策略：</b>单次调用超时 {data.v2.TIMEOUT_MS}ms，幂等 GET 失败重试至多 {data.v2.MAX_RETRY} 次（指数退避）；
            V2 不可用时降级到本地快照并标注“数据来自缓存，同步于 XX 时间”，不会白屏。每次调用生成 <b>Request ID</b> 写入日志，可还原完整调用链。
          </div>

          <div className="card overflow-hidden">
            <div className="border-b border-line px-5 py-3 text-sm font-semibold text-ink">最近接口调用日志（含 Request ID）</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-ink-faint">
                  <tr>
                    <th className="px-3 py-2 text-left">时间</th>
                    <th className="px-3 py-2 text-left">Request ID</th>
                    <th className="px-3 py-2 text-left">接口</th>
                    <th className="px-3 py-2 text-left">结果</th>
                    <th className="px-3 py-2 text-left">耗时</th>
                    <th className="px-3 py-2 text-left">错误</th>
                  </tr>
                </thead>
                <tbody>
                  {data.logs.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-faint">暂无调用日志。去“扫描”或“上报”触发一次 V2 调用。</td></tr>
                  )}
                  {data.logs.map((l, i) => (
                    <tr key={i} className="border-t border-line-soft">
                      <td className="px-3 py-2 text-xs text-ink-faint">{new Date(l.createdAt).toLocaleTimeString("zh-CN")}</td>
                      <td className="px-3 py-2 font-mono text-xs">{l.requestId}</td>
                      <td className="px-3 py-2 text-xs">{l.api}</td>
                      <td className="px-3 py-2">
                        <Badge tone={l.success ? "green" : "red"}>{l.success ? `${l.statusCode ?? "OK"}` : (l.errorCode ?? "FAIL")}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-ink-soft">{l.durationMs ?? "—"}ms</td>
                      <td className="px-3 py-2 text-xs text-rose-600">{l.errorMessage ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone = "gray" }: { label: string; value: React.ReactNode; tone?: string }) {
  const tones: Record<string, string> = {
    gray: "text-ink", green: "text-emerald-600", amber: "text-amber-600", red: "text-rose-600",
  };
  return (
    <div className="card p-4">
      <div className="text-xs text-ink-faint">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${tones[tone]}`}>{value}</div>
    </div>
  );
}
