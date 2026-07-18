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

// Zone-jump unlock data comes from two sources.
//
// game.worldUnlocks (the game's config.js, loaded by save-editor.html) is the engine's own
// drop table for world-grid books: one-shot feature books (Miners, Dominance, ...) and
// repeatable books on a zone cadence (TrainTacular every 5th zone, Coordination every zone,
// Gigastation in banded tiers, ...). applyWorldUnlockDrops mirrors the engine's scheduling
// rules (main.js addSpecials) against that table, so game updates are picked up without
// editing this file. One-shot books are marked owned (done=1) along with the job/building
// their purchase would have unlocked; repeatable books only raise `allowed` — how many the
// game lets you buy — because buying runs fire() side effects (TrainTacular bumps the
// Trainer modifier, Coordination scales the army) that a save edit can't replicate. Without
// the allowed bump those books are permanently missable: the engine only drops them on
// their exact zones and buyUpgrade re-locks at done >= allowed.
//
// ZONE_UNLOCKS below hand-covers only what lives outside that table: tutorial and engine-
// hardcoded flags, early world-grid equipment (those specials carry no fire() to parse),
// map-found books and buildings (kept lumped at the old zone-60 tier — map books re-drop at
// any map level, so they're recoverable in-game below that), and the zone-230 magma set.
// Repeatable purchases (done counts) are never copied, challenge-completion flags are
// earned bonuses, and per-run state doesn't belong.
var ZONE_UNLOCKS = [
	{ zone: 6,
		upgrades: ['Battle'],
		jobs: ['Farmer', 'Lumberjack'],
		buildings: ['Trap'],
		equipment: ['Shield', 'Dagger', 'Boots', 'Mace', 'Helmet', 'Polearm', 'Pants', 'Battleaxe', 'Shoulderguards', 'Greatsword', 'Breastplate'],
		globals: ['trapBuildAllowed'] },
	{ zone: 7, globals: ['mapsUnlocked'] },
	{ zone: 16, upgrades: ['Trapstorm', 'Bounty'] },
	{ zone: 20, globals: ['portalActive'] },
	{ zone: 60,
		upgrades: ['Formations'],
		buildings: ['Barn', 'Shed', 'Forge', 'Hut', 'House', 'Mansion', 'Hotel', 'Resort', 'Gateway', 'Wormhole', 'Collector', 'Nursery'],
		equipment: ['Arbalest', 'Gambeson'],
		globals: ['brokenPlanet', 'autoUpgradesAvailable', 'autoUpgrades', 'autoStorageAvailable', 'autoStorage', 'Geneticistassist'] },
	{ zone: 230, upgrades: ['UberHut', 'UberHouse', 'UberMansion', 'UberHotel', 'UberResort'] }
];

// The unlockUpgrade("X") / unlockJob("X") / unlockBuilding("X") call inside a fire() body —
// how a worldUnlocks book names what it grants.
var UNLOCK_CALL = /unlock(Upgrade|Job|Building)\(\s*["']([^"']+)/;

function unlockOne(section, name, changed){
	var o = saveObj[section] && saveObj[section][name];
	if (o && typeof o === 'object' && o.locked){ o.locked = 0; changed.push(section + '.' + name); }
}

// The planet breaks on killing zone 59's final Improbability (config.js world:59 last:true
// -> planetBreaker), and only in Universe 1 — U2 never breaks. Specials with
// brokenPlanet: -1 drop only on the unbroken planet (U1 zones 1-59, every U2 zone);
// brokenPlanet: 1 only on the broken one (U1 zones 60+, never in U2). This is what retires
// Speedminer/lumber/farming/science at z60 in favour of the Mega* books.
var BREAK_ZONE = 60;

// How many books of this special a full clear of zones 1..targetZone-1 collects (the jump
// lands at the target zone's start, so its own cells are uncleared). Cadence mirrors main.js
// addSpecials: positive world = that exact zone; negative = repeating (-1 every zone, -2
// even, -3 odd, -5/-33/-10/-20/-25 every 5th/3rd/10th/20th/25th), bounded by startAt/lastAt,
// the universe block flags, and the brokenPlanet window above.
function naturalDropCount(special, targetZone, universe){
	if (universe === 2 && special.blockU2) return 0;
	if (universe !== 2 && special.blockU1) return 0;
	var first = (typeof special.startAt === 'number') ? special.startAt : 1;
	var last = targetZone - 1;
	if (typeof special.lastAt === 'number' && special.lastAt < last) last = special.lastAt;
	if (special.brokenPlanet === 1){
		if (universe === 2) return 0;
		if (first < BREAK_ZONE) first = BREAK_ZONE;
	}
	if (special.brokenPlanet === -1 && universe !== 2 && last > BREAK_ZONE - 1) last = BREAK_ZONE - 1;
	if (last < first) return 0;
	function multiplesOf(m){ return Math.floor(last / m) - Math.floor((first - 1) / m); }
	var w = special.world, count = 0;
	if (w > 0) count = (w >= first && w <= last) ? 1 : 0;
	else if (w === -1) count = last - first + 1;
	else if (w === -2) count = multiplesOf(2);
	else if (w === -3) count = (last - first + 1) - multiplesOf(2);
	else if (w === -5) count = multiplesOf(5);
	else if (w === -33) count = multiplesOf(3);
	else if (w === -10) count = multiplesOf(10);
	else if (w === -20) count = multiplesOf(20);
	else if (w === -25) count = multiplesOf(25);
	if (special.canRunOnce && count > 1) count = 1;
	return count;
}

// Grant everything game.worldUnlocks would have dropped by targetZone. Returns false when
// config.js isn't loaded (editor opened away from the game folder) so the caller can warn.
function applyWorldUnlockDrops(targetZone, changed){
	if (typeof game === 'undefined' || !game.worldUnlocks) return false;
	var universe = (saveObj.global && saveObj.global.universe === 2) ? 2 : 1;
	// The natural ceiling caps `allowed` at what the save's farthest-reached zone could have
	// dropped. The engine never hands out more books than the schedule allows, so a count
	// above the ceiling can only be editor damage (an earlier version over-granted the
	// brokenPlanet-gated books) — clamp it back down, but never below purchases.
	var hlc = (saveObj.global && typeof saveObj.global.highestLevelCleared === 'number') ? saveObj.global.highestLevelCleared : 0;
	var farthestZone = Math.max(targetZone, hlc + 1);
	var drops = {}; // upgrade -> {count, ceiling, repeatable}; summed across specials (Gigastation has 5 tiers)
	for (var item in game.worldUnlocks){
		try {
			var sp = game.worldUnlocks[item];
			if (item === 'Foreman'){
				// No unlock call — each Foreman book does game.global.autoCraftModifier += 0.25.
				var mod = naturalDropCount(sp, targetZone, universe) * 0.25;
				if (saveObj.global && (saveObj.global.autoCraftModifier || 0) < mod){
					saveObj.global.autoCraftModifier = mod;
					changed.push('global.autoCraftModifier');
				}
				continue;
			}
			var m = String(sp.fire || '').match(UNLOCK_CALL);
			if (!m) continue; // loot drops, unique-map openers, the easter egg
			if (sp.locked) continue;
			var n = naturalDropCount(sp, targetZone, universe);
			var ceil = naturalDropCount(sp, farthestZone, universe);
			if (m[1] === 'Upgrade'){
				// Register even at 0/0: the clamp below then repairs upgrades this universe
				// could never have dropped (e.g. broken-planet books in U2).
				var d = drops[m[2]] || (drops[m[2]] = { count: 0, ceiling: 0, repeatable: false });
				d.count += n;
				d.ceiling += ceil;
				if (sp.world < 0 && !sp.canRunOnce) d.repeatable = true;
			}
			else if (n) unlockOne(m[1] === 'Job' ? 'jobs' : 'buildings', m[2], changed);
		} catch (e){} // holiday entries gate `locked` behind getters that need main.js; skip them
	}
	for (var name in drops){
		var up = saveObj.upgrades && saveObj.upgrades[name];
		if (!up || typeof up !== 'object') continue;
		var touched = false;
		var d = drops[name];
		var allowedTarget = Math.max(d.count, Math.min(up.allowed || 0, d.ceiling), up.done || 0);
		if (d.count > 0 && up.locked){ up.locked = 0; touched = true; }
		else if (d.ceiling === 0 && !up.done && up.locked === 0){
			// Unlocked with a zero natural ceiling and nothing bought: no book could ever
			// have dropped here, so this is earlier editor damage — relock it.
			up.locked = 1;
			touched = true;
		}
		if ((up.allowed || 0) !== allowedTarget){ up.allowed = allowedTarget; touched = true; }
		if (!drops[name].repeatable && !up.done && d.count > 0){
			up.done = 1;
			touched = true;
			// A real purchase runs the upgrade's own fire(); grant the job/building it unlocks.
			var src = game.upgrades[name] ? String(game.upgrades[name].fire || '') : '';
			var chainRe = /unlock(Job|Building)\(\s*["']([^"']+)/g, cm;
			while ((cm = chainRe.exec(src))) unlockOne(cm[1] === 'Job' ? 'jobs' : 'buildings', cm[2], changed);
		}
		if (touched) changed.push('upgrades.' + name);
	}
	return true;
}

// Challenge completion anchors. Zone-anchored challenges declare completeAfterZone in
// game.challenges (engine fires entering zone+1); map-anchored ones declare
// completeAfterMap, resolved via the unique maps' zones: Dimension of Anger 20, Trimple of
// Doom 33, The Prison 80, Imploding Star 170 (U1); Dimension of Rage 15 (Unlucky's own
// text), Prismatic Palace 20 and Melting Point 50 (their worldUnlocks entries) (U2).
var CHALLENGE_MAP_ZONES = {
	'Dimension of Anger': 20, 'Trimple of Doom': 33, 'The Prison': 80, 'Imploding Star': 170,
	'Dimension of Rage': 15, 'Prismatic Palace': 20, 'Melting Point': 50
};
// Legacy U1 challenges trigger completion in engine code rather than declared data; anchors
// per each challenge's own description text in config.js.
var CHALLENGE_LEGACY_ZONES = {
	Discipline: 20, Metal: 20, Size: 20, Coordinate: 20, // The Dimension of Anger
	Meditate: 33, Trimp: 33, Trapper: 33,                // Trimple of Doom
	Mapocalypse: 80,                                     // The Prison
	Mapology: 100,                                       // "Completing Zone 100"
	Devastation: 170                                     // Imploding Star
};

var UNLOCK_PERK_CALL = /unlockPerk\(\s*["']([^"']+)/;
var MARKS_COMPLETED = /\.completed\s*=\s*true/;

// Grant what completing each challenge would have written to the save, for every challenge
// a natural run is past by targetZone. Rewards are parsed from the challenge's own
// onComplete: the completed flag, and the perk it unlockPerk()s — mirrored exactly (U1
// flips portal.<perk>.locked, U2 flips radLocked, each only when the field exists). Perks
// are unlocked, not leveled; leveling costs helium/radon as normal. Returns the granted
// challenge names.
function applyChallengeCompletions(targetZone, changed){
	if (typeof game === 'undefined' || !game.challenges) return [];
	var universe = (saveObj.global && saveObj.global.universe === 2) ? 2 : 1;
	var granted = [];
	for (var name in game.challenges){
		try {
			var ch = game.challenges[name];
			if (!ch || typeof ch.onComplete !== 'function') continue;
			if (universe === 2 && !ch.allowU2) continue;
			if (universe === 1 && ch.blockU1) continue;
			var src = String(ch.onComplete);
			var perk = (src.match(UNLOCK_PERK_CALL) || [])[1];
			var marks = MARKS_COMPLETED.test(src);
			if (!perk && !marks) continue;
			var anchor = 0;
			if (typeof ch.completeAfterZone === 'number') anchor = ch.completeAfterZone;
			else if (ch.completeAfterMap && CHALLENGE_MAP_ZONES[ch.completeAfterMap]) anchor = CHALLENGE_MAP_ZONES[ch.completeAfterMap];
			else if (CHALLENGE_LEGACY_ZONES[name]) anchor = CHALLENGE_LEGACY_ZONES[name];
			if (!anchor || targetZone < anchor + 1) continue;
			var touched = false;
			if (marks && saveObj.challenges && saveObj.challenges[name] && saveObj.challenges[name].completed !== true){
				saveObj.challenges[name].completed = true;
				changed.push('challenges.' + name + '.completed');
				touched = true;
			}
			if (perk && saveObj.portal && saveObj.portal[perk]){
				var lockField = (universe === 2) ? 'radLocked' : 'locked';
				if (typeof saveObj.portal[perk][lockField] !== 'undefined' && saveObj.portal[perk][lockField] !== false){
					saveObj.portal[perk][lockField] = false;
					changed.push('portal.' + perk + '.' + lockField);
					touched = true;
				}
			}
			if (touched) granted.push(name + (perk ? ' (' + perk + ' perk)' : ''));
		} catch (e){} // entries with getters that need main.js (Daily); skip them
	}
	return granted;
}

// Apply everything a natural run would have by targetZone. Only ever unlocks — never locks,
// never lowers done or allowed counts — so jumping below your progress is a no-op for flags.
function applyZoneJump(targetZone){
	var changed = [];
	function unlockIn(section, names){
		if (!saveObj[section]) return;
		for (var i = 0; i < names.length; i++) unlockOne(section, names[i], changed);
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
				if (tier.globals[g] === 'brokenPlanet' && saveObj.global.universe === 2) continue; // U2's planet never breaks
				if (saveObj.global[tier.globals[g]] !== true){ saveObj.global[tier.globals[g]] = true; changed.push('global.' + tier.globals[g]); }
			}
		}
	}
	var derived = applyWorldUnlockDrops(targetZone, changed);
	var challenges = applyChallengeCompletions(targetZone, changed);
	saveObj.global.world = targetZone;
	saveObj.global.lastClearedCell = -1; // zone start, matching the engine's nextWorld reset
	if (typeof saveObj.global.highestLevelCleared === 'number' && saveObj.global.highestLevelCleared < targetZone - 1)
		saveObj.global.highestLevelCleared = targetZone - 1;
	return { changed: changed, derived: derived, challenges: challenges };
}

function onZoneJump(){
	if (!saveObj){ setStatus('Decode a save first.'); return; }
	var z = Number(document.getElementById('jumpZoneInput').value);
	if (!isNonNegInt(z) || z < 1){ setStatus('Jump zone must be a whole number of 1 or more.'); return; }
	var result = applyZoneJump(z);
	var changed = result.changed;
	flatten(saveObj);
	runSearch();
	invalidateOutputs();
	setStatus('Jumped to zone ' + z + '. Set world, cell, and zone record, and applied ' + changed.length +
		' unlock' + (changed.length === 1 ? '' : 's') + ' a natural run would have by now' +
		(result.challenges.length ? ', including ' + result.challenges.length + ' completed challenges with their reward perks unlocked (level those at View Perks; levels still cost helium)' : '') +
		'. Repeatable book upgrades (Coordination, TrainTacular, Gigastation, ...) are made buyable rather than auto-bought — ' +
		'purchase them in-game with edited resources; Coordination also needs trimp housing. ' +
		'The current zone still uses the old enemy grid until you finish it.' +
		(result.derived ? '' : ' WARNING: config.js did not load, so only baseline unlocks were applied. Open the editor from the game folder for the full set.'));
}

// ---------- Quick actions ----------
// One-step forms for the edits people actually open a save editor for: portal currency,
// perk refunds, run resources, permanent currencies, Fluffy/Scruffy, challenge records.
// Each apply* function commits its full linked-invariant patch atomically and returns a
// message describing exactly what changed (or a refusal). Amounts only ever add; levels
// and records only ever raise. DOM handlers (onQa*) stay thin so the logic is testable.

// Fluffy/Scruffy leveling constants from main.js `Fluffy` (main.js is not loaded here, so
// they're embedded like PERK_PARAMS): exp to BE level L = floor(first * 5^prestige *
// (4^L - 1) / 3). U1 Fluffy caps at the 10-entry reward list and every level requires a
// matching level of the Capable perk; U2 Scruffy caps at the 31-entry rewardsU2 list with
// no Capable gate (Fluffy.getCapableLevel returns the list length in U2).
var FLUFFY = { firstLevel: 1000, growth: 4, prestigeExpModifier: 5, maxLevelU1: 10, maxLevelU2: 31 };

function fluffyExpForLevel(level, prestige){
	var first = FLUFFY.firstLevel * Math.pow(FLUFFY.prestigeExpModifier, prestige || 0);
	return Math.floor(first * ((Math.pow(FLUFFY.growth, level) - 1) / (FLUFFY.growth - 1)));
}

function applyAddCurrency(curName, n){
	var cur = CURRENCIES[curName];
	if (!saveObj.global) return 'This save has no global section; cannot add ' + curName + '.';
	var lo = (typeof saveObj.global[cur.leftoverKey] === 'number') ? saveObj.global[cur.leftoverKey] : 0;
	if (!isFinite(lo + n)) return 'That amount would overflow ' + cur.leftoverKey + ' beyond what the save format can hold. Not changed.';
	saveObj.global[cur.leftoverKey] = lo + n;
	var total = syncCurrencyTotal(cur);
	return 'Added ' + n + ' ' + curName + ', spendable at View Perks right now. ' +
		(total !== null ? 'Lifetime total auto-updated to ' + total + '.' : 'Could not sync ' + cur.totalKey + '; check it manually.');
}

// Refund mirrors the in-game respec identity: perk spending drops by the freed amount and
// leftover rises by the same amount, so totalEarned stays constant and respec math holds.
function applyRefundPerks(curName){
	var cur = CURRENCIES[curName];
	if (!saveObj.portal || !saveObj.global) return 'This save has no perks section to refund.';
	var freed = 0, count = 0;
	for (var pk in saveObj.portal){
		var po = saveObj.portal[pk];
		if (!po || typeof po !== 'object' || po[cur.lockedField]) continue;
		if (typeof po[cur.levelField] !== 'number' || po[cur.levelField] <= 0) continue;
		if (typeof po[cur.spentField] === 'number') freed += po[cur.spentField];
		po[cur.levelField] = 0;
		po[cur.spentField] = 0;
		count++;
	}
	if (!count) return 'No ' + curName + ' perks have levels to refund.';
	var lo = (typeof saveObj.global[cur.leftoverKey] === 'number') ? saveObj.global[cur.leftoverKey] : 0;
	if (!isFinite(lo + freed)) return 'Refunding would overflow ' + cur.leftoverKey + '. Not changed.';
	saveObj.global[cur.leftoverKey] = lo + freed;
	return 'Refunded ' + count + ' ' + curName + ' perk' + (count === 1 ? '' : 's') + ': ' + freed + ' ' + curName +
		' moved to spendable-now. Lifetime total is unchanged, exactly like an in-game respec.';
}

// Population (trimps) is deliberately excluded: raising it naively breaks the
// employed-workers and army-size invariants the game enforces every tick.
var QA_RESOURCES = ['food', 'wood', 'metal', 'science', 'gems', 'fragments'];
function applyAddResources(n){
	if (!saveObj.resources) return 'This save has no resources section.';
	var added = [];
	for (var i = 0; i < QA_RESOURCES.length; i++){
		var r = saveObj.resources[QA_RESOURCES[i]];
		if (r && typeof r.owned === 'number' && isFinite(r.owned + n)){ r.owned += n; added.push(QA_RESOURCES[i]); }
	}
	if (!added.length) return 'No resource fields could take that amount.';
	return 'Added ' + n + ' to ' + added.join(', ') + '. Amounts above your storage cap still spend fine; gathering just cannot raise them further until storage catches up.';
}

function applyAddAtPath(tokens, label, n){
	var holder = saveObj;
	for (var i = 0; i < tokens.length - 1 && holder; i++) holder = holder[tokens[i]];
	var last = tokens[tokens.length - 1];
	if (!holder || typeof holder[last] !== 'number')
		return 'This save has no ' + tokens.join('.') + ' yet' + (tokens[0] === 'playerSpire' ? ' — open the Player Spire once in-game first.' : '.');
	if (!isFinite(holder[last] + n)) return 'That amount would overflow ' + tokens.join('.') + '. Not changed.';
	holder[last] += n;
	return 'Added ' + n + ' ' + label + ' (now ' + holder[last] + ').';
}

function applySetFluffy(universe, n){
	if (!saveObj.global) return 'This save has no global section.';
	var isU2 = universe === 2;
	var petName = isU2 ? 'Scruffy' : 'Fluffy';
	var expField = isU2 ? 'fluffyExp2' : 'fluffyExp';
	var prestigeField = isU2 ? 'fluffyPrestige2' : 'fluffyPrestige';
	var prestige = (typeof saveObj.global[prestigeField] === 'number') ? saveObj.global[prestigeField] : 0;
	var targetExp = fluffyExpForLevel(n, prestige);
	if (!isFinite(targetExp)) return 'That level overflows the exp math. Not changed.';
	var msg = [];
	var curExp = (typeof saveObj.global[expField] === 'number') ? saveObj.global[expField] : 0;
	if (curExp >= targetExp){
		msg.push(petName + ' already has ' + curExp + ' exp, at or past level ' + n + '; exp was not lowered.');
	} else {
		saveObj.global[expField] = targetExp;
		msg.push('Set ' + petName + ' to exactly level ' + n + (prestige ? ' at prestige ' + prestige : '') + ' (' + expField + ' = ' + targetExp + ').');
	}
	if (!isU2){
		// Every Fluffy level requires a level of the Capable perk, and Fluffy is inactive at
		// Capable 0 — raise the perk to match, with real spent/total sync like any perk edit.
		var cap = saveObj.portal && saveObj.portal.Capable;
		if (cap && typeof cap === 'object' && (typeof cap.level !== 'number' || cap.level < n)){
			cap.level = n;
			cap.locked = false;
			cap.heliumSpent = perkSpentForLevel('Capable', n);
			var total = syncCurrencyTotal(CURRENCIES.helium);
			msg.push('Raised the Capable perk to ' + n + ' (Fluffy is gated by it) and recomputed its helium spending' +
				(total !== null ? '; lifetime helium total auto-updated to ' + total : '') + '.');
		}
	}
	return msg.join(' ');
}

function applyRaiseC2(n){
	if (!saveObj.c2 || typeof saveObj.c2 !== 'object') return 'This save has no Challenge² records section.';
	var raised = 0, total = 0;
	for (var k in saveObj.c2){
		if (typeof saveObj.c2[k] !== 'number') continue;
		total++;
		if (saveObj.c2[k] < n){ saveObj.c2[k] = n; raised++; }
	}
	if (!raised) return 'All ' + total + ' challenge records are already at or above zone ' + n + '.';
	return 'Raised ' + raised + ' of ' + total + ' Challenge² and Challenge³ records to zone ' + n +
		'. The game recomputes the bonus from these on load; records above ' + n + ' were not lowered.';
}

// Shared DOM plumbing: read a positive number (integer where the game requires one),
// run the action, re-index, and announce.
function qaNumber(inputId, wantInt){
	var el = document.getElementById(inputId);
	if (!el || el.value.trim() === '') return null;
	var n = Number(el.value);
	if (!isFinite(n) || n <= 0) return null;
	if (wantInt && Math.floor(n) !== n) return null;
	return n;
}

function runQuickAction(inputId, wantInt, what, fn){
	if (!saveObj){ setStatus('Decode a save first.'); return; }
	var n = null;
	if (inputId !== null){
		n = qaNumber(inputId, wantInt);
		if (n === null){ setStatus('Enter a positive ' + (wantInt ? 'whole ' : '') + 'number ' + what + '. Scientific notation like 1e15 works.'); return; }
	}
	var msg = fn(n);
	flatten(saveObj);
	runSearch();
	invalidateOutputs();
	setStatus(msg);
}

// [inputId, integerOnly, save path tokens, label for the status message]
var QA_ADDERS = [
	['qaBones', true, ['global', 'b'], 'bones'],
	['qaNullifium', false, ['global', 'nullifium'], 'nullifium'],
	['qaEssence', false, ['global', 'essence'], 'dark essence'],
	['qaMagmite', false, ['global', 'magmite'], 'magmite'],
	['qaVoidMaps', true, ['global', 'totalVoidMaps'], 'void maps'],
	['qaRunestones', false, ['playerSpire', 'main', 'runestones'], 'Player Spire runestones'],
	['qaSpirestones', false, ['playerSpire', 'main', 'spirestones'], 'spirestones']
];

function wireQuickActions(){
	document.getElementById('qaHeliumBtn').addEventListener('click', function(){
		runQuickAction('qaHelium', false, 'of helium to add', function(n){ return applyAddCurrency('helium', n); });
	});
	document.getElementById('qaRadonBtn').addEventListener('click', function(){
		runQuickAction('qaRadon', false, 'of radon to add', function(n){ return applyAddCurrency('radon', n); });
	});
	document.getElementById('qaRefundHeliumBtn').addEventListener('click', function(){
		runQuickAction(null, false, '', function(){ return applyRefundPerks('helium'); });
	});
	document.getElementById('qaRefundRadonBtn').addEventListener('click', function(){
		runQuickAction(null, false, '', function(){ return applyRefundPerks('radon'); });
	});
	document.getElementById('qaRespecBtn').addEventListener('click', function(){
		runQuickAction(null, false, '', function(){
			if (!saveObj.global) return 'This save has no global section.';
			if (saveObj.global.canRespecPerks === true) return 'Perk respec is already available.';
			saveObj.global.canRespecPerks = true;
			return 'Perk respec re-enabled: the Respec button will be back at your next portal screen.';
		});
	});
	document.getElementById('qaResourcesBtn').addEventListener('click', function(){
		runQuickAction('qaResources', false, 'to add to each resource', applyAddResources);
	});
	QA_ADDERS.forEach(function(row){
		document.getElementById(row[0] + 'Btn').addEventListener('click', function(){
			runQuickAction(row[0], row[1], 'of ' + row[3] + ' to add', function(n){ return applyAddAtPath(row[2], row[3], n); });
		});
	});
	document.getElementById('qaFluffyBtn').addEventListener('click', function(){
		runQuickAction('qaFluffy', true, 'from 1 to ' + FLUFFY.maxLevelU1 + ' for Fluffy', function(n){
			if (n > FLUFFY.maxLevelU1) return 'Fluffy caps at level ' + FLUFFY.maxLevelU1 + '. Not changed.';
			return applySetFluffy(1, n);
		});
	});
	document.getElementById('qaScruffyBtn').addEventListener('click', function(){
		runQuickAction('qaScruffy', true, 'from 1 to ' + FLUFFY.maxLevelU2 + ' for Scruffy', function(n){
			if (n > FLUFFY.maxLevelU2) return 'Scruffy caps at level ' + FLUFFY.maxLevelU2 + '. Not changed.';
			return applySetFluffy(2, n);
		});
	});
	document.getElementById('qaC2Btn').addEventListener('click', function(){
		runQuickAction('qaC2', true, 'for the target zone', applyRaiseC2);
	});
	document.getElementById('qaChallengesBtn').addEventListener('click', function(){
		runQuickAction('qaChallenges', true, 'for the zone to complete challenges through', function(n){
			var changed = [];
			var granted = applyChallengeCompletions(n, changed);
			if (typeof game === 'undefined' || !game.challenges) return 'The game data (config.js) did not load, so challenges cannot be derived. Open the editor from the game folder.';
			if (!granted.length) return 'Nothing new to complete: every challenge with a completion anchor at or below zone ' + n + ' for this universe is already done or unlocked.';
			return 'Completed ' + granted.length + ' challenge' + (granted.length === 1 ? '' : 's') + ': ' + granted.join(', ') +
				'. Reward perks are unlocked at View Perks; leveling them still costs helium or radon.';
		});
	});
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
	// Category views pass a friendly label; the raw path still rides along for search users.
	var shownName = d.label ? d.label + ' (' + d.path + ')' : d.path;
	if (d.type === 'boolean'){
		var cb = document.createElement('input');
		cb.type = 'checkbox'; cb.id = id; cb.checked = !!current;
		cb.setAttribute('data-path', d.path);
		cb.addEventListener('change', onFieldChange);
		var labCb = document.createElement('label');
		labCb.setAttribute('for', id); labCb.textContent = ' ' + shownName + hint;
		wrap.appendChild(cb); wrap.appendChild(labCb);
	} else {
		var lab = document.createElement('label');
		lab.setAttribute('for', id);
		lab.textContent = shownName + (d.type === 'null' ? ' (currently empty)' : '') + hint;
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

// Curated browse categories: human-named groups so nothing requires knowing a field name.
// `fixed` entries are [path, label]; `dynamic` sections generate one labeled entry per item
// in the loaded save (perks, equipment, jobs, buildings, upgrades).
var CATEGORIES = [
	{ name: 'Progress', fixed: [
		['global.world', 'Current zone'],
		['global.lastClearedCell', 'Last cleared cell in this zone'],
		['global.highestLevelCleared', 'Zone record (game shows this plus 1)'],
		['global.totalPortals', 'Total portals used'],
		['global.totalVoidMaps', 'Void maps held'] ] },
	{ name: 'Helium and Radon', fixed: [
		['global.totalHeliumEarned', 'Helium lifetime total (raising it adds spendable helium)'],
		['global.heliumLeftover', 'Helium spendable now'],
		['resources.helium.owned', 'Helium owned this run (pays out at next portal)'],
		['global.totalRadonEarned', 'Radon lifetime total'],
		['global.radonLeftover', 'Radon spendable now'],
		['resources.radon.owned', 'Radon owned this run'] ] },
	{ name: 'Resources', fixed: [
		['resources.food.owned', 'Food'],
		['resources.wood.owned', 'Wood'],
		['resources.metal.owned', 'Metal'],
		['resources.science.owned', 'Science'],
		['resources.gems.owned', 'Gems'],
		['resources.fragments.owned', 'Fragments'] ] },
	{ name: 'Trimps and army', fixed: [
		['resources.trimps.owned', 'Trimps population'],
		['resources.trimps.soldiers', 'Soldiers fighting'],
		['resources.trimps.maxSoldiers', 'Max soldiers (derived)'],
		['global.attack', 'Army attack total (auto-managed by equipment edits)'],
		['global.health', 'Army health total (auto-managed by equipment edits)'],
		['global.block', 'Army block total'] ] },
	{ name: 'Perks', dynamic: 'perks' },
	{ name: 'Equipment', dynamic: 'equipment' },
	{ name: 'Jobs', dynamic: 'jobs' },
	{ name: 'Buildings', dynamic: 'buildings' },
	{ name: 'Upgrades and features', dynamic: 'upgrades' },
	{ name: 'Fluffy and Scruffy', fixed: [
		['global.fluffyExp', 'Fluffy experience (Universe 1)'],
		['global.fluffyPrestige', 'Fluffy prestige'],
		['global.fluffyExp2', 'Scruffy experience (Universe 2)'],
		['global.fluffyPrestige2', 'Scruffy prestige'] ] },
	{ name: 'Special currencies', fixed: [
		['global.b', 'Bones'],
		['global.nullifium', 'Nullifium (heirloom upgrades)'],
		['global.essence', 'Dark essence (masteries)'],
		['global.magmite', 'Magmite (Dimensional Generator)'],
		['global.totalVoidMaps', 'Void maps held'],
		['playerSpire.main.runestones', 'Player Spire runestones'],
		['playerSpire.main.spirestones', 'Spirestones (Core heirlooms)'] ] },
	{ name: 'Nature (zone 236+)', fixed: [
		['empowerments.Poison.level', 'Poison empowerment level'],
		['empowerments.Poison.retainLevel', 'Poison retain level'],
		['empowerments.Poison.tokens', 'Poison tokens'],
		['empowerments.Wind.level', 'Wind empowerment level'],
		['empowerments.Wind.retainLevel', 'Wind retain level'],
		['empowerments.Wind.tokens', 'Wind tokens'],
		['empowerments.Ice.level', 'Ice empowerment level'],
		['empowerments.Ice.retainLevel', 'Ice retain level'],
		['empowerments.Ice.tokens', 'Ice tokens'] ] }
];

// Turn a category into labeled descriptors for renderFields. Labels ride on shallow copies so
// leafByPath (used by change handlers) keeps the canonical descriptor.
function categoryFields(cat){
	var out = [];
	function add(path, label){
		var d = leafByPath[path];
		if (d) out.push(Object.assign({}, d, { label: label }));
	}
	if (cat.fixed) for (var i = 0; i < cat.fixed.length; i++) add(cat.fixed[i][0], cat.fixed[i][1]);
	if (!cat.dynamic || !saveObj) return out;
	var names;
	if (cat.dynamic === 'perks' && saveObj.portal){
		names = Object.keys(saveObj.portal).sort();
		for (var p = 0; p < names.length; p++){
			var perk = saveObj.portal[names[p]];
			if (!perk || typeof perk !== 'object') continue;
			var nice = names[p].replace('_', ' ');
			if (typeof perk.level === 'number') add('portal.' + names[p] + '.level', nice + ' perk level');
			if (typeof perk.radLevel === 'number') add('portal.' + names[p] + '.radLevel', nice + ' perk radon level');
		}
	}
	else if (cat.dynamic === 'equipment' && saveObj.equipment){
		names = Object.keys(saveObj.equipment).sort();
		for (var e = 0; e < names.length; e++){
			add('equipment.' + names[e] + '.level', names[e] + ' level');
			add('equipment.' + names[e] + '.prestige', names[e] + ' prestige');
			add('equipment.' + names[e] + '.locked', names[e] + ' locked (0 = owned)');
		}
	}
	else if (cat.dynamic === 'jobs' && saveObj.jobs){
		names = Object.keys(saveObj.jobs).sort();
		for (var j = 0; j < names.length; j++){
			add('jobs.' + names[j] + '.owned', names[j] + ' count');
			add('jobs.' + names[j] + '.locked', names[j] + ' locked (0 = available)');
		}
	}
	else if (cat.dynamic === 'buildings' && saveObj.buildings){
		names = Object.keys(saveObj.buildings).sort();
		for (var b = 0; b < names.length; b++){
			add('buildings.' + names[b] + '.owned', names[b] + ' count');
			add('buildings.' + names[b] + '.locked', names[b] + ' locked (0 = available)');
		}
	}
	else if (cat.dynamic === 'upgrades' && saveObj.upgrades){
		names = Object.keys(saveObj.upgrades).sort();
		for (var u = 0; u < names.length; u++){
			var up = saveObj.upgrades[names[u]];
			if (up && typeof up === 'object' && typeof up.done === 'number') add('upgrades.' + names[u] + '.done', names[u] + ' purchased (count)');
		}
	}
	return out;
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

function showCategory(cat){
	document.getElementById('searchBox').value = '';
	renderFields(categoryFields(cat));
	var count = document.getElementById('resultCount');
	count.textContent = cat.name + ': ' + count.textContent;
}

function buildCategoryButtons(){
	var box = document.getElementById('categoryButtons');
	box.innerHTML = '';
	CATEGORIES.forEach(function(cat){
		var b = document.createElement('button');
		b.type = 'button'; b.textContent = cat.name;
		b.addEventListener('click', function(){ showCategory(cat); });
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
	buildCategoryButtons();
	document.getElementById('editorSections').hidden = false;
	document.getElementById('searchBox').value = '';
	document.getElementById('exportBox').value = '';
	document.getElementById('jsonBox').value = '';
	jsonStale = false;
	applyJsonArmed = false;
	renderFields(commonList());
	setStatus('Save decoded. Zone ' + (obj.global.world != null ? obj.global.world : '?') + ', version ' + (obj.global.stringVersion || '?') + '. ' + leaves.length + ' editable values. Quick actions below cover the common edits (currencies, refunds, Fluffy, challenge records); search finds anything else.');
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
	buildCategoryButtons();
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
	wireQuickActions();
	document.getElementById('searchBox').addEventListener('input', onSearchInput);
	document.getElementById('encodeBtn').addEventListener('click', onEncode);
	document.getElementById('copyBtn').addEventListener('click', onCopy);
	document.getElementById('showJsonBtn').addEventListener('click', onShowJson);
	document.getElementById('applyJsonBtn').addEventListener('click', onApplyJson);
});
