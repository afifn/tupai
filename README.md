<div align="center">

<img src="build/icon.png" alt="Tupai icon" width="96" />

# Tupai

### A desktop database tool for six database engines.

**MySQL · MariaDB · PostgreSQL · Oracle · SQLite · MongoDB**

Browse objects, edit data, run queries, move data, and manage database work in
one application.

[![Latest release](https://img.shields.io/github/v/release/afifn/tupai?style=flat-square)](https://github.com/afifn/tupai/releases)
[![MIT license](https://img.shields.io/github/license/afifn/tupai?style=flat-square)](LICENSE)
[![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D4?style=flat-square&logo=windows)](https://github.com/afifn/tupai/releases)
[![macOS 13+](https://img.shields.io/badge/macOS-13%2B-000000?style=flat-square&logo=apple)](https://github.com/afifn/tupai/releases)

[Download](#installation) · [Features](#features) · [Engines](#supported-engines) · [Quick start](#quick-start) · [FAQ](#faq)

</div>

> [!IMPORTANT]
> Download Tupai only from the [official releases page](https://github.com/afifn/tupai/releases).
> Current builds are not digitally signed. Windows may show **More info** and
> **Run anyway**. On macOS, right-click the app and choose **Open** once.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/dark.png">
  <img src="assets/screenshots/light.png" alt="Tupai showing a database tree and data grid" width="100%">
</picture>

## Features

### Connections

- Connect to MySQL, MariaDB, PostgreSQL, Oracle, SQLite, and MongoDB.
- Use SSL/TLS, certificates, SSH tunnels, and SSH host-key checks where supported.
- Organize connections into groups with colours and drag and drop.
- Test a connection before saving it.
- Import and export connection files in NCX format. Passwords are never exported.

### Browse and edit data

- Browse databases, schemas, tables, views, routines, and saved queries.
- Use paging, sorting, quick filters, and multiple filter conditions.
- Edit cells, add rows, and delete multiple rows in one transaction.
- Open records in a form view.
- Preview binary data as an image, text, or hexadecimal data.
- View tables and relationships in a diagram.
- Tables without a primary key are read-only.

### Query editor and assistant

- Write SQL in a multi-tab editor with table and column completion.
- View one result tab per statement, messages, and query plans.
- Run the whole editor or only the selected SQL.
- Stop running queries on PostgreSQL, MySQL, and Oracle.
- Use manual transactions on MySQL, MariaDB, PostgreSQL, and Oracle.
- Format SQL locally and build simple `SELECT` queries visually.
- Ask the database assistant about the open schema and reference tables with `@`.
- Preview up to five rows from a safe `SELECT` query before running it.

### Tables and administration

- Create and edit tables, indexes, foreign keys, comments, and table settings.
- Choose database types from an engine-specific list in the table designer.
- Edit type length, decimal digits, and `ENUM` or `SET` values in separate fields.
- Use the table designer for PostgreSQL, MySQL, MariaDB, Oracle, and SQLite.
- Manage users and permissions on MySQL, MariaDB, PostgreSQL, and Oracle.
- Monitor and stop sessions where the engine supports it.
- Import CSV and SQL files, and export CSV, JSON, and SQL.
- Back up and restore SQL databases with backup history.
- Transfer data between tables, including between different engines.
- Compare and deploy structure or data changes with a preview first.

MongoDB is a document database, so Tupai does not show SQL tables, SQL DDL,
SQL synchronization, SQL backups, or SQL user management for MongoDB.

### Appearance and settings

- Use a separate Settings window with sections for General, Appearance, Editor,
  Grid, Oracle, Assistant, Keymap, Log, and About.
- Choose light, dark, preset, or custom themes.
- Build a custom theme from the app background, text colour, and button colour.
- Preview custom colours before applying them and check text readability.
- Adjust editor font, size, indentation, and syntax colours with a live SQL preview.
- Set log detail, file size, file count, and view log history in **Settings > Log**.
- Use English, Indonesian, Simplified Chinese, Japanese, or Spanish.
- Change keybindings for common actions.
- Open the documentation, changelog, issue tracker, and keyboard shortcuts from **Help**.

## Supported engines

| Feature                 | MySQL | MariaDB | PostgreSQL | Oracle | SQLite  | MongoDB |
| ----------------------- | :---: | :-----: | :--------: | :----: | :-----: | :-----: |
| SQL editor              |  Yes  |   Yes   |    Yes     |  Yes   |   Yes   |   No    |
| Table structure and DDL |  Yes  |   Yes   |    Yes     |  Yes   | Limited |   No    |
| Users and permissions   |  Yes  |   Yes   |    Yes     |  Yes   |   No    |   No    |
| Session monitor         |  Yes  |   Yes   |    Yes     |  Yes   |   No    |   Yes   |
| SQL backup and restore  |  Yes  |   Yes   |    Yes     |  Yes   |   Yes   |   No    |
| Synchronization         |  Yes  |   Yes   |    Yes     |  Yes   |   Yes   |   No    |
| Manual transactions     |  Yes  |   Yes   |    Yes     |  Yes   |   No    |   No    |
| Relationship diagrams   |  Yes  |   Yes   |    Yes     |  Yes   |   Yes   |   No    |

Notes:

- SQLite does not support changing a column type or primary key through `ALTER TABLE`.
- Data synchronization requires a primary key, including composite primary keys.
- Oracle servers older than 12.1 need Oracle Instant Client in thick mode.

## Installation

### macOS

Download the DMG or ZIP for your Mac from the [releases page](https://github.com/afifn/tupai/releases):

- `Tupai-<version>-arm64.dmg` for Apple Silicon
- `Tupai-<version>-x64.dmg` for Intel

Open the DMG and drag Tupai to Applications. Because the build is not signed,
open it once with right-click, **Open**, or run:

```bash
xattr -dr com.apple.quarantine /Applications/Tupai.app
```

### Windows

Download `Tupai-Setup-<version>.exe` from the [releases page](https://github.com/afifn/tupai/releases).
When Windows shows its security warning, choose **More info**, then **Run anyway**.
The installer needs administrator permission because it installs for all users.

### From source

You need Node.js 22.12 or newer, preferably Node.js 24 LTS, and npm.

```bash
npm install
npm run rebuild
npm run dev
```

To build an unsigned macOS package:

```bash
npm run dist:mac:unsigned
```

## Quick start

1. **Create a connection.** Choose an engine, enter its connection details, and
   press **Test** before saving it. For SQLite, choose a database file.
2. **Open a table.** Connect, expand a database and schema, then select a table.
3. **Edit data.** Use paging, sorting, and filters. Add rows from the pager and
   select rows with clicks, Shift-click, or drag.
4. **Run SQL.** Open a Query tab with `⌘1` or `Ctrl+1`, choose a database, and
   run with `⌘Enter` or `Ctrl+Enter`.
5. **Use the assistant.** Ask about the open schema or type `@` to reference a table.
6. **Move or back up data.** Use Transfer, Sync, or Backup after checking the preview.
7. **Change settings.** Open Settings with `⌘,` or `Ctrl+,`.

### Shortcuts

| Action         | macOS    | Windows/Linux |
| -------------- | -------- | ------------- |
| New query tab  | `⌘1`     | `Ctrl+1`      |
| Run query      | `⌘Enter` | `Ctrl+Enter`  |
| Close tab      | `⌘W`     | `Ctrl+W`      |
| Search objects | `⌘F`     | `Ctrl+F`      |
| Open Settings  | `⌘,`     | `Ctrl+,`      |
| Open Users     | `⌘2`     | `Ctrl+2`      |
| Open Sessions  | `⌘6`     | `Ctrl+6`      |

Shortcuts can be changed in **Settings > Keymap**.

## Updates

Tupai checks for new releases when it starts. You can also check manually in
**Settings > About > Check for updates**.

- **Windows** downloads the update and installs it when you choose **Install and restart**.
- **macOS** shows a download link because unsigned builds cannot update themselves.
- The update check sends only a version request. Database connections, credentials,
  and settings are not sent.

## System requirements

- macOS 13 or newer, Apple Silicon or Intel.
- Windows 10 or 11, 64-bit.
- Oracle 12.1 or newer for thin mode; older Oracle servers need Oracle Instant Client.
- MongoDB does not provide SQL editor or SQL table features in Tupai.

## Data and privacy

Tupai stores data locally. Open the data folder from **Settings > About > Data folder**.

- Database passwords, SSH secrets, and the assistant API key are encrypted with the
  operating system secure storage.
- Credentials are never sent back to the renderer.
- SSH host keys are checked before authentication.
- Settings exports do not include the assistant API key.
- Logs are stored in `Tupai/Logs/` as `tupai-YYYYMMDD.log` files.
- The old `db-manager` profile is moved to `Tupai` on startup when it is the default profile.
- An explicit `--user-data-dir` is never changed.

## FAQ

<details>
<summary><strong>Is Tupai free?</strong></summary>

Yes. Tupai is released under the [MIT license](LICENSE). There is no account,
subscription, or intermediary server.
</details>

<details>
<summary><strong>Does Tupai send my database data online?</strong></summary>

No. Database operations run on your computer. The app only checks for updates,
and it contacts an assistant provider if you configure and use the assistant.
</details>

<details>
<summary><strong>Where are my connections and settings stored?</strong></summary>

In the local application data folder, available from **Settings > About > Data folder**.
</details>

<details>
<summary><strong>Where are log files stored?</strong></summary>

In the `Logs` folder inside the application data folder. Open **Settings > Log**
to see the files, open the folder, or open the active file.
</details>

<details>
<summary><strong>Can I use Tupai with a production database?</strong></summary>

Yes, but table changes, data edits, DDL, and synchronization affect the target
database directly. Test on a copy first and keep a backup.
</details>

<details>
<summary><strong>How do I report a bug?</strong></summary>

Open an [issue](https://github.com/afifn/tupai/issues) with the Tupai version,
engine and server version, reproduction steps, and relevant log files.
</details>

## Documentation

- [Changelog](CHANGELOG.md)
- [Releases](https://github.com/afifn/tupai/releases)
- [Issues](https://github.com/afifn/tupai/issues)
- [License](LICENSE)

## Contributing

Issues and pull requests are welcome. Before submitting a change, run:

```bash
npm run typecheck
npm run lint
npm test
```

Run the relevant smoke test for changes to drivers, IPC, synchronization, or
the application runtime.

## License

[MIT](LICENSE). Copyright (c) 2026 Tupai.

## Safety

Tupai is a database administration tool. Commands such as `DROP`, `TRUNCATE`,
DDL, and synchronization change the target database directly. Make sure you
have permission to change the target and keep a backup before destructive work.
