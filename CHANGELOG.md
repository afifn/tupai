# Changelog

Semua perubahan penting pada Tupai dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/) dan
[Semantic Versioning](https://semver.org/lang/id/). Versi masih di jalur `0.x`,
jadi antarmuka dan format file bisa berubah antar rilis minor.

## [Unreleased]

Belum ada perubahan setelah `0.0.3`.

## [0.0.3] - 2026-10-24

### Diperbaiki

- Aplikasi terpaket tidak bisa menyambung ke database apa pun: setiap tes
  koneksi gagal dengan "Cannot use import statement outside a module". Worker
  database adalah ES module yang berjalan dari `app.asar.unpacked`, di luar
  `package.json` aplikasi, sehingga Node memperlakukannya sebagai CommonJS.
  Folder worker sekarang membawa penanda `{"type":"module"}`.

## [0.0.2] - 2026-10-24

### Ditambahkan

- `TUPAI_UPDATE_URL` untuk menunjuk feed pembaruan statis sendiri (provider
  `generic`), dipakai menguji alur pembaruan tanpa merilis dan untuk hosting
  sendiri.

### Diubah

- Rilis dipindahkan ke repositori publik agar feed pembaruan bisa dibaca tanpa
  autentikasi.

## [0.0.1] - 2026-10-24

Rilis terpaket pertama. Build macOS arm64/x64 dan installer Windows x64 belum
ditandatangani.

### Ditambahkan

**Database dan koneksi**

- Enam engine: MySQL, MariaDB, PostgreSQL, Oracle, SQLite, MongoDB.
- Grup koneksi berwarna dengan drag & drop.
- SSH tunnel untuk MySQL/MariaDB dan PostgreSQL, dengan verifikasi host key dan
  mode ketat.
- SSL/TLS dengan CA, client certificate, dan private key.
- Port serta opsi bawaan per engine; port mengikuti saat engine diganti.
- Impor dan ekspor koneksi Navicat (`.ncx`). Password tidak pernah didekripsi
  atau diekspor.

**Menjelajah dan mengedit data**

- Tree Database → Schema → Tabel/View → Kolom, plus Queries dan Programmable
  (function, procedure, trigger, event).
- Browser objek dengan jumlah baris, ukuran, komentar, dan engine.
- Pencarian lintas objek dan filter cepat sidebar (`Mod+F`).
- Grid dengan paging, sorting, filter cepat, dan filter multi-kondisi (AND/OR).
- Edit sel dan tambah baris sesuai tipe data (date/time picker, boolean, angka,
  JSON).
- Hapus banyak baris dalam satu transaksi, multi-select, kolom bisa di-resize.
- Preview BLOB: gambar, teks, atau hex dump.
- Form view per record dan diagram tabel/relasi (ER).
- Context menu untuk koneksi, database, schema, tabel, view, routine, dan sel.

**Query**

- Editor Monaco dengan autocomplete tabel/kolom, multi-tab, dan riwayat.
- Batas baris ditegakkan di driver, jadi `SELECT *` pada tabel besar tidak
  memuat seluruh hasil ke memori.
- Hentikan query yang sedang berjalan (PostgreSQL, MySQL, Oracle).
- Workspace hasil: satu tab per statement, tab Messages, dan query plan
  (EXPLAIN).
- Jalankan hanya bagian yang diseleksi.
- Query Builder visual untuk SELECT dan Beautify lokal (`sql-formatter`).
- Query tersimpan sebagai file `.sql`, dengan impor dan ekspor.

**Asisten AI**

- Endpoint OpenAI-compatible dengan streaming dan tombol berhenti.
- Rujukan tabel lewat `@nama_tabel`, beserta kolomnya.
- Aksi SQL: optimize, explain, tambah komentar, perbaiki dari error, dan
  konversi dialek.
- Pratinjau maksimal lima baris di bawah jawaban. Hanya `SELECT`/`WITH` tunggal
  yang dijalankan; DML, DDL, batch, dan fungsi penunda ditolak. Permintaan lebih
  dari lima baris hanya menampilkan query, dan pratinjau bisa dimatikan.
- Konteks engine dan database selalu dikirim, termasuk saat hanya tab query yang
  terbuka.
- Peran asisten dikunci ke urusan database: instruksi pengguna tidak bisa
  mengubahnya menjadi chatbot umum.

**Struktur dan administrasi**

- Table Designer (kolom, index, foreign key, komentar, info, DDL) dan View
  Designer.
- Manajemen user dan permission (MySQL, MariaDB, PostgreSQL, Oracle).
- Monitor sesi dan penghentian sesi lain.
- Import/Export CSV, JSON, SQL; backup dan restore SQL dengan riwayat.
- Data Transfer antar tabel, termasuk lintas engine, dengan pratinjau.
- Sinkronisasi struktur dan data antar database dengan pratinjau diff sebelum
  deploy.

**Antarmuka**

- Menu aplikasi native: File, Edit, View, Tools, Window. Item tanpa target
  dinonaktifkan, dan accelerator mengikuti keymap tersimpan.
- Dialog Setelan terpusat dengan tujuh bagian: Umum, Tampilan, Editor, Grid,
  Asisten, Keymap, Tentang.
- Lima tema (Terang, Gelap, Light Ocean, Dark Forest, Kustom) plus palet kustom
  terang/gelap dari empat warna inti, divalidasi kontras.
- Bahasa Indonesia dan Inggris. Istilah teknis tidak diterjemahkan.
- Keymap yang bisa diubah untuk sepuluh aksi shell.
- Notifikasi desktop dengan hitungan waktu yang berhenti saat kursor di atasnya.

### Diubah

- Nama produk menjadi **Tupai**; profil lama `db-manager` dipakai ulang agar
  koneksi dan password yang sudah tersimpan tetap terbaca.
- Seluruh teks antarmuka pindah ke katalog locale, termasuk pesan error driver
  yang diterjemahkan lewat kode error.
- Sidebar memakai satu filter lintas koneksi, menggantikan pencarian per
  koneksi.
- Menu bar macOS memakai menu aplikasi sendiri tanpa role `close`, agar `Cmd+W`
  menutup satu tab, bukan jendela.

### Diperbaiki

- Worker database dimuat dari `app.asar.unpacked`; sebelumnya worker gagal
  spawn pada build terpaket.
- Jawaban asisten tidak tampil bila provider mengirim semua delta dan `[DONE]`
  dalam satu chunk.
- Mengubah model di Setelan tidak berpengaruh ke chat, dan mematikan pratinjau
  menghapus model, karena blok setelan AI punya dua penulis.
- Tabel yang baru dibuat lewat query editor tidak bisa di-`@` sampai panel
  ditutup dan dibuka lagi.
- Postgres memakai satu client per database; membuka database lain sebelumnya
  membaca katalog yang salah.
- Data tabel tidak tampil karena `selectRows` tidak mengembalikan `columns`,
  `primaryKeys`, dan `hasPrimaryKey`.
- `splitStatements` memahami dollar-quoting Postgres sehingga body function
  tidak terpotong.
- Query yang dihentikan tidak lagi meninggalkan timer `PROTOCOL_SEQUENCE_TIMEOUT`
  pada koneksi MySQL.
- Store ditulis atomik dengan `.bak`, dan dialog konfirmasi memakai dialog
  dalam aplikasi, bukan `window.confirm`/`window.prompt`.

### Keamanan

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, CSP ketat.
- Password database, passphrase SSH, dan API key AI dienkripsi `safeStorage`.
  Bila OS tidak menyediakan penyimpanan aman, penyimpanan gagal dengan pesan
  jelas alih-alih menulis nilai kosong.
- Renderer tidak pernah menerima kredensial.
- Setiap channel IPC divalidasi zod sebelum menyentuh worker.
- Host key SSH diverifikasi; perubahan sidik jari memblokir koneksi sebelum
  autentikasi.

### Pembaruan

- Pemeriksaan versi baru otomatis saat aplikasi dibuka, plus tombol
  **Periksa pembaruan** di Setelan → Tentang dan item menu aplikasi.
- Windows: unduhan berjalan di latar belakang dan installer dipasang saat
  pengguna menekan **Pasang dan mulai ulang**; arsitektur installer mengikuti
  yang terpasang.
- macOS: build belum ditandatangani, jadi panel menampilkan versi baru dan
  tombol **Buka halaman unduhan** alih-alih memasang sendiri. Auto-install
  menyala otomatis setelah build ditandatangani Developer ID.
- Feed memakai GitHub Releases (`latest.yml`, `latest-mac.yml`), jadi tidak ada
  server update terpisah. Pemeriksaan hanya mengirim permintaan versi.
- `TUPAI_UPDATE_URL` bisa menunjuk feed statis sendiri (provider `generic`),
  dipakai untuk menguji alur pembaruan tanpa merilis.

### Catatan rilis

- Build macOS belum ditandatangani dan belum dinotarisasi. Buka lewat klik
  kanan → **Open** sekali, atau jalankan
  `xattr -dr com.apple.quarantine /Applications/Tupai.app`.
- MongoDB tidak punya SQL editor, DDL, sync, backup, atau manajemen user.
- SQLite tidak mendukung `ALTER COLUMN`, perubahan primary key, atau manajemen
  user; perubahan seperti itu dilaporkan `unsupported`.

Belum ada tag rilis di repositori; `0.0.1` adalah versi yang tertulis di
`package.json`. Bagian `Unreleased` akan menjadi rilis berikutnya, dan tautan
perbandingan ditambahkan setelah tag pertama dibuat.
