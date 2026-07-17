'use strict';
// Trimps save editor — fully client-side. Uses the game's own lz-string.js, so encode/decode
// exactly matches Trimps' Export/Import (compressToBase64 / decompressFromBase64). Nothing is
// uploaded anywhere; the whole round-trip happens in the browser.

// Numeric game.global fields worth a dedicated labeled control. Everything else is edited via
// the raw JSON box. Zone jumps (world) usually also need lastClearedCell to stay consistent.
var QUICK_GLOBALS = [
	['world', 'Zone (world)'],
	['lastClearedCell', 'Last cleared cell in zone']
];

function setStatus(msg){
	var el = document.getElementById('status');
	if (el) el.textContent = msg;
}

// Strip whitespace and decompress an exported Trimps save into an object; null on any failure.
function decodeSave(code){
	var clean = code.replace(/(\r\n|\n|\r|\s)/gm, '');
	if (!clean) return null;
	var json = LZString.decompressFromBase64(clean);
	if (!json) return null;
	try { return JSON.parse(json); }
	catch (e){ return null; }
}

// Write value at a dot path (e.g. "resources.food.owned"). Returns false if the parent is missing.
function setByPath(obj, path, value){
	var parts = path.split('.'), cur = obj;
	for (var i = 0; i < parts.length - 1; i++){
		if (cur == null || typeof cur[parts[i]] !== 'object') return false;
		cur = cur[parts[i]];
	}
	cur[parts[parts.length - 1]] = value;
	return true;
}

// One labeled text input for a numeric field. Text (not number) because Trimps values can be
// very large or in scientific notation, which number inputs mangle.
function makeQuickField(path, label, value){
	var wrap = document.createElement('div');
	wrap.className = 'quickField';
	var id = 'qf_' + path.replace(/[^a-zA-Z0-9]/g, '_');
	var lab = document.createElement('label');
	lab.setAttribute('for', id);
	lab.textContent = label;
	var input = document.createElement('input');
	input.type = 'text';
	input.id = id;
	input.value = String(value);
	input.setAttribute('data-path', path);
	input.setAttribute('inputmode', 'decimal');
	input.setAttribute('spellcheck', 'false');
	input.setAttribute('autocomplete', 'off');
	wrap.appendChild(lab);
	wrap.appendChild(document.createElement('br'));
	wrap.appendChild(input);
	return wrap;
}

// Populate the Quick Edits section from a decoded save. Returns the number of fields generated.
function renderQuickFields(obj){
	var container = document.getElementById('quickFields');
	container.innerHTML = '';
	var count = 0;
	if (obj.global){
		QUICK_GLOBALS.forEach(function(pair){
			if (typeof obj.global[pair[0]] === 'number'){
				container.appendChild(makeQuickField('global.' + pair[0], pair[1], obj.global[pair[0]]));
				count++;
			}
		});
	}
	if (obj.resources){
		Object.keys(obj.resources).forEach(function(name){
			var res = obj.resources[name];
			if (res && typeof res.owned === 'number'){
				container.appendChild(makeQuickField('resources.' + name + '.owned', name + ' owned', res.owned));
				count++;
			}
		});
	}
	if (!count) container.textContent = 'No auto-detected numeric fields. Use the Full Save Data box below.';
	return count;
}

function prettyJson(obj){ return JSON.stringify(obj, null, 2); }

function onDecode(){
	var obj = decodeSave(document.getElementById('importBox').value);
	if (!obj || typeof obj !== 'object' || !obj.global){
		setStatus('Could not read that save. Make sure you pasted a complete Trimps export code.');
		return;
	}
	var n = renderQuickFields(obj);
	document.getElementById('jsonBox').value = prettyJson(obj);
	document.getElementById('editorSections').hidden = false;
	setStatus('Save decoded. Zone ' + (obj.global.world != null ? obj.global.world : '?') + '. ' + n + ' quick fields available. Edit, then Encode.');
	var h = document.getElementById('quickHeading');
	if (h) h.focus();
}

// Write the quick-field values into the JSON box. The JSON box is the single source of truth for
// Encode, so quick edits are applied on top of the box's current (possibly hand-edited) contents.
function onApplyQuick(){
	var jsonBox = document.getElementById('jsonBox');
	var obj;
	try { obj = JSON.parse(jsonBox.value); }
	catch (e){ setStatus('Full Save Data is not valid JSON, so quick edits were not applied: ' + e.message); return; }
	var inputs = document.querySelectorAll('#quickFields input[data-path]');
	var applied = 0;
	for (var i = 0; i < inputs.length; i++){
		var raw = inputs[i].value.trim();
		var num = Number(raw);
		if (raw === '' || isNaN(num)) continue;
		if (setByPath(obj, inputs[i].getAttribute('data-path'), num)) applied++;
	}
	jsonBox.value = prettyJson(obj);
	setStatus(applied + ' quick edit(s) written into the save data. Now press Encode.');
}

function onEncode(){
	var obj;
	try { obj = JSON.parse(document.getElementById('jsonBox').value); }
	catch (e){ setStatus('Cannot encode: Full Save Data is not valid JSON: ' + e.message); return; }
	document.getElementById('exportBox').value = LZString.compressToBase64(JSON.stringify(obj));
	setStatus('Encoded. Copy the new save code and import it into Trimps (Settings, then Import).');
}

function onCopy(){
	var out = document.getElementById('exportBox');
	if (!out.value){ setStatus('Nothing to copy yet. Press Encode first.'); return; }
	out.select();
	var done = function(){ setStatus('New save code copied to clipboard.'); };
	if (navigator.clipboard && navigator.clipboard.writeText){
		navigator.clipboard.writeText(out.value).then(done, function(){ document.execCommand('copy'); done(); });
	} else {
		document.execCommand('copy'); done();
	}
}

window.addEventListener('DOMContentLoaded', function(){
	document.getElementById('decodeBtn').addEventListener('click', onDecode);
	document.getElementById('applyBtn').addEventListener('click', onApplyQuick);
	document.getElementById('encodeBtn').addEventListener('click', onEncode);
	document.getElementById('copyBtn').addEventListener('click', onCopy);
});
