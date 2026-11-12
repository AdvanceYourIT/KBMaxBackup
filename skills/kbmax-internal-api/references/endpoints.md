# Endpoints

All paths are relative to `https://<tenant>.kbmax.com`. "Search" = `POST` with the search body from SKILL.md. "Page" is the admin page of one record (`/<page>/<id>`); KBMax builds page URLs from the type name as the kebab-case plural, so an unlisted type probably follows the same pattern.

| Resource | List | Single record | Page | Status |
|---|---|---|---|---|
| Products (configurators) | search `/api/admin/products/search` | `GET /api/admin/products/{id}` | `/admin/configurators/{id}` | verified |
| Scenes | search `/api/scenes/search` | `GET /api/scenes/{id}` | `/admin/scenes/{id}` | assumed |
| Safe functions | search `/api/functions/search` | `GET /api/functions/{id}` | `/admin/safe-functions/{id}` | assumed |
| Tables | search `/api/tables/search` | `GET /api/tables/{id}` | `/admin/tables/{id}` | assumed (old KBMax Tools also used `POST /api/tables?waitForRefresh=false`, `PUT /api/tables/{id}`) |
| Quote headers | search `/api/quoteheaders/search` | `GET /api/quoteheaders/{id}` | `/admin/quote-headers/{id}` | verified |
| Workflows | search `/api/workflows/search` | `GET /api/workflows/{id}` | `/admin/workflows/{id}` | assumed; 403 for Junior |
| Custom actions | search `/api/customactions/search` | `GET /api/customactions/{id}` | `/admin/custom-actions/{id}` | assumed; 403 for Junior |
| Quote outputs | search `/api/quoteoutputs/search` | `GET /api/quoteoutputs/{id}` | `/admin/quote-outputs/{id}` | assumed; 403 for Junior |
| Settings | `GET /api/settings` (one object) | - | - | verified (also a cheap "is the session alive" check) |
| Global functions | search `/api/globalfunctions/search` (sortField `name`) | `GET /api/globalfunctions/{id}` | `/admin/global-functions/{id}` | verified |
| Global definitions | search `/api/globaldefinitions/search` (`fields: null`) | search result is the full record | `/admin/global-definitions/{id}` | list verified |
| Builders | search `/api/builders/search` (`fields: []`) | search result is the full record | `/admin/builders/{id}` | list verified |
| Price columns | search `/api/pricecolumns/search` | search result | `/admin/price-columns/{id}` | assumed |
| Generators | search `/api/generators/search` | search result | `/admin/generators/{id}` | assumed |
| Queues | search `/api/queues/search` | search result | `/admin/queues/{id}` | assumed |
| Roles | search `/api/roles/search` (sortField `role`) | `GET /api/roles/{id}` | `/admin/roles/{id}` | assumed |
| Tags | search `/api/tags/search` | - | - | assumed |
| Themes | search `/api/themes/search` | `GET /api/themes/{id}` | `/admin/themes/{id}` | assumed |
| Email templates | search `/api/emailtemplates/search` | `GET /api/emailtemplates/{id}` | `/admin/email-templates/{id}` | assumed |
| Build types | `GET /api/buildtypes?page=0&pageSize=1000` (array or `{items,totalCount}`) | `GET /api/buildtypes/{id}` | `/admin/build-types/{id}` | assumed |
| Layouts | `GET /api/layouts/selections` | `GET /api/layouts/{id}` | `/admin/layouts/{id}` | assumed |
| Currencies | `GET /api/currencies/companyoptions` | - | - | assumed |
| Product category tree | `GET /api/categories/tree?onlyActiveCategories=false` | - | - | assumed |
| Users | search `/api/users/search` (`fields: []`; also takes `query`, `filters`, `nestedPath`, `nestedFields`) | - | - | verified |
| Quotes | search `/api/quotes/search` | `GET /api/quotes/{id}` | `/quotes/{id}` | assumed; can be huge |

Other calls:
- Edit lock of a product: `GET /api/admin/products/{id}/isediting` returns the sessions editing it (`[]` = free).
- Logged-in user: not an API call; `window.serverVm.context.user` in the page (MAIN world) has `id`, `email`, `roles[]`.

"Assumed" rows: run a backup of that type on DEV and check that records come back with full content (not just `id`/`name`); the backup extension warns when a detail endpoint answers 404/405.
