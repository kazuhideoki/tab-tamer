"""Bounded live-Brave probe. Creates only test windows; closes only owned windows.
Run explicitly with python3 scripts/research/reproduce-focus.py.
No extension settings are changed. JSON output contains only test URLs and IDs.
"""
import http.server, threading, subprocess, json, time, uuid

def osa(body):
    result = subprocess.run(['osascript','-e','tell application id "com.brave.Browser"\n'+body+'\nend tell'],capture_output=True,text=True,timeout=15)
    if result.returncode: raise RuntimeError(result.stderr)
    return result.stdout.strip()

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body=b'<!doctype html><title>Tab Tamer focus probe</title><h1>Tab Tamer focus probe</h1>'
        self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers(); self.wfile.write(body)
    def log_message(self,*args): pass

server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}/{uuid.uuid4().hex}'
owned=[]
original=osa('return id of front window')
original_tabs=osa('return id of every tab of front window')

def snap(label):
    rows=[]
    for wid in owned:
        try:
            raw=osa(f'''set w to window id {wid}
set output to ""
repeat with t in tabs of w
set output to output & (id of t) & "|" & (URL of t) & linefeed
end repeat
return (id of active tab of w) & linefeed & output''')
            lines=raw.splitlines(); rows.append({'window':wid,'active':lines[0],'tabs':lines[1:]})
        except RuntimeError: rows.append({'window':wid,'closed':True})
    print(json.dumps({'case':label,'front':osa('return id of front window'),'windows':rows}),flush=True)

def window(url):
    wid=osa(f'set w to make new window\nset URL of active tab of w to "{url}"\nreturn id of w')
    owned.append(wid);time.sleep(1);return wid

def duplicate(wid,active):
    return osa(f'''set w to window id {wid}
set t to make new tab at end of tabs of w with properties {{URL:"{base}/pending-{uuid.uuid4().hex}"}}
{'set active tab index of w to count tabs of w' if active else ''}
set URL of t to "{base}/target"
return "requested"''')
try:
    first=window(base+'/target')
    osa(f'make new tab at end of tabs of window id {first} with properties {{URL:"{base}/other"}}\nset active tab index of window id {first} to 2\nactivate')
    time.sleep(1);snap('same-window-before')
    duplicate(first,True);time.sleep(1.2);snap('same-window-foreground-after')
    osa(f'set active tab index of window id {first} to 2')
    snap('background-before');duplicate(first,False);time.sleep(1.2);snap('background-after')
    second=window(base+'/second-window')
    osa(f'set index of window id {second} to 1\nactivate')
    snap('cross-window-before');duplicate(second,True);time.sleep(1.2);snap('cross-window-after')
    osa(f'set index of window id {second} to 1\nactivate')
    subprocess.run(['open','-a','Brave Browser',base+'/target'],check=True)
    time.sleep(1.2);snap('external-open-after')
finally:
    for wid in owned:
        try:
            # Refuse cleanup if a user added an unrelated tab into a test window.
            urls=osa(f'return URL of every tab of window id {wid}')
            if all(u.startswith(base) for u in urls.split(', ')):
                osa(f'close window id {wid}')
            else: print(json.dumps({'cleanup':'retained window with unrelated URL','window':wid}))
        except RuntimeError: pass
    try: osa(f'set index of window id {original} to 1')
    except RuntimeError: pass
    print(json.dumps({'original_tab_ids_unchanged':osa(f'return id of every tab of window id {original}')==original_tabs,'remaining_windows':osa('count windows')}))
    server.shutdown()
