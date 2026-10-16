const utf8=new TextEncoder();
export async function sign(body,secret) {
  const key=await crypto.subtle.importKey('raw',utf8.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,utf8.encode(body)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function verify(envelope,secret) {
  if(typeof envelope?.body!=='string'||envelope.body.length>262144||!/^([a-f0-9]{64})$/.test(envelope.mac||'')) throw Error('Invalid signed message');
  const expected=await sign(envelope.body,secret);
  let diff=0;for(let i=0;i<64;i++)diff|=expected.charCodeAt(i)^envelope.mac.charCodeAt(i);
  if(diff)throw Error('Signature mismatch');return JSON.parse(envelope.body);
}
export async function digest(text) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',utf8.encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function envelope(value,secret) {const body=JSON.stringify(value);return {body,mac:await sign(body,secret)};}
