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

// Zone-jump unlock template, derived by diffing a real zone-444 save against a fresh game.
// Each entry lists what a natural playthrough has by the given zone. Only one-shot feature
// unlocks are included: repeatable upgrades (Coordination, prestiges) would warp balance if
// copied, challenge-completion flags are earned bonuses, and per-run state doesn't belong.
// Thresholds are exact where the engine gates them (Formations 60, Dominance 70, Barrier 80)
// and approximate for the late tier (230); a jump to a high zone gets everything either way.
var ZONE_UNLOCKS = [
	{ zone: 20, globals: ['portalActive'] },
	{ zone: 60,
		upgrades: ['Battle', 'Bloodlust', 'Blockmaster', 'Trapstorm', 'Bounty', 'Anger', 'Formations', 'Miners', 'Scientists', 'Trainers', 'Explorers'],
		jobs: ['Farmer', 'Lumberjack', 'Miner', 'Scientist', 'Trainer', 'Explorer', 'Geneticist'],
		buildings: ['Trap', 'Barn', 'Shed', 'Forge', 'Hut', 'House', 'Mansion', 'Hotel', 'Resort', 'Gateway', 'Wormhole', 'Collector', 'Warpstation', 'Gym', 'Tribute', 'Nursery'],
		equipment: ['Shield', 'Dagger', 'Boots', 'Mace', 'Helmet', 'Polearm', 'Pants', 'Battleaxe', 'Shoulderguards', 'Greatsword', 'Breastplate', 'Arbalest', 'Gambeson'],
		globals: ['brokenPlanet', 'mapsUnlocked', 'trapBuildAllowed', 'autoUpgradesAvailable', 'autoUpgrades', 'autoStorageAvailable', 'autoStorage', 'Geneticistassist'] },
	{ zone: 70, upgrades: ['Dominance'] },
	{ zone: 80, upgrades: ['Barrier'] },
	{ zone: 230,
		upgrades: ['Magmamancers', 'UberHut', 'UberHouse', 'UberMansion', 'UberHotel', 'UberResort'],
		jobs: ['Magmamancer'] }
];

// Apply everything a natural run would have by targetZone. Only ever unlocks — never locks,
// never lowers done counts — so jumping below your progress is a no-op for flags.
function applyZoneJump(targetZone){
	var changed = [];
	function unlockIn(section, names){
		if (!saveObj[section]) return;
		for (var i = 0; i < names.length; i++){
			var o = saveObj[section][names[i]];
			if (o && typeof o === 'object' && o.locked){ o.locked = 0; changed.push(section + '.' + names[i]); }
		}
	}
	for (var t = 0; t < ZONE_UNLOCKS.length; t++){
		var tier = ZONE_UNLOCKS[t];
		if (targetZone < tier.zone) continue;
		if (tier.upgrades && saveObj.upgrades){
			for (var u = 0; u < tier.upgrades.length; u++){
				var up = saveObj.upgrades[tier.upgrades[u]];
				if (!up || typeof up !== 'object') continue;
				if (up.locked){ up.locked = 0; changed.push('upgrades.' + tier.upgrades[u]); }
				if (!up.done){ up.done = 1; if (changed.indexOf('upgrades.' + tier.upgrades[u]) === -1) changed.push('upgrades.' + tier.upgrades[u]); }
			}
		}
		if (tier.jobs) unlockIn('jobs', tier.jobs);
		if (tier.buildings) unlockIn('buildings', tier.buildings);
		if (tier.equipment) unlockIn('equipment', tier.equipment);
		if (tier.globals && saveObj.global){
			for (var g = 0; g < tier.globals.length; g++){
				if (saveObj.global[tier.globals[g]] !== true){ saveObj.global[tier.globals[g]] = true; changed.push('global.' + tier.globals[g]); }
			}
		}
	}
	saveObj.global.world = targetZone;
	saveObj.global.lastClearedCell = -1; // zone start, matching the engine's nextWorld reset
	if (typeof saveObj.global.highestLevelCleared === 'number' && saveObj.global.highestLevelCleared < targetZone - 1)
		saveObj.global.highestLevelCleared = targetZone - 1;
	return changed;
}

function onZoneJump(){
	if (!saveObj){ setStatus('Decode a save first.'); return; }
	var z = Number(document.getElementById('jumpZoneInput').value);
	if (!isNonNegInt(z) || z < 1){ setStatus('Jump zone must be a whole number of 1 or more.'); return; }
	var changed = applyZoneJump(z);
	flatten(saveObj);
	runSearch();
	invalidateOutputs();
	setStatus('Jumped to zone ' + z + '. Set world, cell, and zone record, and applied ' + changed.length +
		' unlock' + (changed.length === 1 ? '' : 's') + ' a natural run would have by now' +
		(changed.length ? ' (portal, features, jobs, buildings, equipment as applicable)' : '') +
		'. The current zone still uses the old enemy grid until you finish it. Repeatable upgrades like Coordination are not granted; buy them in-game with edited resources.');
}

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
	var me = path.match(/^equipment\.([^.]+)\.(level|prestige|healthCalculated|blockCalculated|attackCalculated|locked|blockNow|oc)$/);
	if (me){
		var equipName = me[1], field = me[2];
		if (field === 'level') return { kind: 'equipLevel', equip: equipName,
			hint: ' — linked: the matching army stat total auto-adjusts' };
		if (field === 'prestige') return { kind: 'equipPrestige', equip: equipName,
			hint: ' — safe alone: the game recomputes stats and cost from this on load' };
		if (field === 'locked') return { kind: 'safe', hint: ' — 0 = owned/available, 1 = locked' };
		if (field === 'oc') return { kind: 'safe', hint: ' — base cost; prices recompute from this on load' };
		if (field === 'blockNow') return { kind: 'blockNow',
			hint: ' — Shield block-vs-health routing; tied to the Blockmaster upgrade' };
		return { kind: 'derived',
			hint: ' — recomputed from prestige on load; the saved value is used to rebalance your stats, so edit level or prestige instead' };
	}
	if (/^jobs\.[^.]+\.modifier$/.test(path))
		return { kind: 'derived', hint: ' — derived from job level; edits won’t stick' };
	if (path === 'global.world') return { kind: 'zone', hint: ' — current zone; to raise your RECORD, edit global.highestLevelCleared' };
	if (/^jobs\.[^.]+\.owned$/.test(path)) return { kind: 'jobOwned' };
	if (path === 'resources.trimps.owned' || path === 'resources.trimps.soldiers') return { kind: 'popCheck' };
	if (path === 'resources.helium.owned') return { kind: 'curPool', cur: 'helium',
		hint: ' — spendable at your NEXT portal; for helium to spend at View Perks right now, edit global.heliumLeftover. Lifetime total auto-syncs' };
	if (path === 'global.heliumLeftover') return { kind: 'curPool', cur: 'helium',
		hint: ' — helium spendable at View Perks right now. Lifetime total auto-syncs' };
	if (path === 'global.totalHeliumEarned') return { kind: 'curTotal', cur: 'helium',
		hint: ' — lifetime total; editing it moves the difference into your spendable helium' };
	if (path === 'resources.radon.owned') return { kind: 'curPool', cur: 'radon',
		hint: ' — spendable at your NEXT portal; for radon to spend right now, edit global.radonLeftover. Lifetime total auto-syncs' };
	if (path === 'global.radonLeftover') return { kind: 'curPool', cur: 'radon',
		hint: ' — radon spendable at View Perks right now. Lifetime total auto-syncs' };
	if (path === 'global.totalRadonEarned') return { kind: 'curTotal', cur: 'radon',
		hint: ' — lifetime total; editing it moves the difference into your spendable radon' };
	if (path === 'global.highestLevelCleared') return { kind: 'safe',
		hint: ' — your zone record; unlocks features (masteries at 180+, formations, map modifiers). Shown in-game as this plus 1' };
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
		// Non-finite numbers (1e309, Infinity) survive JSON.stringify only as null and would
		// silently corrupt the exported save, so refuse them outright.
		return (input.trim() === '' || !isFinite(n)) ? { error: true } : n;
	}
	if (input === '') return null;
	var nn = Number(input);
	return (input.trim() !== '' && isFinite(nn)) ? nn : input;
}

// Game levels and prestiges are non-negative integers; anything else desyncs cost math.
function isNonNegInt(v){ return typeof v === 'number' && isFinite(v) && v >= 0 && Math.floor(v) === v; }

// Any successful edit makes previously generated output stale. Clear the export code (it no
// longer matches the save) and remember that a shown JSON snapshot is out of date.
var jsonStale = false;
var applyJsonArmed = false;
function invalidateOutputs(){
	var out = document.getElementById('exportBox');
	if (out && out.value) out.value = '';
	var jb = document.getElementById('jsonBox');
	if (jb && jb.value) jsonStale = true;
	applyJsonArmed = false;
}

// If the auto-synced partner field is currently rendered, reflect its new value in its control.
function refreshControl(path, value){
	var ctrl = document.querySelector('[data-path="' + path + '"]');
	if (ctrl) ctrl.value = String(value);
}

// Helium and radon each form a trio bound by one identity: totalEarned = perk spending +
// leftover + owned. Load reconciles helium this way (main.js load, when the total is above 0);
// radon accumulates the same identity during play. Editing any member re-syncs the others.
var CURRENCIES = {
	helium: { name: 'helium', ownedTokens: ['resources', 'helium', 'owned'], leftoverKey: 'heliumLeftover', totalKey: 'totalHeliumEarned', spentField: 'heliumSpent', levelField: 'level', lockedField: 'locked' },
	radon:  { name: 'radon',  ownedTokens: ['resources', 'radon', 'owned'],  leftoverKey: 'radonLeftover',  totalKey: 'totalRadonEarned',  spentField: 'radSpent',   levelField: 'radLevel', lockedField: 'radLocked' }
};

function currencyParts(cur){
	// Perk-spend loop mirrors the engine's load reconciliation: skip locked, skip level <= 0.
	var spent = 0;
	if (saveObj.portal) for (var pk in saveObj.portal){
		var po = saveObj.portal[pk];
		if (!po || typeof po !== 'object' || po[cur.lockedField]) continue;
		if (typeof po[cur.levelField] === 'undefined' || po[cur.levelField] <= 0) continue;
		if (typeof po[cur.spentField] === 'number') spent += po[cur.spentField];
	}
	var leftover = (saveObj.global && typeof saveObj.global[cur.leftoverKey] === 'number') ? saveObj.global[cur.leftoverKey] : 0;
	var owned = readByTokens(cur.ownedTokens);
	if (typeof owned !== 'number') owned = 0;
	return { spent: spent, leftover: leftover, owned: owned };
}

function syncCurrencyTotal(cur){
	var p = currencyParts(cur);
	var total = p.spent + p.leftover + p.owned;
	if (!saveObj.global || !isFinite(total)) return null;
	saveObj.global[cur.totalKey] = total;
	refreshControl('global.' + cur.totalKey, total);
	return total;
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
	if (val && val.error){ setStatus('"' + d.path + '" needs a plain finite number. Not changed.'); return; }
	var oldVal = readByTokens(d.tokens);
	var shown = (d.type === 'boolean') ? val : JSON.stringify(val);
	var k = d.smart.kind;

	// Linked kinds validate BEFORE committing: an edit lands with its full engine-equivalent
	// side effects or not at all — never a half-applied pair.
	if ((k === 'perkLevel' || k === 'equipLevel' || k === 'equipPrestige') && !isNonNegInt(Number(val))){
		el.value = String(oldVal);
		setStatus(d.path + ' must be a whole number of 0 or more (game levels are integers). Not changed.');
		return;
	}

	if (k === 'perkLevel'){
		var spent = perkSpentForLevel(d.smart.perk, Number(val));
		if (!isFinite(spent)){
			el.value = String(oldVal);
			setStatus(d.path + ': that level is too high to compute a finite ' + d.smart.spentField + ', which would corrupt respec math. Not changed.');
			return;
		}
		var perkObj = saveObj.portal && saveObj.portal[d.smart.perk];
		if (!perkObj){
			el.value = String(oldVal);
			setStatus(d.path + ': could not find this perk in the save to keep ' + d.smart.spentField + ' in sync. Not changed.');
			return;
		}
		setByTokens(d.tokens, val);
		var hadKey = (typeof perkObj[d.smart.spentField] !== 'undefined');
		perkObj[d.smart.spentField] = spent;
		if (!hadKey) flatten(saveObj); // brand-new leaf: re-index so it is searchable
		refreshControl(d.smart.spentPath, spent);
		var perkCur = CURRENCIES[(d.smart.spentField === 'radSpent') ? 'radon' : 'helium'];
		var newTotal = syncCurrencyTotal(perkCur);
		invalidateOutputs();
		setStatus('Set ' + d.path + ' = ' + shown + '. Auto-updated ' + d.smart.spentField + ' to ' + spent +
			(newTotal !== null ? ' and ' + perkCur.totalKey + ' to ' + newTotal : '') + ' so respec and lifetime totals stay correct.');
		return;
	}

	if (k === 'curTotal'){
		// totalEarned = perks spent + leftover + owned. Setting the total re-distributes the
		// difference into the spendable pools: raises go to leftover (usable right now);
		// reductions drain leftover first, then owned. It can never go below perk spending.
		var curT = CURRENCIES[d.smart.cur];
		var target = Number(val);
		var partsT = currencyParts(curT);
		if (target < partsT.spent){
			el.value = String(oldVal);
			setStatus(d.path + ' cannot go below the ' + partsT.spent + ' ' + curT.name + ' already spent on perks. Lower perk levels first, or use at least ' + partsT.spent + '. Not changed.');
			return;
		}
		var newOwned = partsT.owned;
		var newLeftover = target - partsT.spent - partsT.owned;
		if (newLeftover < 0){ newOwned += newLeftover; newLeftover = 0; }
		setByTokens(d.tokens, target);
		if (saveObj.global){
			saveObj.global[curT.leftoverKey] = newLeftover;
			refreshControl('global.' + curT.leftoverKey, newLeftover);
		}
		if (saveObj.resources && saveObj.resources[curT.name]){
			setByTokens(curT.ownedTokens, newOwned);
			refreshControl(curT.ownedTokens.join('.'), newOwned);
		}
		invalidateOutputs();
		setStatus('Set ' + d.path + ' = ' + shown + '. Rebalanced to match: ' + curT.leftoverKey + ' is now ' + newLeftover + ' and owned is ' + newOwned + ', so spendable ' + curT.name + ' equals the new total minus perk spending.');
		return;
	}

	if (k === 'equipLevel'){
		// Replicate the engine's levelEquipment bookkeeping: army stat totals are running
		// accumulators, so a level change of dL must add calculated*dL to global[stat] and
		// global.difs[stat] (verified bit-identical to engine leveling).
		var eq = saveObj.equipment && saveObj.equipment[d.smart.equip];
		var stat = eq ? (eq.blockNow ? 'block' : (typeof eq.health !== 'undefined' ? 'health' : 'attack')) : null;
		var calc = eq ? eq[stat + 'Calculated'] : null;
		var okShape = eq && typeof calc === 'number' && saveObj.global && typeof saveObj.global[stat] === 'number'
			&& saveObj.global.difs && typeof saveObj.global.difs[stat] === 'number';
		if (!okShape){
			el.value = String(oldVal);
			setStatus(d.path + ': this save is missing the fields needed to adjust your total ' + (stat || 'stat') + ' the way in-game leveling would. Not changed.');
			return;
		}
		var adj = calc * (Number(val) - Number(oldVal));
		if (!isFinite(adj) || !isFinite(saveObj.global[stat] + adj)){
			el.value = String(oldVal);
			setStatus(d.path + ': that level change overflows your total ' + stat + ' beyond what the save format can hold. Not changed.');
			return;
		}
		setByTokens(d.tokens, val);
		saveObj.global[stat] += adj;
		saveObj.global.difs[stat] += adj;
		refreshControl('global.' + stat, saveObj.global[stat]);
		invalidateOutputs();
		setStatus('Set ' + d.path + ' = ' + shown + '. Auto-adjusted your total ' + stat + ' by ' + adj + ' to match, exactly as leveling in-game would.');
		return;
	}

	if (k === 'equipPrestige'){
		setByTokens(d.tokens, val);
		invalidateOutputs();
		if (Number(val) <= 1){
			setStatus('Set ' + d.path + ' = ' + shown + '. Warning: the game only recomputes equipment stats on load for prestige 2 and up, so at prestige ' + val + ' the old calculated stats remain as saved.');
		} else {
			setStatus('Set ' + d.path + ' = ' + shown + '. Nothing else to change: on load the game recomputes this equipment’s stats and cost from prestige and rebalances your totals automatically.');
		}
		return;
	}

	// Remaining kinds commit directly.
	setByTokens(d.tokens, val);
	invalidateOutputs();

	if (k === 'blockNow'){
		setStatus('Set ' + d.path + ' = ' + shown + '. Warning: Shield block-vs-health routing is tied to the Blockmaster upgrade, and the contribution of already-bought levels is NOT migrated between health and block by this edit.');
		return;
	}
	if (k === 'derived'){
		setStatus('Set ' + d.path + ' = ' + shown + '. Heads up: this value is recomputed by the game, so the edit likely will not stick.');
		return;
	}
	if (k === 'zone'){
		setStatus('Set ' + d.path + ' = ' + shown + '. Note: the current zone still uses the old saved enemy grid until you finish it; the next zone generates fresh. If this should also count as your record, edit global.highestLevelCleared.');
		return;
	}
	if (k === 'curPool'){
		var curP = CURRENCIES[d.smart.cur];
		var totalP = syncCurrencyTotal(curP);
		if (totalP !== null) setStatus('Set ' + d.path + ' = ' + shown + '. Auto-updated global.' + curP.totalKey + ' to ' + totalP + ' (perks spent + leftover + owned), keeping all ' + curP.name + ' values consistent.');
		else setStatus('Set ' + d.path + ' = ' + shown + '. Could not update ' + curP.totalKey + ' (missing or overflowing fields); check it manually.');
		return;
	}
	if (k === 'jobOwned' || k === 'popCheck'){
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
	// A debounced re-render can land while the user is focused on a result control, which
	// would drop NVDA focus to the body. Remember the focused field and restore it after.
	var active = document.activeElement;
	var focusPath = (active && box.contains(active)) ? active.getAttribute('data-path') : null;
	box.innerHTML = '';
	var frag = document.createDocumentFragment();
	var shown = Math.min(list.length, MAX_RESULTS);
	for (var i = 0; i < shown; i++) frag.appendChild(makeControl(list[i]));
	box.appendChild(frag);
	if (focusPath){
		var again = box.querySelector('[data-path="' + focusPath + '"]');
		if (again) again.focus();
		else document.getElementById('searchBox').focus();
	}
	var count = document.getElementById('resultCount');
	if (list.length === 0) count.textContent = 'No fields match.';
	else if (list.length > shown) count.textContent = 'Showing ' + shown + ' of ' + list.length + ' fields. Refine your search to narrow it.';
	else count.textContent = 'Showing ' + shown + ' field' + (shown === 1 ? '' : 's') + '.';
}

// Empty-search view: the values people edit most, when they exist in the loaded save.
var COMMON_PATHS = [
	'global.world', 'global.lastClearedCell', 'global.highestLevelCleared', 'global.totalPortals',
	'global.heliumLeftover', 'global.totalHeliumEarned', 'global.totalVoidMaps', 'global.fluffyExp',
	'global.fluffyPrestige',
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
	document.getElementById('exportBox').value = '';
	document.getElementById('jsonBox').value = '';
	jsonStale = false;
	applyJsonArmed = false;
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
	if (!out.value){ setStatus('Nothing to copy yet. Press Encode first (or re-Encode after your latest edits).'); return; }
	out.select();
	var done = function(){ setStatus('New save code copied to clipboard.'); };
	var failed = function(){ setStatus('Copy failed in this browser. The code is selected in the export box below — copy it manually with Control+C.'); };
	if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(out.value).then(done, function(){ document.execCommand('copy') ? done() : failed(); });
	else { document.execCommand('copy') ? done() : failed(); }
}

function onShowJson(){
	if (!saveObj){ setStatus('Decode a save first.'); return; }
	document.getElementById('jsonBox').value = JSON.stringify(saveObj, null, 2);
	jsonStale = false;
	applyJsonArmed = false;
	setStatus('Full JSON loaded below. Edit it, then press Apply JSON.');
}

function onApplyJson(){
	// If field edits happened after the JSON snapshot was shown, applying it would silently
	// roll them back. Require a second press so the overwrite is deliberate.
	if (jsonStale && !applyJsonArmed){
		applyJsonArmed = true;
		setStatus('Warning: you have made edits since this JSON was shown, and applying it will overwrite them. Press Apply JSON again to do that anyway, or press Show JSON to refresh the snapshot first.');
		return;
	}
	var obj;
	try { obj = JSON.parse(document.getElementById('jsonBox').value); }
	catch (e){ setStatus('That JSON is not valid, so nothing was applied: ' + e.message); return; }
	if (!obj || typeof obj !== 'object' || !obj.global){ setStatus('That JSON is not a Trimps save (no global section).'); return; }
	saveObj = obj;
	flatten(saveObj);
	buildSectionButtons();
	runSearch();
	jsonStale = false;
	applyJsonArmed = false;
	var out = document.getElementById('exportBox');
	if (out) out.value = '';
	setStatus('Save replaced from JSON. ' + leaves.length + ' editable values.');
}

window.addEventListener('DOMContentLoaded', function(){
	document.getElementById('decodeBtn').addEventListener('click', onDecode);
	document.getElementById('jumpZoneBtn').addEventListener('click', onZoneJump);
	document.getElementById('searchBox').addEventListener('input', onSearchInput);
	document.getElementById('encodeBtn').addEventListener('click', onEncode);
	document.getElementById('copyBtn').addEventListener('click', onCopy);
	document.getElementById('showJsonBtn').addEventListener('click', onShowJson);
	document.getElementById('applyJsonBtn').addEventListener('click', onApplyJson);
});
