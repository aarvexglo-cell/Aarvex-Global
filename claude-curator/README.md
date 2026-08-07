Claude-curator — SVG monitor & auto-curator (starter)

Overview

This small starter project demonstrates a safe workflow to automatically validate SVG assets changed in a GitHub repo, ask Claude for suggested fixes, and open a PR with the fix. With admin credentials you may choose to auto-merge the PRs.

Important security notes
- Do NOT commit secrets. Provide environment variables locally or via your deployment platform's secret manager.
- This scaffold uses the GitHub REST API to create branches, update files, and create PRs. The service requires a GitHub token with repo write permissions.
- Claude API usage requires an API key; a placeholder is present in the code. The Claude API endpoint and response shape may need adjustment depending on your Claude provider.

Files created
- src/index.js        -> Express webhook listener + orchestration
- src/validator.js    -> Simple SVG checks and local auto-fix
- src/claude_client.js-> Wrapper to call Claude API (placeholder/adjustable)
- package.json

How it works
1. Configure environment and run the service.
2. Configure a GitHub webhook (push events) pointing to /webhook.
3. On a push, the service finds changed SVG files, fetches their contents, runs quick checks.
4. If issues found, it requests a suggested fix (local autoFix used as fallback). If Claude API is configured, the service will ask Claude and prefer its suggestion.
5. The service creates a new branch, updates the file with the fixed content, and opens a PR with the explanation.
6. Optionally you can auto-merge PRs if you run with a bot account and enable that behavior (not enabled by default).

Setup (local)
1. Copy .env.example to .env and fill the variables (see below).
2. npm install
3. npm start

ENV variables (.env)
- GITHUB_TOKEN: Personal access token or bot token with repo write access (required for git operations)
- GITHUB_WEBHOOK_SECRET: (optional) secret to validate incoming webhook payloads
- CLAUDE_API_URL: Claude-compatible HTTP endpoint to request completions (optional)
- CLAUDE_API_KEY: API key for Claude (optional)
- CLAUDE_MODEL: model name to request (optional)
- PORT: port to listen on (default 4000)

Notes to adapt to your environment
- The Claude API wrapper in src/claude_client.js is a generic POST; you may need to adapt the JSON payload and parsing depending on the Claude endpoint/version you use.
- The service currently uses octokit.repos.createOrUpdateFileContents to write updated files. This is straightforward but creates the file contents anew on the branch. If you prefer a commit-based low-level tree create flow, replace with the git data APIs.
- Error handling is basic — expand logging / retries / background queues as needed.

Deployment
- Deploy behind HTTPS (required for GitHub webhooks) and configure the webhook in GitHub repository settings (Payload URL, content-type application/json, and the secret if set).

Extending / Safety
- Add an approval workflow: instead of auto-creating PRs, send a notification to Slack/Teams and wait for an approver to comment `/apply` on the PR before merging.
- Use a dedicated bot account with a minimal set of permissions (not a full admin user).
- Add rate limiting and signature verification for extra security.

If you want, I can:
- Deploy a simple instance with instructions (Dockerfile + sample deploy). 
- Add an approval bot flow that waits for an admin comment to apply the PR. 
- Add more validators (SVG optical centering, path simplification) and run SVGO automatically on each suggested edit.

Added features in this scaffold

- Auto-merge approval flow: the service listens for issue_comment events and if an authorized user posts a comment with exactly `/apply` on a PR created by the AI fixer (branch prefix `ai/fix-svg-`), the service will merge the PR. Configure allowed approvers via the ADMIN_USERS environment variable (comma-separated list) or rely on GitHub collaborator permission levels (write/maintain/admin).

- SVGO optimization: a package script `npm run optimize:icons` is included to run SVGO on the repository Icons folder and aggressively optimize SVG assets.

- Dockerfile: a minimal Dockerfile is included to run the service in a container. Build with `docker build -t claude-curator .` and run with `docker run -e GITHUB_TOKEN=... -p 4000:4000 claude-curator`.

Deployment notes

1. Build and run with Docker (example):
   docker build -t claude-curator .
   docker run -d --name claude-curator -e GITHUB_TOKEN=ghp_... -e GITHUB_WEBHOOK_SECRET=yoursecret -p 4000:4000 claude-curator

2. Configure the GitHub webhook to point to your host (https) with content-type `application/json` and the same secret.

3. To enable Claude suggestions, add `CLAUDE_API_URL` and `CLAUDE_API_KEY` to environment variables. The wrapper may need adjustment for your Claude provider.

4. To run SVGO locally to optimize icons:
   - npm install (in claude-curator)
   - npm run optimize:icons

Safety reminder: test on a fork or a repo with a bot account before enabling on production.


