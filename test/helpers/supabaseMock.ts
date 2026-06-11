import { vi } from 'vitest';

export interface DbResult {
  data: unknown;
  error: unknown;
}

/**
 * A chainable Supabase query-builder fake. Builder methods return the same
 * thenable; awaiting it (or calling .single()) yields the next scripted result.
 */
class QueryBuilder {
  constructor(private readonly results: DbResult[]) {}

  private next(): DbResult {
    return this.results.length > 1 ? this.results.shift()! : (this.results[0] ?? { data: null, error: null });
  }

  // Builder methods — all return `this`.
  select = vi.fn(() => this);
  insert = vi.fn(() => this);
  update = vi.fn(() => this);
  delete = vi.fn(() => this);
  eq = vi.fn(() => this);
  order = vi.fn(() => this);
  limit = vi.fn(() => this);

  // Terminal: single() resolves the next scripted result.
  single = vi.fn(() => Promise.resolve(this.next()));

  // Make the builder awaitable (for queries that don't end in .single()).
  then<T>(onFulfilled: (v: DbResult) => T) {
    return Promise.resolve(this.next()).then(onFulfilled);
  }
}

/**
 * Builds a Supabase mock whose `.from()` returns a fresh builder scripted with
 * the provided results (consumed in order across terminal calls).
 *
 * @param results One result per terminal call, in order. A single result is
 * reused for every terminal call.
 */
export function makeSupabaseMock(results: DbResult[] = [{ data: null, error: null }]) {
  const queue = [...results];
  const from = vi.fn(() => new QueryBuilder(queue));
  return { supabase: { from } };
}
