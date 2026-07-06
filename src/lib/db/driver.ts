/**
 * 低层数据库驱动抽象（V3 自有数据库，独立于 V2）。
 *
 * - 本地开发：未设置 DATABASE_URL 时用 better-sqlite3（./data/v3.db）。
 * - 部署 Vercel：设置 DATABASE_URL 时用 @neondatabase/serverless（独立 Neon 实例）。
 *
 * 统一以 `?` 占位符书写 SQL，Neon 驱动内部转换为 $1/$2…。
 * 提供原子事务 tx(stmts)：一组语句要么全成功要么全回滚，
 * 用于保证“审批状态变更 + 库存/赔付联动”不出现中间态（考点 4 核心）。
 */

export interface Stmt {
  text: string;
  params?: unknown[];
}

export interface LowDb {
  kind: "sqlite" | "neon";
  init(): Promise<void>;
  all<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | null>;
  /** 返回受影响行数 */
  run(text: string, params?: unknown[]): Promise<number>;
  /** 原子事务：顺序执行所有语句，返回每条的受影响行数；任一失败整体回滚 */
  tx(stmts: Stmt[]): Promise<number[]>;
}

/** 领域层统一使用的存储句柄别名 */
export type Store = LowDb;

let _db: LowDb | null = null;

export async function lowDb(): Promise<LowDb> {
  if (_db) return _db;
  if (process.env.DATABASE_URL) {
    _db = await createNeonLow(process.env.DATABASE_URL);
  } else {
    _db = await createSqliteLow();
  }
  await _db.init();
  return _db;
}

// ---------------- SQLite ----------------

async function createSqliteLow(): Promise<LowDb> {
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const Database = (await import("better-sqlite3")).default;
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  const db = new Database(join(process.cwd(), "data", "v3.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  return {
    kind: "sqlite",
    async init() {
      const { SCHEMA_SQLITE } = await import("./schema");
      db.exec(SCHEMA_SQLITE);
    },
    async all<T>(text: string, params: unknown[] = []) {
      return db.prepare(text).all(...(params as never[])) as T[];
    },
    async get<T>(text: string, params: unknown[] = []) {
      const r = db.prepare(text).get(...(params as never[]));
      return (r ?? null) as T | null;
    },
    async run(text: string, params: unknown[] = []) {
      return db.prepare(text).run(...(params as never[])).changes;
    },
    async tx(stmts: Stmt[]) {
      const counts: number[] = [];
      const fn = db.transaction(() => {
        for (const s of stmts) {
          counts.push(db.prepare(s.text).run(...((s.params ?? []) as never[])).changes);
        }
      });
      fn();
      return counts;
    },
  };
}

// ---------------- Neon ----------------

/** 把 `?` 占位符转换成 Postgres 的 $1/$2… */
function toPg(text: string): string {
  let i = 0;
  return text.replace(/\?/g, () => `$${++i}`);
}

/** neon() 运行时提供 .query()/.transaction()，但类型未暴露；此处按运行时行为声明。 */
interface NeonQueryable {
  query(text: string, params?: unknown[], opts?: { fullResults?: boolean }): Promise<unknown>;
  transaction(
    queries: unknown[],
    opts?: { fullResults?: boolean }
  ): Promise<unknown>;
}

async function createNeonLow(url: string): Promise<LowDb> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url) as unknown as NeonQueryable;

  return {
    kind: "neon",
    async init() {
      const { SCHEMA_NEON_STMTS } = await import("./schema");
      for (const stmt of SCHEMA_NEON_STMTS) {
        await sql.query(stmt);
      }
    },
    async all<T>(text: string, params: unknown[] = []) {
      const rows = (await sql.query(toPg(text), params as unknown[])) as unknown[];
      return rows as T[];
    },
    async get<T>(text: string, params: unknown[] = []) {
      const rows = (await sql.query(toPg(text), params as unknown[])) as unknown[];
      return ((rows[0] as T) ?? null) as T | null;
    },
    async run(text: string, params: unknown[] = []) {
      const res = (await sql.query(toPg(text), params as unknown[], {
        fullResults: true,
      })) as { rowCount: number };
      return res.rowCount ?? 0;
    },
    async tx(stmts: Stmt[]) {
      const queries = stmts.map((s) => sql.query(toPg(s.text), (s.params ?? []) as unknown[]));
      const results = (await sql.transaction(queries, {
        fullResults: true,
      })) as { rowCount: number }[];
      return results.map((r) => r?.rowCount ?? 0);
    },
  };
}
