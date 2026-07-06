"use client";
import { useEffect, useState, useCallback } from "react";
import { api, useToast, Badge, Spinner } from "../components/ui";
import { EXCEPTION_LABELS } from "../components/labels";

interface ScanRow {
  id: string;
  waybillCode: string;
  skuCode: string;
  verdict: "pass" | "fail";
  ruleReason: string | null;
  batchStatus: string;
  ticketId: string | null;
  scannedAt: string;
}

const BATCH_LABELS: Record<string, string> = {
  scanned: "已扫描",
  shippable: "可出库",
  qc_hold: "品控暂扣（锁定）",
  released: "已放行",
  returned: "已退供",
  scrapped: "已作废",
  downgraded: "已降级",
};

export default function ScanPage() {
  const toast = useToast();
  const [form, setForm] = useState({
    waybillCode: "",
    skuCode: "",
    expectedQty: 100,
    actualQty: 100,
    damageLevel: 0,
    specDeviationPct: 0,
    labelError: false,
    batchError: false,
  });
  const [busy, setBusy] = useState(false);
  const [scans, setScans] = useState<ScanRow[]>([]);
  const [lastResult, setLastResult] = useState<{ msg: string; kind: "pass" | "fail" | "idem"; reason?: string; ticketId?: string | null; requestId?: string } | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ scans: ScanRow[] }>("/api/scan");
    if (r.ok && r.data) setScans(r.data.scans);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function submit() {
    if (!form.waybillCode.trim() || !form.skuCode.trim()) {
      toast.push("error", "请填写运单号与 SKU 编码");
      return;
    }
    setBusy(true);
    setLastResult(null);
    const r = await api<{
      ok: boolean; message: string; verdict?: string; reason?: string;
      ticket?: { id: string } | null; idempotentHit?: boolean; requestId?: string;
    }>("/api/scan", { method: "POST", body: form });
    setBusy(false);
    if (!r.ok) {
      toast.push("error", r.error ?? "扫描失败");
      setLastResult({ msg: r.error ?? "扫描失败", kind: "fail" });
      return;
    }
    const d = r.data!;
    const kind = d.idempotentHit ? "idem" : d.verdict === "pass" ? "pass" : "fail";
    setLastResult({
      msg: d.message,
      kind,
      reason: d.reason,
      ticketId: d.ticket?.id ?? null,
      requestId: d.requestId,
    });
    toast.push(kind === "pass" ? "success" : "info", d.message);
    load();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">扫描操作与品控检测</h1>
        <p className="mt-1 text-sm text-ink-soft">
          模拟扫描枪录入 SKU。系统先通过 <b>V2 接口</b> 校验 SKU 确属该运单，再由<b>可配置品控规则引擎</b>判定，异常自动暂扣批次并创建工单。
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 录入表单 */}
        <div className="card p-5">
          <h2 className="mb-4 text-sm font-semibold text-ink">扫描录入</h2>
          <div className="space-y-3">
            <Field label="运单号（V2 真实运单）">
              <input className="inp" value={form.waybillCode}
                onChange={(e) => setForm({ ...form, waybillCode: e.target.value })}
                placeholder="扫描/输入运单外部编码" />
            </Field>
            <Field label="SKU 编码">
              <input className="inp" value={form.skuCode}
                onChange={(e) => setForm({ ...form, skuCode: e.target.value })}
                placeholder="扫描/输入 SKU 编码" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="应发数量">
                <input type="number" className="inp" value={form.expectedQty}
                  onChange={(e) => setForm({ ...form, expectedQty: Number(e.target.value) })} />
              </Field>
              <Field label="实到数量">
                <input type="number" className="inp" value={form.actualQty}
                  onChange={(e) => setForm({ ...form, actualQty: Number(e.target.value) })} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="破损等级 (0-5)">
                <input type="number" min={0} max={5} className="inp" value={form.damageLevel}
                  onChange={(e) => setForm({ ...form, damageLevel: Number(e.target.value) })} />
              </Field>
              <Field label="规格偏差 %">
                <input type="number" className="inp" value={form.specDeviationPct}
                  onChange={(e) => setForm({ ...form, specDeviationPct: Number(e.target.value) })} />
              </Field>
            </div>
            <div className="flex gap-4 pt-1">
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <input type="checkbox" checked={form.labelError}
                  onChange={(e) => setForm({ ...form, labelError: e.target.checked })} />
                标签异常
              </label>
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <input type="checkbox" checked={form.batchError}
                  onChange={(e) => setForm({ ...form, batchError: e.target.checked })} />
                批次异常
              </label>
            </div>
            <button className="btn-primary w-full" onClick={submit} disabled={busy}>
              {busy ? <Spinner label="校验并判定中…" /> : "提交扫描"}
            </button>
          </div>

          {lastResult && (
            <div className={`mt-4 rounded-lg border p-3 text-sm ${
              lastResult.kind === "pass" ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : lastResult.kind === "idem" ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-rose-200 bg-rose-50 text-rose-800"}`}>
              <div className="font-medium">{lastResult.msg}</div>
              {lastResult.reason && <div className="mt-1 text-xs opacity-80">判定依据：{lastResult.reason}</div>}
              {lastResult.ticketId && (
                <a href={`/tickets/${lastResult.ticketId}`} className="mt-1 inline-block text-xs underline">
                  查看工单 {lastResult.ticketId} →
                </a>
              )}
              {lastResult.requestId && <div className="mt-1 text-xs opacity-60">Request ID: {lastResult.requestId}</div>}
            </div>
          )}
        </div>

        {/* 品控演示提示 */}
        <div className="card p-5">
          <h2 className="mb-3 text-sm font-semibold text-ink">品控规则引擎（可配置）</h2>
          <p className="text-xs text-ink-soft">
            判定阈值来自 <a href="/config" className="text-brand underline">品控规则表</a>，非硬编码。默认规则：
          </p>
          <ul className="mt-2 space-y-1.5 text-xs text-ink-soft">
            <li>• 数量差异 ≥ 5% → 数量不符（一级）</li>
            <li>• 破损等级 ≥ 3 → 外观破损（<b>二级</b>）</li>
            <li>• 规格偏差 ≥ 10% → 规格不符（一级）</li>
            <li>• 标签异常 → 标签错误（一级）</li>
            <li>• 批次异常 → 批次异常（<b>二级</b>）</li>
          </ul>
          <div className="mt-4 rounded-lg bg-brand-tint/50 p-3 text-xs text-brand-dark">
            <b>试一试：</b>把实到数量改成与应发差 ≥ 5%，或把破损等级设为 3+，提交后会看到批次<b>暂扣</b>并自动创建品控工单。相同批次再次提交会命中<b>幂等</b>提示。
          </div>
        </div>
      </div>

      {/* 最近扫描 */}
      <div className="card overflow-hidden">
        <div className="border-b border-line px-5 py-3 text-sm font-semibold text-ink">最近扫描记录</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-ink-faint">
              <tr>
                <th className="px-4 py-2 text-left">运单号</th>
                <th className="px-4 py-2 text-left">SKU</th>
                <th className="px-4 py-2 text-left">判定</th>
                <th className="px-4 py-2 text-left">批次状态</th>
                <th className="px-4 py-2 text-left">依据 / 工单</th>
                <th className="px-4 py-2 text-left">时间</th>
              </tr>
            </thead>
            <tbody>
              {scans.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-faint">暂无扫描记录</td></tr>
              )}
              {scans.map((s) => (
                <tr key={s.id} className="border-t border-line-soft">
                  <td className="px-4 py-2 font-mono text-xs">{s.waybillCode}</td>
                  <td className="px-4 py-2 font-mono text-xs">{s.skuCode}</td>
                  <td className="px-4 py-2">
                    <Badge tone={s.verdict === "pass" ? "green" : "red"}>{s.verdict === "pass" ? "通过" : "异常"}</Badge>
                  </td>
                  <td className="px-4 py-2">
                    <Badge tone={s.batchStatus === "qc_hold" ? "red" : s.batchStatus === "shippable" ? "green" : "gray"}>
                      {BATCH_LABELS[s.batchStatus] ?? s.batchStatus}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-xs text-ink-soft">
                    {s.ticketId ? (
                      <a href={`/tickets/${s.ticketId}`} className="text-brand underline">{s.ticketId}</a>
                    ) : (
                      <span className="line-clamp-1">{s.ruleReason}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-ink-faint">{new Date(s.scannedAt).toLocaleString("zh-CN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-soft">{label}</span>
      {children}
    </label>
  );
}
