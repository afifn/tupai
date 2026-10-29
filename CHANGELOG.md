# Changelog

Semua perubahan penting pada Tupai dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/) dan
[Semantic Versioning](https://semver.org/lang/id/). Versi masih di jalur `0.x`,
jadi antarmuka dan format file bisa berubah antar rilis minor.

## [Unreleased]

## [0.2.3] - 2026-10-29

### Diubah

- **README** kini menyebut installer Windows sudah tersedia sejak 0.2.2, lengkap
  dengan langkah melewati SmartScreen dan konfirmasi administrator. Sebelumnya
  README masih menyatakan installer Windows belum dipublikasikan.
- README menambahkan catatan bahwa build macOS hanya ada pada rilis yang dibangun
  di macOS, sehingga pembaca tidak bingung ketika rilis teratas hanya berisi
  installer Windows.
- Pintasan di README memakai notasi platform (`⌘1` / `Ctrl+1`), bukan token
  mentah `Mod+1`.

### Ditambahkan

- **Tangkapan layar di README** dalam versi terang dan gelap, dipilih otomatis
  sesuai tema GitHub. Gambarnya memakai database demo, bukan data kerja.

### Diperbaiki

- **Koneksi Postgres yang diputus server karena menganggur tidak lagi menjatuhkan
  seluruh aplikasi.** Sebelumnya `pg.Client` memancarkan `error` tanpa listener,
  sehingga error itu menjadi uncaught exception dan mematikan worker database
  beserta semua koneksi. Kini sesi yang berakhir hanya membuang koneksi itu;
  koneksi lain tetap jalan dan koneksi tersebut menyambung ulang otomatis.
  Lubang yang sama ditutup untuk MySQL.
- **Query yang sedang berjalan saat sesinya diputus** berhenti dengan pesan
  "Sesi ke server berakhir (...) Koneksi ini perlu disambung ulang", bukan
  menggantung tanpa batas. Penyebabnya `pg-cursor`: callback pembacaan tidak
  pernah dipanggil setelah sesi mati.

## [0.2.2] - 2026-10-28

### Diubah

- **Installer Windows berbahasa Indonesia** dan tidak lagi menampilkan halaman
  "Who should this application be installed for?". Sebelumnya installer tampil
  bahasa Inggris karena daftar bahasa bawaan tidak memuat `id_ID`, dan halaman
  mode pemasangan menambah satu pertanyaan teknis yang juga berbahasa Inggris.
  Pemasangan kini selalu untuk semua pengguna, dengan satu konfirmasi
  administrator.
- **Catatan rilis GitHub dibuat dari `CHANGELOG.md`** lewat `npm run release:notes`.
  Skrip menambahkan langkah pemasangan di depan bagian perubahan, sehingga
  halaman unduhan selalu menjelaskan cara melewati peringatan SmartScreen.
- Grid data memakai **nomor urut** di kolom paling kiri, bukan checkbox. Baris
  dipilih langsung dengan mouse: klik memilih satu baris, Ctrl/Cmd+klik
  menambah, Shift+klik memperluas, dan drag menyapu rentang tanpa menyorot teks.
  Header `#` tetap berfungsi sebagai pilih-semua, dan pengguna keyboard memakai
  panah, Space, Ctrl/Cmd+A, dan Escape.

### Ditambahkan

- **Ekspor koneksi bisa dipilih**: menu konteks koneksi mengekspor koneksi itu
  saja, menu konteks grup mengekspor anggotanya, dan menu latar atau menu
  aplikasi tetap mengekspor semuanya. Dialog baru menampilkan checkbox per
  koneksi beserta nama file yang mengikuti nama koneksi saat hanya satu yang
  dipilih.
- **System Privileges** di halaman User untuk Oracle: `GRANT privilege TO user`
  dan `REVOKE privilege FROM user` tanpa klausa `ON`, lewat tombol **System** di
  setiap baris user. Hak tingkat sistem tidak terikat ke satu objek, jadi
  dipisahkan dari Grant/Revoke per objek.

### Diperbaiki

- Grid data tidak lagi menyisakan warna pada baris yang sudah di-deselect. Baris
  yang ditampilkan di panel Detail menyimpan tint sendiri, dan cincin fokus
  keyboard ikut menyala pada klik mouse; keduanya kini ikut bersih saat seleksi
  dikosongkan, sementara navigasi panah tetap menampilkan cincin fokus.
- **Teks baris koneksi berwarna** kini netral selama koneksi belum tersambung, dan
  baru memakai warna identitas setelah sesi dibuka. Warna mentah ternyata tidak
  layak jadi warna teks: diukur pada wash barisnya sendiri, 7 dari 8 warna gagal
  4.5:1 di tema terang dan 8 dari 8 gagal di tema gelap (terburuk violet 2.55:1).
  Warna teks karena itu memakai campuran 50% warna identitas dengan `--text`,
  shade paling jenuh yang masih lolos di semua latar termasuk saat hover
  (terukur 6.2–8.4:1 di terang, 4.8–6.7:1 di gelap). Aturan ini dijaga
  `tests/connectionTint.test.ts`.
- **Jarak sidebar kini satu ritme**: baris koneksi berwarna menambah padding dan
  margin sendiri, sehingga barisnya 3 px lebih tinggi dari tetangganya dan jarak
  antar-barispun melompat dari 28 px ke 32 px di setiap batas blok. Semua jarak
  disamakan menjadi 4 px (judul folder, koneksi, dan tree di dalam koneksi), dan
  tint warna kini hanya cat, bukan layout. Ikon koneksi juga diberi bentuk ring
  tipis tanpa latar, sesuai permintaan.
- **Ikon engine di sidebar** kini hanya berwarna saat koneksinya tersambung.
  Sebelumnya setiap baris punya kotak 20 px dengan latar abu-abu dan garis tepi,
  dan ikonnya selalu berwarna merek — jadi status "tersambung" tidak terlihat dan
  setiap baris membawa dua penanda visual sekaligus. Kotak dan garis tepinya
  dihapus, ikon tertutup tampil abu-abu, dan warna merek muncul saat sesi dibuka.
  Ikon Oracle juga tidak lagi merah sendiri di semua keadaan karena `oracle.svg`
  membawa `fill="#EA1B22"` tertanam yang mengalahkan warna CSS; `EngineIcon` kini
  membuang `fill` dari aset sehingga warna ditentukan di satu tempat.
- **Jarak blok di sidebar**: grup folder dan daftar koneksi kini dipisahkan 8 px
  (sebelumnya menempel), koneksi pertama di bawah judul folder diberi jarak 4 px,
  dan indentasi di dalam grup dikurangi dari 14 px ke 12 px supaya caret serta
  ikon grup dan koneksi duduk di kolom yang sama (terukur: `caretX` 11, `iconX`
  33, `nameX` 59 untuk keduanya).
- **Menu klik-kanan di dekat tepi bawah jendela** tidak lagi terpotong. Posisinya
  dulu ditebak dari jumlah item (`jumlah item × 30 px`), padahal tinggi sebenarnya
  juga terhitung dari padding, garis pemisah, dan label yang membungkus ke baris
  kedua. Pada menu latar sidebar (5 item) tebakannya meleset 32 px sehingga entri
  terakhir, **Reload**, berada di luar jendela dan tidak bisa diklik. Menu kini
  diukur lebih dulu lalu digeser ke dalam jendela, dan menu yang lebih tinggi dari
  jendela bisa di-scroll, bukan dipotong.
- **Membuat user di Oracle** gagal dengan `ORA-00988` karena password dikirim
  sebagai string literal, padahal `IDENTIFIED BY` menerima identifier password.
  Password kini dikutip sebagai identifier sehingga berfungsi untuk password
  berawalan angka, bertanda baca, dan reserved word.
- User Oracle yang baru dibuat **tidak bisa login** (`ORA-01045`) karena tidak
  punya `CREATE SESSION`. Pilihan "Can login" dan "superuser" kini benar-benar
  diterapkan.
- **Grant/Revoke di Oracle** mengirim `ON DATABASE`/`ON SCHEMA`, sintaks yang
  tidak ada di Oracle, sehingga selalu gagal dengan `ORA-00905`. Pilihan scope
  kini mengikuti kemampuan tiap engine: Oracle hanya Tabel dan Schema, dan scope
  Schema diperluas menjadi satu perintah per objek.
- Judul kolom di halaman **Users** dan **Sessions** menempel ke garis sel karena
  padding header dimatikan oleh aturan grid yang lebih spesifik. Header kini punya
  jarak lagi, dan tombol kedua halaman diletakkan di kanan pada posisi yang sama.
- Halaman **Sessions** dan **Users** kini memakai seluruh tinggi dan lebar tab.
  Sebelumnya tabelnya dipatok setinggi 320 px (Sessions) atau menyisakan celah
  (Users), dan lebarnya berhenti di lebar isi kolom. Jendela yang lebih besar
  sekarang menampilkan lebih banyak baris, dan jendela sempit tidak lagi
  memotong kolom aksi.
- Halaman **User** pada Oracle menampilkan setiap nama sebagai `undefined`.
  Query katalog mengembalikan baris sebagai array, sedangkan pembacanya memakai
  nama kolom. Nama, status login, dan tanda superuser kini terbaca benar.
- Worker database tidak lagi mati saat membuka tabel Oracle yang punya kolom CLOB
  atau NCLOB. Driver mengembalikan kolom itu sebagai objek `Lob` (handle yang
  terikat ke koneksi), dan handle tersebut tidak bisa menyeberang ke main process
  sehingga `postMessage` melempar `DataCloneError` dan mematikan thread beserta
  semua koneksi. Nilainya kini diambil sebagai string, dan nilai lain yang tidak
  bisa disalin ditampilkan sebagai label, bukan menjatuhkan sesi.
- Laporan worker berhenti kini menyebut penyebab sebenarnya beserta operasi yang
  sedang berjalan, bukan pesan kosong. Detail lengkap masuk `db-manager.log`,
  sedangkan banner hanya menampilkan baris pertamanya.
- Daftar relasi (foreign key) pada Oracle selalu kosong karena query memakai alias
  tabel yang tidak ada (`r.owner` pada join ber-alias `rc`). Kesalahan ini berlaku
  di semua versi Oracle, bukan hanya versi lama.
- Halaman User pada Oracle gagal dengan `ORA-00904` karena membaca
  `all_users.account_status`, kolom yang hanya ada di `dba_users`. Kini memakai
  `dba_users` bila tersedia, dan jatuh ke daftar nama dengan status ditandai tidak
  diketahui bila akun tidak punya akses katalog.

## [0.2.1] - 2026-10-27

### Ditambahkan

- Lisensi MIT (`LICENSE`), plus metadata `license` di `package.json` dan
  tautan lisensi di README.

### Diperbaiki

- Tabel Oracle bernama quoted-lowercase (misalnya `"orders"`) kini menampilkan
  data. Driver meng-uppercase nama tabel saat membaca kolom, primary key,
  index, foreign key, komentar, dan DDL, sehingga katalog tidak menemukannya
  dan grid terbuka tanpa kolom. Nama kini dipakai persis seperti yang
  dikembalikan katalog, termasuk schema quoted; pencarian objek memakai
  `UPPER(...)` agar tetap tidak peka huruf besar/kecil.
- Label **Kolom** di panel Detail, header tabel foreign key, dan header tabel
  pintasan di Setelan kini mengikuti bahasa antarmuka. Sebelumnya teksnya
  hardcode "Kolom"/"Nama"/"Shortcut".
- Memilih database atau schema di sidebar kini juga memindahkan fokus ke
  koneksinya. Sebelumnya, setelah membuka koneksi lain, memperluas database
  pada koneksi pertama tetap meninggalkan fokus di koneksi kedua, sehingga
  toolbar dan tab query baru memakai server yang salah.
- Item **Tentang Tupai** di menu bar macOS kini membuka panel Tentang yang sama
  dengan Setelan. Sebelumnya ia memakai panel bawaan Electron, sehingga versi,
  build, dan pemeriksaan pembaruan tidak terlihat, dan di mode dev nama
  aplikasinya tertulis "Electron".
- Ketika proses database berhenti, aplikasi kini memberi tahu. Sebelumnya semua
  koneksi hilang bersama thread itu tanpa pemberitahuan, dan UI tetap
  menampilkannya sebagai terbuka sampai operasi berikutnya gagal dengan pesan
  "koneksi tidak aktif" yang menyalahkan server. Sekarang muncul banner berisi
  alasan dan operasi terakhir, dan koneksi ditandai perlu disambung ulang.
- Koneksi Oracle gagal dengan "getConnection is not a function" sebelum menyentuh
  server. Paket `oracledb` adalah CommonJS, dan API-nya berada di `default` saat
  diimpor dari ES module; driver kini membuka `default` lebih dulu. Pesan error
  yang muncul sekarang adalah error jaringan atau TNS yang sebenarnya.
- Server Oracle yang lebih lama dari 12.1 kini bisa dihubungkan lewat mode thick.  Bagian **Oracle** di Pengaturan menerima folder Oracle Instant Client, dan
  pesan `NJS-138` diterjemahkan menjadi penjelasan yang mengarahkan ke setelan
  tersebut. Folder kosong tetap memakai mode thin, jadi server 12.1+ tidak
  berubah. Bagian itu juga punya tombol **Unduh Instant Client** yang membuka
  halaman unduhan Oracle di browser.
- Tabel pada Oracle 11g kini bisa dibuka. Driver memilih sintaks sesuai versi
  server: `identity_column`, `OFFSET ... FETCH NEXT`, dan `FETCH FIRST` hanya
  dipakai bila server mendukungnya (12c+), dan versi lama memakai pembungkus
  `ROWNUM`. Sebelumnya membuka tabel gagal dengan `ORA-00904`, lalu `ORA-01036`
  karena ada bind yang dikirim tanpa dipakai statement.

### Diubah

- Label pintasan di Setelan kini mengikuti platform: `⌘⇧F` di macOS dan
  `Ctrl+Shift+F` di Windows/Linux, bukan teks mentah `Mod+Shift+F`.
- Dialog Setelan menyesuaikan lebar/tinggi jendela, dan kontrolnya sedikit
  lebih lega di Windows agar tidak terasa sempit. Di layar sempit, kolom
  navigasi menyempit dan padding berkurang.
- Chrome aplikasi kini bersikap seperti jendela desktop, bukan halaman web:
  drag tidak lagi menyorot label, tab, toolbar, tree, atau status bar. Yang
  tetap bisa dipilih hanya isian, editor SQL, tabel hasil, teks SQL/DDL, pesan,
  dan balasan Asisten. Menu Edit > Select All kini memilih isi field atau
  seluruh buffer editor yang sedang fokus, bukan seluruh halaman.
- Asisten AI tidak lagi menampilkan blok tool call palsu. Prompt kini menyatakan
  bahwa asisten tidak punya akses database dan tidak boleh menulis
  `<function_calls>`; balasan yang tetap memuatnya dibersihkan sebelum ditampilkan
  dan diberi catatan singkat.
- Asisten kini menerima ringkasan skema database yang sedang dibuka (daftar tabel
  beserta kolomnya, dengan batas ukuran), sehingga pertanyaan seperti "analisa
  database ini" bisa dijawab tanpa membuka tabel atau mengetik @mention lebih
  dulu.

- Di Windows 11 dan Linux, toolbar kini juga menjadi baris title bar
  (`titleBarOverlay` 44px), sehingga tidak ada lagi baris judul terpisah di atas
  toolbar dan tombol minimise/maximise/close digambar OS di dalam baris yang
  sama. Perilaku OS seperti snap layout dan resize border tetap utuh. Warna
  overlay mengikuti tema terang/gelap. Windows 10 tetap memakai frame bawaan
  karena tidak mendukung overlay.

## [0.2.0] - 2026-10-25

### Ditambahkan

- Tiga bahasa baru: 简体中文, 日本語, dan Español. Pemilih bahasa kini berupa
  dropdown di Setelan, dan setiap label ditulis dalam bahasanya sendiri.
- **English menjadi bahasa utama** dan default untuk profil baru.
- Tab query baru mengikuti database dan schema yang terakhir dibuka di sidebar.
  Sebelumnya tombol `+` (juga `⌘1` dan menu Query) memilih database non-sistem
  pertama di server, bukan database yang sedang ditelusuri. Klik database atau
  schema di tree sekarang juga menjadi sorotan sidebar saat tidak ada tab yang
  menunjuk ke sana.

### Diubah

- Di macOS, toolbar kini menempati baris title bar: judul jendela bawaan
  dihapus (`titleBarStyle: hiddenInset`), traffic lights duduk di baris yang
  sama, dan toolbar bisa dipakai untuk menggeser jendela. Ruang untuk traffic
  lights dilepas otomatis saat fullscreen. Platform lain tetap memakai frame
  bawaan.
- Tab Data/Form/Structure/Import-Export dibuat lebih padat (teks 12px, padding
  5px/10px) dan judul tabel turun dari 16px ke 13px, sehingga lebih banyak
  baris terlihat.
- Filter tabel dipindah ke baris tab: tombol **Filter** di kanan tab membuka
  panel kondisi. Saat tertutup, tidak ada baris filter yang memakan tempat.
- Filter tabel disederhanakan menjadi satu daftar kondisi. Panel langsung
  menyediakan satu baris kosong, dengan pemilih AND/OR, jumlah kondisi aktif,
  tombol **Add a condition**, dan **Reset to default**.
- Label menu aplikasi, isi footer, dan puluhan teks yang masih hardcode
  (konfirmasi hapus, aria-label, catatan tabel tanpa primary key, dsb.) kini
  berasal dari katalog locale. Sebelumnya menu dan footer tetap berbahasa
  Indonesia walau antarmuka sudah diganti.
- Nama engine (MySQL, MariaDB, PostgreSQL, Oracle, SQLite, MongoDB) tetap
  tidak diterjemahkan.
- Ikon engine di sidebar kini memakai warna mereknya meskipun koneksi belum
  tersambung, dengan opasitas sebagai pembeda (0.85 vs 1). Sebelumnya ikon
  di-desaturasi total sehingga MySQL, MariaDB, Oracle, dan MongoDB tampak sama
  abu-abu. Badge 20px juga diberi garis tepi tipis agar tidak menyatu dengan
  latar sidebar, dan empat warna engine yang gagal 3:1 di badge digelapkan
  (MariaDB, SQLite, Oracle, MongoDB).
- Panel Asisten di dock kanan tidak lagi mengulang judulnya sendiri: tab
  "Assistant" di atas sudah menyebutnya, jadi baris judul di dalam panel
  dihapus dan tombol Setelan/Bersihkan pindah ke baris konteks. Tiga badge
  (model, "active schema context", "N tabel dirujuk") diganti satu baris teks
  redup berisi engine · database · schema, dengan nama model di kanan.
- Sisa teks Indonesia yang masih hardcode di panel Asisten (label peran
  Kamu/Asisten, "Sisipkan SQL", pesan gagal memuat tabel, keterangan kolom,
  pesan hentikan, batas rujukan) kini lewat katalog locale. Placeholder dan
  hint tidak lagi mengulang kalimat yang sama.
- Bulatan status di kanan setiap baris koneksi dihapus. Status tersambung sudah
  dibaca dari ikon engine yang menyala dengan warna brand-nya, jadi bulatan itu
  hanya menambah kolom yang selalu terlihat, termasuk abu-abu untuk koneksi
  yang belum tersambung.
- `@vitejs/plugin-react` naik ke 6.1.2 agar mengikuti Vite 8 (rolldown).
  Sebelumnya plugin v4 mengirim opsi `esbuild`/`jsx` yang sudah deprecated,
  sehingga `npm run dev` mencetak peringatan dan rolldown menolak opsi JSX-nya.

### Diperbaiki

- Tab yang baru dibuka tidak terlihat saat tab bar sudah penuh: strip tab kini
  otomatis menggulir ke tab aktif, dan kembali saat tab di kiri dipilih.
- Tabel berkedip saat pertama kali dibuka: peringatan "tanpa primary key"
  sempat muncul lalu hilang, dan kotak tabel baru terbentuk setelah data tiba
  sehingga tata letak melompat. Peringatan kini menunggu data, dan rangka tabel
  plus pager sudah ada sejak awal.
- Bundel main gagal dibangun setelah katalog bertambah banyak
  ("Unterminated string literal"). Penyebabnya katalog locale ikut ter-bundle ke
  proses main lewat `menu.ts`; menu native kini menerima label dari renderer
  lewat IPC, sehingga main tidak lagi membawa ~6.500 string terjemahan.
- Pemisah statement tidak lagi membuang komentar blok yang dieksekusi server.
  `/*!40101 SET NAMES utf8 */;` (bentuk yang ditulis mysqldump) tetap dikirim
  saat import atau restore, alih-alih dianggap komentar kosong.
- Tombol hapus di baris koneksi langsung menghapus tanpa bertanya, padahal menu
  klik-kanan untuk aksi yang sama meminta konfirmasi. Sekarang keduanya memakai
  dialog yang sama, dengan judul, pesan, dan detail dari katalog locale.
- Fokus awal dialog konfirmasi jatuh ke tombol berbahaya ketika semua aksi
  bersifat destruktif, sehingga menekan Enter menghapus. Kini Cancel yang
  mendapat fokus.
- Tab editor dan tab panel kanan (Asisten/Detail) kini sama tinggi (28px) dan
  duduk di sumbu yang sama di dalam bar 38px. Sebelumnya tab editor 30.75px
  sehingga strip meluber 2.75px melewati garis bawah tab bar, sementara tab
  panel kanan hanya 26px.

## [0.1.1] - 2026-10-25

### Diubah

- Electron 32.3.3 -> **45.0.0** (Chromium 156, Node 24.22.0). Ini menutup
  kerentanan Chromium yang tertinggal selama setahun di Electron 32.
- Node host 22.14.0 -> **24.22.1** (LTS Krypton), di-pin lewat `.nvmrc`,
  `.node-version`, dan `engines.node`.
- `better-sqlite3` 11.10 -> **13.0.3**, yang memakai N-API. Satu binary kini
  dipakai host dan Electron, sehingga siklus rebuild per-ABI (sumber error
  `NODE_MODULE_VERSION` berulang) tidak diperlukan lagi.

### Diperbaiki

- Clipboard berhenti bekerja setelah Electron 44 mengubah `writeText`/`readText`
  menjadi async: nilai promise ikut dikirim sehingga tempel menghasilkan
  `[object Promise]`. Handler kini meng-`await`.
- `safeStorage` dipindah ke API async (`encryptStringAsync`,
  `decryptStringAsync`) karena API sinkron dihapus di Electron 46. Ciphertext
  lama tetap terbaca, jadi tidak ada password yang perlu diisi ulang.

### Catatan

- Build macOS kini memerlukan **macOS 13 atau lebih baru**; Chromium di Electron
  45 menghentikan dukungan macOS 12.
- `better-sqlite3@13` mensyaratkan Electron 35+ karena butuh N-API versi 10.

## [0.1.0] - 2026-10-25

### Ditambahkan

- Transaksi manual per tab Query untuk MySQL, MariaDB, PostgreSQL, dan Oracle:
  mulai transaksi, jalankan beberapa statement, lalu **Commit** atau
  **Rollback**. Selama transaksi terbuka, perubahan tidak terlihat oleh sesi
  lain dan bisa dibatalkan. Badge di toolbar menunjukkan jumlah statement dan
  status gagal.
- Pengaman: menutup tab, memutus koneksi, atau keluar aplikasi saat transaksi
  masih terbuka akan menanyakan Commit / Rollback / Batal. Tidak ada
  auto-commit.
- DDL pada MySQL/MariaDB/Oracle terdeteksi sebagai implicit commit dan
  dikonfirmasi lebih dulu, bukan dibiarkan mengakhiri transaksi diam-diam.
- Opsi "Konfirmasi sebelum menutup aplikasi" di Setelan akhirnya berfungsi,
  termasuk saat ada query yang belum disimpan.
- Database dan schema dikunci selama transaksi terbuka agar statement tidak
  berpindah katalog di tengah jalan.

### Catatan

- SQLite dan MongoDB belum mendukung transaksi manual; tombolnya nonaktif
  dengan alasan yang ditampilkan.
- Edit grid, Table Designer, dan Sync tetap memakai transaksi sendiri per aksi,
  di luar transaksi tab Query.

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

Setiap versi di atas sudah punya tag dan GitHub Release. Naikkan `version` di
`package.json` dan tambahkan bagian baru di file ini sebelum merilis; lihat
`DEVELOPING.md` untuk urutan build dan publikasinya.
