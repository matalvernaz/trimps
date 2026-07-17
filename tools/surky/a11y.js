'use strict';
// Accessibility addon for Surky (loaded last; the upstream single-file page is untouched
// apart from lang attribute and this script tag). Surky's results already land in properly
// labeled number inputs, so the work here is announcements and descriptions, not structure.

(function(){
	function announce(msg){
		var r = document.getElementById('a11yStatus');
		if (r) r.textContent = msg;
	}

	function setup(){
		var r = document.createElement('p');
		r.id = 'a11yStatus';
		r.setAttribute('role', 'status');
		r.setAttribute('aria-live', 'polite');
		document.body.insertBefore(r, document.body.firstChild);

		// Hover-only title tooltips become part of each control's accessible description.
		var style = document.createElement('style');
		style.textContent = '.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}';
		document.head.appendChild(style);
		var titled = document.querySelectorAll('input[title], select[title], button[title], label[title]');
		for (var i = 0; i < titled.length; i++){
			var t = titled[i];
			var txt = t.getAttribute('title');
			if (!txt) continue;
			var target = (t.tagName === 'LABEL') ? (document.getElementById(t.getAttribute('for')) || t) : t;
			var span = document.createElement('span');
			span.className = 'sr-only';
			span.id = 'a11ydesc' + i;
			span.textContent = txt;
			t.parentNode.insertBefore(span, t.nextSibling);
			target.setAttribute('aria-describedby', span.id);
		}

		// Inputs with no resolvable label get one derived from their id
		// (input-dark-mode -> "dark mode").
		var inputs = document.querySelectorAll('input, select, textarea');
		for (var j = 0; j < inputs.length; j++){
			var inp = inputs[j];
			if (inp.getAttribute('aria-label') || inp.getAttribute('aria-labelledby')) continue;
			if (inp.id && document.querySelector('label[for="' + inp.id + '"]')) continue;
			if (inp.closest && inp.closest('label')) continue;
			if (inp.id) inp.setAttribute('aria-label', inp.id.replace(/^(input|label)-/, '').replace(/-/g, ' '));
		}

		// Snapshot perk number inputs so allocation runs can report how many changed.
		function snapshot(){
			var m = {};
			var nums = document.querySelectorAll('input[type="number"][id^="input-"]');
			for (var k = 0; k < nums.length; k++) m[nums[k].id] = nums[k].value;
			return m;
		}
		function wrapAllocator(name, verb){
			var orig = window[name];
			if (typeof orig !== 'function') return;
			window[name] = function(){
				var before = snapshot();
				var out = orig.apply(this, arguments);
				var after = snapshot(), changed = 0;
				for (var id in after) if (after[id] !== before[id]) changed++;
				announce(verb + ' complete: ' + changed + ' perk value' + (changed === 1 ? '' : 's') + ' updated. Each result is in its own labeled field; when happy, use Export perks to copy the string for the game.');
				return out;
			};
		}
		wrapAllocator('clearAndAutobuyPerks', 'Clear and autobuy');
		wrapAllocator('autobuyPerks', 'Autobuy');

		if (typeof window.exportPerks === 'function'){
			var origExport = window.exportPerks;
			window.exportPerks = function(){
				var out = origExport.apply(this, arguments);
				announce('Perk string copied to clipboard. In the game, open View Perks, choose Import, and paste it.');
				return out;
			};
		}
		if (typeof window.restoreSave === 'function'){
			var origRestore = window.restoreSave;
			window.restoreSave = function(){
				var out = origRestore.apply(this, arguments);
				announce('Previous save text restored into the save box.');
				return out;
			};
		}
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
	else setup();
})();
