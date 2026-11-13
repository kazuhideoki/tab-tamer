import {defaults,webURL} from './policy.js';
const ALARM='tab-tamer-suspension';
const validToken=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x);
export class Suspension {
  constructor(api,config=()=>defaults,log=()=>{},now=()=>Date.now()) {
    this.api=api;this.config=config;this.log=log;this.now=now;this.states={};this.overrides={};this.revisions=new Map();
    this.bootUntil=this.now()+5000;this.ready=this.init();
    this.tail=this.ready.catch(()=>this.log('suspension-init-failed'));
  }
  enqueue(fn){const task=this.tail.then(async()=>{await this.ready;return fn();});this.tail=task.catch(()=>{});return task;}
  minutes(){return (this.config()||defaults).suspension.idle_minutes;}
  delay(){return this.minutes()*60000;}
  touch(id){this.revisions.set(id,(this.revisions.get(id)||0)+1);}
  async send(id,message,options){
    let timer;
    try{return await Promise.race([this.api.tabs.sendMessage(id,message,options),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Page protection check timed out')),1500);})]);}
    finally{clearTimeout(timer);}
  }
  async pageIdentity(id,token=null){
    const message=token?{type:'suspension-identity',token}:{type:'suspension-probe'};
    const reply=await this.send(id,message,{frameId:0}).catch(()=>null);
    if(token?reply?.saved:reply?.identityAvailable)return reply;
    // Updated extensions have no receiver in already-open documents. activeTab
    // permits this identity-only operation without reloading or reading the page.
    const tab=await this.api.tabs.get(id);
    if(!webURL(tab.url))return null;
    try{
      const results=await this.api.scripting.executeScript({target:{tabId:id,frameIds:[0]},world:'ISOLATED',
        func:token=>{
          try{
            const key='__tab_tamer_identity_v1';
            if(token!==null)sessionStorage.setItem(key,token);
            return {identityAvailable:true,token:sessionStorage.getItem(key),saved:token!==null};
          }catch{return {identityAvailable:false,saved:false};}
        },args:[token]});
      return results?.[0]?.result??null;
    }catch{return null;}
  }
  async save(){await this.api.storage.session.set({suspension:this.states});}
  async init(){
    const {suspension}=await this.api.storage.session.get('suspension');
    this.overrides=(await this.api.storage.local.get('residentOverrides')).residentOverrides||{};
    this.states=suspension||{};if(suspension)this.bootUntil=0;
    const tabs=await this.api.tabs.query({});const live=new Set(tabs.map(t=>String(t.id)));
    for(const id of Object.keys(this.states))if(!live.has(id))delete this.states[id];
    for(const t of tabs){
      const s=this.states[t.id];
      if(!s)this.states[t.id]={...this.fresh(t),restore:true};
      else {if(s.active!==t.active)s.since=this.now();s.active=t.active;s.pinned=t.pinned;}
    }
    await this.save();
    // Restore a missing alarm, without postponing an existing deadline on every wake.
    if(!await this.api.alarms.get(ALARM))await this.api.alarms.create(ALARM,{periodInMinutes:1});
  }
  fresh(t,at=this.now()){return {since:at,active:!!t.active,pinned:!!t.pinned,token:null,manual:null};}
  resident(t,s){return typeof s.manual==='boolean'?s.manual:!!t.pinned;}
  async created(t,at){this.states[t.id]={...this.fresh(t,at),restore:t.discarded||at<this.bootUntil};await this.save();}
  async activated(info,at){
    for(const t of await this.api.tabs.query({windowId:info.windowId})){
      const s=this.states[t.id]||(this.states[t.id]=this.fresh(t,at));
      const active=t.id===info.tabId;
      if(s.active!==active){s.since=at;s.reason=null;s.retryAt=0;}
      s.active=active;
    }await this.save();
  }
  async replaced(added,removed){
    const tab=await this.api.tabs.get(added);
    this.states[added]=this.states[removed]||this.fresh(tab);
    this.states[added].active=tab.active;this.states[added].pinned=tab.pinned;
    delete this.states[removed];await this.save();
  }
  async updated(id,change){
    const t=await this.api.tabs.get(id).catch(()=>null);if(!t)return;
    const s=this.states[id]||(this.states[id]=this.fresh(t));
    if(change.pinned!==undefined){
      const was=typeof s.manual==='boolean'?s.manual:s.pinned;
      s.pinned=t.pinned;if(was&&!this.resident(t,s))s.since=this.now();
    }
    if(change.url||change.status==='loading'){s.reason=null;s.retryAt=0;}
    await this.save();
  }
  async identify(id,token){
    const t=await this.api.tabs.get(id);const s=this.states[id]||(this.states[id]=this.fresh(t));
    if(!s.token){
      // A newly created tab cannot inherit a cloned tab's sessionStorage token.
      // Only tabs present at a fresh browser/extension boot may restore a token.
      const duplicates=validToken(token)?Object.entries(this.states).filter(([other,x])=>Number(other)!==id&&x.token===token):[];
      if(s.restore&&duplicates.length){s.ambiguous=true;for(const [,other] of duplicates)other.ambiguous=true;}
      s.token=s.restore&&validToken(token)&&!duplicates.length?token:crypto.randomUUID();
      s.manual=this.overrides[s.token]?.value??null;
    }
    await this.save();return s.token;
  }
  async setResident(id,mode){
    if(!['on','off','pin'].includes(mode))throw Error('常駐の指定が不正です。');
    const t=await this.api.tabs.get(id);const s=this.states[id]||(this.states[id]=this.fresh(t));
    // The page must acknowledge durable identity before accepting a manual mark.
    const page=await this.pageIdentity(id);
    if(!page?.identityAvailable)throw Error('このページでは常駐指定を保存できません。Braveの設定画面などは対象外です。');
    await this.identify(id,page.token);
    if(s.ambiguous)s.token=crypto.randomUUID();
    const ack=await this.pageIdentity(id,s.token);
    if(!ack?.saved)throw Error('このページでは常駐指定を保存できません。');
    const was=this.resident(t,s);s.ambiguous=false;s.manual=mode==='pin'?null:mode==='on';
    if(s.manual===null)delete this.overrides[s.token];else this.overrides[s.token]={value:s.manual};
    await this.api.storage.local.set({residentOverrides:this.overrides});
    if(!this.resident(t,s)&&(was||mode==='off')){s.since=this.now();s.retryAt=0;s.reason=null;}
    await this.save();return this.status(id);
  }
  reason(t,s){
    if(t.discarded)return '休止中';
    if(!(this.config()||defaults).suspension.enabled)return '自動休止はオフ';
    if(t.active)return '選択中のため維持';
    if(s.ambiguous)return 'タブの識別が重複したため維持（常駐を再指定してください）';
    if(this.resident(t,s))return '常駐のため維持';
    if(t.audible)return '音声再生中のため維持';
    if(t.incognito||!webURL(t.url))return '自動休止の対象外のページ';
    if(t.status!=='complete'||t.pendingUrl)return '読み込み中のため維持';
    if(t.autoDiscardable===false||t.splitViewId>=0)return 'ブラウザの保護指定のため維持';
    return null;
  }
  async protection(id){
    const frames=await this.api.webNavigation.getAllFrames({tabId:id});
    if(!frames?.length)throw Error('no frames');
    const replies=await Promise.all(frames.map(f=>this.send(id,{type:'suspension-probe'},f.documentId?{documentId:f.documentId}:{frameId:f.frameId})));
    if(replies.some(r=>r?.version!==1||!r.mediaKnown))return '保護状態を確認できないため維持';
    if(replies.some(r=>r.dirty))return '入力途中のため維持';
    if(replies.some(r=>r.media))return '通話・メディア使用中のため維持';
    const top=replies[frames.findIndex(f=>f.frameId===0)];
    if(!top?.identityAvailable)return 'タブを識別できないため維持';
    const token=await this.identify(id,top.token);
    const ack=await this.send(id,{type:'suspension-identity',token},{frameId:0});
    if(!ack?.saved)return 'タブを識別できないため維持';
    return null;
  }
  async status(id){
    const t=await this.api.tabs.get(id);const s=this.states[id]||(this.states[id]=this.fresh(t));
    // Resolve restored identity even while the selected tab is protected.
    if(!t.discarded&&webURL(t.url)){
      const p=await this.pageIdentity(id);
      if(p?.identityAvailable){const token=await this.identify(id,p.token);await this.pageIdentity(id,token);}
    }
    let reason=this.reason(t,s);
    if(!reason)reason=await this.protection(id).catch(()=>'保護状態を確認できないため維持');
    return {resident:this.resident(t,s),mode:s.manual===null?'pin':s.manual?'on':'off',
      reason:reason||(s.retryAt>this.now()?s.reason:null)||`あと${Math.max(1,Math.ceil((s.since+this.delay()-this.now())/60000))}分で休止`};
  }
  async sweep(){
    const windows=new Set((await this.api.windows.getAll({})).filter(w=>w.type==='normal').map(w=>w.id));
    for(const initial of await this.api.tabs.query({})){
      const id=initial.id,s=this.states[id]||(this.states[id]=this.fresh(initial));
      try{
        if(!windows.has(initial.windowId)||this.reason(initial,s)||this.now()<s.since+this.delay()||this.now()<(s.retryAt||0))continue;
        const revision=this.revisions.get(id);
        const protection=await this.protection(id);
        if(protection){s.reason=protection;continue;}
        const live=await this.api.tabs.get(id);
        if(this.revisions.get(id)!==revision||this.reason(live,s)||live.url!==initial.url||this.now()<s.since+this.delay())continue;
        await this.api.tabs.discard(id);s.reason=null;s.retryAt=0;this.log('tab-suspended',{tab:id});
      }catch{ s.reason='休止できなかったため維持（後で再試行）';s.retryAt=this.now()+60000; }
    }await this.save();
  }
}
export function installSuspension(api,config,log){
  const manager=new Suspension(api,config,log);
  const run=fn=>manager.enqueue(fn).catch(()=>{});
  api.tabs.onCreated.addListener(t=>{const at=manager.now();manager.touch(t.id);run(()=>manager.created(t,at));});
  api.tabs.onActivated.addListener(i=>{const at=manager.now();for(const id of Object.keys(manager.states))manager.touch(Number(id));run(()=>manager.activated(i,at));});
  api.tabs.onUpdated.addListener((id,c)=>{manager.touch(id);run(()=>manager.updated(id,c));});
  api.tabs.onRemoved.addListener(id=>{manager.touch(id);run(async()=>{delete manager.states[id];await manager.save();});});
  api.tabs.onReplaced.addListener((added,removed)=>{manager.touch(removed);manager.touch(added);run(()=>manager.replaced(added,removed));});
  for(const event of [api.webNavigation.onBeforeNavigate,api.webNavigation.onCommitted])event.addListener(d=>manager.touch(d.tabId));
  api.alarms.onAlarm.addListener(a=>{if(a.name===ALARM)run(async()=>{await manager.configurationReady;await manager.sweep();});});
  return manager;
}
