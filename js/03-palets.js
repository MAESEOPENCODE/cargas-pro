// ═══════════════════════════════════════════════════════════════════════
// CARGAS PRO · CONTROL DE PALETS / UNIDADES LOGÍSTICAS
// Identidad única + código de barras + reserva + preparación + carga + trazabilidad.
// ═══════════════════════════════════════════════════════════════════════
(function(){
  const $ = id => document.getElementById(id);
  const esc = v => String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const up = v => String(v||'').trim().toUpperCase();
  const nowISO = () => new Date().toISOString();
  let salidaPalets = [];
  let salidaPicking = [];
  let salidaPedidos = [];
  let salidaPedidoActivo = '';
  let salidaPorPedido = new Map();
  let salidaCargaId = '';
  let cpEditPaletId = '';
  function cpGuardarPreparacionActiva(){ if(salidaPedidoActivo) salidaPorPedido.set(String(salidaPedidoActivo),{palets:[...salidaPalets],picking:JSON.parse(JSON.stringify(salidaPicking))}); }
  function cpCargarPreparacion(id){ const v=salidaPorPedido.get(String(id))||{palets:[],picking:[]}; salidaPalets=[...(v.palets||[])]; salidaPicking=JSON.parse(JSON.stringify(v.picking||[])); }
  let camStream = null, camTimer = null;

  function pedidoTxt(p){ return up(p?.grupo||'') + (p?.num ? ' #'+p.num : ''); }
  function pedidoById(id){ return pedidos.find(p=>String(p.id)===String(id)); }
  function palletStatusLabel(s){ return ({disponible:'Disponible',reservado:'Reservado',preparando:'Preparando',cargado:'Cargado',bloqueado:'Bloqueado',anulado:'Anulado',agotado:'Agotado'}[s]||s||'—'); }
  function createdValue(v){ return v?.seconds ? v.seconds*1000 : (typeof v==='number'?v:Date.parse(v||'')||0); }

  window.abrirPalets = function(){
    $('cpPaletsScreen').classList.add('open');
    document.body.style.overflow='hidden';
    cpPalTab(window._cpPalTab||'palets'); cpRenderPalets();
  };
  window.cerrarPalets = function(){ $('cpPaletsScreen').classList.remove('open'); document.body.style.overflow=''; cpCerrarCamara(); };

  function cpPedidoOptions(selectId, includeBlank){
    const el=$(selectId); if(!el) return;
    const current=el.value;
    const ps=pedidos.filter(p=>p.status!=='cargado').sort((a,b)=>String(a.num||'').localeCompare(String(b.num||''),undefined,{numeric:true}));
    el.innerHTML=(includeBlank?'<option value="">Sin pedido · stock</option>':'<option value="">Selecciona pedido</option>')+ps.map(p=>`<option value="${esc(p.id)}">${esc(pedidoTxt(p))} · ${esc(p.producto||'')}</option>`).join('');
    if(ps.some(p=>String(p.id)===String(current))) el.value=current;
  }

  window.cpImprimirCarga=function(cargaId,modo){
    const g=cpSalidasAll().filter(s=>String(s.cargaId||s.id)===String(cargaId)); if(!g.length){toast('⚠️ Carga no encontrada');return;}
    const ms=s=>createdValue(s.createdAt)||Date.parse(s.confirmedAt||'')||0;
    g.sort((a,b)=>(a.ordenCarga||999)-(b.ordenCarga||999)||ms(a)-ms(b));
    const h=g[0], det=modo==='detalle', n=v=>parseInt(v)||0;
    const fecha=new Date(ms(h)||Date.now()).toLocaleString('es-ES');
    let seq=0, totP=0, totC=0, totK=0, totPk=0;
    const bloques=g.map((s,k)=>{
      const ps=(s.palets||[]).map(id=>palets.find(x=>String(x.id)===String(id))||{id}), pk=s.picking||[];
      const cajasP=ps.reduce((a,x)=>a+(Array.isArray(x.contenido)&&x.contenido.length?x.contenido.reduce((b,c)=>b+n(c.cajas),0):n(x.cajas)),0);
      const cajasPk=pk.reduce((a,r)=>a+n(r.cajas),0), kg=ps.reduce((a,x)=>a+(parseFloat(x.peso)||0),0);
      totP+=ps.length; totC+=cajasP; totPk+=cajasPk; totK+=kg;
      const ped=pedidos.find(p=>String(p.id)===String(s.pedidoId));
      const cab=`<td>${k+1}º</td><td><b>${esc(s.pedidoNum||s.pedidoId)}</b></td><td>${esc(s.cliente||'')}</td>`;
      if(!det) return {res:`<tr>${cab}<td>${esc(ped?.producto||'')}${ped?.productosExtra?.length?' +'+ped.productosExtra.length:''}</td><td class="r">${ps.length}</td><td class="r">${cajasP}</td><td class="r">${cajasPk||''}</td><td class="r">${kg?kg.toFixed(1):''}</td></tr>`};
      const filas=ps.map(x=>{ seq++; const mix=Array.isArray(x.contenido)&&x.contenido.length;
        return `<tr><td>${seq}</td><td><b>${esc(x.id)}</b>${x.sscc?'<br><small>SSCC '+esc(x.sscc)+'</small>':''}</td><td>${mix?'MIXTO<br>'+x.contenido.map(c=>'<small>'+esc(c.producto)+': '+esc(c.cajas||0)+'</small>').join('<br>'):esc(x.producto||'')+'<br><small>'+esc(x.formato||'')+'</small>'}</td><td>${esc(x.lote||'—')}</td><td>${esc(x.caducidad||'—')}</td><td class="r">${mix?x.contenido.reduce((b,c)=>b+n(c.cajas),0):n(x.cajas)}</td><td>${esc(x.ubicacion||'')}</td><td class="r">${x.peso?esc(x.peso):''}</td><td class="chk">☐</td></tr>`;}).join('');
      const filasPk=pk.map(r=>`<tr class="pk"><td>PK</td><td><b>${esc(r.paletId)}</b></td><td>${esc(r.producto||'')}<br><small>${esc(r.formato||'')}</small></td><td>${esc(r.lote||'—')}</td><td>${esc(r.caducidad||'—')}</td><td class="r">${n(r.cajas)}</td><td colspan="2"><small>Picking (cajas sueltas)</small></td><td class="chk">☐</td></tr>`).join('');
      return {det:`<div class="ped"><b>${k+1}º · Pedido ${esc(s.pedidoNum||s.pedidoId)}</b> · ${esc(s.cliente||'')}${ped?.prodRef||ped?.ref?' · Ref. '+esc(ped.prodRef||ped.ref):''}${ped?.pais?' · '+esc(ped.pais):''}<span style="float:right">${ps.length} palets · ${cajasP+cajasPk} cajas</span></div><table><thead><tr><th>Nº</th><th>Palet</th><th>Producto</th><th>Lote</th><th>Cad.</th><th>Cajas</th><th>Ubic.</th><th>Kg</th><th>✓</th></tr></thead><tbody>${filas}${filasPk}</tbody></table>`};
    });
    const veh=[['Transportista',h.transportista],['Tractora',h.tractora],['Remolque',h.remolque],['Muelle',h.muelle]].map(([a,b])=>`<span><b>${a}:</b> ${esc(b||'—')}</span>`).join('');
    const cuerpo=det?bloques.map(b=>b.det).join(''):`<table><thead><tr><th>Orden</th><th>Pedido</th><th>Cliente</th><th>Producto</th><th>Palets</th><th>Cajas</th><th>Picking</th><th>Kg</th></tr></thead><tbody>${bloques.map(b=>b.res).join('')}<tr class="tot"><td colspan="4">TOTAL</td><td class="r">${totP}</td><td class="r">${totC}</td><td class="r">${totPk||''}</td><td class="r">${totK?totK.toFixed(1):''}</td></tr></tbody></table>`;
    const w=window.open('','_blank','width=960,height=700'); if(!w){toast('⚠️ El navegador bloqueó la ventana de impresión');return;}
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Packing List ${esc(h.cargaNumero||'')}</title><style>body{font-family:Arial,sans-serif;margin:12mm;color:#111;font-size:12px}h1{font-size:20px;margin:0 0 4px}.meta{display:flex;flex-wrap:wrap;gap:6px 18px;margin:6px 0 12px;font-size:12px}table{width:100%;border-collapse:collapse;margin-bottom:10px}th,td{border:1px solid #444;padding:4px 6px;text-align:left;vertical-align:top}th{background:#eee;font-size:11px}.r{text-align:right}.chk{text-align:center;font-size:15px;width:24px}small{color:#444}.ped{background:#f3f3f3;border:1px solid #444;border-bottom:0;padding:5px 7px;margin-top:10px}.ped+table{margin-top:0}.pk td{background:#fff8dc}.tot td{font-weight:800;background:#eee}.firmas{display:flex;gap:30px;margin-top:28px}.firmas div{flex:1;border-top:1px solid #111;padding-top:4px;font-size:11px}tr{page-break-inside:avoid}@media print{@page{size:A4;margin:10mm}body{margin:0}}</style></head><body><h1>PACKING LIST · Carga ${esc(h.cargaNumero||'')} <small>(${det?'detallado':'resumido'})</small></h1><div class="meta"><span><b>Fecha:</b> ${fecha}</span><span><b>Pedidos:</b> ${g.length}</span><span><b>Palets:</b> ${totP}</span><span><b>Cajas:</b> ${totC+totPk}</span>${totK?`<span><b>Kg:</b> ${totK.toFixed(1)}</span>`:''}${veh}</div><div style="margin-bottom:6px;color:#444">Orden de carga: 1º = primero en cargarse.</div>${cuerpo}${det?`<div class="tot" style="font-weight:800;text-align:right">TOTAL: ${totP} palets · ${totC+totPk} cajas${totK?' · '+totK.toFixed(1)+' kg':''}</div>`:''}<div class="firmas"><div>Expedición</div><div>Transportista</div></div><script>setTimeout(()=>window.print(),200)<\/script></body></html>`);
    w.document.close();
  };

  // Packings = documentos de salidas_palets + los reconstruidos desde palets "cargados" (por si faltara el documento de salida).
  function cpSalidasAll(){
    const base=Array.isArray(salidasPalets)?salidasPalets.slice():[]; const have=new Set(base.map(s=>String(s.id)));
    const der=new Map();
    (palets||[]).filter(x=>x.estado==='cargado'&&x.salidaId&&!have.has(String(x.salidaId))).forEach(x=>{
      const sid=String(x.salidaId); if(!der.has(sid)){ const ci=x.cargaInfo||{}; der.set(sid,{id:sid,cargaId:sid.includes('-')?sid.split('-')[0]:sid,cargaNumero:'',ordenCarga:0,pedidoId:x.pedidoId||ci.pedidoId||'',pedidoNum:x.pedidoNum||ci.pedidoNum||'',cliente:x.cliente||'',palets:[],picking:[],estado:'cargado',muelle:ci.muelle||'',transportista:ci.transportista||'',tractora:ci.tractora||'',remolque:ci.remolque||'',createdAt:x.loadedAt||null,confirmedAt:'',_derivado:true}); }
      der.get(sid).palets.push(x.id);
    });
    return base.concat([...der.values()]);
  }
  function cpSiguienteNumCarga(){ return cpSalidasAll().reduce((m,s)=>Math.max(m,parseInt(s.cargaNumero)||0),0)+1; }
  window.cpPalTab=function(t){
    const packs=t==='packs';
    if($('cpPanelPalets'))$('cpPanelPalets').style.display=packs?'none':'';
    if($('cpPanelPacks'))$('cpPanelPacks').style.display=packs?'':'none';
    if($('cpTabPalets'))$('cpTabPalets').className='cp-p-btn'+(packs?'':' primary');
    if($('cpTabPacks'))$('cpTabPacks').className='cp-p-btn'+(packs?' primary':'');
    window._cpPalTab=t; cpRenderSalidas();
  };
  window.cpRenderSalidas = function(){
    const el=$('cpSalidasLista'); const cnt=$('cpPacksCount');
    if(cnt) cnt.textContent=window._salidasErr?'!':(window._salidasListo?(new Set(cpSalidasAll().map(s=>s.cargaId||s.id))).size:'…');
    if(!el) return;
    if(window._salidasErr){ el.innerHTML='<div style="padding:16px;border:1px solid #d33;background:#fdecec;color:#900;border-radius:6px"><b>No se pueden leer los Packing Lists</b><br>'+esc(window._salidasErr)+'<br><small>Si pone "permission-denied", hay que permitir lectura de la colección <code>salidas_palets</code> en las reglas de Firestore.</small></div>'; return; }
    if(!window._salidasListo){ el.innerHTML='<div style="padding:20px;text-align:center;color:#7a8794">Cargando Packing Lists…</div>'; return; }
    const q=up($('cpPalBusca')?.value);
    const ms=s=>createdValue(s.createdAt)||Date.parse(s.confirmedAt||'')||Date.now();
    const rows=cpSalidasAll().filter(s=>!q||[s.id,s.cargaId,s.pedidoNum,s.cliente,s.transportista,s.muelle,s.tractora,s.remolque,(s.palets||[]).join(' ')].join(' ').toUpperCase().includes(q));
    const grupos=new Map(); rows.forEach(s=>{const k=s.cargaId||s.id; if(!grupos.has(k))grupos.set(k,[]); grupos.get(k).push(s);});
    const cargas=[...grupos.values()].map(g=>({g,t:Math.max(...g.map(ms))})).sort((a,b)=>b.t-a.t);
    el.innerHTML=cargas.length?cargas.map(({g,t})=>{
      g.sort((a,b)=>(a.ordenCarga||999)-(b.ordenCarga||999)||ms(a)-ms(b)); const h=g[0], nPal=g.reduce((a,s)=>a+(s.palets||[]).length,0), nCaj=g.reduce((a,s)=>a+(s.picking||[]).reduce((b,r)=>b+(parseInt(r.cajas)||0),0),0);
      const veh=[h.transportista,h.tractora,h.remolque,h.muelle?('Muelle '+h.muelle):''].filter(Boolean).map(esc).join(' · ')||'—';
      return `<details class="cp-p-chip" style="display:block;margin-bottom:6px"><summary style="cursor:pointer"><b>Carga ${esc(h.cargaNumero||'')}</b> · ${new Date(t).toLocaleString('es-ES')} · ${g.length} pedido${g.length===1?'':'s'} · ${nPal} palets${nCaj?' + '+nCaj+' cajas picking':''}<div style="font-size:11px;color:#73808c">${veh}</div></summary><div style="padding:6px 0"><button class="cp-p-btn" onclick="cpImprimirCarga('${esc(h.cargaId||h.id)}','resumen')">🖨 Resumido</button> <button class="cp-p-btn primary" onclick="cpImprimirCarga('${esc(h.cargaId||h.id)}','detalle')">🖨 Detallado</button></div>${g.map((s,k)=>`<div style="padding:5px 0 5px 14px;border-top:1px solid #eee"><b>${k+1}º · ${esc(s.pedidoNum||s.pedidoId||'')}</b> · ${esc(s.cliente||'')}<div style="font-size:11px;color:#73808c">Palets: ${(s.palets||[]).map(esc).join(', ')||'—'}${(s.picking||[]).length?'<br>Picking: '+s.picking.map(r=>esc(r.paletId)+' ('+esc(r.cajas)+' cajas)').join(', '):''}</div></div>`).join('')}</details>`;
    }).join(''):'<div style="padding:20px;text-align:center;color:#7a8794">Aún no hay Packing Lists confirmados.<br><small>Diagnóstico · salidas_palets: '+salidasPalets.length+' · palets cargados: '+palets.filter(x=>x.estado==='cargado').length+' · pedidos cargados: '+pedidos.filter(p=>p.status==='cargado').length+'</small></div>';
  };

  window.cpRenderPalets = function(){
    try{ cpRenderSalidas(); }catch(e){ console.error('cpRenderSalidas',e); }
    const q=up($('cpPalBusca')?.value), st=$('cpPalEstado')?.value||'', pid=$('cpPalPedido')?.value||'';
    cpPedidoOptions('cpPalPedido',true); if($('cpPalPedido')) $('cpPalPedido').value=pid;
    const counts={disponible:0,reservado:0,preparando:0,cargado:0};
    palets.forEach(x=>{if(counts[x.estado]!=null) counts[x.estado]++;});
    $('cpStatDisp').textContent=counts.disponible; $('cpStatRes').textContent=counts.reservado; $('cpStatPrep').textContent=counts.preparando; $('cpStatLoad').textContent=counts.cargado;
    const rows=palets.filter(x=>{
      if(st && x.estado!==st) return false;
      if(pid && String(x.pedidoId)!==String(pid)) return false;
      if(q){ const txt=[x.id,x.pedidoNum,x.cliente,x.producto,x.formato,x.lote,x.ubicacion,x.prodRef,x.sscc].join(' ').toUpperCase(); if(!txt.includes(q)) return false; }
      return true;
    });
    $('cpPalLista').innerHTML=rows.length?`<table><thead><tr><th>Palet</th><th>Pedido / cliente</th><th>Producto</th><th>Contenido</th><th>Lote</th><th>Ubicación</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${rows.map(x=>{
      const mixto=Array.isArray(x.contenido)&&x.contenido.length;
      const cont=mixto ? x.contenido.map(c=>`${esc(c.producto)}: ${esc(c.cajas||0)} cajas`).join('<br>') : [x.cajas?x.cajas+' cajas':'',x.unidades?x.unidades+' '+(x.unidadesTipo||'uds'):'' ].filter(Boolean).join(' · ')||'—';
      const prodLabel=mixto?'MIXTO':(x.producto||'');
      return `<tr><td><span class="cp-p-code">${esc(x.id)}</span>${x.sscc?`<div style="font-size:9px;color:#74808b">SSCC ${esc(x.sscc)}</div>`:''}</td><td>${esc(x.pedidoNum||'STOCK')}<div style="font-size:10px;color:#73808c">${esc(x.cliente||'')}</div></td><td><b>${esc(prodLabel)}</b><div style="font-size:10px;color:#73808c">${esc(x.formato||'')}</div></td><td>${cont}</td><td>${esc(x.lote||'—')}</td><td>${esc(x.ubicacion||'—')}</td><td><span class="cp-p-status ${esc(x.estado||'')}">${esc(palletStatusLabel(x.estado))}</span></td><td><button class="cp-p-btn" onclick="cpImprimirEtiqueta('${esc(x.id)}')">🏷️</button> <button class="cp-p-btn" onclick="cpCambiarUbicacion('${esc(x.id)}')">📍</button> <button class="cp-p-btn" onclick="cpVerPalet('${esc(x.id)}')">Ver</button> <button class="cp-p-btn" onclick="cpEditarPalet('${esc(x.id)}')">✏️ Editar</button> <button class="cp-p-btn danger" onclick="cpBorrarPalet('${esc(x.id)}')">🗑️ Borrar</button></td></tr>`;
    }).join('')}</tbody></table>`:'<div style="padding:35px;text-align:center;color:#7a8794">No hay palets que coincidan con los filtros.</div>';
  };

  function cpPedidoLineaOptions(p){
    const lines=[{idx:'main',producto:p?.producto||'',formato:p?.formato||'',ref:p?.prodRef||p?.ref||'',pais:p?.pais||''},...(p?.productosExtra||[]).map((x,i)=>({idx:String(i),producto:x.producto||'',formato:x.formato||'',ref:x.prodRef||'',pais:x.pais||p?.pais||''}))];
    return lines.filter(x=>x.producto||x.formato);
  }

  function cpRenderMixto(p){
    const box=$('cpf-mezcla-list'), mixed=!!$('cpf-mixto')?.checked;
    if(!box)return;
    if(!mixed || !p){box.style.display='none';box.innerHTML='';return;}
    const lines=cpPedidoLineaOptions(p);
    box.style.display='block';
    box.innerHTML='<div style="font-weight:800;margin-bottom:6px">Contenido del palet mixto</div><div style="font-size:11px;color:var(--t3);margin-bottom:8px">Indica las cajas de cada artículo que irán físicamente en este único palet.</div>'+lines.map(l=>{
      const source=l.idx==='main'?p:(p.productosExtra||[])[parseInt(l.idx)];
      const pendiente=Math.max((parseInt(source?.cajas)||0)-(parseInt(source?.cajasCargados)||0),0);
      return '<div class="cpf-mezcla-line" data-idx="'+esc(l.idx)+'" data-producto="'+esc(up(l.producto))+'" data-formato="'+esc(up(l.formato))+'" data-ref="'+esc(up(l.ref))+'" data-pais="'+esc(up(l.pais))+'" style="display:grid;grid-template-columns:minmax(0,1fr) 110px;gap:8px;align-items:center;padding:7px 0;border-bottom:1px dashed var(--border2)"><div><b>'+esc(up(l.producto))+'</b><div style="font-size:10px;color:var(--t3)">'+esc(up(l.formato)||'Sin formato')+'</div></div><label style="font-size:11px">Cajas<input class="cpf-mezcla-cajas" type="number" min="0" step="1" value="'+(pendiente||0)+'"></label></div>';
    }).join('');
  }
  window.cpMixtoChange=function(){ cpRenderMixto(pedidoById($('cpf-pedido')?.value)); };
  function cpApplyPedidoSource(){
    const p=pedidoById($('cpf-pedido')?.value);
    const line=cpPedidoLineaOptions(p)[0];
    const sourceLine=line?.idx==='main'?p:(p?.productosExtra||[])[parseInt(line?.idx)];
    if(!p){
      ['cpf-cliente','cpf-ref','cpf-pais','cpf-lote','cpf-cad'].forEach(id=>{if($(id))$(id).value='';});
      if($('cpf-producto')) $('cpf-producto').readOnly=false;
      if($('cpf-formato')) $('cpf-formato').readOnly=false;
      return;
    }
    $('cpf-cliente').value=up(p.grupo||'');
    cpRenderMixto(p);
    $('cpf-producto').value=up(line?.producto||p.producto||'');
    $('cpf-formato').value=up(line?.formato||p.formato||'');
    $('cpf-ref').value=up(line?.ref||p.ref||'');
    $('cpf-pais').value=up(line?.pais||p.pais||'');
    // Si el pedido está asignado a una producción, copiar sus datos de trazabilidad.
    // Los campos quedan editables por si el palet físico cambia de lote o caducidad.
    const prodRef=line?.ref && /^P-/i.test(line.ref) ? line.ref : (line?.idx==='main' ? p.prodRef||'' : '');
    const prod=prodRef ? (window.producciones||[]).find(x=>String(x.numProd||'')===String(prodRef)) : null;
    $('cpf-lote').value=prod?.lote||'';
    $('cpf-cad').value=prod?.caducidad||'';
    // Cantidades y datos logísticos se copian del pedido, pero se dejan editables para ajustar el palet físico.
    $('cpf-cajas').value=parseInt(sourceLine?.cajas)||0;
    $('cpf-cpp').value=parseInt(sourceLine?.cpp||sourceLine?.cajasPorPalet)||0;
    $('cpf-unidades').value=parseInt(sourceLine?.totalUnidades)||((parseInt(sourceLine?.cajas)||0)*(parseInt(sourceLine?.udsCaja)||0))||0;
    $('cpf-utipo').value=up(sourceLine?.unidadesTipo||'UDS')||'UDS';
    // Producto y formato vienen del pedido y no se pueden alterar por accidente; cantidades sí.
    $('cpf-producto').readOnly=true; $('cpf-formato').readOnly=true;
  }
  window.cpNuevoPalet=function(){
    cpEditPaletId='';
    cpPedidoOptions('cpf-pedido',true);
    ['cpf-pedido','cpf-cliente','cpf-producto','cpf-formato','cpf-ref','cpf-pais','cpf-lote','cpf-cad','cpf-ubicacion','cpf-cajas','cpf-cpp','cpf-unidades','cpf-sscc','cpf-peso','cpf-notas'].forEach(id=>{if($(id)) $(id).value='';});
    if($('cpf-mixto')) $('cpf-mixto').checked=false;
    cpRenderMixto(null);
    if($('cpf-producto')) $('cpf-producto').readOnly=false; if($('cpf-formato')) $('cpf-formato').readOnly=false;
    $('cpf-tipo').value='TERMINADO'; $('cpf-utipo').value='UDS'; $('cpPalFormTitle').textContent='Nuevo palet'; if($('cpf-save-btn'))$('cpf-save-btn').textContent='Guardar y generar etiqueta';
    $('cpPalFormModal').classList.add('open'); setTimeout(()=>$('cpf-pedido')?.focus(),100);
  };
  window.cpCerrarPalForm=function(){ $('cpPalFormModal').classList.remove('open'); cpEditPaletId=''; };
  window.cpPedidoChange=function(){ cpApplyPedidoSource(); cpRenderMixto(pedidoById($('cpf-pedido')?.value)); };

  // Generación de identificadores dentro de la misma transacción que crea el palet.
  // Así una validación fallida no consume numeración y dos terminales no pueden obtener el mismo ID.
  async function withPalletIds(count, writer){
    const nCount=Math.max(0,parseInt(count)||0);
    if(!nCount) return writer(null,[]);
    return db.runTransaction(async tx=>{
      const counterRef=db.collection('config').doc('palets_counter');
      const snap=await tx.get(counterRef);
      const start=snap.exists?(parseInt(snap.data().next)||1):1;
      const ids=Array.from({length:nCount},(_,i)=>'P'+String(start+i).padStart(8,'0'));
      await writer(tx,ids);
      tx.set(counterRef,{next:start+nCount,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
      return ids;
    });
  }
  async function addPallet(data){
    return withPalletIds(0,async()=>{
      await colPalets.doc(data.id).set(data);
      await colMovLogistica.doc().set({paletId:data.id,accion:'creado',estado:data.estado,ts:Date.now(),fecha:nowISO(),detalle:'Alta de unidad logística',pedidoId:data.pedidoId||'',pedidoNum:data.pedidoNum||''});
    });
  }

  let cpUbicacionId='';
  window.cpCambiarUbicacion=function(id){
    const x=palets.find(p=>String(p.id)===String(id)); if(!x)return;
    if(x.estado==='cargado'){toast('⛔ Un palet ya cargado no puede cambiar de ubicación');return;}
    cpUbicacionId=x.id; $('cpUbicInfo').textContent='Palet '+x.id+' · Ubicación actual: '+(x.ubicacion||'SIN UBICACIÓN'); $('cpUbicInput').value=x.ubicacion||''; $('cpUbicAviso').style.display='none'; $('cpUbicModal').classList.add('open');
    setTimeout(()=>{$('cpUbicInput')?.focus();$('cpUbicInput')?.select();},80);
  };
  window.cpCerrarUbicacion=function(){cpUbicacionId='';$('cpUbicModal')?.classList.remove('open');};
  window.cpConfirmarUbicacion=async function(){
    const id=cpUbicacionId; const x=palets.find(p=>String(p.id)===String(id)); if(!x)return;
    if(x.estado==='cargado'){cpCerrarUbicacion();toast('⛔ Un palet ya cargado no puede cambiar de ubicación');return;}
    const u=up($('cpUbicInput').value); if(!u){$('cpUbicAviso').textContent='Indica una ubicación.';$('cpUbicAviso').style.display='block';return;}
    try{await db.runTransaction(async tx=>{const ref=colPalets.doc(x.id),snap=await tx.get(ref);if(!snap.exists)throw new Error('El palet ya no existe');const cur=snap.data();if(cur.estado==='cargado')throw new Error('El palet ya está cargado');tx.update(ref,{ubicacion:u,ubicacionUpdatedAt:firebase.firestore.FieldValue.serverTimestamp()});tx.set(colMovLogistica.doc(),{paletId:x.id,accion:'ubicado',estado:cur.estado,ts:Date.now(),fecha:nowISO(),ubicacionAnterior:cur.ubicacion||'',ubicacion:u,pedidoId:cur.pedidoId||'',pedidoNum:cur.pedidoNum||''});});cpCerrarUbicacion();cpRenderPalets();toast('📍 '+x.id+' → '+u);}catch(e){console.error(e);toast('❌ No se pudo cambiar la ubicación: '+(e.message||e));}
  };

  function cpPedidoLineas(p){ return [{idx:'main',producto:p.producto||'',formato:p.formato||'',uds:parseInt(p.uds)||0,cajas:parseInt(p.cajas)||0},...(p.productosExtra||[]).map((pe,i)=>({idx:String(i),producto:pe.producto||'',formato:pe.formato||'',uds:parseInt(pe.uds)||0,cajas:parseInt(pe.cajas)||0}))].filter(x=>x.producto||x.uds||x.cajas); }
  function cpPaletEncajaEnPedido(x,p){
    const lineas=cpPedidoLineas(p);
    if(Array.isArray(x.contenido) && x.contenido.length){
      return x.contenido.every(c=>lineas.some(l=>up(l.producto)===up(c.producto) && (!c.formato || !l.formato || up(c.formato)===up(l.formato))));
    }
    const prod=up(x.producto), fmt=up(x.formato); return lineas.some(l=>up(l.producto)===prod && (!fmt || !up(l.formato) || up(l.formato)===fmt));
  }
  function cpPedidoTotalPalets(p){ return cpPedidoLineas(p).reduce((a,l)=>a+(l.uds||0),0); }
  function cpPedidoTotalCajas(p){ return cpPedidoLineas(p).reduce((a,l)=>a+(l.cajas||0),0); }
  function cpPedidoPaletsYaCargados(p){ return palets.filter(x=>String(x.pedidoId)===String(p.id) && x.estado==='cargado').length; }
  function cpPedidoCajasPicking(p){ return (p.pickingCajasPreparadas||0); }
  function cpPaletsCompatibles(p){ return palets.filter(x=>{ const own=String(x.pedidoId)===String(p.id); const reserva=(x.reservasCajas&&parseInt(x.reservasCajas[p.id]))||0; const reservadoOtro=x.estado==='reservado' && x.reservaPedidoId && !own && String(x.reservaPedidoId)!==String(p.id); if(reservadoOtro)return false; if(!['disponible','reservado','preparando'].includes(x.estado))return false; return (( !x.pedidoId && cpPaletEncajaEnPedido(x,p)) || own || reserva>0) && cpPaletEncajaEnPedido(x,p); }); }
  function cpFifoDate(x){
    const vals=[x?.entradaAt,x?.entradaIso,x?.producedAt,x?.producedIso,x?.createdAt,x?.createdIso,x?.fechaEntrada,x?.fecha];
    for(const v of vals){
      if(!v) continue;
      let d=null;
      if(typeof v?.toDate==='function') d=v.toDate();
      else if(v instanceof Date) d=v;
      else if(typeof v==='number') d=new Date(v);
      else d=new Date(v);
      if(d && !isNaN(d.getTime())) return d;
    }
    return new Date(8640000000000000);
  }
  function cpOrdenarFIFO(arr){ return [...arr].sort((a,b)=>{const d=cpFifoDate(a)-cpFifoDate(b);if(d)return d;return String(a.id).localeCompare(String(b.id),undefined,{numeric:true});}); }
  function cpPickingPlanFIFO(p){
    const pendiente=cpPickingPendiente(p);
    if(!pendiente) return [];
    const compatibles=cpOrdenarFIFO(_palletsForOrder(p).filter(x=>!x.contenido?.length && x.estado!=='reservado' && (()=>{const reserved=(x.reservasCajas&&Object.entries(x.reservasCajas).filter(([k])=>String(k)!==String(p.id)).reduce((a,[,v])=>a+(parseInt(v)||0),0))||0; return !salidaPicking.some(r=>String(r.paletId)===String(x.id)) && ((parseInt(x.cajas)||0)-reserved)>0;})()));
    let rest=pendiente; const plan=[];
    for(const x of compatibles){ if(rest<=0)break; const reservedOther=(x.reservasCajas&&Object.entries(x.reservasCajas).filter(([k])=>String(k)!==String(p.id)).reduce((a,[,v])=>a+(parseInt(v)||0),0))||0; const cajas=Math.min(rest,Math.max((parseInt(x.cajas)||0)-reservedOther,0)); if(cajas>0){plan.push({x,cajas});rest-=cajas;} }
    return plan;
  }
  function cpModoSalidaChange(){
    const picking=$('cps-modo')?.value==='picking';
    const scan=$('cps-scan'); if(scan) scan.placeholder=picking?'Escanea el palet origen para hacer picking':'Escanea el palet completo';
    const btn=document.querySelector('#cpSalidaModal .cp-p-scanrow .cp-p-btn:not(.primary)'); if(btn) btn.textContent=picking?'Proponer FIFO':'Cargar palets';
    const p=pedidoById($('cps-pedido')?.value); if(p && picking) cpRenderPicking();
  }
  function cpPickingPendiente(p){ return Math.max(cpPedidoTotalCajas(p)-cpPedidoCajasPicking(p),0); }
  function cpPickingTotalLocal(){ return salidaPicking.reduce((a,r)=>a+(parseInt(r.cajas)||0),0); }
  function cpPickingProductoTotal(p,producto,formato){
    return cpPedidoLineas(p).filter(l=>up(l.producto)===up(producto)&&(!formato||!l.formato||up(l.formato)===up(formato))).reduce((a,l)=>a+(l.cajas||0),0);
  }
  function cpPickingProductoPreparado(p,producto,formato){
    return (p.pickingMovimientos||[]).filter(m=>up(m.producto)===up(producto)&&(!formato||!m.formato||up(m.formato)===up(formato))).reduce((a,m)=>a+(parseInt(m.cajas)||0),0);
  }

  window.cpEditarPalet=function(id){
    const x=palets.find(p=>String(p.id)===String(id)); if(!x)return;
    if(x.estado!=='disponible'||x.salidaId){toast('⛔ Solo se pueden editar palets disponibles y no cargados');return;}
    cpEditPaletId=String(x.id); cpPedidoOptions('cpf-pedido',true); $('cpf-pedido').value=x.pedidoId||''; cpApplyPedidoSource();
    $('cpf-mixto').checked=!!x.mixed||Array.isArray(x.contenido)&&x.contenido.length>0; cpRenderMixto(pedidoById(x.pedidoId));
    if(Array.isArray(x.contenido)&&x.contenido.length) document.querySelectorAll('#cpf-mezcla-list .cpf-mezcla-line').forEach(el=>{const c=x.contenido.find(v=>up(v.producto)===up(el.dataset.producto)&&(!v.formato||up(v.formato)===up(el.dataset.formato))); if(c)el.querySelector('.cpf-mezcla-cajas').value=parseInt(c.cajas)||0;});
    $('cpf-producto').value=x.producto||''; $('cpf-formato').value=x.formato||''; $('cpf-ref').value=x.referencia||x.ref||''; $('cpf-pais').value=x.pais||''; $('cpf-tipo').value=x.tipo||'TERMINADO'; $('cpf-lote').value=x.lote||''; $('cpf-cad').value=x.caducidad||''; $('cpf-ubicacion').value=x.ubicacion||''; $('cpf-cajas').value=parseInt(x.cajas)||0; $('cpf-cpp').value=parseInt(x.cajasPorPalet)||0; $('cpf-unidades').value=parseInt(x.unidades)||0; $('cpf-utipo').value=x.unidadesTipo||'UDS'; $('cpf-sscc').value=x.sscc||''; $('cpf-peso').value=parseFloat(x.pesoKg)||0; $('cpf-notas').value=x.notas||'';
    $('cpPalFormTitle').textContent='Editar palet '+x.id; if($('cpf-save-btn'))$('cpf-save-btn').textContent='Guardar cambios'; $('cpPalFormModal').classList.add('open');
  };
  window.cpBorrarPalet=function(id){
    const x=palets.find(p=>String(p.id)===String(id)); if(!x)return;
    if(x.estado!=='disponible'||x.salidaId||Object.keys(x.reservasCajas||{}).length){toast('⛔ Solo se pueden borrar palets disponibles, sin reservas ni cargas');return;}
    confirm2('🗑️','Borrar palet','Se eliminará '+x.id+' de forma permanente. Esta acción no se puede deshacer.','Borrar','red',async()=>{try{await db.runTransaction(async tx=>{const ref=colPalets.doc(x.id),snap=await tx.get(ref);if(!snap.exists)throw new Error('El palet ya no existe');const cur=snap.data();if(cur.estado!=='disponible'||cur.salidaId||Object.keys(cur.reservasCajas||{}).length)throw new Error('El palet ya no está disponible para borrar');tx.delete(ref);tx.set(colMovLogistica.doc(),{paletId:x.id,accion:'eliminado',estado:'eliminado',ts:Date.now(),fecha:nowISO(),pedidoId:cur.pedidoId||'',pedidoNum:cur.pedidoNum||'',detalle:'Borrado manual del palet'});});cpRenderPalets();toast('✅ Palet '+x.id+' borrado');}catch(e){console.error(e);toast('❌ No se pudo borrar el palet: '+(e.message||e));}});
  };
  window.cpGuardarPalet=async function(){
    const p=pedidoById($('cpf-pedido').value), mixed=!!$('cpf-mixto')?.checked && !!p;
    let contenido=[];
    if(mixed){
      document.querySelectorAll('#cpf-mezcla-list .cpf-mezcla-line').forEach(el=>{
        const cajas=parseInt(el.querySelector('.cpf-mezcla-cajas')?.value)||0;
        if(cajas>0) contenido.push({producto:up(el.dataset.producto),formato:up(el.dataset.formato),referencia:up(el.dataset.ref),pais:up(el.dataset.pais),cajas});
      });
      if(!contenido.length){toast('⚠️ Añade al menos un artículo y sus cajas');return;}
    }
    const producto=mixed?'MIXTO':up($('cpf-producto').value); if(!producto){toast('⚠️ Indica el producto');return;}
    const sscc=String($('cpf-sscc').value||'').replace(/\D/g,''); if(sscc && sscc.length!==18){toast('⚠️ El SSCC debe tener 18 dígitos');return;}
    const cajas=mixed?contenido.reduce((a,c)=>a+c.cajas,0):(parseInt($('cpf-cajas').value)||0), unidades=mixed?1:(parseInt($('cpf-unidades').value)||0), cpp=parseInt($('cpf-cpp').value)||0;
    const base={pedidoId:p?.id||'',pedidoNum:p?.num||'',cliente:up(p?.grupo||''),producto,formato:mixed?'MIXTO':up($('cpf-formato').value),referencia:up($('cpf-ref').value),prodRef:up(p?.prodRef||$('cpf-ref').value||''),pais:up($('cpf-pais').value),tipo:up($('cpf-tipo').value),lote:up($('cpf-lote').value),caducidad:$('cpf-cad').value||'',ubicacion:up($('cpf-ubicacion').value),cajas,cajasPorPalet:cpp,unidades,unidadesTipo:up($('cpf-utipo').value)||'UDS',pesoKg:parseFloat($('cpf-peso').value)||0,sscc,notas:up($('cpf-notas').value),...(mixed?{contenido,mixed:true}:{}),estado:'disponible',source:'manual',createdAt:firebase.firestore.FieldValue.serverTimestamp(),createdIso:nowISO()};
    if(p) base.pedidoCliente=up(p.grupo||''); let id=cpEditPaletId||'';
    try{
      if(id){
        const ref=colPalets.doc(id); await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)throw new Error('El palet ya no existe');const cur=snap.data();if(cur.estado!=='disponible'||cur.salidaId)throw new Error('El palet ya no está disponible para editar');const data={...base,id,estado:cur.estado,source:cur.source||'manual',createdAt:cur.createdAt||firebase.firestore.FieldValue.serverTimestamp(),createdIso:cur.createdIso||nowISO(),updatedAt:firebase.firestore.FieldValue.serverTimestamp(),mixed:!!mixed,contenido:mixed?contenido:[]};tx.set(ref,data);tx.set(colMovLogistica.doc(),{paletId:id,accion:'editado',estado:cur.estado,ts:Date.now(),fecha:nowISO(),detalle:'Modificación manual del palet',pedidoId:data.pedidoId||'',pedidoNum:data.pedidoNum||''});});
        cpCerrarPalForm(); cpRenderPalets(); toast('✅ Palet '+id+' actualizado');
      }else{
        await withPalletIds(1,async(tx,ids)=>{ id=ids[0]; const data={...base,id}; tx.set(colPalets.doc(id),data); tx.set(colMovLogistica.doc(),{paletId:id,accion:'creado',estado:'disponible',ts:Date.now(),fecha:nowISO(),detalle:'Alta de unidad logística',pedidoId:data.pedidoId||'',pedidoNum:data.pedidoNum||''}); });
        cpCerrarPalForm(); cpRenderPalets(); toast('✅ Palet '+id+' creado'); setTimeout(()=>cpImprimirEtiqueta(id),250);
      }
    }catch(e){ console.error(e); toast('❌ No se pudo guardar el palet: '+(e.message||e)); }
  };

  window.cpVerPalet=function(id){ const x=palets.find(p=>String(p.id)===String(id)); if(!x)return; const contenido=Array.isArray(x.contenido)&&x.contenido.length?x.contenido.map(c=>`${c.producto}: ${c.cajas||0} cajas`).join('\n'):`${x.cajas||0} cajas · ${x.unidades||0} ${x.unidadesTipo||'uds'}`; const msg=[`PALET ${x.id}`,`Pedido: ${x.pedidoNum||'STOCK'}`,`Cliente: ${x.cliente||'—'}`,`Producto: ${x.mixed?'MIXTO':(x.producto||'—')}`,`Formato: ${x.formato||'—'}`,`Lote: ${x.lote||'—'}`,`Contenido: ${contenido}`,`Estado: ${palletStatusLabel(x.estado)}`,`Ubicación: ${x.ubicacion||'—'}`].join('\n'); confirm2('▣','Detalle del palet',msg,'Imprimir etiqueta','blue',()=>cpImprimirEtiqueta(id)); };

  function cpBarcodeSvg(value){ if(typeof JsBarcode!=='function') return ''; const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); JsBarcode(svg,String(value||''),{format:'CODE128',displayValue:false,height:70,width:2,margin:0}); return svg.outerHTML; }
  window.cpImprimirEtiqueta=function(id){ const x=palets.find(p=>String(p.id)===String(id)); if(!x)return; const contenidoTxt=Array.isArray(x.contenido)&&x.contenido.length?'<b>Contenido mixto:</b><br>'+x.contenido.map(c=>esc(c.producto)+' · '+esc(c.cajas||0)+' cajas').join('<br>'):'Contenido: '+esc(x.cajas||0)+' cajas · '+esc(x.unidades||0)+' '+esc(x.unidadesTipo||'UDS'); const barcodeSvg=cpBarcodeSvg(x.id); if(!barcodeSvg){toast('⚠️ No se pudo generar el código de barras');return;} const w=window.open('','_blank','width=520,height=650'); if(!w){toast('⚠️ El navegador bloqueó la ventana de impresión');return;} w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(x.id)}</title><style>body{font-family:Arial,sans-serif;margin:0;padding:12mm;width:90mm;color:#111}h1{font-size:26px;margin:0 0 3mm}h2{font-size:14px;margin:2mm 0}.line{border-top:1px solid #111;margin:3mm 0}.meta{font-size:11px;line-height:1.55}.barcode{width:86mm;height:24mm}.foot{font-size:9px;color:#555;margin-top:3mm}@media print{@page{size:100mm 150mm;margin:0}body{padding:7mm;width:auto}}</style></head><body><h1>${esc(x.id)}</h1><div class="meta"><b>${esc(x.producto||'')}</b> · ${esc(x.formato||'')}<br>Pedido: <b>${esc(x.pedidoNum||'STOCK')}</b> · ${esc(x.cliente||'')}<br>Lote: ${esc(x.lote||'—')} · Cad.: ${esc(x.caducidad||'—')}<br>${contenidoTxt}<br>Ubicación: ${esc(x.ubicacion||'—')}</div><div class="line"></div>${barcodeSvg.replace('<svg ','<svg class="barcode" ')}<div style="text-align:center;font:800 15px monospace">${esc(x.id)}</div><div class="foot">CARGAS PRO · UNIDAD LOGÍSTICA · No reutilizar este identificador</div><script>setTimeout(()=>window.print(),150)<\/script></body></html>`); w.document.close(); };

  function _palletsForOrder(p){ return cpPaletsCompatibles(p); }
  function cpRenderPedidosCarga(){
    const box=$('cps-pedidos-carga'); if(!box)return;
    box.innerHTML=salidaPedidos.length ? salidaPedidos.map(id=>{const p=pedidoById(id), active=String(id)===String(salidaPedidoActivo); const pos=salidaPedidos.indexOf(id); return `<div class="cp-p-chip" style="display:flex;align-items:center;gap:8px;${active?'border-color:#F0B400;':''}"><b style="min-width:22px;text-align:center" title="Orden de carga">${pos+1}º</b><button type="button" class="cp-p-btn" ${pos===0?'disabled':''} onclick="cpMoverPedidoSalida('${esc(id)}',-1)">▲</button><button type="button" class="cp-p-btn" ${pos===salidaPedidos.length-1?'disabled':''} onclick="cpMoverPedidoSalida('${esc(id)}',1)">▼</button><button type="button" class="cp-p-btn" onclick="cpActivarPedidoSalida('${esc(id)}')">${active?'▶ ':''}${esc(pedidoTxt(p))}</button><span style="flex:1;color:#77838e">${esc(p?.producto||'')} · ${esc(p?.productosExtra?.length?((p.productosExtra.length+1)+' artículos'):'1 artículo')}</span><button type="button" class="cp-p-btn danger" onclick="cpQuitarPedidoSalida('${esc(id)}')">Quitar</button></div>`;}).join(''):'<div style="padding:10px;color:#77838e">Añade uno o varios pedidos para preparar la carga del camión.</div>';
  }
  window.cpAnadirPedidoSalida=function(){ const id=$('cps-pedido-add')?.value; if(!id)return; if(!salidaPedidos.some(x=>String(x)===String(id))){salidaPedidos.push(String(id));salidaPorPedido.set(String(id),{palets:[],picking:[]});} salidaPedidoActivo=String(id); cpCargarPreparacion(id); $('cps-pedido').value=id; cpRenderPedidosCarga(); cpSalidaPedidoChange(true); $('cps-pedido-add').value=''; };
  window.cpMoverPedidoSalida=function(id,d){ cpGuardarPreparacionActiva(); const i=salidaPedidos.indexOf(String(id)), j=i+d; if(i<0||j<0||j>=salidaPedidos.length)return; [salidaPedidos[i],salidaPedidos[j]]=[salidaPedidos[j],salidaPedidos[i]]; cpRenderPedidosCarga(); };
  window.cpMoverPaletSalida=function(i,d){ const j=i+d; if(j<0||j>=salidaPalets.length)return; [salidaPalets[i],salidaPalets[j]]=[salidaPalets[j],salidaPalets[i]]; cpRenderSalidaList(); };
  window.cpActivarPedidoSalida=function(id){ cpGuardarPreparacionActiva(); salidaPedidoActivo=String(id); cpCargarPreparacion(id); $('cps-pedido').value=id; cpRenderPedidosCarga(); cpSalidaPedidoChange(true); };
  window.cpQuitarPedidoSalida=function(id){ cpGuardarPreparacionActiva(); salidaPedidos=salidaPedidos.filter(x=>String(x)!==String(id)); salidaPorPedido.delete(String(id)); if(String(salidaPedidoActivo)===String(id)){salidaPedidoActivo=salidaPedidos[0]||'';cpCargarPreparacion(salidaPedidoActivo);$('cps-pedido').value=salidaPedidoActivo;} cpRenderPedidosCarga(); cpSalidaPedidoChange(true); };
  window.cpNuevaSalida=function(){ salidaPalets=[]; salidaPicking=[]; salidaPedidos=[]; salidaPedidoActivo=''; salidaPorPedido=new Map(); salidaCargaId='C'+Date.now().toString(36).toUpperCase(); cpPedidoOptions('cps-pedido-add',false); $('cps-pedido').innerHTML='<option value="">Añade un pedido</option>'; ['cps-cliente','cps-muelle','cps-trans','cps-tractora','cps-remolque'].forEach(id=>$(id).value=''); if($('cps-carga-num'))$('cps-carga-num').value=String(cpSiguienteNumCarga()); if($('cps-modo'))$('cps-modo').value='palet'; cpRenderPedidosCarga(); $('cps-info').textContent='Añade uno o varios pedidos para preparar la carga.'; $('cps-lista').innerHTML=''; $('cps-picking').innerHTML=''; $('cpSalidaModal').classList.add('open'); cpModoSalidaChange(); setTimeout(()=>$('cps-pedido-add')?.focus(),100); };
  window.cpCerrarSalida=function(){ $('cpSalidaModal').classList.remove('open'); salidaPalets=[]; salidaPicking=[]; };
  window.cpSalidaPedidoChange=function(fromState){
    if(!fromState) cpGuardarPreparacionActiva();
    const id=$('cps-pedido').value; if(id && !salidaPedidos.some(x=>String(x)===String(id))) salidaPedidos.push(String(id));
    salidaPedidoActivo=String(id||''); cpCargarPreparacion(salidaPedidoActivo); cpRenderPedidosCarga();
    const p=pedidoById(id); $('cps-cliente').value=up(p?.grupo||'');
    if(p){ const av=_palletsForOrder(p); const totalP=cpPedidoTotalPalets(p), cargP=cpPedidoPaletsYaCargados(p), totalC=cpPedidoTotalCajas(p), prepC=cpPedidoCajasPicking(p); $('cps-info').innerHTML=`<b>Pedido ${esc(p.num||p.id)}</b> · ${esc(p.grupo||'')}<br><b>Palets:</b> ${cargP}/${totalP} completos · <b>Picking:</b> ${prepC}/${totalC} cajas · ${av.length} palets compatibles.`; } else $('cps-info').textContent='Añade un pedido.'; cpRenderSalidaList(); cpRenderPicking();
  };
  function cpRenderSalidaList(){
    const all=salidaPalets.map(id=>palets.find(x=>x.id===id)).filter(Boolean);
    $('cps-lista').innerHTML=all.length?'<div style="font-weight:800;margin:8px 0 5px">📦 Palets completos seleccionados</div>'+all.map((x,i)=>`<div class="cp-p-chip"><span><b>${i+1}º</b> <button class="cp-p-btn" ${i===0?'disabled':''} onclick="cpMoverPaletSalida(${i},-1)">▲</button><button class="cp-p-btn" ${i===all.length-1?'disabled':''} onclick="cpMoverPaletSalida(${i},1)">▼</button> <b class="cp-p-code">${esc(x.id)}</b> · ${esc(x.producto||'')} · ${esc(x.cajas||0)} cajas · lote ${esc(x.lote||'—')}</span><button class="cp-p-btn danger" onclick="cpQuitarSalida('${esc(x.id)}')">Quitar</button></div>`).join(''):'<div style="padding:12px;text-align:center;color:#77838e">No hay palets completos seleccionados.</div>';
  }
  function cpRenderPicking(){
    const el=$('cps-picking'); if(!el)return;
    const p=pedidoById($('cps-pedido')?.value);
    const pendiente=p?cpPickingPendiente(p):0;
    const plan=p?cpPickingPlanFIFO(p):[];
    if(!salidaPicking.length){
      if(!p){el.innerHTML='<div style="padding:12px;text-align:center;color:#77838e">Selecciona un pedido.</div>';return;}
      const disponible=plan.reduce((a,r)=>a+r.cajas,0);
      el.innerHTML='<div style="font-weight:800;margin:8px 0 5px">🧺 Picking · propuesta FIFO</div>'+
        `<div class="cp-p-note" style="margin-bottom:7px"><b>Pendiente:</b> ${pendiente} cajas · <b>Stock FIFO localizado:</b> ${disponible} cajas</div>`+
        (plan.length?plan.map((r,i)=>`<div class="cp-p-chip"><span><b class="cp-p-code">${esc(r.x.id)}</b> · ${esc(r.x.producto||'')} · lote ${esc(r.x.lote||'—')} · entrada ${esc(cpFifoDate(r.x).toLocaleDateString('es-ES'))} · disponible ${esc(r.x.cajas||0)} cajas</span><b>${r.cajas} cajas</b></div>`).join(''):'<div style="padding:12px;text-align:center;color:#b3261e">No hay stock suficiente para completar el picking.</div>')+
        `<div class="cp-p-note" style="margin-top:7px">🥇 Orden FIFO: se propone consumir siempre el palet más antiguo compatible primero.</div>`;
      return;
    }
    el.innerHTML='<div style="font-weight:800;margin:8px 0 5px">🧺 Picking · cajas a extraer</div>'+salidaPicking.map((r,i)=>{const x=palets.find(p=>String(p.id)===String(r.paletId));return `<div class="cp-p-chip" style="display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center"><span><b class="cp-p-code">${esc(r.paletId)}</b> · ${esc(x?.producto||r.producto||'')} · lote ${esc(x?.lote||r.lote||'—')} · FIFO ${esc(cpFifoDate(x).toLocaleDateString('es-ES'))} · disponible ${esc(x?.cajas||0)} cajas</span><input type="number" min="1" max="${Math.max(parseInt(x?.cajas)||0,1)}" value="${parseInt(r.cajas)||0}" style="width:90px" onchange="cpPickingCantidad(${i},this.value)" inputmode="numeric"><button class="cp-p-btn danger" onclick="cpQuitarPicking(${i})">Quitar</button></div>`}).join('')+`<div class="cp-p-note" style="margin-top:7px"><b>Picking en esta preparación:</b> ${cpPickingTotalLocal()} / ${pendiente} cajas</div>`;
  }
  window.cpPickingCantidad=function(i,v){ const n=Math.max(0,parseInt(v)||0); const r=salidaPicking[i]; if(!r)return; const x=palets.find(p=>String(p.id)===String(r.paletId)); const max=parseInt(x?.cajas)||0; r.cajas=Math.min(n,max); cpRenderPicking(); };
  window.cpQuitarSalida=function(id){ salidaPalets=salidaPalets.filter(x=>String(x)!==String(id)); cpRenderSalidaList(); };
  window.cpQuitarPicking=function(i){ salidaPicking.splice(i,1); cpRenderPicking(); };
  function cpCadDate(x){const v=String(x?.caducidad||'').trim();if(!v)return null;const d=new Date(v+'T00:00:00');return isNaN(d.getTime())?null:d;}
  function cpFefoCompatibles(p){return _palletsForOrder(p).filter(x=>!salidaPalets.includes(x.id)).filter(x=>cpCadDate(x));}
  function cpFefoAviso(x,p){const d=cpCadDate(x);if(!d)return '';const otros=cpFefoCompatibles(p);if(!otros.length)return '';const earliest=otros.reduce((a,b)=>cpCadDate(a)<cpCadDate(b)?a:b);if(cpCadDate(earliest)<d)return '⚠️ AVISO FEFO: este palet caduca el '+d.toLocaleDateString('es-ES')+'. Hay otro palet compatible que caduca antes ('+cpCadDate(earliest).toLocaleDateString('es-ES')+', '+earliest.id+').';return '';}
  window.cpEscanearEntrada=function(raw){
    const code=String(raw||'').trim().toUpperCase(); if(!code)return; const x=palets.find(p=>String(p.id).toUpperCase()===code||String(p.sscc||'').toUpperCase()===code); if(!x){toast('❌ Palet no encontrado: '+code);return;}
    const p=pedidoById($('cps-pedido').value); if(!p){toast('⚠️ Selecciona primero el pedido');return;}
    if(x.pedidoId&&String(x.pedidoId)!==String(p.id)){toast('⛔ Este palet pertenece a '+(x.pedidoNum||'STOCK')+' · '+(x.cliente||'otro cliente'));return;}
    if(!['disponible','reservado','preparando'].includes(x.estado)){toast('⛔ Palet no disponible · '+palletStatusLabel(x.estado));return;}
    if(!cpPaletEncajaEnPedido(x,p)){toast('⛔ Producto/formato del palet no corresponde al pedido');return;}
    if($('cps-modo')?.value==='picking'){
      if(salidaPicking.some(r=>String(r.paletId)===String(x.id))){toast('ℹ️ '+x.id+' ya está en picking');return;}
      const fefo=cpFefoAviso(x,p); salidaPicking.push({paletId:x.id,producto:x.producto||'',formato:x.formato||'',lote:x.lote||'',cajas:0}); cpRenderPicking(); if(fefo){$('cps-info').innerHTML='<div class="cp-fefo-warning">'+esc(fefo)+'</div>';toast(fefo);}else toast('✓ '+x.id+' añadido como origen de picking'); return;
    }
    const limite=Math.max(cpPedidoTotalPalets(p)-cpPedidoPaletsYaCargados(p),0); if(limite&&salidaPalets.length>=limite){toast('⛔ El pedido solo necesita '+limite+' palet'+(limite===1?'':'s')+' más');return;}
    const fefo=cpFefoAviso(x,p); if(!salidaPalets.includes(x.id)){salidaPalets.push(x.id);if(fefo)toast(fefo);else toast('✓ '+x.id+' añadido');}else toast('ℹ️ '+x.id+' ya estaba seleccionado'); cpRenderSalidaList(); if(fefo)$('cps-info').innerHTML='<div class="cp-fefo-warning">'+esc(fefo)+'</div>';
  };
  window.cpCargarDisponibles=function(){
    const p=pedidoById($('cps-pedido').value); if(!p){toast('⚠️ Selecciona un pedido');return;}
    if($('cps-modo')?.value==='picking'){
      const plan=cpPickingPlanFIFO(p); if(!plan.length){toast('⚠️ No hay stock compatible disponible para el picking');cpRenderPicking();return;}
      salidaPicking=plan.map(r=>({paletId:r.x.id,producto:r.x.producto||'',formato:r.x.formato||'',lote:r.x.lote||'',cajas:r.cajas}));
      cpRenderPicking(); toast('🥇 FIFO aplicado · '+plan.reduce((a,r)=>a+r.cajas,0)+' cajas propuestas en '+plan.length+' palet'+(plan.length===1?'':'s'));
      return;
    }
    const limite=Math.max(cpPedidoTotalPalets(p)-cpPedidoPaletsYaCargados(p)-salidaPalets.length,0); if(!limite){toast('ℹ️ El pedido no necesita más palets');return;}
    const av=cpOrdenarFIFO(_palletsForOrder(p).filter(x=>!salidaPalets.includes(x.id))).slice(0,limite); salidaPalets=[...salidaPalets,...av.map(x=>x.id)]; cpRenderSalidaList(); toast('📦 '+av.length+' palets compatibles añadidos en FIFO');
  };
  window.cpReservarFIFO=async function(){
    const p=pedidoById($('cps-pedido')?.value); if(!p){toast('⚠️ Selecciona un pedido');return;}
    const plan=cpPickingPlanFIFO(p); const totalPal=Math.max(cpPedidoTotalPalets(p)-cpPedidoPaletsYaCargados(p),0);
    const completos=cpOrdenarFIFO(cpPaletsCompatibles(p).filter(x=>x.estado==='disponible' && !x.pedidoId).filter(x=>!((x.reservasCajas&&Object.keys(x.reservasCajas).length)))).slice(0,totalPal);
    if(!plan.length && !completos.length){toast('⚠️ No hay stock compatible para reservar');return;}
    try{await db.runTransaction(async tx=>{
      const refs=[...new Set([...plan.map(r=>r.x.id),...completos.map(x=>x.id)])].map(id=>colPalets.doc(id));
      const snaps=[]; for(const ref of refs)snaps.push(await tx.get(ref));
      const by=new Map(snaps.map(s=>[s.id,s]));
      for(const x of completos){const snap=by.get(x.id);if(!snap?.exists)throw new Error('Falta '+x.id);const cur=snap.data();if(cur.estado!=='disponible')throw new Error(x.id+' ya no está disponible');tx.update(colPalets.doc(x.id),{estado:'reservado',reservaPedidoId:p.id,reservaPedidoNum:p.num||'',reservedAt:firebase.firestore.FieldValue.serverTimestamp()});tx.set(colMovLogistica.doc(),{paletId:x.id,accion:'reservado',estado:'reservado',pedidoId:p.id,pedidoNum:p.num||'',ts:Date.now(),fecha:nowISO(),detalle:'Reserva FIFO palet completo'});}
      for(const r of plan){const snap=by.get(r.x.id);if(!snap?.exists)throw new Error('Falta '+r.x.id);const cur=snap.data();const other=cur.reservasCajas||{};const reservedOther=Object.entries(other).filter(([k])=>String(k)!==String(p.id)).reduce((a,[,v])=>a+(parseInt(v)||0),0);const libre=Math.max((parseInt(cur.cajas)||0)-reservedOther,0);const n=Math.min(r.cajas,libre);if(n<=0)continue;other[p.id]=(parseInt(other[p.id])||0)+n;tx.update(colPalets.doc(r.x.id),{reservasCajas:other});tx.set(colMovLogistica.doc(),{paletId:r.x.id,accion:'reservado_picking',estado:cur.estado,pedidoId:p.id,pedidoNum:p.num||'',cajas:n,ts:Date.now(),fecha:nowISO(),detalle:'Reserva FIFO de cajas para picking'});}
    }); toast('🔒 Reserva FIFO realizada'); cpSalidaPedidoChange();
    }catch(e){console.error(e);toast('❌ No se pudo reservar: '+(e.message||e));}
  };
  async function cpConfirmarSalidaPedido(){
    const p=pedidoById($('cps-pedido').value); if(!p){toast('⚠️ Selecciona un pedido');return;}
    if(!salidaPalets.length && !salidaPicking.length){toast('⚠️ Selecciona palets completos o añade picking');return;}
    const pickingLocal=salidaPicking.filter(r=>(parseInt(r.cajas)||0)>0); if(salidaPicking.length!==pickingLocal.length){toast('⚠️ Indica las cajas a extraer en todos los palets de picking o elimínalos');return;}
    const ts=Date.now(); const sid=salidaCargaId ? (salidaCargaId+'-'+String(p.id)) : ('S'+ts.toString(36).toUpperCase()); const ids=[...new Set(salidaPalets)];
    const muelle=up($('cps-muelle').value), transportista=up($('cps-trans').value), tractora=up($('cps-tractora').value), remolque=up($('cps-remolque').value);
    // Firestore Compat no admite tx.get(query); tomamos esta instantánea antes de la transacción.
    const loadedSnap=await colPalets.where('pedidoId','==',String(p.id)).where('estado','==','cargado').get();
    const loadedBefore=loadedSnap.docs.map(d=>d.data());
    try{ await db.runTransaction(async tx=>{
      const orderRef=col.doc(String(p.id)), orderSnap=await tx.get(orderRef); if(!orderSnap.exists)throw new Error('El pedido ya no existe'); const current=orderSnap.data();
      const refs=[...ids.map(id=>colPalets.doc(id)),...pickingLocal.map(r=>colPalets.doc(r.paletId))]; const uniqueRefs=[...new Map(refs.map(r=>[r.path,r])).values()]; const snaps=[]; for(const ref of uniqueRefs)snaps.push(await tx.get(ref));
      const byId=new Map(snaps.filter(s=>s.exists).map(s=>[s.id,s.data()]));
      const selected=[]; for(const id of ids){const x=byId.get(id);if(!x)throw new Error('Palet inexistente: '+id);if(x.pedidoId&&String(x.pedidoId)!==String(p.id))throw new Error('Palet '+id+' no pertenece al pedido');if(!['disponible','reservado','preparando'].includes(x.estado))throw new Error('Palet '+id+' ya no está disponible');if(!cpPaletEncajaEnPedido(x,current))throw new Error('Producto/formato incompatible en '+id);selected.push(x);}
      const pickingValid=[]; for(const r of pickingLocal){const x=byId.get(String(r.paletId));if(x?.contenido?.length)throw new Error('El palet mixto '+r.paletId+' debe cargarse completo, no por picking');if(!x)throw new Error('Palet de picking inexistente: '+r.paletId);if(x.estado==='cargado')throw new Error('El palet '+r.paletId+' ya está cargado');if(!['disponible','reservado','preparando'].includes(x.estado))throw new Error('Palet '+r.paletId+' no está disponible para picking');if(!cpPaletEncajaEnPedido(x,current))throw new Error('Producto/formato incompatible en picking: '+r.paletId);const n=parseInt(r.cajas)||0;if(n<=0||n>=(parseInt(x.cajas)||0)+1)throw new Error('Cantidad de picking no válida en '+r.paletId);pickingValid.push({r,x,n});}
      const overlap=ids.find(id=>pickingLocal.some(r=>String(r.paletId)===String(id))); if(overlap) throw new Error('El palet '+overlap+' no puede ir completo y a picking en la misma preparación');
      const already=loadedBefore.filter(x=>!ids.includes(String(x.id))); const limiteP=Math.max(cpPedidoTotalPalets(current)-already.length,0); if(limiteP&&selected.length>limiteP)throw new Error('El pedido solo admite '+limiteP+' palets más');
      const ex=[...(current.productosExtra||[])].map(pe=>({...pe})); let mainU=0,mainC=0; const extraCounts=ex.map(()=>({u:0,c:0}));
      const accumulateOne=(x,units=1)=>{const mainMatch=up(x.producto)===up(current.producto)&&(!x.formato||!current.formato||up(x.formato)===up(current.formato));if(mainMatch){mainU+=units;mainC+=parseInt(x.cajas)||0;return;}const ix=ex.findIndex(pe=>up(pe.producto)===up(x.producto)&&(!x.formato||!pe.formato||up(x.formato)===up(pe.formato)));if(ix>=0){extraCounts[ix].u+=units;extraCounts[ix].c+=parseInt(x.cajas)||0;}};
      const accumulate=(x)=>{if(Array.isArray(x.contenido)&&x.contenido.length){x.contenido.forEach((c,i)=>accumulateOne(c,i===0&&up(c.producto)===up(current.producto)?1:0));}else accumulateOne(x,1);};
      loadedBefore.forEach(accumulate); selected.forEach(accumulate);
      const prevPick=[...(current.pickingMovimientos||[])]; const pickNew=pickingValid.map(({r,x,n})=>({id:'PK'+Date.now().toString(36).toUpperCase()+Math.random().toString(36).slice(2,6),paletId:x.id,pedidoId:current.id,pedidoNum:current.num||'',producto:x.producto||'',formato:x.formato||'',lote:x.lote||'',caducidad:x.caducidad||'',cajas:n,fecha:nowISO(),salidaId:sid}));
      const pickCajasAntes=parseInt(current.pickingCajasPreparadas)||0, pickCajasNuevas=pickNew.reduce((a,m)=>a+m.cajas,0), pickCajasDespues=pickCajasAntes+pickCajasNuevas;
      pickingValid.forEach(({x,n})=>{const mainMatch=up(x.producto)===up(current.producto)&&(!x.formato||!current.formato||up(x.formato)===up(current.formato));if(mainMatch) mainC+=n; else {const ix=ex.findIndex(pe=>up(pe.producto)===up(x.producto)&&(!x.formato||!pe.formato||up(x.formato)===up(pe.formato)));if(ix>=0) extraCounts[ix].c+=n;}});
      ex.forEach((pe,i)=>{pe.udsCargados=extraCounts[i].u;pe.cajasCargados=extraCounts[i].c;});
      const mainBoxesReq=parseInt(current.cajas)||0; const lineas=[{uds:parseInt(current.uds)||0,cajas:mainBoxesReq,cu:mainU,cc:mainC},...ex.map(pe=>({uds:parseInt(pe.uds)||0,cajas:parseInt(pe.cajas)||0,cu:parseInt(pe.udsCargados)||0,cc:parseInt(pe.cajasCargados)||0}))].filter(l=>l.uds||l.cajas);
      const done=lineas.length>0&&lineas.every(l=>(l.uds<=0||l.cu>=l.uds)&&(l.cajas<=0||l.cc>=l.cajas));
      if(!done) throw new Error('El pedido '+(current.num||current.id)+' debe cargarse completo: incluye todos sus artículos y cajas');
      const now=nowISO();
      const salida={id:sid,cargaId:salidaCargaId||sid,cargaNumero:parseInt($('cps-carga-num')?.value)||1,ordenCarga:window._cpOrdenCarga||1,pedidoId:current.id,pedidoNum:current.num||'',cliente:up(current.grupo||''),palets:ids,picking:pickNew,estado:'cargado',muelle,transportista,tractora,remolque,createdAt:firebase.firestore.FieldValue.serverTimestamp(),confirmedAt:now};
      for(const id of ids){const x=byId.get(id);const ref=colPalets.doc(id);tx.update(ref,{estado:'cargado',pedidoId:x.pedidoId||current.id,pedidoNum:x.pedidoNum||current.num||'',cliente:x.cliente||up(current.grupo||''),assignedAtLoad:!x.pedidoId,assignedAtLoadPedidoId:!x.pedidoId?current.id:'',salidaId:sid,loadedAt:firebase.firestore.FieldValue.serverTimestamp(),cargaInfo:{pedidoId:current.id,pedidoNum:current.num||'',muelle,transportista,tractora,remolque}});tx.set(colMovLogistica.doc(),{paletId:id,accion:'cargado',estado:'cargado',salidaId:sid,pedidoId:current.id,pedidoNum:current.num||'',ts,fecha:now});}
      for(const {x,n} of pickingValid){const ref=colPalets.doc(x.id),rest=parseInt(x.cajas||0)-n; const reservas={...(x.reservasCajas||{})}; const rPrev=parseInt(reservas[current.id])||0; if(rPrev>0){reservas[current.id]=Math.max(rPrev-n,0);if(!reservas[current.id])delete reservas[current.id];} tx.update(ref,{cajas:rest,estado:rest<=0?'agotado':'disponible',reservasCajas:reservas,lastPickingAt:firebase.firestore.FieldValue.serverTimestamp()});}
      pickNew.forEach((m,i)=>{const src=pickingValid[i].x;tx.set(colMovLogistica.doc(),{paletId:m.paletId,accion:'picking',estado:src.estado, pedidoId:current.id,pedidoNum:current.num||'',salidaId:sid,cajas:m.cajas,producto:m.producto,formato:m.formato,lote:m.lote,caducidad:m.caducidad,ts,fecha:now});});
      tx.set(colSalidasPalets.doc(sid),salida);
      tx.set(orderRef,{...current,udsCargados:mainU,cajasCargadas:mainC,productosExtra:ex,pickingCajasPreparadas:pickCajasDespues,pickingMovimientos:[...prevPick,...pickNew],status:done?'cargado':current.status,cargadoAt:done?now.slice(0,10):current.cargadoAt||'',hora:current.hora||'',muelle:muelle||current.muelle||'',transportista:transportista||current.transportista||'',mat1:tractora||current.mat1||'',mat2:remolque||current.mat2||'',cargasHistorial:[...(current.cargasHistorial||[]),{fecha:now.slice(0,10),detalle:(ids.length?ids.length+' palets':'')+(pickNew.length?' + '+pickCajasNuevas+' cajas picking':''),palets:ids.length,pickingCajas:pickCajasNuevas,hora:current.hora||'',muelle,transportista,mat1:tractora,mat2:remolque}]});
    }); if(!window._cpCargaMulti){ cpCerrarSalida(); } toast('🟢 Pedido '+(p.num||p.id)+' añadido a la carga '+(parseInt($('cps-carga-num')?.value)||1)+' · '+(ids.length?ids.length+' palets':'')+(pickingLocal.length?' + '+pickingLocal.reduce((a,r)=>a+r.cajas,0)+' cajas picking':''));
    }catch(e){console.error(e);throw e;}
  };
  window.cpConfirmarSalida=async function(){
    cpGuardarPreparacionActiva();
    if(!salidaPedidos.length){toast('⚠️ Añade al menos un pedido a la carga');return;}
    const numero=Math.max(1,parseInt($('cps-carga-num')?.value)||1); const cargaId=salidaCargaId||('C'+Date.now().toString(36).toUpperCase());
    const total=salidaPedidos.length; let ok=0;
    window._cpCargaMulti=true;
    try{
      for(const id of salidaPedidos){ window._cpOrdenCarga=salidaPedidos.indexOf(id)+1; $('cps-pedido').value=id; salidaPedidoActivo=String(id); cpCargarPreparacion(id); await cpConfirmarSalidaPedido(); ok++; }
      localStorage.setItem('cargasProUltimaCarga',String(numero)); cpCerrarSalida(); try{ if($('cpPaletsScreen')&&!$('cpPaletsScreen').classList.contains('open')) abrirPalets(); cpPalTab('packs'); }catch(_){} toast('🚚 Carga '+numero+' confirmada · '+ok+'/'+total+' pedidos');
    }catch(e){ toast('❌ La carga se detuvo tras '+ok+'/'+total+' pedidos: '+(e.message||e)); }
    finally{ window._cpCargaMulti=false; }
  };

  window.cpReabrirPedidoPalets=async function(pedidoId,{eliminar=false}={}){
    const pedido=pedidos.find(x=>String(x.id)===String(pedidoId));
    const afect=palets.filter(x=>String(x.pedidoId)===String(pedidoId) && x.estado==='cargado');
    for(const x of afect){
      const limpiar=eliminar || x.assignedAtLoad===true;
      const upd={estado:'disponible',salidaId:firebase.firestore.FieldValue.delete(),loadedAt:firebase.firestore.FieldValue.delete(),cargaInfo:firebase.firestore.FieldValue.delete(),assignedAtLoad:firebase.firestore.FieldValue.delete(),assignedAtLoadPedidoId:firebase.firestore.FieldValue.delete()};
      if(limpiar){upd.pedidoId='';upd.pedidoNum='';upd.cliente='';}
      await colPalets.doc(x.id).update(upd);
      await colMovLogistica.doc().set({paletId:x.id,accion:eliminar?'pedido_eliminado':'pedido_reabierto',estado:'disponible',ts:Date.now(),fecha:nowISO(),pedidoId:String(pedidoId),pedidoNum:x.pedidoNum||''});
    }
    // Reintegra al palet de origen las cajas que habían salido por picking.
    // Se hace en transacción para que dos terminales no pisen el saldo de cajas.
    const picks=(pedido?.pickingMovimientos||[]);
    if(picks.length){
      const porPalet=new Map(); picks.forEach(m=>{const id=String(m.paletId||'');const n=parseInt(m.cajas)||0;if(id&&n>0)porPalet.set(id,(porPalet.get(id)||0)+n);});
      await db.runTransaction(async tx=>{
        const refs=[...porPalet.keys()].map(id=>colPalets.doc(id)); const snaps=[]; for(const ref of refs)snaps.push(await tx.get(ref));
        snaps.forEach((snap,i)=>{if(!snap.exists)throw new Error('No se puede devolver el picking: falta el palet '+refs[i].id);const cur=snap.data();if(cur.estado==='cargado')throw new Error('No se puede devolver el picking: el palet '+refs[i].id+' ya está cargado');const n=(parseInt(cur.cajas)||0)+(porPalet.get(snap.id)||0);tx.update(refs[i],{cajas:n,estado:'disponible',lastPickingRevertedAt:firebase.firestore.FieldValue.serverTimestamp()});tx.set(colMovLogistica.doc(),{paletId:snap.id,accion:eliminar?'picking_revertido_eliminacion':'picking_revertido_reapertura',estado:'disponible',cajasDevueltas:porPalet.get(snap.id)||0,ts:Date.now(),fecha:nowISO(),pedidoId:String(pedidoId),pedidoNum:pedido?.num||''});});
      });
    }
    // Libera las reservas de ese pedido (palets completos y cajas reservadas).
    await db.runTransaction(async tx=>{
      const refs=new Map();
      for(const x of palets){
        const own=String(x.reservaPedidoId||'')===String(pedidoId);
        const rc=x.reservasCajas||{};
        if(own || Object.prototype.hasOwnProperty.call(rc,String(pedidoId))) refs.set(String(x.id),colPalets.doc(x.id));
      }
      if(!refs.size)return;
      const snaps=[]; for(const ref of refs.values())snaps.push(await tx.get(ref));
      snaps.forEach(snap=>{if(!snap.exists)return;const cur=snap.data();const rc={...(cur.reservasCajas||{})};delete rc[String(pedidoId)];const upd={reservasCajas:rc};if(String(cur.reservaPedidoId||'')===String(pedidoId)){upd.estado='disponible';upd.reservaPedidoId=firebase.firestore.FieldValue.delete();upd.reservaPedidoNum=firebase.firestore.FieldValue.delete();upd.reservedAt=firebase.firestore.FieldValue.delete();}tx.update(colPalets.doc(snap.id),upd);tx.set(colMovLogistica.doc(),{paletId:snap.id,accion:eliminar?'reserva_liberada_eliminacion':'reserva_liberada_reapertura',estado:upd.estado||cur.estado,pedidoId:String(pedidoId),pedidoNum:pedido?.num||'',ts:Date.now(),fecha:nowISO()});});
    });
  };

  window.cpCrearPaletsDeProduccion=async function(lote){
    if(!lote || (parseFloat(lote.palets)<=0 && parseFloat(lote.cajas)<=0)) return;
    if(lote.fase && lote.fase!=='encajado') return;
    const P=Math.max(Math.floor(parseFloat(lote.palets)||0),0), C=Math.max(Math.floor(parseFloat(lote.cajas)||0),0), cpp=Math.max(Math.floor(parseFloat(lote.cajasPorPalet)||0),0);
    if(!P && !C)return;
    const pedidoAsignado=(lote.pedidosRef||[]).length===1 ? pedidoById(lote.pedidosRef[0].id) : null;
    const pedidoLinea=pedidoAsignado ? cpPedidoLineaOptions(pedidoAsignado).find(x=>up(x.producto)===up(lote.articulo) && (!x.formato || !lote.formato || up(x.formato)===up(lote.formato))) : null;
    const cantidades=[]; let restantes=C;
    for(let i=0;i<P;i++){ cantidades.push(cpp); }
    if(C>0){ cantidades.push(restantes); }
    const desired=cantidades.length;
    const loteRef=colProd.doc(String(lote.id));
    try{
      const result=await db.runTransaction(async tx=>{
        const loteSnap=await tx.get(loteRef);
        if(!loteSnap.exists) throw new Error('El lote ya no existe');
        const currentLote=loteSnap.data();
        const existingSnap=await tx.get(colPalets.where('produccionId','==',String(lote.id)));
        const existingIds=existingSnap.docs.map(d=>d.id);
        const refs=existingIds.map(id=>colPalets.doc(id));
        const snaps=[]; for(const ref of refs) snaps.push(await tx.get(ref));
        const actuales=snaps.filter(s=>s.exists).map(s=>s.data());
        const cargados=actuales.filter(x=>x.estado==='cargado');
        if(desired<cargados.length) throw new Error('La nueva cantidad produciría menos palets que los ya cargados');
        const keep=actuales.filter(x=>x.estado==='cargado').concat(actuales.filter(x=>x.estado!=='cargado').slice(0,Math.max(0,desired-cargados.length)));
        const keepIds=new Set(keep.map(x=>String(x.id)));
        const anulados=actuales.filter(x=>!keepIds.has(String(x.id)) && x.estado!=='cargado');
        const nuevos=desired-keep.length;
        let ids=[];
        if(nuevos>0){
          const counterRef=db.collection('config').doc('palets_counter');
          const cSnap=await tx.get(counterRef);
          const start=cSnap.exists?(parseInt(cSnap.data().next)||1):1;
          ids=Array.from({length:nuevos},(_,i)=>'P'+String(start+i).padStart(8,'0'));
          tx.set(counterRef,{next:start+nuevos,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
        }
        anulados.forEach(x=>tx.update(colPalets.doc(x.id),{estado:'anulado',anuladoAt:firebase.firestore.FieldValue.serverTimestamp(),anuladoMotivo:'Ajuste de cantidad del lote',sourceAdjustment:true}));
        const uCaja=parseInt(lote.botellasPorCaja||lote.bricksPorCaja||0)||0;
        const makeData=(id,cajas)=>({id,pedidoId:pedidoAsignado?.id||'',pedidoNum:pedidoAsignado?.num||'',cliente:up(pedidoAsignado?.grupo||''),producto:up(lote.articulo),formato:up(lote.formato),referencia:up(pedidoLinea?.ref||pedidoAsignado?.ref||''),pais:up(pedidoLinea?.pais||pedidoAsignado?.pais||''),tipo:'PRODUCCIÓN',lote:up(lote.lote),caducidad:lote.caducidad||'',ubicacion:'',cajas,cajasPorPalet:cpp,unidades:cajas*uCaja,unidadesTipo:lote.tipo==='brik'?'BRICKS':(lote.tipo==='botella'?'BOTELLAS':'UDS'),pesoKg:0,notas:'PRODUCCIÓN '+(lote.numProd||''),estado:'disponible',source:'produccion',produccionId:lote.id,prodRef:lote.numProd||'',createdAt:firebase.firestore.FieldValue.serverTimestamp(),createdIso:nowISO()});
        const disponibles=keep.filter(x=>x.estado!=='cargado');
        const targets=[...disponibles,...ids.map(id=>({id,__new:true}))];
        let idx=0;
        targets.forEach(x=>{
          const cajas=cantidades[cargados.length+idx]??0;
          if(x.__new){tx.set(colPalets.doc(x.id),makeData(x.id,cajas));tx.set(colMovLogistica.doc(),{paletId:x.id,accion:'creado',estado:'disponible',ts:Date.now(),fecha:nowISO(),detalle:'Alta desde producción',pedidoId:pedidoAsignado?.id||'',pedidoNum:pedidoAsignado?.num||'',produccionId:lote.id});}
          else if(x.estado!=='cargado'){tx.update(colPalets.doc(x.id),makeData(x.id,cajas));}
          idx++;
        });
        tx.set(loteRef,{...lote,paletIds:actuales.filter(x=>x.estado==='cargado').map(x=>x.id).concat(targets.map(x=>x.id)),paletsFisicosCreados:desired}, {merge:false});
        return {ids,desired,anulados:anulados.length};
      });
      toast('▣ '+result.desired+' palets físicos sincronizados para '+(lote.numProd||lote.articulo)+(result.anulados?' · '+result.anulados+' anulados':'') );
    }catch(e){console.error(e);toast('❌ No se pudieron sincronizar los palets: '+(e.message||e));throw e;}
  };

  window.cpAbrirCamara=async function(){
    $('cpCamModal').classList.add('open'); const msg=$('cpCamMsg');
    if(!navigator.mediaDevices?.getUserMedia){msg.textContent='La cámara no está disponible en este navegador. Usa el lector manual.';return;}
    try{
      if(window.ZXingBrowser?.BrowserMultiFormatReader){
        const reader=new ZXingBrowser.BrowserMultiFormatReader();
        camStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});
        $('cpCamVideo').srcObject=camStream; msg.textContent='Buscando código…';
        const scan=async()=>{if(!camStream)return;try{const result=await reader.decodeOnceFromVideoElement($('cpCamVideo'));if(result){cpEscanearEntrada(result.getText());cpCerrarCamara();return;}}catch(e){}camTimer=requestAnimationFrame(scan);};scan();return;
      }
      if('BarcodeDetector' in window){
        const detector=new BarcodeDetector({formats:['code_128','ean_13','qr_code']}); camStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false}); $('cpCamVideo').srcObject=camStream;
        const scan=async()=>{if(!camStream)return;try{const codes=await detector.detect($('cpCamVideo'));if(codes.length){cpEscanearEntrada(codes[0].rawValue);cpCerrarCamara();return;}}catch(e){}camTimer=requestAnimationFrame(scan);};scan();return;
      }
      msg.textContent='Este navegador no tiene lector de códigos disponible. En iPhone/iPad se necesita ZXing y, si no está cargado, puedes usar un lector Bluetooth/USB o introducir el código manualmente.';
    }catch(e){console.error(e);msg.textContent='No se pudo abrir la cámara. Comprueba el permiso del navegador y usa el lector manual si es necesario.';}
  };
  window.cpCerrarCamara=function(){ if(camTimer)cancelAnimationFrame(camTimer);camTimer=null;if(camStream){camStream.getTracks().forEach(t=>t.stop());camStream=null;}const v=$('cpCamVideo');if(v)v.srcObject=null;$('cpCamModal')?.classList.remove('open'); };

  // Integración con la pantalla de producción: el módulo se crea al registrar lotes nuevos.
  // Si se cargó una versión anterior sin el hook, no modifica datos existentes automáticamente.
  // ═══ Centro de operaciones / control profesional ═══
  window.abrirOperaciones=function(){ $('cpOpsScreen').classList.add('open'); document.body.style.overflow='hidden'; cpOpsRefresh(); };
  window.cerrarOperaciones=function(){ $('cpOpsScreen').classList.remove('open'); document.body.style.overflow=''; };
  window.cpOpsRefresh=async function(){
    const pend=pedidos.filter(p=>p.status!=='cargado');
    const pickingPend=pend.reduce((a,p)=>a+cpPickingPendiente(p),0);
    const disp=palets.filter(x=>x.estado==='disponible');
    const prep=palets.filter(x=>x.estado==='preparando');
    const sinUb=palets.filter(x=>x.estado!=='cargado' && !String(x.ubicacion||'').trim());
    const now=Date.now(), lim=now+30*86400000;
    const cad=palets.filter(x=>x.estado!=='cargado'&&cpCadDate(x)&&cpCadDate(x).getTime()<=lim&&cpCadDate(x).getTime()>=now).length;
    $('opsPedidosPend').textContent=pend.length; $('opsPickingPend').textContent=pickingPend; $('opsPalDisponible').textContent=disp.length; $('opsPalPreparando').textContent=prep.length; $('opsPalSinUb').textContent=sinUb.length; $('opsCad30').textContent=cad;
    const inc=[];
    if(sinUb.length) inc.push(`<div class="cp-ops-row"><span>Palets sin ubicación física</span><span class="cp-ops-badge warn">${sinUb.length}</span></div>`);
    if(cad) inc.push(`<div class="cp-ops-row"><span>Palets con caducidad en ≤ 30 días</span><span class="cp-ops-badge warn">${cad}</span></div>`);
    const deficit=pend.filter(p=>cpPickingPendiente(p)>0 && cpPaletsCompatibles(p).filter(x=>(parseInt(x.cajas)||0)>0).reduce((a,x)=>a+(parseInt(x.cajas)||0),0)<cpPickingPendiente(p));
    if(deficit.length) inc.push(`<div class="cp-ops-row"><span>Pedidos con falta de stock para picking</span><span class="cp-ops-badge danger">${deficit.length}</span></div>`);
    const sinLote=disp.filter(x=>!String(x.lote||'').trim()); if(sinLote.length) inc.push(`<div class="cp-ops-row"><span>Palets disponibles sin lote</span><span class="cp-ops-badge danger">${sinLote.length}</span></div>`);
    $('opsIncidencias').innerHTML=inc.length?inc.join(''):'<div class="cp-ops-row"><span>Sin incidencias críticas detectadas</span><span class="cp-ops-badge ok">OK</span></div>';
    const byLoc={}; disp.concat(prep).forEach(x=>{const loc=String(x.ubicacion||'SIN UBICACIÓN').trim()||'SIN UBICACIÓN';(byLoc[loc]??=[]).push(x);});
    const locs=Object.entries(byLoc).sort((a,b)=>a[0].localeCompare(b[0],undefined,{numeric:true}));
    $('opsUbicaciones').innerHTML=locs.length?locs.slice(0,12).map(([loc,xs])=>`<div class="cp-ops-row"><span><b>${esc(loc)}</b><br><small>${xs.slice(0,3).map(x=>esc(x.id)).join(' · ')}${xs.length>3?' · …':''}</small></span><span class="cp-ops-badge">${xs.length} palet${xs.length===1?'':'s'}</span></div>`).join(''):'<div class="cp-ops-row">No hay palets activos.</div>';
    const pp=pend.filter(p=>cpPickingPendiente(p)>0).sort((a,b)=>String(a.num||'').localeCompare(String(b.num||''),undefined,{numeric:true})).slice(0,15);
    $('opsPicking').innerHTML=pp.length?`<table class="cp-ops-table"><thead><tr><th>Pedido</th><th>Cliente</th><th>Producto</th><th>Pendiente</th><th>FIFO disponible</th></tr></thead><tbody>${pp.map(p=>{const av=cpOrdenarFIFO(cpPaletsCompatibles(p).filter(x=>(parseInt(x.cajas)||0)>0));const stock=av.reduce((a,x)=>a+(parseInt(x.cajas)||0),0);return `<tr><td><b>${esc(p.num||p.id)}</b></td><td>${esc(p.grupo||'')}</td><td>${esc(p.producto||'')}</td><td><b>${cpPickingPendiente(p)}</b> cajas</td><td>${stock} cajas · ${av.length} palets</td></tr>`}).join('')}</tbody></table>`:'<div class="cp-ops-row">No hay picking pendiente.</div>';
    let recent=[]; try{const ms=await colMovLogistica.orderBy('ts','desc').limit(20).get(); recent=ms.docs.map(d=>({...d.data(),id:d.id}));}catch(e){recent=Array.isArray(window._cpMovCache)?window._cpMovCache:[];}
    $('opsMovimientos').innerHTML=recent.length?`<table class="cp-ops-table"><thead><tr><th>Fecha</th><th>Palet</th><th>Acción</th><th>Pedido</th><th>Detalle</th></tr></thead><tbody>${recent.slice(0,20).map(m=>`<tr><td>${esc(m.fecha||'')}</td><td><b>${esc(m.paletId||'')}</b></td><td>${esc(m.accion||'')}</td><td>${esc(m.pedidoNum||'')}</td><td>${esc(m.detalle||((m.cajas!=null?m.cajas+' cajas':'')))}</td></tr>`).join('')}</tbody></table>`:'<div class="cp-ops-row">El historial reciente aparecerá aquí al registrar movimientos.</div>';
  };
  window.cpOpsUbicaciones=function(){ $('cpUbicacionesScreen').classList.add('open'); cpRenderUbicaciones(); };
  window.cerrarUbicaciones=function(){ $('cpUbicacionesScreen').classList.remove('open'); };
  window.cpRenderUbicaciones=function(){
    const q=up($('opsUbBusca')?.value); const by={};
    palets.filter(x=>x.estado!=='cargado'&&x.estado!=='anulado').forEach(x=>{const loc=String(x.ubicacion||'SIN UBICACIÓN').trim()||'SIN UBICACIÓN';const txt=[loc,x.id,x.producto,x.lote,x.pedidoNum,x.cliente].join(' ').toUpperCase();if(q&&!txt.includes(q))return;(by[loc]??=[]).push(x);});
    const entries=Object.entries(by).sort((a,b)=>a[0].localeCompare(b[0],undefined,{numeric:true}));
    $('opsUbLista').innerHTML=entries.length?`<div class="cp-ops-loc">${entries.map(([loc,xs])=>`<div class="cp-ops-loc-card"><b>📍 ${esc(loc)}</b><small>${xs.length} unidad${xs.length===1?'':'es'} · ${xs.reduce((a,x)=>a+(parseInt(x.cajas)||0),0)} cajas</small>${xs.slice(0,8).map(x=>`<div class="cp-p-chip"><b>${esc(x.id)}</b> · ${esc(x.producto||'')} · ${parseInt(x.cajas)||0} cajas</div>`).join('')}${xs.length>8?`<small>+ ${xs.length-8} más</small>`:''}</div>`).join('')}</div>`:'<div class="cp-ops-card"><div class="cp-ops-row">No hay ubicaciones que coincidan.</div></div>';
  };

})();
