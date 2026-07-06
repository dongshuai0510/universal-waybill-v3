"use client";
/** 工单列表页（模块四）：筛选 + 分页 + 统计 + 即将超时高亮。 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, Badge } from "../components/ui";
import {
  STATUS_LABELS,
  STATUS_TONE,
  CATEGORY_LABELS,
  SOURCE_LABELS,
  exceptionLabel,
  statusLabel,
} from "../components/labels";

interface TicketRow {
  id: string;
  category: string;
  exceptionType: string;
  source: string;
  waybillCode: string;
  amount: number;
  status: string;
  currentLevel: number | null;
  deadlineAt: string | null;
  createdAt: string;
  nearTimeout?: boolean;
  overdue?: boolean;
}

export default function TicketsPage() {
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [f, setF] = useState({ status: "", category: "", source: "", waybillCode: "" });

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (f.status) qs.set("status", f.status);
    if (f.category) qs.set("category", f.category);
    if (f.source) qs.set("source", f.source);
    if (f.waybillCode) qs.set("waybillCode", f.waybillCode);
    const r = await api<{ tickets: TicketRow[]; total: number; totalPages: number; stats: Record<string, number> }>(
      `/api/tickets?${qs.toString()}`
    );
    if (r.ok && r.data) {
      setRows(r.data.tickets);
      setTotal(r.data.total);
      setTotalPages(r.data.totalPages);
      setStats(r.data.stats);
    }
    setLoading(false);
  }, [page, f]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">异常工单</h1>
          <p className="text-sm text-ink-faint">共 {total} 条工单 · 支持按状态/类型/来源/运单号筛选</p>
        </div>
        <Link href="/report" className="btn-primary">+ 手工上报异常</Link>
      </div>

      {/* 统计条 */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(STATUS_LABELS).map(([k, label]) => (
          <button
            key={k}
            onClick={() => { setF((x) => ({ ...x, status: x.status === k ? "" : k })); setPage(1); }}
            className={`card px-3 py-2 text-left transition ${f.status === k ? "ring-2 ring-brand" : ""}`}
          >
            <div className="text-xs text-ink-faint">{label}</div>
            <div className="text-lg font-semibold text-ink">{stats[k] ?? 0}</div>
          </button>
        ))}
      </div>

      {/* 筛选 */}
      <div className="card flex flex-wrap items-center gap-3 p-3">
        <select className="select" value={f.category} onChange={(e) => { setF((x) => ({ ...x, category: e.target.value })); setPage(1); }}>
          <option value="">全部大类</option>
          <option value="logistics">物流异常</option>
          <option value="qc">品控异常</option>
        </select>
        <select className="select" value={f.source} onChange={(e) => { setF((x) => ({ ...x, source: e.target.value })); setPage(1); }}>
          <option value="">全部来源</option>
          <option value="manual">手工上报</option>
          <option value="scan">扫描自动触发</option>
        </select>
        <input
          className="input flex-1"
          placeholder="按运单号搜索…"
          value={f.waybillCode}
          onChange={(e) => setF((x) => ({ ...x, waybillCode: e.target.value }))}
          onKeyDown={(e) => { if (e.key === "Enter") { setPage(1); load(); } }}
        />
        <button className="btn-ghost" onClick={() => { setF({ status: "", category: "", source: "", waybillCode: "" }); setPage(1); }}>
          重置
        </button>
      </div>

      {/* 列表 */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-ink-faint">
            <tr>
              <th className="px-4 py-2.5">工单号</th>
              <th className="px-4 py-2.5">大类 / 类型</th>
              <th className="px-4 py-2.5">来源</th>
              <th className="px-4 py-2.5">运单号</th>
              <th className="px-4 py-2.5">金额</th>
              <th className="px-4 py-2.5">状态</th>
              <th className="px-4 py-2.5">时效</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-t border-line-soft hover:bg-brand-tint2/40">
                <td className="px-4 py-2.5">
                  <Link href={`/tickets/${t.id}`} className="font-mono text-xs text-brand-dark hover:underline">
                    {t.id}
                  </Link>
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={t.category === "qc" ? "brand" : "blue"}>{CATEGORY_LABELS[t.category]}</Badge>
                  <span className="ml-1.5 text-ink-soft">{exceptionLabel(t.exceptionType)}</span>
                </td>
                <td className="px-4 py-2.5 text-ink-soft">{SOURCE_LABELS[t.source]}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-ink-soft">{t.waybillCode}</td>
                <td className="px-4 py-2.5 text-ink-soft">¥{t.amount.toLocaleString()}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={STATUS_TONE[t.status] ?? "gray"}>{statusLabel(t.status)}</Badge>
                  {t.currentLevel && ["l1_reviewing", "l2_reviewing", "pending"].includes(t.status) && (
                    <span className="ml-1 text-xs text-ink-faint">L{t.currentLevel}</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {t.overdue ? (
                    <span className="badge bg-rose-100 text-rose-700">已超时</span>
                  ) : t.nearTimeout ? (
                    <span className="badge bg-amber-100 text-amber-700">即将超时</span>
                  ) : (
                    <span className="text-xs text-ink-faint">—</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-ink-faint">暂无工单，去 <Link href="/report" className="text-brand-dark underline">上报</Link> 或 <Link href="/scan" className="text-brand-dark underline">扫描</Link></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      <div className="flex items-center justify-between text-sm text-ink-soft">
        <span>第 {page} / {totalPages} 页{loading && " · 加载中…"}</span>
        <div className="flex gap-2">
          <button className="btn-ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
          <button className="btn-ghost" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</button>
        </div>
      </div>
    </div>
  );
}
