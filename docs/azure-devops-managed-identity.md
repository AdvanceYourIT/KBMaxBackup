# Azure DevOps: use a managed identity for uploads

A managed identity removes the need for a PAT: Microsoft Entra ID issues short-lived tokens and handles rotation.

## Important limitation
A managed identity can only obtain tokens from code **running on an Azure resource** (Function App, Logic App, Automation account, VM, container, ...). A browser extension runs on a user's PC and can **not** use a managed identity directly. To use one, the upload must be done by a small Azure-hosted component, and the extension hands the backup to it:

```
KBMax Backup extension --(ZIP/JSON over HTTPS)--> Azure Function (managed identity) --(Bearer token)--> Azure DevOps Git
```

This relay is not built yet. The steps below prepare the identity and the Azure DevOps side; the extension currently uploads with a [PAT](azure-devops-pat.md).

## 1. Create the managed identity
1. Azure portal > **Managed Identities** > **Create**.
2. Choose subscription, resource group and region. Name it e.g. `id-kbmax-backup`.
3. **Review + create**. Note the **Client ID** and **Object (principal) ID** on the overview page.

A user-assigned identity is recommended: it is reusable and survives redeployment of the resource. (A system-assigned identity on the Function App also works; its name equals the app name.)

## 2. Add the identity to Azure DevOps
Requirements: the organization is connected to the same Microsoft Entra tenant, and you are a Project Collection Administrator.
1. Azure DevOps > **Organization settings** > **Users** > **Add users**.
2. Enter the identity's name (or object ID), set **Access level** to **Basic**, select the project and add it to the **Contributors** group (or a custom group with *Contribute* on the backup repository).
3. **Add**. The identity now appears in the user list and can be managed like a user.

If pushes go to a branch with branch policies, use a dedicated backup branch or give the identity *Bypass policies when pushing* only on that repository.

## 3. Run the upload component as that identity
1. Create the Azure Function App (or Logic App) and, under **Identity > User assigned**, attach `id-kbmax-backup`.
2. Acquire a token for Azure DevOps. The Azure DevOps resource ID is `499b84ac-1321-427f-aa17-267ca6975798`:

```js
// Node.js, @azure/identity
const { ManagedIdentityCredential } = require('@azure/identity');
const credential = new ManagedIdentityCredential('<client-id-of-id-kbmax-backup>');
const { token } = await credential.getToken('499b84ac-1321-427f-aa17-267ca6975798/.default');
// Use it as: Authorization: Bearer <token>
```

3. Push the files with the Azure DevOps Git REST API (`POST https://dev.azure.com/<org>/<project>/_apis/git/repositories/<repo>/pushes?api-version=7.1`) using that Bearer token.
4. Protect the function itself (Function App > **Authentication**, Entra ID) so only your users can call it.

## Test the identity without the extension
On an Azure VM or Cloud Shell with the identity attached:
```
az login --identity --username <client-id>
az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798
```
A token is returned when the identity is set up correctly; a 401/203 from Azure DevOps later usually means the identity has not been added under **Organization settings > Users** yet.

## Sources
- Microsoft Learn: [Use service principals and managed identities in Azure DevOps](https://learn.microsoft.com/azure/devops/integrate/get-started/authentication/service-principal-managed-identity)
