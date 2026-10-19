// Real Preact components in headless Edge; no account, native windows or audio devices.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = resolve(desktop, 'web'), out = resolve(desktop, 'out/review-fixes-ui');
const require = createRequire(resolve(web, 'package.json'));
const {build} = require('esbuild'), {chromium} = require('@playwright/test');
mkdirSync(out, {recursive: true});
async function fixture(name, source) {
  await build({stdin: {contents: source, resolveDir: web, sourcefile: `${name}.tsx`, loader: 'tsx'},
    bundle: true, outfile: resolve(out, `${name}.js`), jsx: 'automatic', jsxImportSource: 'preact'});
  writeFileSync(resolve(out, `${name}.html`), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${name}.css"><div id="app"></div><script src="${name}.js"></script>`);
  return pathToFileURL(resolve(out, `${name}.html`)).href;
}
const menu = await fixture('menu', `
import {render} from 'preact'; import {ContextMenuHost,openContextMenu} from './src/components/ContextMenu';
import './src/styles/menu.css'; render(<ContextMenuHost/>,document.getElementById('app'));
window.picks=0; window.parentPicks=0;
window.show=()=>openContextMenu(new MouseEvent('contextmenu',{clientX:120,clientY:100}),[
 {kind:'item',label:'Unavailable',disabled:true,submenu:[{kind:'item',label:'Never',action:()=>{}}],action:()=>{}},
 {kind:'item',label:'Camera',action:()=>window.parentPicks++,submenu:[
  {kind:'item',label:'Disabled',disabled:true,action:()=>{}},
  {kind:'item',label:'Device',action:()=>window.picks++}]}]);`);
const call = await fixture('call', `
import {render} from 'preact'; import {useState} from 'preact/hooks';
import {CallView} from './src/components/CallView'; import {ContextMenuHost} from './src/components/ContextMenu';
import {fixtureSession} from './src/fixtures'; import './src/styles/base.css'; import './src/styles/call.css';
import './src/styles/call-view-controls.css'; import './src/styles/menu.css';
const s=fixtureSession('default');
const user={id:'alice',name:'Alice',self:false,camera:false,live:true,muted:false,deafened:false,speaking:false,volume:100,pan:0,streamVolume:100,streamMuted:false};
const room={id:'room',name:'Geral',kind:'voice',users:[user]};
s.connectedChannelId='room';s.callChannel=room;s.categories=[{id:'voice',name:'Voz',channels:[room]}];
s.streams=[{id:'scr:alice',ownerId:'alice',kind:'screen',title:'Alice',width:1280,height:720,path:'native-overlay',hidden:false}];
const listeners=new Set(); window.nativeMenu=()=>listeners.forEach(fn=>fn({name:'videoContextMenu',streamId:'scr:alice',x:250,y:250}));
const bridge={send(){return'test';},request(){return Promise.resolve();}};
const store={onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
function App(){const [focus,setFocus]=useState({key:null,filmOpen:true});return <><CallView session={s} bridge={bridge} store={store} focus={focus} onFocus={setFocus}/><ContextMenuHost/></>;}
localStorage.setItem('tri-call-show-nonvideo','0');render(<App/>,document.getElementById('app'));`);
const browser = await chromium.launch({channel: 'msedge', headless: true});
const checks = [];
try {
  const page = await browser.newPage({viewport:{width:1100,height:800}});
  await page.goto(menu); await page.waitForTimeout(250);
  await page.evaluate(()=>window.show()); await page.getByRole('menu').waitFor(); await page.waitForTimeout(100);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight');
  await page.getByRole('menuitem',{name:'Device',exact:true}).waitFor();
  assert.equal(await page.locator('.tri-menu__submenu-anchor .is-focused').textContent(),'Device');
  checks.push('Right arrow opens submenu, focuses first enabled device and skips disabled rows');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu').count(),1);
  assert.equal(await page.getByRole('menuitem',{name:'Device',exact:true}).count(),0);
  await page.keyboard.press('Enter'); await page.getByRole('menuitem',{name:'Device',exact:true}).waitFor();
  await page.keyboard.press('ArrowLeft'); assert.equal(await page.getByRole('menu').count(),1);
  await page.keyboard.press('Enter'); await page.getByRole('menuitem',{name:'Device',exact:true}).waitFor();
  await page.keyboard.press('Enter'); await page.locator('.tri-menu-layer').waitFor({state:'hidden'});
  assert.equal(await page.getByRole('menu').count(),0);
  assert.deepEqual(await page.evaluate(()=>[window.picks,window.parentPicks]),[1,0]);
  checks.push('Enter selects device once; Escape/Left return focus to parent without closing it');
  await page.evaluate(()=>window.show()); await page.getByRole('menuitem',{name:'Camera',exact:true}).hover();
  await page.getByRole('menuitem',{name:'Device',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>[window.picks,window.parentPicks]),[2,0]);
  checks.push('Mouse submenu selection still works and does not trigger the parent action');
  await page.goto(call); await page.locator('.tri-video-tile').waitFor(); await page.waitForTimeout(250);
  assert.equal(await page.locator('.tri-video-tile').count(),1);
  await page.locator('.tri-video-tile').dispatchEvent('contextmenu',{bubbles:true,cancelable:true,clientX:250,clientY:250});
  await page.getByRole('menu').waitFor();
  assert.equal(await page.getByRole('menuitem',{name:'Perfil',exact:true}).count(),1);
  await page.keyboard.press('Escape'); await page.evaluate(()=>window.nativeMenu());
  await page.getByRole('menu').waitFor();
  assert.equal(await page.getByRole('menuitem',{name:'Perfil',exact:true}).count(),1);
  checks.push('Screen owner menu works with non-video participants hidden, for DOM and native video events');
  await page.keyboard.press('Escape'); await page.locator('.tri-video-tile').click();
  await page.locator('.tri-call-focus').waitFor();
  assert.equal(await page.locator('.tri-call-card--film').count(),0);
  assert.equal(await page.locator('.tri-video-tile').count(),1);
  checks.push('Focused filmstrip also respects the non-video participant filter');
  writeFileSync(resolve(out,'result.json'),JSON.stringify({passed:true,checks},null,2));
  console.log(checks.map(c=>'PASS: '+c).join('\n'));
} finally { await browser.close(); }
