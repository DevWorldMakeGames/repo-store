#!/usr/bin/env node
/**
 * sync-releases.js
 * For every app whose app.json has  "github": "owner/repo", read that repo's
 * GitHub Releases and write apps/<id>/releases.generated.json with one
 * download entry per platform per release (url, sha256, size, date, count).
 * build-list.js merges that file into apps.json.
 *
 * Optional app.json block to control matching and add per-platform details:
 *   "assets": {
 *     "android": { "match": "\\.apk$",         "minOs": "Android 8.0" },
 *     "windows": { "match": "x64.*\\.msi$",    "minOs": "Windows 10", "silentArgs": "/qn" }
 *   }
 * Defaults match *.apk for Android and *.msi/.msix/.exe/.zip for Windows.
 * Set "prereleases": true to include pre-releases.
 *
 * Env: GITHUB_TOKEN (raises the API limit; automatic in GitHub Actions),
 *      MAX_RELEASES (default 5).
 * SHA-256 comes from the digest GitHub stores on each asset. If an asset has
 * none, the file is downloaded once and hashed (reused on later runs).
 * Exits with code 1 if any app fails, so CI keeps the last good deploy.
 * Requires Node 18+.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APPS_DIR = path.join(__dirname, 'apps');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const MAX = Number(process.env.MAX_RELEASES) || 5;
const DEFAULTS = {
  android: { match: '\\.apk$' },
  windows: { match: '\\.(msi|msix|exe|zip)$' },
};
const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'repo-store-sync',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function api(url) {
  const r = await fetch(url, { headers });
  if (r.status === 403 || r.status === 429) {
    const reset = r.headers.get('x-ratelimit-reset');
    throw new Error(`GitHub rate limit hit${reset ? `, resets ${new Date(reset * 1000).toISOString()}` : ''}`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

async function hashUrl(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'repo-store-sync' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} downloading ${url}`);
  const h = crypto.createHash('sha256');
  for await (const chunk of r.body) h.update(chunk);
  return h.digest('hex');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function syncApp(id) {
  const meta = readJson(path.join(APPS_DIR, id, 'app.json'));
  if (!meta || !meta.github) return null;
  if (!/^[\w.-]+\/[\w.-]+$/.test(meta.github)) throw new Error('github must look like "owner/repo"');

  const outFile = path.join(APPS_DIR, id, 'releases.generated.json');
  const known = new Map(((readJson(outFile) || {}).downloads || []).map((d) => [d.url, d.sha256]));
  const rules = {};
  for (const p of Object.keys(DEFAULTS)) {
    if (meta.assets && !meta.assets[p]) continue; // only listed platforms when "assets" is set
    rules[p] = { ...DEFAULTS[p], ...((meta.assets || {})[p] || {}) };
  }

  const all = await api(`https://api.github.com/repos/${meta.github}/releases?per_page=${Math.min(MAX * 3, 100)}`);
  const releases = all.filter((r) => !r.draft && (meta.prereleases || !r.prerelease)).slice(0, MAX);

  const downloads = [];
  for (const rel of releases) {
    for (const [platform, rule] of Object.entries(rules)) {
      const re = new RegExp(rule.match, 'i');
      const asset = rel.assets.find((a) => re.test(a.name) && a.state === 'uploaded');
      if (!asset) continue;
      const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '');
      const sha256 = digest ? digest[1].toLowerCase() : known.get(asset.browser_download_url) || (await hashUrl(asset.browser_download_url));
      const { match, ...extra } = rule;
      downloads.push({
        platform,
        version: String(rel.tag_name).replace(/^v/i, ''),
        type: (asset.name.match(/\.([a-z0-9]+)$/i) || [])[1].toLowerCase(),
        url: asset.browser_download_url,
        sha256,
        size: asset.size,
        date: (rel.published_at || rel.created_at || '').slice(0, 10) || null,
        downloadCount: asset.download_count,
        ...extra,
      });
    }
  }

  fs.writeFileSync(outFile, JSON.stringify({ repo: meta.github, synced: new Date().toISOString(), downloads }, null, 2) + '\n');
  return downloads.length;
}

(async () => {
  let failed = 0;
  const ids = fs.readdirSync(APPS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && !/^[._]/.test(e.name)).map((e) => e.name).sort();
  for (const id of ids) {
    try {
      const n = await syncApp(id);
      if (n !== null) console.log(`${id}: ${n} download(s) synced`);
    } catch (e) {
      failed++;
      console.error(`${id}: ${e.message}`);
    }
  }
  if (failed) process.exit(1);
})();
