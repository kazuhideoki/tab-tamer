// Independent of tab grouping and its configuration/queue.
export function markdownLink(tab) {
  if(!tab?.url)throw Error('現在のタブのURLを取得できません。');
  const title=(tab.title||tab.url).replace(/[\r\n\t]+/g,' ');
  return `[${title}](${tab.url})`;
}
export function installMarkdownCopy(api) {
  let queue=Promise.resolve();
  async function copy(tabPromise,format) {
    let result,tab;
    const label=format==='copy-url'?'URL':'Markdown形式';
    try {
      tab=await tabPromise;
      if(!tab?.url)throw Error('現在のタブのURLを取得できません。');
      const text=format==='copy-url'?tab.url:markdownLink(tab);
      const contexts=await api.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[api.runtime.getURL('clipboard.html')]});
      if(!contexts.length)await api.offscreen.createDocument({url:'clipboard.html',reasons:['CLIPBOARD'],justification:'Copy the current tab URL or Markdown link.'});
      const response=await api.runtime.sendMessage({target:'clipboard',text});
      if(!response?.ok)throw Error(response?.error||'クリップボードから応答がありません。');
      result={ok:true,message:`${label}${format==='copy-url'?'を':'で'}コピーしました`,at:Date.now()};
    }catch(e){result={ok:false,message:`${label}のコピーに失敗しました`,error:String(e.message||e),at:Date.now()};}
    // Feedback persists across worker suspension; it describes the latest attempt.
    await Promise.allSettled([
      api.storage.session.set({copyResult:result}),
      api.action.setBadgeText({text:result.ok?'OK':'ERR'}),
      api.action.setBadgeBackgroundColor({color:result.ok?'#187943':'#b3261e'}),
      api.action.setTitle({title:'Tab Tamer：'+result.message+(result.ok?'':' — '+result.error)})
    ]);
    // Recover the page receiver after an extension reload, without reloading the page.
    const message={type:'copy-result',ok:result.ok,message:result.message};
    async function pageNotification() {
      if(tab?.id===undefined)throw Error('No source tab');
      const response=await api.tabs.sendMessage(tab.id,message,{frameId:0});
      if(!response?.shown)throw Error('No page notification');
    }
    try {
      try {await pageNotification();}
      catch {
        if(tab?.id===undefined||!/^https?:\/\//.test(tab.url||''))throw Error('Page notification unavailable');
        await api.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},files:['copy-toast.js']});
        await pageNotification();
      }
      result.notification={channel:'page',shown:true};
    }catch{
      try {
        await api.notifications.create('copy-result',{
          type:'basic',iconUrl:api.runtime.getURL('notification.png'),title:'Tab Tamer',
          message:result.message+(result.ok?'':`：${result.error}`),
          silent:true
        });
        // OS settings may still suppress the banner after accepting the notification.
        result.notification={channel:'system',accepted:true};
      }catch(e){result.notification={channel:'none',error:String(e.message||e)};}
    }
    // Notification failure must never turn a successful clipboard write into a failure.
    try {await api.storage.session.set({copyResult:result});}catch{}
    return result;
  }
  function request(tab,format='copy-markdown') {
    // Capture the tab at invocation, before queued clipboard operations.
    const snapshot=tab?Promise.resolve(tab):api.tabs.query({active:true,lastFocusedWindow:true}).then(t=>t[0]);
    // Attach rejection handling immediately, even while another copy is pending.
    const captured=snapshot.then(tab=>({tab}),error=>({error}));
    const operation=queue.then(async()=>{const value=await captured;return copy(value.error?Promise.reject(value.error):Promise.resolve(value.tab),format);});
    queue=operation.catch(()=>{});return operation;
  }
  api.commands.onCommand.addListener((command,tab)=>{if(command==='copy-markdown'||command==='copy-url')void request(tab,command);});
  api.runtime.onMessage.addListener((message,sender,reply)=>{
    if(message?.type!=='copy-markdown'||sender.id!==api.runtime.id||(sender.url||'').split(/[?#]/)[0]!==api.runtime.getURL('status.html'))return;
    request().then(reply);return true;
  });
}
