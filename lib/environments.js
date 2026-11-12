export const ENVIRONMENTS = {
  dev: { key: 'dev', label: 'Development', short: 'DEV' },
  test: { key: 'test', label: 'Test', short: 'TEST' },
  prod: { key: 'prod', label: 'Production', short: 'PROD' },
};

// KBMax hosts follow <customer>.kbmax.com (production), <customer>-test.kbmax.com and
// <customer>-dev.kbmax.com, so any customer is recognised without configuration.
// Hosts that do not follow this pattern can be mapped manually (`overrides`: [{ host, env }]).
const KBMAX_HOST = /^([a-z0-9][a-z0-9-]*?)(?:-(dev|test))?\.kbmax\.com$/;
const NOT_A_TENANT = new Set(['www']);

export function detectEnvironment(url, overrides = []) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.toLowerCase();
  const override = overrides.find((o) => o.host === host && ENVIRONMENTS[o.env]);
  let key;
  let customer = host;

  if (override) {
    key = override.env;
  } else {
    const match = KBMAX_HOST.exec(host);
    if (!match || NOT_A_TENANT.has(match[1])) return null;
    key = match[2] ?? 'prod';
    customer = match[1];
  }

  return { ...ENVIRONMENTS[key], host, customer, baseUrl: parsed.origin };
}

export function hostPatterns(overrides = []) {
  return ['https://*.kbmax.com/*', ...overrides.map((o) => `https://${o.host}/*`)];
}

export function isValidHost(host) {
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) && host.includes('.');
}
