# Changelog

Important changes in Tupai are listed here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/). Tupai is still in the `0.x`
series, so settings and file formats may change between minor releases.

## [Unreleased]

## [0.2.6] - 2026-11-01

### New Features

- Added a complete, grouped SQL type picker for each supported database engine.
- Added separate Length, Decimals, and Values fields for parameterized types.
- Added a dialog for editing `ENUM` and `SET` values one item per line.
- Added Log settings with detail levels, file limits, history, and folder actions.
- Added daily log files with rotation and oldest-file retention.
- Added editable syntax colours for the SQL editor, applied to every editor and the preview.
- Added a Help menu with documentation, changelog, issue reporting, and keyboard shortcuts.

### Fixes

- Replaced the platform colour picker with an in-app picker, so choosing a syntax colour no longer makes the window blink.
- Theme and editor colours no longer repaint the window when an unrelated setting changes.
- Added a live SQL preview to Editor settings with one row per option.
- Rewrote the README in clear English and removed references to other products.
- Kept table structure rows aligned with fixed columns and dedicated type fields.
- Hid unsupported column comments in SQLite.
- Simplified My theme to three main colours, a live preview, and a readable status.
- Made custom themes apply correctly to both light and dark appearances.
- MongoDB no longer shows SQL column types or table DDL controls.
- Replaced hardcoded Run labels with translated messages.
- Migrated legacy `db-manager` profiles to the `Tupai` profile folder.
- Moved log controls from About to the Log settings section.

## [0.2.5] - 2026-10-30

### New Features

- Updated the README for the macOS 0.2.5 release, Settings window, and demo workspace.

### Fixes

- Settings now closes with the main window and no longer keeps the application alive.
- Oracle client changes now show the required restart action and the active client path.

## [0.2.4] - 2026-10-30

### New Features

- Added a refreshed light and dark POS demo workspace to the README.
- Added tab reordering with drag and drop, context menus, and keyboard shortcuts.
- Added a separate Settings window with platform-specific navigation.

### Fixes

- Settings changes now apply immediately to the main window.
- The Settings title bar now follows the native frame and application theme.

## [0.2.3] - 2026-10-29

### New Features

- Added light and dark README screenshots using a separate demo database.

### Fixes

- Idle PostgreSQL and MySQL disconnects no longer crash the database worker.
- Queries now stop with a clear reconnect message when their session ends.
- README installation notes now cover Windows and macOS release differences.

## [0.2.2] - 2026-10-28

### New Features

- Added selectable connection export for individual connections and groups.
- Added Oracle system privilege management.
- Added row-number selection to the data grid with mouse and keyboard support.

### Fixes

- The Windows installer now uses Indonesian text and installs for all users.
- GitHub release notes can now be generated from the changelog.
- Deselected grid rows no longer keep selection colours.
- Improved connection colours, engine icons, sidebar spacing, and context-menu positioning.
- Fixed Oracle user creation, login privileges, grants, foreign keys, and user listings.
- Oracle CLOB and NCLOB columns no longer crash the database worker.
- Worker stop messages now include the failed operation.
- Sessions and Users tables now use the available window space.

## [0.2.1] - 2026-10-27

### New Features

- Added the MIT license and license links.
- Added Oracle support for quoted lowercase table names, older servers, and thick mode.

### Fixes

- Improved Oracle table, user, foreign key, and connection handling.
- Added translated labels for remaining structure and Settings fields.
- Sidebar scope selection now keeps the active connection correct.
- The macOS About menu now opens Tupai's About settings.
- Database worker failures now show a clear reconnect notice.
- Settings and toolbar layouts now adapt better to platform and window size.
- Query, assistant, filter, and table grid interactions received multiple stability fixes.

## [0.2.0] - 2026-10-25

### New Features

- Added Simplified Chinese, Japanese, and Spanish translations.
- Added database and schema context to new query tabs.
- Added native application menus with configurable keybindings.
- Added five themes, custom light and dark palettes, and contrast validation.
- Added data filtering, assistant improvements, and compact table controls.

### Fixes

- Improved tab scrolling, table loading, confirmations, assistant output, and PostgreSQL sessions.
- Fixed packaged worker loading, MySQL cancellation cleanup, and atomic settings writes.
- Moved remaining interface text and driver errors into the locale catalog.
- Improved engine icons, sidebar states, and right-panel layout.

## [0.1.1] - 2026-10-25

### New Features

- Upgraded Electron, Node.js, and better-sqlite3 to current supported versions.

### Fixes

- Fixed clipboard operations and asynchronous safeStorage handling after the Electron upgrade.
- macOS builds now require macOS 13 or newer.

## [0.1.0] - 2026-10-25

### New Features

- Added manual transactions for MySQL, MariaDB, PostgreSQL, and Oracle query tabs.
- Added transaction safeguards for closing tabs, disconnecting, quitting, and implicit DDL commits.
- Added the working close-confirmation setting and database/schema locking during transactions.

### Fixes

- SQLite and MongoDB clearly disable unsupported manual transaction controls.
- Table Designer, grid edits, and Sync keep their own per-operation transactions.

## [0.0.3] - 2026-10-24

### Fixes

- Fixed packaged database connections by loading the worker as an ES module.

## [0.0.2] - 2026-10-24

### New Features

- Added a configurable update feed URL for self-hosted and test releases.

### Fixes

- Moved releases to the public repository so update feeds work without authentication.

## [0.0.1] - 2026-10-24

### New Features

- Added MySQL, MariaDB, PostgreSQL, Oracle, SQLite, and MongoDB connections.
- Added SSL, SSH tunnels, host-key verification, connection groups, and Navicat import/export.
- Added database browsing, filtering, paging, sorting, editing, forms, BLOB previews, and diagrams.
- Added Monaco SQL editing with autocomplete, history, query plans, saved queries, and selection execution.
- Added AI assistance with streaming, SQL actions, schema context, and safe query previews.
- Added Table and View Designers, user and session management, import/export, backup, and restore.
- Added data transfer and structure/data synchronization with previews.
- Added native menus, Settings, themes, English and Indonesian translations, and configurable keybindings.

### Fixes

- Packaged builds, assistant streaming, model settings, table references, PostgreSQL sessions, and data-grid metadata were stabilized.
- Added secure credential storage, strict Electron isolation, IPC validation, SSH host-key checks, and update checks.
- Renamed the product profile to Tupai while preserving existing connections and encrypted credentials.
