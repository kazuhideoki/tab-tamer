// Only the first real interaction matters. Do not send keys, targets or page
// content, and ignore synthetic events used by sites during initialization.
const events=['pointerdown','keydown','click','auxclick','input','submit'];
function interacted(event) {
  if(!event.isTrusted)return;
  for(const type of events)window.removeEventListener(type,interacted,true);
  chrome.runtime.sendMessage({type:'page-interaction'}).catch(()=>{});
}
for(const type of events)window.addEventListener(type,interacted,{capture:true,passive:true});
