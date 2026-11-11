// Screen pop and call status from /pbx/events (server-sent events). The strings come
// from the toast's data attributes so the script is the same for every tenant.
(function () {
  var toast = document.getElementById('pbx-toast');
  if (!toast || !window.EventSource) return;
  var status = {};
  try { status = JSON.parse(toast.dataset.status || '{}'); } catch (e) { /* keep empty */ }
  var hideTimer = null;

  function show(html, ms) {
    toast.innerHTML = html;
    toast.hidden = false;
    if (hideTimer) clearTimeout(hideTimer);
    if (ms) hideTimer = setTimeout(function () { toast.hidden = true; }, ms);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var es = new EventSource('/pbx/events');
  es.addEventListener('inbound', function (m) {
    var d = JSON.parse(m.data);
    var who = d.advocate
      ? '<a href="/advocates/' + encodeURIComponent(d.advocate.sourceId) + '">' + esc(d.advocate.fullName) + '</a>' + (d.advocate.city ? ' · ' + esc(d.advocate.city) : '')
      : '<span class="muted">' + esc(toast.dataset.unknown) + '</span>';
    show('<strong>☎ ' + esc(toast.dataset.incoming) + '</strong> ' + esc(d.number) + '<br>' + who, 60000);
  });
  es.addEventListener('call', function (m) {
    var d = JSON.parse(m.data);
    if (d.direction === 'inbound' && d.status !== 'ended') return;
    var line = status[d.status] || d.status;
    if (d.status === 'ended' && d.duration) line += ' · ' + esc(d.duration);
    show('<strong>' + esc(line) + '</strong> ' + esc(d.number), d.status === 'ended' ? 8000 : 0);
    // the note on the open card changes when the call ends: refresh it
    if (d.status === 'ended' && d.sourceId && location.pathname === '/advocates/' + encodeURIComponent(d.sourceId)) {
      setTimeout(function () { location.reload(); }, 1500);
    }
  });
})();
