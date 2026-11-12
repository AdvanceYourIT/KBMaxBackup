---
name: kbmax-internal-api
description: How to read and write Epicor CPQ (KBMax) configuration through its internal web API - search/get/PUT/POST of products (configurators), quote headers, global functions, tables, builders and more, from the logged-in browser tab. Use when building tools, extensions or scripts that back up, restore, import or generate KBMax records, when you need the endpoint for a KBMax admin page, or when an import behaves unexpectedly (active flag, stripped defaults, edit lock, role checks).
---

# KBMax internal API

Knowledge gathered while building the KBMax Backup extension (this repository) against real DEV/TEST environments. The API is **internal and undocumented**: it is what the KBMax admin UI itself calls. It can change without notice, so verify an endpoint on DEV before relying on it, and prefer the official KBMax SDK/webhooks for anything customer-facing.

Status labels used below: **verified** = seen in a real HAR capture or tested on a live environment; **assumed** = taken from the old KBMax Tools source or inferred, not yet confirmed live.

## Core rules
1. **Authentication is the browser session.** There are no API tokens. Call `fetch(url, { credentials: 'include' })` from inside a logged-in KBMax tab (a browser extension does this with `chrome.scripting.executeScript` in the tab; no credentials are ever stored). From outside the tab the calls fail.
2. **Base URL** is the tenant host, `https://<customer>[-dev|-test].kbmax.com`. Environment can be derived from the host name: no suffix = PROD, `-test` = TEST, `-dev` = DEV.
3. **Unknown `/api/...` paths return `200` with an HTML page** (SPA fallback), not 404. Always check that the body is JSON before trusting a "success". A real missing record gives 404/405.
4. **Lists** are `POST /api/<type>/search` with `{ query, fields, sortField, descending, skip, take }`. `fields: null` or `[]` returns full records; a list of names returns only those. Page with `skip`/`take` (500 works). Single records are `GET /api/<type>/{id}`.
5. **Writes** are `PUT /api/<type>/{id}?waitForRefresh=false` (update, replaces the whole record) and `POST /api/<type>?...` (create). Never retry a write automatically.
6. **The server is the authority on derived data.** Do not compare or send `references`, `dependencies`, ids, owners or dates; KBMax computes them.
7. **Permissions:** almost every read works for any logged-in role; the exceptions seen are workflows, custom actions and quote outputs (403 for a Junior role). Gate destructive tooling yourself, e.g. require role id `1` (Company Administrator): the logged-in user is in `window.serverVm.context.user` (read it in the page's MAIN world), and `POST /api/users/search` with the user's e-mail returns current roles. Match roles on **id**, not name.

## Where to look
- [references/endpoints.md](references/endpoints.md) - endpoint table per resource, page URLs, what is verified.
- [references/write-recipes.md](references/write-recipes.md) - exact create/update flows for global functions, quote headers and products, plus the dry-run/read-back safety pattern.
- [references/gotchas.md](references/gotchas.md) - behaviours that cost time: `active` lives in the configurator, lean storage and read-back noise, `kbs_` ids, missing `js`, edit lock, no validation on save, large records.

## Recommended workflow for a new tool
1. Capture the call you need in the browser dev tools (Network, filter Fetch/XHR, *Save as HAR*). Copy the **request body** and the **response**; the UI's own call is the specification.
2. Read first: fetch a real record and look at its shape before generating one. Give an AI that record as an example.
3. Dry-run: compare the file with the current record (types, missing fields, unknown fields, duplicate names, ids that do not exist) before sending anything.
4. Snapshot the current record before every overwrite, write once, read back and compare, and report only real differences (see gotchas for what is noise).
5. Try on DEV; on TEST/PROD make the user type the host name to confirm.
6. After importing a configurator, open it in KBMax and run its validation: the API accepts invalid configurators.
