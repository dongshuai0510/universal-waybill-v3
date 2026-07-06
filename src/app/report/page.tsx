"use client";
/** 物流异常手工上报页（模块一）。 */
import { useState } from "react";
import { api, useToast, Badge, Spinner, newOpToken } from "../components/ui";
import { EXCEPTION_LABELS } from "../components/labels";
import Link from "next/link";

const LOGISTICS_TYPES = ["lost", "damaged", "rejected", "overtime", "wrong_address"] as const;

interface WaybillInfo {
  externalCode: string;
  receiverStore: string | null;
  receiverName: string | null;
  totalQuantity: number;
  skuCount: number;
  dataSource: string;
  syncedAt: string;
  degradeNote?: string | null;
}

export default function ReportPage() {
  const { push } = useToast();
  const [code, setCode] = useState("");
  const [checking, setChecking] = useState(false);
  const [waybill, setWaybill] = useState<WaybillInfo | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  const [exceptionType, setExceptionType] = useState<(typeof LOGISTICS_TYPES)[number]>("lost");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [ai, setAi] = useState<{ suggestedType: string; severity: string; basis: string; disclaimer: string; source: string } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [result, setResult] = useState<{ id: string } | null>(null);

  async function check() {
    if (!code.trim()) return;
    setChecking(true);
    setWaybill(null);
    setCheckError(null);
    setResult(null);
    const r = await api<{ exists: boolean; waybill: WaybillInfo; source: string; degradeNote?: string | null; requestId: string }>(
      `/api/waybill?code=${encodeURIComponent(code.trim())}`
    );
    setChecking(false);
    if (r.ok && r.data?.exists && r.data.waybill) {
      setWaybill({ ...r.data.waybill, dataSource: r.data.source, degradeNote: r.data.degradeNote });
    } else {
      setCheckError(r.data ? r.error ?? "运单校验失败" : r.error ?? "校验失败");
    }
  }

  async function classify() {
    if (!description.trim()) {
      push("info", "请先填写异常描述，AI 才能给出建议");
      return;
    }
    setAiLoading(true);
    const r = await api<{ suggestedType: string; severity: string; basis: string; disclaimer: string; source: string }>(
      "/api/ai/classify",
      { method: "POST", body: { text: description, category: "logistics" } }
    );
    setAiLoading(false);
    if (r.ok && r.data) {
      setAi(r.data);
      // AI 建议仅预填，人工可改
      if (LOGISTICS_TYPES.includes(r.data.suggestedType as (typeof LOGISTICS_TYPES)[number])) {
        setExceptionType(r.data.suggestedType as (typeof LOGISTICS_TYPES)[number]);
      }
    }
  }

  async function submit() {
    if (!waybill) return;
    setSubmitting(true);
    const r = await api<{ ticket: { id: string } }>("/api/report", {
      method: "POST",
      body: {
        waybillCode: waybill.externalCode,
        exceptionType,
        description,
        amount: amount ? Number(amount) : undefined,
        aiSuggestion: ai ? `${ai.disclaimer}：${ai.suggestedType}（${ai.basis}）` : undefined,
        opToken: newOpToken(),
      },
    });
    setSubmitting(false);
    if (r.ok && r.data) {
      push("success", "异常上报成功，已创建工单");
      setResult({ id: r.data.ticket.id });
    } else {
      push("error", r.error ?? "上报失败");
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-lg font-semibold text-ink">物流异常上报</h1>
      <p className="mb-5 text-sm text-ink-soft">
        发货后异常手工上报。发起上报会<strong className="text-brand-dark">实时调用 V2 接口</strong>校验运单真实存在，不允许对不存在的运单上报。
      </p>

      {/* Step 1 运单校验 */}
      <div className="card mb-4 p-5">
        <div className="mb-2 text-sm font-medium text-ink">① 运单真实性校验（实时调用 V2）</div>
        <div className="flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && check()}
            placeholder="输入运单外部编码，如 PS2512220005001"
            className="flex-1 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <button onClick={check} disabled={checking} className="btn-primary">
            {checking ? <Spinner label="校验中" /> : "校验运单"}
          </button>
        </div>
        {checkError && (
          <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{checkError}</div>
        )}
        {waybill && (
          <div className="mt-3 rounded-lg border border-line bg-brand-tint2 p-3 text-sm">
            <div className="mb-1 flex items-center gap-2">
              <Badge tone="green">运单存在</Badge>
              <Badge tone={waybill.dataSource === "v2-live" ? "brand" : "amber"}>
                {waybill.dataSource === "v2-live" ? "实时获取自 V2" : `本地缓存（同步于 ${waybill.syncedAt}）`}
              </Badge>
            </div>
            <div className="text-ink-soft">
              收货：{waybill.receiverStore || waybill.receiverName || "—"}　·　SKU {waybill.skuCount} 种　·　总数量 {waybill.totalQuantity}
            </div>
            {waybill.degradeNote && <div className="mt-1 text-amber-700">{waybill.degradeNote}</div>}
          </div>
        )}
      </div>

      {/* Step 2 异常信息 */}
      {waybill && !result && (
        <div className="card mb-4 p-5">
          <div className="mb-3 text-sm font-medium text-ink">② 异常信息</div>
          <label className="mb-1 block text-xs text-ink-faint">异常描述</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="描述具体情况，如：客户反馈包裹破损，外箱变形…"
            className="mb-2 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <button onClick={classify} disabled={aiLoading} className="btn-ghost mb-3 text-xs">
            {aiLoading ? <Spinner label="AI 分析中" /> : "🤖 AI 辅助判断异常类型"}
          </button>
          {ai && (
            <div className="mb-3 rounded-lg border border-violet-200 bg-violet-50 p-3 text-xs text-violet-800">
              <div className="mb-0.5 font-medium">
                {ai.disclaimer}（{ai.source === "llm" ? "大模型" : "本地启发式"}）
              </div>
              <div>建议类型：{EXCEPTION_LABELS[ai.suggestedType] ?? ai.suggestedType}　严重度：{ai.severity}</div>
              <div className="text-violet-600">依据：{ai.basis}</div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-ink-faint">异常类型（可修改 AI 建议）</label>
              <select
                value={exceptionType}
                onChange={(e) => setExceptionType(e.target.value as (typeof LOGISTICS_TYPES)[number])}
                className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
              >
                {LOGISTICS_TYPES.map((t) => (
                  <option key={t} value={t}>{EXCEPTION_LABELS[t]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-faint">涉及金额（元，留空则按数量估算）</label>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="自动估算"
                className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <button onClick={submit} disabled={submitting} className="btn-primary">
              {submitting ? <Spinner label="提交中" /> : "提交上报"}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="card border-emerald-200 bg-emerald-50 p-5 text-sm">
          <div className="mb-2 font-medium text-emerald-800">✓ 上报成功，工单已创建并进入审批流程</div>
          <Link href={`/tickets/${result.id}`} className="btn-primary">查看工单详情</Link>
        </div>
      )}
    </div>
  );
}
