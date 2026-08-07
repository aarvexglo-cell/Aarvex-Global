#!/usr/bin/env node
/**
 * Optional Playwright capture for Design Auditor.
 * Usage:
 *   node capture.mjs --base https://staging.example.com --out ./out --audit-id 123
 * Requires: npm i playwright && npx playwright install chromium
 *
 * Uploads (optional): set AWS_REGION + S3_BUCKET; needs aws-sdk v3 or aws cli.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const BASE = (args.base || "https://aarvexglobal.com").replace(/\/$/, "");
const OUT = args.out || path.join(process.cwd(), "design-audit-out");
const AUDIT_ID = args["audit-id"] || String(Date.now());
const BUCKET = process.env.S3_BUCKET || "";

const PORTAL = [
  ["login", "portal.html"],
  ["home", "portal.html#dashboard"],
  ["trade_products", "portal.html#trade"],
  ["trade_shops", "portal.html#trade"],
  ["sell", "portal.html#sell"],
  ["myorders", "portal.html#myorders"],
  ["profile", "portal.html#profile"],
  ["messages", "portal.html#messages"],
];
const ADMIN = [
  ["users", "admin_dashboard.html"],
  ["kyc", "admin_dashboard.html"],
  ["shops", "admin_dashboard.html"],
  ["settings", "admin_dashboard.html"],
  ["modqueue", "admin_dashboard.html"],
  ["clientlogs", "admin_dashboard.html"],
];
const VPS = [
  ["desktop", 1440, 900],
  ["mobile", 390, 844],
];

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("Install Playwright: npm i playwright && npx playwright install chromium");
    process.exit(1);
  }

  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const manifest = [];

  for (const [id, rel] of [...PORTAL, ...ADMIN]) {
    for (const [vp, w, h] of VPS) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      const url = `${BASE}/${rel}`;
      console.log(`Capture ${id} ${vp} → ${url}`);
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
        await page.waitForTimeout(800);
      } catch (e) {
        console.warn(`  navigation warn: ${e.message}`);
      }
      const file = `${id}__${vp}.png`;
      const full = path.join(OUT, file);
      await page.screenshot({ path: full, fullPage: false });
      const s3Key = `design-audits/${AUDIT_ID}/${file}`;
      manifest.push({ tab: id, viewport: vp, file, s3_key: s3Key, url });
      if (BUCKET) {
        const r = spawnSync(
          "aws",
          ["s3", "cp", full, `s3://${BUCKET}/${s3Key}`, "--content-type", "image/png"],
          { encoding: "utf8" }
        );
        if (r.status !== 0) console.warn(`  S3 upload failed: ${r.stderr || r.stdout}`);
        else console.log(`  uploaded s3://${BUCKET}/${s3Key}`);
      }
      await page.close();
    }
  }

  await browser.close();
  const metaPath = path.join(OUT, "captures.json");
  await writeFile(metaPath, JSON.stringify({ audit_id: AUDIT_ID, base: BASE, captures: manifest }, null, 2));
  console.log(`Wrote ${metaPath} (${manifest.length} shots)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
