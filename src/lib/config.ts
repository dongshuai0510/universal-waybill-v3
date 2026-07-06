/**
 * 全局可配置项（后台可调，不硬编码）。
 *
 * 呼应 V2 “规则引擎而非硬编码” 的设计理念：
 * 分级审批金额阈值、各类超时时长、重提上限等都以配置项存储在 config 表，
 * 后台页面可调整，代码零改动。此处仅提供“默认值 + 读取/写入”封装。
 *
 * 各默认值的设定依据详见《需求理解与假设说明》文档。
 */
import type { Store } from "./db/driver";

/** 分级审批规则：金额落在哪个区间 → 起始审批层级 */
export interface ApprovalTier {
  /** 金额下限（含），单位：元 */
  minAmount: number;
  /** 起始审批层级：1 = 一级审批；2 = 直接二级审批 */
  startLevel: 1 | 2;
  label: string;
}

export interface V3Config {
  /** 分级审批金额阈值（可配置的分级规则，非硬编码 if amount>500） */
  approvalTiers: ApprovalTier[];
  /** 一级审批超时（分钟）超时后自动升级到二级 */
  l1TimeoutMinutes: number;
  /** 二级审批超时（分钟）超时后自动驳回（兜底） */
  l2TimeoutMinutes: number;
  /** 待审批超时（分钟）超时后自动升级 */
  pendingTimeoutMinutes: number;
  /** 品控暂扣超时（分钟）—— 独立于审批超时，远短于审批超时（压仓成本驱动） */
  qcHoldTimeoutMinutes: number;
  /** 拒绝后允许的重新提交次数上限 */
  resubmitLimit: number;
  /** 达到重提上限后的处理：escalate（强制升级二级）/ close（关闭） */
  resubmitExceededAction: "escalate" | "close";
  /** 品控暂扣超时后的处理：escalate_l2（强制升级二级审批） */
  qcHoldTimeoutAction: "escalate_l2";
  /** 列表中“即将超时”高亮阈值（分钟）：剩余时间少于此值时标红 */
  nearTimeoutMinutes: number;
}

export const DEFAULT_CONFIG: V3Config = {
  // 依据：以“单笔异常涉及金额”为分层依据。小额授权一线快速处理，
  // 大额需二级复核以控风险。金额区间参考电商/物流行业常见赔付分布。
  approvalTiers: [
    { minAmount: 0, startLevel: 1, label: "小额（<2000 元）一级审批" },
    { minAmount: 2000, startLevel: 2, label: "大额（≥2000 元）直接二级审批" },
  ],
  // 依据：物流异常处理时效期望在 1 个工作日内推进；用分钟表达便于演示。
  l1TimeoutMinutes: 24 * 60,
  l2TimeoutMinutes: 48 * 60,
  pendingTimeoutMinutes: 12 * 60,
  // 依据：品控暂扣意味着“货物压仓产生运营成本”，应远短于审批超时。
  // 设为 4 小时，倒逼品控环节快速处置，避免批次长期锁定占用库容。
  qcHoldTimeoutMinutes: 4 * 60,
  resubmitLimit: 2,
  resubmitExceededAction: "escalate",
  qcHoldTimeoutAction: "escalate_l2",
  nearTimeoutMinutes: 120,
};

const CONFIG_KEY = "v3.config";

/** 读取配置（缺失时落库默认值并返回默认值） */
export async function getConfig(store: Store): Promise<V3Config> {
  const row = await store.get<{ value_json: string }>(
    "SELECT value_json FROM config WHERE key = ?",
    [CONFIG_KEY]
  );
  if (!row) {
    await saveConfig(store, DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(row.value_json) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** 覆盖保存配置（后台可调阈值） */
export async function saveConfig(store: Store, cfg: V3Config): Promise<void> {
  const now = new Date().toISOString();
  await store.run(
    `INSERT INTO config (key, value_json, description, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [CONFIG_KEY, JSON.stringify(cfg), "V3 分级审批/超时/重提 可配置项", now]
  );
}

/** 根据金额确定起始审批层级（可配置分级规则的执行） */
export function resolveStartLevel(cfg: V3Config, amount: number): 1 | 2 {
  let level: 1 | 2 = 1;
  const sorted = [...cfg.approvalTiers].sort((a, b) => a.minAmount - b.minAmount);
  for (const t of sorted) {
    if (amount >= t.minAmount) level = t.startLevel;
  }
  return level;
}
