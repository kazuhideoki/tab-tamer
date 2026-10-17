import {chooseSurvivor,matchGroup,urlKey,webURL} from './policy.js';
export class Engine {
  constructor(api,log=()=>{}) { this.api=api;this.log=log;this.config=null;this.generation=0;this.tail=Promise.resolve();
    this.candidates=new Map();this.revisions=new Map();this.ranks=new Map();this.sequence=0;this.epoch=0;this.expectedActivation=null;this.expectedFocus=null;this.restoreUntil=0; }
  trace(id,reason,data={}) {this.log('dedup-decision',{tab:id,reason,...data});}
  enqueue(fn) {const task=this.tail.then(fn);this.tail=task.catch(e=>this.log('error',{message:String(e.message||e).slice(0,180)}));return task;}
  async init() { const tabs=await this.api.tabs.query({});for(const t of tabs)if(!this.ranks.has(t.id))this.ranks.set(t.id,0); }
  async reconcile(previous) {
    if(!this.config.grouping.enabled)return;
    // Match old metadata before renaming: manually edited groups stay untouched.
    for(const group of await this.api.tabGroups.query({})) {
      const old=previous?.groups.find(g=>g.name===group.title&&g.color===group.color);
      const next=old&&this.config.groups.find(g=>g.id===old.id);
      if(next&&(next.name!==group.title||next.color!==group.color))
        await this.api.tabGroups.update(group.id,{title:next.name,color:next.color});
    }
    for(const t of await this.api.tabs.query({})) {
      try {await this.group(t.id);} catch {this.log('group-deferred',{tab:t.id});}
    }
  }
  created(tab) {
    this.ranks.set(tab.id,++this.sequence);
    if(tab.incognito||tab.discarded||(tab.status==='complete'&&webURL(tab.url))||Date.now()<this.restoreUntil){this.trace(tab.id,'creation-ineligible',{incognito:!!tab.incognito,discarded:!!tab.discarded,alreadyComplete:tab.status==='complete'&&webURL(tab.url),startupGuard:Date.now()<this.restoreUntil});return;}
    this.trace(tab.id,'candidate-created');
    this.candidates.set(tab.id,{id:tab.id,windowId:tab.windowId,created:Date.now(),foreground:tab.active,cancelled:false,firstActivation:true,document:null,revision:0});
  }
  activated(info) {
    if(this.expectedActivation?.id===info.tabId && this.expectedActivation.windowId===info.windowId){this.expectedActivation=null;return;}
    this.epoch++;
    for(const c of this.candidates.values()) {
      if(c.id===info.tabId && c.firstActivation){c.firstActivation=false;continue;}
      if(c.id!==info.tabId)c.cancelled=true;
    }
  }
  focused(windowId) {
    if(this.expectedFocus===windowId){this.expectedFocus=null;return;}
    this.epoch++; for(const c of this.candidates.values())if(c.windowId!==windowId)c.cancelled=true;
  }
  removed(id) {this.candidates.delete(id);this.ranks.delete(id);this.revisions.delete(id);}
  changed(id) {this.revisions.set(id,(this.revisions.get(id)||0)+1);}
  interacted(id) {
    // Interaction belongs to this tab only. A link opened in a new tab gets its
    // own candidate and is still eligible for duplicate prevention.
    this.changed(id);
    if(this.candidates.delete(id)){this.trace(id,'page-interaction');this.enqueue(()=>this.group(id));}
  }
  navigating(id) {
    this.changed(id);const c=this.candidates.get(id);
    if(c){clearTimeout(c.timer);c.complete=false;c.navigating=true;}
  }
  historyUpdated(d) {
    if(d.frameId!==0)return;
    const c=this.candidates.get(d.tabId);
    // Follow automatic SPA initialization within the initial document. Trusted
    // page interaction ends eligibility via a separate early capture listener.
    if(c?.document&&c.document===d.documentId&&webURL(d.url)&&
       !d.transitionQualifiers?.includes('forward_back')) {
      if(c.url===d.url)return;
      this.changed(d.tabId);c.url=d.url;c.revision=this.revisions.get(d.tabId);
      if(c.complete)this.schedule(c);
      return;
    }
    this.changed(d.tabId);if(c)this.trace(d.tabId,'history-ineligible',{sameDocument:c.document===d.documentId});this.candidates.delete(d.tabId);
    this.enqueue(()=>this.group(d.tabId));
  }
  committed(d) {
    if(d.frameId!==0)return;
    this.changed(d.tabId);const c=this.candidates.get(d.tabId);if(!c)return;
    if(!webURL(d.url))return;
    if(['reload','form_submit'].includes(d.transitionType)||d.transitionQualifiers?.includes('forward_back') ||
      (c.document&&!d.transitionQualifiers?.includes('client_redirect'))){this.trace(d.tabId,'commit-ineligible',{transition:d.transitionType,qualifiers:d.transitionQualifiers||[],hadDocument:!!c.document});this.candidates.delete(d.tabId);return;}
    clearTimeout(c.timer);c.complete=false;c.navigating=false;
    c.document=d.documentId;c.url=d.url;c.revision=this.revisions.get(d.tabId);
  }
  completed(d) {
    if(d.frameId!==0)return;
    const c=this.candidates.get(d.tabId);
    if(!c||!c.document||c.document!==d.documentId){this.enqueue(()=>this.group(d.tabId));return;}
    if(c.navigating)return;
    this.trace(d.tabId,'load-completed',{ageMs:Date.now()-c.created});c.complete=true;this.schedule(c);
  }
  schedule(c,minDelay=0) {
    clearTimeout(c.timer);
    const generation=this.generation,revision=c.revision;
    const remaining=c.created+(this.config?.dedup.new_tab_timeout_ms??15000)-Date.now();
    const settle=Math.max(this.config?.dedup.settle_ms??200,minDelay);
    c.timer=setTimeout(()=>this.enqueue(async()=>{
      if(this.candidates.get(c.id)!==c||!c.complete||c.revision!==revision)return;
      const source=await this.get(c.id);
      // Completion of the main document can precede tabs.status becoming
      // complete (for example while an artifact iframe is still loading).
      // Keep the candidate until the tab is ready, but never revive a candidate
      // invalidated by input, navigation, removal, or configuration changes.
      if(this.candidates.get(c.id)!==c||!c.complete||c.revision!==revision)return;
      if(this.revisions.get(c.id)!==revision||generation!==this.generation) {
        this.trace(c.id,'check-invalidated',{revisionChanged:this.revisions.get(c.id)!==revision,reconfigured:generation!==this.generation});return;
      }
      if(source?.status==='loading'&&source.url===c.url&&!source.pendingUrl&&
         Date.now()+settle<c.created+(this.config?.dedup.new_tab_timeout_ms??15000)) {
        this.trace(c.id,'waiting-for-tab-complete');
        this.schedule(c,50);return;
      }
      // Freeze the destination before asynchronous focus/close operations. A
      // later URL change must invalidate this attempt, never retarget it.
      this.candidates.delete(c.id);
      try {if(remaining>=settle&&generation===this.generation)await this.deduplicate({...c},source);else this.trace(c.id,'schedule-expired-or-reconfigured',{ageMs:Date.now()-c.created});}finally{await this.group(c.id);}
    }),Math.max(0,Math.min(settle,remaining)));
  }
  async get(id){try{return await this.api.tabs.get(id);}catch{return null;}}
  async valid(c,targetId,key,generation) {
    if(generation!==this.generation||this.revisions.get(c.id)!==c.revision)return null;
    const s=await this.get(c.id),t=await this.get(targetId);
    if(!s||!t||s.status!=='complete'||s.pinned||s.audible||s.splitViewId>=0||s.incognito||t.incognito||s.pendingUrl||t.pendingUrl||s.url!==c.url||
       urlKey(s.url,this.config)!==key||urlKey(t.url,this.config)!==key)return null;
    return {s,t};
  }
  async deduplicate(c,source) {
    const config=this.config;if(!config?.dedup.enabled||Date.now()-c.created>config.dedup.new_tab_timeout_ms){this.trace(c.id,'disabled-or-expired',{ageMs:Date.now()-c.created});return;}
    if(source===undefined)source=await this.get(c.id);if(!source||source.pinned||source.audible||source.splitViewId>=0||source.url!==c.url||source.status!=='complete'){this.trace(c.id,'source-ineligible',{exists:!!source,pinned:!!source?.pinned,audible:!!source?.audible,splitView:source?.splitViewId>=0,sameURL:source?.url===c.url,status:source?.status});return;}
    const windows=new Map((await this.api.windows.getAll({})).map(w=>[w.id,w]));if(windows.get(source.windowId)?.type!=='normal'){this.trace(c.id,'window-ineligible');return;}
    const tabs=(await this.api.tabs.query({})).map(t=>({...t,windowType:windows.get(t.windowId)?.type}));
    const target=chooseSurvivor(source,tabs,config,id=>this.ranks.get(id)??0);if(!target){this.trace(c.id,'no-eligible-target',{sameURLTabs:tabs.filter(t=>t.id!==c.id&&urlKey(t.url,config)===urlKey(source.url,config)).map(t=>({tab:t.id,status:t.status,pending:!!t.pendingUrl,discarded:!!t.discarded,older:(this.ranks.get(t.id)??0)<(this.ranks.get(c.id)??0),normalWindow:t.windowType==='normal',sameWindow:t.windowId===source.windowId,incognito:!!t.incognito}))});return;}
    const generation=this.generation,key=urlKey(source.url,config),epoch=this.epoch;
    let pair=await this.valid(c,target.id,key,generation);if(!pair){this.trace(c.id,'validation-failed',{revisionChanged:this.revisions.get(c.id)!==c.revision});return;}
    const wantsFocus=config.focus.foreground&&c.foreground&&!c.cancelled&&pair.s.active&&windows.get(pair.s.windowId)?.focused;
    // A background-created tab selected later belongs to the user now: retain it.
    if(pair.s.active&&!wantsFocus){this.log('retain-active',{tab:c.id,foreground:!!c.foreground,cancelled:!!c.cancelled,windowFocused:!!windows.get(pair.s.windowId)?.focused});return;}
    try {
      if(wantsFocus) {
        if(config.focus.expand_group&&pair.t.groupId!==-1) {
          await this.api.tabGroups.update(pair.t.groupId,{collapsed:false});
          if(this.epoch!==epoch||c.cancelled)return;
        }
        pair=await this.valid(c,target.id,key,generation);if(!pair||this.epoch!==epoch||c.cancelled)return;
        const currentWindow=await this.api.windows.get(pair.s.windowId);
        if(!pair.s.active||!currentWindow.focused||this.epoch!==epoch)return;
        this.expectedActivation={id:target.id,windowId:pair.t.windowId};
        await this.api.tabs.update(target.id,{active:true});
        if(this.epoch!==epoch||c.cancelled)return;
        if(pair.s.windowId!==pair.t.windowId){this.expectedFocus=pair.t.windowId;await this.api.windows.update(pair.t.windowId,{focused:true});}
        if(this.epoch!==epoch||c.cancelled)return;
        if(target.discarded) {
          // Activating a discarded tab starts a reload. Do not mistake its
          // transient pendingUrl for a different destination, or close the
          // source before the restored target commits. User input still wins.
          const deadline=Math.min(Date.now()+2000,c.created+config.dedup.new_tab_timeout_ms);
          while(true) {
            if(this.epoch!==epoch||c.cancelled||this.generation!==generation||this.revisions.get(c.id)!==c.revision)return;
            const restored=await this.get(target.id);
            if(!restored||urlKey(restored.url,config)!==key)return;
            if(!restored.pendingUrl)break;
            if(restored.pendingUrl!==restored.url||Date.now()>=deadline){this.log('restore-deferred',{tab:c.id});return;}
            await new Promise(resolve=>setTimeout(resolve,25));
          }
        }
      }
      pair=await this.valid(c,target.id,key,generation);if(!pair){this.trace(c.id,'validation-failed',{revisionChanged:this.revisions.get(c.id)!==c.revision});return;}
      if(wantsFocus) {
        if(this.epoch!==epoch||!pair.t.active||!(await this.api.windows.get(pair.t.windowId)).focused||this.epoch!==epoch)return;
      } else if(pair.s.active)return;
      await this.api.tabs.remove(c.id);this.log('duplicate-closed',{tab:c.id,kept:target.id,focused:wantsFocus});
    } finally {this.expectedActivation=null;this.expectedFocus=null;}
  }
  async group(id) {
    const c=this.config;if(!c?.grouping.enabled)return;
    const t=await this.get(id);if(!t||t.incognito||t.pinned||t.splitViewId>=0||!webURL(t.url)||t.pendingUrl)return;
    if((await this.api.windows.get(t.windowId)).type!=='normal')return;
    const rule=matchGroup(t.url,c);
    const groups=await this.api.tabGroups.query({windowId:t.windowId});const current=groups.find(g=>g.id===t.groupId);
    const managed=current&&c.groups.find(g=>g.name===current.title&&g.color===current.color);
    if(current&&!managed&&c.grouping.preserve_manual)return;
    if(!rule){if(managed?.strict)await this.api.tabs.ungroup(id);return;}
    if(current?.title===rule.name&&current.color===rule.color)return;
    const live=await this.get(id);if(!live||live.url!==t.url||live.windowId!==t.windowId||live.groupId!==t.groupId)return;
    const existing=groups.find(g=>g.title===rule.name&&g.color===rule.color);
    const groupId=await this.api.tabs.group(existing?{tabIds:[id],groupId:existing.id}:{tabIds:[id],createProperties:{windowId:t.windowId}});
    if(!existing)await this.api.tabGroups.update(groupId,{title:rule.name,color:rule.color});
    this.log('grouped',{tab:id,rule:rule.id});
  }
}
