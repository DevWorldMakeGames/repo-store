#!/usr/bin/env node
/**
 * build-list.js
 * Builds apps.json (the catalog the web client reads) from the ./apps folder.
 *
 *   node build-list.js           build apps.json
 *   node build-list.js --check   validate only, write nothing
 *
 * Each app lives in apps/<app-id>/ :
 *   app.json         required: metadata + downloads (see README block below)
 *   description.md   optional: long description (Markdown)
 *   icon.(png|svg|webp|jpg)  optional: used if app.json has no "icon"
 *   screenshots/*    optional: used if app.json has no "screenshots"
 *
 * Images may be https URLs or files inside the app folder. Files in the app
 * folder are served by the site itself at apps/<id>/<file> (so apps/<id>/icon.png
 * just works). To serve them from raw.githubusercontent.com instead, set
 * "rawImages": true plus "repo" and "branch" in store.config.json.
 *
 * app.json fields:
 *   name*, shortDescription*, description, author, category, tags[], website,
 *   license, ageRating (Everyone | Everyone 10+ | Teen 13+ | Mature 17+ | Adults Only 18+ | Unrated; default Unrated), icon, screenshots[], updated (YYYY-MM-DD),
 *   github ("owner/repo"): release downloads are pulled in by sync-releases.js
 *   downloads*[] : { platform*: "android"|"windows", version*, url* (https),
 *                    sha256*, type (apk | msi | msix | exe | zip), size (text like "3.8 MB", or bytes),
 *                    minOs, date, silentArgs, downloadCount }
 *   *Required unless "github" is set. List downloads newest first.
 *
 * Requires Node 16+. No dependencies.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const APPS_DIR = path.join(ROOT, 'apps');
const OUT_FILE = path.join(ROOT, 'apps.json');
const CHECK_ONLY = process.argv.includes('--check');

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const SHA_RE = /^[a-f0-9]{64}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ICON_RE = /^icon\.(png|svg|webp|jpe?g)$/i;
const IMAGE_RE = /\.(png|jpe?g|webp|gif|svg)$/i;
const AGES = ['Everyone', 'Everyone 10+', 'Teen 13+', 'Mature 17+', 'Adults Only 18+', 'Unrated'];
const TYPES = { android: ['apk'], windows: ['msi', 'msix', 'exe', 'zip'] };

const errors = [];
const warnings = [];
const fail = (id, msg) => errors.push(`${id}: ${msg}`);
const warn = (id, msg) => warnings.push(`${id}: ${msg}`);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

let config = {};
try {
  const cfgPath = path.join(ROOT, 'store.config.json');
  if (fs.existsSync(cfgPath)) config = readJson(cfgPath);
} catch (e) {
  fail('store.config.json', `invalid JSON (${e.message})`);
}
const repo = config.rawImages ? process.env.GITHUB_REPOSITORY || config.repo || '' : '';
const branch = config.branch || 'main';
if (config.rawImages && !repo) fail('store.config.json', '"rawImages" needs a "repo" ("owner/repo")');

/** Resolve an image value (https URL or file in the app folder) to a URL. */
function assetUrl(id, value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(id, `${label} must be a non-empty string`);
    return null;
  }
  value = value.trim();
  if (/^https:\/\//i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
    fail(id, `${label} must be an https URL or a file in the app folder: ${value}`);
    return null;
  }
  const rel = value.replace(/^\.\//, '');
  const base = path.join(APPS_DIR, id);
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep)) {
    fail(id, `${label} points outside the app folder: ${value}`);
    return null;
  }
  if (!fs.existsSync(file)) {
    fail(id, `${label} file not found: ${value}`);
    return null;
  }
  const urlPath = ['apps', id, ...rel.split('/')].map(encodeURIComponent).join('/');
  return repo ? `https://raw.githubusercontent.com/${repo}/${branch}/${urlPath}` : urlPath;
}

function buildDownload(id, d, i) {
  const at = `downloads[${i}]`;
  if (!d || typeof d !== 'object') return fail(id, `${at} must be an object`), null;

  const platform = String(d.platform || '').toLowerCase();
  if (!TYPES[platform]) return fail(id, `${at}.platform must be "android" or "windows"`), null;
  if (!d.version) fail(id, `${at}.version is required`);
  if (typeof d.url !== 'string' || !/^https:\/\//i.test(d.url)) {
    fail(id, `${at}.url must be an https URL (use the GitHub release asset URL)`);
  }
  if (!SHA_RE.test(String(d.sha256 || ''))) {
    fail(id, `${at}.sha256 must be 64 hex characters`);
  }

  let type = String(d.type || '').toLowerCase();
  if (!type && typeof d.url === 'string') {
    type = (d.url.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  }
  if (!TYPES[platform].includes(type)) {
    fail(id, `${at}.type "${type}" is not valid for ${platform} (use ${TYPES[platform].join(', ')})`);
  }
  const sizeOk = typeof d.size === 'string'
    ? d.size.trim().length > 0 && d.size.length <= 24
    : Number.isInteger(d.size) && d.size > 0;
  if (d.size != null && !sizeOk) {
    fail(id, `${at}.size must be text like "3.8 MB" (or a byte count)`);
  }
  if (d.date && !DATE_RE.test(d.date)) fail(id, `${at}.date must be YYYY-MM-DD`);

  return {
    platform,
    version: String(d.version ?? ''),
    type,
    url: d.url,
    sha256: String(d.sha256 || '').toLowerCase(),
    size: d.size ?? null,
    minOs: d.minOs || null,
    silentArgs: d.silentArgs || null,
    date: d.date || null,
    downloadCount: Number.isInteger(d.downloadCount) ? d.downloadCount : null,
  };
}

function buildApp(id) {
  const dir = path.join(APPS_DIR, id);
  const metaPath = path.join(dir, 'app.json');
  if (id.toLowerCase() === 'publish') return fail(id, '"publish" is reserved for the Publish page'), null;
  if (!ID_RE.test(id)) return fail(id, 'folder name may only use letters, digits, ".", "_" and "-"'), null;
  if (!fs.existsSync(metaPath)) return fail(id, 'missing app.json'), null;

  let meta;
  try {
    meta = readJson(metaPath);
  } catch (e) {
    return fail(id, `app.json is not valid JSON (${e.message})`), null;
  }

  if (!meta.name) fail(id, 'name is required');
  if (!meta.shortDescription) fail(id, 'shortDescription is required');
  if (meta.github != null && !/^[\w.-]+\/[\w.-]+$/.test(meta.github)) {
    fail(id, 'github must look like "owner/repo"');
  }
  // Downloads = hand-written entries + the ones sync-releases.js generated.
  let generated = [];
  const genPath = path.join(dir, 'releases.generated.json');
  if (meta.github && fs.existsSync(genPath)) {
    try { generated = readJson(genPath).downloads || []; }
    catch (e) { fail(id, `releases.generated.json is not valid JSON (${e.message})`); }
  }
  const rawDownloads = [...(Array.isArray(meta.downloads) ? meta.downloads : []), ...generated];
  if (!rawDownloads.length) {
    if (meta.github) return warn(id, 'no releases found (run "node sync-releases.js"): app skipped'), null;
    fail(id, 'downloads must contain at least one entry');
  }

  // Long description: description.md wins, then app.json "description".
  let description = meta.description || '';
  const mdPath = path.join(dir, 'description.md');
  if (fs.existsSync(mdPath)) description = fs.readFileSync(mdPath, 'utf8').trim();
  if (!description) warn(id, 'no description.md (the detail page will use the short description)');

  // Age rating (defaults to Unrated)
  let ageRating = 'Unrated';
  if (meta.ageRating != null && meta.ageRating !== '') {
    const hit = AGES.find((a) => a.toLowerCase() === String(meta.ageRating).toLowerCase());
    if (hit) ageRating = hit; else fail(id, `ageRating must be one of: ${AGES.join(', ')}`);
  }

  // Images
  let icon = meta.icon;
  if (!icon) icon = fs.readdirSync(dir).find((f) => ICON_RE.test(f));
  icon = icon ? assetUrl(id, icon, 'icon') : null;

  let shots = meta.screenshots;
  if (!shots) {
    const shotDir = path.join(dir, 'screenshots');
    shots = fs.existsSync(shotDir)
      ? fs.readdirSync(shotDir).filter((f) => IMAGE_RE.test(f)).sort().map((f) => `screenshots/${f}`)
      : [];
  }
  if (!Array.isArray(shots)) {
    fail(id, 'screenshots must be an array');
    shots = [];
  }
  shots = shots.map((s, i) => assetUrl(id, s, `screenshots[${i}]`)).filter(Boolean);

  const downloads = rawDownloads.map((d, i) => buildDownload(id, d, i)).filter(Boolean);
  const platforms = [...new Set(downloads.map((d) => d.platform))].sort();

  if (meta.updated && !DATE_RE.test(meta.updated)) fail(id, 'updated must be YYYY-MM-DD');
  const updated =
    meta.updated || downloads.map((d) => d.date).filter(Boolean).sort().pop() || null;

  return {
    id,
    name: meta.name || id,
    shortDescription: meta.shortDescription || '',
    description: description || meta.shortDescription || '',
    author: meta.author || (meta.github ? meta.github.split('/')[0] : null),
    github: meta.github || null,
    category: meta.category || 'Other',
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    website: /^https:\/\//i.test(meta.website || '') ? meta.website : null,
    license: meta.license || null,
    ageRating,
    icon,
    screenshots: shots,
    platforms,
    updated,
    totalDownloads: downloads.some((d) => d.downloadCount != null)
      ? downloads.reduce((n, d) => n + (d.downloadCount || 0), 0) : null,
    downloads,
  };
}

function main() {
  if (!fs.existsSync(APPS_DIR)) {
    console.error('No "apps" folder found next to build-list.js');
    process.exit(1);
  }

  const ids = fs
    .readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !/^[._]/.test(e.name))
    .map((e) => e.name)
    .sort();

  const apps = ids.map(buildApp).filter(Boolean);
  apps.sort((a, b) => a.name.localeCompare(b.name));

  warnings.forEach((w) => console.warn(`warning: ${w}`));
  if (errors.length) {
    errors.forEach((e) => console.error(`error:   ${e}`));
    console.error(`\n${errors.length} error(s). apps.json was not written.`);
    process.exit(1);
  }

  const output = {
    name: config.name || 'repo-store',
    generated: new Date().toISOString(),
    count: apps.length,
    apps,
  };

  if (CHECK_ONLY) {
    console.log(`OK: ${apps.length} app(s) valid.`);
    return;
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote ${path.basename(OUT_FILE)} with ${apps.length} app(s).`);
}

main();
