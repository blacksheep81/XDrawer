#!/usr/bin/env python3
"""Runs the Drive sync tests in headless Chrome against an in-memory Drive.

    python tests/sync/run.py            run once, exit 0 when everything passes
    python tests/sync/run.py --serve    keep serving so the page can be opened by hand

Only the Python standard library is needed. Set CHROME to pick a browser.
"""
import http.server, json, os, pathlib, re, shutil, subprocess, sys, tempfile, threading

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).resolve().parent
TIMEOUT = 180
outcome = {}
finished = threading.Event()

# library.html runs inside a test iframe with just enough of the extension API to start.
LIBRARY_STUB = b"""<script>
window.addEventListener('error', event => parent.postMessage({ libraryError:event.message }, '*'));
window.addEventListener('unhandledrejection', event => parent.postMessage({ libraryError:String(event.reason) }, '*'));
window.chrome = { runtime:{ getURL:p => '/' + p, onMessage:{ addListener(){} }, sendMessage:async () => ({ ok:true, configured:false, state:{} }) },
  tabs:{ query:async () => [], sendMessage:async () => null }, cookies:{ get:async () => null, getAll:async () => [] },
  storage:{ local:{ get:async () => ({}), set:async () => {} } } };
</script>"""


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def reply(self, body, content_type='text/html; charset=utf-8'):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/':
            return self.reply((HERE / 'synctest.html').read_bytes())
        if path == '/sync.js':
            # The connect flow refuses to run without a client ID; the real one is never needed here.
            source = (ROOT / 'sync.js').read_text(encoding='utf-8')
            source = re.sub(r"GOOGLE_CLIENT_ID = '[^']*'", "GOOGLE_CLIENT_ID = 'test-client'", source)
            return self.reply(source.encode('utf-8'), 'text/javascript; charset=utf-8')
        if path == '/library.html':
            return self.reply((ROOT / 'library.html').read_bytes().replace(b'<head>', b'<head>' + LIBRARY_STUB, 1))
        return super().do_GET()

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        outcome.update(json.loads(body))
        self.reply(b'ok', 'text/plain')
        finished.set()


def find_browser():
    candidates = [
        os.environ.get('CHROME'),
        shutil.which('google-chrome'), shutil.which('chromium'), shutil.which('chromium-browser'), shutil.which('chrome'),
        r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]
    return next((path for path in candidates if path and os.path.exists(path)), None)


def main():
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_address[1]}/'

    if '--serve' in sys.argv:
        print(f'打开 {url} 查看测试结果，按 Ctrl+C 退出。')
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            return 0

    browser = find_browser()
    if not browser:
        print('找不到 Chrome 或 Edge，请用环境变量 CHROME 指定路径。', file=sys.stderr)
        return 2

    profile = tempfile.mkdtemp(prefix='x-drawer-sync-test-')
    process = subprocess.Popen(
        [browser, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', f'--user-data-dir={profile}', url + '?report=1'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not finished.wait(TIMEOUT):
            print(f'{TIMEOUT} 秒内没有结果。', file=sys.stderr)
            return 2
    finally:
        process.terminate()
        try:
            process.wait(10)
        except subprocess.TimeoutExpired:
            process.kill()
        shutil.rmtree(profile, ignore_errors=True)
        server.shutdown()

    sys.stdout.reconfigure(encoding='utf-8')
    for failure in outcome.get('failed', []):
        print(f"FAIL {failure['name']}\n     {failure['detail']}")
    print(f"{outcome.get('passed', 0)} passed, {len(outcome.get('failed', []))} failed")
    if outcome.get('scale'):
        print(outcome['scale'])
    return 1 if outcome.get('failed') or not outcome.get('passed') else 0


if __name__ == '__main__':
    sys.exit(main())
