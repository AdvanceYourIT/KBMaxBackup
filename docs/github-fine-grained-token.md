# GitHub: create a fine-grained personal access token

A fine-grained token can be limited to a single private repository and to exactly the permissions the backup needs.

## Prerequisites
- A **private** repository for the backups (e.g. `kbmax-backups`) with at least one commit, so the target branch exists. A README is enough.
- You can write to that repository. If it belongs to an organization, an owner must allow fine-grained tokens (Organization settings > Personal access tokens) and may need to approve your token request.

## Create the token
1. On GitHub click your profile picture > **Settings** > **Developer settings** > **Personal access tokens** > **Fine-grained tokens** > **Generate new token**.
2. **Token name**: `KBMax Backup DEV` (one token per environment: DEV, TEST, PROD).
3. **Expiration**: as short as practical (maximum 1 year; organizations may set a lower limit).
4. **Resource owner**: the user or organization that owns the backup repository.
5. **Repository access**: **Only select repositories** and pick the backup repository.
6. **Permissions > Repository permissions**: set **Contents** to **Read and write**. **Metadata: Read** is added automatically. Leave everything else at *No access*.
7. Click **Generate token** and copy it immediately. It is shown only once. If the owner is an organization that requires approval, the token stays pending until an owner approves it.

## Use it in KBMax Backup
1. Open the extension > **GitHub** tab.
2. Select the environment the token is for.
3. Fill in owner, repository, branch and folder path, paste the token and click **Save**.

## Verify the token
```
curl -H "Authorization: Bearer <token>" -H "X-GitHub-Api-Version: 2022-11-28" https://api.github.com/repos/<owner>/<repository>
```
A JSON description of the repository means the token works; `404` usually means the repository was not selected for the token (or approval is pending).

## Good practice
- Use a dedicated branch (e.g. `kbmax-backups`) if `main` is protected; branch protection blocks direct pushes.
- Set a calendar reminder before expiry and rotate by generating a new token, saving it in the extension, then deleting the old one.
- If a token leaks, delete it under **Fine-grained tokens** immediately.

## Sources
- GitHub Docs: [Managing your personal access tokens](https://docs.github.com/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
