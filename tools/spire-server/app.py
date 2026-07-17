"""Accessible web wrapper around DataBeaver's trimps-tools spire optimizer.

Serves a labeled form, runs the genetic optimizer for a bounded time, and renders
the best layout as a screen-reader-friendly floor-by-floor list. Stdlib only.
"""
import html
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

SPIRE_BIN = '/app/spire'
BASE = '/tools/spire'
# Authoritative trap letters from spirelayout.cpp: const char Layout::traps[] = "_FZPLSCK"
TRAP_NAMES = {
    '_': 'empty', 'F': 'Fire trap', 'Z': 'Frost trap', 'P': 'Poison trap',
    'L': 'Lightning trap', 'S': 'Strength tower', 'C': 'Condenser tower', 'K': 'Knowledge tower',
}
RUNTIMES = (10, 30, 60, 120)
MAX_FLOORS = 30

PAGE_TOP = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spire Layout Optimizer</title>
<style>body{font-family:sans-serif;max-width:45em;margin:1em auto;padding:0 1em;line-height:1.6}
label{display:block;margin-top:0.8em}input,select{font-size:1em}</style></head><body>
<h1>Spire Layout Optimizer</h1>
<p>Finds a strong Spire trap layout using DataBeaver's trimps-tools optimizer. Pick your
Spire size and budget, then run; longer runs find better layouts.</p>"""

FORM = """<form method="post" action="{base}/run">
<label>Number of floors in your Spire
<input name="floors" type="text" inputmode="numeric" required value="{floors}"></label>
<label>Runestone budget (plain number, no suffixes, for example 250000000)
<input name="budget" type="text" inputmode="numeric" required value="{budget}"></label>
<label>Trap upgrade levels as four digits: Fire, Frost, Poison, Lightning (0 = not unlocked)
<input name="upgrades" type="text" required pattern="[0-9]{{4}}" value="{upgrades}"></label>
<label>Core description, optional (for example epic/poison:40/lightning:30)
<input name="core" type="text" value="{core}"></label>
<label><input name="income" type="checkbox" {income}> Optimize runestone income instead of pure damage</label>
<label>How long to search
<select name="runtime">{runtime_options}</select></label>
<button type="submit">Find layout</button>
</form></body></html>"""


def form_html(floors='20', budget='1000000000', upgrades='5555', core='', income=False, runtime=30):
    opts = ''.join(
        '<option value="%d"%s>%d seconds</option>' % (r, ' selected' if r == runtime else '', r)
        for r in RUNTIMES)
    return PAGE_TOP + FORM.format(base=BASE, floors=html.escape(floors), budget=html.escape(budget),
                                  upgrades=html.escape(upgrades), core=html.escape(core),
                                  income='checked' if income else '', runtime_options=opts)


BEST_RE = re.compile(r'New best layout found \(([^)]*)\):\s*\n\s*(\d{4}) ((?:[A-Z_]{1,5}\s*)+)')


def run_optimizer(floors, budget, upgrades, core, income, runtime):
    cmd = [SPIRE_BIN, '-f', str(floors), '-b', str(budget), '-u', upgrades, '-w', '2']
    if income:
        cmd.append('-i')
    if core:
        cmd += ['-c', core]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=runtime,
                              env={'TERM': 'dumb'})
        out = proc.stdout + proc.stderr
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b'').decode(errors='replace') + (e.stderr or b'').decode(errors='replace')
    matches = list(BEST_RE.finditer(out))
    if not matches:
        return None, out[-800:]
    return matches[-1], None


def result_html(match, floors):
    stats, upgrades, cells = match.group(1), match.group(2), match.group(3)
    flat = re.sub(r'\s+', '', cells)
    floor_items = []
    for i in range(0, len(flat), 5):
        row = flat[i:i + 5]
        names = ', '.join(TRAP_NAMES.get(ch, ch) for ch in row)
        floor_items.append('<li>Floor %d: %s (%s)</li>' % (i // 5 + 1, names, html.escape(row)))
    layout_string = upgrades + ' ' + ' '.join(flat[i:i + 5] for i in range(0, len(flat), 5))
    return (PAGE_TOP +
            '<h2 role="status">Best layout found</h2>'
            '<p>' + html.escape(stats) + '. Upgrade levels (Fire, Frost, Poison, Lightning): ' +
            html.escape(upgrades) + '.</p>'
            '<p>Floors are listed bottom to top; each floor reads left to right.</p>'
            '<ol>' + ''.join(floor_items) + '</ol>'
            '<label>Full layout string<br>'
            '<textarea rows="3" cols="60" readonly onfocus="this.select()">' +
            html.escape(layout_string) + '</textarea></label>'
            '<p><a href="' + BASE + '/">Run another search</a></p></body></html>')


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip('/') in ('', BASE, BASE + ''):
            self._send(200, form_html())
        else:
            self._send(404, PAGE_TOP + '<p>Not found. <a href="' + BASE + '/">Go to the optimizer form</a>.</p></body></html>')

    def do_POST(self):
        if not self.path.startswith(BASE + '/run'):
            self._send(404, 'not found')
            return
        length = int(self.headers.get('Content-Length', 0))
        q = parse_qs(self.rfile.read(min(length, 4096)).decode())
        get = lambda k, d='': q.get(k, [d])[0].strip()
        try:
            floors = int(get('floors', '20'))
            budget = float(get('budget', '0'))
            if not (1 <= floors <= MAX_FLOORS) or budget <= 0:
                raise ValueError
            upgrades = get('upgrades', '5555')
            if not re.fullmatch(r'\d{4}', upgrades):
                raise ValueError
            core = get('core')
            if core and not re.fullmatch(r'[a-zA-Z0-9:/._-]{0,120}', core):
                raise ValueError
            runtime = int(get('runtime', '30'))
            if runtime not in RUNTIMES:
                runtime = 30
        except ValueError:
            self._send(400, PAGE_TOP + '<p role="alert">Invalid input. Floors must be 1 to %d, budget a positive number, upgrades exactly four digits.</p><p><a href="%s/">Back to the form</a></p></body></html>' % (MAX_FLOORS, BASE))
            return
        match, raw = run_optimizer(floors, '%d' % budget, upgrades, core, get('income') == 'on', runtime)
        if match is None:
            self._send(200, PAGE_TOP + '<p role="alert">The optimizer produced no layout in the time given. Raw output tail:</p><pre>' + html.escape(raw or 'none') + '</pre><p><a href="' + BASE + '/">Back to the form</a></p></body></html>')
            return
        self._send(200, result_html(match, floors))

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
