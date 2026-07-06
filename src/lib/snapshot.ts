/**
 * 运单快照解析器：把“实时 V2 校验”与“本地快照降级”统一封装。
 *
 * 策略（详见《需求理解与假设说明》⑥ V2 数据同步策略）：
 *  - 关键动作（发起异常上报、扫描录入）必须实时调用 V2，拿到结果后顺带刷新本地快照。
 *  - V2 不可用时回退到本地快照，并明确标注 dataSource=v2-cache + syncedAt，
 *    而不是整体白屏/报错。
 *  - 快照仅只读缓存，绝不在此改运单状态（运单状态以 V2 为准）。
 */
import { nanoid } from "nanoid";
import type { Store } from "./db/driver";
import type { WaybillDetail, WaybillSnapshot } from "./types";
import { fetchWaybill } from "./v2-client";

/** 运单金额估算：V2 快照本身不含金额字段，按总数量 × 单价系数估算，用于分级审批演示。
 *  真实系统应由 V2 提供金额字段；这里的估算依据写在假设文档中。 */
export function estimateAmount(totalQuantity: number, skuCount: number): number {
  // 以每件 120 元的行业均价估算货值，作为审批金额基准（可被上报人手动覆盖）
  const base = Math.round(totalQuantity * 120);
  return base > 0 ? base : skuCount * 120;
}

/** 把 V2 详情写入/更新本地快照表（只读缓存） */
export async function upsertSnapshot(
  store: Store,
  d: WaybillDetail,
  dataSource: "v2-live" | "v2-cache" = "v2-live"
): Promise<void> {
  const now = new Date().toISOString();
  await store.run(
    `INSERT INTO waybill_snapshot
       (external_code, receiver_store, receiver_name, receiver_phone, receiver_address,
        total_quantity, sku_count, skus_json, warehouse, data_source, synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(external_code) DO UPDATE SET
       receiver_store=excluded.receiver_store,
       receiver_name=excluded.receiver_name,
       receiver_phone=excluded.receiver_phone,
       receiver_address=excluded.receiver_address,
       total_quantity=excluded.total_quantity,
       sku_count=excluded.sku_count,
       skus_json=excluded.skus_json,
       warehouse=excluded.warehouse,
       data_source=excluded.data_source,
       synced_at=excluded.synced_at`,
    [
      d.externalCode,
      d.receiverStore,
      d.receiverName,
      d.receiverPhone,
      d.receiverAddress,
      d.totalQuantity,
      d.skuCount,
      JSON.stringify(d.skus),
      d.receiverStore ?? "default",
      dataSource,
      now,
    ]
  );
}

/** 读取本地快照 */
export async function readSnapshot(store: Store, code: string): Promise<WaybillSnapshot | null> {
  const row = await store.get<Record<string, unknown>>(
    "SELECT * FROM waybill_snapshot WHERE external_code = ?",
    [code]
  );
  if (!row) return null;
  return rowToSnapshot(row);
}

export function rowToSnapshot(row: Record<string, unknown>): WaybillSnapshot {
  const skus = JSON.parse((row.skus_json as string) || "[]");
  const totalQuantity = Number(row.total_quantity) || 0;
  const skuCount = Number(row.sku_count) || 0;
  return {
    externalCode: row.external_code as string,
    receiverStore: (row.receiver_store as string) ?? null,
    receiverName: (row.receiver_name as string) ?? null,
    receiverPhone: (row.receiver_phone as string) ?? null,
    receiverAddress: (row.receiver_address as string) ?? null,
    totalQuantity,
    skuCount,
    skusJson: skus,
    amount: estimateAmount(totalQuantity, skuCount),
    tenant: (row.warehouse as string) ?? "default",
    syncedAt: row.synced_at as string,
  };
}

export interface ResolveResult {
  waybill: WaybillDetail | null;
  /** 数据来源：v2-live 实时 / v2-cache 本地缓存降级 / not_found 不存在 */
  source: "v2-live" | "v2-cache" | "not_found";
  requestId: string;
  /** 降级时的提示信息 */
  degradeNote?: string;
  /** V2 明确返回“不存在”（区别于“V2 挂了”） */
  confirmedNotFound: boolean;
}

/**
 * 解析运单：先实时调 V2；成功则刷新快照并返回 live；
 * 失败（非 404）则降级到本地快照并标注缓存来源；
 * V2 明确 404 则返回 not_found（真实性校验失败，不允许上报）。
 */
export async function resolveWaybill(store: Store, code: string): Promise<ResolveResult> {
  const r = await fetchWaybill(store, code);
  if (r.ok && r.data) {
    await upsertSnapshot(store, r.data, "v2-live");
    return { waybill: r.data, source: "v2-live", requestId: r.meta.requestId, confirmedNotFound: false };
  }
  // V2 明确返回运单不存在：真实性校验失败
  if (r.meta.statusCode === 404) {
    return { waybill: null, source: "not_found", requestId: r.meta.requestId, confirmedNotFound: true };
  }
  // V2 不可用（超时/网络/5xx）：降级到本地快照
  const snap = await readSnapshot(store, code);
  if (snap) {
    const detail: WaybillDetail = {
      externalCode: snap.externalCode,
      receiverStore: snap.receiverStore,
      receiverName: snap.receiverName,
      receiverPhone: snap.receiverPhone,
      receiverAddress: snap.receiverAddress,
      totalQuantity: snap.totalQuantity,
      skuCount: snap.skuCount,
      skus: snap.skusJson,
      sourceFile: null,
      createdAt: snap.syncedAt,
      dataSource: "v2-cache",
      syncedAt: snap.syncedAt,
    };
    return {
      waybill: detail,
      source: "v2-cache",
      requestId: r.meta.requestId,
      degradeNote: `V2 接口不可用（${r.meta.errorCode ?? "未知"}），已降级展示本地缓存，同步于 ${snap.syncedAt}`,
      confirmedNotFound: false,
    };
  }
  // V2 挂了且本地无缓存
  return {
    waybill: null,
    source: "not_found",
    requestId: r.meta.requestId,
    degradeNote: `V2 接口不可用且本地无该运单缓存（${r.meta.errorCode ?? "未知"}）`,
    confirmedNotFound: false,
  };
}

export { nanoid };
