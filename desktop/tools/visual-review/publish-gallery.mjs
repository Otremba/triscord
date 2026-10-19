// Builds only the explicitly selected, reviewed interface screenshots for static hosting.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root=process.cwd();
const output=path.join(root,'desktop/out/codex-coordination-20261014/cloudflare-gallery');
const assets=path.join(output,'public');fs.mkdirSync(assets,{recursive:true});
const selection=[
 ['principal','Tela principal','native-navigation-call.png'],
 ['estreita','Janela menor','native-navigation-narrow.png'],
 ['controles','Controles da chamada','native-calls-controls.png'],
 ['seletor','Seleção de compartilhamento','native-share-picker.png'],
 ['transmissoes','Duas transmissões','native-dual-stream-layout.png'],
 ['mensagem','Campo de mensagem com várias linhas','chat-composer.png'],
 ['chat','Mensagens e reações','native-chat-layout.png'],
 ['agrupamento','Mensagens agrupadas','native-chat-grouped.png'],
 ['datas','Separação por data','native-chat-dates.png'],
 ['formatacao','Formatação de texto','native-chat-markdown.png'],
 ['spoiler','Spoiler revelado','native-chat-revealed.png'],
 ['configuracoes','Configurações de dispositivos','native-settings.png'],
 ['sons','Soundboard','native-soundboard.png'],
 ['camera','Cartão de câmera · imagem de teste','native-camera-card.png'],
 ['foco','Participante em destaque · imagens de teste','native-camera-focus.png']
];
const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=value=>new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}).format(new Date(value));
const captures=selection.map(([id,title,filename])=>{
 const source=path.join(root,'desktop/out',filename),stat=fs.statSync(source),bytes=fs.readFileSync(source);
 if(bytes.length!==stat.size||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Captura em gravação ou inválida: '+filename);
 const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
 const asset=id+'-'+sha256.slice(0,12)+'.png';fs.writeFileSync(path.join(assets,asset),bytes);
 return{id,title,asset,sha256,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),capturedAt:stat.mtime.toISOString()};
});
const generatedAt=new Date().toISOString();
const html=`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>triscord · progresso da interface</title><style>
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#080808;color:#eee;font:16px system-ui,sans-serif}header,main,footer{max-width:1180px;margin:auto;padding:24px}h1{font-size:30px;margin:0 0 10px}p{line-height:1.6;color:#aaa}.tag{font-size:13px;display:inline-block;padding:5px 10px;border:1px solid #555;border-radius:20px;margin-bottom:14px}nav{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}a{color:#ddd}nav a{font-size:14px;padding:8px 12px;background:#202020;border:1px solid #333;border-radius:6px;text-decoration:none}article{margin:0 0 28px;border:1px solid #333;border-radius:10px;background:#111;overflow:hidden;scroll-margin-top:16px}article h2{font-size:19px;margin:0;padding:16px 18px}article p{font-size:13px;margin:0;padding:0 18px 14px}figure{margin:0;padding:12px;background:#000;text-align:center}img{display:block;max-width:100%;height:auto;margin:auto}figcaption{padding:12px;color:#aaa;font-size:13px}footer{font-size:13px;padding-bottom:48px}strong{color:#eee}@media(max-width:600px){header,main,footer{padding:18px}h1{font-size:25px}article h2{font-size:17px}}
</style><header><span class="tag">Em desenvolvimento</span><h1>triscord · interface atual</h1><p>Galeria publicada em <strong>${date(generatedAt)} (Brasília)</strong>. São capturas do aplicativo com dados de teste; participantes e vídeos podem ser simulados. A fidelidade ao Discord ainda está em revisão.</p><p>Último avanço verificado: controles repetidos de microfone, áudio e configurações foram retirados do rodapé; controles de chamada estão na área central. Navegação e chamadas continuam em revisão, configurações em andamento e entrega final pendente.</p><nav aria-label="Telas">${captures.map(c=>`<a href="#${c.id}">${escape(c.title)}</a>`).join('')}</nav></header><main>${captures.map(c=>`<article id="${c.id}"><h2>${escape(c.title)}</h2><p>Captura: ${date(c.capturedAt)} · ${c.width} × ${c.height} pixels</p><figure><a href="/${c.asset}" target="_blank" rel="noopener"><img src="/${c.asset}" alt="${escape(c.title)}" width="${c.width}" height="${c.height}" loading="lazy"></a><figcaption>Toque na imagem para abrir em tamanho original.</figcaption></figure></article>`).join('')}</main><footer>Esta galeria é um retrato do progresso no horário indicado. Não é uma transmissão ao vivo e não comprova testes entre computadores ou aprovação final.</footer></html>`;
fs.writeFileSync(path.join(assets,'index.html'),html);
fs.writeFileSync(path.join(assets,'captures.json'),JSON.stringify({generatedAt,captures},null,2));
fs.writeFileSync(path.join(assets,'_headers'),'/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Robots-Tag: noindex, nofollow\n  Content-Security-Policy: default-src \'none\'; img-src \'self\'; style-src \'unsafe-inline\'; base-uri \'none\'; frame-ancestors \'none\'\n');
fs.writeFileSync(path.join(output,'wrangler.json'),JSON.stringify({name:'triscord-interface',account_id:'6560ec793840e7fe4bfdfc063795428c',compatibility_date:'2026-10-14',workers_dev:true,assets:{directory:'./public',html_handling:'auto-trailing-slash',not_found_handling:'404-page',run_worker_first:false}},null,2));
console.log(JSON.stringify({output,images:captures.length,totalBytes:captures.reduce((n,c)=>n+fs.statSync(path.join(assets,c.asset)).size,0),generatedAt}));
