// Client-side error beacon. Reports JS errors, unhandled promise rejections, and events
// pushed via clientLog(kind, msg) to GET /log, which nginx records server-side. Exists so
// problems in a screen-reader session are diagnosable without needing the browser console.
// Capped and deduplicated per page load so a crash loop cannot flood the log.
(function(){
	var MAX_EVENTS = 25;
	var sent = 0;
	var seen = {};

	function beacon(kind, msg){
		if (sent >= MAX_EVENTS) return;
		var key = kind + '|' + msg;
		if (seen[key]) return;
		seen[key] = true;
		sent++;
		var extra = '';
		try { if (typeof game === 'object' && game && game.global) extra = ' z' + game.global.world + ' v' + game.global.stringVersion; } catch (e){}
		var m = encodeURIComponent(('[' + kind + '] ' + location.pathname + extra + ' :: ' + msg).slice(0, 1600));
		try { fetch('/log?m=' + m, { keepalive: true, cache: 'no-store' }); }
		catch (e){ try { new Image().src = '/log?m=' + m; } catch (e2){} }
	}

	window.clientLog = beacon;

	window.addEventListener('error', function(e){
		var stack = (e.error && e.error.stack) ? ' | ' + String(e.error.stack).split('\n').slice(0, 3).join(' <- ') : '';
		beacon('error', (e.message || '?') + ' @ ' + (e.filename || '?').split('/').pop() + ':' + e.lineno + ':' + e.colno + stack);
	});

	window.addEventListener('unhandledrejection', function(e){
		var r = e.reason;
		beacon('promise', (r && r.stack) ? String(r.stack).split('\n').slice(0, 3).join(' <- ') : String(r).slice(0, 300));
	});
})();
