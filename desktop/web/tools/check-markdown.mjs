// Native parser -> inert AST -> real Preact renderer, in a private headless Edge page.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const web=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(web,'../..');
const out=resolve(web,'../out/web-markdown');mkdirSync(out,{recursive:true});
const texts=[
 '# Heading\n-# Subtext\n**bold _nested italic_** __underlined__ ~~struck~~ and `literal <b>`',
 '||[secret](https://example.com/secret)||',
 '<img src=x onerror=alert(1)> [bad](javascript:alert(1)) <file:/tmp/a>',
 '```html\n<img onerror=alert(1)>\n```',
 '> quote\n\n- first\n- second\n\n3. third\n4. fourth',
 '**unclosed',
 'https://example.com/a',
];
const input=resolve(out,'input.json');writeFileSync(input,JSON.stringify(texts));
const env={...process.env,PATH:[resolve(root,'.toolchain/Qt/6.8.3/mingw_64/bin'),process.env.PATH].join(';')};
const native=JSON.parse(execFileSync(resolve(web,'../out/markdown-web-fixture.exe'),[input],{env,encoding:'utf8'}));
assert.equal(native.nativeLinkChecks,7);
await build({stdin:{contents:`
import {render} from 'preact';import {Markdown,relativeTimestamp} from './src/components/Markdown';import {ChatPanel} from './src/components/ChatPanel';
import './src/styles/base.css';import './src/styles/frame.css';import './src/styles/chat.css';
document.documentElement.dataset.theme='midnight';window.calls=[];window.relativeTimestamp=relativeTimestamp;
const bridge={send(c){window.calls.push(c);return 'test';},request(c){window.calls.push(c);return Promise.resolve();},onMessage(){}};
const texts=${JSON.stringify(texts)},nodes=${JSON.stringify(native.items)};
render(<>{texts.map((text,i)=><section id={'case'+i}><Markdown nodes={nodes[i]} text={text} messageId={'m'+i} bridge={bridge}/></section>)}
<section id="fallback"><Markdown text="**plain fixture without AST**" messageId="fallback" bridge={bridge}/></section>
<section id="bad-tree"><Markdown nodes={[{type:'link',href:'javascript:alert(1)',children:[{type:'text',text:'Bad tree target'}]}]} text="" messageId="bad-tree" bridge={bridge}/></section>
</>,document.getElementById('app'));`,resolveDir:web,sourcefile:'markdown-check.tsx',loader:'tsx'},bundle:true,outfile:resolve(out,'fixture.js'),jsx:'automatic',jsxImportSource:'preact'});
writeFileSync(resolve(out,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="app"></div><script src="fixture.js"></script>');
const browser=await chromium.launch({channel:'msedge',headless:true});const checks=[];
try {
 const page=await browser.newPage({viewport:{width:900,height:900}});await page.goto(pathToFileURL(resolve(out,'index.html')).href);
 assert.equal(await page.locator('#case0 h1').textContent(),'Heading');assert.equal(await page.locator('#case0 .tri-markdown__subtext').textContent(),'Subtext');
 assert.equal(await page.locator('#case0 strong em').textContent(),'nested italic');assert.equal(await page.locator('#case0 u').textContent(),'underlined');assert.equal(await page.locator('#case0 s').textContent(),'struck');checks.push('native heading/subtext/nested emphasis/underline/strike render as typed elements');
 assert.equal(await page.locator('#case0 code').textContent(),'literal <b>');assert.equal(await page.locator('#case3 pre code').textContent(),'<img onerror=alert(1)>');checks.push('inline and fenced code preserve literal content');
 assert.equal(await page.locator('img,script:not([src]),iframe').count(),0);assert.equal(await page.locator('#case2 a,#bad-tree a').count(),0);checks.push('HTML stays text; native and renderer reject javascript/file link targets');
 const spoiler=page.getByRole('button',{name:'Revelar spoiler'});assert.equal(await page.locator('#case1 a').count(),0);
 await spoiler.click();assert.equal(await page.evaluate(()=>window.calls.length),0);assert.equal(await page.locator('#case1 a').count(),1);
 await page.locator('#case1 a').click();assert.deepEqual(await page.evaluate(()=>window.calls),[{name:'openChatLink',messageId:'m1',url:'https://example.com/secret'}]);checks.push('first spoiler click reveals without navigating; second link click requests validated native opening');
 assert.ok((await page.locator('#case4 blockquote').textContent()).includes('quote'));assert.equal(await page.locator('#case4 ul li').count(),2);assert.equal(await page.locator('#case4 ol').getAttribute('start'),'3');checks.push('quotes and unordered/ordered lists preserve structure and start number');
 assert.ok((await page.locator('#case5').textContent()).includes('**unclosed'));assert.equal(await page.locator('#fallback').textContent(),'**plain fixture without AST**');checks.push('unclosed markup and old DTOs retain readable text');
 await page.locator('#case6 a').click();assert.equal(await page.evaluate(()=>window.calls.at(-1).url),'https://example.com/a');checks.push('bare URLs work through native request instead of leaving the app origin');
 for(const value of native.relative) assert.equal(await page.evaluate(v=>window.relativeTimestamp(Number(v.seconds),v.now),value),value.label);
 checks.push('relative timestamp labels match12 native formatter threshold cases');
 await page.screenshot({path:resolve(out,'markdown.png')});
 writeFileSync(resolve(out,'report.json'),JSON.stringify({passed:checks.length,nativeLinkChecks:native.nativeLinkChecks,relativeCases:native.relative.length,checks},null,2));console.log(JSON.stringify({passed:checks.length,nativeLinkChecks:native.nativeLinkChecks,relativeCases:native.relative.length,checks}));
}finally{await browser.close();}
