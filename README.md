# Tupai

Aplikasi desktop untuk mengelola beberapa database sekaligus: MySQL, MariaDB,
PostgreSQL, Oracle, SQLite, dan MongoDB. Dibangun dengan Electron, React, dan
TypeScript.

Semua operasi database berjalan di worker thread, kredensial disimpan lewat
penyimpanan aman OS, dan setiap channel IPC divalidasi sebelum menyentuh driver.

## Fitur

**Koneksi**

- Enam engine: MySQL, MariaDB, PostgreSQL, Oracle, SQLite, MongoDB.
- Port dan opsi bawaan per engine, mengikuti port saat engine diganti.
- Grup koneksi dengan warna penanda, drag & drop antar grup.
- SSH tunnel (MySQL/MariaDB, PostgreSQL) dengan verifikasi host key.
- SSL/TLS dengan CA, client cert, dan key.
- Test connection sebelum menyimpan.
- Impor dan ekspor koneksi Navicat (`.ncx`). Password tidak pernah didekripsi
  atau ikut diekspor.

**Menjelajah objek**

- Tree Database → Schema → Tabel/View, plus grup Saved queries dan Routines
  (function, procedure, trigger, event). Kolom tampil di panel Detail, bukan di
  tree.
- Browser objek dengan jumlah baris, ukuran, komentar, dan engine.
- Pencarian cepat lintas objek yang sudah dimuat (tabel, view, routine, dan
  query tersimpan) lewat `Mod+F`; pencarian kolom belum termasuk.
- Context menu lengkap untuk koneksi, database, schema, tabel, view, dan routine.

**Data**

- Grid dengan paging, sorting, filter cepat, dan filter multi-kondisi (AND/OR).
- Edit sel sesuai tipe data, tambah baris inline, hapus banyak baris dalam satu
  transaksi.
- Preview BLOB: gambar, teks, atau hex dump.
- Form view untuk melihat satu record per halaman.
- Tampilan diagram tabel dan relasi (ER) dengan edit langsung.

**Query**

- Editor Monaco dengan autocomplete tabel/kolom, multi-tab, dan riwayat query.
- Batas baris ditegakkan di sisi driver, jadi `SELECT *` pada tabel besar tidak
  memuat seluruh hasil ke memori.
- Hentikan query yang sedang berjalan (PostgreSQL, MySQL, Oracle).
- Workspace hasil: satu tab per statement, tab Messages, dan query plan
  (EXPLAIN) di area hasil yang sama.
- Jalankan hanya bagian yang diseleksi.
- Transaksi manual (MySQL, MariaDB, PostgreSQL, Oracle): mulai transaksi,
  jalankan beberapa statement, lalu **Commit** atau **Rollback**. Perubahan
  belum terlihat oleh sesi lain sampai di-commit, dan menutup tab atau memutus
  koneksi akan menanyakan nasib transaksi itu.
- Beautify lokal memakai `sql-formatter`.
- Query Builder visual untuk SELECT.
- Asisten AI (endpoint OpenAI-compatible) dengan streaming dan tombol berhenti,
  rujukan tabel via `@nama_tabel`, serta aksi SQL (optimize, explain, komentar,
  konversi dialek).
- Jawaban asisten yang berisi satu `SELECT` menampilkan maksimal lima baris
  sebagai pratinjau. Permintaan lebih dari lima baris hanya menampilkan query,
  dan pratinjau bisa dimatikan di Setelan.
- Asisten selalu menerima konteks engine dan database yang sedang dibuka, dan
  perannya dikunci ke urusan database: instruksi pengguna tidak bisa
  mengubahnya menjadi chatbot umum.

**Struktur dan administrasi**

- Table Designer: kolom, index, foreign key, komentar, info & DDL.
- View Designer.
- User dan permission (MySQL, MariaDB, PostgreSQL, Oracle; tidak untuk SQLite
  dan MongoDB).
- Monitor sesi dengan kemampuan menghentikan sesi lain (semua engine kecuali
  SQLite, yang tidak punya sesi server).
- Import CSV dan SQL; ekspor CSV, JSON, dan SQL. Backup & restore SQL dengan
  riwayat (backup tidak tersedia untuk MongoDB).
- Data Transfer antar tabel, termasuk lintas engine, dengan pratinjau dan dry
  run.
- Sinkronisasi struktur dan data antar database, dengan pratinjau diff sebelum
  deploy. Tabel tanpa primary key ditolak untuk sinkronisasi data.

**Antarmuka dan preferensi**

- Menu aplikasi native (File, Edit, View, Tools, Window). Item yang tidak punya
  target dinonaktifkan, dan shortcut-nya mengikuti keymap yang tersimpan.
- Satu dialog Setelan dengan tujuh bagian: Umum, Tampilan, Editor, Grid,
  Asisten, Keymap, dan Tentang.
- Lima tema (Terang, Gelap, Light Ocean, Dark Forest, Kustom) plus palet kustom
  terang/gelap yang diturunkan dari empat warna inti dan divalidasi kontras.
- Lima bahasa: English (utama), Bahasa Indonesia, 简体中文, 日本語, dan Español,
  dipilih lewat dropdown di Setelan. Istilah teknis (nama engine, `NULL`,
  `BLOB`, kata kunci SQL) tidak diterjemahkan.
- Keymap yang bisa diubah untuk sepuluh aksi shell.
- Notifikasi desktop untuk hasil operasi, dengan hitungan waktu yang berhenti
  saat kursor berada di atasnya.
- Pemeriksaan pembaruan otomatis saat aplikasi dibuka. Lihat
  [Pembaruan](#pembaruan).

## Memasang

Unduh dari halaman [rilis](https://github.com/afifn/tupai/releases).

**macOS**: buka `Tupai-<versi>-arm64.dmg` (Apple Silicon) atau
`Tupai-<versi>-x64.dmg` (Intel), lalu seret Tupai ke Applications.

**Windows**: jalankan `Tupai Setup <versi>.exe`.

Build macOS belum ditandatangani dan belum dinotarisasi, jadi Gatekeeper
menolak pembukaan pertama. Buka lewat klik kanan → **Open** sekali, atau
jalankan:

```bash
xattr -dr com.apple.quarantine /Applications/Tupai.app
```

## Menggunakan

1. **Buat koneksi.** Klik **Koneksi** di toolbar, pilih engine, isi host, port,
   user, dan password. Untuk SQLite pilih file database. Tab SSL dan SSH
   opsional. Tekan **Test** sebelum menyimpan.
2. **Buka objek.** Klik dua kali koneksi di sidebar untuk menyambung, lalu
   bentangkan database dan schema. Klik nama tabel untuk membuka datanya.
3. **Jelajahi dan edit data.** Grid punya paging, sorting, filter, dan edit sel
   sesuai tipe kolom. Tambah baris lewat tombol di pager; hapus banyak baris
   sekaligus dengan multi-select. Tabel tanpa primary key bersifat read-only.
4. **Tulis query.** Buka tab Query (`Mod+1`), pilih database dan schema di bar
   atas, lalu jalankan dengan `Mod+Enter`. Pilih sebagian teks untuk menjalankan
   hanya bagian itu. Hasil muncul per statement, bersama tab Messages dan plan.
5. **Pakai asisten.** Buka panel asisten dari toolbar, lalu tanyakan soal skema
   atau data. Ketik `@` untuk merujuk tabel tertentu beserta kolomnya. Blok SQL
   di jawaban bisa disisipkan ke editor, dan jawaban `SELECT` menampilkan
   pratinjau baris.
6. **Pindahkan atau cadangkan.** Gunakan **Transfer** untuk memindahkan data
   antar tabel (termasuk lintas engine), **Sync** untuk menyamakan struktur/data
   antar database, dan **Backup** untuk dump SQL.
7. **Atur aplikasi.** `Mod+,` membuka Setelan: bahasa, tema, font editor, ukuran
   grid, konfigurasi asisten, keymap, dan info versi.

Shortcut yang sering dipakai: `Mod+1` query baru, `Mod+Enter` jalankan,
`Mod+W` tutup tab, `Mod+F` cari objek, `Mod+,` setelan. Semua bisa diubah di
Setelan → Keymap.

## Pembaruan

Aplikasi memeriksa rilis baru saat dibuka dan menampilkan notifikasi bila ada
versi lebih baru. Pemeriksaan juga bisa dijalankan manual dari
**Setelan → Tentang → Periksa pembaruan**, atau dari menu aplikasi.

- **Windows**: pembaruan diunduh di latar belakang lalu dipasang saat Anda
  menekan **Pasang dan mulai ulang**. Installer yang diunduh selalu cocok dengan
  Windows dan arsitektur yang terpasang.
- **macOS**: build saat ini belum ditandatangani, sehingga macOS tidak
  mengizinkan aplikasi mengganti dirinya sendiri. Panel menampilkan versi baru
  dan tombol **Buka halaman unduhan**; unduh DMG lalu pasang seperti biasa.
  Begitu build ditandatangani dengan Developer ID, pembaruan macOS memasang
  sendiri tanpa perubahan kode.

Tidak ada data yang dikirim saat memeriksa pembaruan selain permintaan versi ke
GitHub. Koneksi database, kredensial, dan setelan Anda tidak pernah ikut.

## Kebutuhan sistem

- macOS 13 atau lebih baru (Apple Silicon atau Intel), atau Windows 10/11 64-bit.
- Untuk Oracle, driver memerlukan Oracle Client sesuai aturan Oracle sendiri.
- MongoDB tidak punya SQL editor, DDL, sync, backup, atau manajemen user.
- SQLite tidak mendukung `ALTER COLUMN`, perubahan primary key, atau manajemen
  user; perubahan seperti itu dilaporkan `unsupported`.

## Data dan privasi

Semua data tersimpan lokal di folder data aplikasi, yang lokasinya bisa dibuka
dari **Setelan → Tentang → Folder data**. Isinya antara lain koneksi, setelan,
query tersimpan, dan riwayat.

- Password database, passphrase SSH, dan API key AI dienkripsi dengan
  penyimpanan aman OS (`safeStorage`). Bila OS tidak menyediakannya,
  penyimpanan gagal dengan pesan jelas alih-alih menulis nilai kosong.
- Kredensial tidak pernah dikirim ke tampilan.
- Host key SSH diverifikasi: koneksi pertama dicatat, dan perubahan sidik jari
  memblokir koneksi sebelum autentikasi.
- Setelan bisa diekspor dan diimpor. API key tidak pernah ikut karena tinggal di
  file terpisah di balik `safeStorage`.

## Changelog

Riwayat perubahan ada di [CHANGELOG.md](CHANGELOG.md).

## Lisensi

Tupai dirilis dengan lisensi [MIT](LICENSE). Copyright (c) 2026 Tupai.
