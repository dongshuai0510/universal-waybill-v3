/**
 * 初始化与演示数据填充。
 *
 *  - ensureSeed：幂等初始化角色、品控规则、配置（首次访问自动执行）。
 *  - seedDemo：生成 ≥200 条异常工单 + 扫描 + 审批 + 赔付 + 库存演示数据，
 *    覆盖不同状态/类型，验证列表筛选/分页/统计在数据量下依然流畅（模块四规模化）。
 *
 * 运单快照来源于 V2：seedDemo 会先尝试从 V2 同步一批真实运单作为快照，
 * V2 不可用时回退到本地已有快照 / 占位快照（并标注 v2-cache），不阻塞演示。
 */
import { nanoid } from "nanoid";
import type { Store } from "./db/driver";
import { lowDb } from "./db/driver";
import { getConfig } from "./config";
import { defaultQcRules, insertQcRule } from "./qc-engine";
import { fetchWaybills } from "./v2-client";
import { upsertSnapshot } from "./snapshot";
import { createTicket, approveTicket, executeTicket, suggestAction } from "./store";
import type { ExceptionType, ExceptionCategory, LogisticsExceptionType, QcExceptionType } from "./types";

const now = () => new Date().toISOString();

/** 默认用户（角色演示） */
const DEFAULT_USERS: Array<{ id: string; name: string; roles: string; warehouse?: string; active?: number }> = [
  { id: "op_wang", name: "王操作（仓库操作员）", roles: "reporter", warehouse: "WH-SH" },
  { id: "op_li", name: "李操作（仓库操作员）", roles: "reporter", warehouse: "WH-SH" },
  { id: "appr_zhang", name: "张审批（一级审批人）", roles: "approver_l1", warehouse: "WH-SH" },
  { id: "appr_zhao", name: "赵审批（二级审批人）", roles: "approver_l2", warehouse: "WH-SH" },
  { id: "qc_chen", name: "陈品控（品控主管）", roles: "qc_supervisor,approver_l1", warehouse: "WH-SH" },
  { id: "admin_sys", name: "系统管理员", roles: "admin,approver_l1,approver_l2", warehouse: "WH-SH" },
  { id: "appr_disabled", name: "已离职审批人（禁用演示）", roles: "approver_l1", warehouse: "WH-SH", active: 0 },
];

export async function ensureSeed(store: Store): Promise<void> {
  // 配置（写默认值）
  await getConfig(store);

  // 用户
  const uCount = await store.get<{ n: number }>("SELECT COUNT(*) AS n FROM users");
  if (!uCount || Number(uCount.n) === 0) {
    for (const u of DEFAULT_USERS) {
      await store.run(
        "INSERT INTO users (id, name, roles, warehouse, active, created_at) VALUES (?,?,?,?,?,?)",
        [u.id, u.name, u.roles, u.warehouse ?? "WH-SH", u.active ?? 1, now()]
      );
    }
  }

  // 品控规则
  const rCount = await store.get<{ n: number }>("SELECT COUNT(*) AS n FROM qc_rules");
  if (!rCount || Number(rCount.n) === 0) {
    for (const r of defaultQcRules()) {
      await insertQcRule(store, {
        subType: r.subType,
        description: r.description,
        condition: r.condition,
        severity: r.severity,
        autoApprovalLevel: r.autoApprovalLevel,
        priority: r.priority,
      });
    }
  }
}

const LOGISTICS_TYPES: LogisticsExceptionType[] = ["lost", "damaged", "rejected", "overtime", "wrong_address"];
const QC_TYPES: QcExceptionType[] = ["quantity_mismatch", "appearance_damage", "spec_mismatch", "label_error", "batch_abnormal"];

const DESCRIPTIONS: Record<string, string> = {
  lost: "客户反馈包裹在途丢失，物流轨迹停滞多日",
  damaged: "签收时外箱严重破损，内件挤压变形",
  rejected: "客户当面拒收，要求退回",
  overtime: "超过时效仍未签收，客户催单",
  wrong_address: "收货地址填写错误，需更正后重新发货",
  quantity_mismatch: "扫描实到数量与应发数量存在差异",
  appearance_damage: "来货外观破损，破损等级偏高",
  spec_mismatch: "规格型号与订单不符",
  label_error: "SKU 标签/条码贴错",
  batch_abnormal: "批号或效期异常",
};

/**
 * 生成演示工单。为覆盖各状态：
 *  - 一部分保持 pending / l1_reviewing / l2_reviewing
 *  - 一部分走完审批 → executing → done（触发赔付/库存联动）
 *  - 一部分被拒
 */
export async function seedDemo(store: Store, count = 220): Promise<{ created: number }> {
  await ensureSeed(store);

  // 准备运单快照：尝试从 V2 同步，失败则用占位
  const codes = await ensureSnapshots(store, 60);

  let created = 0;
  for (let i = 0; i < count; i++) {
    const isQc = i % 2 === 0;
    const category: ExceptionCategory = isQc ? "qc" : "logistics";
    const type: ExceptionType = isQc
      ? QC_TYPES[i % QC_TYPES.length]
      : LOGISTICS_TYPES[i % LOGISTICS_TYPES.length];
    const waybillCode = codes[i % codes.length];
    const amount = [300, 800, 1500, 2600, 4200, 6800][i % 6];
    const reporter = isQc ? "op_li" : "op_wang";
    const skuCode = isQc ? `SKU-${1000 + (i % 40)}` : null;
    const batchKey = isQc ? `${waybillCode}::SKU-${1000 + (i % 40)}` : null;

    const ticket = await createTicket(store, {
      category,
      exceptionType: type,
      source: isQc ? "scan" : "manual",
      waybillCode,
      skuCode,
      batchKey,
      amount,
      description: DESCRIPTIONS[type] ?? "异常",
      reporter,
    });
    created++;

    // 分布到不同状态
    const bucket = i % 5;
    if (bucket === 0) {
      // 保持 pending（待审批）
    } else if (bucket === 1) {
      // 一级审批中：模拟一次拒绝后重提回到 pending
      const fresh = await store.get<{ version: number }>("SELECT version FROM tickets WHERE id=?", [ticket.id]);
      await approveTicket(store, {
        ticketId: ticket.id, approver: "appr_zhang", decision: "reject",
        opinion: "信息不全，退回补充", expectedVersion: fresh?.version ?? 0, opToken: "seed_" + nanoid(8),
      });
    } else {
      // 走完审批链 → 执行 → done
      let t = await store.get<{ version: number; current_level: number; status: string }>(
        "SELECT version, current_level, status FROM tickets WHERE id=?", [ticket.id]
      );
      // 一级审批通过
      const appr1 = ticket.category === "qc" ? "qc_chen" : "appr_zhang";
      await approveTicket(store, {
        ticketId: ticket.id, approver: appr1, decision: "approve",
        opinion: "情况属实，同意处理", expectedVersion: t?.version ?? 0, opToken: "seed_" + nanoid(8),
      });
      t = await store.get("SELECT version, current_level, status FROM tickets WHERE id=?", [ticket.id]);
      // 若升到二级，二级再通过
      if (t?.status === "l2_reviewing") {
        await approveTicket(store, {
          ticketId: ticket.id, approver: "appr_zhao", decision: "approve",
          opinion: "大额已复核，同意", expectedVersion: t.version, opToken: "seed_" + nanoid(8),
        });
        t = await store.get("SELECT version, current_level, status FROM tickets WHERE id=?", [ticket.id]);
      }
      // 执行
      if (t?.status === "executing") {
        const map = suggestAction(category, type);
        await executeTicket(store, {
          ticketId: ticket.id, operator: "admin_sys", action: map.action,
          payoutAmount: amount, opToken: "seed_" + nanoid(8), expectedVersion: t.version,
        });
      }
    }
  }
  return { created };
}

/** 确保有一批运单快照可供工单关联：优先 V2 同步，失败用占位快照 */
async function ensureSnapshots(store: Store, want: number): Promise<string[]> {
  const existing = await store.all<{ external_code: string }>(
    "SELECT external_code FROM waybill_snapshot ORDER BY synced_at DESC LIMIT ?",
    [want]
  );
  if (existing.length >= Math.min(20, want)) return existing.map((r) => r.external_code);

  // 尝试从 V2 拉运单
  const codes: string[] = existing.map((r) => r.external_code);
  try {
    const r = await fetchWaybills(store, { page: 1, pageSize: want });
    if (r.ok && r.data && r.data.waybills.length > 0) {
      for (const w of r.data.waybills) {
        await upsertSnapshot(store, w, "v2-live");
        codes.push(w.externalCode);
      }
    }
  } catch {
    /* V2 不可用，走占位 */
  }

  // 仍不足 → 生成占位快照（标注 v2-cache，仅用于演示工单关联）
  if (codes.length < 20) {
    for (let i = codes.length; i < 20; i++) {
      const code = `DEMO-WB-${String(10000 + i)}`;
      await upsertSnapshot(
        store,
        {
          externalCode: code,
          receiverStore: `演示门店${i}`,
          receiverName: null,
          receiverPhone: null,
          receiverAddress: null,
          totalQuantity: 10 + (i % 30),
          skuCount: 1 + (i % 5),
          skus: [{ skuCode: `SKU-${1000 + (i % 40)}`, skuName: `演示商品${i}`, quantity: 10, spec: "标准" }],
          sourceFile: null,
          createdAt: now(),
          dataSource: "v2-cache",
          syncedAt: now(),
        },
        "v2-cache"
      );
      codes.push(code);
    }
  }
  return codes;
}

/** CLI 入口：npm run seed */
export async function runSeedCli(): Promise<void> {
  const store = await lowDb();
  const r = await seedDemo(store, 220);
  // eslint-disable-next-line no-console
  console.log(`seed done: created ${r.created} tickets`);
}
