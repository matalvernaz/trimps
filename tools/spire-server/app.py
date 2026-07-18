"""Accessible web wrapper around DataBeaver's trimps-tools spire optimizer.

Serves a labeled form, runs the genetic optimizer for a bounded time, and renders
the best layout as a screen-reader-friendly floor-by-floor list plus the exact
in-game commands to build it. Can pre-fill the form from a pasted Trimps save.
Stdlib only.
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
# Letter -> the name the in-game accessible Spire command box expects for "Build".
LETTER_TO_CMD = {
    'F': 'Fire', 'Z': 'Frost', 'P': 'Poison', 'L': 'Lightning',
    'S': 'Strength', 'C': 'Condenser', 'K': 'Knowledge',
}
# Emit Build lines in this order so towers come after the damage traps.
CMD_ORDER = ['Fire', 'Frost', 'Poison', 'Lightning', 'Strength', 'Condenser', 'Knowledge']
RUNTIMES = (10, 30, 60, 120)
MAX_FLOORS = 30
# Core descriptions the optimizer rejects are caught before the real run; these are the
# substrings its parser prints on a bad -c string.
CORE_ERR_MARKERS = ('invalid core tier', 'too few mods', 'too many mods', 'below base value',
                    'above', 'invalid ')

PAGE_TOP = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spire Layout Optimizer</title>
<style>body{font-family:sans-serif;max-width:45em;margin:1em auto;padding:0 1em;line-height:1.6}
label{display:block;margin-top:0.8em}input,select,textarea{font-size:1em}
textarea{width:100%;box-sizing:border-box}details{margin:1em 0;border:1px solid #999;border-radius:4px;padding:0.5em}
summary{cursor:pointer;font-weight:bold}.note{border-left:4px solid #b58900;padding:0.3em 0.6em;background:#fff8e1}
ol,ul{margin:0.4em 0}</style></head><body>
<h1>Spire Layout Optimizer</h1>
<p>Finds a strong Spire trap layout using DataBeaver's trimps-tools optimizer. Paste a save to
fill the fields automatically, or enter them by hand, then run; longer runs find better layouts.</p>"""

# Static: the paste-a-save panel. Its script fills the form fields below.
SAVE_SECTION = """<details open>
<summary>Fill from a Trimps save (optional)</summary>
<p>In Trimps, open the menu and choose Export Save, copy the whole string, and paste it here.
The save is read in your browser only; nothing is uploaded.</p>
<label for="saveBox">Paste your Trimps export save
<textarea id="saveBox" rows="3" spellcheck="false" autocomplete="off"></textarea></label>
<button type="button" id="readSaveBtn">Read save</button>
<p id="saveStatus" role="status" aria-live="polite"></p>
</details>"""

FORM = """<form method="post" action="{base}/run">
<label>Number of floors in your Spire
<input id="floors" name="floors" type="text" inputmode="numeric" required value="{floors}"></label>
<label>Runestone budget (plain number, no suffixes, for example 250000000)
<input id="budget" name="budget" type="text" inputmode="numeric" required value="{budget}"></label>
<label>Trap upgrade levels as four digits: Fire, Frost, Poison, Lightning (each trap's in-game level; use 0 if Poison or Lightning is not unlocked yet)
<input id="upgrades" name="upgrades" type="text" required pattern="[0-9]{{4}}" value="{upgrades}"></label>
<label>Core description, optional (for example epic/poison:40/lightning:30)
<input id="core" name="core" type="text" value="{core}"></label>
<label><input name="income" type="checkbox" {income}> Optimize runestone income instead of pure damage</label>
<label>How long to search
<select name="runtime">{runtime_options}</select></label>
<button type="submit">Find layout</button>
</form>"""

# Client-side save reader. Loaded lz-string is served from the site root (same origin).
# Mapping notes:
#   floors   = playerSpire.main.rowsAllowed
#   budget   = playerSpire.main.runestones
#   upgrades = per trap, locked ? 0 : in-game level, clamped to the max digit. DataBeaver's -u
#              digit IS the in-game trap level (0 = poison/lightning not unlocked); confirmed by
#              its max levels 10/8/9/7 matching the game's exactly. Fire's max of 10 can't fit a
#              single -u digit, so it clamps to 9.
#   core     = global.CoreEquipped: rarity index -> tier name, non-empty mods -> stat:value.
SCRIPT = r"""<script src="/lz-string.js"></script>
<script>
(function(){
  "use strict";
  var MAXDIG = {Fire:9, Frost:8, Poison:9, Lightning:7};
  var TIER = {1:"common", 2:"rare", 3:"epic", 4:"legendary", 5:"magnificent", 6:"ethereal"};
  var MODTOK = {fireTrap:"fire", poisonTrap:"poison", lightningTrap:"lightning",
                runestones:"runestones", strengthEffect:"strength", condenserEffect:"condenser"};

  function plainInt(n){
    if(typeof n !== "number" || !isFinite(n)) return "";
    return n.toLocaleString("fullwide", {useGrouping:false, maximumFractionDigits:0});
  }
  function setVal(id, v){
    var el = document.getElementById(id);
    if(el && v !== null && v !== undefined && v !== "") el.value = v;
  }
  function coreString(core){
    // Returns {str, note}. str is "" when the core has no usable mods.
    if(!core || !core.mods) return {str:"", note:""};
    var rarity = core.rarity | 0, note = "", tier;
    if(rarity >= 1 && rarity <= 6){ tier = TIER[rarity]; }
    else if(rarity >= 7){ tier = "ethereal"; note = "core rarity is above the optimizer's top tier, approximated as ethereal"; }
    else { tier = "common"; }
    var parts = [];
    for(var i=0; i<core.mods.length; i++){
      var m = core.mods[i];
      if(!m) continue;
      var tok = MODTOK[m[0]];
      if(!tok || m[0] === "empty") continue;
      var v = Math.round(m[1]);
      if(v <= 0) continue;
      parts.push(tok + ":" + v);
    }
    if(!parts.length) return {str:"", note:""};
    return {str: tier + "/" + parts.join("/"), note: note};
  }
  function readSave(){
    var status = document.getElementById("saveStatus");
    var raw = (document.getElementById("saveBox").value || "").replace(/\s+/g, "");
    if(!raw){ status.textContent = "Paste a save first."; return; }
    var json = null, save = null;
    try { json = LZString.decompressFromBase64(raw); } catch(e){}
    try { save = JSON.parse(json); } catch(e){}
    if(!save){ status.textContent = "Could not read that save. Use the game's Export Save button and paste the whole string."; return; }

    var msgs = [];
    var main = (save.playerSpire && save.playerSpire.main) ? save.playerSpire.main : null;
    var traps = (save.playerSpire && save.playerSpire.traps) ? save.playerSpire.traps : null;
    if(main){
      if(typeof main.rowsAllowed === "number"){ setVal("floors", String(main.rowsAllowed)); msgs.push(main.rowsAllowed + " floors"); }
      if(typeof main.runestones === "number"){ var b = plainInt(main.runestones); setVal("budget", b); msgs.push("budget " + b); }
    } else {
      status.textContent = "This save has not opened the Player Spire yet, so there is nothing to fill.";
      return;
    }
    if(traps){
      var order = ["Fire", "Frost", "Poison", "Lightning"], digits = "", capped = false;
      for(var i=0; i<order.length; i++){
        var t = traps[order[i]];
        var d = (!t || t.locked) ? 0 : (t.level | 0);
        if(d > MAXDIG[order[i]]){ d = MAXDIG[order[i]]; capped = true; }
        digits += d;
      }
      setVal("upgrades", digits); msgs.push("upgrades " + digits);
      if(capped) msgs.push("a maxed Fire shows as 9, the highest a single upgrade digit allows");
    }
    var core = (save.global && save.global.CoreEquipped) ? save.global.CoreEquipped : null;
    if(core && core.name){
      var cs = coreString(core);
      if(cs.str){ setVal("core", cs.str); msgs.push("core " + cs.str); if(cs.note) msgs.push(cs.note); }
      else { setVal("core", ""); msgs.push("equipped core has no mods the optimizer understands"); }
    } else {
      setVal("core", ""); msgs.push("no core equipped");
    }
    status.textContent = "Filled: " + msgs.join("; ") + ". Review the fields, then Find layout.";
  }
  document.addEventListener("DOMContentLoaded", function(){
    var b = document.getElementById("readSaveBtn");
    if(b) b.addEventListener("click", readSave);
  });
})();
</script></body></html>"""


def form_html(floors='20', budget='1000000000', upgrades='5555', core='', income=False, runtime=30):
    opts = ''.join(
        '<option value="%d"%s>%d seconds</option>' % (r, ' selected' if r == runtime else '', r)
        for r in RUNTIMES)
    form = FORM.format(base=BASE, floors=html.escape(floors), budget=html.escape(budget),
                       upgrades=html.escape(upgrades), core=html.escape(core),
                       income='checked' if income else '', runtime_options=opts)
    return PAGE_TOP + SAVE_SECTION + form + SCRIPT


BEST_RE = re.compile(r'New best layout found \(([^)]*)\):\s*\n\s*(\d{4}) ((?:[A-Z_]{1,5}\s*)+)')


def run_optimizer(floors, budget, upgrades, core, income, runtime):
    cmd = [SPIRE_BIN, '-f', str(floors), '-b', str(budget), '-u', upgrades, '-w', '2']
    if income:
        cmd.append('-i')
    if core:
        # -k keeps the given core mods (no -d core-budget is passed, so the optimizer treats the
        # core as owned and won't spend spirestones improving it). Don't add -d 0: it means the
        # core must cost 0 spirestones, which the optimizer rejects for any real core.
        cmd += ['-c', core, '-k']
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


def core_error(core):
    """Return the optimizer's complaint about a -c string, or None if it parses.

    Uses -g (print layout and exit) so the core is validated without a full search.
    """
    if not core:
        return None
    try:
        proc = subprocess.run([SPIRE_BIN, '-c', core, '-f', '1', '-b', '1', '-w', '1', '-g'],
                              capture_output=True, text=True, timeout=8, env={'TERM': 'dumb'})
    except (subprocess.TimeoutExpired, OSError):
        return None
    out = proc.stdout + proc.stderr
    for line in out.splitlines():
        low = line.lower()
        if any(m in low for m in CORE_ERR_MARKERS):
            return line.strip()
    return None


def layout_commands(flat):
    """Turn the flat trap string into in-game accessible-Spire commands.

    Cell i sits at column i%5+1, row i//5+1 (row 1 is the bottom floor). Same-trap cells are
    batched into one Build line; a leading Sell all clears whatever is there first.
    """
    by_trap = {}
    for i, ch in enumerate(flat):
        name = LETTER_TO_CMD.get(ch)
        if not name:
            continue
        by_trap.setdefault(name, []).append((i % 5 + 1, i // 5 + 1))
    lines = ['Sell all']
    for name in CMD_ORDER:
        cells = by_trap.get(name)
        if not cells:
            continue
        pairs = ' '.join('%d %d' % (col, row) for col, row in cells)
        lines.append('Build %s %s' % (name, pairs))
    return lines


def result_html(match, floors, note=''):
    stats, upgrades, cells = match.group(1), match.group(2), match.group(3)
    flat = re.sub(r'\s+', '', cells)
    floor_items = []
    for i in range(0, len(flat), 5):
        row = flat[i:i + 5]
        names = ', '.join(TRAP_NAMES.get(ch, ch) for ch in row)
        floor_items.append('<li>Floor %d: %s (%s)</li>' % (i // 5 + 1, names, html.escape(row)))
    layout_string = upgrades + ' ' + ' '.join(flat[i:i + 5] for i in range(0, len(flat), 5))
    commands = layout_commands(flat)
    command_items = ''.join('<li>' + html.escape(c) + '</li>' for c in commands)
    command_block = html.escape('\n'.join(commands))
    note_html = ('<p class="note" role="alert">' + html.escape(note) + '</p>') if note else ''
    return (PAGE_TOP + note_html +
            '<h2 role="status">Best layout found</h2>'
            '<p>' + html.escape(stats) + '. Upgrade levels (Fire, Frost, Poison, Lightning): ' +
            html.escape(upgrades) + '.</p>'
            '<h2>Commands to build it in the accessible Spire</h2>'
            '<p>Open your Player Spire, then type each line below into the Spire command box and press '
            'Enter, one at a time. The first line, Sell all, clears your current traps so the new '
            'layout matches exactly. Column comes before row, and row 1 is the bottom floor.</p>'
            '<ol>' + command_items + '</ol>'
            '<label>All commands, one per line, to copy<br>'
            '<textarea rows="' + str(len(commands) + 1) + '" cols="60" readonly onfocus="this.select()">' +
            command_block + '</textarea></label>'
            '<h2>Layout, floor by floor</h2>'
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
        note = ''
        if core:
            err = core_error(core)
            if err:
                note = 'Your core (%s) was not accepted by the optimizer: %s. Ran without a core.' % (core, err)
                core = ''
        match, raw = run_optimizer(floors, '%d' % budget, upgrades, core, get('income') == 'on', runtime)
        if match is None:
            self._send(200, PAGE_TOP + '<p role="alert">The optimizer produced no layout in the time given. Raw output tail:</p><pre>' + html.escape(raw or 'none') + '</pre><p><a href="' + BASE + '/">Back to the form</a></p></body></html>')
            return
        self._send(200, result_html(match, floors, note))

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
