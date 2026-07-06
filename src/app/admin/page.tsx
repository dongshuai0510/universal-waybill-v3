"use client";
/**
 * 后台配置页（模块二/七）：
 *  - 分级审批金额阈值 / 各类超时 / 重提上限 —— 可配置（非硬编码）
 *  - 品控规则列表 + 新增（可配置触发条件）
 *  - 超时自动流转手动触发（演示）
 *  - 生成 ≥200 条演示数据
 */
import { useEffect, useState } from "react";
import { api, useToast, Badge, Spinner } from "../components/ui";
import { EXCEPTION_LABELS } from "../components/labels";

interface Config {
  approvalTiers: { minAmount: number; startLevel: 1 | 2; label: string }[];
  l1TimeoutMinutes: number;
  l2TimeoutMinutes: number;
  pendingTimeoutMinutes: number;
  qcHoldTimeoutMinutes: number;
  resubmitLimit: number;
  resubmitExceededAction: string;
  nearTimeoutMinutes: number;
}

interface QcRule {
  id: string;
  exceptionSubtype: string;
  conditionType: string;
  threshold: number;
  severity: string;
  autoApprovalLevel: number;
  name: string;
}

export default function AdminPage() {
  const { push } = useToast();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [rules, setRules] = useState<QcRule[]>([]);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const [c, r] = await Promise.all([
      api<{ config: Config }>("/api/config"),
      api<{ rules: QcRule[] }>("/api/qc-rules"),
    ]);
    if (c.data) setCfg(c.data.config);
    if (r.data) setRules(r.data.rules);
  }
  useEffect(() => {
    load();
  }, []);

  async function saveConfig() {
    if (!cfg) return;
    setSaving(true);
    const r = await api("/api/config", { method: "PUT", body: cfg });
    setSaving(false);
    if (r.ok) push("success", "配置已保存（阈值即时生效，无需改代码）");
    else push("error", r.error ?? "保存失败");
  }

  async function sweep() {
    setBusy("sweep");
    const r = await api<{ approval: { escalated: number; autoRejected: number }; qcHold: { escalated: number } }>(
      "/api/cron/sweep",
      { method: "POST" }
    );
    setBusy(null);
    if (r.ok && r.data)
      push(
        "success",
        `超时扫描完成：升级 ${r.data.approval.escalated} · 驳回 ${r.data.approval.autoRejected} · 品控暂扣升级 ${r.data.qcHold.escalated}`
      );
    else push("error", r.error ?? "扫描失败");
  }

  async function seed() {
    setBusy("seed");
    const r = await api<{ created?: number; skipped?: boolean; message?: string }>("/api/seed", {
      method: "POST",
      body: {},
      timeoutMs: 60000,
    });
    setBusy(null);
    if (r.ok && r.data)
      push("success", r.data.skipped ? r.data.message ?? "已跳过" : `已生成 ${r.data.created} 条演示工单`);
    else push("error", r.error ?? "生成失败");
  }

  if (!cfg) return <Spinner label="加载配置…" />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-ink">后台配置</h1>
        <p className="mt-0.5 text-sm text-ink-soft">
          分级阈值、各类超时、重提上限、品控规则均为可配置项，后台调整即时生效，呼应 V2「规则引擎而非硬编码」理念。
        </p>
      </div>

      {/* 分级审批阈值 */}
      <div className="card p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink">分级审批金额阈值</h2>
        <div className="space-y-2">
          {cfg.approvalTiers.map((t, i) => (
            <div key={i} className="flex items-center gap-3 text-sm">
              <span className="text-ink-soft">金额 ≥</span>
              <input
                type="number"
                value={t.minAmount}
                onChange={(e) => {
                  const tiers = [...cfg.approvalTiers];
                  tiers[i] = { ...t, minAmount: Number(e.target.value) };
                  setCfg({ ...cfg, approvalTiers: tiers });
                }}
                className="w-28 rounded-lg border border-line px-2 py-1"
              />
              <span className="text-ink-soft">元 → 起始层级</span>
              <select
                value={t.startLevel}
                onChange={(e) => {
                  const tiers = [...cfg.approvalTiers];
                  tiers[i] = { ...t, startLevel: Number(e.target.value) as 1 | 2 };
                  setCfg({ ...cfg, approvalTiers: tiers });
                }}
                className="rounded-lg border border-line px-2 py-1"
              >
                <option value={1}>一级审批</option>
                <option value={2}>直接二级审批</option>
              </select>
              <span className="text-xs text-ink-faint">{t.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 超时与重提 */}
      <div className="card p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink">超时时长与重提上限（分钟）</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <NumField label="待审批超时" value={cfg.pendingTimeoutMinutes} onChange={(v) => setCfg({ ...cfg, pendingTimeoutMinutes: v })} />
          <NumField label="一级审批超时" value={cfg.l1TimeoutMinutes} onChange={(v) => setCfg({ ...cfg, l1TimeoutMinutes: v })} />
          <NumField label="二级审批超时" value={cfg.l2TimeoutMinutes} onChange={(v) => setCfg({ ...cfg, l2TimeoutMinutes: v })} />
          <NumField
            label="品控暂扣超时（独立·更短）"
            value={cfg.qcHoldTimeoutMinutes}
            onChange={(v) => setCfg({ ...cfg, qcHoldTimeoutMinutes: v })}
            hint="压仓成本驱动，远短于审批超时"
          />
          <NumField label="重提次数上限" value={cfg.resubmitLimit} onChange={(v) => setCfg({ ...cfg, resubmitLimit: v })} />
          <NumField label="即将超时高亮阈值" value={cfg.nearTimeoutMinutes} onChange={(v) => setCfg({ ...cfg, nearTimeoutMinutes: v })} />
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button onClick={saveConfig} disabled={saving} className="btn-primary">
            {saving ? "保存中…" : "保存配置"}
          </button>
          <span className="text-xs text-ink-faint">
            超过重提上限处理：{cfg.resubmitExceededAction === "escalate" ? "强制升级二级审批" : "关闭工单"}
          </span>
        </div>
      </div>

      {/* 品控规则 */}
      <div className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">品控规则（可配置触发条件，非硬编码）</h2>
          <Badge tone="brand">{rules.length} 条启用</Badge>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-faint">
              <th className="py-2">异常子类型</th>
              <th>触发条件</th>
              <th>阈值</th>
              <th>严重度</th>
              <th>自动进入</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="border-b border-line-soft">
                <td className="py-2 font-medium text-ink">{EXCEPTION_LABELS[r.exceptionSubtype] ?? r.exceptionSubtype}</td>
                <td className="text-ink-soft">{r.conditionType}</td>
                <td className="text-ink-soft">{r.threshold}</td>
                <td>
                  <Badge tone={r.severity === "high" ? "red" : r.severity === "medium" ? "amber" : "gray"}>{r.severity}</Badge>
                </td>
                <td className="text-ink-soft">{r.autoApprovalLevel === 2 ? "二级审批" : "一级审批"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-ink-faint">
          规则存于 qc_rules 表，扫描时引擎按优先级遍历命中，记录命中规则 ID + 判定依据，可追溯。
        </p>
      </div>

      {/* 运维动作 */}
      <div className="card p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink">运维 / 演示</h2>
        <div className="flex flex-wrap gap-3">
          <button onClick={sweep} disabled={busy === "sweep"} className="btn-ghost">
            {busy === "sweep" ? "扫描中…" : "立即扫描超时工单（模拟 Cron）"}
          </button>
          <button onClick={seed} disabled={busy === "seed"} className="btn-ghost">
            {busy === "seed" ? "生成中…" : "生成 ≥200 条演示工单"}
          </button>
        </div>
        <p className="mt-3 text-xs text-ink-faint">
          生产环境超时流转由 Vercel Cron 定时命中 /api/cron/sweep，不依赖人工检查。
        </p>
      </div>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-ink-soft">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full rounded-lg border border-line px-2 py-1.5 text-sm"
      />
      {hint && <span className="mt-0.5 block text-[11px] text-ink-faint">{hint}</span>}
    </label>
  );
}
