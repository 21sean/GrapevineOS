/**
 * An in-memory stand-in for the two PostgREST query shapes the checkpointer
 * uses: filtered selects (eq/lt/in, order, limit, range, maybeSingle),
 * upserts keyed on the tables' primary keys, and deletes that can report a
 * count. Just enough of supabase-js's chain to be awaited the same way; a
 * method the saver does not use is deliberately absent so a new query shape
 * fails loudly here rather than passing by accident.
 */
type Row = Record<string, any>;

const KEYS: Record<string, string[]> = {
  chat_checkpoints: ["thread_id", "checkpoint_ns", "checkpoint_id"],
  chat_checkpoint_writes: ["thread_id", "checkpoint_ns", "checkpoint_id", "task_id", "idx"],
};

export class FakeDb {
  tables: Record<string, Row[]> = {};
  /** When true every query throws, the way an unreachable database would. */
  failing = false;

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  keyOf(table: string, row: Row): string {
    return (KEYS[table] ?? ["id"]).map((k) => String(row[k])).join("|");
  }

  reset(): void {
    this.tables = {};
    this.failing = false;
  }
}

type Op =
  | { kind: "select" }
  | { kind: "upsert"; rows: Row[]; ignoreDuplicates: boolean }
  | { kind: "delete"; count: boolean };

class FakeQuery implements PromiseLike<{ data: any; count: number | null }> {
  private filters: ((r: Row) => boolean)[] = [];
  private orderBy?: { col: string; asc: boolean };
  private limitN?: number;
  private slice?: [number, number];
  private single = false;
  private op: Op = { kind: "select" };

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  select(_cols?: string) {
    return this;
  }
  eq(col: string, value: unknown) {
    this.filters.push((r) => r[col] === value);
    return this;
  }
  lt(col: string, value: any) {
    this.filters.push((r) => r[col] < value);
    return this;
  }
  in(col: string, values: unknown[]) {
    this.filters.push((r) => values.includes(r[col]));
    return this;
  }
  order(col: string, opts: { ascending: boolean }) {
    this.orderBy = { col, asc: opts.ascending };
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  range(from: number, to: number) {
    this.slice = [from, to];
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  upsert(rows: Row | Row[], opts?: { ignoreDuplicates?: boolean }) {
    this.op = {
      kind: "upsert",
      rows: Array.isArray(rows) ? rows : [rows],
      ignoreDuplicates: !!opts?.ignoreDuplicates,
    };
    return this;
  }
  delete(opts?: { count?: string }) {
    this.op = { kind: "delete", count: opts?.count === "exact" };
    return this;
  }
  throwOnError() {
    return this;
  }

  then<R1 = { data: any; count: number | null }, R2 = never>(
    onfulfilled?: ((value: { data: any; count: number | null }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    let result: { data: any; count: number | null };
    try {
      result = this.run();
    } catch (err) {
      return Promise.reject(err).then(onfulfilled, onrejected);
    }
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }

  private run(): { data: any; count: number | null } {
    if (this.db.failing) throw new Error("PostgrestError: database down");
    const rows = this.db.rows(this.table);
    if (this.op.kind === "upsert") {
      for (const row of this.op.rows) {
        const key = this.db.keyOf(this.table, row);
        const i = rows.findIndex((r) => this.db.keyOf(this.table, r) === key);
        if (i >= 0) {
          if (!this.op.ignoreDuplicates) rows[i] = { ...rows[i], ...row };
        } else {
          rows.push({ at: new Date().toISOString(), ...row });
        }
      }
      return { data: null, count: null };
    }
    let matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op.kind === "delete") {
      this.db.tables[this.table] = rows.filter((r) => !matched.includes(r));
      return { data: matched, count: this.op.count ? matched.length : null };
    }
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      matched = [...matched].sort(
        (a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1),
      );
    }
    if (this.slice) matched = matched.slice(this.slice[0], this.slice[1] + 1);
    if (this.limitN !== undefined) matched = matched.slice(0, this.limitN);
    return { data: this.single ? (matched[0] ?? null) : matched, count: null };
  }
}

/** The one instance the mocked db module and the tests share. */
export const fakeDb = new FakeDb();
