# Catatan pengembangan

Dokumen ini untuk yang mengubah kode. Panduan pemakaian ada di
[README.md](README.md), riwayat perubahan di [CHANGELOG.md](CHANGELOG.md).

## Kebutuhan

- Node.js 20 atau lebih baru (dikembangkan di Node 22).
- npm 10 atau lebih baru.
- Python 3.9–3.11 untuk membangun native module. Homebrew Python 3.12+ tidak
  menyertakan `distutils`, sehingga `node-gyp` gagal; skrip macOS di repo ini
  memakai `/usr/bin/python3` secara eksplisit.
- Toolchain build: Xcode Command Line Tools di macOS, Visual Studio Build Tools
  di Windows.

## Menjalankan

```bash
npm install
npm run dev
```

`npm install` menjalankan `electron-builder install-app-deps` untuk membangun
ulang `better-sqlite3` dan `cpu-features` terhadap ABI Electron. Bila langkah itu
gagal karena Python, jalankan:

```bash
PYTHON=/usr/bin/python3 npx electron-builder install-app-deps
```

Perintah lain:

```bash
npm run typecheck   # tsc untuk main/preload dan renderer
npm run lint        # eslint
npm test            # vitest untuk modul murni src/shared
npm run build       # bundle ke out/ + cek worker tidak mengimpor electron
npm start           # jalankan hasil build
```

## Struktur proyek

```
src/
  main/                  proses utama Electron
    ai/                  pengaturan + klien AI (streaming)
    menu.ts              menu aplikasi native -> MenuAction ke renderer
    update/              pemeriksaan dan pemasangan pembaruan
    connection/          store koneksi, grup, SSL, SSH tunnel, known hosts
    drivers/             adapter per engine + registry + tipe bersama
    io/                  export/import, backup, dump, transfer
    ipc/                 handler IPC (validasi zod sebelum ke worker)
    savedQueries/        query tersimpan (.sql) + riwayat
    storage/             penulisan file atomik
    workers/             worker thread eksekusi driver
  preload/               contextBridge -> window.dbApi
  renderer/src/          UI React
  shared/                tipe, skema zod, DDL, filter, builder, format SQL,
                         diff (schema/data), prompt dan guard pratinjau AI,
                         aturan pembaruan
scripts/smoke/           smoke test
```

## Transaksi manual

Satu transaksi per tab Query, bukan per koneksi: tab yang sama bisa punya
beberapa sub-tab, dan semuanya berbagi sesi database yang sama.

- Setiap adapter menyimpan `Map<transactionId, pinned connection>`. Koneksi
  di-pin karena pooled/shared connection akan membuat statement tab lain ikut
  masuk transaksi, atau statement transaksi berjalan di sesi berbeda dan tidak
  melihat tulisannya sendiri.
- MySQL/MariaDB memakai `PoolConnection` yang ditahan; PostgreSQL membuka
  `pg.Client` baru (bukan cache per database); Oracle membuka `Connection`
  baru dengan `autoCommit: false`.
- Batas 4 transaksi terbuka per koneksi (`MAX_OPEN_TRANSACTIONS`), karena tiap
  transaksi menahan satu koneksi server.
- `commitsImplicitly` (`src/shared/transactionGuard.ts`) menandai DDL yang
  meng-commit implisit di MySQL/MariaDB/Oracle; driver menghapus entri transaksi
  saat itu terjadi supaya `listTransactions` tidak berbohong, dan UI bertanya
  lebih dulu.
- PostgreSQL tidak terkena aturan itu: DDL-nya transaksional, dan rollback
  `CREATE TABLE` sudah diuji.
- SQLite dan MongoDB melempar `DbError('UNSUPPORTED')` dengan alasan yang
  ditampilkan ke pengguna.

## Membangun installer

**Windows** (dijalankan di Windows):

```bash
npm run dist:win
```

Menghasilkan installer NSIS x64 di `release/`.

**macOS** (dijalankan di macOS):

```bash
npm run dist:mac          # arm64 + x64
npm run dist:mac:arm64
npm run dist:mac:x64
```

Menghasilkan `Tupai-<versi>-arm64.dmg` dan `Tupai-<versi>-x64.dmg`.

Catatan penting:

- Build belum ditandatangani. Di Mac orang lain, buka lewat klik kanan → **Open**
  sekali, atau jalankan
  `xattr -dr com.apple.quarantine /Applications/Tupai.app`.
- Notarization otomatis aktif bila env `CSC_LINK` + `CSC_KEY_PASSWORD` dan
  `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` tersedia.
- Membangun x64 dari Mac arm64 menimpa native module dengan binary x64.
  `dist:mac` dan `dist:mac:x64` sudah menjalankan `npm run rebuild:host` di
  akhir; build manual perlu melakukannya sendiri agar `npm run dev` tetap jalan.
- `electron-builder` memakai `TMPDIR` untuk membuat dmg. Bila disk sistem
  penuh, arahkan ke volume lain:
  `TMPDIR=/path/with/space npm run dist:mac`.

## Merilis versi baru

Rilis dipakai oleh pemeriksaan pembaruan di aplikasi, jadi urutannya penting.

1. Naikkan `version` di `package.json` (dan tambahkan bagian baru di
   `CHANGELOG.md`). Versi di feed update dibaca dari sini.
2. Build metadata lokal dan periksa hasilnya:

   ```bash
   npm run dist:mac:arm64   # atau dist:win di Windows
   npm run release:meta
   ```

   `release:meta` memastikan `latest-mac.yml` / `latest.yml` cocok dengan
   `package.json`, menyebut artefak yang benar-benar ada, dan menunjuk zip
   (bukan dmg) untuk macOS.

3. Terbitkan ke GitHub Releases:

   ```bash
   npm run release:mac   # arm64 + x64, unggah ke release draf
   npm run release:win   # jalankan di Windows
   ```

   Kedua skrip memakai `--publish always` dengan provider `github` di
   `electron-builder.yml`. Butuh `GH_TOKEN` (atau `GITHUB_TOKEN`) dengan izin
   `repo`.

4. Buka draf release di GitHub, periksa asetnya (`*.dmg`, `*.zip`, `*.exe`,
   `latest*.yml`, `*.blockmap`), lalu terbitkan.

### Menguji pembaruan tanpa merilis

Set `TUPAI_UPDATE_URL` ke direktori statis berisi `latest-mac.yml` (atau
`latest.yml` di Windows) beserta artefaknya, lalu jalankan build terpasang:

```bash
cd /tmp/feed && python3 -m http.server 8798
TUPAI_UPDATE_URL=http://127.0.0.1:8798/ "/Applications/Tupai.app/Contents/MacOS/Tupai"
```

Variabel itu memakai provider `generic`, jadi tidak menyentuh GitHub. Nilainya
datang dari environment peluncur, sama seperti argumen baris perintah, dan hanya
dibaca saat build terpasang. Naikkan `version` di `latest-mac.yml` untuk menguji
"ada pembaruan", samakan dengan `package.json` untuk menguji "sudah terbaru".

### Repositori privat

Feed GitHub dibaca tanpa autentikasi, jadi repositori privat menghasilkan 404
dan aplikasi melaporkan "Belum ada rilis yang dipublikasikan." Pilihannya:
jadikan repo publik, atau pisahkan rilis ke repo publik tersendiri lalu ubah
`publish.owner`/`publish.repo` di `electron-builder.yml`. Menanam token di
aplikasi bukan pilihan: token itu bisa diekstrak siapa pun yang punya build.

Catatan:

- Feed macOS harus memuat zip untuk kedua arsitektur, karena Squirrel.Mac
  mengunduh zip dan memilih sesuai mesin. `release:mac` sudah membangun
  keduanya.
- Auto-install di macOS hanya aktif bila app ditandatangani Developer ID
  (`src/shared/update.ts` memeriksa hasil `codesign`). Tanpa itu panel menampilkan
  tombol halaman unduhan.
- Jangan mengunggah `latest.yml` dari mesin lain: feed Windows dan macOS
  berbeda file dan isinya.

## Smoke test

Skrip di `scripts/smoke/` menguji driver, IPC, dan worker terhadap database
sungguhan. Tidak ada dependency test tambahan; skrip dibundel dengan esbuild.

```bash
npm run smoke:sqlite     # tanpa server
npm run smoke:sync       # diff dan deploy sync antar database (SQLite)
npm run smoke:postgres   # butuh PostgreSQL di 127.0.0.1:5432
npm run smoke:mysql      # menyalakan MySQL sementara di port 33061
npm run smoke:p1         # batas baris, hapus massal, insert terpecah, streaming
npm run smoke:p2         # pembatalan query
npm run smoke:p2-ssh     # mode host key ketat (butuh github.com:22)
npm run smoke:p2-ai      # streaming asisten (server SSE lokal)
npm run smoke:p2-preview # pratinjau baris asisten terhadap SQLite sungguhan
npm run smoke:p2-ui      # guard tab belum disimpan dan dialog konfirmasi
npm run smoke:atomic     # penulisan store atomik + backup
npm run smoke:menu       # menu native menjalankan aksi dan mengikuti keymap
npm run smoke:app        # aplikasi terpaket lewat CDP
npm run smoke:p1-app
npm run smoke:provision  # membuat user, database, tabel, dan seeder
```

Detail tiap suite ada di `scripts/smoke/README.md`. Semua suite membuat data
sementara dengan nama unik dan membersihkannya sendiri.

Smoke test membutuhkan bash. Di Windows, jalankan lewat Git Bash:

```powershell
& "C:\Program Files\Git\bin\bash.exe" -lc "cd /d/DESKTOP/tupai && bash scripts/smoke/run.sh sqlite"
```

Data sementara smoke test disimpan di `.smoke/` di dalam proyek (di-ignore git),
bukan di temp sistem: MySQL datadir bisa ratusan MB dan proyek ini berada di SSD
eksternal. Proses yang dijalankan skrip selalu dihentikan lewat trap, termasuk
saat Ctrl+C, dan instance MySQL yatim dari run sebelumnya dibersihkan otomatis
di awal run berikutnya.
