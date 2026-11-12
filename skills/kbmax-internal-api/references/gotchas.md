# Gotchas

## `active` lives in the configurator
KBMax stores whether a product is active in `configurator.active` (**absent = true**) and derives the product's top-level `active` from it. Creating a product with `active: false` at the top level but no `configurator.active: false` produces an **active** product. Always set both. (Learned the hard way: a test product went live on DEV.)

## The server stores a lean configurator, the editor sends an expanded one
After a write KBMax re-serialises the configurator. When you read it back, expect these differences that are **not** data loss:
- every `kbs_xxxxxxxx` block id inside rule `blocks` is replaced by a new one (hundreds of "changes");
- `blocks` is a JSON *string*; its formatting changes, so compare it parsed;
- empty defaults appear (`"skip": []`, `"take": []`) and records omit empty fields (an unset `sku` may simply be absent, so a field is not "unknown" because one sample record lacks it - merge several records to learn the field set);
- `js` of rule containers is regenerated (whitespace-only differences);
- `idProduct`, row ids, owners and dates are added to the configurator and child rows;
- `references` and `dependencies` are computed (`dependencies` can go from 0 to dozens).
Compare after removing those; what remains is real (for example `active`).

## No validation on save
The API accepts invalid configurators. KBMax validates only in its editor. Always tell the user to open an imported product/quote header and run the validation.

## `references` and `dependencies` are client-side
Do not try to maintain them; the server (or the next editor save) recomputes them.

## Edit lock
`GET /api/admin/products/{id}/isediting` is advisory. Refuse to overwrite while it lists sessions.

## SPA fallback
A wrong path answers `200` + HTML. Treat "not JSON" as "endpoint does not exist" and classify responses (JSON / HTML / error) in diagnostics.

## Search `fields`
`fields` null/`[]` returns the full record. When only names are wanted, ask for `['id','name']` and fall back to `['id']` if the type answers 400. Search results of several types are already complete records, so a separate GET per record can be skipped (and doubles the load).

## Large data
Quotes can be huge and numerous. Stream the output (write each record to a ZIP in OPFS, upload in batches); building one big object in memory crashes the extension. Use ZIP64 above 4 GB / 65,535 files.

## Scope of what a configurator contains
A product record holds rules, pages, build outputs, option filters and child rows, but **not** the data it relies on: tables, safe functions, global functions/definitions, scenes and builders are separate records referenced by id. Copying or scaling a product ("make a version that is 5x bigger") needs those records too; dimensions typically live in tables.

## Browser/extension notes
- Run fetches via `chrome.scripting.executeScript` in the KBMax tab (cookie session). Reading `window.serverVm` needs `world: 'MAIN'`.
- Request the host permission for `https://*.kbmax.com/*`; other custom hosts via optional permissions.
- An incomplete or outdated installed copy fails silently on a missing module; show an error banner (`boot.js`) and tell users to reload the extension in `edge://extensions`.
- A managed identity cannot be used directly from a browser extension (needs an Azure-hosted relay); use a PAT or fine-grained token for uploads.
