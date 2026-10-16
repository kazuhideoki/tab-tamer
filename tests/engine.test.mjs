import test from 'node:test';import assert from 'node:assert/strict';import {Engine} from '../extension/engine.js';import {validateConfig} from '../extension/policy.js';
function fixture(){
 const tabs=new Map([[1,{id:1,url:'https://example.com/a',windowId:1,status:'complete',groupId:10,active:false}],[2,{id:2,url:'https://example.com/a',windowId:2,status:'complete',groupId:-1,active:true}]]);
 const wins=new Map([[1,{id:1,focused:false,type:'normal'}],[2,{id:2,focused:true,type:'normal'}]]);const calls=[];let e;
 const api={tabs:{query:async()=>[...tabs.values()].map(t=>({...t})),get:async id=>{if(!tabs.has(id))throw Error('missing');return {...tabs.get(id)};},update:async(id,p)=>{calls.push(['activate',id]);for(const t of tabs.values())if(t.windowId===tabs.get(id).windowId)t.active=false;Object.assign(tabs.get(id),p);e.activated({tabId:id,windowId:tabs.get(id).windowId});},remove:async id=>{calls.push(['remove',id]);tabs.delete(id);e.removed(id);}},windows:{getAll:async()=>[...wins.values()],get:async id=>wins.get(id),update:async(id,p)=>{calls.push(['focus',id]);for(const w of wins.values())w.focused=w.id===id;e.focused(id);}},tabGroups:{update:async(id,p)=>calls.push(['expand',id]),query:async()=>[]}};
 e=new Engine(api);e.config=validateConfig({version:1});e.ranks.set(1,0);e.ranks.set(2,1);e.revisions.set(2,1);
 const c={id:2,windowId:2,url:'https://example.com/a',revision:1,created:Date.now(),foreground:true,cancelled:false};e.candidates.set(2,c);
 return {e,api,tabs,wins,c,calls};
}
test('foreground expands then selects and focuses before removing',async()=>{const f=fixture();await f.e.deduplicate(f.c);assert.deepEqual(f.calls,[['expand',10],['activate',1],['focus',1],['remove',2]]);});
test('background never expands or changes focus',async()=>{const f=fixture();f.c.foreground=false;f.tabs.get(2).active=false;await f.e.deduplicate(f.c);assert.deepEqual(f.calls,[['remove',2]]);});
test('switch during expansion cancels remaining focus and close',async()=>{const f=fixture();f.api.tabGroups.update=async()=>{f.e.activated({tabId:999,windowId:2});};await f.e.deduplicate(f.c);assert.deepEqual(f.calls,[]);});
test('URL changes during activation retain the new tab',async()=>{const f=fixture();const update=f.api.tabs.update;f.api.tabs.update=async(...args)=>{await update(...args);f.tabs.get(2).url='https://example.com/edited';f.e.changed(2);};await f.e.deduplicate(f.c);assert.ok(f.tabs.has(2));});
test('missing survivor does not remove source',async()=>{const f=fixture();f.api.tabGroups.update=async()=>f.tabs.delete(1);await f.e.deduplicate(f.c);assert.ok(f.tabs.has(2));});
test('active background-created tab belongs to user',async()=>{const f=fixture();f.c.foreground=false;await f.e.deduplicate(f.c);assert.deepEqual(f.calls,[]);});
test('second ordinary commit ends new-tab eligibility',()=>{const f=fixture();f.c.document='first';f.e.committed({tabId:2,frameId:0,url:f.c.url,documentId:'second',transitionType:'link',transitionQualifiers:[]});assert.equal(f.e.candidates.has(2),false);});
test('POST and reload are not deduplicated',()=>{for(const type of ['form_submit','reload']){const f=fixture();f.e.committed({tabId:2,frameId:0,url:f.c.url,documentId:'new',transitionType:type});assert.equal(f.e.candidates.has(2),false);}});
test('expired new-tab eligibility retains tab',async()=>{const f=fixture();f.c.created=0;await f.e.deduplicate(f.c);assert.deepEqual(f.calls,[]);});

test('config metadata changes follow stable rule IDs and preserve manual edits',async()=>{
 const f=fixture(); const previous=validateConfig({version:1,groups:[{id:'a',name:'Old',color:'blue',urls:['https://example.com/*']}]});
 f.e.config=validateConfig({version:1,groups:[{id:'a',name:'New',color:'red',urls:['https://example.com/*']}]});
 f.api.tabGroups.query=async()=>[{id:10,title:'Old',color:'blue'},{id:11,title:'Manual',color:'blue'}];
 f.api.tabGroups.update=async(id,props)=>f.calls.push([id,props]); f.api.tabs.query=async()=>[];
 await f.e.reconcile(previous); assert.deepEqual(f.calls,[[10,{title:'New',color:'red'}]]);
});
test('navigation invalidation and configuration generation abort pending closure',async()=>{
 const f=fixture();f.e.changed(2);await f.e.deduplicate(f.c);assert.deepEqual(f.calls,[]);
 const g=fixture();g.api.tabGroups.update=async()=>{g.e.generation++;};await g.e.deduplicate(g.c);assert.deepEqual(g.calls,[]);
});

test('a blank new tab stays eligible for its first web navigation only',()=>{
 const f=fixture();f.e.created({id:3,windowId:2,url:'chrome://newtab/',status:'complete',active:true});
 f.e.committed({tabId:3,frameId:0,url:'https://example.com/a',documentId:'one',transitionType:'typed'});
 assert.equal(f.e.candidates.get(3).document,'one');
 f.e.committed({tabId:3,frameId:0,url:'https://example.com/b',documentId:'two',transitionType:'typed'});
 assert.equal(f.e.candidates.has(3),false);
});
test('pinned, audible and split-view sources remain intact',async()=>{
 for(const flags of [{pinned:true},{audible:true},{splitViewId:9}]){
  const f=fixture();Object.assign(f.tabs.get(2),flags);await f.e.deduplicate(f.c);assert.deepEqual(f.calls,[]);
 }
});
test('target navigation during expansion preserves source',async()=>{
 const f=fixture();f.api.tabGroups.update=async()=>{f.tabs.get(1).url='https://example.com/other';};
 await f.e.deduplicate(f.c);assert.deepEqual(f.calls,[]);
});
test('disabled foreground focusing does not let tab removal pick another selection',async()=>{
 const f=fixture();f.e.config.focus.foreground=false;await f.e.deduplicate(f.c);assert.deepEqual(f.calls,[]);
});

test('command-line start_page is eligible outside the startup guard',()=>{
 const f=fixture();f.e.created({id:3,windowId:2,url:'https://example.com/a',status:'loading',active:true});
 f.e.committed({tabId:3,frameId:0,url:'https://example.com/a',documentId:'external',transitionType:'start_page'});
 assert.equal(f.e.candidates.get(3).document,'external');
 f.e.restoreUntil=Date.now()+5000;f.e.created({id:4,windowId:2,status:'loading',active:true});assert.equal(f.e.candidates.has(4),false);
});
test('back-forward navigation is never deduplicated',()=>{
 const f=fixture();f.e.committed({tabId:2,frameId:0,url:f.c.url,documentId:'restore',transitionType:'link',transitionQualifiers:['forward_back']});assert.equal(f.e.candidates.has(2),false);
});

test('same-document same-URL history state update preserves new-tab deduplication',async()=>{
 const f=fixture();f.c.document='initial';
 f.e.historyUpdated({tabId:2,frameId:0,documentId:'initial',url:f.c.url});
 assert.equal(f.e.candidates.get(2),f.c);assert.equal(f.e.revisions.get(2),f.c.revision);
 await f.e.deduplicate(f.c);assert.ok(!f.tabs.has(2));
});
test('initial automatic SPA route, query and fragment changes deduplicate the final URL',async()=>{
 for(const suffix of ['/next','?q=1','#section']){
  const f=fixture();f.c.document='initial';const url=f.c.url+suffix;
  f.tabs.get(1).url=url;f.tabs.get(2).url=url;f.e.changed(2);
  f.e.historyUpdated({tabId:2,frameId:0,documentId:'initial',url});
  assert.equal(f.e.candidates.get(2),f.c);assert.equal(f.c.url,url);
  await f.e.deduplicate(f.c);assert.ok(!f.tabs.has(2));
 }
});
test('interaction ends initial eligibility and invalidates an in-flight closure',async()=>{
 const f=fixture();f.c.document='initial';
 f.api.tabGroups.update=async()=>f.e.interacted(2);
 await f.e.deduplicate(f.c);assert.ok(f.tabs.has(2));assert.equal(f.e.candidates.has(2),false);
 f.e.historyUpdated({tabId:2,frameId:0,documentId:'initial',url:f.c.url+'/next'});
 assert.equal(f.e.candidates.has(2),false);
});
test('interaction in the opener does not exempt a newly opened tab',async()=>{
 const f=fixture();f.e.interacted(1);await f.e.deduplicate(f.c);assert.ok(!f.tabs.has(2));
});
test('interaction cancelling a scheduled duplicate check still groups the retained tab',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();f.c.document='initial';const grouped=[];
 f.e.group=async id=>grouped.push(id);
 f.e.completed({tabId:2,frameId:0,documentId:'initial'});f.e.interacted(2);await f.e.tail;
 assert.deepEqual(grouped,[2]);t.mock.timers.tick(200);await f.e.tail;assert.ok(f.tabs.has(2));
});
test('history restoration and different-document history events end eligibility',()=>{
 for(const detail of [{documentId:'other'},{documentId:'initial',transitionQualifiers:['forward_back']}]){
  const f=fixture();f.c.document='initial';
  f.e.historyUpdated({tabId:2,frameId:0,url:f.c.url,...detail});assert.equal(f.e.candidates.has(2),false);
 }
});
test('URL changes after completion restart the settling period',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();f.c.document='initial';
 f.e.completed({tabId:2,frameId:0,documentId:'initial'});t.mock.timers.tick(150);
 const url=f.c.url+'?canonical=1';f.tabs.get(1).url=url;f.tabs.get(2).url=url;f.e.changed(2);
 f.e.historyUpdated({tabId:2,frameId:0,documentId:'initial',url});
 t.mock.timers.tick(100);await f.e.tail;assert.ok(f.tabs.has(2));
 t.mock.timers.tick(100);await f.e.tail;assert.ok(!f.tabs.has(2));
});
test('client redirect waits for the final document to complete',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();f.c.document='initial';
 f.e.completed({tabId:2,frameId:0,documentId:'initial'});t.mock.timers.tick(100);
 f.e.navigating(2);t.mock.timers.tick(300);await f.e.tail;assert.ok(f.tabs.has(2));
 f.e.completed({tabId:2,frameId:0,documentId:'initial'});t.mock.timers.tick(300);await f.e.tail;assert.ok(f.tabs.has(2));assert.ok(f.e.candidates.has(2));
 f.e.committed({tabId:2,frameId:0,documentId:'redirect',url:f.c.url,transitionType:'link',transitionQualifiers:['client_redirect']});
 f.e.completed({tabId:2,frameId:0,documentId:'initial'});t.mock.timers.tick(300);await f.e.tail;assert.ok(f.tabs.has(2));
 f.e.completed({tabId:2,frameId:0,documentId:'redirect'});t.mock.timers.tick(200);await f.e.tail;assert.ok(!f.tabs.has(2));
});
test('queued settling attempt cannot consume an updated destination',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();f.c.document='initial';
 let release;f.e.enqueue(()=>new Promise(resolve=>{release=resolve;}));await Promise.resolve();
 f.e.completed({tabId:2,frameId:0,documentId:'initial'});t.mock.timers.tick(200);
 const url=f.c.url+'?canonical=1';f.tabs.get(1).url=url;f.tabs.get(2).url=url;
 f.e.historyUpdated({tabId:2,frameId:0,documentId:'initial',url});
 release();await f.e.tail;assert.ok(f.tabs.has(2));
 t.mock.timers.tick(200);await f.e.tail;assert.ok(!f.tabs.has(2));
});
test('expired initial settling retains the tab',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();f.c.document='initial';f.c.created=0;
 f.e.completed({tabId:2,frameId:0,documentId:'initial'});t.mock.timers.tick(1);await f.e.tail;
 assert.ok(f.tabs.has(2));assert.equal(f.e.candidates.has(2),false);
});
test('the deadline never shortens the required URL settling period',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();f.c.document='initial';
 f.c.created=Date.now()-f.e.config.dedup.new_tab_timeout_ms+100;
 f.e.completed({tabId:2,frameId:0,documentId:'initial'});t.mock.timers.tick(200);await f.e.tail;
 assert.ok(f.tabs.has(2));assert.equal(f.e.candidates.has(2),false);
});
test('history update in existing tabs never creates new-tab eligibility',()=>{
 const f=fixture();f.e.historyUpdated({tabId:1,frameId:0,documentId:'existing',url:f.c.url});
 assert.equal(f.e.candidates.has(1),false);
});

test('discarded target restoration commits before the duplicate closes',async()=>{
 const f=fixture();f.tabs.get(1).discarded=true;const update=f.api.tabs.update;
 f.api.tabs.update=async(...args)=>{await update(...args);f.tabs.get(1).pendingUrl=f.c.url;setTimeout(()=>{delete f.tabs.get(1).pendingUrl;f.tabs.get(1).discarded=false;},40);};
 await f.e.deduplicate(f.c);assert.ok(!f.tabs.has(2));assert.equal(f.tabs.get(1).pendingUrl,undefined);
});
test('user switching while discarded target restores prevents closing',async()=>{
 const f=fixture();f.tabs.get(1).discarded=true;const update=f.api.tabs.update;
 f.api.tabs.update=async(...args)=>{await update(...args);f.tabs.get(1).pendingUrl=f.c.url;setTimeout(()=>f.e.activated({tabId:999,windowId:1}),10);};
 await f.e.deduplicate(f.c);assert.ok(f.tabs.has(2));
});


test('main-document completion waits for tab readiness without a second navigation event',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();f.c.document='initial';
 f.tabs.get(2).status='loading';f.e.completed({tabId:2,frameId:0,documentId:'initial'});
 t.mock.timers.tick(200);await f.e.tail;
 assert.equal(f.e.candidates.get(2),f.c);assert.deepEqual(f.calls,[]);
 t.mock.timers.tick(200);await f.e.tail;assert.deepEqual(f.calls,[]);
 f.tabs.get(2).status='complete';t.mock.timers.tick(200);await f.e.tail;
 assert.ok(!f.tabs.has(2));assert.equal(f.e.candidates.has(2),false);
});
test('readiness wait stops after interaction, navigation, removal, or reconfiguration',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const cancel of [f=>f.e.interacted(2),f=>f.e.navigating(2),f=>f.e.removed(2),f=>{f.e.generation++;f.e.candidates.clear();}]){
  const f=fixture();f.c.document='initial';f.tabs.get(2).status='loading';
  f.e.completed({tabId:2,frameId:0,documentId:'initial'});t.mock.timers.tick(200);await f.e.tail;
  cancel(f);f.tabs.get(2).status='complete';t.mock.timers.tick(500);await f.e.tail;
  assert.deepEqual(f.calls,[]);
 }
});
test('readiness wait is bounded by the original creation deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});const f=fixture();
 f.c.document='initial';f.tabs.get(2).status='loading';f.e.config.dedup.new_tab_timeout_ms=1000;
 f.e.completed({tabId:2,frameId:0,documentId:'initial'});
 for(let i=0;i<5;i++){t.mock.timers.tick(200);await f.e.tail;}
 assert.equal(f.e.candidates.has(2),false);assert.deepEqual(f.calls,[]);
 f.tabs.get(2).status='complete';t.mock.timers.tick(200);await f.e.tail;assert.deepEqual(f.calls,[]);
});
test('interaction during the asynchronous readiness read cannot revive a candidate',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();f.c.document='initial';f.tabs.get(2).status='loading';
 const get=f.api.tabs.get;f.api.tabs.get=async id=>{const tab=await get(id);if(id===2)f.e.interacted(2);return tab;};
 f.e.completed({tabId:2,frameId:0,documentId:'initial'});t.mock.timers.tick(200);await f.e.tail;
 assert.equal(f.e.candidates.has(2),false);assert.deepEqual(f.calls,[]);
});
test('loading after readiness validation prevents closing the source',async()=>{
 const f=fixture();f.api.tabGroups.update=async()=>{f.tabs.get(2).status='loading';};
 await f.e.deduplicate(f.c);assert.ok(f.tabs.has(2));assert.deepEqual(f.calls,[]);
});
