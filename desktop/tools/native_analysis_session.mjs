// Development-only REA session. Keeps one immutable native import open for
// evidence queries; nothing from this helper is shipped in the client.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [reaRepo, runtimeRoot, target, directory] = process.argv.slice(2);
if (!reaRepo || !runtimeRoot || !target || !directory) throw new Error('Pass REA repo, runtime root, target and a new session directory');
const dir=path.resolve(directory);
fs.mkdirSync(dir);
const {Client}=await import(pathToFileURL(path.join(reaRepo,'node_modules/@modelcontextprotocol/client/dist/index.mjs')));
const {StdioClientTransport,getDefaultEnvironment}=await import(pathToFileURL(path.join(reaRepo,'node_modules/@modelcontextprotocol/client/dist/stdio.mjs')));
const client=new Client({name:'triscord-native-analysis',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(reaRepo,'scripts/rea.mjs'),'--mcp'],cwd:reaRepo,
 env:{...getDefaultEnvironment(),GHIDRA_INSTALL_DIR:path.join(runtimeRoot,'ghidra/ghidra_12.1.4_PUBLIC'),
 JAVA_HOME:path.join(runtimeRoot,'jdk/jdk-21.0.12.1+1'),REA_GHIDRA_STARTUP_TIMEOUT_MS:'1800000'},stderr:'pipe'});
transport.stderr.on('data',data=>fs.appendFileSync(path.join(dir,'server.log'),data));
const status=phase=>fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({phase,ownerPid:process.pid,updatedAt:new Date().toISOString(),target}));
const allowed=new Set(['search_strings','xrefs','analyze_function','read_function_instructions','list_strings','binary_session']);
try {
 await client.connect(transport);
 const catalog=await client.listTools(); fs.writeFileSync(path.join(dir,'catalog.json'),JSON.stringify(catalog));
 status('opening');
 const opened=await client.callTool({name:'open_binary',arguments:{path:path.resolve(target),provider_id:'ghidra'}},{timeout:1900000});
 fs.writeFileSync(path.join(dir,'open.json'),JSON.stringify(opened));
 if(opened.isError) throw new Error('REA failed to open the target; inspect open.json');
 status('ready');
 while(true) {
   const jobs=fs.readdirSync(dir).filter(name=>/^request-[a-z0-9-]+\.json$/.test(name)).sort();
   let closing=false;
   for(const name of jobs) {
     const output=path.join(dir,name.replace('request-','response-'));
     if(fs.existsSync(output)) continue;
     const job=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
     if(job.name==='close') {fs.writeFileSync(output,JSON.stringify({closed:true}));closing=true;break;}
     if(!allowed.has(job.name) || !catalog.tools.some(tool=>tool.name===job.name)) {fs.writeFileSync(output,JSON.stringify({error:'read-only tool not admitted'}));continue;}
     status('querying');
     try {
       const result=await client.callTool({name:job.name,arguments:job.arguments||{}},{timeout:1900000});
       fs.writeFileSync(output,JSON.stringify(result));
     } catch(error) {fs.writeFileSync(output,JSON.stringify({error:String(error.message)}));}
     status('ready');
   }
   if(closing) break;
   await new Promise(resolve=>setTimeout(resolve,500));
 }
} catch(error) {status('failed');fs.writeFileSync(path.join(dir,'error.txt'),String(error.stack));process.exitCode=1;}
finally {await client.close();if(process.exitCode!==1)status('closed');}
