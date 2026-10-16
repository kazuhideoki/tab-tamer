#!/usr/bin/env python3
"""Read the installed extensions' current log-only stores; never modify Brave."""
import base64,json,lzma,pathlib,re,struct,sys
from cli import ROOT,private_write,validate
BASE=pathlib.Path.home()/'Library/Application Support/BraveSoftware/Brave-Browser/Default'
def read_store(directory):
    if list(directory.glob('*.ldb')) or list(directory.glob('*.sst')):
        raise ValueError('Compacted store: export through extension UI instead; refusing partial migration')
    values={}
    for path in sorted(directory.glob('*.log')):
        data=path.read_bytes();pos=0
        while pos<len(data):
            remain=32768-pos%32768
            if remain<7:pos+=remain;continue
            if pos+7>len(data):raise ValueError('Incomplete log header; retry after settings are saved')
            _,length,kind=struct.unpack_from('<IHB',data,pos);pos+=7
            if kind==0 and length==0:pos+=remain-7;continue
            if kind!=1:raise ValueError('Fragmented log: export through extension UI instead')
            record=data[pos:pos+length];pos+=length
            if len(record)!=length or length<12:raise ValueError('Incomplete log record')
            _,count=struct.unpack_from('<QI',record);i=12
            def field():
                nonlocal i
                n=shift=0
                while True:
                    b=record[i];i+=1;n|=(b&127)<<shift;shift+=7
                    if b<128:break
                value=record[i:i+n];i+=n;return value.decode()
            for _ in range(count):
                kind=record[i];i+=1;key=field()
                if kind==1:values[key]=json.loads(field())
                elif kind==0:values.pop(key,None)
                else:raise ValueError('Unknown log operation')
    return values

def patterns(old):
    # Current user's patterns are plain host/path matchers, not arbitrary regexes.
    if old.startswith('/') or not re.fullmatch(r'(?:https?://)?[a-zA-Z0-9.-]+(?::[0-9]+)?(?:/[^\s]*)?',old):
        raise ValueError('Unsupported legacy pattern; migrate explicitly')
    if '://' in old:scheme,rest=old.split('://',1);schemes=[scheme]
    else:rest=old;schemes=['http','https']
    host,sep,path=rest.partition('/');path='/'+path if sep else '/*'
    result=[]
    for scheme in schemes:
        result.append(f'{scheme}://{host}{path}')
        if ':' not in host:result.append(f'{scheme}://{host}:*{path}')
    return result

def main():
    output=ROOT/'config.toml'
    if output.exists():raise ValueError('config.toml exists; refusing overwrite')
    groups=read_store(BASE/'Sync Extension Settings/danncghahncanipdoajmakdbeaophenb')
    groups=json.loads(lzma.decompress(base64.b64decode(groups['groups'])))
    settings=read_store(BASE/'Local Extension Settings/gnmdbogfankgjepgglmmfmbnimcmcjle')
    get=lambda k:settings[k]['value']
    if get('whiteList') or json.loads(get('urlRules')) or get('titleMatchMode')!='N':raise ValueError('Custom duplicate rules require explicit migration')
    if get('scope')!='A' or get('keepActiveTab') or get('prioritizeActiveWindow'):raise ValueError('Duplicate priority differs from agreed policy')
    lines=['# Migrated local settings. Never commit this file.','version = 1','','[dedup]',f'enabled = {str(get("onDuplicateTabDetected")=="A").lower()}','scope = "all_windows"']
    mapping={'ignore_hash':'ignoreHashPart','ignore_query':'ignoreSearchPart','ignore_www':'ignore3w','case_insensitive':'caseInsensitive','prefer_https':'keepTabWithHttps','keep_pinned':'keepPinnedTab'}
    for new,old in mapping.items():lines.append(f'{new} = {str(get(old)).lower()}')
    lines+=['ignore_trailing_slash = true','settle_ms = 200','new_tab_timeout_ms = 15000','exclude = []','','[focus]','foreground = true','expand_group = true','','[grouping]','enabled = true','preserve_manual = true']
    for i,g in enumerate(groups):
        if g.get('options',{}).get('merge'):raise ValueError('Cross-window grouping requires explicit migration')
        urls=[p for m in g['matchers'] for p in patterns(m)]
        lines+=['','[[groups]]',f'id = "group-{i+1}"','name = '+json.dumps(g['title'],ensure_ascii=False),'color = '+json.dumps(g['color']),'urls = '+json.dumps(urls,ensure_ascii=False),f'strict = {str(g.get("options",{}).get("strict",False)).lower()}']
    private_write(output,'\n'.join(lines)+'\n')
    validate(output)
    print(f'Migrated {len(groups)} groups to ignored config.toml; Brave stores unchanged.')
if __name__=='__main__':
    try:main()
    except Exception as e:print(str(e),file=sys.stderr);sys.exit(1)
