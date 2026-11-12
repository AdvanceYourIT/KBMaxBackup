# Write recipes

All verified against HAR captures of the KBMax editor and tested on a DEV environment. Always send `Content-Type: application/json`, and use `?waitForRefresh=false` where shown (that is what the UI does).

## Global functions
- **Update:** `PUT /api/globalfunctions/{id}?waitForRefresh=false` with the full record (a PUT replaces everything: a file with missing fields loses them).
- **Create** mirrors the UI in two steps:
  1. `POST /api/globalfunctions` with only `{ name, functionType, blocks, parameters }` -> returns the new record with an id.
  2. `PUT /api/globalfunctions/{id}?waitForRefresh=false` with the full content (`returnType`, `js`, ...).
- `name` must be unique (a duplicate is an error). `functionType` is one of `any, value, validation, naming, pricing, visibility, submit, button`.
- `blocks` is a **JSON string** (the visual editor's block tree) whose `DeclareGlobalFunctionBlock` must agree with `name`, `functionType` and `parameters`.
- KBMax does **not** generate `js` or `returnType` on create. A record without `js` has no compiled code until someone opens and saves it in the editor. Supply `js` yourself when you generate a function.
- Smallest valid new function: `examples/global-function-minimal.json`.

## Quote headers
- **Update:** `PUT /api/quoteheaders/{id}?waitForRefresh=false`.
- **Create:** one `POST /api/quoteheaders?waitForRefresh=false` with the whole record, without `id`, `createdDate`, `modifiedDate`, `createdBy`, `modifiedBy`, `modifiedByName` and **never `isDefault`** (the default header is a company setting).
- Required: `name`, `configurator`. Names need not be unique.
- Can be 1 MB or more.

## Products (configurators)
- **Update:** `PUT /api/admin/products/{id}?waitForRefresh=false`.
- **Create:** one `POST /api/admin/products?waitForRefresh=false` with the whole record, without `id` and the created/modified fields. Required: `name`, `configurator`. Child rows (`images`, `templates`, `translations`, `attributes`, `categories`, `volumeDiscounts`) go in the same body; KBMax gives them their own ids and `idProduct`.
- **Set `configurator.active`** (see gotchas) - `active: false` at the top level alone does nothing.
- Check the edit lock first (`GET /api/admin/products/{id}/isediting`) and refuse to overwrite a product somebody has open.
- Products are 1 MB+; the extension message limit is about 64 MB per record.

## Safety pattern that worked
1. **Dry run** (read-only): invalid JSON, duplicate ids, id not found, missing fields (for PUT), wrong data types vs a real record, unknown fields, name collisions, `blocks`/`js` out of sync, `active` mismatch, edit lock.
2. **Snapshot** the current record of every update before sending (save as a ZIP in the same layout as a backup so it can be imported again to undo).
3. **One attempt**, no automatic retry. Stop that record on failure.
4. **Read back** with `GET` and compare. Report real differences only (gotchas explains the noise to ignore).
5. TEST/PROD: require typing the host name before the apply button is enabled.
6. Created records can only be removed in KBMax itself: log the new ids.
