/**
 * 超时自动流转（模块二异常分支，考点 3）。
 *
 * 由后台任务（Vercel Cron 命中 /api/cron/sweep）或手动触发调用，
 * 不依赖人工检查。扫描所有到达 deadline 的未关闭工单，按配置规则处理：
 *
 *  - pending / l1_reviewing 超时 → 自动升级二级审批（给高层再一次机会）
 *  - l2_reviewing 超时         → 自动驳回关闭（closed_timeout，兜底避免永久卡死）
 *  - 品控暂扣（qc_hold）超时   → 强制升级二级审批（qcHoldTimeoutAction）
 *
 * 幂等：以“状态 + deadline 已过”为前置条件，重复执行不会重复处理
 * （处理后 deadline 被重置或工单已关闭）。所有动作写审计日志。
 */
import { nanoid } from "nanoid";
import type { Store } from "./db/driver";
import { getConfig } from "./config";
import { rowToTicket } from "./store";

const now = () => new Date().toISOString();
const addMinutes = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();

export interface SweepResult {
  scanned: number;
  escalated: number;
  autoRejected: number;
  details: { ticketId: string; from: string; to: string; reason: string }[];
}

export async function sweepTimeouts(store: Store): Promise<SweepResult> {
  const cfg = await getConfig(store);
  const ts = now();
  const result: SweepResult = { scanned: 0, escalated: 0, autoRejected: 0, details: [] };

  // 找出所有已过 deadline 且仍在审批环节的工单
  const rows = await store.all<Record<string, unknown>>(
    `SELECT * FROM tickets
     WHERE deadline_at IS NOT NULL AND deadline_at < ?
       AND status IN ('pending','l1_reviewing','l2_reviewing')
     ORDER BY deadline_at ASC LIMIT 500`,
    [ts]
  );
  result.scanned = rows.length;

  for (const row of rows) {
    const t = rowToTicket(row);
    const apId = "ap_" + nanoid(10);
    // 幂等令牌：同一工单同一 deadline 只处理一次
    const opToken = `timeout:${t.id}:${t.deadlineAt}`;

    let toStatus: string;
    let action: string;
    let reason: string;
    let newLevel: number | null = t.currentLevel;
    let newDeadline: string | null;

    if (t.status === "l2_reviewing") {
      // 二级超时 → 自动驳回兜底
      toStatus = "closed_timeout";
      action = "auto_reject";
      reason = `二级审批超时（截止 ${t.deadlineAt}），自动驳回关闭`;
      newLevel = null;
      newDeadline = null;
      result.autoRejected++;
    } else {
      // pending / 一级超时 → 自动升级二级
      toStatus = "l2_reviewing";
      action = "auto_escalate";
      reason = `${t.status} 超时（截止 ${t.deadlineAt}），自动升级二级审批`;
      newLevel = 2;
      newDeadline = addMinutes(cfg.l2TimeoutMinutes);
      result.escalated++;
    }

    try {
      const counts = await store.tx([
        {
          // 乐观锁 + deadline 双重校验：确保是同一状态同一 deadline（幂等）
          text: `UPDATE tickets SET status=?, current_level=?, version=version+1,
                   deadline_at=?, updated_at=?, closed_at=?
                 WHERE id=? AND version=? AND deadline_at=? AND status=?`,
          params: [toStatus, newLevel, newDeadline, ts, toStatus.startsWith("closed") ? ts : null,
                   t.id, t.version, t.deadlineAt, t.status],
        },
        {
          text: `INSERT INTO approval_records
                   (id, ticket_id, approver_id, level, action, opinion, result, op_token, from_status, to_status, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          params: [apId, t.id, "system", t.currentLevel, action, reason, action, opToken, t.status, toStatus, ts],
        },
      ]);
      if (counts[0] > 0) {
        result.details.push({ ticketId: t.id, from: t.status, to: toStatus, reason });
      } else {
        // 已被并发处理，跳过
        result.scanned--;
      }
    } catch (e) {
      if (/unique|constraint/i.test((e as Error).message)) {
        // 幂等：该 deadline 已处理过
        result.scanned--;
        continue;
      }
      throw e;
    }
  }

  return result;
}

/** 品控暂扣超时扫描：qc_hold 批次超时 → 强制升级二级审批（独立超时时长） */
export async function sweepQcHoldTimeouts(store: Store): Promise<{ scanned: number; escalated: number }> {
  const cfg = await getConfig(store);
  const ts = now();
  // 品控暂扣工单：source=scan、category=qc、仍在 pending/l1 且已超过品控暂扣超时
  const cutoff = new Date(Date.now() - cfg.qcHoldTimeoutMinutes * 60_000).toISOString();
  const rows = await store.all<Record<string, unknown>>(
    `SELECT * FROM tickets
     WHERE source='scan' AND exception_category='qc'
       AND status IN ('pending','l1_reviewing')
       AND created_at < ?
     ORDER BY created_at ASC LIMIT 500`,
    [cutoff]
  );
  let escalated = 0;
  for (const row of rows) {
    const t = rowToTicket(row);
    const apId = "ap_" + nanoid(10);
    const opToken = `qc-hold-timeout:${t.id}`;
    try {
      const counts = await store.tx([
        {
          text: `UPDATE tickets SET status='l2_reviewing', current_level=2, version=version+1,
                   deadline_at=?, updated_at=?
                 WHERE id=? AND version=? AND status IN ('pending','l1_reviewing')`,
          params: [addMinutes(cfg.l2TimeoutMinutes), ts, t.id, t.version],
        },
        {
          text: `INSERT INTO approval_records
                   (id, ticket_id, approver_id, level, action, opinion, result, op_token, from_status, to_status, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          params: [apId, t.id, "system", t.currentLevel, "auto_escalate",
                   `品控暂扣超时（>${cfg.qcHoldTimeoutMinutes}分钟，压仓成本），强制升级二级审批`,
                   "auto_escalate", opToken, t.status, "l2_reviewing", ts],
        },
      ]);
      if (counts[0] > 0) escalated++;
    } catch (e) {
      if (/unique|constraint/i.test((e as Error).message)) continue;
      throw e;
    }
  }
  return { scanned: rows.length, escalated };
}
