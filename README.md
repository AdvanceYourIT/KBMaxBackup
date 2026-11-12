# KBMax Backup

Edge/Chrome extension (Manifest V3, no build step, no dependencies) that backs up the configuration of Epicor CPQ (KBMax) as a ZIP of JSON files. The internal KBMax API is called from the logged-in tab, so no credentials are stored in the extension.

> **Unofficial community tool.** It is not affiliated with or endorsed by Epicor. It uses the internal, undocumented web API of KBMax (the same calls the KBMax admin screens make), which can change without notice. Try everything on a DEV environment first; the import tool writes to KBMax.

## Installation
1. Open `edge://extensions/` (or `chrome://extensions/`), enable **Developer mode**, click **Load unpacked**.
2. Select the folder of this repository (the one that contains `manifest.json`).

## Usage
1. Log in to KBMax (dev, test or production) and keep that tab active.
2. Open the extension. Every environment with an open KBMax tab is offered under **Environment to back up** (default: the active tab, otherwise the most recently used one) and shown as a badge (DEV / TEST / PROD).
3. On the **Backup** tab choose what to include and click **Create backup**. Progress and log appear in a separate tab. Without an upload destination the ZIP is downloaded when done; with an enabled destination the backup goes there instead and no ZIP is downloaded (**Download ZIP** on the progress page still gives you one). If an upload fails, the ZIP is downloaded as a fallback so the backup is not lost.

Backups can be started ad hoc, as often as needed: there is no daily limit and the button is never disabled because a backup already ran. It is only disabled when no KBMax tab is open or nothing is selected. After a backup, **Run backup again** on the progress page repeats it with the same settings.

Each ZIP is named `KBMax_<DEV|TEST|PROD>_<date>_<time>.zip` and contains one folder per category with one JSON file per record, plus `backup-info.json` (environment, time, counts) and `_errors.json` when records failed. The last backup per environment is remembered.

**Back up one record.** When the KBMax tab shows a single record, the popup gets a *Record on screen* panel with **Back up this record**. The record is recognised from the page URL (the part after `#` is ignored): `/admin/configurators/<id>` (product), `/admin/scenes/<id>`, `/admin/safe-functions/<id>`, `/admin/quote-headers/<id>`, `/admin/workflows/<id>`, `/admin/custom-actions/<id>`, `/admin/quote-outputs/<id>`, `/admin/global-functions/<id>`, `/admin/global-definitions/<id>`, `/admin/tables/<id>`, `/admin/builders/<id>`, `/admin/price-columns/<id>`, `/admin/generators/<id>`, `/admin/queues/<id>`, `/admin/roles/<id>`, `/admin/themes/<id>`, `/admin/email-templates/<id>`, `/admin/build-types/<id>`, `/admin/layouts/<id>` and `/quotes/<id>`. (KBMax builds these page URLs from the type name: kebab-case plural, so a new type follows the same pattern.) Global definitions, builders, price columns, generators and queues have no known single-record endpoint; the extension tries `GET /api/<type>/<id>` and falls back to the search list (which already returns full records). It saves the *saved* version from KBMax (unsaved changes in the editor are not included) as `KBMax_<ENV>_<type>-<id>_<time>.zip`, in the same layout as a full backup, and goes to the enabled upload destinations too. It does not change the "last backups" list. Add a page to this list with `pagePath` in `lib/categories.js`.

A backup is read-only: only GET and `.../search` POST calls are used. The separate **Import** tool is the only part that writes to KBMax.

## Import (restore or AI-generated files)
**Import...** (next to *Create backup*) opens a tool that writes JSON files back to KBMax with a PUT. Currently supported: **Global functions** (update: `PUT /api/globalfunctions/{id}?waitForRefresh=false`, create: `POST /api/globalfunctions`) **Quote headers** (update: `PUT /api/quoteheaders/{id}?waitForRefresh=false`, create: `POST /api/quoteheaders?waitForRefresh=false`) and **Configurators (products)** (update: `PUT /api/admin/products/{id}?waitForRefresh=false`, create: `POST /api/admin/products?waitForRefresh=false`). A quote header or product can be 1 MB or more; test with an unchanged record on DEV first.

Creating a product or quote header is a single POST with the whole record, as the KBMax editor does it. The fields KBMax sets itself (`id`, created/modified dates and users) are left out, and `isDefault` is never sent for a quote header (the default header is a company setting). KBMax stores a new record in its own form (new `kbs_` block ids, empty `skip`/`take` lists, regenerated `js`); the read-back ignores that, so only real differences are reported. Names of products and quote headers do not have to be unique (the analysis only warns); global function names do.

KBMax stores whether a product is active inside `configurator.active` (absent means true) and takes the product's `active` from there. A file with `active: false` but without `configurator.active: false` is therefore created as an active product; the analysis warns about this.

The read-back after a write lists the fields KBMax stored differently, with the values (`active (false -> true)`). Ids, owners and dates that KBMax adds to the rows it stores, the `kbs_` ids inside rule blocks, empty defaults it adds and regenerated `js` are not counted as differences. The "Unknown field" warning compares against a merge of the first 8 existing records, because KBMax leaves empty fields (such as `sku`) out of a record.

KBMax validates a configurator only in its own editor, not on save: after importing a product or quote header, open it in KBMax and run its validation. Products are also protected by KBMax's edit lock: if someone has the product open in the editor (`GET /api/admin/products/{id}/isediting` is not empty) the analysis warns and *Apply* skips it.

Files use exactly the format of the backup: take a record from a backup (or from KBMax), let an AI or a person edit it, and import it. A file **with** an `id` overwrites that record; a file **without** an `id` creates a new one (KBMax assigns the id). [`examples/global-function-minimal.json`](examples/global-function-minimal.json) is the smallest valid new global function; give an AI that, plus a full exported global function, as examples. Pick the type, then JSON files or a backup ZIP (only the folder of that type is used).

1. **Analyse (dry run)** only reads. Each file is compared with the current record in KBMax: invalid JSON, missing fields (a PUT replaces the whole record), wrong data types, unknown fields, an `id` that does not exist, two files for one id, invalid `blocks` JSON, and `blocks` / `js` changing out of sync are reported before anything is sent.
2. **Apply** performs the records marked *create* and *update*; files with errors are skipped. Before each overwrite the current record is saved, and at the end a ZIP `KBMax_<ENV>_import_<time>.zip` is downloaded with the previous versions (same layout as a backup ZIP, so it can be imported again to undo) and `import-results.json` (which ids were created). Created records can only be removed in KBMax itself.
   - **Create** mirrors the KBMax editor: a POST with only `name`, `functionType`, `blocks` and `parameters`, followed by a PUT with the full content (`returnType`, `js`, ...). KBMax does not generate `js` itself; a file without `js` gives a function without compiled code until it is opened and saved in the editor (the analysis warns about this).
   - Checks for create: required fields, `functionType` one of `any, value, validation, naming, pricing, visibility, submit, button`, the name is not already in use (or used twice in the import), and the declaration inside `blocks` matches `name`, `functionType` and `parameters`.
3. Each written record is read back and compared. If the server stored something different (for example it regenerates `js`), the fields are listed in the log.

Safety: DEV needs no extra step; on TEST and PROD you must type the host name before *Apply* is enabled. Writes are never retried automatically. Records already written stay written if you cancel. `id`, `createdDate`, `modifiedDate`, `createdBy`, `modifiedBy`, `modifiedByName`, `references` and `dependencies` are not compared (the server maintains them).

Adding a type: give its entry in `lib/categories.js` a `write: { update: (id) => '<PUT url>' }` property.

## Access control
Backups and imports are only available to users with the **Company Administrator** role. The extension reads the logged-in user from the KBMax page (`serverVm.context.user`), refreshes the roles with a `users/search` lookup on the user's e-mail address (so a role change applies without reloading), and checks for role id `1`. Roles are matched on id, not name, so a custom role with the same name does not qualify.

- The popup shows who is signed in and disables *Create backup* and *Import...* with the reason; the backup and import pages check again and do nothing when access is denied; *Apply* in the import checks once more right before writing.
- It fails closed: if the user cannot be determined, access is denied (run **Diagnose access** on the Hosts tab if KBMax changes this).
- The allowed role ids are set in `lib/access.js` (`REQUIRED_ROLE_IDS`).
- This is a safeguard in the extension, not a security boundary: anyone can modify a local extension, and KBMax itself lets lower roles read most configuration through its API (it answers 403 for workflows, custom actions and quote outputs to a Junior). Real enforcement of writes stays with KBMax.

## What a full backup contains
Configurators (products), scenes, safe functions, tables, quote headers, workflows, custom actions, quote outputs, settings, global functions, global definitions, builders, price columns, generators, queues, roles, tags, themes, email templates, build types, layouts, currencies (company rates) and the product category tree. Optional (off by default): **Users** (personal data: names, e-mail addresses, phone numbers and addresses) and **Quotes** (large).

Deliberately not included: database logins, integration settings (they hold credentials), the database table schema (`/api/dbtables`, a live view of the connected external database rather than KBMax data), and platform-level channels and root users.

## Large backups (quotes)
The backup is streamed: every record is written straight into the ZIP and handed to the enabled uploads, then released from memory. The ZIP is built in a temporary file in the extension's private browser storage (on disk) and handed to the browser as a download at the end, so memory use stays low regardless of backup size. The ZIP supports more than 4 GB and 65,535 files (ZIP64).

- Free disk space of roughly the backup size is needed while the backup runs. The temporary file is removed when the next backup starts.
- Quotes can be very large and numerous. Prefer leaving **Quotes** out of backups that are uploaded to Git; repositories are not meant to hold many gigabytes (GitHub recommends keeping repositories small).
- A single KBMax record has to fit in memory (and in one extension message, about 64 MB).

## Uploads (Azure DevOps and GitHub)
The **Azure DevOps** and **GitHub** tabs store a destination per environment (organization/owner, repository, branch, folder path and token). Tick *Upload backups of this environment ...* to enable it, and use **Test connection** to verify the settings. Enabled destinations receive the backup instead of a local ZIP download (the ZIP is only downloaded when an upload fails).

- Each backup lands in its own folder `<folder path>/KBMax_<ENV>_<date>_<time>/...`; existing files are never changed or deleted.
- The target branch must already exist (the repository needs at least one commit). Use a dedicated branch when `main` is protected.
- Azure DevOps: authenticates with a PAT and pushes in batches via the Git pushes API. GitHub: authenticates with a fine-grained token and commits via the Git Data API. GitHub uploads are refused when the repository is public.
- Upload errors never affect the downloaded ZIP; they are shown in the status line and the log.
- Tokens are kept in this browser profile's extension storage (`chrome.storage.local`) and are only sent to `dev.azure.com` / `api.github.com`.

**Incremental sync (Azure DevOps and GitHub).** Set *Upload mode* on the Azure DevOps or GitHub tab to *Incremental sync* instead of creating a new timestamped folder per backup. All files go to one fixed folder `<folder path>/KBMax_<ENV>/` (for example `/backups/KBMax_DEV/products/334_Name.json`), and each backup pushes only what changed:
- Before uploading, the extension lists the files in that folder and compares the git blob hash (SHA-1) of every new file with the one the host returns (Azure DevOps: `GET .../items?recursionLevel=Full`, `objectId`; GitHub: the folder's git tree, `sha`), so unchanged files are not uploaded and nothing is downloaded. For GitHub a very large folder whose recursive listing is truncated is read folder by folder. The first backup uploads everything; later ones only new and changed files, in batches of at most 100 files / 6 MB, one commit per batch (`KBMax sync DEV: 2 new, 1 changed (part 1)`). Nothing changed = no commit. On GitHub the batches are chained and the branch is moved once at the end, so a failed run leaves the branch untouched.
- It works for full backups and for **Back up this record** (only that record is compared and pushed). Backups of a subset of categories leave the other folders untouched.
- A record renamed in KBMax gets a new file name (`<id>_<name>.json`); the old file with the same id is removed in the same commit, so the history shows a rename. Records deleted in KBMax are **not** removed from the repository.
- **modifiedDate rule.** KBMax can return slightly different text for the same record (for example values shown in the language of the user who is active), which would be reported as a change on every run. When a file differs from the stored one but its top-level `modifiedDate` is the same, it is treated as unchanged and not pushed. Only files that differ are downloaded for this check (Azure DevOps: `items?path=...&$format=text`; GitHub: the git blob). Files without a `modifiedDate` (settings, categories, ...) are compared on content; if the stored file cannot be read, the file is pushed. A change that does not update `modifiedDate` in KBMax is therefore not picked up; delete the file in the repository to force a refresh.
- Azure DevOps refuses a push above 25 MB. Batches therefore stay under about 12 MB of content (files are sent base64-encoded), and a file larger than 16 MB cannot be pushed at all: it is skipped with a `[skipped]` line in the log (shown as an error) and is not in the repository. Such a file is still in the local ZIP (Download ZIP).
- The log lists every pushed file as `[new]`, `[changed]` or `[removed]` with its path, followed by a summary line (`3 new, 1 changed, 0 removed, 615 unchanged`). The log window keeps the last 1000 lines.
- `backup-info.json` is only updated when something else changed, so there are no empty commits.
- Interrupted or failed? Run the backup again; the comparison simply continues where it stopped. The local ZIP (fallback or Download ZIP) is always a full backup, and *New timestamped folder* stays the default.

Setup guides:
- [Azure DevOps: create a Personal Access Token](docs/azure-devops-pat.md)
- [Azure DevOps: use a managed identity](docs/azure-devops-managed-identity.md) (needs an Azure-hosted relay; a browser extension cannot use a managed identity directly)
- [GitHub: create a fine-grained token](docs/github-fine-grained-token.md)

## Environments
The environment is detected from the host name, for any KBMax customer, without configuration:

| Host | Environment |
|---|---|
| `<customer>.kbmax.com` | PROD |
| `<customer>-test.kbmax.com` | TEST |
| `<customer>-dev.kbmax.com` | DEV |

Hosts that do not follow this pattern (for example a custom domain) can be mapped on the **Hosts** tab; the browser then asks for permission to access that host. See `lib/environments.js`.

Destination settings and the "last backup" list are stored per environment type (DEV / TEST / PROD), not per customer. If you back up several customers with one browser profile, use separate profiles.

The extension requests access to `https://*.kbmax.com/*` (all KBMax tenants), `dev.azure.com` and `api.github.com`; other hosts are only requested when you add them on the **Hosts** tab.

## Knowledge about the KBMax API
Everything learned about KBMax's internal API (endpoints, write recipes, pitfalls) is written up as a reusable skill in [`skills/kbmax-internal-api/`](skills/kbmax-internal-api/SKILL.md). Copy that folder to `.claude/skills/` (project) or `~/.claude/skills/` (personal) to let Claude Code use it, or read it as plain documentation.

## Structure
- `lib/categories.js` - which KBMax resources are fetched (add or adjust endpoints here).
- `lib/kbmaxApi.js` - fetch via the KBMax tab, pagination, retries.
- `lib/backup.js` - orchestration. `lib/zip.js` - dependency-free streaming ZIP/ZIP64 writer, `lib/zip-sink.js` - where the ZIP is written (disk-backed, in-memory fallback).
- `lib/destinations-local.js` - local download. `lib/destinations-azure.js`, `lib/destinations-github.js` - uploads (registry in `lib/destinations.js`, shared HTTP helpers in `lib/upload-utils.js`).
- `lib/settings.js` - per-environment destination settings.
- `import.html` / `import.js` - import tool UI. `lib/importer.js` - dry-run analysis and guarded writes. `lib/zip-reader.js` - reads backup ZIPs (incl. ZIP64).
- `theme.css` - colours (all in the `:root` block). `boot.js` - shows an error banner when the extension script fails to start.

## Open points
- Uploads are tested against mocked APIs only, not yet against a real Azure DevOps organization or GitHub repository. Azure DevOps organizations on the legacy `*.visualstudio.com` URL are not supported.
- Endpoints for quote headers, workflows, custom actions, quote outputs and safe functions, and the "get by id" paths, were derived from the KBMax admin screens and are not yet validated against a live environment; on 404/405 the search result is kept.

## License
MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Robert van Oorschot.
