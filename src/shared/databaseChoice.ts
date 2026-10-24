// Databases a server owns for its own bookkeeping. They stay visible in the
// tree (Navicat shows them too) but make a poor default target when the user has
// not picked one yet.
const SYSTEM_DATABASES = new Set([
  'information_schema',
  'performance_schema',
  'mysql',
  'sys',
  'pg_catalog',
  'template0',
  'template1'
])

export function isSystemDatabase(name: string): boolean {
  return SYSTEM_DATABASES.has(name.toLowerCase())
}

// Prefers the first user database, falling back to whatever exists so a server
// that only has system databases still resolves to something usable.
export function pickDefaultDatabase(found: string[]): string | undefined {
  return found.find((name) => !SYSTEM_DATABASES.has(name.toLowerCase())) ?? found[0]
}
