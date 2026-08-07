const fetch = require('node-fetch');

// This is a small wrapper to call Claude (Anthropic) or any Claude-compatible endpoint.
// Configure CLAUDE_API_URL and CLAUDE_API_KEY in .env

async function suggestFixWithClaude(originalContent, issues) {
  const url = process.env.CLAUDE_API_URL; // e.g. https://api.anthropic.com/v1/complete
  const key = process.env.CLAUDE_API_KEY;

  if (!url || !key) {
    // No API configured — fall back to asking local auto-fix (the validator autoFix should be used)
    return { ok: false, reason: 'no_api', suggestion: null };
  }

  const prompt = `You are an assistant that receives an SVG file and a list of detected issues.\nIssues: ${issues.join(', ')}\nProvide a corrected SVG content only (no commentary).\nOriginal:\n\n${originalContent}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        // This payload shape might need to be adapted for the Claude/Anthropic endpoint you use
        model: process.env.CLAUDE_MODEL || 'claude-2.1',
        prompt: prompt,
        max_tokens: 2000
      })
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, reason: `api_error_${res.status}`, suggestion: text };
    }
    const data = await res.json();
    // The exact field depends on the API. Try a few common ones.
    const suggestion = data?.completion || data?.output || data?.text || JSON.stringify(data);
    return { ok: true, suggestion };
  } catch (err) {
    return { ok: false, reason: 'request_failed', error: String(err) };
  }
}

module.exports = { suggestFixWithClaude };
