import type { DbEngine } from '@shared/types'
import mysqlRaw from './assets/engines/mysql.svg?raw'
import mariadbRaw from './assets/engines/mariadb.svg?raw'
import postgresRaw from './assets/engines/postgresql.svg?raw'
import oracleRaw from './assets/engines/oracle.svg?raw'
import sqliteRaw from './assets/engines/sqlite.svg?raw'
import mongodbRaw from './assets/engines/mongodb.svg?raw'

interface Props {
  engine: DbEngine
  size?: number
  // Disconnected connections render muted; the brand tint applies when active.
  active?: boolean
}

// The bundled SVGs carry a <title> element. It duplicates the label wherever the
// icon sits next to text (and would be read twice by a screen reader), so it is
// stripped once here; the wrapper keeps the name as a tooltip.
function clean(raw: string): string {
  return raw
    .replace(/<title>[^<]*<\/title>/i, '')
    .replace(/<svg /i, '<svg aria-hidden="true" focusable="false" ')
}

// Official engine marks (simple-icons, monochrome single-path). Shape comes from
// the asset; the brand tint is applied through CSS so both themes stay legible.
const ENGINE_SVG: Record<DbEngine, string> = {
  mysql: clean(mysqlRaw),
  mariadb: clean(mariadbRaw),
  postgres: clean(postgresRaw),
  oracle: clean(oracleRaw),
  sqlite: clean(sqliteRaw),
  mongodb: clean(mongodbRaw)
}

// Engine names are product names, not translated text, so they stay as-is
// in both locales.
export const ENGINE_LABEL: Record<DbEngine, string> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  postgres: 'PostgreSQL',
  oracle: 'Oracle',
  sqlite: 'SQLite',
  mongodb: 'MongoDB'
}

export function EngineIcon({ engine, size = 16, active = false }: Props): JSX.Element {
  return (
    <span
      className={`engine-icon engine-icon--${engine}${active ? ' is-active' : ''}`}
      title={ENGINE_LABEL[engine]}
      style={{ width: size, height: size }}
      // The bundled SVG is a trusted local asset, not user input.
      dangerouslySetInnerHTML={{ __html: ENGINE_SVG[engine] }}
    />
  )
}
