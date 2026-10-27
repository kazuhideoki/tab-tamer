chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||message?.target!=='clipboard'||typeof message.text!=='string')return;
  const input=document.querySelector('#clipboard');
  try {
    input.value=message.text;input.focus();input.select();
    if(!document.execCommand('copy'))throw Error('クリップボードに書き込めませんでした。再試行してください。');
    reply({ok:true});
  }catch(e){reply({ok:false,error:String(e.message||e)});}
  finally{input.value='';}
});
