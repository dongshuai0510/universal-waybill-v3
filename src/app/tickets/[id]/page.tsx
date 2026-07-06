"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api, newOpToken, useToast, Badge, Modal, Spinner } from "../../components/ui";
import { useUser } from "../../components/user";
import {
  STATUS_LABELS, STATUS_TONE, EXCEPTION_LABELS, CATEGORY_LABELS,
  SOURCE_LABELS, ACTION_LABELS, DIRECTION_LABELS, EXECUTION_LABELS,
} from "../../components/labels";

interface Ticket {
  id: string; code: string; category: string; exceptionType: string; source: string;
  waybillCode: string; skuCode: string | null; batchKey: string | null; amount: number;
  description: string; status: string; currentLevel: number | null; version: number;
  resubmitCount: number; reporter: string; deadlineAt: string | null; aiSuggestion: string | null;
  createdAt: string; updatedAt: string; closedAt: string | null;
}
interface Approval {
  id: string; result: string; approver: string; level: number | null; opinion: string;
  fromStatus: string; toStatus: string; createdAt: string;
}
interface Detail {
  ticket: Ticket; timeline: Approval[]; scans: Record<string, unknown>[];
  payouts: Record<string, unknown>[]; ledger: Record<string, unknown>[];
  waybill: (Record<string, unknown> & { dataSourceLabel?: string }) | null;
}

const OPEN_STATUSES = ["pending", "l1_reviewing", "l2_reviewing"];

export default function TicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { userId } = useUser();
  const toast = useToast();
  const [d, setD] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [opinion, setOpinion] = useState("");
  const [confirm, setConfirm] = useState<null | "approve" | "reject" | "execute" | "fast" | "reassign">(null);
  const [aiOpinion, setAiOpinion] = useState<null | { suggestion: string; basis: string; references: string[]; disclaimer: string }>(null);
  const [reassignTo, setReassignTo] = useState("");
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    const r = await api<Detail>(`/api/tickets/${id}`);
    if (r.ok && r.data) setD(r.data);
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const t = d?.ticket;

  async function doApprove(decision: "approve" | "reject") {
    if (!t) return;
    setBusy(true);
    const r = await api(`/api/tickets/${t.id}/approve`, {
      method: "POST",
      body: { decision, opinion, expectedVersion: t.version, opToken: newOpToken() },
    });
    setBusy(false); setConfirm(null); setOpinion("");
    if (r.ok) { toast.push("success", decision === "approve" ? "审批通过" : "已拒绝"); load(); }
    else { toast.push("error", r.error ?? "操作失败"); if (r.status === 409) load(); }
  }

  async function doExecute() {
    if (!t) return;
    setBusy(true);
    const r = await api(`/api/tickets/${t.id}/execute`, {
      method: "POST",
      body: { payoutAmount: t.amount, opToken: newOpToken(), expectedVersion: t.version },
    });
    setBusy(false); setConfirm(null);
    if (r.ok) { toast.push("success", "执行完成，赔付/库存已联动"); load(); }
    else { toast.push("error", r.error ?? "执行失败"); if (r.status === 409) load(); }
  }

  async function doFastRelease() {
    if (!t) return;
    if (!reason.trim()) { toast.push("error", "必须填写复核原因"); return; }
    setBusy(true);
    const r = await api(`/api/tickets/${t.id}/fast-release`, {
      method: "POST", body: { reason, opToken: newOpToken() },
    });
    setBusy(false); setConfirm(null); setReason("");
    if (r.ok) { toast.push("success", "已快速放行，批次解锁"); load(); }
    else toast.push("error", r.error ?? "操作失败");
  }

  async function doReassign() {
    if (!t || !reassignTo) return;
    setBusy(true);
    const r = await api(`/api/tickets/${t.id}/reassign`, {
      method: "POST", body: { newAssignee: reassignTo, reason: reason || "审批人不可用，转交处理" },
    });
    setBusy(false); setConfirm(null); setReason(""); setReassignTo("");
    if (r.ok) { toast.push("success", "已转交"); load(); }
    else toast.push("error", r.error ?? "转交失败");
  }

  async function loadAiOpinion() {
    if (!t) return;
    const r = await api<typeof aiOpinion>(`/api/ai/suggest-opinion`, {
      method: "POST", body: { category: t.category, exceptionType: t.exceptionType, amount: t.amount },
    });
    if (r.ok && r.data) setAiOpinion(r.data);
  }

  if (loading) return <div className="py-20 text-center"><Spinner label="加载工单…" /></div>;
  if (!t) return <div className="card p-8 text-center text-ink-faint">工单不存在</div>;

  const isOpen = OPEN_STATUSES.includes(t.status);
  const isSelfReporter = t.reporter === userId;
  const remain = t.deadlineAt ? new Date(t.deadlineAt).getTime() - Date.now() : null;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-sm text-ink-faint">
        <Link href="/tickets" className="hover:text-brand">← 工单列表</Link>
        <span>/</span>
        <span className="font-mono">{t.id}</span>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* 左：工单主体 */}
        <div className="space-y-5 lg:col-span-2">
          <div className="card p-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge tone={t.category === "qc" ? "brand" : "blue"}>{CATEGORY_LABELS[t.category]}</Badge>
              <Badge tone="gray">{SOURCE_LABELS[t.source]}</Badge>
              <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABELS[t.status]}</Badge>
              {t.currentLevel && isOpen && <Badge tone="purple">当前 {t.currentLevel} 级</Badge>}
              <span className="ml-auto text-xs text-ink-faint">v{t.version}</span>
            </div>
            <h1 className="text-lg font-semibold text-ink">{EXCEPTION_LABELS[t.exceptionType]}</h1>
            <p className="mt-1 text-sm text-ink-soft">{t.description}</p>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <Field label="关联运单" value={t.waybillCode} mono />
              <Field label="涉及金额" value={`¥${t.amount.toLocaleString()}`} />
              <Field label="上报人" value={t.reporter} />
              {t.skuCode && <Field label="SKU" value={t.skuCode} mono />}
              {t.batchKey && <Field label="批次" value={t.batchKey} mono />}
              <Field label="重提次数" value={String(t.resubmitCount)} />
              <Field label="创建时间" value={fmt(t.createdAt)} />
              {t.deadlineAt && isOpen && (
                <Field
                  label="当前环节超时"
                  value={remain !== null && remain <= 0 ? "已超时" : fmt(t.deadlineAt)}
                  danger={remain !== null && remain <= 0}
                />
              )}
            </div>
            {t.aiSuggestion && (
              <div className="mt-4 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-700">
                🤖 {t.aiSuggestion}
              </div>
            )}
          </div>

          {/* 运单信息（来源标注） */}
          {d.waybill && (
            <div className="card p-5">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink">关联运单信息</h2>
                <span className="text-xs text-ink-faint">{d.waybill.dataSourceLabel as string} · 以 V2 为准</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                <Field label="收货门店" value={(d.waybill.receiverStore as string) || "—"} />
                <Field label="收件人" value={(d.waybill.receiverName as string) || "—"} />
                <Field label="总数量" value={String(d.waybill.totalQuantity ?? "—")} />
              </div>
            </div>
          )}

          {/* 赔付 & 库存（可追溯） */}
          {(d.payouts.length > 0 || d.ledger.length > 0) && (
            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold text-ink">执行联动记录（可追溯）</h2>
              {d.payouts.map((p) => (
                <div key={p.id as string} className="mb-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge tone={p.direction === "to_customer" ? "blue" : "amber"}>
                      {DIRECTION_LABELS[p.direction as string]}
                    </Badge>
                    <span className="font-medium">¥{Number(p.amount).toLocaleString()}</span>
                    <span className="text-xs text-ink-faint">对账：{p.reconcile_method as string}</span>
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-ink-faint">
                    赔付ID {p.id as string} ← 审批 {p.approval_record_id as string}
                  </div>
                </div>
              ))}
              {d.ledger.map((l) => (
                <div key={l.id as string} className="mb-1 font-mono text-[11px] text-ink-soft">
                  库存 {Number(l.delta) > 0 ? "+" : ""}{String(l.delta)} · {l.reason as string} ← 审批 {String(l.approval_record_id ?? "—")}
                </div>
              ))}
            </div>
          )}

          {/* 扫描记录 */}
          {d.scans.length > 0 && (
            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold text-ink">关联扫描记录（1:N）</h2>
              <div className="space-y-1.5">
                {d.scans.map((s) => (
                  <div key={s.id as string} className="flex items-center gap-2 text-xs">
                    <Badge tone={s.qc_result === "pass" ? "green" : "red"}>{s.qc_result === "pass" ? "通过" : "异常"}</Badge>
                    <span className="text-ink-soft">{s.judge_reason as string}</span>
                    <span className="ml-auto text-ink-faint">{fmt(s.scan_time as string)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 右：操作 + 审计时间线 */}
        <div className="space-y-5">
          {/* 操作区 */}
          <div className="card p-5">
            <h2 className="mb-3 text-sm font-semibold text-ink">操作</h2>
            {isOpen && (
              <>
                {isSelfReporter && (
                  <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    你是本工单上报人，不能审批自己提交的工单（自批自核禁止）。
                  </div>
                )}
                <textarea
                  value={opinion}
                  onChange={(e) => setOpinion(e.target.value)}
                  placeholder="审批意见…"
                  className="mb-2 w-full rounded-lg border border-line px-3 py-2 text-sm"
                  rows={2}
                />
                <div className="flex gap-2">
                  <button className="btn-primary flex-1" disabled={busy || isSelfReporter} onClick={() => setConfirm("approve")}>通过</button>
                  <button className="btn-ghost flex-1" disabled={busy || isSelfReporter} onClick={() => setConfirm("reject")}>拒绝</button>
                </div>
                <button className="btn-ghost mt-2 w-full text-xs" onClick={() => { loadAiOpinion(); }}>
                  获取 AI 建议审批意见（需人工确认）
                </button>
                {aiOpinion && (
                  <div className="mt-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-700">
                    <div className="font-medium">🤖 {aiOpinion.suggestion}</div>
                    <div className="mt-1 text-violet-600">依据：{aiOpinion.basis}</div>
                    {aiOpinion.references.length > 0 && (
                      <div className="mt-1 font-mono text-[10px]">参考：{aiOpinion.references.join("、")}</div>
                    )}
                    <div className="mt-1 font-medium text-rose-500">{aiOpinion.disclaimer}</div>
                  </div>
                )}
                <div className="mt-3 border-t border-line pt-3">
                  <button className="btn-ghost w-full text-xs" onClick={() => setConfirm("reassign")}>
                    审批人不可用？转交他人（兜底）
                  </button>
                </div>
              </>
            )}
            {t.status === "executing" && (
              <button className="btn-primary w-full" disabled={busy} onClick={() => setConfirm("execute")}>
                执行联动（赔付/库存）
              </button>
            )}
            {t.category === "qc" && isOpen && (
              <div className="mt-3 border-t border-line pt-3">
                <button className="btn-ghost w-full text-xs text-rose-600" onClick={() => setConfirm("fast")}>
                  品控主管误判快速放行（绕过审批）
                </button>
              </div>
            )}
            {!isOpen && t.status !== "executing" && (
              <div className="text-sm text-ink-faint">工单已结束，无可用操作。</div>
            )}
          </div>

          {/* 审计时间线 */}
          <div className="card p-5">
            <h2 className="mb-3 text-sm font-semibold text-ink">状态变更历史（审计日志）</h2>
            <ol className="relative space-y-4 border-l border-line pl-4">
              {d.timeline.map((a) => (
                <li key={a.id} className="relative">
                  <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-brand" />
                  <div className="text-sm font-medium text-ink">{ACTION_LABELS[a.result] ?? a.result}</div>
                  <div className="text-xs text-ink-soft">{a.approver}{a.level ? ` · ${a.level}级` : ""}</div>
                  {a.opinion && <div className="mt-0.5 text-xs text-ink-soft">「{a.opinion}」</div>}
                  <div className="mt-0.5 text-[11px] text-ink-faint">
                    {STATUS_LABELS[a.fromStatus] ?? a.fromStatus} → {STATUS_LABELS[a.toStatus] ?? a.toStatus} · {fmt(a.createdAt)}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      {/* 确认弹窗 */}
      <Modal
        open={confirm === "approve" || confirm === "reject"}
        onClose={() => setConfirm(null)}
        title={confirm === "approve" ? "确认通过？" : "确认拒绝？"}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setConfirm(null)}>取消</button>
            <button className="btn-primary" disabled={busy} onClick={() => doApprove(confirm as "approve" | "reject")}>
              {busy ? "提交中…" : "确认"}
            </button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          {confirm === "approve"
            ? `确认对工单 ${t.id} 执行「通过」。若金额超阈值将自动升级二级审批。`
            : `确认对工单 ${t.id} 执行「拒绝」，将退回重提（受重提上限约束）。`}
        </p>
      </Modal>

      <Modal
        open={confirm === "execute"} onClose={() => setConfirm(null)} title="确认执行联动？"
        footer={<><button className="btn-ghost" onClick={() => setConfirm(null)}>取消</button>
          <button className="btn-primary" disabled={busy} onClick={doExecute}>{busy ? "执行中…" : "确认执行"}</button></>}
      >
        <p className="text-sm text-ink-soft">
          执行后将在单事务内完成：工单→已完成、库存联动、赔付记录（{t.category === "qc" ? "向供应商追偿" : "赔付客户"}），保证一致性。
        </p>
      </Modal>

      <Modal
        open={confirm === "fast"} onClose={() => setConfirm(null)} title="品控主管误判快速放行"
        footer={<><button className="btn-ghost" onClick={() => setConfirm(null)}>取消</button>
          <button className="btn-primary" disabled={busy} onClick={doFastRelease}>{busy ? "处理中…" : "确认放行"}</button></>}
      >
        <p className="mb-2 text-sm text-ink-soft">仅品控主管可操作。将绕过审批直接解锁批次并关闭工单，必须填写复核原因（留痕）。</p>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
          placeholder="复核原因（必填）…" className="w-full rounded-lg border border-line px-3 py-2 text-sm" />
      </Modal>

      <Modal
        open={confirm === "reassign"} onClose={() => setConfirm(null)} title="转交工单（审批人兜底）"
        footer={<><button className="btn-ghost" onClick={() => setConfirm(null)}>取消</button>
          <button className="btn-primary" disabled={busy || !reassignTo} onClick={doReassign}>{busy ? "转交中…" : "确认转交"}</button></>}
      >
        <p className="mb-2 text-sm text-ink-soft">当审批人离职/禁用导致工单卡死时，转交给其他审批人处理。</p>
        <input value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}
          placeholder="新处理人账号（如 appr_zhao）" className="mb-2 w-full rounded-lg border border-line px-3 py-2 text-sm" />
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
          placeholder="转交原因…" className="w-full rounded-lg border border-line px-3 py-2 text-sm" />
      </Modal>
    </div>
  );
}

function Field({ label, value, mono, danger }: { label: string; value: string; mono?: boolean; danger?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-ink-faint">{label}</div>
      <div className={`${mono ? "font-mono text-xs" : "text-sm"} ${danger ? "text-rose-600 font-medium" : "text-ink"}`}>{value}</div>
    </div>
  );
}

function fmt(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
