const button=document.querySelector('#copy-markdown');
const result=document.querySelector('#copy-result');
button.addEventListener('click',async()=>{
  button.disabled=true;result.textContent='コピー中…';
  try {
    const response=await chrome.runtime.sendMessage({type:'copy-markdown'});
    result.textContent=response?.ok?'コピーしました。':`コピー失敗：${response?.error||'応答がありません。'}`;
  }catch{result.textContent='コピー失敗：拡張を再読み込みして再試行してください。';}
  finally{button.disabled=false;}
});
chrome.commands.getAll().then(commands=>{
  const shortcut=commands.find(c=>c.name==='copy-markdown')?.shortcut;
  document.querySelector('#copy-shortcut').textContent=shortcut?`ショートカット：${shortcut}`:'ショートカット未割り当て：brave://extensions/shortcuts で設定してください。';
});
chrome.storage.session.get('copyResult').then(({copyResult})=>{
  if(copyResult&&!result.textContent)result.textContent=`前回（${new Date(copyResult.at).toLocaleTimeString()}）：${copyResult.ok?'コピーしました。':'コピー失敗：'+copyResult.error}`;
});
const s=await chrome.runtime.sendMessage({type:'status'});
document.querySelector('#state').textContent=s.configured?`${s.groups}グループ · 反映 ${s.appliedAt} · ${s.hash.slice(0,12)}`:'設定が未反映です。';
document.querySelector('#logs').textContent=s.logs.map(x=>JSON.stringify(x)).join('\n');
