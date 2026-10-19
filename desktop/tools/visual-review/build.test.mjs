import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepare,build,loadImage} from './build.mjs';

// Real, small PNGs; metadata tests do not need a GUI, user settings or app build.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZsAAAAASUVORK5CYII=','base64');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'triscord-review-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(path.join(root,'capture.png'),png);return root;}
const source={path:'capture.png',dpi:96,state:'voice',origin:'observed-discord'};
test('missing reference stays pending, never approved',t=>{const root=fixture(t);const [p]=prepare(root,{pairs:[{id:'call',implementation:source}]});assert.equal(p.status,'pending');assert.match(p.issues[0],/Falta captura real/);});
test('matching metadata means ready for HUMAN review',t=>{const root=fixture(t);const [p]=prepare(root,{pairs:[{id:'call',reference:source,implementation:source}]});assert.equal(p.status,'ready-for-review');assert.deepEqual(p.issues,[]);assert.equal(p.reference.width,1);});
test('state, DPI, dimensions and provenance mismatches are explicit',t=>{const root=fixture(t);const altered=Buffer.from(png);altered.writeUInt32BE(2,16);fs.writeFileSync(path.join(root,'wide.png'),altered);const [p]=prepare(root,{pairs:[{id:'call',reference:{...source,origin:'fixture'},implementation:{...source,path:'wide.png',dpi:144,state:'chat'}}]});assert.equal(p.status,'pending');assert.equal(p.issues.length,4);});
test('reject stale hash, corrupt header and duplicate IDs',t=>{const root=fixture(t);assert.throws(()=>loadImage(root,{...source,sha256:'0'.repeat(64)}),/Hash divergente/);fs.writeFileSync(path.join(root,'bad.png'),'not a png');assert.throws(()=>loadImage(root,{path:'bad.png'}),/PNG/);assert.throws(()=>prepare(root,{pairs:[{id:'x'},{id:'x'}]}),/duplicado/);});
test('reject reading outside workspace, including symlink redirection',t=>{const root=fixture(t);const outside=fs.mkdtempSync(path.join(os.tmpdir(),'triscord-review-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));fs.writeFileSync(path.join(outside,'outside.png'),png);assert.throws(()=>loadImage(root,{path:path.join(outside,'outside.png')}),/fora do workspace/);try{fs.symlinkSync(outside,path.join(root,'link'),'junction');}catch(error){if(error.code==='EPERM')return;throw error;}assert.throws(()=>loadImage(root,{path:'link/outside.png'}),/fora do workspace/);});
test('report escapes script injection and excludes image data from metadata',t=>{const root=fixture(t);fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({pairs:[{id:'x',title:'</script><script>alert(1)</script>',implementation:source}]}));const result=build({root,manifestPath:'manifest.json',out:'review'});const html=fs.readFileSync(result.html,'utf8');assert.ok(!html.includes('</script><script>alert(1)</script>'));assert.ok(html.includes('\\u003c/script>'));const audit=JSON.parse(fs.readFileSync(path.join(root,'review/audit.json')));assert.ok(audit.pairs[0].implementation.sha256);assert.equal(audit.pairs[0].implementation.data,undefined);assert.equal(result.pending,1);});
test('reject output directory escape',t=>{const root=fixture(t);fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({pairs:[]}));assert.throws(()=>build({root,manifestPath:'manifest.json',out:path.join(root,'../outside')}),/Saída fora/);});
