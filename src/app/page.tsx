"use client";
/**
 * 首页 / 总览仪表盘。
 * 展示工单状态分布、跨系统接口健康摘要、快速入口，
 * 并在首次访问时确保基础种子已初始化。
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, Badge } from "./components/ui";
import { STATUS_LABELS, STATUS_TONE } from "./components/labels";

interface Stats {
  stats: Record<string, number>;
}
interface SyncSummary {
  total: number;
  successRate: number;
  lastSyncAt: string | null;
  v2Base: string;
}

export default function Home() {
  const [stats, setStats] = useState<Record<string, number>>({});
  const [sync, setSync] = useState<SyncSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const s = await api<Stats>("/api/tickets?stats=1");
      if (s.ok && s.data) setStats(s.data.stats);
      const m = await api<{ summary: SyncSummary }>("/api/sync?summary=1");
      if (m.ok && m.data) setSync(m.data.summary);
      setLoading(false);
    })();
  }, []);

  const total = stats.total ?? 0;
  const open = (stats.pending ?? 0) + (stats.l1_reviewing ?? 0) + (stats.l2_reviewing ?? 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">运单全流程管理 · 总览</h1>
        <p className="mt-1 text-sm text-ink-soft">
          承接 V2 录单数据，覆盖扫描品控 → 异常上报 → 分级审批 → 执行联动的运单全生命周期。
        </p>
      </div>

      {/* KPI 卡片 */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Kpi label="工单总数" value={total} loading={loading} />
        <Kpi label="待处理（审批中）" value={open} loading={loading} tone="amber" />
        <Kpi label="已完成" value={stats.done ?? 0} loading={loading} tone="green" />
        <Kpi
          label="接口成功率"
          value={sync ? `${sync.successRate}%` : "—"}
          loading={loading}
          tone={sync && sync.successRate < 90 ? "red" : "brand"}
        />
      </div>

      {/* 状态分布 */}
      <div className="card p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink">工单状态分布</h2>
        {loading ? (
          <div className="text-sm text-ink-faint">加载中…</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {Object.keys(STATUS_LABELS).map((s) => (
              <div key={s} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5">
                <Badge tone={STATUS_TONE[s]}>{STATUS_LABELS[s]}</Badge>
                <span className="text-sm font-medium text-ink">{stats[s] ?? 0}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 快速入口 */}
      <div className="grid gap-4 md:grid-cols-3">
        <QuickCard
          href="/scan"
          title="扫描品控"
          desc="扫描录入 → 品控规则判定 → 异常自动暂扣建单"
          tag="模块零"
        />
        <QuickCard
          href="/report"
          title="异常上报"
          desc="从真实运单发起物流异常上报（实时校验 V2）"
          tag="模块一"
        />
        <QuickCard
          href="/tickets"
          title="工单与审批"
          desc="分级审批流转、执行联动、审计追踪"
          tag="模块二/三/四"
        />
        <QuickCard href="/monitor" title="接口监控" desc="V2 同步日志、成功率、链路追踪" tag="模块五" />
        <QuickCard href="/config" title="规则配置" desc="审批阈值 / 超时 / 品控规则（可调，不硬编码）" tag="配置" />
        <QuickCard href="/docs" title="交付文档" desc="需求理解与假设说明 · 接口文档 · AI 说明" tag="文档" />
      </div>

      {sync && (
        <div className="text-xs text-ink-faint">
          V2 接口地址：<span className="font-mono">{sync.v2Base}</span>
          {sync.lastSyncAt && <> · 最近同步：{new Date(sync.lastSyncAt).toLocaleString("zh-CN")}</>}
        </div>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  loading,
  tone = "brand",
}: {
  label: string;
  value: number | string;
  loading: boolean;
  tone?: string;
}) {
  const toneClass: Record<string, string> = {
    brand: "text-brand-dark",
    amber: "text-amber-600",
    green: "text-emerald-600",
    red: "text-rose-600",
  };
  return (
    <div className="card p-4">
      <div className="text-xs text-ink-faint">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass[tone]}`}>{loading ? "…" : value}</div>
    </div>
  );
}

function QuickCard({ href, title, desc, tag }: { href: string; title: string; desc: string; tag: string }) {
  return (
    <Link href={href} className="card block p-5 transition-shadow hover:shadow-card-hover">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <Badge tone="brand">{tag}</Badge>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-soft">{desc}</p>
    </Link>
  );
}
