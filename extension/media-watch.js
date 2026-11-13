// Runs in MAIN at document_start to observe newly requested media without reading it.
(() => {
  const streams=new Set(),connections=new Set(),hooks=[];let known=true;
  const publish=()=>{
    for(const stream of streams)if(stream.getTracks().every(t=>t.readyState==='ended'))streams.delete(stream);
    for(const pc of connections)if(pc.connectionState==='closed')connections.delete(pc);
    const intact=known&&hooks.every(([object,key,hook])=>object[key]===hook);
    window.dispatchEvent(new CustomEvent('__tab_tamer_media_state',{detail:{known:intact,active:streams.size>0||connections.size>0}}));
  };
  window.addEventListener('__tab_tamer_media_probe',publish);
  function watch(stream){
    const tracks=stream.getTracks();streams.add(stream);
    const changed=()=>{if(tracks.every(t=>t.readyState==='ended'))streams.delete(stream);publish();};
    tracks.forEach(t=>t.addEventListener('ended',changed));changed();return stream;
  }
  const devices=navigator.mediaDevices;
  for(const key of ['getUserMedia','getDisplayMedia'])if(typeof devices?.[key]==='function'){
    const original=devices[key];
    const hook=function(...args){return Reflect.apply(original,this,args).then(watch);};
    try{devices[key]=hook;hooks.push([devices,key,hook]);}catch{known=false;}
  }
  const Original=window.RTCPeerConnection;
  if(Original)try{const hook=new Proxy(Original,{construct(target,args,newTarget){
    const pc=Reflect.construct(target,args,newTarget);connections.add(pc);publish();
    pc.addEventListener('connectionstatechange',()=>{if(pc.connectionState==='closed')connections.delete(pc);publish();});
    const close=pc.close;pc.close=function(...args){const result=Reflect.apply(close,this,args);connections.delete(pc);publish();return result;};
    return pc;
  }});window.RTCPeerConnection=hook;hooks.push([window,'RTCPeerConnection',hook]);}catch{known=false;}
})();
