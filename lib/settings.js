const extensionApi = globalThis.browser ?? globalThis.chrome;

// Upload destinations. Settings are stored per environment (dev / test / prod).
// `enabled` (stored with the values) controls whether a backup is uploaded after it is created.
export const DESTINATIONS = {
  azureDevOps: {
    label: 'Azure DevOps',
    guides: ['docs/azure-devops-pat.md', 'docs/azure-devops-managed-identity.md'],
    tokenLabel: 'Personal access token (scope: Code - Read & write)',
    fields: [
      { key: 'organization', label: 'Organization', placeholder: 'my-organization' },
      { key: 'project', label: 'Project', placeholder: 'my-project' },
      { key: 'repository', label: 'Repository', placeholder: 'kbmax-backups' },
      { key: 'branch', label: 'Branch', placeholder: 'main' },
      { key: 'path', label: 'Folder path', placeholder: '/backups' },
      {
        key: 'mode',
        label: 'Upload mode',
        choices: [
          ['folder', 'New timestamped folder per backup (full copy)'],
          ['sync', 'Incremental sync (only new and changed files)'],
        ],
        hint: 'Incremental sync keeps one folder KBMax_<ENV> in the folder path and pushes only files that are new or changed, so the repository history shows what changed. Records deleted in KBMax stay in the repository.',
      },
    ],
  },
  github: {
    label: 'GitHub',
    guides: ['docs/github-fine-grained-token.md'],
    tokenLabel: 'Fine-grained token (permission: Contents - Read & write)',
    fields: [
      { key: 'owner', label: 'Owner (user or organization)', placeholder: 'my-organization' },
      { key: 'repository', label: 'Private repository', placeholder: 'kbmax-backups' },
      { key: 'branch', label: 'Branch', placeholder: 'main' },
      { key: 'path', label: 'Folder path', placeholder: '/backups' },
      {
        key: 'mode',
        label: 'Upload mode',
        choices: [
          ['folder', 'New timestamped folder per backup (full copy)'],
          ['sync', 'Incremental sync (only new and changed files)'],
        ],
        hint: 'Incremental sync keeps one folder KBMax_<ENV> in the folder path and pushes only files that are new or changed, so the repository history shows what changed. Records deleted in KBMax stay in the repository.',
      },
    ],
  },
};

export async function loadDestinationSettings(destination, envKey) {
  const stored = await extensionApi.storage.local.get(['destinationSettings', 'destinationTokens']);
  return {
    values: stored.destinationSettings?.[destination]?.[envKey] ?? {},
    hasToken: Boolean(stored.destinationTokens?.[destination]?.[envKey]),
  };
}

// token === '' keeps the stored token; pass clearToken to remove it.
export async function saveDestinationSettings(destination, envKey, values, { token = '', clearToken = false } = {}) {
  const stored = await extensionApi.storage.local.get(['destinationSettings', 'destinationTokens']);
  const settings = stored.destinationSettings ?? {};
  const tokens = stored.destinationTokens ?? {};

  settings[destination] = { ...settings[destination], [envKey]: values };
  tokens[destination] = { ...tokens[destination] };
  if (clearToken) delete tokens[destination][envKey];
  else if (token) tokens[destination][envKey] = token;

  await extensionApi.storage.local.set({ destinationSettings: settings, destinationTokens: tokens });
}

export async function getDestinationToken(destination, envKey) {
  const { destinationTokens } = await extensionApi.storage.local.get('destinationTokens');
  return destinationTokens?.[destination]?.[envKey] ?? '';
}

// Destinations that should receive the backup of this environment.
export async function loadEnabledDestinations(envKey) {
  const stored = await extensionApi.storage.local.get(['destinationSettings', 'destinationTokens']);
  return Object.keys(DESTINATIONS)
    .map((key) => ({
      key,
      label: DESTINATIONS[key].label,
      values: stored.destinationSettings?.[key]?.[envKey] ?? {},
      token: stored.destinationTokens?.[key]?.[envKey] ?? '',
    }))
    .filter((destination) => destination.values.enabled === true);
}

// Custom host -> environment mappings for KBMax hosts that do not follow <customer>[-dev|-test].kbmax.com.
export async function loadEnvironmentOverrides() {
  const { environmentOverrides } = await extensionApi.storage.local.get('environmentOverrides');
  return Array.isArray(environmentOverrides) ? environmentOverrides : [];
}

export async function saveEnvironmentOverrides(overrides) {
  await extensionApi.storage.local.set({ environmentOverrides: overrides });
}
