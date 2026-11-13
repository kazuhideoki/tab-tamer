// Bind controls to the tab shown when this popup opens, across asynchronous work.
const residentTabPromise=chrome.tabs.query({active:true,currentWindow:true}).then(tabs=>tabs[0]);
const button=document.querySelector('#copy-markdown');
const result=document.querySelector('#copy-result');
button.addEventListener('click',async()=>{
  button.disabled=true;result.textContent='コピー中…';
  try {
    const response=await chrome.runtime.sendMessage({type:'copy-markdown'});
    result.textContent=response?.ok?(response.message||'コピーしました。'):`コピー失敗：${response?.error||'応答がありません。'}`;
  }catch{result.textContent='コピー失敗：拡張を再読み込みして再試行してください。';}
  finally{button.disabled=false;}
});
chrome.commands.getAll().then(commands=>{
  document.querySelector('#copy-shortcut').textContent=[['copy-url','URL'],['copy-markdown','Markdown']].map(([name,label])=>{
    const shortcut=commands.find(c=>c.name===name)?.shortcut;
    return `${label}：${shortcut||'未割り当て（brave://extensions/shortcuts で設定）'}`;
  }).join(' ／ ');
});
chrome.storage.session.get('copyResult').then(({copyResult})=>{
  if(copyResult&&!result.textContent)result.textContent=`前回（${new Date(copyResult.at).toLocaleTimeString()}）：${copyResult.ok?(copyResult.message||'コピーしました。'):'コピー失敗：'+copyResult.error}`;
});
const s=await chrome.runtime.sendMessage({type:'status'});
document.querySelector('#state').textContent=s.configured?`${s.groups}グループ · 反映 ${s.appliedAt} · ${s.hash.slice(0,12)}`:'設定が未反映です。';
document.querySelector('#logs').textContent=s.logs.map(x=>JSON.stringify(x)).join('\n');

const residentState=document.querySelector('#resident-state');
const residentToggle=document.querySelector('#resident-toggle');
const residentPin=document.querySelector('#resident-pin');
let resident;
async function refreshResident(mode){
  residentToggle.disabled=true;residentPin.disabled=true;
  try{
    const tab=await residentTabPromise;
    if(!tab)throw Error('現在のタブが見つかりません。');
    const r=await chrome.runtime.sendMessage(mode?{type:'suspension-set',tabId:tab.id,mode}:{type:'suspension-status',tabId:tab.id});
    if(r?.error)throw Error(r.error);
    resident=r;
    residentState.textContent=`常駐：${r.resident?'オン':'オフ'}（${r.mode==='pin'?'Pinに連動':'手動指定'}） · ${r.reason}`;
    residentToggle.textContent=`常駐を${r.resident?'オフ':'オン'}にする`;
  }catch(e){residentState.textContent=e.message;}
  finally{residentToggle.disabled=false;residentPin.disabled=resident?.mode==='pin';}
}
residentToggle.addEventListener('click',()=>refreshResident(resident?.resident?'off':'on'));
residentPin.addEventListener('click',()=>refreshResident('pin'));
await refreshResident();
