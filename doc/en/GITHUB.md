# GitHub integration with approval-gated writes

The coding agent can read GitHub repositories through a GitHub App and prepare
them inside the existing Cloudflare sandbox. Reads are always allowed for an
explicitly allowlisted repository. Writing is disabled by default and can only
happen after the Telegram user reviews a complete diff and presses **Approve**.

Coding sessions need a chat provider that supports tool calling (an
OpenAI-compatible or Anthropic provider). The Cloudflare Workers AI provider
does not support the tool loop and will be rejected with a clear error.

An approved write creates a new branch and one commit through the GitHub Git
Data API. It never updates the default branch, merges, deploys, opens pull
requests or force-pushes.

## Security model

- GitHub App installation tokens are created and used only inside the Worker.
- Tokens are never written to the sandbox, sandbox environment variables,
  tool results, model messages or Telegram messages.
- Read installation tokens request only `contents: read`.
- Write installation tokens request `contents: write` and are requested only
  after an approval callback. They are never used for reads.
- A repository must be present in the read allowlist before the service will
  fetch metadata or an archive.
- A repository must separately be present in
  `GITHUB_WRITE_ALLOWED_REPOSITORIES` before any write is possible. Adding a
  repository to the read allowlist never enables writes.
- The coding agent itself cannot write to GitHub. It proposes a change set;
  the Worker collects the complete diff, hashes it, and asks the original
  Telegram user in the original private chat to review and approve it.
- The approval is bound to the user, chat, session, job, approval ID, one-time
  nonce and exact diff hash. It expires after `CODING_APPROVAL_TTL_MS`.
- Before writing, the Worker re-collects the diff and re-checks the base branch
  head. If either changed, the approval becomes stale and nothing is written.
- Writes use the approved base commit, create a new branch, and verify the
  resulting commit tree and branch head. A failed or partial write never
  silently falls back to another branch or the default branch.
- Repository archives are extracted in the Worker, with path traversal,
  duplicate path, file count, per-file size and total size checks.
- Repository files are written through `SandboxClient.writeFile`; no archive
  is passed to a shell and no repository content is executed.

## Create the GitHub App

1. Open GitHub `Settings -> Developer settings -> GitHub Apps -> New GitHub App`.
2. Disable the webhook unless you add one later.
3. Set repository permissions:
    - `Contents`: `Read-only` for read-only deployments.
    - `Contents`: `Read and write` only if you intend to enable the approval
      flow.
    - `Metadata`: `Read-only` (mandatory)
    - Do not grant `Administration`, `Pull requests` or `Workflows`
      permissions. The Worker does not open pull requests.
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
| `GITHUB_APP_ID`                       | For private repos/writes | GitHub App numeric ID. Required for private repositories and all writes.      |
| `GITHUB_APP_PRIVATE_KEY`              | For private repos/writes | Unencrypted PEM private key. Newlines may be escaped as `\n`.                 |
| `GITHUB_INSTALLATION_ID`              | For private repos/writes | Default installation ID for authorized repositories.                          |
| `GITHUB_ALLOWED_REPOSITORIES`         | Yes                      | Comma-separated global allowlist, e.g. `owner/repo,owner/other`.              |
| `GITHUB_ALLOWED_REPOSITORIES_BY_USER` | Optional                 | JSON map of Telegram user id to a repository array or comma-separated string. |
| `GITHUB_INSTALLATION_IDS`             | Optional                 | JSON map of `owner/repo` to installation ID; overrides the default.           |
| `GITHUB_API_BASE_URL`                 | Optional                 | GitHub API base URL. Defaults to `https://api.github.com`.                    |
| `GITHUB_WRITE_ALLOWED_REPOSITORIES`   | Optional                 | Separate comma-separated allowlist for approval-gated writes. Empty by default. |
| `CODING_APPROVAL_TTL_MS`              | Optional                 | Approval lifetime in milliseconds. Defaults to 15 minutes; minimum 60 seconds. |
| `SANDBOX_INTERNET`                    | Optional                 | Set `true` to let the coding sandbox download packages. Default `false`.       |

> `GITHUB_APP_PRIVATE_KEY` is a secret. Never commit the `.pem` file; the
> repository ignores `*.pem` and `*.key`. Paste the full PEM into the Worker
> secret field, or use `\n` escapes if the dashboard stores it on one line.

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

## Approval flow

After an instruction finishes, the Worker compares the sandbox against the
commit that was checked out and stores a complete unified diff. If there are
changes, Telegram receives a summary with three buttons:

- **Review changes** shows the complete diff or sends it as a `.diff` document
  when it is too large for a message.
- **Approve and save to GitHub** validates the one-time approval, re-collects
  the diff, checks that the base branch has not moved, and creates a new branch
  and commit.
- **Reject changes** discards the proposal without writing to GitHub.

Only the original Telegram user in the original private chat can use the
buttons. The callback is rejected for other users, groups, expired approvals,
changed diffs, changed jobs or changed sessions. A replayed approval returns
the existing result and never writes a second time. A failed GitHub write leaves the proposed change set available for review.
Pressing **Approve and save to GitHub** again retries the same branch and
commit safely; it is never retried automatically.

## Wiring

The integration is connected to the coding session Durable Object and the
Telegram callback handler. A caller can also construct the service and register
the read-only tools:

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

`repo_info` only accepts the repository that matches the sandbox workspace.
`repo_list` lists the repositories allowed for the caller. The host performs
the checkout itself; `repo_checkout` is not exposed to the coding agent. The
write path is also not exposed as a model tool: only the approval callback can
call `GitHubService.writeChanges`.

## Tests

Unit tests use fake GitHub responses and `MockSandboxClient`. They do not need
a GitHub account, a real private key or a Cloudflare paid plan.
