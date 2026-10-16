import {Engine} from './engine.js';
import {validateConfig} from './policy.js';
import {verify,envelope,digest} from './auth.js';
import {secret} from './bootstrap.js';
let record=null,logs=[];
function log(event,data={}) {logs.push({at:new Date().toISOString(),event,...data});logs=logs.slice(-100);chrome.storage.session.set({logs}).catch(()=>{});}
const engine=new Engine(chrome,log);
const ready=engine.enqueue(async()=>{
  const saved=await chrome.storage.local.get('configRecord');
  if(saved.configRecord){try{record=saved.configRecord;engine.config=validateConfig(record.config);}catch{record=null;log('invalid-stored-config');}}
  const session=await chrome.storage.session.get(['logs','started']);logs=session.logs||[];
  if(!session.started){engine.restoreUntil=Date.now()+5000;await chrome.storage.session.set({started:true});}
  await engine.init();log('ready');
});
chrome.runtime.onStartup.addListener(()=>{engine.restoreUntil=Date.now()+5000;engine.candidates.clear();});
chrome.tabs.onCreated.addListener(t=>engine.created(t));
chrome.tabs.onActivated.addListener(i=>engine.activated(i));
chrome.windows.onFocusChanged.addListener(id=>engine.focused(id));
chrome.tabs.onRemoved.addListener(id=>engine.removed(id));
chrome.tabs.onDetached.addListener(id=>{engine.changed(id);engine.candidates.delete(id);});
chrome.tabs.onAttached.addListener(id=>engine.enqueue(()=>engine.group(id)));
chrome.tabs.onReplaced.addListener((added,removed)=>{engine.removed(removed);engine.ranks.set(added,0);engine.enqueue(()=>engine.group(added));});
chrome.tabs.onUpdated.addListener((id,change)=>{
  if(change.pinned===true){engine.changed(id);engine.candidates.delete(id);}
  if(change.url && engine.candidates.get(id)?.url!==change.url)engine.changed(id);
  if(change.status==='complete'&&!engine.candidates.has(id))engine.enqueue(()=>engine.group(id));
});
chrome.webNavigation.onBeforeNavigate.addListener(d=>{if(d.frameId===0)engine.navigating(d.tabId);});
chrome.webNavigation.onCommitted.addListener(d=>engine.committed(d));
chrome.webNavigation.onCompleted.addListener(d=>engine.completed(d));
chrome.webNavigation.onErrorOccurred.addListener(d=>{if(d.frameId===0){if(engine.candidates.has(d.tabId))engine.trace(d.tabId,'navigation-error');engine.changed(d.tabId);engine.candidates.delete(d.tabId);}});
for(const event of [chrome.webNavigation.onHistoryStateUpdated,chrome.webNavigation.onReferenceFragmentUpdated])event.addListener(d=>engine.historyUpdated(d));
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  const page=(sender.url||'').split(/[?#]/)[0];
  if(sender.id!==chrome.runtime.id)return;
  if(message?.type==='page-interaction'&&sender.tab) {
    engine.interacted(sender.tab.id);return;
  }
  if(message?.type==='status'&&page===chrome.runtime.getURL('status.html')) {
    ready.then(()=>reply({configured:!!record,hash:record?.hash,appliedAt:record?.appliedAt,groups:record?.config.groups.length,logs}));return true;
  }
  if(message?.type!=='apply'||page!==chrome.runtime.getURL('apply.html'))return;
  engine.enqueue(async()=>{
    log('config-request');
    const request=await verify(message.envelope,secret);
    if(!/^[a-f0-9]{32}$/.test(request.id)||!Number.isInteger(request.issued)||!Number.isInteger(request.expires)||
       request.issued>Date.now()+5000||request.expires<Date.now()||request.expires-request.issued>120000)throw Error('Expired or invalid request');
    if(request.action==='status')return envelope({ok:true,id:request.id,hash:record?.hash??null,appliedAt:record?.appliedAt??null},secret);
    if(request.action!=='apply'||typeof request.config_text!=='string')throw Error('Invalid action');
    const hash=await digest(request.config_text);
    if(hash!==request.hash)throw Error('Configuration hash mismatch');
    const config=validateConfig(JSON.parse(request.config_text));
    if(record?.requestId!==request.id){
      if(record&&request.issued<=record.issued)throw Error('Stale request');
      const next={config,hash,requestId:request.id,issued:request.issued,appliedAt:new Date().toISOString()};
      await chrome.storage.local.set({configRecord:next});
      const readback=(await chrome.storage.local.get('configRecord')).configRecord;
      if(readback?.hash!==hash||readback?.requestId!==request.id)throw Error('Storage verification failed');
      record=next;
      // Commit configuration before best-effort grouping; grouping errors do not undo persistence.
      const previous=engine.config;engine.config=config;engine.generation++;engine.candidates.clear();
      engine.enqueue(()=>engine.reconcile(previous));
      log('config-applied',{hash});
    }else if(record.hash!==hash)throw Error('Request ID reused');
    return envelope({ok:true,id:request.id,hash:record.hash,appliedAt:record.appliedAt},secret);
  }).then(reply,e=>reply({error:String(e.message||e)}));return true;
});
