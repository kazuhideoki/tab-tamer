#!/usr/bin/env python3
"""Local-only build and signed, one-shot config transfer. Python 3.11+, Node 22+."""
import argparse, base64, fcntl, hashlib, hmac, http.server, json, os, pathlib, secrets, shutil, subprocess, sys, time, tomllib
ROOT = pathlib.Path(__file__).resolve().parent.parent
STATE = ROOT / '.tab-tamer'
BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

def private_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_suffix(path.suffix + '.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(text)
    os.replace(temp, path)

def validate(path):
    if path.stat().st_size > 262144:
        raise ValueError('config exceeds 256 KiB')
    raw = tomllib.loads(path.read_text())
    result = subprocess.run(['node', str(ROOT/'scripts/validate-config.mjs')], input=json.dumps(raw), text=True, capture_output=True)
    if result.returncode:
        raise ValueError(result.stderr.strip())
    return json.loads(result.stdout)

def identity(create=False):
    path = STATE/'identity.json'
    if not path.exists():
        if not create:
            raise ValueError('Run ./tab-tamer build first')
        key = subprocess.run(['openssl','genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:2048'], capture_output=True, check=True).stdout
        public = subprocess.run(['openssl','pkey','-pubout','-outform','DER'],input=key,capture_output=True,check=True).stdout
        extid = ''.join(chr(97+int(x,16)) for x in hashlib.sha256(public).hexdigest()[:32])
        private_write(path, canonical({'key':base64.b64encode(public).decode(),'id':extid,'secret':secrets.token_hex(32)}))
    return json.loads(path.read_text())

def build():
    for source in (ROOT/'extension').glob('*.js'):
        subprocess.run(['node','--check',str(source)],check=True,capture_output=True)
    ident=identity(True)
    dest=ROOT/'dist'; dest.mkdir(exist_ok=True,mode=0o700)
    for source in (ROOT/'extension').iterdir():
        if source.is_file(): shutil.copyfile(source,dest/source.name)
    manifest=json.loads((dest/'manifest.json').read_text());manifest['key']=ident['key']
    (dest/'manifest.json').write_text(json.dumps(manifest,indent=2))
    private_write(dest/'bootstrap.js','export const secret = '+json.dumps(ident['secret'])+';\n')
    print(f'Built {dest}\nExtension ID: {ident["id"]}')

def transfer(args):
    ident=identity()
    if not (ROOT/'dist/bootstrap.js').exists():raise ValueError('Run build first')
    config=validate(args.config) if args.command=='apply' else None
    config_text=canonical(config) if config is not None else ''
    now=time.time_ns()//1_000_000
    request={'action':args.command,'id':secrets.token_hex(16),'issued':now,'expires':now+60000,'config_text':config_text,'hash':hashlib.sha256(config_text.encode()).hexdigest()}
    body=canonical(request)
    signed={'body':body,'mac':hmac.new(ident['secret'].encode(),body.encode(),hashlib.sha256).hexdigest()}
    result={}
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*unused):pass
        def respond(self,code,value):
            self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(canonical(value).encode())
        def do_GET(self):
            if self.headers.get('Host')!=f'127.0.0.1:{self.server.server_port}' or self.path!=f'/{request["id"]}/request':return self.respond(404,{})
            self.respond(200,signed)
        def do_POST(self):
            if self.headers.get('Host')!=f'127.0.0.1:{self.server.server_port}' or self.path!=f'/{request["id"]}/ack':return self.respond(404,{})
            try:
                n=int(self.headers.get('Content-Length','0'))
                if n<1 or n>16384:raise ValueError('Invalid length')
                ack=json.loads(self.rfile.read(n));ackbody=ack['body']
                expected=hmac.new(ident['secret'].encode(),ackbody.encode(),hashlib.sha256).hexdigest()
                if not hmac.compare_digest(expected,ack['mac']):raise ValueError('Invalid signature')
                value=json.loads(ackbody)
                if value.get('id')!=request['id'] or value.get('ok') is not True:raise ValueError('Invalid ACK')
                if args.command=='apply' and value.get('hash')!=request['hash']:raise ValueError('Hash mismatch')
                self.respond(200,{'ok':True});result.update(value)
            except (KeyError,ValueError,TypeError): self.respond(400,{'error':'Invalid ACK'})
    # Single-thread server and short per-connection timeout bound unsolicited connections.
    class Server(http.server.HTTPServer):
        def get_request(self):
            conn,addr=super().get_request();conn.settimeout(2);return conn,addr
    with Server(('127.0.0.1',0),Handler) as server:
        server.timeout=.3
        url=f'chrome-extension://{ident["id"]}/apply.html#port={server.server_port}&id={request["id"]}'
        command=[args.browser]
        if args.user_data_dir:command.append('--user-data-dir='+str(args.user_data_dir.resolve()))
        command.extend(['--profile-directory='+args.profile,url])
        # No shell. Launching the URL does not require remote debugging.
        process=subprocess.Popen(command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        deadline=time.monotonic()+60
        while not result and time.monotonic()<deadline:server.handle_request()
        # A newly launched browser may remain open; it is not a config-serving daemon.
        if not result:raise ValueError('No verified ACK within 60s. Check the Tab Tamer tab, then run status; configuration may already be saved.')
    private_write(STATE/'last-result.json',canonical(result))
    print(f'{args.command}: verified\nHash: {result["hash"]}\nApplied: {result["appliedAt"]}')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['build','validate','apply','status'])
    parser.add_argument('--config',type=pathlib.Path,default=ROOT/'config.toml')
    parser.add_argument('--browser',default=BRAVE)
    parser.add_argument('--user-data-dir',type=pathlib.Path)
    parser.add_argument('--profile',default='Default')
    args=parser.parse_args()
    STATE.mkdir(exist_ok=True,mode=0o700)
    with (STATE/'command.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if args.command=='build':build()
        elif args.command=='validate':
            c=validate(args.config);print(f'Valid: {len(c["groups"])} groups')
        else:transfer(args)
if __name__=='__main__':
    try:main()
    except (ValueError,OSError,subprocess.SubprocessError,tomllib.TOMLDecodeError) as e:
        print(f'Error: {e}',file=sys.stderr);sys.exit(1)
