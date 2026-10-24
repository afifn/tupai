// The colour schema for the whole renderer.
//
// This file does not hold colour values. It is the inventory: every token that
// exists, which group it belongs to, and what it is for. Values live in
// `src/renderer/src/theme/themes/*.css`.
//
// Why the split: a token that exists in the schema but not in the CSS renders
// as nothing, and a token that exists in the CSS but not here is invisible to
// whoever wants to restyle the app. `tests/themeTokens.test.ts` fails when the
// two lists drift apart.

export type ThemeTokenGroup =
  | 'surface'
  | 'text'
  | 'accent'
  | 'status'
  | 'notice'
  | 'overlay'
  | 'scrollbar'
  | 'engine'
  | 'diagram'
  | 'identity'

export interface ThemeToken {
  /** CSS custom property, including the leading `--`. */
  name: string
  group: ThemeTokenGroup
  /** What changing this token affects. Indonesian, because it is read by the maintainer. */
  description: string
}

export const THEME_TOKENS: ThemeToken[] = [
  // Surfaces
  {
    name: '--bg',
    group: 'surface',
    description: 'Latar jendela di belakang semua panel.'
  },
  {
    name: '--surface',
    group: 'surface',
    description: 'Latar panel, dialog, tab aktif, dan input.'
  },
  {
    name: '--surface-muted',
    group: 'surface',
    description: 'Latar sekunder: header tabel, baris pita, area kosong.'
  },
  {
    name: '--surface-hover',
    group: 'surface',
    description: 'Latar saat kursor berada di atas baris atau tombol netral.'
  },
  {
    name: '--border',
    group: 'surface',
    description: 'Garis pemisah tipis antar elemen.'
  },
  {
    name: '--border-strong',
    group: 'surface',
    description: 'Garis untuk kontrol yang harus terlihat jelas, misalnya input fokus.'
  },

  // Text
  {
    name: '--text',
    group: 'text',
    description: 'Teks utama. Harus lolos 4.5:1 terhadap --bg dan --surface.'
  },
  {
    name: '--text-muted',
    group: 'text',
    description: 'Teks sekunder: label, hint, metadata. Tetap harus lolos 4.5:1.'
  },

  // Accent
  {
    name: '--accent',
    group: 'accent',
    description: 'Warna aksi utama: tombol primer, tab aktif, garis fokus.'
  },
  {
    name: '--accent-hover',
    group: 'accent',
    description: 'Accent saat kursor di atas tombol primer.'
  },
  {
    name: '--accent-text',
    group: 'accent',
    description: 'Teks di atas --accent. Harus lolos 4.5:1 terhadap --accent.'
  },
  {
    name: '--accent-soft',
    group: 'accent',
    description: 'Latar lembut bernuansa accent, misalnya chip atau badge.'
  },
  {
    name: '--selected-bg',
    group: 'accent',
    description: 'Latar baris tabel yang sedang dipilih.'
  },
  {
    name: '--pk-bg',
    group: 'accent',
    description: 'Latar kolom primary key di data grid.'
  },

  // Status
  { name: '--ok', group: 'status', description: 'Teks dan ikon untuk keadaan berhasil.' },
  { name: '--error', group: 'status', description: 'Teks dan ikon untuk keadaan gagal.' },
  {
    name: '--info',
    group: 'status',
    description: 'Teks dan ikon untuk informasi netral.'
  },

  // Notice blocks
  {
    name: '--notice-error-bg',
    group: 'notice',
    description: 'Latar kotak pemberitahuan error.'
  },
  {
    name: '--notice-error-border',
    group: 'notice',
    description: 'Garis kotak pemberitahuan error.'
  },
  {
    name: '--notice-ok-bg',
    group: 'notice',
    description: 'Latar kotak pemberitahuan berhasil.'
  },
  {
    name: '--notice-ok-border',
    group: 'notice',
    description: 'Garis kotak pemberitahuan berhasil.'
  },
  {
    name: '--notice-info-bg',
    group: 'notice',
    description: 'Latar kotak pemberitahuan informasi.'
  },
  {
    name: '--notice-info-border',
    group: 'notice',
    description: 'Garis kotak pemberitahuan informasi.'
  },

  // Overlay and scrollbars
  {
    name: '--overlay',
    group: 'overlay',
    description: 'Tirai di belakang dialog. Boleh rgba, tidak diuji kontrasnya.'
  },
  { name: '--scrollbar-thumb', group: 'scrollbar', description: 'Pegangan scrollbar.' },
  {
    name: '--scrollbar-thumb-hover',
    group: 'scrollbar',
    description: 'Pegangan scrollbar saat kursor di atasnya.'
  },
  {
    name: '--scrollbar-track',
    group: 'scrollbar',
    description: 'Jalur scrollbar. Umumnya transparan.'
  },

  // Badge foregrounds
  {
    name: '--error-text',
    group: 'status',
    description: 'Teks di atas --error, misalnya angka di badge.'
  },

  // Engine brand tints
  {
    name: '--engine-mysql',
    group: 'engine',
    description: 'Warna ikon MySQL saat koneksi terbuka.'
  },
  {
    name: '--engine-mariadb',
    group: 'engine',
    description: 'Warna ikon MariaDB saat koneksi terbuka.'
  },
  {
    name: '--engine-postgres',
    group: 'engine',
    description: 'Warna ikon PostgreSQL saat koneksi terbuka.'
  },
  {
    name: '--engine-sqlite',
    group: 'engine',
    description: 'Warna ikon SQLite saat koneksi terbuka.'
  },
  {
    name: '--engine-oracle',
    group: 'engine',
    description: 'Warna ikon Oracle saat koneksi terbuka.'
  },
  {
    name: '--engine-mongodb',
    group: 'engine',
    description: 'Warna ikon MongoDB saat koneksi terbuka.'
  },

  // Diagram card colours. Content, not chrome: identical in every theme.
  {
    name: '--diagram-slate',
    group: 'diagram',
    description: 'Warna kartu diagram, nada slate.'
  },
  {
    name: '--diagram-slate-text',
    group: 'diagram',
    description: 'Teks di atas kartu diagram slate.'
  },
  {
    name: '--diagram-blue',
    group: 'diagram',
    description: 'Warna kartu diagram, nada biru.'
  },
  {
    name: '--diagram-blue-text',
    group: 'diagram',
    description: 'Teks di atas kartu diagram biru.'
  },
  {
    name: '--diagram-teal',
    group: 'diagram',
    description: 'Warna kartu diagram, nada teal.'
  },
  {
    name: '--diagram-teal-text',
    group: 'diagram',
    description: 'Teks di atas kartu diagram teal.'
  },
  {
    name: '--diagram-green',
    group: 'diagram',
    description: 'Warna kartu diagram, nada hijau.'
  },
  {
    name: '--diagram-green-text',
    group: 'diagram',
    description: 'Teks di atas kartu diagram hijau.'
  },
  {
    name: '--diagram-amber',
    group: 'diagram',
    description: 'Warna kartu diagram, nada kuning tua.'
  },
  {
    name: '--diagram-amber-text',
    group: 'diagram',
    description: 'Teks di atas kartu diagram kuning tua.'
  },
  {
    name: '--diagram-orange',
    group: 'diagram',
    description: 'Warna kartu diagram, nada oranye.'
  },
  {
    name: '--diagram-orange-text',
    group: 'diagram',
    description: 'Teks di atas kartu diagram oranye.'
  },
  {
    name: '--diagram-rose',
    group: 'diagram',
    description: 'Warna kartu diagram, nada merah muda.'
  },
  {
    name: '--diagram-rose-text',
    group: 'diagram',
    description: 'Teks di atas kartu diagram merah muda.'
  },
  {
    name: '--diagram-violet',
    group: 'diagram',
    description: 'Warna kartu diagram, nada violet.'
  },
  {
    name: '--diagram-violet-text',
    group: 'diagram',
    description: 'Teks di atas kartu diagram violet.'
  },

  // Connection identity markers
  {
    name: '--conn-slate',
    group: 'identity',
    description: 'Penanda warna koneksi, nada slate.'
  },
  {
    name: '--conn-red',
    group: 'identity',
    description: 'Penanda warna koneksi, nada merah.'
  },
  {
    name: '--conn-amber',
    group: 'identity',
    description: 'Penanda warna koneksi, nada kuning tua.'
  },
  {
    name: '--conn-green',
    group: 'identity',
    description: 'Penanda warna koneksi, nada hijau.'
  },
  {
    name: '--conn-teal',
    group: 'identity',
    description: 'Penanda warna koneksi, nada teal.'
  },
  {
    name: '--conn-blue',
    group: 'identity',
    description: 'Penanda warna koneksi, nada biru.'
  },
  {
    name: '--conn-violet',
    group: 'identity',
    description: 'Penanda warna koneksi, nada violet.'
  },
  {
    name: '--conn-pink',
    group: 'identity',
    description: 'Penanda warna koneksi, nada merah muda.'
  }
]

export const THEME_TOKEN_NAMES: string[] = THEME_TOKENS.map((token) => token.name)

/** Themes shipped with the app. `light` and `dark` are the full palettes.
 *  `custom` is not a CSS preset: its tokens are written inline by the settings
 *  layer, so it has no block in presets.css. */
export const THEME_IDS = [
  'light',
  'dark',
  'light-ocean',
  'dark-forest',
  'custom'
] as const

export type ThemeId = (typeof THEME_IDS)[number]

/**
 * Themes that only override the accent family on top of another theme.
 * A preset must never change `--bg`, `--text`, or `--surface`: it would turn a
 * two-line override into a full palette nobody re-checked for contrast.
 */
export const THEME_PRESETS: { id: ThemeId; base: 'light' | 'dark' }[] = [
  { id: 'light-ocean', base: 'light' },
  { id: 'dark-forest', base: 'dark' }
]

/** Themes whose colours come from the settings file instead of a CSS block. */
export const THEME_FROM_SETTINGS: ThemeId[] = ['custom']

export interface ContrastPair {
  /** Token used as text or icon colour. */
  fg: string
  /** Token used as the background behind it. */
  bg: string
  /** WCAG minimum: 4.5 for normal text, 3 for large text and UI edges. */
  min: number
  note: string
}

/**
 * Pairs that must keep their contrast in every theme. Editing a colour without
 * checking these is how a palette quietly becomes unreadable.
 */
export const CONTRAST_PAIRS: ContrastPair[] = [
  { fg: '--text', bg: '--bg', min: 4.5, note: 'Teks utama di latar jendela' },
  { fg: '--text', bg: '--surface', min: 4.5, note: 'Teks utama di panel' },
  { fg: '--text', bg: '--surface-muted', min: 4.5, note: 'Teks utama di header tabel' },
  { fg: '--text-muted', bg: '--bg', min: 4.5, note: 'Teks sekunder di latar jendela' },
  { fg: '--text-muted', bg: '--surface', min: 4.5, note: 'Teks sekunder di panel' },
  { fg: '--accent-text', bg: '--accent', min: 4.5, note: 'Label tombol primer' },
  { fg: '--error', bg: '--surface', min: 4.5, note: 'Pesan error di panel' },
  { fg: '--ok', bg: '--surface', min: 4.5, note: 'Pesan berhasil di panel' },
  { fg: '--info', bg: '--surface', min: 4.5, note: 'Pesan informasi di panel' }
]

export interface KnownContrastGap extends ContrastPair {
  /** Base themes where the pair currently fails. */
  themes: ('light' | 'dark')[]
  /** Measured ratio when the gap was recorded, per base theme. */
  measured: { light: number; dark: number }
  /** Why it has not been fixed yet. */
  reason: string
}

/**
 * Pairs that already fail WCAG today, recorded instead of ignored.
 *
 * These are pre-existing values, not a target. The test asserts they still
 * measure what is written here, so the gap stays visible: if someone changes
 * the colour, they must update this record, and if someone fixes it they must
 * move the pair into CONTRAST_PAIRS. Do not delete an entry to make a run pass.
 */
export const KNOWN_CONTRAST_GAPS: KnownContrastGap[] = [
  {
    fg: '--border-strong',
    bg: '--surface',
    min: 3,
    themes: ['light', 'dark'],
    note: 'Batas kontrol (non-teks), WCAG 1.4.11',
    measured: { light: 1.83, dark: 2.04 },
    reason:
      'Nilai lama dari styles.css. Menaikkannya mengubah tampilan, jadi dikerjakan terpisah dari fase inventaris tema.'
  },
  {
    fg: '--error-text',
    bg: '--error',
    min: 4.5,
    themes: ['dark'],
    note: 'Angka di badge atas --error',
    measured: { light: 6.54, dark: 2.28 },
    reason:
      'Lama: teks putih di atas error merah muda. Fase inventaris mempertahankan nilai lama supaya tampilan tidak berubah; perbaikannya mengganti --error-text gelap menjadi gelap, bukan terang.'
  }
]
