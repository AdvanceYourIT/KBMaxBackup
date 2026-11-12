// Endpoints are the ones the KBMax admin screens call (see skills/kbmax-internal-api/references/endpoints.md).
// searchApi: POST with { fields, sortField, skip, take } -> array of records.
// getApi: GET for the full record; on 404/405 the search result is kept instead.
// activeInConfigurator = the record's "active" must agree with configurator.active (the latter wins);
// write enables Import for the type: update(id) -> PUT url; create -> POST url. Either createFields = the
// only fields the UI posts when creating (all required; the rest is saved with a PUT afterwards), or
// createOmit = the fields left out of a POST that carries the whole record (required = fields that must
// be present); uniqueName = a duplicate name is an error instead of a warning;
// allowed = enumerations the UI offers; editLock(id) = GET url listing the sessions editing a record
// (an import is refused while someone is editing); note = hint shown before applying.
// listGet(page) = list with a GET instead of a search (an array, or { items, totalCount } followed by page).
// pagePath = the KBMax page of one record (/<pagePath>/<id>), used to back up the record on screen;
// recordApi = GET url of one record for types without getApi (the search already returns full records,
// so a full backup does not call it; if it 404s the record is taken from the search list).
// Optional: sortField (default 'id'); searchFields (exact `fields` to request, no fallback; [] or null
// = all fields); getApi omitted = the search result is already the full record; single = one settings
// object fetched with a GET and saved as `file`.
export const CATEGORIES = [
  { key: 'products', pagePath: 'admin/configurators', label: 'Configurators (products)', folder: 'products', searchApi: '/api/admin/products/search', getApi: (id) => `/api/admin/products/${id}`, defaultOn: true,
    write: {
      update: (id) => `/api/admin/products/${id}?waitForRefresh=false`,
      // The editor creates a product with one POST holding the whole record (no id, no server-set fields).
      create: '/api/admin/products?waitForRefresh=false',
      createOmit: ['id', 'createdDate', 'modifiedDate', 'createdBy', 'modifiedBy', 'modifiedByName'],
      required: ['name', 'configurator'],
      // KBMax stores "active" inside the configurator (absent = true) and derives the product's flag from it.
      activeInConfigurator: true,
      // Advisory edit lock of the KBMax editor: GET returns the sessions currently editing ([] = none).
      editLock: (id) => `/api/admin/products/${id}/isediting`,
      note: 'KBMax only validates a configurator in its own editor. After importing, open the product in KBMax and run its validation.',
    } },
  { key: 'scenes', pagePath: 'admin/scenes', label: 'Scenes', folder: 'scenes', searchApi: '/api/scenes/search', getApi: (id) => `/api/scenes/${id}`, defaultOn: true },
  { key: 'safeFunctions', pagePath: 'admin/safe-functions', label: 'Safe functions', folder: 'safe-functions', searchApi: '/api/functions/search', getApi: (id) => `/api/functions/${id}`, defaultOn: true },
  { key: 'tables', pagePath: 'admin/tables', label: 'Tables', folder: 'tables', searchApi: '/api/tables/search', getApi: (id) => `/api/tables/${id}`, defaultOn: true },
  { key: 'quoteHeaders', pagePath: 'admin/quote-headers', label: 'Quote headers', folder: 'quote-headers', searchApi: '/api/quoteheaders/search', getApi: (id) => `/api/quoteheaders/${id}`, defaultOn: true,
    write: {
      update: (id) => `/api/quoteheaders/${id}?waitForRefresh=false`,
      // One POST with the whole record. isDefault is never sent: the default header is a company setting.
      create: '/api/quoteheaders?waitForRefresh=false',
      createOmit: ['id', 'createdDate', 'modifiedDate', 'createdBy', 'modifiedBy', 'modifiedByName', 'isDefault'],
      required: ['name', 'configurator'],
      note: 'KBMax only validates a configurator in its own editor. After importing, open the quote header in KBMax and run its validation.',
    } },
  { key: 'workflows', pagePath: 'admin/workflows', label: 'Workflows', folder: 'workflows', searchApi: '/api/workflows/search', getApi: (id) => `/api/workflows/${id}`, defaultOn: true },
  { key: 'customActions', pagePath: 'admin/custom-actions', label: 'Custom actions', folder: 'custom-actions', searchApi: '/api/customactions/search', getApi: (id) => `/api/customactions/${id}`, defaultOn: true },
  { key: 'quoteOutputs', pagePath: 'admin/quote-outputs', label: 'Quote outputs', folder: 'quote-outputs', searchApi: '/api/quoteoutputs/search', getApi: (id) => `/api/quoteoutputs/${id}`, defaultOn: true },
  { key: 'settings', label: 'Settings', single: '/api/settings', file: 'settings.json', defaultOn: true },
  { key: 'globalFunctions', pagePath: 'admin/global-functions', label: 'Global functions', folder: 'global-functions', searchApi: '/api/globalfunctions/search', getApi: (id) => `/api/globalfunctions/${id}`, sortField: 'name', defaultOn: true,
    write: {
      update: (id) => `/api/globalfunctions/${id}?waitForRefresh=false`,
      // The UI creates with only these fields, then saves the full record with a PUT.
      create: '/api/globalfunctions',
      uniqueName: true,
      createFields: ['name', 'functionType', 'blocks', 'parameters'],
      allowed: { functionType: ['any', 'value', 'validation', 'naming', 'pricing', 'visibility', 'submit', 'button'] },
    } },
  { key: 'globalDefinitions', pagePath: 'admin/global-definitions', recordApi: (id) => `/api/globaldefinitions/${id}`, label: 'Global definitions', folder: 'global-definitions', searchApi: '/api/globaldefinitions/search', searchFields: null, sortField: 'name', defaultOn: true },
  { key: 'builders', pagePath: 'admin/builders', recordApi: (id) => `/api/builders/${id}`, label: 'Builders', folder: 'builders', searchApi: '/api/builders/search', searchFields: [], sortField: 'name', defaultOn: true },
  { key: 'priceColumns', label: 'Price columns', folder: 'price-columns', pagePath: 'admin/price-columns', recordApi: (id) => `/api/pricecolumns/${id}`, searchApi: '/api/pricecolumns/search', searchFields: null, sortField: 'name', defaultOn: true },
  { key: 'generators', label: 'Generators', folder: 'generators', pagePath: 'admin/generators', recordApi: (id) => `/api/generators/${id}`, searchApi: '/api/generators/search', searchFields: null, sortField: 'name', defaultOn: true },
  { key: 'queues', label: 'Queues', folder: 'queues', pagePath: 'admin/queues', recordApi: (id) => `/api/queues/${id}`, searchApi: '/api/queues/search', searchFields: null, sortField: 'name', defaultOn: true },
  { key: 'roles', label: 'Roles', folder: 'roles', pagePath: 'admin/roles', searchApi: '/api/roles/search', searchFields: null, sortField: 'role', getApi: (id) => `/api/roles/${id}`, defaultOn: true },
  { key: 'tags', label: 'Tags', folder: 'tags', searchApi: '/api/tags/search', searchFields: null, sortField: 'name', defaultOn: true },
  { key: 'themes', label: 'Themes', folder: 'themes', pagePath: 'admin/themes', searchApi: '/api/themes/search', searchFields: null, sortField: 'name', getApi: (id) => `/api/themes/${id}`, defaultOn: true },
  { key: 'emailTemplates', label: 'Email templates', folder: 'email-templates', pagePath: 'admin/email-templates', searchApi: '/api/emailtemplates/search', searchFields: null, sortField: 'name', getApi: (id) => `/api/emailtemplates/${id}`, defaultOn: true },
  { key: 'buildTypes', label: 'Build types', folder: 'build-types', pagePath: 'admin/build-types', listGet: (page) => `/api/buildtypes?page=${page}&pageSize=1000`, recordApi: (id) => `/api/buildtypes/${id}`, defaultOn: true },
  { key: 'layouts', label: 'Layouts', folder: 'layouts', pagePath: 'admin/layouts', listGet: () => '/api/layouts/selections', getApi: (id) => `/api/layouts/${id}`, defaultOn: true },
  { key: 'currencies', label: 'Currencies (company rates)', folder: 'currencies', listGet: () => '/api/currencies/companyoptions', defaultOn: true },
  { key: 'categories', label: 'Product categories (tree)', single: '/api/categories/tree?onlyActiveCategories=false', file: 'categories.json', defaultOn: true },
  { key: 'users', label: 'Users (personal data)', folder: 'users', searchApi: '/api/users/search', searchFields: [], defaultOn: false },
  { key: 'quotes', pagePath: 'quotes', label: 'Quotes (data, can be large)', folder: 'quotes', searchApi: '/api/quotes/search', getApi: (id) => `/api/quotes/${id}`, defaultOn: false },
];
