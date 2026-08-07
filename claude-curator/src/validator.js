const DEFAULT_VIEWBOX = '0 0 24 24';

function findIssues(svgText) {
  const issues = [];
  if (!/viewBox\s*=\s*"[^"]+"/i.test(svgText)) {
    issues.push('missing-viewBox');
  }
  if (/width\s*=\s*"[^"]+"/i.test(svgText) || /height\s*=\s*"[^"]+"/i.test(svgText)) {
    issues.push('fixed-dimensions');
  }
  if (/enable-background/i.test(svgText) || /xml:space/i.test(svgText)) {
    issues.push('editor-metadata');
  }
  if (/<!--[^>]*Uploaded to: SVG Repo[^>]*-->/i.test(svgText)) {
    issues.push('repo-metadata');
  }
  return issues;
}

function autoFix(svgText) {
  let out = svgText;
  // remove common uploaded comments and any HTML comments
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  // remove width/height attributes
  out = out.replace(/\swidth\s*=\s*"[^"]*"/ig, '');
  out = out.replace(/\sheight\s*=\s*"[^"]*"/ig, '');
  // remove enable-background and xml:space
  out = out.replace(/\senable-background\s*=\s*"[^"]*"/ig, '');
  out = out.replace(/\sxml:space\s*=\s*"[^"]*"/ig, '');
  // remove metadata tags
  out = out.replace(/<metadata[\s\S]*?<\/metadata>/ig, '');
  // ensure xml header
  if (!/^\s*<\?xml/i.test(out)) {
    out = '<?xml version="1.0" encoding="utf-8"?>\n' + out.trim();
  }
  // ensure viewBox exists on root svg
  if (!/viewBox\s*=\s*"[^"]+"/i.test(out)) {
    out = out.replace(/<svg([^>]*)>/i, (m, attrs) => {
      return '<svg' + attrs + ' viewBox="' + DEFAULT_VIEWBOX + '">';
    });
  }
  // trim whitespace
  return out.trim();
}

module.exports = {
  findIssues,
  autoFix
};
