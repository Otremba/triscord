// Builds the Cloudflare Pages site (triscord.pages.dev) into desktop/out/site-dist: the pages from this folder plus the
// current installer under /download/, with its version, size and SHA-256 filled in. The installer comes from
// desktop/out/portable-web-package.json (written by desktop-rust/package.ps1), never from the repository.
// Deploy (only with the owner's OK): npx wrangler pages deploy desktop/out/site-dist --project-name triscord --branch main
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(site, '../desktop');
const out = join(desktop, 'out/site-dist');
const pkg = JSON.parse(readFileSync(join(desktop, 'out/portable-web-package.json'), 'utf8').replace(/^﻿/, ''));
const installer = pkg.installer;
const bytes = readFileSync(installer);
const sha = createHash('sha256').update(bytes).digest('hex');
if (pkg.installerSha256 && pkg.installerSha256 !== sha) throw new Error('Installer changed since packaging; package again.');
// Larger neural-filter installers live in the same public release consumed by the native updater.
const externalDownload = bytes.length > 25 * 1024 * 1024;
const releaseUrl = `https://github.com/Otremba/triscord/releases/download/desktop-v${pkg.version}/${encodeURIComponent(basename(installer))}`;
const values = { VERSION: pkg.version, INSTALLER: basename(installer), SHA256: sha, SIZE: `${(bytes.length / 1048576).toFixed(1).replace('.', ',')} MB` };

if (resolve(out) !== resolve(desktop, 'out/site-dist')) throw new Error('Unexpected site output directory');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });
mkdirSync(join(out, 'download'), { recursive: true });
for (const name of readdirSync(site)) {
  if (!/\.(html|css)$/.test(name)) continue;
  const text = readFileSync(join(site, name), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Unknown placeholder ${key} in ${name}`);
    return values[key];
  });
  writeFileSync(join(out, name), text);
}
for (const name of readdirSync(join(site, 'assets'))) copyFileSync(join(site, 'assets', name), join(out, 'assets', name));
if (!externalDownload) copyFileSync(installer, join(out, 'download', values.INSTALLER));
writeFileSync(join(out, 'download', `${values.INSTALLER}.sha256`), `${sha}  ${values.INSTALLER}\n`);
// /download always points at the current installer.
writeFileSync(join(out, '_redirects'), `/download /download/${values.INSTALLER} 302\n` +
  (externalDownload ? `/download/${values.INSTALLER} ${releaseUrl} 302\n` : ''));
// Only valid assets are attachments. Missing installers must remain an HTML
// error page with HTTP 404, never an apparent executable containing the home page.
writeFileSync(join(out, '_headers'), `/download/${values.INSTALLER}\n  Content-Disposition: attachment\n  Cache-Control: public, max-age=300\n` +
  `/download/${values.INSTALLER}.sha256\n  Cache-Control: public, max-age=300\n`);
console.log(JSON.stringify({ out, ...values, externalDownload, files: readdirSync(out).length, installerBytes: statSync(installer).size }, null, 2));
