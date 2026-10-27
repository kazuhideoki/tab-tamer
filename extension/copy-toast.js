// Top frame only. Keep page CSS and keyboard focus out of the notification.
(()=>{
  let host,timer;
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(sender.id!==chrome.runtime.id||message?.type!=='copy-result')return;
    clearTimeout(timer);host?.remove();
    host=document.createElement('div');
    host.setAttribute('data-tab-tamer-toast','');
    host.style.cssText='all:initial!important;position:fixed!important;top:20px!important;right:20px!important;z-index:2147483647!important;pointer-events:none!important;';
    const root=host.attachShadow({mode:'open'});
    const box=document.createElement('div');
    box.setAttribute('role',message.ok?'status':'alert');
    box.style.cssText='font:14px/1.5 system-ui,sans-serif;padding:12px 18px;border-radius:10px;color:white;background:'+(message.ok?'#187943':'#b3261e')+';box-shadow:0 4px 20px #0004;max-width:320px;';
    box.textContent=message.ok?'✓ コピーしました':'コピーできませんでした。Tab Tamerを開いて詳細を確認してください。';
    root.append(box);
    (document.fullscreenElement||document.documentElement).append(host);
    timer=setTimeout(()=>{host?.remove();host=null;},message.ok?2200:5000);
    reply({shown:true});
  });
})();
