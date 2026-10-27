// Independent of tab grouping and its configuration/queue.
export function markdownLink(tab) {
  if(!tab?.url)throw Error('現在のタブのURLを取得できません。');
  const title=(tab.title||tab.url).replace(/[\r\n\t]+/g,' ').replace(/[\\`*_{}\[\]<>()!|&~]/g,'\\$&');
  // Encode delimiters without decoding existing percent escapes or changing queries.
  const url=tab.url.replace(/[\s\u0000-\u001f\u007f<>()[\]\\`"']/g,c=>encodeURIComponent(c).replace(/[()']/g,x=>'%'+x.charCodeAt(0).toString(16).toUpperCase())).replace(/&/g,'&amp;');
  return `[${title}](${url})`;
}
export function installMarkdownCopy(api) {
  let queue=Promise.resolve();
  async function copy(tabPromise) {
    let result,tab;
    try {
      tab=await tabPromise;
      const text=markdownLink(tab);
      const contexts=await api.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[api.runtime.getURL('clipboard.html')]});
      if(!contexts.length)await api.offscreen.createDocument({url:'clipboard.html',reasons:['CLIPBOARD'],justification:'Copy the current tab as a Markdown link.'});
      const response=await api.runtime.sendMessage({target:'clipboard',text});
      if(!response?.ok)throw Error(response?.error||'クリップボードから応答がありません。');
      result={ok:true,at:Date.now()};
    }catch(e){result={ok:false,error:String(e.message||e),at:Date.now()};}
    // Feedback persists across worker suspension; it describes the latest attempt.
    await Promise.allSettled([
      api.storage.session.set({copyResult:result}),
      api.action.setBadgeText({text:result.ok?'OK':'ERR'}),
      api.action.setBadgeBackgroundColor({color:result.ok?'#187943':'#b3261e'}),
      api.action.setTitle({title:result.ok?'Tab Tamer：コピーしました':'Tab Tamer：コピー失敗 — '+result.error})
    ]);
    // Notification failure must never turn a successful copy into a failure.
    try {
      const shown=tab?.id!==undefined&&await api.tabs.sendMessage(tab.id,{type:'copy-result',ok:result.ok},{frameId:0});
      if(!shown?.shown)throw Error('No page notification');
    }catch{
      try {await api.action.openPopup(tab?.windowId!==undefined?{windowId:tab.windowId}:{});}catch{}
    }
    return result;
  }
  function request(tab) {
    // Capture the tab at invocation, before queued clipboard operations.
    const snapshot=tab?Promise.resolve(tab):api.tabs.query({active:true,lastFocusedWindow:true}).then(t=>t[0]);
    // Attach rejection handling immediately, even while another copy is pending.
    const captured=snapshot.then(tab=>({tab}),error=>({error}));
    const operation=queue.then(async()=>{const value=await captured;return copy(value.error?Promise.reject(value.error):Promise.resolve(value.tab));});
    queue=operation.catch(()=>{});return operation;
  }
  api.commands.onCommand.addListener((command,tab)=>{if(command==='copy-markdown')void request(tab);});
  api.runtime.onMessage.addListener((message,sender,reply)=>{
    if(message?.type!=='copy-markdown'||sender.id!==api.runtime.id||(sender.url||'').split(/[?#]/)[0]!==api.runtime.getURL('status.html'))return;
    request().then(reply);return true;
  });
}
