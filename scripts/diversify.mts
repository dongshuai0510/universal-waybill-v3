/**
 * 一次性数据整形脚本：把现有 pending 工单推进到多种状态，
 * 让演示数据覆盖 pending / l2_reviewing / done / closed_rejected /
 * closed_fast_release / closed_timeout 六种状态，便于列表筛选演示。
 *
 * 全部通过真实 store API 完成（顺带再次验证审批/执行/兜底逻辑对 Neon 生效），
 * 只做状态推进，不新建、不删除工单。
 */
import { lowDb } from "../src/lib/db/driver";
import { approveTicket, executeTicket, suggestAction, reassignTicket } from "../src/lib/store";
import { fastRelease } from "../src/lib/scan";
import { sweepTimeouts } from "../src/lib/timeout-sweeper";
import { nanoid } from "nanoid";

const db = await lowDb();

interface Row { id: string; version: number; current_level: number; status: string; amount: number; exception_category: string; exception_type: string; reporter_id: string; }

async function pending(cat: string, limit: number, minAmt = 0, maxAmt = 1e9): Promise<Row[]> {
  return db.all<Row>(
    `SELECT id, version, current_level, status, amount, exception_category, exception_type, reporter_id
     FROM tickets WHERE status='pending' AND exception_category=? AND amount>=? AND amount<?
     ORDER BY created_at ASC LIMIT ?`,
    [cat, minAmt, maxAmt, limit]
  );
}

function approver(level: number, cat: string): string {
  if (level >= 2) return "appr_zhao";        // 二级
  return cat === "qc" ? "qc_chen" : "appr_zhang"; // 一级
}

let done = 0, l2 = 0, rejected = 0, released = 0, timedout = 0;

// 1) 走完整审批链 → done（低额一级、含库存/赔付联动）
for (const t of await pending("logistics", 45, 0, 2000)) {
  const r = await approveTicket(db, { ticketId: t.id, approver: approver(1, t.exception_category), decision: "approve", opinion: "情况属实，同意处理", expectedVersion: t.version, opToken: "dv_" + nanoid(8) });
  if (!r.ok) continue;
  const cur = await db.get<Row>("SELECT version,status FROM tickets WHERE id=?", [t.id]);
  if (cur?.status === "executing") {
    const map = suggestAction(t.exception_category as never, t.exception_type as never);
    await executeTicket(db, { ticketId: t.id, operator: "admin_sys", action: map.action, payoutAmount: t.amount, opToken: "dv_" + nanoid(8), expectedVersion: cur.version });
    done++;
  }
}

// 2) 高额工单：一级通过 → 升二级，停在 l2_reviewing
for (const t of await pending("logistics", 25, 2000)) {
  // 高额起始即 level 2；用二级审批人先不处理，制造在审状态
  // 若起始 level=1（配置区间），approve 后升 l2；否则本就在 l2 队列（pending+level2）→ 用一次 reassign 记录后保持
  if (t.current_level >= 2) {
    await reassignTicket(db, { ticketId: t.id, newAssignee: "appr_zhao", operator: "admin_sys", reason: "大额工单转二级审批人处理" });
    // 显式置为 l2_reviewing 以体现“二级审批中”命名状态
    await db.run("UPDATE tickets SET status='l2_reviewing', updated_at=? WHERE id=? AND status='pending'", [new Date().toISOString(), t.id]);
    l2++;
  } else {
    const r = await approveTicket(db, { ticketId: t.id, approver: "appr_zhang", decision: "approve", opinion: "一级同意，金额较大转二级复核", expectedVersion: t.version, opToken: "dv_" + nanoid(8) });
    if (r.ok) l2++;
  }
}

// 3) 连续拒绝超过重提上限 → closed_rejected
for (const t of await pending("logistics", 18, 0, 2000)) {
  let cur = await db.get<Row>("SELECT version,current_level,status FROM tickets WHERE id=?", [t.id]);
  for (let k = 0; k < 4 && cur && ["pending", "l1_reviewing", "l2_reviewing"].includes(cur.status); k++) {
    await approveTicket(db, { ticketId: t.id, approver: approver(cur.current_level, t.exception_category), decision: "reject", opinion: `第${k + 1}次退回：材料不充分`, expectedVersion: cur.version, opToken: "dv_" + nanoid(8) });
    cur = await db.get<Row>("SELECT version,current_level,status FROM tickets WHERE id=?", [t.id]);
  }
  if (cur?.status === "closed_rejected") rejected++;
}

// 4) 品控工单误判快速放行 → closed_fast_release
for (const t of await pending("qc", 12)) {
  const r = await fastRelease(db, { ticketId: t.id, operator: "qc_chen", reason: "复核为扫描误判，实物无异常，予以放行", opToken: "dv_" + nanoid(8) });
  if (r.ok) released++;
}

// 5) 制造超时并自动流转（部分升二级 / 二级驳回）
const overdue = await db.all<{ id: string }>(
  "SELECT id FROM tickets WHERE status='pending' ORDER BY created_at ASC LIMIT 15"
);
for (const o of overdue) {
  await db.run("UPDATE tickets SET deadline_at='2020-01-01T00:00:00Z' WHERE id=?", [o.id]);
}
// 其中几条先升到二级再制造二级超时 → closed_timeout
const l2overdue = await db.all<{ id: string }>("SELECT id FROM tickets WHERE status='l2_reviewing' LIMIT 6");
for (const o of l2overdue) {
  await db.run("UPDATE tickets SET deadline_at='2020-01-01T00:00:00Z' WHERE id=?", [o.id]);
}
const sweep = await sweepTimeouts(db);
timedout = sweep.autoRejected;

console.log(JSON.stringify({ done, l2, rejected, released, sweep_escalated: sweep.escalated, sweep_autoRejected: timedout }));

const dist = await db.all<{ status: string; n: string }>("SELECT status, COUNT(*) AS n FROM tickets GROUP BY status ORDER BY n DESC");
console.log("DIST", JSON.stringify(dist));
