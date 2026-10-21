// Pure presentation-state regression: no browser, renderer, devices or account data.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/call-status.ts',import.meta.url))],bundle:true,write:false,platform:'node',format:'esm'});
const {callStatus}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const session={connection:'connected',voiceRequested:true,camera:false};
for(const [voiceState,label,tone] of [
  ['connecting','Conectando à voz…','pending'],
  ['reconnecting','Reconectando a voz…','pending'],
  ['error','Falha na conexão de voz','critical'],
  ['connected','Voz conectada','positive'],
  ['idle','Aguardando conexão de voz','neutral'],
]) assert.deepEqual(callStatus({...session,voiceState}),{state:voiceState,label,tone});
assert.equal(callStatus({...session,voiceState:'idle',voiceRequested:false}).label,'Voz desconectada');
assert.equal(callStatus({...session,voiceState:'connected',camera:true}).label,'Vídeo conectado');
assert.equal(callStatus({...session,connection:'reconnecting',voiceState:'connected'}).state,'connected','control reconnect does not invalidate an independently connected media transport');
assert.equal(callStatus({...session,voiceState:'connecting'}).tone,'pending','control connected does not imply audio connected');
assert.equal(callStatus(session).state,'connected','legacy snapshots without a media state retain their control fallback');
console.log('Call status: media state, control fallback and non-connected labels passed');
