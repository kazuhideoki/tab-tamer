import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {installMarkdownCopy} from '../extension/copy.js';
import {Engine} from '../extension/engine.js';
import {validateConfig} from '../extension/policy.js';

const source=readFileSync(new URL('../extension/worker.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
function event(){let listener;return {addListener:fn=>{listener=fn;},emit:(...args)=>listener?.(...args)};}
function boot(){
 const old={event:'previous-session-event'},session={started:true,logs:[old]},writes=[];
 let release,engine;
 const configGate=new Promise(resolve=>{release=resolve;});
 const url='https://example.com/a';
 const tabs=new Map([[1,{id:1,windowId:1,url,status:'complete',active:false,groupId:-1}]]);
 const chrome={
  storage:{local:{get:async()=>{await configGate;return {configRecord:{config:{version:1,grouping:{enabled:false}}}};}},session:{get:async()=>structuredClone(session),set:async value=>{writes.push(structuredClone(value));Object.assign(session,structuredClone(value));}}},
  tabs:{...Object.fromEntries(['onCreated','onActivated','onRemoved','onDetached','onAttached','onReplaced','onUpdated'].map(k=>[k,event()])),query:async()=>[...tabs.values()],get:async id=>{if(!tabs.has(id))throw Error('missing');return {...tabs.get(id)};},remove:async id=>{tabs.delete(id);chrome.tabs.onRemoved.emit(id);}},
  windows:{onFocusChanged:event(),getAll:async()=>[{id:1,type:'normal',focused:true}]},
  webNavigation:Object.fromEntries(['onBeforeNavigate','onCommitted','onCompleted','onErrorOccurred','onHistoryStateUpdated','onReferenceFragmentUpdated'].map(k=>[k,event()])),
  commands:{onCommand:event()},
  runtime:{onStartup:event(),onMessage:event()},
 };
 vm.runInNewContext(source,{chrome,installMarkdownCopy,Engine:class extends Engine{constructor(...args){super(...args);engine=this;}},validateConfig,Date});
 return {chrome,engine,session,writes,release,tabs,url};
}
test('wake-up events do not overwrite saved diagnostics before storage is read',async()=>{
 const f=boot();
 f.chrome.tabs.onCreated.emit({id:2,windowId:1,status:'loading',active:false});
 assert.equal(f.writes.length,0);
 f.release();await f.engine.tail;
 assert.deepEqual(f.session.logs.map(x=>x.event),['previous-session-event','dedup-decision','ready']);
});
test('a duplicate created while the worker wakes closes after configuration loads',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=boot();
 const tab={id:2,windowId:1,url:f.url,status:'loading',active:false,groupId:-1};
 f.tabs.set(2,tab);f.chrome.tabs.onCreated.emit(tab);
 f.chrome.webNavigation.onBeforeNavigate.emit({tabId:2,frameId:0});
 f.chrome.webNavigation.onCommitted.emit({tabId:2,frameId:0,documentId:'new',url:f.url,transitionType:'link'});
 tab.status='complete';f.chrome.webNavigation.onCompleted.emit({tabId:2,frameId:0,documentId:'new'});
 t.mock.timers.tick(200);
 f.release();await f.engine.tail;
 assert.ok(f.tabs.has(1));assert.equal(f.tabs.has(2),false);
 assert.ok(f.session.logs.some(x=>x.event==='duplicate-closed'));
});
