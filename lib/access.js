import { requestJson } from './kbmaxApi.js';

const extensionApi = globalThis.browser ?? globalThis.chrome;

// A user needs at least one of these roles to back up or import. 1 = the built-in
// "Company Administrator". Roles are matched on id (not name): a custom role can share a name.
export const REQUIRED_ROLE_IDS = [1];
export const REQUIRED_ROLE_LABEL = 'Company Administrator';

// Runs in the KBMax page's own JavaScript world. KBMax embeds the logged-in user in the page
// (serverVm.context.user); this returns plain data only.
function readLoggedInUser() {
  const user = globalThis.serverVm?.context?.user;
  if (!user || typeof user !== 'object') return null;
  return {
    id: user.id ?? null,
    email: user.email ?? null,
    displayName: user.displayName || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'Unknown user',
    roles: (Array.isArray(user.roles) ? user.roles : []).map((role) => ({ id: role.id, role: role.role, systemRole: role.systemRole })),
  };
}

function hasRequiredRole(roles) {
  return roles.some((role) => REQUIRED_ROLE_IDS.includes(role.id) && role.systemRole !== false);
}

// The page was loaded some time ago; ask KBMax for the user's current roles so a role change takes
// effect without reloading. Returns null when the user cannot be found (then the page's roles count).
async function lookupCurrentRoles({ tabId, baseUrl, user }) {
  if (!user.email) return null;
  try {
    const list = await requestJson({
      tabId,
      url: `${baseUrl}/api/users/search`,
      method: 'POST',
      payload: { fields: [], sortField: 'id', descending: false, skip: 0, take: 25, query: user.email, filters: [], nestedPath: null, nestedFields: [] },
      maxAttempts: 1,
    });
    const match = (Array.isArray(list) ? list : []).find((candidate) => String(candidate.email ?? '').toLowerCase() === user.email.toLowerCase());
    return match && Array.isArray(match.roles) ? match.roles.map((role) => ({ id: role.id, role: role.role, systemRole: role.systemRole })) : null;
  } catch {
    return null;
  }
}

// Result: { allowed, reason, user: { displayName, email } | null, roles: [names], source }.
// Fails closed: if the user cannot be determined, access is denied.
export async function checkAccess({ tabId, baseUrl }) {
  let user;
  try {
    const [{ result }] = await extensionApi.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readLoggedInUser });
    user = result;
  } catch (error) {
    return { allowed: false, user: null, roles: [], source: 'none', reason: `Could not read the logged-in user from the KBMax tab: ${error.message}` };
  }

  if (!user) {
    return { allowed: false, user: null, roles: [], source: 'none', reason: 'Could not determine the logged-in user. Log in to KBMax and reload the page; if this keeps happening KBMax may have changed (run Diagnose access).' };
  }

  const current = await lookupCurrentRoles({ tabId, baseUrl, user });
  const roles = current ?? user.roles;
  const allowed = hasRequiredRole(roles);
  const names = roles.filter((role) => role.role).map((role) => `${role.role}${role.systemRole === false ? ' (custom role)' : ''}`);

  return {
    allowed,
    user: { displayName: user.displayName, email: user.email },
    roles: names,
    source: current ? 'users/search' : 'page',
    reason: allowed
      ? ''
      : `Access denied: ${user.displayName} has ${names.length > 0 ? `the role ${names.join(', ')}` : 'no role'}. The role "${REQUIRED_ROLE_LABEL}" is required to back up or import.`,
  };
}
