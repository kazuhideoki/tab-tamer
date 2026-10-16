const state=document.querySelector('#state');
let watchdog=setTimeout(()=>{state.textContent='反映がタイムアウトしました。コマンド側の結果を確認してください。';},65000);
try {
  const params=new URLSearchParams(location.hash.slice(1));
  const port=params.get('port'),id=params.get('id');
  if(!/^\d{1,5}$/.test(port||'')||Number(port)<1024||Number(port)>65535||!/^[a-f0-9]{32}$/.test(id||''))throw Error('反映コマンドから開いてください。');
  history.replaceState(null,'',location.pathname); // Remove request locator from the visible URL.
  const base=`http://127.0.0.1:${port}/${id}`;
  const response=await fetch(base+'/request',{cache:'no-store',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('設定を取得できませんでした。');
  const request=await response.json();
  const result=await chrome.runtime.sendMessage({type:'apply',envelope:request});
  if(result.error)throw Error(result.error);
  const ack=await fetch(base+'/ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result),signal:AbortSignal.timeout(10000)});
  if(!ack.ok)throw Error('完了通知に失敗しました。statusコマンドで保存結果を確認してください。');
  state.textContent='完了しました。';
  clearTimeout(watchdog);
  const tab=await chrome.tabs.getCurrent();if(tab)await chrome.tabs.remove(tab.id);
} catch(e) {clearTimeout(watchdog);state.textContent=`反映できませんでした: ${e.message}`;}
