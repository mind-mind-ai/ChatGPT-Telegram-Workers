# Read-only GitHub integration

The coding agent can read GitHub repositories through a GitHub App and prepare
them inside the existing Cloudflare sandbox. The integration is read-only:
it never requests write permissions and never creates commits, branches,
pushes or pull requests.

## Security model

- GitHub App installation tokens are created and used only inside the Worker.
- Tokens are never written to the sandbox, sandbox environment variables,
  tool results, model messages or Telegram messages.
- Installation tokens are scoped to one repository and request only
  `contents: read`.
- A repository must be present in the explicit allowlist before the service
  will fetch metadata or an archive.
- Repository archives are extracted in the Worker, with path traversal,
  duplicate path, file count, per-file size and total size checks.
- Repository files are written through `SandboxClient.writeFile`; no archive
  is passed to a shell and no repository content is executed.

## Create the GitHub App

1. Open GitHub `Settings -> Developer settings -> GitHub Apps -> New GitHub App`.
2. Disable the webhook unless you add one later.
3. Set repository permissions:
    - `Contents`: `Read-only`
    - `Metadata`: `Read-only` (mandatory)
    - Do not grant `Contents: write`, `Administration`, `Pull requests` or
      `Workflows` permissions.
4. Create the App and note the **App ID**.
5. Generate a private key and download the `.pem` file.
6. Install the App on the selected repositories.
7. Find the installation ID. It is the numeric id in the installation URL,
   or use `GET /app/installations` with an App JWT.
8. Put only the selected repositories in the allowlist.

The code accepts either an unencrypted PKCS#8 PEM (`BEGIN PRIVATE KEY`) or a
PKCS#1 RSA PEM (`BEGIN RSA PRIVATE KEY`). Encrypted private keys are not
supported. If needed, convert a key locally:

```bash
openssl pkcs8 -topk8 -nocrypt -in app.pem -out app.pk8.pem
```

## Environment variables

Set these as Worker secrets or environment variables. Never commit them.

| Variable                              | Required                 | Purpose                                                                       |
| ------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `GITHUB_APP_ID`                       | For private repositories | GitHub App numeric ID.                                                        |
| `GITHUB_APP_PRIVATE_KEY`              | For private repositories | Unencrypted PEM private key. Newlines may be escaped as `\n`.                 |
| `GITHUB_INSTALLATION_ID`              | For private repositories | Default installation ID for authorized repositories.                          |
| `GITHUB_ALLOWED_REPOSITORIES`         | Yes                      | Comma-separated global allowlist, e.g. `owner/repo,owner/other`.              |
| `GITHUB_ALLOWED_REPOSITORIES_BY_USER` | Optional                 | JSON map of Telegram user id to a repository array or comma-separated string. |
| `GITHUB_INSTALLATION_IDS`             | Optional                 | JSON map of `owner/repo` to installation ID; overrides the default.           |
| `GITHUB_API_BASE_URL`                 | Optional                 | GitHub API base URL. Defaults to `https://api.github.com`.                    |

Example per-user authorization:

```json
{
    "123456789": ["owner/private-repo", "owner/another-repo"],
    "987654321": "owner/public-repo"
}
```

`*` can be used as a user key for a global entry in the same JSON map.
`GITHUB_ALLOWED_REPOSITORIES` is also global. Until a GitHub OAuth or
Telegram consent flow is added, this explicit operator-maintained allowlist is
the source of user authorization; the `GitHubAuthorizationProvider` interface
can be replaced by a database-backed implementation later.

Public repositories can be read without App credentials, but they still must
be in the allowlist. Private repositories require the App credentials and an
installation ID.

## Wiring

The integration is intentionally not connected to Telegram yet. A caller
constructs the service and registers the tools:

```ts
const github = createGitHubServiceFromEnv(ENV);
const registry = new ToolRegistry();
registerCodingTools(registry, { sandbox });
registerGitHubTools(registry, { service: github, sandbox });
```

The runtime access context must contain the user, repository and session:

```ts
await runtime.run(messages, registry, {
    access: {
        userId: '123456789',
        repository: 'owner/repo',
        sessionId: 'default',
        permissions: ['coding'],
    },
});
```

`repo_info` and `repo_checkout` only accept the repository that matches the
sandbox workspace. `repo_list` lists the repositories allowed for the caller.

## Tests

Unit tests use fake GitHub responses and `MockSandboxClient`. They do not need
a GitHub account, a real private key or a Cloudflare paid plan.
