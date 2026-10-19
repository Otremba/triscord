import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export function loadImage(root, entry) {
  if (!entry) return null;
  if (typeof entry.path !== 'string') throw Error('Captura precisa de path.');
  const filename = fs.realpathSync(path.resolve(root, entry.path));
  if (!inside(root, filename)) throw Error('Captura fora do workspace: ' + entry.path);
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw Error('Captura inválida ou maior que 20 MB.');
  const bytes = fs.readFileSync(filename);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii',12,16) !== 'IHDR')
    throw Error('A captura deve ser PNG: ' + entry.path);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > 20_000_000) throw Error('Dimensões da captura inválidas ou excessivas.');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (entry.sha256 && entry.sha256 !== sha256) throw Error('Hash divergente: ' + entry.path);
  const dpi = entry.dpi ?? null;
  if (dpi !== null && (!Number.isFinite(dpi) || dpi <= 0)) throw Error('DPI inválido.');
  return {path:entry.path,width,height,sha256,dpi,state:entry.state ?? null,
    origin:entry.origin ?? 'unverified',note:entry.note ?? '',data:'data:image/png;base64,' + bytes.toString('base64')};
}
export function prepare(root, manifest) {
  if (!Array.isArray(manifest.pairs) || manifest.pairs.length > 100) throw Error('Manifesto deve conter até 100 pares.');
  const ids = new Set();
  return manifest.pairs.map(pair => {
    if (typeof pair.id !== 'string' || !pair.id || ids.has(pair.id)) throw Error('Identificador ausente ou duplicado.');
    ids.add(pair.id);
    const reference = loadImage(root,pair.reference), implementation = loadImage(root,pair.implementation);
    const issues = [];
    if (!reference) issues.push('Falta captura real do Discord.');
    if (!implementation) issues.push('Falta captura do triscord.');
    if (reference && reference.origin !== 'observed-discord') issues.push('Origem da referência ainda não confirmada como Discord observado.');
    if (reference && implementation) {
      if (reference.width !== implementation.width || reference.height !== implementation.height) issues.push('Dimensões diferentes: sobreposição bloqueada.');
      if (!reference.dpi || !implementation.dpi) issues.push('Escala/DPI não registrados.');
      else if (reference.dpi !== implementation.dpi) issues.push('Escala/DPI diferentes.');
      if (!reference.state || !implementation.state || reference.state !== implementation.state) issues.push('Estado correspondente não confirmado.');
    }
    return {id:pair.id,title:pair.title ?? pair.id,notes:pair.notes ?? '',reference,implementation,issues,
      status:issues.length ? 'pending' : 'ready-for-review'};
  });
}
export function build({root,manifestPath,out}) {
  root=fs.realpathSync(root);
  manifestPath=fs.realpathSync(path.resolve(root,manifestPath));
  if(!inside(root,manifestPath)) throw Error('Manifesto fora do workspace.');
  out=path.resolve(root,out);
  if(!inside(root,out)) throw Error('Saída fora do workspace.');
  // Validate the nearest existing ancestor too, to prevent symlink output escapes.
  let ancestor=out;
  while(!fs.existsSync(ancestor)) ancestor=path.dirname(ancestor);
  if(!inside(root,fs.realpathSync(ancestor))) throw Error('Saída redirecionada fora do workspace.');
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  const pairs=prepare(root,manifest);
  const totalImageBytes=pairs.reduce((sum,p)=>sum+(p.reference?.data.length??0)+(p.implementation?.data.length??0),0);
  if(totalImageBytes>70*1024*1024) throw Error('Relatório excede o limite de 70 MB de imagens incorporadas.');
  const payload={version:1,createdAt:new Date().toISOString(),title:manifest.title ?? 'Comparação visual do triscord',pairs};
  const template=fs.readFileSync(new URL('./viewer.html',import.meta.url),'utf8');
  const json=JSON.stringify(payload).replace(/</g,'\\u003c');
  const html=template.replace('__REVIEW_DATA__',json);
  fs.mkdirSync(out,{recursive:true});
  for(const name of ['index.html','audit.json']) {
    const target=path.join(out,name);
    if(fs.existsSync(target)&&!inside(root,fs.realpathSync(target))) throw Error('Arquivo de saída redirecionado fora do workspace.');
  }
  fs.writeFileSync(path.join(out,'index.html'),html);
  const metadata={...payload,pairs:pairs.map(p=>({...p,reference:p.reference&&{...p.reference,data:undefined},implementation:p.implementation&&{...p.implementation,data:undefined}}))};
  fs.writeFileSync(path.join(out,'audit.json'),JSON.stringify(metadata,null,2));
  return {html:path.join(out,'index.html'),pairs:pairs.length,pending:pairs.filter(p=>p.status==='pending').length};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2), options={root:process.cwd()};
  for(let n=0;n<args.length;n+=2) {
    const key={'--manifest':'manifestPath','--out':'out','--root':'root'}[args[n]];
    if(!key || !args[n+1]) throw Error('Uso: node build.mjs --manifest arquivo.json --out pasta [--root workspace]');
    options[key]=args[n+1];
  }
  if(!options.manifestPath||!options.out) throw Error('Informe --manifest e --out.');
  console.log(JSON.stringify(build(options)));
}
