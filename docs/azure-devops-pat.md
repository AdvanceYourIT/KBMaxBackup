# Azure DevOps: create a Personal Access Token (PAT)

A PAT is the simplest way to let KBMax Backup upload to an Azure DevOps Git repository. It acts as the user who creates it, so use a dedicated service account where possible.

## Prerequisites
- An Azure DevOps organization and project with a Git repository for the backups (e.g. `kbmax-backups`). The repository needs at least one commit so the target branch exists.
- The user creating the PAT has at least **Basic** access and **Contribute** permission on that repository.
- Your organization allows PAT creation (Organization settings > Microsoft Entra > *Restrict global personal access token creation* must not block you).

## Create the token
1. Sign in at `https://dev.azure.com/<organization>`.
2. Click the **User settings** icon (person with a gear, top right) > **Personal access tokens**. Direct link: `https://dev.azure.com/<organization>/_usersSettings/tokens`.
3. Click **+ New Token**.
4. Fill in:
   - **Name**: `KBMax Backup DEV` (use one token per environment: DEV, TEST, PROD).
   - **Organization**: the organization that contains the backup repository (not "All accessible organizations").
   - **Expiration**: as short as practical (maximum 1 year). Put the renewal date in your calendar.
5. Under **Scopes** choose **Custom defined**, click **Show all scopes**, and enable only **Code > Read & write**.
6. Click **Create** and copy the token immediately. It is shown only once.

## Use it in KBMax Backup
1. Open the extension > **Azure DevOps** tab.
2. Select the environment (DEV / TEST / PROD) the token is for.
3. Fill in organization, project, repository, branch and folder path, paste the token and click **Save**.

## Good practice
- Use a dedicated branch (e.g. `kbmax-backups`) when `main` has branch policies; policies block direct pushes.
- Never share a PAT in chat, tickets or source code. If it leaks, revoke it under **Personal access tokens > Revoke**.
- Prefer a managed identity for unattended or production use: see [azure-devops-managed-identity.md](azure-devops-managed-identity.md).
