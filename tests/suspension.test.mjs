import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Suspension} from '../extension/suspension.js';
import {validateConfig} from '../extension/policy.js';
function fixture(){
  let time=1000000,config=validateConfig({version:1}),session={},local={};
  const tabs=new Map(),pages=new Map(),discards=[],sent=[];
  const storage=data=>({get:async key=>({[key]:structuredClone(data[key])}),set:async x=>Object.assign(data,structuredClone(x))});
  const api={storage:{session:storage(session),local:storage(local)},alarms:{get:async()=>null,create:async()=>{}},
    tabs:{query:async q=>[...tabs.values()].filter(t=>q.windowId===undefined||t.windowId===q.windowId).map(t=>({...t})),get:async id=>{if(!tabs.has(id))throw Error('missing');return {...tabs.get(id)};},
      sendMessage:async(id,m,options)=>{sent.push([id,m,options]);const p=pages.get(id);if(!p||p.unreachable)throw Error('no receiver');if(m.type==='suspension-identity'){p.token=m.token;return {saved:true};}return {...p};},
      discard:async id=>{if(tabs.get(id).fail)throw Error('cannot discard');discards.push(id);tabs.get(id).discarded=true;}},
    windows:{getAll:async()=>[{id:1,type:'normal'},{id:2,type:'normal'}]},
    webNavigation:{getAllFrames:async()=>[{frameId:0,documentId:'doc'}]}};
  function add(id,fields={}){tabs.set(id,{id,windowId:1,url:'https://example.com',status:'complete',active:false,pinned:false,...fields});pages.set(id,{version:1,identityAvailable:true,mediaKnown:true,dirty:false,media:false,token:null});}
  async function boot(){const m=new Suspension(api,()=>config,()=>{},()=>time);await m.tail;return m;}
  return {api,tabs,pages,discards,sent,session,local,add,boot,advance:ms=>time+=ms,setConfig:c=>config=validateConfig(c)};
}
test('old settings receive ten minute default and invalid suspension settings fail',()=>{
  assert.deepEqual(validateConfig({version:1}).suspension,{enabled:true,idle_minutes:10});
  for(const idle_minutes of [0,1.5,10081,'10'])assert.throws(()=>validateConfig({version:1,suspension:{idle_minutes}}));
  assert.throws(()=>validateConfig({version:1,suspension:{enabled:1}}));
});
test('background creation and deselection have separate deadlines; every window protects its selection',async()=>{
  const f=fixture();f.add(1,{active:true});f.add(2,{active:true,windowId:2});const m=await f.boot();
  f.advance(300000);f.add(3);await m.created(f.tabs.get(3),m.now());
  f.advance(300000);await m.sweep();assert.deepEqual(f.discards,[]);
  f.tabs.get(1).active=false;f.add(4,{active:true});await m.activated({tabId:4,windowId:1},m.now());
  f.advance(300000);await m.sweep();assert.deepEqual(f.discards,[3]);
  f.advance(300000);await m.sweep();assert.deepEqual(f.discards,[3,1]);
  assert.ok(!f.tabs.get(2).discarded);assert.ok(!f.tabs.get(4).discarded);
});
test('Pin follows until overridden; explicit off and return-to-Pin grant a full grace period',async()=>{
  const f=fixture();f.add(1,{pinned:true});const m=await f.boot();
  f.advance(700000);await m.sweep();assert.equal(f.discards.length,0);
  await m.setResident(1,'off');assert.equal((await m.status(1)).mode,'off');
  f.tabs.get(1).pinned=false;await m.updated(1,{pinned:false});f.tabs.get(1).pinned=true;await m.updated(1,{pinned:true});
  assert.equal((await m.status(1)).resident,false);
  f.advance(599999);await m.sweep();assert.equal(f.discards.length,0);
  f.advance(1);await m.sweep();assert.deepEqual(f.discards,[1]);
  f.tabs.get(1).discarded=false;await m.setResident(1,'on');f.tabs.get(1).pinned=false;await m.updated(1,{pinned:false});
  assert.equal((await m.status(1)).resident,true);
  await m.setResident(1,'pin');assert.equal((await m.status(1)).resident,false);await m.sweep();assert.equal(f.discards.length,1);
});
test('unpin without a manual override resets the grace period',async()=>{
  const f=fixture();f.add(1,{pinned:true});const m=await f.boot();f.advance(900000);
  f.tabs.get(1).pinned=false;await m.updated(1,{pinned:false});await m.sweep();assert.equal(f.discards.length,0);
  f.advance(600000);await m.sweep();assert.deepEqual(f.discards,[1]);
});
test('worker reboot retains deadlines and manual marks without granting repeated grace',async()=>{
  const f=fixture();f.add(1);f.add(2);let m=await f.boot();await m.setResident(2,'on');f.advance(500000);
  m=await f.boot();f.advance(100000);await m.sweep();assert.deepEqual(f.discards,[1]);assert.equal((await m.status(2)).mode,'on');
});
test('browser restoration uses a tab token, never URL or recycled tab ID, and starts a fresh grace period',async()=>{
  const f=fixture();f.add(1);f.add(2);let m=await f.boot();await m.setResident(1,'on');await m.identify(2,null);
  const first={...f.pages.get(1)},second={...f.pages.get(2)};
  // Chrome clears session storage for extensions on restart, but restores page sessionStorage.
  delete f.session.suspension;f.tabs.clear();f.pages.clear();f.add(20);f.add(1);
  f.pages.set(20,first);f.pages.set(1,second);f.advance(10000000);m=await f.boot();
  assert.equal((await m.status(20)).resident,true);assert.equal((await m.status(1)).resident,false);
  await m.sweep();assert.deepEqual(f.discards,[]);f.advance(600000);await m.sweep();assert.deepEqual(f.discards,[1]);
});
test('a cloned sessionStorage token in a newly created tab never inherits its manual mark',async()=>{
  const f=fixture();f.add(1);const m=await f.boot();await m.setResident(1,'on');f.advance(6000);
  f.add(2);f.pages.set(2,{...f.pages.get(1)});await m.created(f.tabs.get(2),m.now());
  assert.equal((await m.status(2)).resident,false);assert.notEqual(f.pages.get(1).token,f.pages.get(2).token);
});
test('audio, dirty frames, media, unknown protection, special pages and discard failures do not block other tabs',async()=>{
  const f=fixture();for(let i=1;i<=8;i++)f.add(i);f.tabs.get(1).audible=true;f.pages.get(2).dirty=true;
  f.pages.get(3).media=true;f.pages.get(4).mediaKnown=false;f.pages.get(5).unreachable=true;
  f.tabs.get(6).url='brave://settings';f.tabs.get(7).fail=true;const m=await f.boot();
  f.advance(600000);await m.sweep();assert.deepEqual(f.discards,[8]);
  assert.match((await m.status(1)).reason,/音声/);assert.match((await m.status(2)).reason,/入力途中/);
  assert.match((await m.status(3)).reason,/通話/);assert.match((await m.status(4)).reason,/確認できない/);
  assert.match((await m.status(7)).reason,/休止できなかった/);
});
test('activation or navigation during a protection probe invalidates the discard attempt',async()=>{
  const f=fixture();f.add(1);const m=await f.boot();f.advance(600000);
  const original=f.api.tabs.sendMessage;
  f.api.tabs.sendMessage=async(...args)=>{const r=await original(...args);m.touch(1);return r;};
  await m.sweep();assert.deepEqual(f.discards,[]);
});
test('every live frame must answer and a dirty subframe protects the tab',async()=>{
  const f=fixture();f.add(1);const m=await f.boot();f.advance(600000);
  f.api.webNavigation.getAllFrames=async()=>[{frameId:0,documentId:'main'},{frameId:9,documentId:'child'}];
  const original=f.api.tabs.sendMessage;
  f.api.tabs.sendMessage=async(id,msg,opt)=>opt.documentId==='child'?{version:1,mediaKnown:true,dirty:true}:original(id,msg,opt);
  await m.sweep();assert.deepEqual(f.discards,[]);assert.match((await m.status(1)).reason,/入力途中/);
});
test('ambiguous restored identities protect both tabs until explicitly reassigned',async()=>{
  const f=fixture();f.add(1,{pinned:true});let m=await f.boot();await m.setResident(1,'off');const page={...f.pages.get(1)};
  delete f.session.suspension;f.add(2,{pinned:true});f.pages.set(2,{...page});m=await f.boot();
  await m.status(1);await m.status(2);f.advance(600000);await m.sweep();assert.deepEqual(f.discards,[]);
  assert.match((await m.status(1)).reason,/識別が重複/);await m.setResident(2,'off');
  f.advance(600000);await m.sweep();assert.deepEqual(f.discards,[2]);
});
test('worker wakes preserve the existing alarm instead of postponing suspension',async()=>{
  const f=fixture();let scheduled=false,creates=0;
  f.api.alarms.get=async()=>scheduled?{name:'tab-tamer-suspension'}:null;
  f.api.alarms.create=async()=>{scheduled=true;creates++;};
  await f.boot();await f.boot();assert.equal(creates,1);
  scheduled=false;await f.boot();assert.equal(creates,2);
});
test('residency off remains per tab even when restored tabs share a URL',async()=>{
  const f=fixture();f.add(1,{pinned:true});f.add(2,{pinned:true});let m=await f.boot();
  await m.setResident(1,'off');await m.setResident(2,'on');delete f.session.suspension;m=await f.boot();
  assert.equal((await m.status(1)).resident,false);assert.equal((await m.status(2)).resident,true);
  f.advance(600000);await m.sweep();assert.deepEqual(f.discards,[1]);
});
test('an unresponsive frame times out without preventing another tab from suspending',async()=>{
  const f=fixture();f.add(1);f.add(2);const m=await f.boot();f.advance(600000);
  const original=f.api.tabs.sendMessage;f.api.tabs.sendMessage=(id,...args)=>id===1?new Promise(()=>{}):original(id,...args);
  await m.sweep();assert.deepEqual(f.discards,[2]);
});
test('browser-reported tab replacement preserves the logical tab residency and deadline',async()=>{
  const f=fixture();f.add(1);const m=await f.boot();await m.setResident(1,'on');const previous={...m.states[1]};
  f.add(20);f.tabs.delete(1);await m.replaced(20,1);
  assert.equal((await m.status(20)).resident,true);assert.equal(m.states[20].since,previous.since);assert.equal(m.states[1],undefined);
});
test('a failed persistence read cannot fall back to discarding manually protected tabs',async()=>{
  const f=fixture();f.add(1);f.api.storage.local.get=async()=>{throw Error('storage unavailable');};
  const m=await f.boot();f.advance(600000);
  await assert.rejects(m.enqueue(()=>m.sweep()),/storage unavailable/);assert.deepEqual(f.discards,[]);
});

function legacyIdentity(f){
  const stores=new Map(),calls=[];
  f.api.scripting={executeScript:async options=>{
    calls.push(options);
    const store=stores.get(options.target.tabId)||new Map();stores.set(options.target.tabId,store);
    const result=vm.runInNewContext('('+options.func.toString()+')(token)',{
      token:options.args[0],sessionStorage:{getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value)},
      get document(){throw Error('must not access page content');}
    });
    return [{frameId:0,result}];
  }};
  return {stores,calls};
}
test('legacy tabs toggle both ways without a content receiver or page reload',async()=>{
  const f=fixture();f.add(1,{active:true});f.pages.get(1).unreachable=true;
  const identity=legacyIdentity(f);const m=await f.boot();
  assert.equal((await m.setResident(1,'on')).resident,true);
  assert.equal((await m.setResident(1,'off')).resident,false);
  assert.equal((await m.setResident(1,'pin')).mode,'pin');
  assert.ok(identity.calls.length>0);
  for(const call of identity.calls){assert.deepEqual(call.target,{tabId:1,frameIds:[0]});assert.equal(call.world,'ISOLATED');}
  assert.equal(f.discards.length,0);
});
test('late identity access preserves restoration and never pretends the legacy document is protected',async()=>{
  const f=fixture();f.add(1);f.pages.get(1).unreachable=true;
  const {stores}=legacyIdentity(f);let m=await f.boot();await m.setResident(1,'on');
  const saved=stores.get(1).get('__tab_tamer_identity_v1');delete f.session.suspension;
  m=await f.boot();assert.equal((await m.status(1)).resident,true);
  assert.equal(stores.get(1).get('__tab_tamer_identity_v1'),saved);
  await m.setResident(1,'off');f.advance(600000);await m.sweep();assert.deepEqual(f.discards,[]);
});
test('restricted pages and denied injection keep settings intact and report a failure',async()=>{
  const f=fixture();f.add(1);const m=await f.boot();await m.setResident(1,'on');
  f.pages.get(1).unreachable=true;f.api.scripting={executeScript:async()=>{throw Error('not permitted');}};
  await assert.rejects(m.setResident(1,'off'),/保存できません/);assert.equal(m.states[1].manual,true);
  f.tabs.get(1).url='brave://settings';f.api.scripting.executeScript=()=>{throw Error('must not inject into special pages');};
  await assert.rejects(m.setResident(1,'off'),/対象外/);assert.equal(m.states[1].manual,true);
});
