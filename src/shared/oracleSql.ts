// Paging and limiting for Oracle, which has two incompatible spellings.
//
// Oracle 12c added the SQL standard form (`OFFSET n ROWS FETCH NEXT m ROWS ONLY`
// and `FETCH FIRST n ROWS ONLY`). Oracle 11g and older reject it with
// ORA-00933/ORA-00921, so a driver that always emits the modern form cannot
// browse any table on an old server. The legacy form wraps the query in
// ROWNUM filters, which every version understands.
//
// This module is pure so the two shapes can be tested without a database.

export interface OraclePaging {
  offset: number
  limit: number
}

/**
 * Adds offset/limit to a query using the syntax the server understands.
 *
 * `modern` is true for 12c+. The legacy form needs a subquery because ROWNUM is
 * assigned before ORDER BY is applied: filtering `ROWNUM <= offset + limit` in
 * the inner query and `> offset` in the outer one is the standard workaround.
 */
export function oraclePageSql(
  selectSql: string,
  paging: OraclePaging,
  modern: boolean
): string {
  if (modern) {
    return `${selectSql} OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY`
  }
  // A page that starts at 0 still needs the inner limit, so the outer bound is
  // `offset + limit` in both cases.
  const outer = paging.offset > 0 ? ` WHERE rn > :off` : ''
  return (
    `SELECT * FROM (SELECT p.*, ROWNUM AS rn FROM (${selectSql}) p ` +
    `WHERE ROWNUM <= :lim2)${outer}`
  )
}

/** Binds for the chosen shape; only names the statement actually contains. */
export function oraclePageBinds(
  paging: OraclePaging,
  modern: boolean
): Record<string, number> {
  if (modern) return { off: paging.offset, lim: paging.limit }
  // The legacy shape only references :off on a page after the first. Passing it
  // on page 1 raises ORA-01036 "unrecognized bind variable", because Oracle
  // rejects a bind the statement never mentions.
  const binds: Record<string, number> = { lim2: paging.offset + paging.limit }
  if (paging.offset > 0) binds.off = paging.offset
  return binds
}

/**
 * Limits a query to `limit` rows without an offset. Used by the search queries,
 * which only ever want the first N results.
 */
export function oracleLimitSql(
  selectSql: string,
  limit: number,
  modern: boolean
): string {
  return modern
    ? `${selectSql} FETCH FIRST ${limit} ROWS ONLY`
    : `SELECT * FROM (${selectSql}) WHERE ROWNUM <= ${limit}`
}
