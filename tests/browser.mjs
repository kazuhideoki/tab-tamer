// Isolated Brave checks. Headless by default; --headed explicitly enables OS focus tests.
import {mkdtemp,readFile,writeFile,mkdir,rm,cp} from 'node:fs/promises';import {openSync,closeSync} from 'node:fs';import {join,resolve} from 'node:path';import {spawn} from 'node:child_process';import http from 'node:http';import assert from 'node:assert/strict';
const headed=process.argv.includes('--headed');
if(process.argv.slice(2).some(arg=>arg!=='--headed'))throw Error('Usage: node tests/browser.mjs [--headed]');
console.log(`Browser mode: ${headed?'headed (uses OS focus)':'headless (no OS focus)'}`);
const root=resolve('.');await mkdir('.work',{recursive:true});const work=await mkdtemp(join(root,'.work/brave-'));const profile=join(work,'profile');
// This fixture models a page opened before extension update without altering runtime code.
const testExtension=join(work,'extension');await cp(join(root,'dist'),testExtension,{recursive:true});
const testManifest=JSON.parse(await readFile(join(testExtension,'manifest.json'),'utf8'));
for(const script of testManifest.content_scripts)if(script.js.some(file=>['suspension-guard.js','media-watch.js'].includes(file)))script.exclude_matches=['http://127.0.0.1/legacy-resident-toggle'];
await writeFile(join(testExtension,'manifest.json'),JSON.stringify(testManifest));
const brave='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';const identity=JSON.parse(await readFile('.tab-tamer/identity.json','utf8'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));let browser,ws,workerSession;let seq=0;const requests=new Map();const results=[],skipped=[];
function command(cmd,args){return new Promise((resolve,reject)=>{const p=spawn(cmd,args,{cwd:root,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('exit',code=>code===0?resolve(out):reject(Error(`${cmd}: ${err||out}`)));});}
let slowGate=Promise.resolve(),releaseSlow;
let interactionGate=Promise.resolve(),releaseInteraction;
const server=http.createServer((req,res)=>{
 if(!headed&&req.url==='/test-open'&&req.method==='POST'){
  let body='';req.on('data',b=>body+=b);req.on('end',async()=>{
   try{const {url}=JSON.parse(body);assert.ok(url.startsWith(`chrome-extension://${identity.id}/apply.html#`));await rpc('Target.createTarget',{url});res.end('ok');}
   catch(e){res.statusCode=400;res.end(String(e));}
  });return;
 }
 if(req.url.startsWith('/interaction-asset')){interactionGate.then(()=>{res.writeHead(204);res.end();});return;}
 if(req.url.startsWith('/initial-server')){res.writeHead(302,{Location:'/initial-client'});res.end();return;}
 if(req.url.startsWith('/initial-client')){res.setHeader('Content-Type','text/html');res.end('<!doctype html><script>setTimeout(()=>location.replace("/initial-spa?kind=route"),100)</script>');return;}
 if(req.url.startsWith('/initial-spa')){
  const kind=new URL(req.url,'http://localhost').searchParams.get('kind');
  const final=kind==='hash'?'/target#initial':`/target?initial=${kind}`;
  const script=kind==='delayed'?`onload=()=>{setTimeout(()=>history.replaceState({},"","/intermediate"),200);setTimeout(()=>history.replaceState({},"",${JSON.stringify(final)}),400)}`:`history.replaceState({},"",${JSON.stringify(final)})`;
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Initial SPA</title><script>${script}</script>`);return;
 }
 if(req.url.startsWith('/interactive')){
  const mode=new URL(req.url,'http://localhost').searchParams.get('mode');
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>User navigation</title><a id="navigate" href="${mode==='new'?'/initial-server':'/target'}" ${mode==='new'?'target="_blank"':''}>Navigate</a><img src="/interaction-asset">${mode==='spa'?'<script>document.querySelector("a").onclick=e=>{e.preventDefault();history.pushState({},"","/target")}</script>':''}`);return;
 }
 if(req.url.startsWith('/slow')){slowGate.then(()=>{res.writeHead(302,{Location:'/target'});res.end();});return;}
 if(req.url.startsWith('/suspension')||req.url==='/legacy-resident-toggle'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Suspension test</title><input aria-label=Draft><iframe src="/frame"></iframe>');return;}
 if(req.url.startsWith('/target-spa')){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>SPA initial state</title><script>history.replaceState({ready:true},"",location.href)</script>');return;}
 res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Tab Tamer acceptance</title><h1>Test page</h1><a href="/target" target="_blank">Open target</a>');
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
// The CLI still signs, serves and verifies the real request. Only URL delivery is
// adapted: a second headless Chromium process cannot forward URLs to the first.
const launcher=join(work,'open-in-test-browser');
await writeFile(launcher,`#!/usr/bin/env node
const response=await fetch(${JSON.stringify(base+'/test-open')},{method:'POST',body:JSON.stringify({url:process.argv.at(-1)})});
if(!response.ok)throw Error(await response.text());
`,{mode:0o700});
const cliBrowserArgs=headed?[]:['--browser',launcher];
await writeFile(join(work,'config.toml'),`version=1\n[dedup]\nsettle_ms=300\n[[groups]]\nid="test"\nname="Tab Tamer Test"\ncolor="blue"\nurls=["${base}/target*"]\n`);
function rpc(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{requests.delete(id);reject(Error('CDP timeout: '+method));},45000);requests.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(Error(JSON.stringify(e)));}});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
async function start(){
 await rm(join(profile,'DevToolsActivePort'),{force:true});
 const logFd=openSync(join(work,'browser.log'),'a');
 browser=spawn(brave,[...(headed?[]:['--headless=new']),`--user-data-dir=${profile}`,`--load-extension=${testExtension}`,`--disable-extensions-except=${testExtension}`,'--enable-logging=stderr','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--restore-last-session','about:blank'],{stdio:['ignore','ignore',logFd]});closeSync(logFd);
 let info;for(let i=0;i<150;i++){try{info=await readFile(join(profile,'DevToolsActivePort'),'utf8');break;}catch{await delay(100);}}if(!info)throw Error('No browser endpoint');
 const [port,path]=info.trim().split('\n');ws=new WebSocket(`ws://127.0.0.1:${port}${path}`);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Debugger.paused'){console.log('Worker debugger paused, resuming');ws.send(JSON.stringify({id:++seq,method:'Debugger.resume',sessionId:m.sessionId}));}const p=requests.get(m.id);if(p){requests.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}};
 let target;for(let i=0;i<100;i++){const {targetInfos}=await rpc('Target.getTargets');target=targetInfos.find(t=>t.url===`chrome-extension://${identity.id}/worker.js`);if(target)break;await delay(100);}if(!target)throw Error('Worker not loaded');workerSession=null;
 await focusBrowser();
 await delay(5500); // Startup/session-restore guard, not part of event timing assertions.
}
async function evaluate(code){try{
 if(!workerSession){
  const {targetId}=await rpc('Target.createTarget',{url:`chrome-extension://${identity.id}/status.html`});
  workerSession=(await rpc('Target.attachToTarget',{targetId,flatten:true})).sessionId;
  await delay(300);
 }
 const r=await rpc('Runtime.evaluate',{expression:`(async()=>{${code}})()`,awaitPromise:true,returnByValue:true},workerSession);
 if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;
}catch(e){throw Error(e.message+' evaluating '+code.slice(0,160));}}

async function stop(){if(ws?.readyState===1)ws.send(JSON.stringify({id:++seq,method:'Browser.close'}));await delay(1500);ws?.close();if(browser?.exitCode===null)browser.kill('SIGTERM');await delay(500);}
async function tabs(){return evaluate('return await chrome.tabs.query({});');}
async function focusBrowser(){
 if(!headed)return;
 await command('osascript',['-e',`tell application "System Events" to set frontmost of (first application process whose unix id is ${browser.pid}) to true`]);
 await delay(300);
}
async function clickLink(url){
 const {targetInfos}=await rpc('Target.getTargets');const page=targetInfos.find(t=>t.type==='page'&&t.url===url);assert.ok(page);
 const {sessionId}=await rpc('Target.attachToTarget',{targetId:page.targetId,flatten:true});
 try {
  const box=await rpc('Runtime.evaluate',{expression:'(()=>{const r=document.querySelector("#navigate").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',returnByValue:true},sessionId);
  const {x,y}=box.result.value;
  await rpc('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1},sessionId);
  await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1},sessionId);
 }finally{await rpc('Target.detachFromTarget',{sessionId});}
}
async function check(name,fn){const match=process.env.TAB_TAMER_TEST_MATCH;if(match&&!/signed CLI|automatic grouping/.test(name)&&!new RegExp(match).test(name)){skipped.push(name);console.log('SKIP',name);return;}console.log('RUN',name);await focusBrowser();await fn();results.push({name,ok:true});console.log('PASS',name);}
const json=JSON.stringify;let target,other,window1;
try{
 await start();
 await check('signed CLI apply without manual reload',async()=>{
  const output=await command('./tab-tamer',['apply',...cliBrowserArgs,'--config',join(work,'config.toml'),'--user-data-dir',profile]);assert.match(output,/apply: verified/);
  const saved=await evaluate('return (await chrome.storage.local.get("configRecord")).configRecord;');assert.equal(saved.config.groups.length,1);
 });
 await focusBrowser();await delay(700);
 ({target,other,window1}=await evaluate(`const w=await chrome.windows.create({url:${json(base+'/target')},focused:true});return {target:w.tabs[0].id,window1:w.id};`));
 await delay(1000);other=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(base+'/other')},active:true})).id;`);await delay(800);
 await check('automatic grouping',async()=>{const t=(await tabs()).find(t=>t.id===target);assert.notEqual(t.groupId,-1);const g=await evaluate(`return await chrome.tabGroups.get(${t.groupId});`);assert.equal(g.title,'Tab Tamer Test');});
 await check('Markdown clipboard button and idle worker recovery',async()=>{
  const expected=`[Tab Tamer acceptance](${base}/other)`;
  const pageTarget=(await rpc('Target.getTargets')).targetInfos.find(t=>t.url===base+'/other');
  const pageSession=(await rpc('Target.attachToTarget',{targetId:pageTarget.targetId,flatten:true})).sessionId;
  const toast=async()=> (await rpc('Runtime.evaluate',{expression:"document.querySelector('[data-tab-tamer-toast]')?.shadowRoot.textContent ?? null",returnByValue:true},pageSession)).result.value;
  const invoke=async()=>{
   await evaluate(`await chrome.tabs.update(${other},{active:true});await chrome.windows.update(${window1},{focused:true});document.querySelector('#copy-markdown').click();`);
   for(let i=0;i<50;i++){
    const state=await evaluate("return {busy:document.querySelector('#copy-markdown').disabled,text:document.querySelector('#copy-result').textContent};");
    if(!state.busy){assert.equal(state.text,'Markdown形式でコピーしました');break;}
    if(i===49)throw Error('copy timed out');await delay(100);
   }
   assert.equal(await toast(),'✓ Markdown形式でコピーしました');
   await rpc('Browser.grantPermissions',{origin:`chrome-extension://${identity.id}`,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
   assert.equal(headed?await command('pbpaste',[]):await evaluate('return await navigator.clipboard.readText();'),expected);
  };
  await invoke();
  await delay(2500);assert.equal(await toast(),null,'toast disappears automatically');
  const shortcuts=await evaluate('return await chrome.commands.getAll();');
  assert.ok(shortcuts.find(c=>c.name==='copy-markdown')?.shortcut,'shortcut must be assigned');
  // Do not attach a debugger to the worker: allow its normal idle shutdown.
  // Isolate idle shutdown from the new periodic maintenance alarm. It is recreated on wake.
  await evaluate("await chrome.alarms.clear('tab-tamer-suspension');");
  await delay(40000);
  const targets=(await rpc('Target.getTargets')).targetInfos;
  assert.ok(!targets.some(t=>t.type==='service_worker'&&t.url===`chrome-extension://${identity.id}/worker.js`),'worker should suspend during idle');
  await invoke();
  if(headed){
   await evaluate(`await chrome.runtime.sendMessage({target:'clipboard',text:'before shortcut'});await chrome.tabs.update(${other},{active:true});await chrome.windows.update(${window1},{focused:true});`);
   await focusBrowser();
   await command('osascript',['-e',`tell application "System Events" to tell (first application process whose unix id is ${browser.pid}) to keystroke "c" using {control down, shift down}`]);
   await delay(500);
   assert.equal(await command('pbpaste',[]),expected);
  }
  // Also recover when the offscreen document itself no longer exists.
  await evaluate('await chrome.offscreen.closeDocument();');
  await invoke();
 });
 await check('foreground duplicate expands collapsed group and reuses old tab',async()=>{
  const g=(await tabs()).find(t=>t.id===target).groupId;await evaluate(`await chrome.tabGroups.update(${g},{collapsed:true});`);
  assert.equal((await evaluate(`return await chrome.tabGroups.get(${g});`)).collapsed,true);
  await evaluate(`await chrome.windows.update(${window1},{focused:true});`);
  assert.ok((await evaluate(`return await chrome.windows.get(${window1});`)).focused,'test window must be foreground');
  const n=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(base+'/target')},active:true})).id;`);await delay(1300);
  const all=await tabs();assert.ok(!all.some(t=>t.id===n));assert.ok(all.find(t=>t.id===target).active);assert.equal((await evaluate(`return await chrome.tabGroups.get(${g});`)).collapsed,false);
 });
 await check('discarded grouped target is reused',async()=>{
  await evaluate(`await chrome.tabs.update(${other},{active:true});await chrome.tabs.discard(${target});`);
  target=(await tabs()).find(t=>t.url===base+'/target').id;
  assert.equal((await tabs()).find(t=>t.id===target).discarded,true);
  await focusBrowser();await evaluate(`await chrome.windows.update(${window1},{focused:true});`);
  const n=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(base+'/target')},active:true})).id;`);await delay(1600);
  assert.ok(!(await tabs()).some(t=>t.id===n));assert.ok((await tabs()).find(t=>t.id===target).active);
 });
 await check('initial same-URL history update reuses grouped target',async()=>{
  const url=base+'/target-spa';
  const first=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(url)},active:true})).id;`);await delay(900);
  assert.notEqual((await tabs()).find(t=>t.id===first).groupId,-1);
  await focusBrowser();await evaluate(`await chrome.windows.update(${window1},{focused:true});`);
  const second=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(url)},active:true})).id;`);await delay(1400);
  assert.ok(!(await tabs()).some(t=>t.id===second),'initial history.replaceState must not exempt a duplicate');
  assert.ok((await tabs()).find(t=>t.id===first).active);
  const background=await evaluate(`await chrome.tabs.update(${other},{active:true});return (await chrome.tabs.create({windowId:${window1},url:${json(url)},active:false})).id;`);await delay(1000);
  assert.ok(!(await tabs()).some(t=>t.id===background));assert.ok((await tabs()).find(t=>t.id===other).active);
  await evaluate(`await chrome.tabs.update(${other},{url:${json(url)},active:true});`);await delay(1000);
  assert.ok((await tabs()).some(t=>t.id===other),'existing-tab navigation remains allowed');
  await evaluate(`await chrome.tabs.update(${other},{url:${json(base+'/other')}});await chrome.tabs.remove(${first});`);await delay(600);
 });
 await check('automatic initial SPA URL changes reuse final foreground and background targets',async()=>{
  for(const kind of ['route','hash','delayed']){
   const url=base+(kind==='hash'?'/target#initial':`/target?initial=${kind}`);
   const first=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(url)},active:false})).id;`);await delay(700);
   // Background page timers are throttled by Brave, so a post-load timer can
   // legitimately run after the initial settling window has already ended.
   for(const active of kind==='delayed'?[true]:[true,false]){
    await focusBrowser();await evaluate(`await chrome.tabs.update(${other},{active:true});`);
    const second=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(base+'/initial-spa?kind='+kind)},active:${active}})).id;`);await delay(1400);
    const all=await tabs();assert.ok(!all.some(t=>t.id===second),`${kind}, active=${active}`);
    assert.ok(all.find(t=>t.id===(active?first:other)).active);
   }
   await evaluate(`await chrome.tabs.update(${other},{active:true});await chrome.tabs.remove(${first});`);
  }
 });
 await check('HTTP and client redirect chain reuses the final SPA destination',async()=>{
  const first=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(base+'/target?initial=route')},active:false})).id;`);await delay(700);
  const second=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(base+'/initial-server')},active:true})).id;`);await delay(1600);
  assert.ok(!(await tabs()).some(t=>t.id===second));assert.ok((await tabs()).find(t=>t.id===first).active);
  await evaluate(`await chrome.tabs.update(${other},{active:true});await chrome.tabs.remove(${first});`);
 });
 for(const mode of ['link','spa'])await check(`trusted same-tab ${mode} navigation during initial loading retains duplicates`,async()=>{
  interactionGate=new Promise(resolve=>{releaseInteraction=resolve;});const url=base+'/interactive?mode='+mode;
  const n=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(url)},active:true})).id;`);await delay(400);
  assert.equal((await tabs()).find(t=>t.id===n)?.status,'loading');await clickLink(url);releaseInteraction();await delay(1100);
  assert.equal((await tabs()).find(t=>t.id===n)?.url,base+'/target');
  await evaluate(`await chrome.tabs.update(${other},{active:true});await chrome.tabs.remove(${n});`);
 });
 await check('trusted link opening a new tab still deduplicates after redirects',async()=>{
  const first=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(base+'/target?initial=route')},active:false})).id;`);await delay(700);
  interactionGate=new Promise(resolve=>{releaseInteraction=resolve;});const url=base+'/interactive?mode=new';
  const opener=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(url)},active:true})).id;`);await delay(400);
  await clickLink(url);releaseInteraction();await delay(1600);
  const all=await tabs();assert.ok(all.some(t=>t.id===opener));assert.equal(all.filter(t=>t.url===base+'/target?initial=route').length,1);assert.ok(all.find(t=>t.id===first).active);
  await evaluate(`await chrome.tabs.update(${other},{active:true});await chrome.tabs.remove([${opener},${first}]);`);
 });
 await check('explicit tab duplication retains the copied tab',async()=>{
  const copy=await evaluate(`return (await chrome.tabs.duplicate(${target})).id;`);await delay(1100);
  assert.ok((await tabs()).some(t=>t.id===copy));await evaluate(`await chrome.tabs.update(${other},{active:true});await chrome.tabs.remove(${copy});`);
 });
 await check('background duplicate preserves selection and collapsed group',async()=>{
  const g=(await tabs()).find(t=>t.id===target).groupId;await evaluate(`await chrome.tabs.update(${other},{active:true});await chrome.tabGroups.update(${g},{collapsed:true});`);
  const n=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(base+'/target')},active:false})).id;`);await delay(1300);
  const all=await tabs();assert.ok(!all.some(t=>t.id===n));assert.ok(all.find(t=>t.id===other).active);assert.equal((await evaluate(`return await chrome.tabGroups.get(${g});`)).collapsed,true);
 });
 let window2;
 await check('cross-window foreground reuses target window',async()=>{
  window2=await evaluate(`return (await chrome.windows.create({url:${json(base+'/second')},focused:true})).id;`);await delay(800);
  const n=await evaluate(`return (await chrome.tabs.create({windowId:${window2},url:${json(base+'/target')},active:true})).id;`);await delay(1400);
  assert.ok(!(await tabs()).some(t=>t.id===n));assert.ok((await evaluate(`return await chrome.windows.get(${window1});`)).focused);assert.ok((await tabs()).find(t=>t.id===target).active);
 });
 await check('user switch during redirect is not overridden',async()=>{
  slowGate=new Promise(resolve=>{releaseSlow=resolve;});
  const n=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(base+'/slow')},active:true})).id;`);await delay(150);
  assert.equal((await tabs()).find(t=>t.id===n)?.status,'loading');
  await evaluate(`await chrome.tabs.update(${other},{active:true});`);releaseSlow();await delay(1600);
  assert.ok((await tabs()).find(t=>t.id===other).active);assert.ok(!(await tabs()).some(t=>t.id===n));
 });
 await check('existing-tab navigation is never deduplicated',async()=>{
  await evaluate(`await chrome.tabs.update(${other},{url:${json(base+'/target')},active:true});`);await delay(1200);assert.ok((await tabs()).some(t=>t.id===other));
  await evaluate(`await chrome.tabs.update(${other},{url:${json(base+'/other')},active:true});`);await delay(700);
 });
 await check('rapid new duplicates leave one survivor',async()=>{
  const ids=await evaluate(`const ids=[];for(let i=0;i<3;i++)ids.push((await chrome.tabs.create({windowId:${window1},url:${json(base+'/target')},active:true})).id);return ids;`);await delay(1600);
  const all=await tabs();assert.equal(all.filter(t=>t.url===base+'/target').length,1);assert.ok(all.some(t=>t.id===target));assert.ok(ids.every(id=>!all.some(t=>t.id===id)));
 });
 await check('query and fragment remain distinct',async()=>{
  for(const suffix of ['?q=1','#section']){const n=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(base+'/target'+suffix)},active:false})).id;`);await delay(900);assert.ok((await tabs()).some(t=>t.id===n));}
 });
 await check('browser link opens a new tab and reuses the existing page',async()=>{
  await evaluate(`await chrome.windows.update(${window1},{focused:true});await chrome.tabs.update(${other},{active:true});`);
  const {targetInfos}=await rpc('Target.getTargets');const page=targetInfos.find(t=>t.type==='page'&&t.url===base+'/other');assert.ok(page);
  const session=(await rpc('Target.attachToTarget',{targetId:page.targetId,flatten:true})).sessionId;
  await rpc('Runtime.evaluate',{expression:"document.querySelector('a').click()",userGesture:true},session);
  await delay(1800);const all=await tabs();assert.equal(all.filter(t=>t.url===base+'/target').length,1);assert.ok(all.find(t=>t.id===target).active);
  await rpc('Target.detachFromTarget',{sessionId:session});
 });
 if(headed)await check('external browser command reuses existing page',async()=>{
  await evaluate(`globalThis.testEvents=[];chrome.tabs.onCreated.addListener(t=>testEvents.push(['created',t]));chrome.tabs.onUpdated.addListener((id,c)=>testEvents.push(['updated',id,c]));chrome.webNavigation.onCommitted.addListener(d=>{if(d.frameId===0)testEvents.push(['committed',d]);});chrome.webNavigation.onErrorOccurred.addListener(d=>testEvents.push(['error',d]));`);
  await evaluate(`await chrome.tabs.update(${other},{active:true});`);
  await command(brave,[`--user-data-dir=${profile}`,base+'/target']);await delay(1800);
  const all=await tabs();assert.equal(all.filter(t=>t.url===base+'/target').length,1);assert.ok(all.find(t=>t.id===target).active);
 });
 if(headed)await check('macOS open launch reuses existing page',async()=>{
  await evaluate(`await chrome.tabs.update(${other},{active:true});`);
  await command('open',['-n','-a','/Applications/Brave Browser.app','--args',`--user-data-dir=${profile}`,base+'/target']);await delay(1800);
  const all=await tabs();assert.equal(all.filter(t=>t.url===base+'/target').length,1);assert.ok(all.find(t=>t.id===target).active);
 });
 if(process.env.TAB_TAMER_TEST_GITHUB)await check('GitHub expanded group reuses an initially opened repository',async()=>{
  const url='https://github.com/octocat/Hello-World';
  const first=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(url)},active:true})).id;`);
  for(let i=0;i<100;i++){if((await tabs()).find(t=>t.id===first)?.status==='complete')break;await delay(150);}
  assert.equal((await tabs()).find(t=>t.id===first)?.status,'complete');await delay(500);
  const group=await evaluate(`return await chrome.tabs.group({tabIds:[${first}]});`);
  await evaluate(`await chrome.tabGroups.update(${group},{title:'GitHub regression',color:'grey',collapsed:false});await chrome.windows.update(${window1},{focused:true});`);
  const second=await evaluate(`return (await chrome.tabs.create({windowId:${window1},url:${json(url)},active:true})).id;`);
  for(let i=0;i<100;i++){if(!(await tabs()).some(t=>t.id===second))break;await delay(150);}
  assert.ok(!(await tabs()).some(t=>t.id===second));assert.ok((await tabs()).find(t=>t.id===first).active);
  await evaluate(`await chrome.tabs.remove(${first});`);
 });
 await check('config apply updates existing group metadata without reload',async()=>{
  const groupId=(await tabs()).find(t=>t.id===target).groupId;
  const path=join(work,'config.toml');const text=await readFile(path,'utf8');await writeFile(path,text.replace('Tab Tamer Test','Renamed Test').replace('color="blue"','color="green"'));
  assert.match(await command('./tab-tamer',['apply',...cliBrowserArgs,'--config',path,'--user-data-dir',profile]),/apply: verified/);await delay(500);
  const group=await evaluate(`return await chrome.tabGroups.get(${groupId});`);assert.equal(group.title,'Renamed Test');assert.equal(group.color,'green');
 });
 await check('invalid config never reaches browser',async()=>{
  await writeFile(join(work,'invalid.toml'),'version=1\n[dedup]\nenabled="yes"\n');const before=await evaluate('return (await chrome.storage.local.get("configRecord")).configRecord.hash;');
  await assert.rejects(command('./tab-tamer',['apply',...cliBrowserArgs,'--config',join(work,'invalid.toml'),'--user-data-dir',profile]));assert.equal(await evaluate('return (await chrome.storage.local.get("configRecord")).configRecord.hash;'),before);
 });
 await check('CLI status verifies persisted hash',async()=>{assert.match(await command('./tab-tamer',['status',...cliBrowserArgs,'--user-data-dir',profile]),/status: verified/);});
 await check('legacy resident toggle preserves open input without reloading the page',async()=>{
  const url=base+'/legacy-resident-toggle';
  const legacy=await evaluate(`return await chrome.tabs.create({windowId:${window1},url:${json(url)},active:true});`);await delay(500);
  const target=(await rpc('Target.getTargets')).targetInfos.find(t=>t.url===url);
  const sessionId=(await rpc('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
  await rpc('Runtime.evaluate',{expression:'window.legacyMarker=Math.random();document.querySelector("input").focus()'},sessionId);
  await rpc('Input.insertText',{text:'unsaved test draft'},sessionId);
  const before=(await rpc('Runtime.evaluate',{expression:'({marker:legacyMarker,draft:document.querySelector("input").value})',returnByValue:true},sessionId)).result.value;
  // This fixture has no guard, matching an existing document after an extension update.
  const probe=await evaluate(`return await chrome.tabs.sendMessage(${legacy.id},{type:'suspension-probe'},{frameId:0}).catch(()=>null);`);
  assert.ok(probe==null,'the legacy fixture must have no content receiver');
  for(const mode of ['on','off','pin']){
   const result=await evaluate(`return await chrome.runtime.sendMessage({type:'suspension-set',tabId:${legacy.id},mode:${json(mode)}});`);
   assert.equal(result.mode,mode);assert.equal(result.resident,mode==='on');
  }
  const after=(await rpc('Runtime.evaluate',{expression:'({marker:legacyMarker,draft:document.querySelector("input").value})',returnByValue:true},sessionId)).result.value;
  assert.deepEqual(after,before,'the original document and unsaved input must remain intact');
  assert.ok((await evaluate(`return await chrome.tabs.sendMessage(${legacy.id},{type:'suspension-probe'},{frameId:0}).catch(()=>null);`))==null,'identity fallback must not fake protection coverage');
  await rpc('Target.detachFromTarget',{sessionId});
  await evaluate(`await chrome.tabs.remove(${legacy.id});`);
 });
 let suspensionTabs;
 await check('automatic suspension protects input, media, resident and every selected tab',async()=>{
  const path=join(work,'suspension.toml');await writeFile(path,(await readFile(join(work,'config.toml'),'utf8'))+'\n[suspension]\nidle_minutes=1\n');
  assert.match(await command('./tab-tamer',['apply',...cliBrowserArgs,'--config',path,'--user-data-dir',profile]),/apply: verified/);
  await evaluate(`await chrome.windows.update(${window1},{focused:true});`);
  suspensionTabs=await evaluate(`const ids={};for(const name of ['idle','pinned','resident','draft','media'])ids[name]=(await chrome.tabs.create({windowId:${window1},url:${json(base)}+'/suspension?'+name,active:name!=='idle'})).id;return ids;`);
  await delay(1200);
  const ids=suspensionTabs;
  await evaluate(`await chrome.tabs.update(${ids.pinned},{pinned:true,active:true});`);await delay(100);
  assert.equal((await evaluate(`return await chrome.runtime.sendMessage({type:'suspension-set',tabId:${ids.pinned},mode:'off'});`)).mode,'off');
  await evaluate(`await chrome.tabs.update(${ids.resident},{active:true});`);await delay(100);
  assert.equal((await evaluate(`return await chrome.runtime.sendMessage({type:'suspension-set',tabId:${ids.resident},mode:'on'});`)).resident,true);
  const badge=await evaluate('return await chrome.action.getBadgeText({});');
  for(const name of ['draft','media']){
   const page=(await rpc('Target.getTargets')).targetInfos.find(t=>t.url===base+'/suspension?'+name);
   const sessionId=(await rpc('Target.attachToTarget',{targetId:page.targetId,flatten:true})).sessionId;
   await evaluate(`await chrome.tabs.update(${ids[name]},{active:true});`);
   if(name==='draft'){
    await rpc('Runtime.evaluate',{expression:'document.querySelector("input").focus()'},sessionId);
    await rpc('Input.insertText',{text:'private draft never sent to extension'},sessionId);
   }else await rpc('Runtime.evaluate',{expression:'window.testConnection=new RTCPeerConnection()'},sessionId);
   await rpc('Target.detachFromTarget',{sessionId});
  }
  // Leave one selected tab in a background window as well.
  const selectedWindow=await evaluate(`return await chrome.windows.create({url:${json(base+'/suspension?selected')},focused:false});`);
  ids.selected=selectedWindow.tabs[0].id;
  await evaluate(`await chrome.tabs.update(${other},{active:true});await chrome.windows.update(${window1},{focused:true});`);
  const since=await evaluate(`return (await chrome.storage.session.get('suspension')).suspension[${ids.idle}].since;`);
  await rpc('ServiceWorker.enable',{},workerSession);await rpc('ServiceWorker.stopAllWorkers',{},workerSession);
  // A runtime message wakes the stopped worker; the old deadline must remain.
  await evaluate(`return await chrome.runtime.sendMessage({type:'status'});`);
  assert.equal(await evaluate(`return (await chrome.storage.session.get('suspension')).suspension[${ids.idle}].since;`),since);
  const deadline=Date.now()+125000;
  while(Date.now()<deadline){const all=await tabs();if(['idle','pinned'].every(name=>all.find(t=>t.url===base+'/suspension?'+name)?.discarded))break;await delay(1000);}
  const all=await tabs();
  // Brave may replace the tab ID when discarding; resolve test fixtures by their unique URL.
  for(const name of Object.keys(ids))ids[name]=all.find(t=>t.url===base+'/suspension?'+name)?.id;
  for(const name of ['idle','pinned'])assert.equal(all.find(t=>t.id===ids[name])?.discarded,true,name);
  for(const name of ['resident','draft','media','selected'])assert.equal(all.find(t=>t.id===ids[name])?.discarded,false,name);
  assert.equal(await evaluate('return await chrome.action.getBadgeText({});'),badge,'suspension does not change copy badges');
  await evaluate(`await chrome.windows.update(${selectedWindow.id},{focused:true});`);await delay(200);
  assert.equal((await tabs()).find(t=>t.id===ids.idle)?.discarded,true,'window focus does not wake background tabs');
  await evaluate(`await chrome.tabs.update(${ids.idle},{active:true});await chrome.windows.update(${window1},{focused:true});`);
  if(!headed){const page=(await rpc('Target.getTargets')).targetInfos.find(t=>t.url===base+'/suspension?idle');if(page)await rpc('Target.activateTarget',{targetId:page.targetId});}
  await delay(900);
  if(headed){await focusBrowser();await delay(500);assert.equal((await tabs()).find(t=>t.id===ids.idle)?.discarded,false,'selecting a discarded tab restores it');}
  else {skipped.push('native focus restoration (headless)');console.log('SKIP native focus restoration (headless)');}
  // Exercise the real popup controls as well as the background protocol.
  await evaluate(`await chrome.tabs.update(${ids.resident},{active:true});`);
  const popupTab=await evaluate(`return await chrome.tabs.create({windowId:${window1},url:chrome.runtime.getURL('status.html'),active:false});`);
  // Find the new view by its tab ID using the extension target, then attach by URL/window order.
  const popupTargets=(await rpc('Target.getTargets')).targetInfos.filter(t=>t.url===`chrome-extension://${identity.id}/status.html`&&t.type==='page');
  let popupSession;
  for(const target of popupTargets){const candidate=(await rpc('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;const r=await rpc('Runtime.evaluate',{expression:'chrome.tabs.getCurrent().then(t=>t.id)',awaitPromise:true,returnByValue:true},candidate);if(r.result.value===popupTab.id){popupSession=candidate;break;}await rpc('Target.detachFromTarget',{sessionId:candidate});}
  assert.ok(popupSession);workerSession=popupSession;
  await rpc('Page.reload',{},workerSession);await delay(500);
  assert.match(await evaluate("return document.querySelector('#resident-state').textContent;"),/オン（手動指定）/);
  await evaluate("document.querySelector('#resident-pin').click();");await delay(200);
  assert.match(await evaluate("return document.querySelector('#resident-state').textContent;"),/オフ（Pinに連動）/);
  await evaluate("document.querySelector('#resident-toggle').click();");await delay(200);
  assert.match(await evaluate("return document.querySelector('#resident-state').textContent;"),/オン（手動指定）/);
  const screenshot=await rpc('Page.captureScreenshot',{format:'png'},workerSession);
  await writeFile(join(work,'popup.png'),Buffer.from(screenshot.data,'base64'));
  // Keep the resident page selected at shutdown so Chrome restores its identity immediately.
 });
 const savedHash=await evaluate('return (await chrome.storage.local.get("configRecord")).configRecord.hash;');
 await stop();await start();
 await check('configuration survives browser restart',async()=>{assert.equal(await evaluate('return (await chrome.storage.local.get("configRecord")).configRecord.hash;'),savedHash);assert.match(await command('./tab-tamer',['status',...cliBrowserArgs,'--user-data-dir',profile]),/status: verified/);const id=await evaluate(`return (await chrome.tabs.create({url:${json(base+'/target?restart=1')},active:false})).id;`);await delay(1200);assert.notEqual((await tabs()).find(t=>t.id===id).groupId,-1);});
 await check('manual resident identity survives real browser restoration without spreading to the same URL',async()=>{
  assert.ok(suspensionTabs,'run the suspension case first');
  let restored;
  for(let i=0;i<30;i++){restored=(await tabs()).find(t=>t.url===base+'/suspension?resident');if(restored&&!restored.discarded&&restored.status==='complete')break;await delay(200);}
  assert.ok(restored,'resident tab restored');
  if(!headed&&restored.discarded){await evaluate(`await chrome.tabs.reload(${restored.id});`);await delay(900);}
  await evaluate(`await chrome.tabs.update(${restored.id},{active:true});await chrome.windows.update(${restored.windowId},{focused:true});`);
  const state=await evaluate(`return await chrome.runtime.sendMessage({type:'suspension-status',tabId:${restored.id}});`);
  assert.equal(state.mode,'on');assert.equal(state.resident,true);
  const snapshot=await evaluate("return (await chrome.storage.session.get('suspension')).suspension;");
  for(const t of (await tabs()).filter(t=>t.url?.startsWith(base+'/suspension?')))assert.ok(Date.now()-snapshot[t.id].since<20000,'restored tabs receive a fresh grace period');
  const restoredPinned=(await tabs()).find(t=>t.url===base+'/suspension?pinned');assert.ok(restoredPinned);
  await evaluate(`await chrome.tabs.update(${restoredPinned.id},{active:true});await chrome.windows.update(${restoredPinned.windowId},{focused:true});`);
  if(!headed){const page=(await rpc('Target.getTargets')).targetInfos.find(t=>t.url===base+'/suspension?pinned');if(page)await rpc('Target.activateTarget',{targetId:page.targetId});}
  await delay(900);
  if(!headed&&(await tabs()).find(t=>t.id===restoredPinned.id)?.discarded){await evaluate(`await chrome.tabs.reload(${restoredPinned.id});`);await delay(900);}
  const off=await evaluate(`return await chrome.runtime.sendMessage({type:'suspension-status',tabId:${restoredPinned.id}});`);
  assert.equal(off.mode,'off');assert.equal(off.resident,false,'a restored pinned tab preserves explicit resident off');
  // New tabs with the same URL must remain independent, even if dedup is disabled.
  const twinConfig=join(work,'twins.toml');
  await writeFile(twinConfig,(await readFile(join(work,'config.toml'),'utf8')).replace('[dedup]','[dedup]\nenabled=false'));
  assert.match(await command('./tab-tamer',['apply',...cliBrowserArgs,'--config',twinConfig,'--user-data-dir',profile]),/apply: verified/);
  const twin=await evaluate(`return await chrome.tabs.create({url:${json(base+'/suspension?resident')},active:true});`);await delay(700);
  assert.equal((await evaluate(`return await chrome.runtime.sendMessage({type:'suspension-status',tabId:${twin.id}});`)).resident,false);
  const stored=await evaluate(`return (await chrome.storage.session.get('suspension')).suspension[${twin.id}];`);
  assert.ok(Date.now()-stored.since<10000,'new restored session grants a full grace period');
 });
 await writeFile(join(work,'run.json'),JSON.stringify({mode:headed?'headed':'headless',osFocusChecksEnabled:headed,testMatch:process.env.TAB_TAMER_TEST_MATCH||null,skipped:[...skipped,...(headed?[]:['external browser command reuses existing page','macOS open launch reuses existing page'])]},null,2));
 await writeFile(join(work,'results.json'),JSON.stringify(results,null,2));console.log('Results:',join(work,'results.json'));
}catch(e){console.error(e);results.push({ok:false,error:String(e)});try{await writeFile(join(work,'failure.json'),JSON.stringify({results,events:await evaluate('return globalThis.testEvents;'),windows:await evaluate('return await chrome.windows.getAll({});'),tabs:await tabs(),logs:await evaluate('return await chrome.storage.session.get(["logs","suspension"]);')},null,2));}catch{}process.exitCode=1;
}finally{releaseSlow?.();releaseInteraction?.();await stop();server.close();}
