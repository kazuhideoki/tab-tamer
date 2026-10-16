// Disposable Brave profile; transport feasibility only, not a production importer.
import {mkdtemp,writeFile,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import http from 'node:http';
const root=await mkdtemp(join(tmpdir(),'tab-tamer-transport-'));
const ext=join(root,'extension');await mkdir(ext);
await writeFile(join(ext,'manifest.json'),JSON.stringify({manifest_version:3,name:'Tab Tamer transport probe',version:'0.0.1',permissions:['storage'],host_permissions:['http://127.0.0.1/*'],background:{service_worker:'worker.js'},externally_connectable:{matches:['http://127.0.0.1/*']}}));
await writeFile(join(ext,'apply.html'),'<script src="apply.js"></script>');
await writeFile(join(ext,'apply.js'),`(async()=>{const base=decodeURIComponent(location.hash.slice(1));const config=await (await fetch(base+'/config')).json();await chrome.storage.local.set({probe:config});const stored=(await chrome.storage.local.get('probe')).probe;await fetch(base+'/ack',{method:'POST',body:JSON.stringify({ok:true,stored})});})().catch(console.error);`);
await writeFile(join(ext,'worker.js'),`chrome.runtime.onMessageExternal.addListener((m,s,reply)=>{if(new URL(s.url).hostname!=='127.0.0.1')return; (async()=>{if(m.action==='apply')await chrome.storage.local.set({probe:m.config});reply({ok:true,stored:(await chrome.storage.local.get('probe')).probe});})().catch(e=>reply({ok:false,error:String(e)}));return true;});`);
let extensionId,ackResolve;const ack=new Promise(r=>ackResolve=r);
const server=http.createServer((req,res)=>{console.log('HTTP',req.method,req.url);if(req.url==='/config'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({schema_version:1,probe:'command-only'}));return;}if(req.url==='/ack'&&req.method==='POST'){let b='';req.on('data',x=>b+=x);req.on('end',()=>{res.end('ok');ackResolve(JSON.parse(b));});return;}res.setHeader('Content-Type','text/html');res.end(`<script>window.onerror=(m)=>fetch('/ack',{method:'POST',body:JSON.stringify({pageError:m})});fetch('/stage');chrome.runtime.sendMessage('${extensionId}',{action:'apply',config:{schema_version:1,probe:'command-only'}},r=>fetch('/ack',{method:'POST',body:JSON.stringify(r||{error:chrome.runtime.lastError?.message})}));</script>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let child,socket;let n=0;const pending=new Map();
async function rpc(method,params={}){let id=++n;let result=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));socket.send(JSON.stringify({id,method,params}));return result;}
try{
 child=spawn('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',[`--user-data-dir=${join(root,'profile')}`,`--load-extension=${ext}`,`--disable-extensions-except=${ext}`,...(process.argv.includes('--visible') ? [] : ['--headless=new']),'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
 let portInfo;for(let i=0;i<100;i++){try{portInfo=await readFile(join(root,'profile','DevToolsActivePort'),'utf8');break;}catch{await new Promise(r=>setTimeout(r,100));}}
 if(!portInfo)throw Error('No DevTools endpoint');
 const [port,path]=portInfo.trim().split('\n');socket=new WebSocket(`ws://127.0.0.1:${port}${path}`);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j});
 socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}};
 for(let i=0;i<50;i++){const t=await rpc('Target.getTargets');const w=t.targetInfos.find(t=>t.url.startsWith('chrome-extension://') && t.url.endsWith('/worker.js'));if(w){extensionId=new URL(w.url).host;break;}await new Promise(r=>setTimeout(r,100));}
 if(!extensionId)throw Error('Extension not loaded');
 const base=`http://127.0.0.1:${server.address().port}`;
 const url=process.argv.includes('--extension-page') ? `chrome-extension://${extensionId}/apply.html#${encodeURIComponent(base)}` : base+'/apply';
 if(process.argv.includes('--browser-command')){const launch=spawn('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',[`--user-data-dir=${join(root,'profile')}`,url],{stdio:'ignore'});await new Promise((r,j)=>{launch.on('error',j);launch.on('exit',r)});}else await rpc('Target.createTarget',{url});
 let timer;const result=await Promise.race([ack,new Promise((_,j)=>{timer=setTimeout(()=>j(Error('ACK timeout')),30000)})]).finally(()=>clearTimeout(timer));
 console.log(JSON.stringify({profile:root,extensionId,result}));
 await rpc('Browser.close');
}finally{socket?.close();child?.kill();server.close();}
