export const defaults = {
  version: 1,
  dedup: { enabled: true, scope: 'all_windows', ignore_hash: false, ignore_query: false,
    ignore_www: false, case_insensitive: false, prefer_https: true, ignore_trailing_slash: true,
    keep_pinned: true, settle_ms: 200, new_tab_timeout_ms: 15000, exclude: [] },
  focus: { foreground: true, expand_group: true },
  grouping: { enabled: true, preserve_manual: true }, groups: [],
};
const colors = new Set(['grey','blue','red','yellow','green','pink','purple','cyan','orange']);
function object(x, name) { if (!x || typeof x !== 'object' || Array.isArray(x)) throw Error(`${name}: object required`); }
function keys(x, allowed, name) { object(x,name); for (const k of Object.keys(x)) if (!allowed.includes(k)) throw Error(`${name}.${k}: unknown setting`); }
function text(x, name, max=2048) { if(typeof x !== 'string' || !x.length || x.length>max) throw Error(`${name}: invalid text`); }
export function glob(pattern) {
  text(pattern, 'URL pattern');
  return new RegExp('^' + pattern.split('*').map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*') + '$');
}
export function validateConfig(raw) {
  keys(raw, Object.keys(defaults), 'config');
  if (raw.version !== 1) throw Error('version must be 1');
  const c=structuredClone(defaults);
  for(const section of ['dedup','focus','grouping']) {
    if(raw[section]===undefined) continue;
    keys(raw[section],Object.keys(defaults[section]),section);
    for(const [k,v] of Object.entries(raw[section])) {
      if(typeof defaults[section][k]==='boolean' && typeof v!=='boolean') throw Error(`${section}.${k}: boolean required`);
      c[section][k]=v;
    }
  }
  if(!['all_windows','same_window'].includes(c.dedup.scope)) throw Error('invalid dedup.scope');
  for(const [k,min,max] of [['settle_ms',0,2000],['new_tab_timeout_ms',1000,60000]])
    if(!Number.isInteger(c.dedup[k]) || c.dedup[k]<min || c.dedup[k]>max) throw Error(`invalid dedup.${k}`);
  if(!Array.isArray(c.dedup.exclude) || c.dedup.exclude.length>100) throw Error('invalid dedup.exclude');
  c.dedup.exclude.forEach(glob);
  if(raw.groups!==undefined)c.groups=raw.groups;
  if(!Array.isArray(c.groups)||c.groups.length>100) throw Error('groups must be an array of at most 100 groups');
  const ids=new Set(),names=new Set();
  c.groups=c.groups.map(g=>{
    keys(g,['id','name','color','urls','strict'],'group');
    text(g.id,'group.id',80); text(g.name,'group.name',100);
    if(!/^[a-z0-9_-]+$/.test(g.id)||ids.has(g.id))throw Error('invalid or duplicate group.id');ids.add(g.id);
    if(names.has(g.name))throw Error('duplicate group.name');names.add(g.name);
    if(!colors.has(g.color))throw Error('invalid group.color');
    if(!Array.isArray(g.urls)||!g.urls.length||g.urls.length>100)throw Error('invalid group.urls');g.urls.forEach(glob);
    if(g.strict!==undefined&&typeof g.strict!=='boolean')throw Error('invalid group.strict');
    return {...g,strict:g.strict??false};
  });
  return c;
}
export function webURL(url) { try {return ['http:','https:'].includes(new URL(url).protocol);} catch{return false;} }
export function urlKey(url,c) {
  if(!webURL(url))return null;
  let u=new URL(url); if(c.dedup.exclude.some(p=>glob(p).test(u.href)))return null;
  if(c.dedup.ignore_hash)u.hash=''; if(c.dedup.ignore_query)u.search='';
  if(c.dedup.ignore_www)u.hostname=u.hostname.replace(/^www\./,'');
  if(c.dedup.prefer_https && u.protocol==='http:')u.protocol='https:';
  let key=u.href;
  if(c.dedup.ignore_trailing_slash) key=key.replace(/\/$/,'');
  if(c.dedup.case_insensitive)key=key.toLowerCase();return key;
}
export function matchGroup(url,c) { return c.groups.find(g=>g.urls.some(p=>glob(p).test(url||''))); }
export function chooseSurvivor(source,tabs,c,rank) {
  const key=urlKey(source.url,c); if(!key)return null;
  return tabs.filter(t=>t.id!==source.id && !t.incognito && !t.pendingUrl &&
    (t.status==='complete'||t.discarded) && t.windowType==='normal' &&
    (c.dedup.scope==='all_windows'||t.windowId===source.windowId) &&
    rank(t.id)<rank(source.id) && urlKey(t.url,c)===key)
    .sort((a,b)=>(c.dedup.keep_pinned?Number(!!b.pinned)-Number(!!a.pinned):0)||(c.dedup.prefer_https?Number(b.url.startsWith('https:'))-Number(a.url.startsWith('https:')):0)||rank(a.id)-rank(b.id)||a.id-b.id)[0]||null;
}
