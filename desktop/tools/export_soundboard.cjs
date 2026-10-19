// Development-only migration. Reads a cloned Electron IndexedDB profile.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [profile, output] = process.argv.slice(2).map(value => path.resolve(value));
if (!profile || !output) throw new Error('Pass legacy profile and an output directory');
const clone = path.join(output, 'migration-profile');
fs.mkdirSync(clone, { recursive: true });
fs.cpSync(path.join(profile, 'IndexedDB'), path.join(clone, 'IndexedDB'), { recursive: true });
app.setPath('userData', clone);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const html = path.join(output, 'migration.html'); fs.writeFileSync(html, '<!doctype html><meta charset="utf-8">');
  await window.loadFile(html);
  const records = await window.webContents.executeJavaScript(`(async () => {
    const db = await new Promise((resolve,reject) => { const request=indexedDB.open('triscord-soundboard'); request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); });
    if (!db.objectStoreNames.contains('sounds')) throw new Error('Legacy soundboard store not found');
    const records=await new Promise((resolve,reject)=>{const request=db.transaction('sounds','readonly').objectStore('sounds').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const result=[];
    for(const record of records) {
      if(record.deleted || !record.data) continue;
      const bytes=record.data instanceof Blob ? new Uint8Array(await record.data.arrayBuffer()) : new Uint8Array(record.data);
      let text=''; for(let i=0;i<bytes.length;i+=8192) text+=String.fromCharCode(...bytes.subarray(i,i+8192));
      result.push({id:record.id,name:record.name,emoji:record.emoji,mime:record.mime,addedBy:record.addedBy,data:btoa(text)});
    }
    db.close(); return result;
  })()`);
  const sounds = path.join(output, 'sounds'); fs.mkdirSync(sounds, { recursive: true });
  const manifest=[];
  for (const record of records) {
    const bytes=Buffer.from(record.data,'base64'); const id=crypto.createHash('sha256').update(bytes).digest('hex');
    if (id !== record.id || bytes.length > 1024*1024 || !bytes.length) throw new Error('Invalid legacy clip');
    const {data,...meta}=record; fs.writeFileSync(path.join(sounds,id),bytes); manifest.push(meta);
  }
  fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2));
  console.log('Exported '+manifest.length+' verified soundboard clips'); window.destroy(); app.quit();
}).catch(error=>{console.error(error.message);app.exit(1);});
