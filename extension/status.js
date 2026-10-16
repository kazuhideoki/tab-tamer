const s=await chrome.runtime.sendMessage({type:'status'});
document.querySelector('#state').textContent=s.configured?`${s.groups}グループ · 反映 ${s.appliedAt} · ${s.hash.slice(0,12)}`:'設定が未反映です。';
document.querySelector('#logs').textContent=s.logs.map(x=>JSON.stringify(x)).join('\n');
