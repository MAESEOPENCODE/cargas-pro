/* ══ DISPOSICIÓN NAVISION — comportamiento ══
   Solo añade navegación y selección; toda la lógica de pedidos
   sigue siendo la original (openPedidoModal, terminarPedido, etc.). */
(function () {
  const $ = id => document.getElementById(id);
  let selId = null;

  const TAB_NAME = { pendientes:'Confección', terminado:'Terminado', todos:'Todos', cargados:'Cargados hoy', historico:'Histórico' };

  function counts() {
    const hoy = new Date().toISOString().slice(0, 10);
    const c = { pendientes:0, terminado:0, revision:0, cargados:0, historico:0, todos:0 };
    (window.pedidos || pedidos).forEach(p => {
      const d = cargDay(p);
      if (p.status === 'pendiente') c.pendientes++;
      else if (p.status === 'terminado') c.terminado++;
      else if (p.status === 'revision') c.revision++;
      else if (p.status === 'cargado') { if (d && d < hoy) c.historico++; else c.cargados++; }
    });
    c.todos = c.pendientes + c.terminado + c.revision + c.cargados;
    return c;
  }

  function findPedido(id) { return pedidos.find(p => String(p.id) === String(id)); }

  function sync() {
    const c = counts();
    document.querySelectorAll('[data-np]').forEach(el => {
      const t = el.getAttribute('data-np');
      el.classList.toggle('active', t === activeTab);
      const n = el.querySelector('.np-count');
      if (n && c[t] !== undefined) n.textContent = c[t];
    });
    const cues = { 'cue-pend':c.pendientes, 'cue-term':c.terminado, 'cue-rev':c.revision, 'cue-carg':c.cargados };
    Object.keys(cues).forEach(k => { const e = $(k); if (e) e.querySelector('.cue-n').textContent = cues[k]; });
    document.querySelectorAll('.cue').forEach(e => e.classList.toggle('active', e.getAttribute('data-tab') === activeTab));

    const cr = $('crumbs');
    if (cr) cr.innerHTML = 'Pedidos<i>›</i><b>' + (TAB_NAME[activeTab] || '') + '</b>';

    // Reaplicar selección tras cada render
    document.querySelectorAll('.sel').forEach(e => e.classList.remove('sel'));
    if (selId) {
      const b = document.querySelector('[data-action][data-id="' + String(selId).replace(/"/g, '') + '"]');
      const row = b && b.closest('tr, .pedido-card');
      if (row) row.classList.add('sel'); else selId = null;
    }
    ribbonState();
  }

  function ribbonState() {
    const p = selId ? findPedido(selId) : null;
    const st = p ? p.status : '';
    const set = (id, on) => { const b = $(id); if (b) b.disabled = !on; };
    set('rb-editar', !!p);
    set('rb-terminar', !!p && (st === 'pendiente' || st === 'revision'));
    set('rb-cargar', !!p && st !== 'cargado');
    set('rb-reabrir', !!p && st === 'cargado');
    set('rb-eliminar', !!p);
  }

  // Envolver render (las funciones globales se resuelven por nombre en cada llamada)
  const _render = window.render;
  window.render = function () { const r = _render.apply(this, arguments); sync(); return r; };

  // Selección de fila / ficha
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-action], button, input, select, a')) return;
    const row = e.target.closest('#tableArea tbody tr, #tableArea tr:not(.camion-tbl-header), #listArea .pedido-card');
    if (!row || row.classList.contains('camion-tbl-header') || row.querySelector('th')) return;
    const b = row.querySelector('[data-action]');
    if (!b) return;
    selId = b.getAttribute('data-id');
    sync();
  });
  document.addEventListener('dblclick', function (e) {
    const tr = e.target.closest('#tableArea tr');
    if (!tr) return;
    const b = tr.querySelector('[data-action]');
    if (b) { selId = b.getAttribute('data-id'); sync(); openPedidoModal(selId); }
  });

  // Acciones de la cinta
  window.rbAct = function (a) {
    if (a === 'nuevo') { expandAll(); return openPedidoModal(null); }
    if (!selId) { toast('Selecciona un pedido de la lista'); return; }
    const id = selId;
    if (a === 'editar') { expandAll(); return openPedidoModal(id); }
    if (a === 'terminar') return terminarPedido(id);
    if (a === 'cargar') { expandAll(); return openCargarModal(id); }
    if (a === 'reabrir') return reabrir(id);
    if (a === 'eliminar') return delPedido(id);
  };
  window.rbTab = function (name) {
    document.querySelectorAll('.rb-tab').forEach(t => t.classList.toggle('active', t.getAttribute('data-rb') === name));
    document.querySelectorAll('.rb-panel').forEach(p => p.classList.toggle('active', p.getAttribute('data-rb') === name));
  };
  window.rbClick = function (id) { const b = $(id); if (b) b.click(); };

  // Panel de navegación
  window.npToggle = function (force) {
    const p = $('navPane'); if (!p) return;
    p.classList.toggle('open', typeof force === 'boolean' ? force : !p.classList.contains('open'));
  };
  window.npGo = function (fn) {
    npToggle(false);
    if (typeof fn === 'string') { setTab(fn); return; }
    fn();
  };

  // FastTabs plegables
  function expandAll() { document.querySelectorAll('.fsec.collapsed').forEach(h => h.click()); }
  document.addEventListener('click', function (e) {
    const h = e.target.closest('.modal-scroll .fsec');
    if (!h) return;
    const cerrar = h.classList.toggle('collapsed');
    let n = h.nextElementSibling;
    while (n && !n.classList.contains('fsec')) { n.classList.toggle('fs-hidden', cerrar); n = n.nextElementSibling; }
  });

  // Vista inicial: lista en cuadrícula en pantallas anchas (como una lista de NAV)
  if (window.innerWidth >= 900) {
    const btn = document.querySelectorAll('.view-btn')[1];
    if (btn) setView('table', btn);
  }
  sync();
})();
