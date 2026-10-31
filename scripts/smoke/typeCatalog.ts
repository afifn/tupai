import { columnTypeCatalog, formatColumnType } from '../../src/shared/columnTypeCatalog'
import type { DbEngine, DdlColumnDef } from '../../src/shared/types'

// Builds one column per catalog entry so a smoke test can prove that every type
// the table designer offers is accepted by a real server. Types that need a
// value list get a sample one; everything else starts from its defaults.
export function catalogColumns(engine: DbEngine): DdlColumnDef[] {
  return columnTypeCatalog(engine).map((spec, index) => {
    const needsValues = (spec.parameters ?? []).some(
      (parameter) => parameter.key === 'values'
    )
    return {
      name: `c${index}`,
      dataType: formatColumnType(spec, needsValues ? { values: 'a, b' } : {}),
      nullable: true,
      primaryKey: false,
      autoIncrement: false,
      defaultValue: ''
    }
  })
}

/** Column name the sample table used for a catalog type. */
export function catalogColumnName(engine: DbEngine, type: string): string {
  const index = columnTypeCatalog(engine).findIndex((spec) => spec.type === type)
  if (index < 0) throw new Error(`${type} is not in the ${engine} catalog`)
  return `c${index}`
}
