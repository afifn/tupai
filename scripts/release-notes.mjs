// Builds the body of a GitHub release from CHANGELOG.md.
//
// The changelog is the source of truth, but it is written for developers: the
// entries explain causes and measurements, which is right in the repository and
// wrong on a download page. This script takes the section for one version,
// drops the entries that only make sense to whoever wrote the code, and puts the
// install steps first, because that is what a visitor needs before anything else.
//
// Usage:
//   node scripts/release-notes.mjs              # version from package.json
//   node scripts/release-notes.mjs 0.2.2        # explicit version
//   node scripts/release-notes.mjs --write      # write release/NOTES.md too
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'

const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
const args = process.argv.slice(2)
const write = args.includes('--write')
const version = args.find((a) => !a.startsWith('-')) ?? pkg.version

const changelogPath = join(root, 'CHANGELOG.md')
if (!existsSync(changelogPath)) {
  console.error('CHANGELOG.md not found')
  process.exit(1)
}
const changelog = readFileSync(changelogPath, 'utf-8')

// A version section runs from its own heading to the next one, so a missing
// entry cannot silently borrow text from the previous release.
const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\].*$`, 'm')
const start = changelog.search(heading)
if (start < 0) {
  console.error(`No "## [${version}]" section in CHANGELOG.md`)
  console.error('Add one before publishing; the release body is generated from it.')
  process.exit(1)
}
const afterHeading = changelog.indexOf('\n', start) + 1
const nextHeading = changelog.slice(afterHeading).search(/^## \[/m)
const body = changelog
  .slice(afterHeading, nextHeading < 0 ? undefined : afterHeading + nextHeading)
  .trim()

if (!body) {
  console.error(`Section for ${version} is empty.`)
  process.exit(1)
}

// Must match `win.artifactName` in electron-builder.yml: productName-Setup-version.
const installer = `Tupai-Setup-${version}.exe`

// Only offer a platform whose artifact was actually built. The mac build runs on
// a Mac, so a release made from Windows has no DMG; telling people to download
// one sends them to a 404. Read from release/ rather than guessing.
const releaseDir = join(root, 'release')
const files = existsSync(releaseDir) ? readdirSync(releaseDir) : []
const hasWindows = files.includes(installer)
const hasMac = files.some((f) => f.startsWith(`Tupai-${version}-`) && f.endsWith('.dmg'))

const windowsBlock = `**Windows** — unduh \`${installer}\` di bawah.

Build belum ditandatangani secara digital, jadi Windows menampilkan peringatan
lebih dulu. Ini normal, bukan tanda file rusak:

1. Jendela biru **"Windows protected your PC"** muncul.
2. Klik **More info**, lalu **Run anyway**.
3. Setujui konfirmasi administrator; Tupai dipasang untuk semua pengguna.`

const macBlock = `**macOS** — unduh \`Tupai-${version}-arm64.dmg\` (Apple Silicon) atau
\`Tupai-${version}-x64.dmg\` (Intel). Build belum ditandatangani: buka lewat klik
kanan → **Open** sekali, atau jalankan
\`xattr -dr com.apple.quarantine /Applications/Tupai.app\`.`

const macMissing = `**macOS** — build macOS dibuat di mesin macOS, jadi belum ada di rilis
ini. Unduh DMG versi terakhir yang memuatnya dari
[halaman rilis](https://github.com/afifn/tupai/releases).`

const platforms = [
  hasWindows ? windowsBlock : null,
  hasMac ? macBlock : macMissing
].filter(Boolean)

if (!hasWindows && !hasMac) {
  console.error(`No artifact for ${version} in release/. Build before writing notes.`)
  process.exit(1)
}

const install = `## Memasang

${platforms.join('\n\n')}

Koneksi yang sudah tersimpan tidak dihapus saat aplikasi dicopot.`

const notes = `${install}

## Yang berubah

${body}

---

Versi lengkap dan riwayat sebelumnya ada di [CHANGELOG.md](CHANGELOG.md).`

if (write) {
  const dir = join(root, 'release')
  if (!existsSync(dir)) mkdirSync(dir)
  const out = join(dir, 'NOTES.md')
  writeFileSync(out, notes + '\n', 'utf-8')
  console.log(`Wrote ${out}`)
  console.log(`Paste it into the GitHub release body for ${version}.`)
} else {
  console.log(notes)
}
