require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
const { findIssues, autoFix } = require('./validator');
const { suggestFixWithClaude } = require('./claude_client');

const app = express();
// capture raw body for correct GitHub signature verification
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';
if (!GITHUB_TOKEN) console.warn('Warning: GITHUB_TOKEN not set — GitHub operations will fail');

const octokit = new Octokit({ auth: GITHUB_TOKEN });

function verifySignature(req) {
  if (!WEBHOOK_SECRET) return true; // not enforced
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;
  // Use raw body bytes (GitHub signs the raw request body)
  const payload = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch (e) {
    return false;
  }
}

app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) {
    res.status(401).send('Invalid signature');
    return;
  }
  const event = req.headers['x-github-event'];
  try {
    if (event === 'push') {
      const payload = req.body;
      const repo = payload.repository;
      const commits = payload.commits || [];
      const modified = new Set();
      commits.forEach(c => {
        (c.added || []).forEach(f => modified.add(f));
        (c.modified || []).forEach(f => modified.add(f));
      });

      const svgFiles = Array.from(modified).filter(f => f.toLowerCase().endsWith('.svg'));
      if (svgFiles.length === 0) {
        res.send({ ok: true, message: 'no svg changes' });
        return;
      }

      const owner = repo.owner.name || repo.owner.login;
      const repoName = repo.name;
      const baseRef = payload.ref.replace('refs/heads/', '');

      const report = [];
      for (const path of svgFiles) {
        // fetch file content at head commit
        try {
          const content = await octokit.repos.getContent({ owner, repo: repoName, path, ref: payload.after });
          const fileData = Buffer.from(content.data.content, 'base64').toString('utf8');
          const issues = findIssues(fileData);
          if (issues.length === 0) {
            report.push({ path, status: 'ok' });
            continue;
          }

          // attempt a suggested fix: first try local autoFix
          let fixed = autoFix(fileData);

          // Ask Claude for a better fix if API configured
          const claudeResp = await suggestFixWithClaude(fileData, issues);
          if (claudeResp.ok && claudeResp.suggestion) {
            // prefer Claude suggestion if returned
            fixed = claudeResp.suggestion;
          }

          // Create a new branch and push fixes as a commit using GitHub API
          const branchName = `ai/fix-svg-${Date.now()}`;

          // get base commit sha
          const baseRefData = await octokit.git.getRef({ owner, repo: repoName, ref: `heads/${baseRef}` });
          const baseSha = baseRefData.data.object.sha;

          // create new branch
          await octokit.git.createRef({ owner, repo: repoName, ref: `refs/heads/${branchName}`, sha: baseSha });

          // update file on branch (createOrUpdateFileContents)
          const buff = Buffer.from(fixed, 'utf8').toString('base64');
          // use the existing file SHA if present to perform an update instead of a create
          const existingSha = content && content.data && content.data.sha ? content.data.sha : undefined;
          try {
            await octokit.repos.createOrUpdateFileContents({
              owner,
              repo: repoName,
              path,
              message: `AI: fix svg ${path}`,
              content: buff,
              branch: branchName,
              ...(existingSha ? { sha: existingSha } : {}),
            });
          } catch (writeErr) {
            // Attempt a recovery: fetch latest file sha on base branch and retry update
            try {
              const latest = await octokit.repos.getContent({ owner, repo: repoName, path, ref: baseRef });
              const latestSha = latest.data.sha;
              await octokit.repos.createOrUpdateFileContents({
                owner,
                repo: repoName,
                path,
                message: `AI: fix svg ${path} (retry with latest sha)`,
                content: buff,
                branch: branchName,
                sha: latestSha,
              });
            } catch (retryErr) {
              throw writeErr; // bubble original write error
            }
          }

          // create PR
          const pr = await octokit.pulls.create({ owner, repo: repoName, title: `AI: fix ${path}`, head: branchName, base: baseRef, body: `Automated SVG fix for ${path}. Issues: ${issues.join(', ')}\n\nGenerated with Claude assist.` });

          report.push({ path, status: 'pr_created', pr: pr.data.html_url });
        } catch (err) {
          report.push({ path, status: 'error', error: String(err) });
        }
      }

      res.send({ ok: true, report });
      return;
    }

    // handle issue_comment events to allow approvers to apply PRs
    if (event === 'issue_comment') {
      const payload = req.body;
      const comment = payload.comment && payload.comment.body && payload.comment.body.trim();
      const commenter = payload.comment && payload.comment.user && payload.comment.user.login;
      const issue = payload.issue; // could be PR
      if (comment === '/apply' && issue && issue.pull_request) {
        const prNumber = issue.number;
        try {
          // check commenter permission: allow if in ADMIN_USERS env or has write/admin on repo
          const allowed = (process.env.ADMIN_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
          let isAllowed = allowed.includes(commenter);
          if (!isAllowed) {
            const perm = await octokit.repos.getCollaboratorPermissionLevel({ owner: payload.repository.owner.login || payload.repository.owner.name, repo: payload.repository.name, username: commenter });
            const level = perm.data.permission;
            if (['admin', 'maintain', 'write'].includes(level)) isAllowed = true;
          }
          if (!isAllowed) {
            res.send({ ok: false, message: 'commenter not authorized' });
            return;
          }

          // get PR
          const pr = await octokit.pulls.get({ owner: payload.repository.owner.login || payload.repository.owner.name, repo: payload.repository.name, pull_number: prNumber });
          // only allow auto-apply for branches created by AI fixer
          const headRef = pr.data.head && pr.data.head.ref;
          if (!headRef || !headRef.startsWith('ai/fix-svg-')) {
            res.send({ ok: false, message: 'PR not eligible for auto-apply' });
            return;
          }

          // merge PR
          await octokit.pulls.merge({ owner: payload.repository.owner.login || payload.repository.owner.name, repo: payload.repository.name, pull_number: prNumber, merge_method: 'merge' });
          res.send({ ok: true, message: 'PR merged' });
          return;
        } catch (err) {
          console.error('apply error', err);
          res.status(500).send({ ok: false, error: String(err) });
          return;
        }
      }
    }

    res.send({ ok: true, message: `ignored event ${event}` });
  } catch (err) {
    console.error(err);
    res.status(500).send({ ok: false, error: String(err) });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Claude-curator listening on ${port}`));
