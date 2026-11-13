// No values, text, keys, or form contents are read. Dirty stays set until navigation.
(() => {
  let dirty=false,media=false,mediaKnown=false;
  const identityKey='__tab_tamer_identity_v1';
  const top=window===window.top;
  let token=null,identityAvailable=false;
  if(top)try{token=sessionStorage.getItem(identityKey);identityAvailable=true;}catch{}
  const mark=e=>{if(e.isTrusted)dirty=true;};
  for(const type of ['beforeinput','input','change'])window.addEventListener(type,mark,{capture:true,passive:true});
  window.addEventListener('keydown',e=>{
    if(e.isTrusted&&e.composedPath().some(n=>n?.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(n?.tagName)))dirty=true;
  },{capture:true,passive:true});
  window.addEventListener('__tab_tamer_media_state',e=>{
    // MAIN-world events are advisory. A page can forge a positive protection flag.
    if(typeof e.detail?.active==='boolean'){media=e.detail.active;mediaKnown=e.detail.known===true;}
  });
  function probe(){
    window.dispatchEvent(new Event('__tab_tamer_media_probe'));
    return {version:1,dirty,media,mediaKnown,token,identityAvailable};
  }
  chrome.runtime.onMessage.addListener((m,s,reply)=>{
    if(s.id!==chrome.runtime.id)return;
    if(m?.type==='suspension-probe'){reply(probe());return;}
    if(m?.type==='suspension-identity'&&top&&typeof m.token==='string'){
      try{sessionStorage.setItem(identityKey,m.token);token=m.token;reply({saved:true});}catch{reply({saved:false});}
    }
  });
  if(top&&identityAvailable)chrome.runtime.sendMessage({type:'suspension-hello',token}).then(r=>{
    if(r?.token)try{sessionStorage.setItem(identityKey,r.token);token=r.token;}catch{}
  }).catch(()=>{});
})();
