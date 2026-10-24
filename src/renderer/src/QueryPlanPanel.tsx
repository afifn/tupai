import { useMemo, useState } from 'react'
import type { ExplainResult } from '@shared/types'
import { useLocale } from './i18n'
import type { MessageKey, MessageParams } from '@shared/i18n'

type Tr = (key: MessageKey, params?: MessageParams) => string

interface Props {
  result: ExplainResult | null
  loading: boolean
  error: string | null
  onClose: () => void
  onRetry: () => void
}

interface PlanNode {
  label: string
  detail: string[]
  children: PlanNode[]
}

// MySQL and PostgreSQL both wrap the plan in their own envelope. These helpers
// only read the shapes the adapters return, never arbitrary server text.
function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function mysqlNode(raw: unknown, tr: Tr): PlanNode | null {
  const record = asRecord(raw)
  if (!record) return null
  const table = asRecord(record.table)
  const label =
    readString(table?.table_name) ??
    readString(record.select_id ? `select #${record.select_id}` : null) ??
    readString(record.operation) ??
    'plan'
  const detail: string[] = []
  const access = readString(table?.access_type)
  if (access) detail.push(tr('plan.access', { value: access }))
  const rows = readNumber(table?.rows_examined_per_scan)
  if (rows !== null) detail.push(tr('plan.rowsExamined', { count: rows }))
  const filtered = readNumber(table?.filtered)
  if (filtered !== null) detail.push(tr('plan.filtered', { value: filtered }))
  const cost = asRecord(table?.cost_info)
  const queryCost = readNumber(cost?.query_cost) ?? readNumber(record.query_cost)
  if (queryCost !== null) detail.push(tr('plan.cost', { value: queryCost }))
  const usingIndex = readString(table?.key)
  if (usingIndex) detail.push(tr('plan.index', { value: usingIndex }))
  const extra = readString(table?.attached_condition)
  if (extra) detail.push(tr('plan.condition', { value: extra }))

  const children: PlanNode[] = []
  const nested = asRecord(record.nested_loop)
  if (Array.isArray(nested)) {
    for (const item of nested) {
      const child = mysqlNode(item, tr)
      if (child) children.push(child)
    }
  }
  const subqueries = record.subqueries
  if (Array.isArray(subqueries)) {
    for (const item of subqueries) {
      const child = mysqlNode(item, tr)
      if (child) children.push(child)
    }
  }
  return { label, detail, children }
}

function postgresNode(raw: unknown, tr: Tr): PlanNode | null {
  const record = asRecord(raw)
  if (!record) return null
  const label = readString(record['Node Type']) ?? 'Plan'
  const detail: string[] = []
  const relation = readString(record['Relation Name'])
  if (relation) detail.push(tr('plan.relation', { value: relation }))
  const index = readString(record['Index Name'])
  if (index) detail.push(tr('plan.index', { value: index }))
  const startup = readNumber(record['Startup Cost'])
  const total = readNumber(record['Total Cost'])
  if (startup !== null && total !== null)
    detail.push(tr('plan.costRange', { start: startup, total }))
  const planRows = readNumber(record['Plan Rows'])
  if (planRows !== null) detail.push(tr('plan.rowsEstimate', { count: planRows }))
  const actualRows = readNumber(record['Actual Rows'])
  if (actualRows !== null) detail.push(tr('plan.rowsActual', { count: actualRows }))
  const actualTime = readNumber(record['Actual Total Time'])
  if (actualTime !== null) detail.push(`${actualTime} ms`)
  const filter = readString(record['Filter'])
  if (filter) detail.push(tr('plan.filter', { value: filter }))

  const children: PlanNode[] = []
  const plans = record.Plans
  if (Array.isArray(plans)) {
    for (const item of plans) {
      const child = postgresNode(item, tr)
      if (child) children.push(child)
    }
  }
  return { label, detail, children }
}

function buildTree(result: ExplainResult, tr: Tr): PlanNode | null {
  if (result.format === 'text') {
    return {
      label: result.engine === 'sqlite' ? 'SQLite' : 'Oracle',
      detail: [],
      children: result.raw
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => ({ label: line.trimEnd(), detail: [], children: [] }))
    }
  }
  try {
    const parsed = JSON.parse(result.raw) as unknown
    if (result.engine === 'mysql') {
      const wrapper = Array.isArray(parsed) ? parsed[0] : parsed
      const queryBlock = asRecord(asRecord(wrapper)?.query_block)
      if (queryBlock) return mysqlNode(queryBlock, tr)
      return mysqlNode(wrapper, tr)
    }
    if (result.engine === 'postgres') {
      const root = Array.isArray(parsed) ? parsed[0] : parsed
      const plan = asRecord(asRecord(root)?.Plan) ?? asRecord(root)
      return postgresNode(plan, tr)
    }
    return null
  } catch {
    return null
  }
}

function PlanBranch({ node, depth }: { node: PlanNode; depth: number }): JSX.Element {
  return (
    <li className="plan__node">
      <div className="plan__row" style={{ paddingLeft: depth * 14 }}>
        <span className="plan__label">{node.label}</span>
        {node.detail.length > 0 && (
          <span className="plan__detail">{node.detail.join(' | ')}</span>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="plan__children">
          {node.children.map((child, index) => (
            <PlanBranch key={index} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function QueryPlanPanel({
  result,
  loading,
  error,
  onClose,
  onRetry
}: Props): JSX.Element {
  const { tr } = useLocale()
  const [rawOpen, setRawOpen] = useState(false)
  const tree = useMemo(() => (result ? buildTree(result, tr) : null), [result, tr])

  return (
    <section className="plan" aria-label={tr('query.plan')}>
      <header className="plan__head">
        <h2>{tr('query.plan')}</h2>
        <div className="plan__actions">
          <button
            className="btn btn--tiny btn--ghost"
            onClick={onRetry}
            disabled={loading}
          >
            {loading ? tr('query.running') : tr('query.planRetry')}
          </button>
          <button
            className="btn btn--tiny btn--ghost"
            onClick={() => setRawOpen((v) => !v)}
            aria-expanded={rawOpen}
            disabled={!result}
          >
            {rawOpen ? tr('query.planHideJson') : tr('query.planShowJson')}
          </button>
          <button className="btn btn--tiny btn--ghost" onClick={onClose}>
            {tr('common.close')}
          </button>
        </div>
      </header>

      {loading && <p className="muted plan__pad">{tr('query.planRunning')}</p>}
      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && result && (
        <>
          <p className="plan__meta">
            {result.engine} | {result.format} | {result.durationMs} ms
          </p>
          {tree ? (
            <ul className="plan__tree">
              <PlanBranch node={tree} depth={0} />
            </ul>
          ) : (
            <p className="muted plan__pad">{tr('plan.unmapped')}</p>
          )}
          {rawOpen && <pre className="plan__raw">{result.raw}</pre>}
        </>
      )}
      {!loading && !error && !result && (
        <p className="muted plan__pad">{tr('plan.hint')}</p>
      )}
    </section>
  )
}
