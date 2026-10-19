// Development-only inert module recovery. Never evaluates the input bundle.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [source, output, parserRoot, ...ids] = process.argv.slice(2);
if (!source || !output || !parserRoot || !ids.length || fs.existsSync(output))
  throw new Error('Supply a retained bundle, new output directory, parser dependency root and numeric module IDs');
if (ids.some(id => !/^\d+$/.test(id))) throw new Error('Numeric module IDs required');
const parser = require(require.resolve('@babel/parser', {paths:[parserRoot]}));
const bytes = fs.readFileSync(source), text = bytes.toString('utf8');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const modules = [];
for (const id of ids) {
  const start = new RegExp(`(?:^|[},])(${id}\\([^)]*\\)\\{)`, 'g').exec(text);
  if (!start) throw new Error(`Module ${id} not found in selected bundle`);
  const index = start.index + start[0].length - start[1].length;
  const next = /\},\d+\([^)]*\)\{/g; next.lastIndex = index + start[1].length;
  const end = next.exec(text);
  if (!end || end.index-index > 500000) throw new Error(`Unbounded module extent: ${id}`);
  const body = text.slice(index,end.index+1);
  // A candidate boundary is accepted only if a real JS parser validates it.
  // Do not silently truncate or recover past a failed boundary.
  parser.parseExpression(`({${body}})`, {sourceType:'script'});
  const offset = Buffer.byteLength(text.slice(0,index)), size = Buffer.byteLength(body);
  if (!bytes.subarray(offset,offset+size).equals(Buffer.from(body))) throw new Error('Byte provenance mismatch');
  modules.push({id,byteOffset:offset,byteLength:size,sha256:hash(Buffer.from(body)),body});
}
const fragment = `(this.webpackChunkdiscord_app=this.webpackChunkdiscord_app||[]).push([['recovered-markdown'],{${modules.map(m=>m.body).join(',')}}]);\n`;
parser.parse(fragment,{sourceType:'script'});
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'modules.js'),fragment,{flag:'wx'});
fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify({
  source:path.resolve(source),sourceSha256:hash(bytes),sourceBytes:bytes.length,
  modules:modules.map(({body,...entry})=>entry),
  limitations:['Synthetic Webpack container; exact original module bytes retained.',
    'Focused module inventory; unresolved dependencies do not establish absence.',
    'Source was not evaluated and no runtime behavior was observed.']
},null,2),{flag:'wx'});
console.log(JSON.stringify({modules:modules.map(m=>({id:m.id,bytes:m.byteLength})),output}));
