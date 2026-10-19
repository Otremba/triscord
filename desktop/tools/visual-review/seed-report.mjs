import fs from 'node:fs';
import path from 'node:path';
import {build} from './build.mjs';
const root=process.cwd();
const output='desktop/out/codex-coordination-20261014/visual-review';
const states=[
 ['voice-call','Chamada · tela completa','native-navigation-call.png'],
 ['voice-call-narrow','Chamada · janela estreita','native-navigation-narrow.png'],
 ['voice-muted','Microfone silenciado e fala ativa','native-calls-grid.png'],
 ['voice-disconnected','Fora da chamada',null],
 ['voice-reconnect','Reconectando',null],
 ['camera-card','Câmera · cartão','native-camera-card.png'],
 ['camera-focus','Câmera · participante em destaque','native-camera-focus.png'],
 ['share-monitors','Compartilhar · telas','native-share-picker.png'],
 ['share-windows','Compartilhar · janelas',null],
 ['share-system-audio','Compartilhar · áudio do sistema',null],
 ['streams-two','Duas transmissões','native-dual-stream-layout.png'],
 ['stream-fullscreen','Transmissão · tela cheia',null],
 ['stream-pip','Transmissão · janela flutuante',null],
 ['stream-loading','Transmissão · carregamento/erro',null],
 ['chat-messages','Chat · mensagens e reações','native-chat-layout.png'],
 ['chat-grouping','Chat · agrupamento','native-chat-grouped.png'],
 ['chat-markdown','Chat · formatação','native-chat-markdown.png'],
 ['chat-spoiler','Chat · spoiler revelado','native-chat-revealed.png'],
 ['chat-composer','Chat · campo de mensagem','chat-composer.png'],
 ['chat-delete','Chat · excluir mensagem',null],
 ['settings','Configurações · dispositivos','native-settings.png'],
 ['soundboard','Soundboard','native-soundboard.png']
];
const captures=path.join(root,output,'captures');fs.mkdirSync(captures,{recursive:true});
const pairs=states.map(([id,title,file])=>{
 let implementation=null;
 if(file&&fs.existsSync(path.join(root,'desktop/out',file))) {
   const bytes=fs.readFileSync(path.join(root,'desktop/out',file));
   fs.writeFileSync(path.join(captures,file),bytes);
   implementation={path:path.join(output,'captures',file).split(path.sep).join('/'),
     origin:'triscord-test-fixture',state:id,dpi:null,
     note:'Captura existente de teste do triscord. DPI não medido; participantes/vídeo podem ser injetados. Não comprova WAN nem fidelidade.'};
 }
 return{id,title,notes:'Falta obter a tela correspondente do Discord real e registrar escala/estado. Nunca usar esta captura como referência do Discord.',reference:null,implementation};
});
const manifestPath=path.join(output,'manifest.json');
fs.writeFileSync(path.join(root,manifestPath),JSON.stringify({title:'Progresso da comparação visual — triscord',pairs},null,2));
console.log(JSON.stringify(build({root,manifestPath,out:output})));
