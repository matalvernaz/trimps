'use strict';
// Accessibility addon for Perky (loaded after perks.js; upstream files stay unmodified).
// Wraps display()/show_alert() and augments the DOM so the whole flow works with a screen
// reader: described inputs, announced alerts, and a readable results list.

(function(){
	function el(tag, attrs, text){
		var e = document.createElement(tag);
		for (var k in attrs) e.setAttribute(k, attrs[k]);
		if (text) e.textContent = text;
		return e;
	}

	// Perky shows help as title attributes (hover-only). Move each into a visually hidden
	// span inside the label so screen readers read it as part of the field description.
	function describeInputs(){
		var style = el('style', {});
		style.textContent = '.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}';
		document.head.appendChild(style);
		var labels = document.querySelectorAll('label[title]');
		for (var i = 0; i < labels.length; i++){
			var lab = labels[i];
			var input = lab.querySelector('input, select, textarea');
			if (!input) continue;
			var descId = 'a11ydesc' + i;
			lab.appendChild(el('span', { 'class': 'sr-only', id: descId }, ' ' + lab.getAttribute('title')));
			input.setAttribute('aria-describedby', descId);
		}
		var save = document.getElementById('save');
		if (save) save.setAttribute('aria-label', 'Paste your Trimps save export here. The calculator reads it and optimizes automatically when you paste. The field clears itself when focused.');
		var perkstring = document.getElementById('perkstring');
		if (perkstring) perkstring.setAttribute('aria-label', 'Optimized perk string. Copy this and paste it into the game, on the View Perks screen, using Import.');
	}

	// Alerts: announce insertions, and make the dismiss badge keyboard-operable.
	function fixAlerts(){
		var alert = document.getElementById('alert');
		if (!alert) return;
		alert.setAttribute('role', 'alert');
		alert.setAttribute('aria-live', 'assertive');
		new MutationObserver(function(){
			var badges = alert.querySelectorAll('.badge:not([role])');
			for (var i = 0; i < badges.length; i++){
				var b = badges[i];
				b.setAttribute('role', 'button');
				b.setAttribute('tabindex', '0');
				b.setAttribute('aria-label', 'Dismiss message');
				b.addEventListener('keydown', function(e){
					if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); this.click(); }
				});
			}
		}).observe(alert, { childList: true, subtree: true });
	}

	// Accessible results: wrap display() and rebuild the outcome as headed prose + a list,
	// derived from the same data the visual grid uses. Announced politely when it updates.
	function accessibleResults(){
		if (typeof window.display !== 'function') return;
		var region = el('section', { id: 'a11yResults', 'aria-live': 'polite' });
		region.appendChild(el('h2', {}, 'Results (screen reader friendly)'));
		var summary = el('p', { id: 'a11ySummary' });
		var list = el('ul', { id: 'a11yList' });
		region.appendChild(summary);
		region.appendChild(list);
		var results = document.getElementById('results');
		results.parentNode.insertBefore(region, results.nextSibling);

		var prettyFn = window.prettify || String;
		var origDisplay = window.display;
		window.display = function(result){
			origDisplay(result);
			var heLeft = result[0], perks = result[1];
			summary.textContent = 'Optimization complete. ' + prettyFn(heLeft) + ' helium left over. Suggested perk levels follow; the perk string box below can be imported in the game via View Perks, then Import.';
			list.innerHTML = '';
			// Upstream display() mutates the perk map to plain numbers (levels) before this
			// runs, so read numbers, and skip perks that are 0 with no removal to report.
			Object.keys(perks).forEach(function(name){
				var p = perks[name];
				var lvl = (typeof p === 'object') ? p.level : p;
				if (typeof lvl !== 'number') return;
				var delta = (window.game && window.game.portal[name]) ? lvl - (window.game.portal[name].level || 0) : null;
				if (lvl === 0 && !delta) return;
				var text = name.replace('_', ' ') + ': level ' + prettyFn(lvl);
				if (delta) text += ' (' + (delta > 0 ? 'up ' : 'down ') + prettyFn(Math.abs(delta)) + ')';
				list.appendChild(el('li', {}, text));
			});
		};
	}

	document.addEventListener('DOMContentLoaded', function(){
		describeInputs();
		fixAlerts();
		accessibleResults();
	});
})();
