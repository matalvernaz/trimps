'use strict';
// Trimps save editor — fully client-side. Uses the game's own lz-string.js so encode/decode
// exactly matches Trimps' Export/Import (compressToBase64 / decompressFromBase64). Nothing is
// uploaded; the whole round-trip happens in the browser.
//
// A save holds thousands of values, so the interface is search-first: type part of a field
// name or path to find it, edit it with a type-appropriate control, and the change is written
// straight into the in-memory save. Encode reads from that same object, so anything untouched
// round-trips unchanged.
//
// "Smart" handling of linked values:
//  - Perk level and its spent-helium/radon are a paired invariant. Editing a perk's level
//    auto-recomputes the matching heliumSpent/radSpent using Trimps' own cost formula
//    (verified to reproduce every perk in a real save exactly), so respec and helium totals
//    stay correct.
//  - Derived fields the game recomputes (resource max, equipment *Calculated, job modifier)
//    are flagged so you don't waste time editing values that won't stick.
//  - Structural hazards with no safe auto-fix (zone vs the saved enemy grid, jobs vs
//    population) are flagged with a warning when you edit them.

var MAX_RESULTS = 300; // cap rendered fields per search to keep the DOM responsive

// Portal perk cost parameters, extracted from the game's config.js. Drives the level->spent
// recompute. priceBase/additive/additiveInc/growth match Trimps' getPerkBuyCount math.
var PERK_PARAMS = {"Looting_II":{"priceBase":100000,"additive":true,"additiveInc":10000,"growth":1.3},"Carpentry_II":{"priceBase":100000,"additive":true,"additiveInc":10000,"growth":1.3},"Motivation_II":{"priceBase":50000,"additive":true,"additiveInc":1000,"growth":1.3},"Power_II":{"priceBase":20000,"additive":true,"additiveInc":500,"growth":1.3},"Toughness_II":{"priceBase":20000,"additive":true,"additiveInc":500,"growth":1.3},"Capable":{"priceBase":100000000,"additive":false,"additiveInc":0,"growth":10},"Cunning":{"priceBase":100000000000,"additive":false,"additiveInc":0,"growth":1.3},"Curious":{"priceBase":100000000000000,"additive":false,"additiveInc":0,"growth":1.3},"Classy":{"priceBase":100000000000000000,"additive":false,"additiveInc":0,"growth":1.3},"Overkill":{"priceBase":1000000,"additive":false,"additiveInc":0,"growth":1.3},"Resourceful":{"priceBase":50000,"additive":false,"additiveInc":0,"growth":1.3},"Coordinated":{"priceBase":150000,"additive":false,"additiveInc":0,"growth":1.3},"Siphonology":{"priceBase":100000,"additive":false,"additiveInc":0,"growth":1.3},"Anticipation":{"priceBase":1000,"additive":false,"additiveInc":0,"growth":1.3},"Resilience":{"priceBase":100,"additive":false,"additiveInc":0,"growth":1.3},"Meditation":{"priceBase":75,"additive":false,"additiveInc":0,"growth":1.3},"Relentlessness":{"priceBase":75,"additive":false,"additiveInc":0,"growth":1.3},"Masterfulness":{"priceBase":1e+23,"additive":false,"additiveInc":0,"growth":50},"Greed":{"priceBase":10000000000,"additive":false,"additiveInc":0,"growth":1.3},"Tenacity":{"priceBase":50000000,"additive":false,"additiveInc":0,"growth":1.3},"Criticality":{"priceBase":100,"additive":false,"additiveInc":0,"growth":1.3},"Equality":{"priceBase":1,"additive":false,"additiveInc":0,"growth":1.5},"Carpentry":{"priceBase":25,"additive":false,"additiveInc":0,"growth":1.3},"Artisanistry":{"priceBase":15,"additive":false,"additiveInc":0,"growth":1.3},"Range":{"priceBase":1,"additive":false,"additiveInc":0,"growth":1.3},"Agility":{"priceBase":4,"additive":false,"additiveInc":0,"growth":1.3},"Bait":{"priceBase":4,"additive":false,"additiveInc":0,"growth":1.3},"Trumps":{"priceBase":3,"additive":false,"additiveInc":0,"growth":1.3},"Pheromones":{"priceBase":3,"additive":false,"additiveInc":0,"growth":1.3},"Packrat":{"priceBase":3,"additive":false,"additiveInc":0,"growth":1.3},"Motivation":{"priceBase":2,"additive":false,"additiveInc":0,"growth":1.3},"Power":{"priceBase":1,"additive":false,"additiveInc":0,"growth":1.3},"Toughness":{"priceBase":1,"additive":false,"additiveInc":0,"growth":1.3},"Looting":{"priceBase":1,"additive":false,"additiveInc":0,"growth":1.3},"Prismal":{"priceBase":1,"additive":false,"additiveInc":0,"growth":1.3},"Hunger":{"priceBase":1000000,"additive":false,"additiveInc":0,"growth":1.3},"Championism":{"priceBase":1000000000,"additive":false,"additiveInc":0,"growth":5},"Frenzy":{"priceBase":1000000000000000,"additive":false,"additiveInc":0,"growth":1.3},"Observation":{"priceBase":5000000000000000000,"additive":false,"additiveInc":0,"growth":2},"Smithology":{"priceBase":1e+23,"additive":false,"additiveInc":0,"growth":4},"Expansion":{"priceBase":1e+23,"additive":false,"additiveInc":0,"growth":3}};

// Total spent to reach level N from 0, matching Trimps' own cost math. Additive perks have a
// closed form; growth perks sum per level (cost explodes exponentially, so the loop is short).
function perkSpentForLevel(name, N){
	var p = PERK_PARAMS[name];
	if (!p || N <= 0) return 0;
	if (p.additive) return N * p.priceBase + p.additiveInc * N * (N - 1) / 2;
	var s = 0;
	for (var k = 0; k < N && k < 1000000; k++){
		s += Math.ceil(k / 2 + p.priceBase * Math.pow(p.growth, k));
		if (!isFinite(s)) return Infinity;
	}
	return s;
}

var saveObj = null;      // canonical decoded save; controls read from and write to this
var leaves = [];         // [{path, tokens, type, smart}] one per editable scalar/null value
var leafByPath = {};     // path -> descriptor

function setStatus(msg){ var el = document.getElementById('status'); if (el) el.textContent = msg; }

function decodeSave(code){
	var clean = code.replace(/(\r\n|\n|\r|\s)/gm, '');
	if (!clean) return null;
	var json = LZString.decompressFromBase64(clean);
	if (!json) return null;
	try { return JSON.parse(json); } catch (e){ return null; }
}

function leafType(v){
	if (v === null) return 'null';
	var t = typeof v;
	return (t === 'number' || t === 'string' || t === 'boolean') ? t : null;
}

// Classify a field so the UI can hint at it and onFieldChange can handle linked/derived cases.
function classify(path){
	var m = path.match(/^portal\.([^.]+)\.(level|radLevel)$/);
	if (m && PERK_PARAMS[m[1]]){
		var spentField = (m[2] === 'level') ? 'heliumSpent' : 'radSpent';
		return { kind: 'perkLevel', perk: m[1], spentField: spentField, spentPath: 'portal.' + m[1] + '.' + spentField,
			hint: ' — linked: ' + spentField + ' auto-updates' };
	}
	var ms = path.match(/^portal\.([^.]+)\.(heliumSpent|radSpent)$/);
	if (ms && PERK_PARAMS[ms[1]]) return { kind: 'perkSpent', hint: ' — normally set automatically by editing this perk’s level' };
	if (/^resources\.[^.]+\.max$/.test(path) || path === 'resources.trimps.maxSoldiers')
		return { kind: 'derived', hint: ' — derived; the game recomputes this, so edits won’t stick' };
	if (/^equipment\.[^.]+\.(healthCalculated|blockCalculated|attackCalculated)$/.test(path))
		return { kind: 'derived', hint: ' — derived from level/prestige; edit those instead' };
	if (/^jobs\.[^.]+\.modifier$/.test(path))
		return { kind: 'derived', hint: ' — derived from job level; edits won’t stick' };
	if (path === 'global.world') return { kind: 'zone', hint: ' — changing zone alone leaves a stale enemy grid' };
	if (/^jobs\.[^.]+\.owned$/.test(path)) return { kind: 'jobOwned' };
	return { kind: 'safe' };
}

function flatten(obj){
	leaves = [];
	leafByPath = {};
	(function walk(node, path, tokens){
		var t = leafType(node);
		if (t){
			var d = { path: path, tokens: tokens, type: t, smart: classify(path) };
			leaves.push(d);
			leafByPath[path] = d;
			return;
		}
		if (Array.isArray(node)){
			for (var i = 0; i < node.length; i++) walk(node[i], path + '[' + i + ']', tokens.concat(i));
		} else if (node && typeof node === 'object'){
			var keys = Object.keys(node);
			for (var k = 0; k < keys.length; k++) walk(node[keys[k]], path ? path + '.' + keys[k] : keys[k], tokens.concat(keys[k]));
		}
	})(obj, '', []);
}

function readByTokens(tokens){ return tokens.reduce(function(acc, tk){ return acc == null ? acc : acc[tk]; }, saveObj); }
function setByTokens(tokens, value){
	var cur = saveObj;
	for (var i = 0; i < tokens.length - 1; i++) cur = cur[tokens[i]];
	cur[tokens[tokens.length - 1]] = value;
}

function coerce(descriptor, input, checked){
	if (descriptor.type === 'boolean') return checked;
	if (descriptor.type === 'string') return input;
	if (descriptor.type === 'number'){
		var n = Number(input);
		return (input.trim() === '' || isNaN(n)) ? { error: true } : n;
	}
	if (input === '') return null;
	var nn = Number(input);
	return (input.trim() !== '' && !isNaN(nn)) ? nn : input;
}

// If the auto-synced partner field is currently rendered, reflect its new value in its control.
function refreshControl(path, value){
	var ctrl = document.querySelector('[data-path="' + path + '"]');
	if (ctrl) ctrl.value = String(value);
}

// Sum of employed Trimps across jobs, for the population sanity check.
function jobsPlusSoldiers(){
	var sum = 0;
	if (saveObj.jobs) for (var j in saveObj.jobs){ var jo = saveObj.jobs[j]; if (jo && typeof jo.owned === 'number') sum += jo.owned; }
	var sol = (saveObj.resources && saveObj.resources.trimps && typeof saveObj.resources.trimps.soldiers === 'number') ? saveObj.resources.trimps.soldiers : 0;
	return sum + sol;
}

function onFieldChange(e){
	var el = e.target;
	var d = leafByPath[el.getAttribute('data-path')];
	if (!d) return;
	var val = coerce(d, el.value, el.checked);
	if (val && val.error){ setStatus('"' + d.path + '" needs a number. Not changed.'); return; }
	setByTokens(d.tokens, val);
	var shown = (d.type === 'boolean') ? val : JSON.stringify(val);

	if (d.smart.kind === 'perkLevel'){
		var spent = perkSpentForLevel(d.smart.perk, Number(val));
		if (!isFinite(spent)){
			setStatus('Set ' + d.path + ' = ' + shown + '. WARNING: that level is too high to compute a finite ' + d.smart.spentField + '; it was left unchanged, so respec math may be off.');
			return;
		}
		var sp = leafByPath[d.smart.spentPath];
		if (sp){ setByTokens(sp.tokens, spent); refreshControl(d.smart.spentPath, spent); }
		setStatus('Set ' + d.path + ' = ' + shown + '. Auto-updated ' + d.smart.spentField + ' to ' + spent + ' so respec and helium totals stay correct.');
		return;
	}
	if (d.smart.kind === 'derived'){
		setStatus('Set ' + d.path + ' = ' + shown + '. Heads up: this value is recomputed by the game, so the edit likely will not stick.');
		return;
	}
	if (d.smart.kind === 'zone'){
		setStatus('Set ' + d.path + ' = ' + shown + '. Warning: the saved enemy grid is for your old zone. Jumping zones this way can desync the grid; advancing in-game is safer.');
		return;
	}
	if (d.smart.kind === 'jobOwned'){
		var pop = jobsPlusSoldiers();
		var owned = readByTokens(['resources', 'trimps', 'owned']);
		if (typeof owned === 'number' && pop > owned){
			setStatus('Set ' + d.path + ' = ' + shown + '. Warning: employed Trimps plus soldiers (' + pop + ') now exceed resources.trimps.owned (' + owned + '); raise trimps.owned or the game may correct it.');
			return;
		}
	}
	setStatus('Set ' + d.path + ' = ' + shown);
}

function makeControl(d){
	var current = readByTokens(d.tokens);
	var wrap = document.createElement('div');
	wrap.className = 'field';
	var id = 'f_' + d.path.replace(/[^a-zA-Z0-9]/g, '_');
	var hint = d.smart.hint || '';
	if (d.type === 'boolean'){
		var cb = document.createElement('input');
		cb.type = 'checkbox'; cb.id = id; cb.checked = !!current;
		cb.setAttribute('data-path', d.path);
		cb.addEventListener('change', onFieldChange);
		var labCb = document.createElement('label');
		labCb.setAttribute('for', id); labCb.textContent = ' ' + d.path + hint;
		wrap.appendChild(cb); wrap.appendChild(labCb);
	} else {
		var lab = document.createElement('label');
		lab.setAttribute('for', id);
		lab.textContent = d.path + (d.type === 'null' ? ' (currently empty)' : '') + hint;
		var input = document.createElement('input');
		input.type = 'text'; input.id = id;
		input.value = (current === null || current === undefined) ? '' : String(current);
		input.setAttribute('data-path', d.path);
		input.setAttribute('spellcheck', 'false');
		input.setAttribute('autocomplete', 'off');
		if (d.type === 'number') input.setAttribute('inputmode', 'decimal');
		input.addEventListener('change', onFieldChange);
		wrap.appendChild(lab); wrap.appendChild(document.createElement('br')); wrap.appendChild(input);
	}
	return wrap;
}

function renderFields(list){
	var box = document.getElementById('fieldList');
	box.innerHTML = '';
	var frag = document.createDocumentFragment();
	var shown = Math.min(list.length, MAX_RESULTS);
	for (var i = 0; i < shown; i++) frag.appendChild(makeControl(list[i]));
	box.appendChild(frag);
	var count = document.getElementById('resultCount');
	if (list.length === 0) count.textContent = 'No fields match.';
	else if (list.length > shown) count.textContent = 'Showing ' + shown + ' of ' + list.length + ' fields. Refine your search to narrow it.';
	else count.textContent = 'Showing ' + shown + ' field' + (shown === 1 ? '' : 's') + '.';
}

// Empty-search view: the values people edit most, when they exist in the loaded save.
var COMMON_PATHS = [
	'global.world', 'global.lastClearedCell', 'global.highestLevelCleared', 'global.totalPortals',
	'global.voidMaps', 'global.spentHelium', 'global.fluffyExp', 'global.fluffyPrestige', 'global.bones',
	'resources.food.owned', 'resources.wood.owned', 'resources.metal.owned', 'resources.science.owned',
	'resources.gems.owned', 'resources.fragments.owned', 'resources.helium.owned', 'resources.radon.owned',
	'resources.trimps.owned', 'resources.trimps.soldiers'
];
function commonList(){ return COMMON_PATHS.map(function(p){ return leafByPath[p]; }).filter(Boolean); }

function runSearch(){
	if (!saveObj) return;
	var q = document.getElementById('searchBox').value.trim().toLowerCase();
	if (q === ''){ renderFields(commonList()); return; }
	renderFields(leaves.filter(function(d){ return d.path.toLowerCase().indexOf(q) !== -1; }));
}

var searchTimer = null;
function onSearchInput(){ if (searchTimer) clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 150); }

function buildSectionButtons(){
	var box = document.getElementById('sectionButtons');
	box.innerHTML = '';
	Object.keys(saveObj).forEach(function(key){
		var b = document.createElement('button');
		b.type = 'button'; b.textContent = key;
		b.addEventListener('click', function(){ document.getElementById('searchBox').value = key + '.'; runSearch(); });
		box.appendChild(b); box.appendChild(document.createTextNode(' '));
	});
}

function onDecode(){
	var obj = decodeSave(document.getElementById('importBox').value);
	if (!obj || typeof obj !== 'object' || !obj.global){
		setStatus('Could not read that save. Make sure you pasted a complete Trimps export code.');
		return;
	}
	saveObj = obj;
	flatten(saveObj);
	buildSectionButtons();
	document.getElementById('editorSections').hidden = false;
	document.getElementById('searchBox').value = '';
	renderFields(commonList());
	setStatus('Save decoded. Zone ' + (obj.global.world != null ? obj.global.world : '?') + ', version ' + (obj.global.stringVersion || '?') + '. ' + leaves.length + ' editable values. Search to find any of them.');
	var h = document.getElementById('editHeading');
	if (h) h.focus();
}

function onEncode(){
	if (!saveObj){ setStatus('Decode a save first.'); return; }
	document.getElementById('exportBox').value = LZString.compressToBase64(JSON.stringify(saveObj));
	setStatus('Encoded. Copy the new save code and import it into Trimps (Settings, then Import).');
}

function onCopy(){
	var out = document.getElementById('exportBox');
	if (!out.value){ setStatus('Nothing to copy yet. Press Encode first.'); return; }
	out.select();
	var done = function(){ setStatus('New save code copied to clipboard.'); };
	if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(out.value).then(done, function(){ document.execCommand('copy'); done(); });
	else { document.execCommand('copy'); done(); }
}

function onShowJson(){
	if (!saveObj){ setStatus('Decode a save first.'); return; }
	document.getElementById('jsonBox').value = JSON.stringify(saveObj, null, 2);
	setStatus('Full JSON loaded below. Edit it, then press Apply JSON.');
}

function onApplyJson(){
	var obj;
	try { obj = JSON.parse(document.getElementById('jsonBox').value); }
	catch (e){ setStatus('That JSON is not valid, so nothing was applied: ' + e.message); return; }
	if (!obj || typeof obj !== 'object' || !obj.global){ setStatus('That JSON is not a Trimps save (no global section).'); return; }
	saveObj = obj;
	flatten(saveObj);
	buildSectionButtons();
	runSearch();
	setStatus('Save replaced from JSON. ' + leaves.length + ' editable values.');
}

window.addEventListener('DOMContentLoaded', function(){
	document.getElementById('decodeBtn').addEventListener('click', onDecode);
	document.getElementById('searchBox').addEventListener('input', onSearchInput);
	document.getElementById('encodeBtn').addEventListener('click', onEncode);
	document.getElementById('copyBtn').addEventListener('click', onCopy);
	document.getElementById('showJsonBtn').addEventListener('click', onShowJson);
	document.getElementById('applyJsonBtn').addEventListener('click', onApplyJson);
});
