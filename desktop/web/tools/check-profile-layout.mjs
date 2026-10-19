// Real components, isolated fixture and private headless Edge. Never touches a real account.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(web, '../out/web-profile-layout'); mkdirSync(out,{recursive:true});
await build({stdin:{contents:`
import {render} from 'preact'; import {ProfileEditor} from './src/components/ProfileEditor';
import {AccountPopoverHost,openAccountPopover} from './src/components/AccountPopover';
import {fixtureSession} from './src/fixtures';
import './src/styles/base.css'; import './src/styles/frame.css'; import './src/styles/call.css'; import './src/styles/modals.css';
import './src/styles/profile.css'; import './src/styles/account-popover.css';
document.documentElement.dataset.theme='midnight';
const session=fixtureSession('default'); session.profile={display_name:'Teste',pronouns:null,bio:null,note:null,banner_color:'#000000',profile_theme_start:null,profile_theme_end:null,avatarDataUrl:'',bannerDataUrl:'',hasAvatar:false,hasBanner:false};
window.sent=[]; const bridge={send(c){window.sent.push(c);return 'test';},request(c){window.sent.push(c);return Promise.resolve(c.name==='saveOwnProfile'?{...session.profile,...c.fields}:session.profile);},onMessage(){}};
const account=new URLSearchParams(location.search).has('account');
render(account?<AccountPopoverHost session={session} bridge={bridge}/>:<ProfileEditor session={session} bridge={bridge} onClose={()=>{window.closedProfile=true;}}/>,document.getElementById('app'));
if(account){const anchor=document.createElement('button');anchor.textContent='Abrir conta';anchor.style='position:fixed;bottom:16px;left:16px;width:100px;height:48px';anchor.onclick=()=>openAccountPopover(anchor);document.body.append(anchor);}
`,resolveDir:web,sourcefile:'profile-check.tsx',loader:'tsx'},bundle:true,outfile:resolve(out,'fixture.js'),jsx:'automatic',jsxImportSource:'preact'});
writeFileSync(resolve(out,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="app"></div><script src="fixture.js"></script>');
const browser=await chromium.launch({channel:'msedge',headless:true}); const checks=[];
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.goto(pathToFileURL(resolve(out,'index.html')).href);
 await page.getByLabel('Nome de exibição',{exact:true}).waitFor();
 const geometry=await page.evaluate(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};return {editor:box('.tri-profile-editor'),left:box('.tri-profile-editor__appearance'),card:box('.tri-profile-preview'),right:box('.tri-profile-editor__details'),banner:box('.tri-profile-preview__banner'),avatar:box('.tri-profile-preview__avatar')};});
 assert.equal(geometry.editor.w,1168);assert.equal(geometry.left.w,240);assert.equal(geometry.card.w,400);
 assert.equal(geometry.card.x-geometry.left.x-geometry.left.w,32);assert.equal(geometry.right.x-geometry.card.x-geometry.card.w,32);
 checks.push('three columns:240px appearance,400px card,32px gaps in1168px shell');
 assert.equal(geometry.banner.h,140);assert.equal(geometry.avatar.w,136);assert.ok(geometry.avatar.y<geometry.banner.y+geometry.banner.h);
 checks.push('400x140 banner and120px avatar with8px ring overlap');
 await page.getByLabel('Nome de exibição',{exact:true}).fill('Novo nome');
 await page.getByRole('button',{name:'Salvar alterações',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Perfil salvo.'}).waitFor();
 assert.equal(await page.evaluate(()=>window.sent.find(c=>c.name==='saveOwnProfile').fields.display_name),'Novo nome');
 checks.push('text fields and existing save action remain functional');
 await page.screenshot({path:resolve(out,'profile-desktop.png')});
 await page.setViewportSize({width:600,height:800});
 assert.ok(await page.evaluate(()=>document.querySelector('.tri-profile-editor').getBoundingClientRect().right<=innerWidth));
 checks.push('narrow window stacks fields without pushing shell outside viewport');
 await page.goto(pathToFileURL(resolve(out,'index.html')).href+'?account');
  await page.getByRole('button',{name:'Abrir conta'}).click();
 await page.getByRole('dialog',{name:'Sua conta'}).waitFor();
 const g=await page.evaluate(()=>{const r=document.querySelector('.tri-account-popover').getBoundingClientRect(),b=document.querySelector('.tri-account-popover__banner').getBoundingClientRect(),a=document.querySelector('.tri-account-popover__avatar').getBoundingClientRect();return{width:r.width,banner:b.height,avatar:a.width,overlap:a.y<b.bottom};});
 assert.deepEqual(g,{width:300,banner:104,avatar:88,overlap:true});checks.push('account popover300px,banner104px,overlapping88px avatar');
 await page.getByRole('button',{name:'Editar status personalizado'}).click();
 await page.getByLabel('Status personalizado',{exact:true}).fill('Jogando');
 await page.getByRole('button',{name:'Salvar status'}).click();
 assert.ok(await page.evaluate(()=>window.sent.some(c=>c.name==='setCustomStatus'&&c.text==='Jogando')));
 checks.push('status bubble reveals working status editor');
 await page.screenshot({path:resolve(out,'account.png')});
 writeFileSync(resolve(out,'report.json'),JSON.stringify({passed:checks.length,checks,geometry},null,2));console.log(JSON.stringify({passed:checks.length,checks}));
}finally{await browser.close();}
