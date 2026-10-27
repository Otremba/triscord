// Stages the public site from the Electron release and its verified package metadata.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = dirname(fileURLToPath(import.meta.url));
const release = resolve(site, '../release');
const out = join(release, 'site-dist');
const pkg = JSON.parse(readFileSync(join(release, 'website-package.json'), 'utf8').replace(/^﻿/, ''));
const installer = pkg.installer;
const bytes = readFileSync(installer);
const sha = createHash('sha256').update(bytes).digest('hex');
if (pkg.installerSha256 && pkg.installerSha256 !== sha) throw new Error('Installer changed since packaging; package again.');
// Pages limits each asset to 25 MiB; larger installers are served by GitHub Releases.
const externalDownload = bytes.length > 25 * 1024 * 1024;
const releaseUrl = `https://github.com/Otremba/triscord/releases/download/v${pkg.version}/${encodeURIComponent(basename(installer))}`;
const values = { VERSION: pkg.version, INSTALLER: basename(installer), SHA256: sha, SIZE: `${(bytes.length / 1048576).toFixed(1).replace('.', ',')} MB` };

if (resolve(out) !== resolve(release, 'site-dist')) throw new Error('Unexpected site output directory');
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
