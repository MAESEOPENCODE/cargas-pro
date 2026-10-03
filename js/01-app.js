// La apiKey web de Firebase no es un secreto por diseño; la protección real está en reglas Firestore/App Check.
// Estado compartido entre los módulos clásicos cargados por index.html.
var db=null, auth=null, currentUser=null, currentRole='operario', offlineReady=Promise.resolve(), col=null, colMov=null, colProd=null, colMat=null, colRecetas=null, colMovMat=null, colMovProd=null, colPalets=null, colSalidasPalets=null, colMovLogistica=null, colAuditoria=null;
try {
  if(typeof firebase==='undefined') throw new Error('SDK Firebase no cargado');
  if(!firebase.apps?.length) firebase.initializeApp({
    apiKey: "AIzaSyBog0Y7wgH5DuV9nuQhqxJB4y-HFRaljYQ",
    authDomain: "cargas-pro.firebaseapp.com",
    projectId: "cargas-pro",
    storageBucket: "cargas-pro.firebasestorage.app",
    messagingSenderId: "449154412431",
    appId: "1:449154412431:web:cfd5619d5816c649e965fa"
  });
  auth=firebase.auth();
  db=firebase.firestore();
  // Caché local y cola de escrituras para trabajar temporalmente sin red.
  offlineReady = db.enablePersistence({synchronizeTabs:true}).then(()=>true).catch(err=>{
    console.warn('Firestore offline no disponible en esta pestaña:',err.code||err.message||err);
    return false;
  });
  col=db.collection('pedidos'); colMov=db.collection('movimientos_palets'); colProd=db.collection('produccion');
  colMat=db.collection('materiales'); colRecetas=db.collection('recetas'); colMovMat=db.collection('movimientos_materiales');
  colMovProd=db.collection('movimientos_produccion'); colPalets=db.collection('palets'); colSalidasPalets=db.collection('salidas_palets');
  colMovLogistica=db.collection('movimientos_logistica'); colAuditoria=db.collection('auditoria');
} catch(e) {
  console.error('Firebase init:',e);
  const ls=document.getElementById('loadingScreen');
  if(ls){ const t=ls.querySelector('.loading-txt'); if(t)t.textContent='No se pudo iniciar Firebase. Comprueba la conexión/configuración y recarga.'; }
}

// ══ AUTENTICACIÓN REAL ══
(function(){
  const $=id=>document.getElementById(id);
  const showLogin=(msg='')=>{const o=$('loginOverlay');if(o)o.style.display='flex';const e=$('loginError');if(e){e.textContent=msg;e.style.display=msg?'block':'none';}};
  const hideLogin=()=>{const o=$('loginOverlay');if(o)o.style.display='none';};
  window.doLogin=async function(){const u=$('loginUser'),p=$('loginPass'),e=$('loginError');if(!auth||!u||!p)return;if(e){e.textContent='';e.style.display='none';}try{await auth.signInWithEmailAndPassword(u.value.trim(),p.value);p.value='';}catch(err){console.error('Firebase Auth:',err);if(e){e.textContent='Correo o contraseña incorrectos.';e.style.display='block';}p.value='';p.focus();}};
  window.doLogout=async function(){if(auth)await auth.signOut();};
  window._cpShowLogin=showLogin;window._cpHideLogin=hideLogin;
})();

// MAYÚSCULAS solo en campos marcados explícitamente.
// Evita romper correos, búsquedas, códigos alfanuméricos y campos técnicos.
document.addEventListener('input', e => {
  const el = e.target;
  if (!el || !el.tagName || !el.matches('[data-uppercase]')) return;
  const v = el.value, u = v.toUpperCase();
  if (v !== u) { const a = el.selectionStart, b = el.selectionEnd; el.value = u; try { el.setSelectionRange(a,b); } catch(_){} }
}, true);

const CP_SCHEMA_VERSION = 3;
function cpNum(value, fallback=0){
  if(value===null || value===undefined || value==='') return fallback;
  const n=Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function cpInt(value, fallback=0){ const n=Number(value); return Number.isInteger(n) && Number.isFinite(n) ? n : (value===''||value==null?fallback:parseInt(value,10)||fallback); }
function _cpActor(){ return { uid: currentUser?.uid||'', email: currentUser?.email||'' }; }
function _cpAudit(data, action){
  const actor=_cpActor(), now=Date.now();
  const out={...data, updatedAtMs:now, updatedBy:actor.uid, updatedByEmail:actor.email, lastAction:action||'actualizado'};
  if(!data.createdAt) out.createdAt=now;
  if(!data.createdBy) { out.createdBy=actor.uid; out.createdByEmail=actor.email; }
  return out;
}
async function registrarAuditoria(action, collection, documentId, detail){
  if(!colAuditoria || !currentUser) return;
  const id='aud_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
  try { await colAuditoria.doc(id).set({id,action,collection,documentId:String(documentId||''),detail:detail||'',..._cpActor(),ts:Date.now(),fecha:new Date().toISOString()}); }
  catch(e){ console.warn('Auditoría no registrada:',e); }
}
function _cpEsAdmin(){ return currentRole==='admin'; }
function _cpClean(value){
  if(Array.isArray(value)) return value.map(_cpClean);
  if(value && typeof value==='object' && !(value instanceof Date) && !(value?.toDate)) {
    const out={};
    Object.entries(value).forEach(([k,v])=>{ if(v!==undefined) out[k]=_cpClean(v); });
    return out;
  }
  return value;
}
function cpNormalizePedido(p){
  const x={schemaVersion:CP_SCHEMA_VERSION, ...p};
  x.uds=cpInt(x.uds); x.cajas=cpInt(x.cajas); x.udsCargados=cpInt(x.udsCargados); x.cajasCargadas=cpInt(x.cajasCargadas);
  x.ec=cpInt(x.ec); x.ed=cpInt(x.ed); x.productosExtra=Array.isArray(x.productosExtra)?x.productosExtra:[];
  return x;
}

var pedidos = [];
var producciones = [];
var materiales = [];
var recetas = [];
var movimientosMat = [];
var movimientosProd = [];
var palets = [];
var salidasPalets = [];
function _dedupeProducciones(rows){
  const m=new Map();
  rows.forEach(l=>{
    const art=(l.articulo||'').trim().toUpperCase(), fmt=(l.formato||'').trim().toUpperCase();
    const key=l.numProd ? `prod:${l.numProd}|${art}|${fmt}` : `doc:${l.id}`;
    const prev=m.get(key);
    const ts=x=>Number(x.updatedAtMs||x.createdAt||0);
    if(!prev || ts(l)>=ts(prev)) m.set(key,l);
  });
  return [...m.values()];
}
const CP_HISTORY_LIMIT=500, CP_STOCK_LIMIT=1000, CP_MOV_DAYS=90;
function cpMovimientosDesde(){ return Date.now()-CP_MOV_DAYS*86400000; }
function startReferenceListeners(){ if (!db) return;
colProd.limit(CP_STOCK_LIMIT).onSnapshot((snap) => {
  producciones = _dedupeProducciones(snap.docs.map(d => ({ ...d.data(), id: d.id })));
  producciones.sort((a,b) => (a.caducidad||'9999-99-99').localeCompare(b.caducidad||'9999-99-99'));
  if (document.getElementById('mProduccion')?.classList.contains('open')) renderProduccionList();
  render(); // por si hay avisos de stock visibles en el formulario abierto
}, (err) => { console.error('Firestore producción:', err); });
colMat.limit(CP_STOCK_LIMIT).onSnapshot((snap) => {
  materiales = snap.docs.map(d => ({ ...d.data(), id: d.id }));
  materiales.sort((a,b) => (a.nombre||'').localeCompare(b.nombre||''));
  if (document.getElementById('mProduccion')?.classList.contains('open')) renderProduccionList();
}, (err) => { console.error('Firestore materiales:', err); });
colRecetas.limit(CP_STOCK_LIMIT).onSnapshot((snap) => {
  recetas = snap.docs.map(d => ({ ...d.data(), id: d.id }));
  if (document.getElementById('mProduccion')?.classList.contains('open')) renderProduccionList();
}, (err) => { console.error('Firestore recetas:', err); });
colMovMat.where('ts','>=',cpMovimientosDesde()).orderBy('ts','desc').limit(CP_HISTORY_LIMIT).onSnapshot((snap) => {
  movimientosMat = snap.docs.map(d => ({ ...d.data(), id: d.id }));
  movimientosMat.sort((a,b) => (b.ts||0)-(a.ts||0));
  if (document.getElementById('mProduccion')?.classList.contains('open')) renderProduccionList();
}, (err) => { console.error('Firestore movimientos materiales:', err); });
colMovProd.where('ts','>=',cpMovimientosDesde()).orderBy('ts','desc').limit(CP_HISTORY_LIMIT).onSnapshot((snap) => {
  movimientosProd = snap.docs.map(d => ({ ...d.data(), id: d.id }));
  movimientosProd.sort((a,b) => (b.ts||0)-(a.ts||0));
  if (document.getElementById('mProduccion')?.classList.contains('open')) renderProduccionList();
}, (err) => { console.error('Firestore movimientos producción:', err); });
colPalets.limit(CP_STOCK_LIMIT).onSnapshot((snap)=>{
  palets = snap.docs.map(d=>({...d.data(),id:d.id}));
  palets.sort((a,b)=>(b.createdAt?.seconds||b.createdAt||0)-(a.createdAt?.seconds||a.createdAt||0));
  if(document.getElementById('cpPaletsScreen')?.classList.contains('open')) cpRenderPalets();
},(err)=>console.error('Firestore palets:',err));
colSalidasPalets.onSnapshot((snap)=>{
  salidasPalets = snap.docs.map(d=>({...d.data(),id:d.id}));
  if(document.getElementById('cpPackingView')?.style.display!=='none' && document.getElementById('cpPaletsScreen')?.classList.contains('open')) cpRenderPackingLists();
},(err)=>{ console.error('Firestore salidas palets:',err); toast('⚠️ No se pudo leer el histórico de Packing Lists: '+(err.code||'permiso o conexión'),6000); });
}

// Disponible de un lote. Con cajasPorPalet se calcula en cajas totales y se reparte en palets + cajas sueltas.
// ── Nº automático de producción (P-AAAA-NNN) ──
function _nuevoNumProd(fecha) {
  const pre = 'P-' + ((fecha||'').slice(0,4) || new Date().getFullYear()) + '-';
  let max = 0;
  producciones.forEach(l => { if ((l.numProd||'').startsWith(pre)) max = Math.max(max, parseInt(l.numProd.slice(pre.length))||0); });
  return pre + String(max+1).padStart(3,'0');
}
// Numera las producciones antiguas que no tienen número (por orden de creación)
async function asignarNumerosProduccion() {
  const sin = producciones.filter(l=>!l.numProd).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
  if (!sin.length) return;
  const usados = new Set(producciones.map(l=>l.numProd).filter(Boolean));
  for (const l of sin) {
    const y = (l.fecha||'').slice(0,4) || String(new Date().getFullYear()); let n = 1, num;
    do { num = 'P-'+y+'-'+String(n++).padStart(3,'0'); } while (usados.has(num));
    usados.add(num); await fbSaveProduccion({ ...l, numProd:num });
  }
}
// Producciones con stock (agrupadas por número) para un artículo/formato
function _opcionesProd(articulo, formato) {
  const key = (articulo||'').trim().toUpperCase(); if (!key) return [];
  const m = new Map();
  producciones.forEach(l => {
    if ((l.articulo||'').trim().toUpperCase()!==key || !_fmtOk(l,formato) || !l.numProd) return;
    if (_esFases(l) && l.fase!=='encajado') return;
    const d = _dispLote(l); if (d.palets<=0 && d.cajas<=0) return;
    const o = m.get(l.numProd) || { num:l.numProd, pal:0, caj:0, lote:l.lote||'', cad:l.caducidad||'' };
    o.pal += d.palets; o.caj += d.cajas; m.set(l.numProd, o);
  });
  return [...m.values()];
}
function _pintarSelectProd(sel, articulo, formato) {
  const want = sel.dataset.want || '';
  const ops = _opcionesProd(articulo, formato);
  let html = '<option value="">— Sin asignar —</option>' + ops.map(o=>`<option value="${o.num}">${o.num}${o.lote?' · Lote '+o.lote:''} · ${o.pal} pal.${o.caj?' + '+o.caj+' cajas':''}${o.cad?' · cad. '+o.cad:''}</option>`).join('');
  if (want && !ops.some(o=>o.num===want)) html += `<option value="${want}">${want} (sin stock)</option>`;
  sel.innerHTML = html; sel.value = want;
}
function refrescarProdSelects() {
  const g = id => document.getElementById(id);
  const m = g('f-prodRef'); if (m) _pintarSelectProd(m, g('f-producto')?.value, g('f-formato')?.value);
  document.querySelectorAll('#productos-extra-container .producto-extra').forEach(el => {
    const sl = el.querySelector('.pe-prod'); if (sl) _pintarSelectProd(sl, el.querySelector('.pe-producto')?.value, el.querySelector('.pe-formato')?.value);
  });
}
function _setProdRefMain(v) { const el = document.getElementById('f-prodRef'); if (el) el.dataset.want = v||''; refrescarProdSelects(); }
window._setProdRefMain = _setProdRefMain;
function _paraHtml(l) {
  const vivos = (l.pedidosRef||[]).filter(r => pedidos.some(p => String(p.id)===String(r.id) && p.status!=='cargado'));
  if (vivos.length !== (l.pedidosRef||[]).length) fbSaveProduccion({ ...l, pedidosRef: vivos }); // limpia referencias a pedidos ya borrados o cargados
  const m = new Map(vivos.map(r=>[String(r.id), r.txt]));
  if (l.numProd) pedidos.forEach(p => {
    if (p.status==='cargado') return;
    if (p.prodRef===l.numProd || (p.productosExtra||[]).some(e=>e.prodRef===l.numProd)) m.set(String(p.id), (p.grupo||'')+(p.num?' #'+p.num:''));
  });
  return m.size ? `<div style="margin-top:3px;color:var(--t2)">📋 Para: <b>${[...m.values()].join(', ')}</b></div>` : '';
}
function _dispLote(l) {
  const k=parseFloat(l.cajasPorPalet)||0, P=parseFloat(l.palets)||0, C=parseFloat(l.cajas)||0;
  const pc=parseFloat(l.paletsConsumidos)||0, cc=parseFloat(l.cajasConsumidos)||0;
  if (k>0) { const tot=Math.max(P*k+C-pc*k-cc,0); return { palets:Math.floor(tot/k), cajas:tot%k, total:tot, k }; }
  return { palets:Math.max(P-pc,0), cajas:Math.max(C-cc,0), total:null, k:0 }; // lote antiguo sin cajas/palet
}
// Stock disponible de un artículo (palets completos + cajas sueltas)
function _fmtOk(l,f){ const a=(l.formato||'').trim().toUpperCase(), b=(f||'').trim().toUpperCase(); return !a||!b||a===b; }
function stockDisponible(articulo, formato, prodRef) {
  const key = (articulo||'').trim().toUpperCase();
  if (!key) return { palets: 0, cajas: 0 };
  let palets = 0, cajas = 0;
  producciones.forEach(l => {
    if ((l.articulo||'').trim().toUpperCase() !== key || !_fmtOk(l,formato) || (prodRef && l.numProd!==prodRef)) return;
    const d=_dispLote(l); palets+=d.palets; cajas+=d.cajas;
  });
  return { palets, cajas };
}
// Bricks de un artículo que ya están producidos pero aún NO encajados (llenado/esperando etiquetado/etiquetado).
// No cuentan como stock en palets/cajas, pero es útil saber que existen antes de descartar el pedido por falta de stock.
function stockEnProceso(articulo, formato, prodRef) {
  const key = (articulo||'').trim().toUpperCase();
  if (!key) return { llenado: 0, etiquetado: 0 };
  let llenado = 0, etiquetado = 0;
  producciones.forEach(l => {
    if (l.tipo !== 'brik' || l.fase === 'encajado') return;
    if ((l.articulo||'').trim().toUpperCase() !== key || !_fmtOk(l,formato) || (prodRef && l.numProd!==prodRef)) return;
    const b = parseFloat(l.totalBricks)||0;
    if (l.fase === 'etiquetado') etiquetado += b; else llenado += b;
  });
  return { llenado, etiquetado };
}
// Plan FIFO (caducidad más próxima): coge los palets pedidos y las cajas necesarias, rompiendo palet si hace falta
function planConsumo(articulo, pal, caj, formato, pedidoId, prodRef, soloProd) {
  const key=(articulo||'').trim().toUpperCase();
  let rp=parseFloat(pal)||0, rc=parseFloat(caj)||0; const plan=[];
  producciones.filter(l=>(l.articulo||'').trim().toUpperCase()===key && _fmtOk(l,formato) && (!soloProd || !prodRef || l.numProd===prodRef))
    .sort((a,b)=>{ const r=x=>(prodRef&&x.numProd===prodRef)?0:(pedidoId&&(x.pedidosRef||[]).some(q=>String(q.id)===String(pedidoId))?1:2); return r(a)-r(b) || (a.caducidad||'9999-99-99').localeCompare(b.caducidad||'9999-99-99'); })
    .forEach(l=>{
      if (rp<=0 && rc<=0) return;
      const d=_dispLote(l);
      const up=Math.min(d.palets,rp);
      const uc=Math.min(d.k>0 ? d.total-up*d.k : d.cajas, rc);
      if (up<=0 && uc<=0) return;
      plan.push({l,up,uc}); rp-=up; rc-=uc;
    });
  return { plan, faltaPal:rp, faltaCaj:rc };
}

async function fbSaveProduccion(l) {
  setSyncStatus('saving'); l=_cpAudit(l, 'produccion_guardada');
  try { await colProd.doc(String(l.id)).set(l); await registrarAuditoria('produccion_guardada','produccion',l.id,l.numProd||l.articulo); setSyncStatus('ok'); }
  catch(e) { console.error(e); setSyncStatus('offline'); toast('❌ Error al guardar producción'); }
}
async function fbSaveMaterial(m) {
  setSyncStatus('saving'); m=_cpAudit(m, 'material_guardado');
  try { await colMat.doc(String(m.id)).set(m); await registrarAuditoria('material_guardado','materiales',m.id,m.nombre||''); setSyncStatus('ok'); }
  catch(e) { console.error(e); setSyncStatus('offline'); toast('❌ Error al guardar material'); }
}
async function fbDeleteMaterial(id) {
  setSyncStatus('saving');
  try { await colMat.doc(String(id)).delete(); await registrarAuditoria('material_eliminado','materiales',id,''); setSyncStatus('ok'); }
  catch(e) { console.error(e); setSyncStatus('offline'); toast('❌ Error al eliminar material'); }
}
async function fbSaveReceta(r) {
  setSyncStatus('saving'); r=_cpAudit(r, 'receta_guardada');
  try { await colRecetas.doc(String(r.id)).set(r); await registrarAuditoria('receta_guardada','recetas',r.id,r.articulo||''); setSyncStatus('ok'); }
  catch(e) { console.error(e); setSyncStatus('offline'); toast('❌ Error al guardar receta'); }
}
// Descuenta materiales según la receta del artículo+formato, proporcional a las cajas nuevas producidas.
// deltaCajas puede ser negativo (si se corrige un lote a la baja) para devolver material al stock.
function _recetaKey(articulo, formato) { return (articulo||'').trim().toUpperCase()+'|'+(formato||'').trim().toUpperCase(); }
function recetaPara(articulo, formato) { return recetas.find(r => _recetaKey(r.articulo,r.formato) === _recetaKey(articulo,formato)); }
async function consumirMateriales(articulo, formato, deltaCajas) {
  if (!deltaCajas) return;
  const r = recetaPara(articulo, formato);
  if (!r || !(r.items||[]).length) return;
  for (const it of r.items) {
    const m = materiales.find(x => String(x.id)===String(it.materialId)); if (!m) continue;
    const cantidad = -deltaCajas*(parseFloat(it.cantidad)||0);
    const nuevo = (parseFloat(m.stock)||0) + cantidad;
    await fbSaveMaterial({ ...m, stock: nuevo });
    await registrarMovMaterial(m, cantidad, nuevo, articulo+(formato?' · '+formato:''), deltaCajas>0?'consumo':'devolucion');
  }
}
// Deja constancia de cada entrada/consumo/ajuste de un material, para el informe de movimientos.
async function registrarMovMaterial(material, cantidad, stockResultante, motivo, tipo) {
  const id = 'mov_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
  await fbSaveMovMaterial({ id, materialId: material.id, materialNombre: material.nombre, unidad: material.unidad,
    cantidad, stockResultante, motivo, tipo: tipo || (cantidad>=0?'entrada':'ajuste'), ts: Date.now(), fecha: new Date().toISOString().slice(0,10) });
}
async function fbSaveMovMaterial(mv) {
  try { await colMovMat.doc(String(mv.id)).set(mv); }
  catch(e) { console.error(e); }
}
const _MOVP_TIPO_TXT = { creado:'Lote creado', editado:'Lote editado', etiquetado:'Etiquetado', encajado:'Encajado', eliminado:'Lote eliminado' };
// Deja constancia de cada alta/edición/cambio de fase/baja de un lote, para el histórico de producción.
async function registrarMovProduccion(lote, tipo, detalle) {
  const id = 'movp_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
  try { await colMovProd.doc(id).set({ id, loteId: lote.id, numProd: lote.numProd||'', articulo: lote.articulo||'', formato: lote.formato||'',
    tipo, detalle: detalle||'', ts: Date.now(), fecha: new Date().toISOString().slice(0,10) }); }
  catch(e) { console.error(e); }
}
function _cajasEq(l) { return (parseFloat(l?.palets)||0)*(parseFloat(l?.cajasPorPalet)||0) + (parseFloat(l?.cajas)||0); }
// Resume un lote en una línea de texto, para el histórico de movimientos de producción
function _descLote(l) {
  if (_esFases(l) && l.fase!=='encajado') {
    const u = l.tipo==='botella'?'botellas':'bricks';
    return `${_FASE_TXT?_FASE_TXT[l.fase]:l.fase} · ${_fmtN(parseFloat(l[_campoTotal(l.tipo)])||0)} ${u}`;
  }
  const pal = parseFloat(l.palets)||0, caj = parseFloat(l.cajas)||0;
  return `${pal} palet${pal===1?'':'s'}${caj?' + '+caj+' cajas':''}${l.cajasPorPalet?' ('+l.cajasPorPalet+' cajas/palet)':''}`;
}
// Revierte el consumo de stock de un historial de cargas (usado al reabrir un pedido)
async function revertirConsumoStock(cargasHistorial) {
  for (const carga of (cargasHistorial||[])) {
    for (const uso of (carga.lotesConsumidos||[])) {
      const lote = producciones.find(l => String(l.id) === String(uso.id));
      if (!lote) continue; // el lote pudo ser eliminado manualmente entre tanto
      await fbSaveProduccion({ ...lote,
        paletsConsumidos: Math.max((parseFloat(lote.paletsConsumidos)||0) - (parseFloat(uso.palets)||0), 0),
        cajasConsumidos: Math.max((parseFloat(lote.cajasConsumidos)||0) - (parseFloat(uso.cajas)||0), 0)
      });
    }
  }
}

async function fbDeleteProduccion(id) {
  setSyncStatus('saving');
  try { await colProd.doc(String(id)).delete(); setSyncStatus('ok'); }
  catch(e) { console.error(e); setSyncStatus('offline'); toast('❌ Error al eliminar'); }
}

// Consume stock FIFO para todas las líneas de una carga.
// Si recibe una transacción externa, no abre otra: stock y pedido quedan atómicos.
async function consumirStockMulti(lineas, pedidoId, txExterna=null) {
  const reqs=(lineas||[]).map(x=>({...x,
    palets:Math.max(0,cpNum(x.palets)), cajas:Math.max(0,cpNum(x.cajas))
  })).filter(x=>x.producto && (x.palets||x.cajas));
  if(!reqs.length) return [];

  // Los candidatos se calculan desde la caché ordenada FIFO, pero dentro de la
  // transacción se leen únicamente sus DocumentReference concretas.
  const acumuladas=new Map();
  for(const req of reqs){
    const key=[req.producto,req.formato||'',req.prodRef||''].join('|');
    const a=acumuladas.get(key)||{...req,palets:0,cajas:0};
    a.palets+=req.palets; a.cajas+=req.cajas; acumuladas.set(key,a);
  }
  const candidateIds=new Set();
  for(const req of acumuladas.values()){
    const {plan}=planConsumo(req.producto,req.palets,req.cajas,req.formato,pedidoId,req.prodRef,false);
    plan.forEach(({l})=>candidateIds.add(String(l.id)));
  }
  if(!candidateIds.size) throw new Error('Stock insuficiente para la carga');

  const ejecutar=async tx=>{
    const refs=[...candidateIds].map(id=>colProd.doc(id));
    const snaps=[];
    for(const ref of refs) snaps.push(await tx.get(ref));
    const fresh=snaps.filter(x=>x.exists).map(x=>({...x.data(),id:x.id}));
    const anterior=producciones;
    producciones=fresh;
    try{
      const updates=new Map(), resultado=[];
      for(const req of reqs){
        const {plan,faltaPal,faltaCaj}=planConsumo(req.producto,req.palets,req.cajas,req.formato,pedidoId,req.prodRef,false);
        if(faltaPal>0 || faltaCaj>0) throw new Error(`Stock insuficiente para ${req.producto}: faltan ${faltaPal} palets y ${faltaCaj} cajas`);
        for(const {l,up,uc} of plan){
          const snap=snaps.find(x=>x.id===String(l.id));
          const current=snap?.data();
          if(!current) throw new Error('El lote '+l.id+' ya no existe; vuelve a intentarlo');
          const previo=updates.get(String(l.id))||{
            paletsConsumidos:parseFloat(current.paletsConsumidos)||0,
            cajasConsumidos:parseFloat(current.cajasConsumidos)||0
          };
          const np=previo.paletsConsumidos+up, nc=previo.cajasConsumidos+uc;
          const totalP=parseFloat(current.palets)||0, totalC=parseFloat(current.cajas)||0;
          if(np>totalP || nc>totalC) throw new Error('Stock cambiado durante la carga; vuelve a intentarlo');
          updates.set(String(l.id),{paletsConsumidos:np,cajasConsumidos:nc});
          const working=producciones.find(x=>String(x.id)===String(l.id));
          if(working){working.paletsConsumidos=np;working.cajasConsumidos=nc;}
          const found=resultado.find(x=>String(x.id)===String(l.id)&&x.producto===req.producto);
          if(found){found.palets+=up;found.cajas+=uc;}
          else resultado.push({id:l.id,producto:req.producto,lote:l.lote||'',palets:up,cajas:uc,caducidad:l.caducidad||''});
        }
      }
      for(const [id,data] of updates) tx.update(colProd.doc(id),{...data,schemaVersion:CP_SCHEMA_VERSION});
      return resultado;
    }finally{ producciones=anterior; }
  };
  return txExterna ? ejecutar(txExterna) : db.runTransaction(ejecutar);
}
async function consumirStock(articulo,palets,cajas,formato,pedidoId,prodRef){
  return consumirStockMulti([{producto:articulo,palets,cajas,formato,prodRef}],pedidoId);
}
// ════ FIX BUG: día de carga real (no fecha planificada del pedido) ════
// Si un pedido tiene cargadoAt (fecha real en que se pulsó "Cargado") usar esa,
// si no, usar p.fecha por compatibilidad con pedidos antiguos (migración suave).
function cargDay(p){ return p.cargadoAt || p.fecha || ''; }
let movimientos = [];
let epActiveTab = 'movs';
let editMovId = null;
let editId = null, cargarId = null;
let activeTab = 'pendientes', activeView = 'cards';
let confirmState = null; // estado encapsulado del diálogo; evita callbacks cruzados

const n = new Date();
const dateStr = n.toLocaleDateString('es-ES',{weekday:'short',day:'2-digit',month:'2-digit'}).replace(',','');
document.getElementById('todayDate').innerHTML = dateStr + ' <span class="sync-dot saving" id="syncDot"></span>';

function setSyncStatus(s) {
  const dot = document.getElementById('syncDot');
  if (!dot) return;
  dot.className = 'sync-dot ' + s;
}

function toast(msg, dur=2200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), dur);
}

function confirm2(icon, title, msg, okLabel, okClass, cb) {
  document.getElementById('confirmIcon').textContent = icon;
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMsg').textContent = msg;
  const ok = document.getElementById('confirmOk');
  ok.textContent = okLabel;
  ok.className = 'cbtn-ok ' + (okClass||'');
  confirmState = { ok: typeof cb === 'function' ? cb : null, createdAt: Date.now() };
  document.getElementById('confirmBg').dataset.confirmToken = String(confirmState.createdAt);
  document.getElementById('confirmBg').classList.add('open');
}
// Diálogo con dos acciones distintas además de Cancelar (botones apilados en vertical)
let confirmAltCallback = null;
function confirm3(icon, title, msg, okLabel, okClass, altLabel, cbOk, cbAlt) {
  confirm2(icon, title, msg, okLabel, okClass, cbOk);
  const alt = document.getElementById('confirmAlt');
  alt.textContent = altLabel; alt.style.display = '';
  document.getElementById('confirmBtns').style.flexDirection = 'column';
  confirmAltCallback = cbAlt;
}
function doConfirmAlt() { const cb = confirmAltCallback; closeConfirm(); if (cb) cb(); }
window.confirm3 = confirm3; window.doConfirmAlt = doConfirmAlt;
function closeConfirm() {
  document.getElementById('confirmBg').classList.remove('open');
  confirmState=null;
  confirmAltCallback=null;
  const bg = document.getElementById('confirmBg'); if(bg) delete bg.dataset.confirmToken;
  const alt = document.getElementById('confirmAlt'); if (alt) alt.style.display = 'none';
  const btns = document.getElementById('confirmBtns'); if (btns) btns.style.flexDirection = '';
  if(window._tmpCancelCarga){ window._tmpCancelCarga(); window._tmpCancelCarga=null; }
}
function doConfirmOk() { const state=confirmState; closeConfirm(); if(state?.ok) state.ok(); }

function hideLoadingScreen() {
  const ls = document.getElementById('loadingScreen');
  if (ls && !ls.classList.contains('hide')) {
    ls.classList.add('hide');
    setTimeout(() => { if(ls.parentNode) ls.remove(); }, 400);
  }
}

// Timeout de seguridad: si en 8s no llega respuesta de Firestore, ocultar pantalla y mostrar error
const _loadTimeout = setTimeout(() => {
  hideLoadingScreen();
  setSyncStatus('offline');
  toast('⚠️ No se pudo conectar. Comprueba la conexión.');
}, 8000);

function startPedidoListener(){ if (!db) return; col.onSnapshot((snapshot) => {
  clearTimeout(_loadTimeout);
  pedidos = snapshot.docs.map(d => cpNormalizePedido({ ...d.data(), id: d.id }));
  // Ordenación: con número → por nº asc; sin número → al final por creación asc (último creado abajo)
  // Pedidos con misma matrícula (mat1) → se agrupan juntos (camión compartido)
  // Precalculamos posición y ancla de matrícula una sola vez.
  // La versión anterior hacía filter()+map()+Math.min() dentro del comparador.
  const _ordenMeta = new Map();
  const _anclas = new Map();
  pedidos.forEach(x => {
    const num = x.num ? parseInt(x.num,10) : null;
    const pos = num !== null && Number.isFinite(num) ? num : 1e9 + (x.createdAt||0)/1e13;
    const mat = (x.mat1||'').trim().toUpperCase();
    _ordenMeta.set(String(x.id), {pos, mat});
    if(mat) _anclas.set(mat, Math.min(_anclas.get(mat) ?? Infinity, pos));
  });
  pedidos.sort((a,b) => {
    const A=_ordenMeta.get(String(a.id))||{pos:Infinity,mat:''};
    const B=_ordenMeta.get(String(b.id))||{pos:Infinity,mat:''};
    if(A.mat && B.mat && A.mat===B.mat) return A.pos-B.pos;
    const anclaA=A.mat ? (_anclas.get(A.mat) ?? A.pos) : A.pos;
    const anclaB=B.mat ? (_anclas.get(B.mat) ?? B.pos) : B.pos;
    return anclaA-anclaB || A.pos-B.pos;
  });
  hideLoadingScreen();
  setSyncStatus('ok');
  // ARRANQUE: mostrar el conjunto operativo completo para que tarjetas y tabla
  // enseñen pedidos, estado y datos logísticos desde la pantalla principal.
  // Después de la primera carga se conserva la pestaña elegida por el usuario.
  if(!window._initialRenderDone){
    activeTab = 'todos';
    window._initialRenderDone = true;
    filtroHoyActivo = false;
    filtroMañanaActivo = false;
    document.getElementById('fFechaDesde').value = '';
    document.getElementById('fFechaHasta').value = '';
    resetHoyBtn();
    resetMañanaBtn();
  }
  // Sincronizar navegación y breadcrumb sin sobrescribir la pestaña activa.
  if (typeof setTab === 'function') setTab(activeTab);
  else render();
  if(document.getElementById('cpPackingView')?.style.display!=='none' && document.getElementById('cpPaletsScreen')?.classList.contains('open')) cpRenderPackingLists();
}, (err) => {
  clearTimeout(_loadTimeout);
  console.error('Firestore:', err);
  setSyncStatus('offline');
  const ls = document.getElementById('loadingScreen');
  if (ls) {
    ls.querySelector('.loading-txt').textContent = 'Sin conexión · Toca para reintentar';
    ls.querySelector('.loading-spinner').style.display = 'none';
    ls.style.cursor = 'pointer';
    ls.onclick = () => location.reload();
  }
  toast('⚠️ Sin conexión a la nube');
});
}

// Las suscripciones se inician solo después de autenticar al usuario.
if (auth) auth.onAuthStateChanged(async user=>{
  currentUser=user;
  const label=document.getElementById('authUser');
  if(user){
    currentRole='operario';
    try { const prof=await db.collection('usuarios').doc(user.uid).get(); currentRole=prof.exists ? (prof.data().rol||'operario') : 'operario'; } catch(err) { console.warn('No se pudo leer el rol; se usará operario:',err); toast('⚠️ No se pudo comprobar tu rol. Se aplican permisos de operario.',5000); }
    if(label)label.textContent=(user.email||'')+' · '+(currentRole==='admin'?'Administrador':'Operario');
    document.body.classList.toggle('operator-mode',currentRole!=='admin' && window.innerWidth<900);
    document.querySelectorAll('[data-admin-action]').forEach(el=>{el.hidden=currentRole!=='admin';});
    window._cpHideLogin?.();
    offlineReady.then(()=>{if(!window._cpListenersStarted){window._cpListenersStarted=true;startReferenceListeners();startPedidoListener();}});
  } else {if(label)label.textContent='';hideLoadingScreen();window._cpShowLogin?.();}
});

async function fbSave(p) {
  setSyncStatus('saving'); p=_cpAudit(p, 'pedido_guardado');
  try {
    await db.collection('pedidos').doc(String(p.id)).set(p);
    await registrarAuditoria('pedido_guardado','pedidos',p.id,p.num||p.grupo||'');
    setSyncStatus('ok');
  } catch(e) { console.error(e); setSyncStatus('offline'); toast('❌ Error al guardar'); }
}

async function fbDelete(id) {
  setSyncStatus('saving');
  try {
    await db.collection('pedidos').doc(String(id)).delete();
    await registrarAuditoria('pedido_eliminado','pedidos',id,'');
    setSyncStatus('ok');
  } catch(e) { console.error(e); setSyncStatus('offline'); toast('❌ Error al eliminar'); }
}

function setTab(t) {
  activeTab = t;
  // Navegación de módulo: Pedidos es ahora un módulo de primer nivel
  document.querySelectorAll('.nav-pane .np-module[data-module]').forEach(n => n.classList.toggle('active', n.dataset.module === 'pedidos'));
  document.querySelectorAll('.nav-pane .np-sub[data-np]').forEach(n => n.classList.toggle('active', n.dataset.np === t));
  const crumbs = document.getElementById('crumbs');
  if (crumbs) crumbs.innerHTML = '<span class="crumb-module">PEDIDOS</span><span class="crumb-sep">/</span><span>' + ({pendientes:'Confección',terminado:'Terminado',todos:'Todos',cargados:'Cargados hoy',historico:'Histórico'}[t] || 'Gestión') + '</span>';
  // Actualizar nav bottom
  document.querySelectorAll('.bottom-nav .nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('nav-pend').classList.toggle('active', t==='pendientes');
  document.getElementById('nav-term').classList.toggle('active', t==='terminado');
  document.getElementById('nav-todos').classList.toggle('active', t==='todos');
  document.getElementById('nav-carg').classList.toggle('active', t==='cargados');
  document.getElementById('nav-hist').classList.toggle('active', t==='historico');
  // Actualizar título de la pestaña del navegador
  const tabTitles = {pendientes:'📦 Confección', terminado:'✅ Terminado', todos:'📋 Todos', cargados:'🚛 Cargados', historico:'🕐 Histórico'};
  document.title = (tabTitles[t] || 'Cargas Pro') + ' · Cargas Pro';
  render();
}

function setView(v, el) {
  activeView = v;
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('listArea').style.display = v==='cards' ? '' : 'none';
  document.getElementById('tableArea').style.display = v==='table' ? '' : 'none';
  const btnImp = document.getElementById('btnImprimir');
  if(btnImp) {
    btnImp.style.display = '';
    btnImp.title = v==='cards' ? 'Imprimir fichas' : 'Imprimir tabla';
    btnImp.textContent = v==='cards' ? '📇' : '🖨️';
  }
  const btnComp = document.getElementById('btnCompartir');
  if(btnComp) btnComp.style.display = '';
  render();
}

function toggleFilter() {
  document.getElementById('filterPanel').classList.toggle('open');
  document.getElementById('fBtn').classList.toggle('on');
}

let filtroHoyActivo = false;
function resetHoyBtn(){const b=document.getElementById("hoyBtn");if(b){b.style.background="";b.style.color="";b.style.borderColor="";}}
function filtrarHoy() {
  const hoy = new Date().toISOString().slice(0,10);
  filtroHoyActivo = !filtroHoyActivo;
  const btn = document.getElementById("hoyBtn");
  // Desactivar mañana si estaba activo
  if (filtroHoyActivo && filtroMañanaActivo) {
    filtroMañanaActivo = false;
    resetMañanaBtn();
  }
  if (filtroHoyActivo) {
    document.getElementById("fFechaDesde").value = hoy;
    document.getElementById("fFechaHasta").value = hoy;
    btn.style.background = "var(--brand-primary)";
    btn.style.color = "var(--dhl-dark)";
    btn.style.borderColor = "var(--brand-primary)";
  } else {
    document.getElementById("fFechaDesde").value = "";
    document.getElementById("fFechaHasta").value = "";
    btn.style.background = "";
    btn.style.color = "";
    btn.style.borderColor = "";
  }
  render();
}

let filtroMañanaActivo = false;
function resetMañanaBtn(){const b=document.getElementById("mañanaBtn");if(b){b.style.background="";b.style.color="";b.style.borderColor="";}}
function filtrarMañana() {
  const mañana = new Date(Date.now() + 86400000).toISOString().slice(0,10);
  filtroMañanaActivo = !filtroMañanaActivo;
  const btn = document.getElementById("mañanaBtn");
  // Desactivar hoy si estaba activo
  if (filtroMañanaActivo && filtroHoyActivo) {
    filtroHoyActivo = false;
    resetHoyBtn();
  }
  if (filtroMañanaActivo) {
    document.getElementById("fFechaDesde").value = mañana;
    document.getElementById("fFechaHasta").value = mañana;
    btn.style.background = "var(--sap-blue)";
    btn.style.color = "#fff";
    btn.style.borderColor = "var(--sap-blue)";
  } else {
    document.getElementById("fFechaDesde").value = "";
    document.getElementById("fFechaHasta").value = "";
    btn.style.background = "";
    btn.style.color = "";
    btn.style.borderColor = "";
  }
  render();
}

function updateLists() {
  const grupos  = [...new Set(pedidos.map(p=>p.grupo).filter(Boolean))];
  const muelles = [...new Set(pedidos.map(p=>p.muelle).filter(Boolean))];
  const trans   = [...new Set(pedidos.map(p=>p.transportista).filter(Boolean))];
  const prods   = [...new Set(pedidos.map(p=>p.producto).filter(Boolean))];
  const baseG = ['EUROGROUP','AMPLUS','IBERIANA','LLOMBART','FRUVA','SOCOMO'];
  document.getElementById('dl-grupos').innerHTML = [...new Set([...baseG,...grupos])].map(g=>`<option value="${g}">`).join('');
  const baseP = ['NARANJA','ESPARRAGO','SANDIA','GAZPACHO','SALMOREJO','MAYONESA','SALSA DE QUESO','SALSA BRAVA'];
  document.getElementById('dl-productos').innerHTML = [...new Set([...baseP,...prods])].map(p=>`<option value="${p}">`).join('');
  const baseM = ['1','2','3','4'];
  const allM = [...new Set([...baseM,...muelles])];
  ['dl-muelles','dl-muelles2'].forEach(id => { const el=document.getElementById(id); if(el) el.innerHTML=allM.map(m=>`<option value="${m}">`).join(''); });
  const baseT = ['VIGAR','TRANSMORO','CASTILLO','CARRION','ISABEL ALONSO','BLÁZQUEZ','SERVICOM','DHL'];
  const allT = [...new Set([...baseT,...trans])];
  ['dl-trans','dl-trans2'].forEach(id => { const el=document.getElementById(id); if(el) el.innerHTML=allT.map(t=>`<option value="${t}">`).join(''); });

  const _fmts=[...new Set([...pedidos.map(x=>x.formato),...pedidos.flatMap(x=>(x.productosExtra||[]).map(e=>e.formato)),...producciones.map(x=>x.formato),'BOTELLA 1 LT','BRICK 500'].map(v=>(v||'').trim().toUpperCase()).filter(Boolean))];
  const _dlf=document.getElementById('dl-formatos'); if(_dlf) _dlf.innerHTML=_fmts.map(v=>`<option value="${v}">`).join('');
  const gs=document.getElementById('fGrupo'); const gv=gs.value;
  gs.innerHTML='<option value="">Todos los clientes</option>'+grupos.map(g=>`<option value="${g}"${g===gv?' selected':''}>${g}</option>`).join('');
  const ms=document.getElementById('fMuelle'); const mv=ms.value;
  ms.innerHTML='<option value="">Todos los muelles</option>'+muelles.map(m=>`<option value="${m}"${m===mv?' selected':''}>${m}</option>`).join('');
  const ps=document.getElementById('fProducto'); const pv=ps.value;
  ps.innerHTML='<option value="">Todos los productos</option>'+prods.map(p=>`<option value="${p}"${p===pv?' selected':''}>${p}</option>`).join('');
}

function updateStats() {
  const hoy = new Date().toISOString().slice(0, 10);
  const pend=pedidos.filter(p=>p.status==='pendiente').length;
  const term=pedidos.filter(p=>p.status==='terminado').length;
  const carg=pedidos.filter(p=>p.status==='cargado' && (!cargDay(p) || cargDay(p) >= hoy)).length;
  const hist=pedidos.filter(p=>p.status==='cargado' && cargDay(p) && cargDay(p) < hoy).length;
  // Total = todos los pedidos que NO están cargados (pendientes + terminados + revisión)
  const totalActivos = pedidos.filter(p=>p.status!=='cargado').length;

}

function render() {
  updateLists(); updateStats();
  const q  = document.getElementById('searchInput').value.toLowerCase();
  const gf = document.getElementById('fGrupo').value;
  const mf = document.getElementById('fMuelle').value;
  const pf = document.getElementById('fProducto').value;
  const fd = document.getElementById('fFechaDesde').value;
  const fh = document.getElementById('fFechaHasta').value;

  const hoy = new Date().toISOString().slice(0, 10);

  // Histórico: solo pedidos cargados con fecha anterior a hoy
  if (activeTab === 'historico') {
    const filtered = pedidos.filter(p => {
      const txt=[p.num,p.grupo,p.producto,p.ref,p.mat1,p.mat2,p.notas,p.pais,p.muelle,p.transportista].join(' ').toLowerCase();
      const dc = cargDay(p);
      const fechaOk = (!fd || (dc && dc >= fd)) && (!fh || (dc && dc <= fh));
      return p.status==='cargado' && dc && dc < hoy
        && (!q||txt.includes(q)) && (!gf||p.grupo===gf) && (!mf||p.muelle===mf) && (!pf||p.producto===pf) && fechaOk;
    });
    document.getElementById('countLbl').textContent = filtered.length + ' pedido'+(filtered.length!==1?'s':'');
    if (activeView==='table') { renderTable(filtered); return; }
    renderHistorico(filtered, hoy);
    return;
  }

  const sm = {pendientes:'pendiente',terminado:'terminado',cargados:'cargado'};
  const ts = sm[activeTab];
  const filtered = pedidos.filter(p => {
    const txt=[p.num,p.grupo,p.producto,p.ref,p.mat1,p.mat2,p.notas,p.pais,p.muelle,p.transportista].join(' ').toLowerCase();
    // En Cargados/Histórico filtramos por la fecha REAL de carga, no la planificada
    const dateField = (activeTab === 'cargados' || activeTab === 'historico') ? cargDay(p) : p.fecha;
    const fechaOk = (!fd || (dateField && dateField >= fd)) && (!fh || (dateField && dateField <= fh));
    let statusOk;
    if (activeTab === 'todos') {
      // Todos: excluir cargados de días anteriores (van a Histórico)
      statusOk = !(p.status==='cargado' && cargDay(p) && cargDay(p) < hoy);
    } else if (activeTab === 'cargados') {
      // Cargados: solo los cargados HOY (por fecha real de carga)
      statusOk = p.status==='cargado' && (!cargDay(p) || cargDay(p) >= hoy);
    } else {
      statusOk = p.status===ts;
    }
    return statusOk && (!q||txt.includes(q)) && (!gf||p.grupo===gf) && (!mf||p.muelle===mf) && (!pf||p.producto===pf) && fechaOk;
  });
  document.getElementById('countLbl').textContent = filtered.length + ' pedido'+(filtered.length!==1?'s':'');
  if (activeView==='table') { renderTable(filtered); return; }
  renderCards(filtered);
}

function renderHistorico(filtered, hoyStr) {
  const bannerHtml = `<div class="hist-banner">
    <div class="hist-banner-icon">🕐</div>
    <div class="hist-banner-txt">
      <div class="hist-banner-date">📦 Pedidos cargados de días anteriores</div>
      <div class="hist-banner-sub">Registros anteriores a hoy · Solo lectura</div>
    </div>
    <div style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:#4527A0">${filtered.length}</div>
  </div>`;

  if (!filtered.length) {
    document.getElementById('listArea').innerHTML = bannerHtml + `<div class="empty"><div class="empty-icon">🕐</div><div class="empty-txt">Sin pedidos históricos</div><div class="empty-sub">No hay pedidos cargados de días anteriores</div></div>`;
    return;
  }
  const groups={};
  filtered.forEach(p=>{ const g=p.grupo||'—'; if(!groups[g]) groups[g]=[]; groups[g].push(p); });
  let html=bannerHtml;
  for(const [g,items] of Object.entries(groups)) {
    html+=`<div class="group-header"><div class="group-badge">🏢 ${g}<span class="group-count">${items.length}</span></div><div class="group-line"></div></div>`;
    items.forEach(p=>{ html+=cardHtmlHistorico(p); });
  }
  document.getElementById('listArea').innerHTML=html;
}

// Card de histórico: igual que cardHtml pero sin botones de acción (solo lectura)
function cardHtmlHistorico(p) {
  const pillClass={pendiente:'pill-pendiente',terminado:'pill-terminado',revision:'pill-revision',cargado:'pill-cargado'}[p.status]||'pill-pendiente';
  const pillLabel={pendiente:'Confección',terminado:'Terminado',revision:'Revisión',cargado:'Cargado'}[p.status]||'—';
  const fecha=p.fecha?new Date(p.fecha+'T00:00').toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit'}):'';
  let cargaBlock='';
  if(p.status==='cargado') {
    cargaBlock=`<div class="carga-banner">${p.hora?`<div class="cb-item"><div class="cb-label">⏰ Hora carga</div><div class="cb-val">${p.hora}</div></div>`:''} ${p.hora_salida?`<div class="cb-item"><div class="cb-label">🕐 Hora salida</div><div class="cb-val" style="color:var(--status-rev)">${p.hora_salida}</div></div>`:''} ${p.muelle?`<div class="cb-item"><div class="cb-label">🚪 Muelle</div><div class="cb-val">${p.muelle}</div></div>`:''} ${p.transportista?`<div class="cb-item"><div class="cb-label">🚚 Transportista</div><div class="cb-val">${p.transportista}</div></div>`:''}</div>`;
  }
  return `<div class="pedido-card status-${p.status}" style="opacity:.88">
    <div class="pedido-top">
      <div class="pedido-top-row1">${p.num?`<span class="pedido-num">#${p.num}</span>`:''}<span class="pedido-empresa">${p.grupo||'—'}</span></div>
      <div class="pedido-top-row2">${fecha?`<span class="pedido-fecha">${fecha}</span>`:''}<span class="status-pill ${pillClass}">${pillLabel}</span><span style="margin-left:auto;display:flex;align-items:center;gap:6px"><span style="font-size:9px;font-family:var(--font-mono);color:#9575CD;background:#EDE7F6;padding:2px 7px;border-radius:10px;letter-spacing:.3px">HISTÓRICO</span><button class="tbl-btn tbl-edit" data-action="edit-hist" data-id="${p.id}" title="Corregir datos" style="font-size:13px;padding:3px 7px">✏️</button></span></div>
    </div>
    <div class="pedido-body">
      <div class="info-row">
        ${p.producto?`<div class="info-block md"><div class="info-label">📦 Producto</div><span class="tag tag-producto">${p.producto}</span></div>`:''}
        ${p.ref?`<div class="info-block lg"><div class="info-label">Referencia</div><div class="info-val">${p.ref}</div></div>`:''}
        ${paletsInfoHtml(p)}${cajasInfoHtml(p)}${totalCajasHtml(p)}${unidadesInfoHtml(p)}${formatoHtml(p)}
        ${p.pais?`<div class="info-block md"><div class="info-label">País</div><span class="tag tag-pais">${p.pais}</span></div>`:''}
      </div>
      ${productosExtraHtml(p)}
      <div class="info-row">
        ${p.mat1?`<div class="info-block md"><div class="info-label">🚛 Tractora</div><span class="tag tag-mat1">${p.mat1}</span></div>`:''}
        ${p.mat2?`<div class="info-block md"><div class="info-label">🔗 Remolque</div><span class="tag tag-mat2">${p.mat2}</span></div>`:''}
        ${p.transportista?`<div class="info-block md"><div class="info-label">🚚 Transportista</div><span class="tag tag-trans">${p.transportista}</span></div>`:''}
        ${p.muelle?`<div class="info-block sm"><div class="info-label">🚪 Muelle</div><span class="tag tag-muelle">${p.muelle}</span></div>`:''}
        ${p.hora?`<div class="info-block sm"><div class="info-label">⏰ Hora</div><span class="tag tag-hora">${p.hora}</span></div>`:''}
      </div>
      ${cargaBlock}
      ${p.notas?`<div class="notes">💬 ${p.notas}</div>`:''}
    </div>
  </div>`;
}

function renderCards(filtered) {
  if (!filtered.length) {
    const msgs={pendientes:['📦','Sin pedidos en confección','Pulse + para añadir'],terminado:['✅','Sin pedidos terminados',''],todos:['📋','Sin pedidos','Pulse + para añadir'],cargados:['🚛','Sin pedidos cargados','']};
    const [icon,txt,sub]=msgs[activeTab]||['📋','Sin resultados',''];
    document.getElementById('listArea').innerHTML=`<div class="empty"><div class="empty-icon">${icon}</div><div class="empty-txt">${txt}</div>${sub?`<div class="empty-sub">${sub}</div>`:''}</div>`;
    return;
  }
  // Calcular qué matrículas aparecen más de una vez en el array filtrado
  const matCount={};
  filtered.forEach(p=>{ const m=(p.mat1||'').trim().toUpperCase(); if(m) matCount[m]=(matCount[m]||0)+1; });
  const matMulti = new Set(Object.keys(matCount).filter(m=>matCount[m]>1));

  const groups={};
  filtered.forEach(p=>{ const g=p.grupo||'—'; if(!groups[g]) groups[g]=[]; groups[g].push(p); });
  let html='';
  for(const [g,items] of Object.entries(groups)) {
    html+=`<div class="group-header"><div class="group-badge">🏢 ${g}<span class="group-count">${items.length}</span></div><div class="group-line"></div></div>`;
    let lastMat = null;
    items.forEach(p=>{
      const mat = (p.mat1||'').trim().toUpperCase();
      const esCamionCompartido = mat && matMulti.has(mat);
      if(esCamionCompartido && mat !== lastMat){
        html+=`<div class="camion-header"><span>🚛 ${p.mat1.trim()}${p.mat2?' · '+p.mat2.trim():''} — mismo camión</span></div>`;
      }
      html+=cardHtml(p, esCamionCompartido);
      lastMat = esCamionCompartido ? mat : null;
    });
  }
  document.getElementById('listArea').innerHTML=html;
}

// Progreso de palets cargados vs. total del pedido (soporta cargas parciales)
function paletsInfoHtml(p) {
  const total = parseInt(p.uds)||0;
  if (!total) return p.uds?`<div class="info-block sm"><div class="info-label">Palets</div><span class="tag tag-palets">${p.uds}</span></div>`:'';
  const cargados = parseInt(p.udsCargados)||0;
  if (cargados<=0) return `<div class="info-block sm"><div class="info-label">Palets</div><span class="tag tag-palets">${total}</span></div>`;
  const restante = Math.max(total-cargados,0);
  let html = `<div class="info-block sm"><div class="info-label">Palets</div><span class="tag tag-palets">${cargados}/${total}</span></div>`;
  if (restante>0) html += `<div class="info-block sm"><div class="info-label">📦 Restante</div><span class="tag" style="background:#CFE0F3;color:#8A4B00;border-color:#B3CDE8">${restante}</span></div>`;
  return html;
}

function formatoHtml(p) {
  const blk = (t,v) => `<div class="info-block sm"><div class="info-label">${t}</div><span class="tag tag-palets">${v}</span></div>`;
  return (p.formato ? blk('Formato',p.formato) : '') + (p.prodRef ? blk('Producción',p.prodRef) : '');
}
function totalCajasHtml(p) {
  const t = parseInt(p.totalCajas)||0;
  return (p.cpp && t) ? `<div class="info-block sm"><div class="info-label">Total cajas</div><span class="tag tag-palets">${t}</span></div>` : '';
}
function unidadesInfoHtml(p) {
  const t = parseInt(p.totalUnidades)||0;
  return (p.udsCaja && t) ? `<div class="info-block sm"><div class="info-label">Uds. totales</div><span class="tag" style="background:#FFF3CD;color:#7A5B00;border-color:#FFE69C">${t}</span></div>` : '';
}
// Progreso de cajas cargadas vs. total del pedido (análogo a paletsInfoHtml)
function cajasInfoHtml(p) {
  const total = parseInt(p.cajas)||0;
  if (!total) return '';
  const cargadas = parseInt(p.cajasCargadas)||0;
  if (cargadas<=0) return `<div class="info-block sm"><div class="info-label">Cajas</div><span class="tag tag-palets">${total}</span></div>`;
  const restante = Math.max(total-cargadas,0);
  let html = `<div class="info-block sm"><div class="info-label">Cajas</div><span class="tag tag-palets">${cargadas}/${total}</span></div>`;
  if (restante>0) html += `<div class="info-block sm"><div class="info-label">📦 Restante</div><span class="tag" style="background:#CFE0F3;color:#8A4B00;border-color:#B3CDE8">${restante} caj.</span></div>`;
  return html;
}

// Renderiza filas adicionales de info-row para los productos extra de un pedido (multi-producto)
// Progreso de palets/cajas cargados de un producto extra (mismo criterio que paletsInfoHtml/cajasInfoHtml)
function _progresoExtraHtml(total, cargado, unidad) {
  const t = parseInt(total)||0;
  if (!t) return '';
  const c = parseInt(cargado)||0;
  if (c<=0) return `<div class="info-block sm"><div class="info-label">${unidad}</div><span class="tag tag-palets">${t}</span></div>`;
  const restante = Math.max(t-c,0);
  let html = `<div class="info-block sm"><div class="info-label">${unidad}</div><span class="tag tag-palets">${c}/${t}</span></div>`;
  if (restante>0) html += `<div class="info-block sm"><div class="info-label">📦 Restante</div><span class="tag" style="background:#CFE0F3;color:#8A4B00;border-color:#B3CDE8">${restante}</span></div>`;
  return html;
}

function productosExtraHtml(p) {
  const extra = p.productosExtra||[];
  if(!extra.length) return '';
  return extra.map(pe => `<div class="info-row">
        ${pe.producto?`<div class="info-block md"><div class="info-label">📦 Producto</div><span class="tag tag-producto">${pe.producto}</span></div>`:''}
        ${formatoHtml(pe)}${_progresoExtraHtml(pe.uds, pe.udsCargados, 'Palets')}
        ${_progresoExtraHtml(pe.cajas, pe.cajasCargados, 'Cajas')}
        ${totalCajasHtml(pe)}${unidadesInfoHtml(pe)}
        ${pe.pais?`<div class="info-block md"><div class="info-label">País</div><span class="tag tag-pais">${pe.pais}</span></div>`:''}
      </div>`).join('');
}

function cardHtml(p, esCamionCompartido=false) {
  const pillClass={pendiente:'pill-pendiente',terminado:'pill-terminado',revision:'pill-revision',cargado:'pill-cargado'}[p.status]||'pill-pendiente';
  const pillLabel={pendiente:'Confección',terminado:'Terminado',revision:'Revisión',cargado:'Cargado'}[p.status]||'—';
  const fecha=p.fecha?new Date(p.fecha+'T00:00').toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit'}):'';
  let cargaBlock='';
  if(p.status==='cargado') {
    cargaBlock=`<div class="carga-banner">${p.hora?`<div class="cb-item"><div class="cb-label">⏰ Hora carga</div><div class="cb-val">${p.hora}</div></div>`:''} ${p.hora_salida?`<div class="cb-item"><div class="cb-label">🕐 Hora salida</div><div class="cb-val" style="color:var(--status-rev)">${p.hora_salida}</div></div>`:''} ${p.muelle?`<div class="cb-item"><div class="cb-label">🚪 Muelle</div><div class="cb-val">${p.muelle}</div></div>`:''} ${p.transportista?`<div class="cb-item"><div class="cb-label">🚚 Transportista</div><div class="cb-val">${p.transportista}</div></div>`:''}</div>`;
  }
  const eid=p.id;
  const terminarBtn = (p.status==='pendiente'||p.status==='revision')
    ? `<button class="tbl-btn" data-action="terminar" data-id="${eid}" title="Marcar como terminado" style="background:rgba(0,80,179,0.10);color:var(--sap-blue);border-color:rgba(0,80,179,0.25)">✅</button>`
    : '';
  const actions=p.status==='cargado'
    ?`<button class="tbl-btn tbl-edit" data-action="edit" data-id="${eid}" title="Editar">✏️</button><button class="tbl-btn tbl-reabrir" data-action="reabrir" data-id="${eid}" title="Reabrir">↩️</button><button class="tbl-btn tbl-del" data-action="del" data-id="${eid}" title="Eliminar">🗑️</button>`
    :`<button class="tbl-btn tbl-edit" data-action="edit" data-id="${eid}" title="Editar">✏️</button>${terminarBtn}<button class="tbl-btn tbl-cargar" data-action="cargar" data-id="${eid}" title="Cargar">🚛</button><button class="tbl-btn tbl-del" data-action="del" data-id="${eid}" title="Eliminar">🗑️</button>`;
  return `<div class="pedido-card status-${p.status}${esCamionCompartido?' camion-compartido':''}">
    <div class="pedido-top">
      <div class="pedido-top-row1">${p.num?`<span class="pedido-num">#${p.num}</span>`:''}<span class="pedido-empresa">${p.grupo||'—'}</span></div>
      <div class="pedido-top-row2">${fecha?`<span class="pedido-fecha">${fecha}</span>`:''}<span class="status-pill ${pillClass}">${pillLabel}</span><span style="margin-left:auto;display:flex;gap:3px;flex-shrink:0">${actions}</span></div>
    </div>
    <div class="pedido-body">
      <div class="info-row">
        ${p.producto?`<div class="info-block md"><div class="info-label">📦 Producto</div><span class="tag tag-producto">${p.producto}</span></div>`:''}
        ${p.ref?`<div class="info-block lg"><div class="info-label">Referencia</div><div class="info-val">${p.ref}</div></div>`:''}
        ${paletsInfoHtml(p)}${cajasInfoHtml(p)}${totalCajasHtml(p)}${unidadesInfoHtml(p)}${formatoHtml(p)}
        ${p.pais?`<div class="info-block md"><div class="info-label">País</div><span class="tag tag-pais">${p.pais}</span></div>`:''}
      </div>
      ${productosExtraHtml(p)}
      <div class="info-row">
        ${p.mat1?`<div class="info-block md"><div class="info-label">🚛 Tractora</div><span class="tag tag-mat1">${p.mat1}</span></div>`:''}
        ${p.mat2?`<div class="info-block md"><div class="info-label">🔗 Remolque</div><span class="tag tag-mat2">${p.mat2}</span></div>`:''}
        ${p.transportista?`<div class="info-block md"><div class="info-label">🚚 Transportista</div><span class="tag tag-trans">${p.transportista}</span></div>`:''}
        ${p.muelle?`<div class="info-block sm"><div class="info-label">🚪 Muelle</div><span class="tag tag-muelle">${p.muelle}</span></div>`:''}
        ${p.hora?`<div class="info-block sm"><div class="info-label">⏰ Hora</div><span class="tag tag-hora">${p.hora}</span></div>`:''}
      </div>
      ${cargaBlock}
      ${p.notas?`<div class="notes">💬 ${p.notas}</div>`:''}
    </div>

  </div>`;
}

function renderTable(filtered) {
  if (!filtered.length) { document.getElementById('tableArea').innerHTML=`<div class="empty"><div class="empty-icon">📭</div><div class="empty-txt">Sin resultados</div></div>`; return; }
  // Pre-calcular matrículas compartidas en este filtered
  const _matCount={};
  filtered.forEach(p=>{ const m=(p.mat1||'').trim().toUpperCase(); if(m) _matCount[m]=(_matCount[m]||0)+1; });
  const _matMulti=new Set(Object.keys(_matCount).filter(m=>_matCount[m]>1));
  const showStatus = activeTab==='todos';
  const statusLabel={pendiente:'Confección',terminado:'Terminado',revision:'Revisión',cargado:'Cargado'};
  const statusColor={pendiente:'var(--status-pend)',terminado:'var(--sap-blue)',revision:'var(--status-rev)',cargado:'var(--status-load)'};
  let _lastMat_tbl = null;
  const rows=filtered.map(p=>{
    const isCargado = p.status==='cargado';
    const terminarBtn = (p.status==='pendiente'||p.status==='revision')
      ? `<button class="tbl-btn" data-action="terminar" data-id="${p.id}" title="Marcar como terminado" style="background:rgba(0,80,179,0.10);color:var(--sap-blue);border-color:rgba(0,80,179,0.25)">✅</button>`
      : '';
    const cargarBtn = isCargado
      ? `<button class="tbl-btn tbl-reabrir" data-action="reabrir" data-id="${p.id}" title="Reabrir">↩️</button>`
      : `<button class="tbl-btn tbl-cargar" data-action="cargar" data-id="${p.id}" title="Cargar">🚛</button>`;
    const _mat_tbl = (p.mat1||'').trim().toUpperCase();
    const _esCamion = _mat_tbl && _matMulti.has(_mat_tbl);
    const colSpanCab = showStatus ? 13 : 12;
    const camionHeaderRow = (_esCamion && _mat_tbl !== _lastMat_tbl)
      ? `<tr class="camion-tbl-header"><td colspan="${colSpanCab}" style="padding:5px 12px;background:linear-gradient(90deg,rgba(42,111,176,0.18) 0%,transparent 100%);border-left:3px solid #2A6FB0;font-size:10px;font-weight:700;color:#2A6FB0;letter-spacing:.5px;text-transform:uppercase">🚛 ${p.mat1.trim()}${p.mat2?' · '+p.mat2.trim():''} — mismo camión</td></tr>`
      : '';
    _lastMat_tbl = _esCamion ? _mat_tbl : null;
    const rowHtml = `<tr>
    <td style="color:var(--t3);font-weight:700">${p.num||'—'}</td>
    <td style="font-weight:700;color:var(--t1)">${p.grupo||'—'}</td>
    <td style="color:var(--sap-blue)">${p.producto||'—'}</td>
    <td>${p.ref||'—'}</td>
    <td style="color:var(--status-load);font-weight:700">${p.uds||'—'}</td>
    <td style="color:var(--status-rev);font-weight:700">${p.mat1||'—'}</td>
    <td style="color:#6A1B9A;font-weight:700">${p.mat2||'—'}</td>
    <td style="color:var(--status-load);font-weight:700">${p.hora||'—'}</td>
    <td style="color:var(--status-rev);font-weight:700">${p.hora_salida||'—'}</td>
    <td style="color:var(--sap-blue)">${p.muelle||'—'}</td>
    <td>${p.transportista||'—'}</td>
    ${showStatus?`<td style="color:${statusColor[p.status]||'var(--t2)'};font-weight:700">${statusLabel[p.status]||p.status||'—'}</td>`:''}
    <td class="tbl-actions-cell">
      <button class="tbl-btn tbl-edit" data-action="edit" data-id="${p.id}" title="Editar">✏️</button>
      ${terminarBtn}
      ${cargarBtn}
      <button class="tbl-btn tbl-del" data-action="del" data-id="${p.id}" title="Eliminar">🗑️</button>
    </td>
  </tr>`;
    return camionHeaderRow + rowHtml;
  }).join('');
  const thStatus = showStatus ? `<th>Estado</th>` : '';
  document.getElementById('tableArea').innerHTML=`<div class="table-wrap"><table style="min-width:900px"><thead><tr><th>#</th><th>Cliente</th><th>Producto</th><th>Ref</th><th>Palets</th><th>Tractora</th><th>Remolque</th><th>H. Carga</th><th>H. Salida</th><th>Muelle</th><th>Transportista</th>${thStatus}<th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

document.addEventListener('click', function(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-action');
  const id = btn.getAttribute('data-id');
  if (action === 'edit')    openPedidoModal(id);
  if (action === 'edit-hist') openPedidoModalHist(id);
  if (action === 'terminar') terminarPedido(id);
  if (action === 'cargar')  openCargarModal(id);
  if (action === 'del')     delPedido(id);
  if (action === 'reabrir') reabrir(id);
});

function openPedidoModal(idOrNull) {
  const p = idOrNull ? pedidos.find(x=>String(x.id)===String(idOrNull)) : null;
  editId = p ? p.id : null;
  document.getElementById('mPedidoTitle').textContent = p ? '✏️ Editar pedido' : '📦 Nuevo pedido';
  // Mostrar botón Copiar solo cuando se edita un pedido existente
  const btnCopiar = document.getElementById('btnCopiarPedido');
  if (btnCopiar) btnCopiar.style.display = p ? '' : 'none';
  ['num','grupo','producto','ref','uds','cajas','cpp','totalcajas','formato','pais','mat1','mat2','hora','hora_salida','muelle','transportista','notas','ec','ed'].forEach(k => {
    const fid = k==='hora_salida'?'f-hora-salida':'f-'+k;
    const el = document.getElementById(fid); if(el) el.value = p?.[k]||'';
  });
  const fUdsCaja = document.getElementById('f-udscaja'); if (fUdsCaja) fUdsCaja.value = p?.udsCaja||'';
  actualizarAvisoStock();
  // Cargar productos extra (multi-producto)
  cargarProductosExtra(p?.productosExtra||[]);
  _setProdRefMain(p?.prodRef||'');
  document.getElementById('f-status').value = p?.status||'pendiente';
  document.getElementById('f-fecha').value  = p?.fecha||new Date().toISOString().slice(0,10);
  // Restaurar checkbox "Sin intercambio" y el campo albarán
  const sinIntEl = document.getElementById('f-sin-intercambio');
  if(sinIntEl) sinIntEl.checked = p?.sinIntercambio||false;
  const albaranEl = document.getElementById('f-albaran-pedido');
  if(albaranEl) albaranEl.value = p?.albaran||'';
  // Mostrar/ocultar campo albarán según ED o sinIntercambio
  actualizarVisibilidadAlbaran();
  document.getElementById('mPedido').classList.add('open');
  setTimeout(()=>{ document.querySelector('#mPedido .modal-scroll').scrollTop=0; },50);
  // Resetear aviso de referencia duplicada
  const warnEl = document.getElementById('ref-dup-warn');
  if (warnEl) warnEl.style.display = 'none';
}
function closePedidoModal() { document.getElementById('mPedido').classList.remove('open'); editId=null; if(window._histModalCleanup){ window._histModalCleanup(); window._histModalCleanup=null; } }

function duplicarPedido() {
  // Capturar el pedido origen (el que está abierto en edición)
  const origen = editId ? pedidos.find(x=>String(x.id)===String(editId)) : null;
  if (!origen) return;
  confirm2('📋', '¿Copiar pedido?',
    `Se creará un pedido nuevo con los mismos datos que #${origen.num||'—'} (${origen.grupo||'—'}).\n\nSe limpiarán: Nº Pedido, Referencia, Fecha (hoy) y estado (Confección).`,
    '📋 Copiar', '',
    () => {
      // Cerrar el modal actual
      closePedidoModal();
      // Preparar copia: mismos datos menos campos que deben ser únicos
      const copia = { ...origen };
      // Limpiar campos únicos/no reutilizables
      delete copia.id;
      delete copia.createdAt;
      delete copia.cargadoAt;
      copia.num     = '';           // Nº pedido vacío
      copia.ref     = '';           // Referencia vacía (casi siempre distinta)
      copia.status  = 'pendiente';  // Siempre comienza en Confección
      copia.fecha   = new Date().toISOString().slice(0,10); // Hoy
      copia.notas   = '';           // Notas limpias
      copia.albaran = '';
      copia.sinIntercambio = false;
      copia.ec      = 0;
      copia.ed      = 0;
      copia.udsCargados = 0;
      copia.cajasCargadas = 0;
      copia.cargasHistorial = [];
      copia.productosExtra = (copia.productosExtra||[]).map(pe => ({...pe, udsCargados:0, cajasCargados:0}));
      // Abrir modal como nuevo pedido con los datos de la copia
      editId = null;
      document.getElementById('mPedidoTitle').textContent = '📦 Nuevo pedido (copia)';
      const btnCopiar = document.getElementById('btnCopiarPedido');
      if (btnCopiar) btnCopiar.style.display = 'none';
      // Rellenar campos
      const campos = ['num','grupo','producto','ref','uds','cajas','cpp','totalcajas','formato','pais','mat1','mat2','hora','hora_salida','muelle','transportista','notas','ec','ed'];
      campos.forEach(k => {
        const fid = k==='hora_salida' ? 'f-hora-salida' : 'f-'+k;
        const el = document.getElementById(fid);
        if (el) el.value = copia[k] != null ? copia[k] : '';
      });
      const fUdsCaja = document.getElementById('f-udscaja'); if (fUdsCaja) fUdsCaja.value = copia.udsCaja||'';
      document.getElementById('f-fecha').value   = copia.fecha;
      document.getElementById('f-status').value  = copia.status;
      actualizarAvisoStock();
      const sinIntEl = document.getElementById('f-sin-intercambio');
      if (sinIntEl) sinIntEl.checked = false;
      const albaranEl = document.getElementById('f-albaran-pedido');
      if (albaranEl) albaranEl.value = '';
      const blAlb = document.getElementById('bloque-albaran-pedido');
      if (blAlb) blAlb.style.display = 'none';
      cargarProductosExtra(copia.productosExtra || []);
      actualizarVisibilidadAlbaran();
      const warnEl = document.getElementById('ref-dup-warn');
      if (warnEl) warnEl.style.display = 'none';
      document.getElementById('mPedido').classList.add('open');
      setTimeout(()=>{ document.querySelector('#mPedido .modal-scroll').scrollTop=0; },50);
      toast('📋 Datos copiados — ajusta los campos y guarda');
    }
  );
}
function openPedidoModalHist(id) {
  openPedidoModal(id);
  // Marcar que es edición histórica para que savePedido no cambie el status
  document.getElementById('mPedidoTitle').textContent = '✏️ Corregir datos (Histórico)';
  // Fijar status en "cargado" y deshabilitar el selector
  const sel = document.getElementById('f-status');
  sel.value = 'cargado';
  sel.disabled = true;
  // Cuando se cierre el modal, rehabilitar el selector
  const orig = window._histModalCleanup;
  window._histModalCleanup = () => { sel.disabled = false; if(orig) orig(); };
}


function actualizarVisibilidadAlbaran(){
  const bloque = document.getElementById('bloque-albaran-pedido');
  if(bloque) bloque.style.display = 'none';
}
window.actualizarVisibilidadAlbaran = actualizarVisibilidadAlbaran;

function _esc(v){ return (v==null?'':String(v)).replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }


// ── Sistema de productos extra (multi-producto por pedido) ──
let _productoIdx = 0;

function addProductoExtra(datos) {
  const idx = _productoIdx++;
  const container = document.getElementById('productos-extra-container');
  const v = datos || {};
  const div = document.createElement('div');
  div.className = 'producto-fila producto-extra';
  div.dataset.idx = idx;
  // Contadores de lo ya cargado de este producto extra (se conservan aunque se reedite/guarde el formulario)
  div.dataset.udscargados = v.udsCargados || 0;
  div.dataset.cajascargados = v.cajasCargados || 0;
  div.style.marginTop = '12px';
  div.style.paddingTop = '12px';
  div.style.borderTop = '1px dashed var(--border2)';
  div.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:4px">
      <button type="button" class="linea-del" onclick="removeProductoExtra(this)" title="Eliminar producto">✕</button>
    </div>
    <div class="fgrid">
      <div class="fg"><label>📦 Producto</label><input class="pe-producto" placeholder="Naranja, Espárrago..." list="dl-productos" autocomplete="off" value="${_esc(v.producto)}" oninput="actualizarAvisoStock()"></div>
      <div class="fg"><label>Palets</label><input class="pe-uds" placeholder="10" inputmode="numeric" value="${_esc(v.uds)}" oninput="actualizarAvisoStock()"></div>
    </div>
    <div class="fgrid" style="margin-top:8px">
      <div class="fg"><label>📦 Cajas</label><input class="pe-cajas" placeholder="0" inputmode="numeric" value="${_esc(v.cajas)}" oninput="actualizarAvisoStock()"></div>
      <div class="fg"><label>🔖 Producción</label><select class="pe-prod" data-want="${_esc(v.prodRef)}" onchange="this.dataset.want=this.value;actualizarAvisoStock()"><option value="">— Sin asignar —</option></select></div>
      <div class="fg"><label>🍶 Formato</label><input class="pe-formato" placeholder="Botella 1 lt, Brick 500..." list="dl-formatos" autocomplete="off" value="${_esc(v.formato)}" oninput="actualizarAvisoStock()"></div>
      <div class="fg"><label>📦 Cajas por palet</label><input class="pe-cpp" placeholder="0" inputmode="numeric" value="${_esc(v.cpp)}" oninput="actualizarAvisoStock()"></div>
      <div class="fg"><label>🧮 Total cajas</label><input class="pe-totalcajas" placeholder="0" readonly tabindex="-1" style="font-weight:800" value="${_esc(v.totalCajas)}"></div>
      <div class="fg"><label>🔢 Uds./caja</label><input class="pe-udscaja" placeholder="Bricks o botellas" inputmode="numeric" value="${_esc(v.udsCaja)}" oninput="actualizarAvisoStock()"></div>
      <div class="fg"><label>🧮 Total unidades</label><input class="pe-totalunidades" placeholder="0" readonly tabindex="-1" style="font-weight:800" value="${_esc(v.totalUnidades)}"></div>
    </div>
    <div class="fgrid" style="margin-top:8px">
      <div class="fg"><label>País</label><input class="pe-pais" placeholder="España, Francia..." list="dl-paises" autocomplete="off" value="${_esc(v.pais)}"></div>
    </div>`;
  container.appendChild(div);
}

function removeProductoExtra(btn) {
  btn.closest('.producto-extra').remove();
}

function getProductosExtra() {
  return [...document.querySelectorAll('#productos-extra-container .producto-extra')].map(el => ({
    producto:    el.querySelector('.pe-producto')?.value.trim()||'',
    uds:         el.querySelector('.pe-uds')?.value.trim()||'',
    cajas:       el.querySelector('.pe-cajas')?.value.trim()||'',
    prodRef:     el.querySelector('.pe-prod')?.dataset.want||'',
    formato:     el.querySelector('.pe-formato')?.value.trim()||'',
    cpp:         el.querySelector('.pe-cpp')?.value.trim()||'',
    totalCajas:  el.querySelector('.pe-totalcajas')?.value.trim()||'',
    udsCaja:     el.querySelector('.pe-udscaja')?.value.trim()||'',
    totalUnidades: el.querySelector('.pe-totalunidades')?.value.trim()||'',
    pais:        el.querySelector('.pe-pais')?.value.trim()||'',
    udsCargados: parseFloat(el.dataset.udscargados)||0,
    cajasCargados: parseFloat(el.dataset.cajascargados)||0,
  })).filter(p => p.producto||p.uds||p.cajas||p.pais);
}

function cargarProductosExtra(productosExtra) {
  const container = document.getElementById('productos-extra-container');
  container.innerHTML = '';
  _productoIdx = 0;
  (productosExtra||[]).forEach(p => addProductoExtra(p));
}

window.addProductoExtra = addProductoExtra;
window.removeProductoExtra = removeProductoExtra;

// Compara palets/cajas solicitados en el pedido (producto principal + productos extra) contra el stock disponible
// Total cajas = palets × cajas por palet + cajas sueltas (se calcula solo)
function _totCajas(pal,cpp,caj){ return (parseFloat(pal)||0)*(parseFloat(cpp)||0)+(parseFloat(caj)||0); }
function calcTotalesCajas() {
  const g=id=>document.getElementById(id);
  const totMain = _totCajas(g('f-uds')?.value,g('f-cpp')?.value,g('f-cajas')?.value);
  if (g('f-totalcajas')) g('f-totalcajas').value = totMain||'';
  if (g('f-totalunidades')) g('f-totalunidades').value = (totMain * (parseFloat(g('f-udscaja')?.value)||0))||'';
  document.querySelectorAll('#productos-extra-container .producto-extra').forEach(el=>{
    const totExtra = _totCajas(el.querySelector('.pe-uds')?.value,el.querySelector('.pe-cpp')?.value,el.querySelector('.pe-cajas')?.value);
    const t=el.querySelector('.pe-totalcajas');
    if (t) t.value = totExtra||'';
    const tu=el.querySelector('.pe-totalunidades');
    if (tu) tu.value = (totExtra * (parseFloat(el.querySelector('.pe-udscaja')?.value)||0))||'';
  });
}
function actualizarAvisoStock() {
  calcTotalesCajas();
  refrescarProdSelects();
  const aviso = document.getElementById('aviso-stock');
  if (!aviso) return;
  const lineas = [
    { articulo: document.getElementById('f-producto')?.value.trim(), formato: document.getElementById('f-formato')?.value.trim()||'', prod: document.getElementById('f-prodRef')?.dataset.want||'', pal: parseFloat(document.getElementById('f-uds')?.value)||0, caj: parseFloat(document.getElementById('f-cajas')?.value)||0 },
    ...[...document.querySelectorAll('#productos-extra-container .producto-extra')].map(el => ({
      articulo: el.querySelector('.pe-producto')?.value.trim()||'',
      formato: el.querySelector('.pe-formato')?.value.trim()||'',
      prod: el.querySelector('.pe-prod')?.dataset.want||'',
      pal: parseFloat(el.querySelector('.pe-uds')?.value)||0,
      caj: parseFloat(el.querySelector('.pe-cajas')?.value)||0
    }))
  ];
  const filas = lineas
    .filter(l => l.articulo && producciones.some(p => (p.articulo||'').trim().toUpperCase() === l.articulo.toUpperCase()))
    .map(l => {
      const s = stockDisponible(l.articulo, l.formato, l.prod);
      const pc = planConsumo(l.articulo, l.pal, l.caj, l.formato, editId, l.prod, true); const falta = pc.faltaPal>0 || pc.faltaCaj>0;
      const sinCpp = producciones.some(x => (x.articulo||'').trim().toUpperCase()===l.articulo.toUpperCase() && !(parseFloat(x.cajasPorPalet)>0));
      const ep = stockEnProceso(l.articulo, l.formato, l.prod);
      return { ...l, s, falta, sinCpp, ep };
    });
  if (!filas.length) { aviso.style.display = 'none'; return; }
  const hayFalta = filas.some(f => f.falta);
  aviso.style.display = '';
  aviso.style.background = hayFalta ? 'rgba(220,53,69,0.12)' : 'rgba(40,167,69,0.12)';
  aviso.style.color = hayFalta ? '#B02A37' : '#1E7E34';
  aviso.innerHTML = filas.map(f => {
    const epTxt = [f.ep.llenado>0 ? `${_fmtN(f.ep.llenado)} sin etiquetar` : '', f.ep.etiquetado>0 ? `${_fmtN(f.ep.etiquetado)} sin encajar` : ''].filter(Boolean).join(' + ');
    return `${f.falta?'⚠️ Stock insuficiente':'✅ Stock disponible'} de "${f.articulo}${f.formato?' · '+f.formato:''}${f.prod?' · '+f.prod:''}": ${f.s.palets} pal. / ${f.s.cajas} cajas${f.falta&&f.sinCpp?' · EDITA EL LOTE (✏️) Y ANOTA LAS CAJAS POR PALET':''}${epTxt?` · 🧃 Además hay ${epTxt}`:''}`;
  }).join('<br>');
}
window.actualizarAvisoStock = actualizarAvisoStock;

function checkRefDuplicado() {
  const ref = document.getElementById('f-ref').value.trim();
  const warn = document.getElementById('ref-dup-warn');
  if (!warn) return false;
  if (!ref) { warn.style.display = 'none'; return false; }
  const duplicado = pedidos.some(p =>
    p.ref && p.ref.trim().toLowerCase() === ref.toLowerCase() &&
    String(p.id) !== String(editId)
  );
  warn.style.display = duplicado ? '' : 'none';
  return duplicado;
}

async function savePedido() {
  const get = id => (document.getElementById(id)?.value||'').trim().toUpperCase();
  const id = editId || String(Date.now() + Math.floor(Math.random()*1000));
  const p = {
    id, createdAt: editId ? (pedidos.find(x=>x.id===editId)?.createdAt || Date.now()) : Date.now(),
    num:get('f-num'), grupo:get('f-grupo'), producto:get('f-producto'), ref:get('f-ref'),
    uds:get('f-uds'), cajas:get('f-cajas'), cpp:get('f-cpp'), totalCajas:get('f-totalcajas'), udsCaja:get('f-udscaja'), totalUnidades:get('f-totalunidades'), formato:get('f-formato'), prodRef:(document.getElementById('f-prodRef')?.dataset.want||''), pais:get('f-pais'),
    mat1:get('f-mat1'), mat2:get('f-mat2'),
    hora:(document.getElementById('f-hora')?.value||''),
    hora_salida:(document.getElementById('f-hora-salida')?.value||''),
    muelle:get('f-muelle'), transportista:get('f-transportista'),
    status:document.getElementById('f-status').value,
    fecha:document.getElementById('f-fecha').value,
    notas:get('f-notas'),
    ec: editId ? (pedidos.find(x=>String(x.id)===String(editId))?.ec||0) : 0,
    ed: editId ? (pedidos.find(x=>String(x.id)===String(editId))?.ed||0) : 0,
    productosExtra: getProductosExtra(),
  };
  if(!p.grupo){ toast('⚠️ Indica el cliente'); return; }
  // Comprobar referencia duplicada
  if (p.ref) {
    const dupPedido = pedidos.find(x =>
      x.ref && x.ref.trim().toLowerCase() === p.ref.trim().toLowerCase() &&
      String(x.id) !== String(editId)
    );
    if (dupPedido) {
      confirm2('⚠️', 'Referencia duplicada',
        `La referencia <strong>${p.ref}</strong> ya existe en el pedido #${dupPedido.num || '—'} (${dupPedido.grupo || '—'}).<br><br>¿Guardar igualmente?`,
        'Guardar', 'Cancelar',
        async () => { await _doSavePedido(p); }
      );
      return;
    }
  }
  await _doSavePedido(p);
}

async function guardarPedidoYMovimientoAtomico(p){
  p=_cpClean(_cpAudit(cpNormalizePedido(p), 'pedido_guardado'));
  if(!currentUser) throw new Error('Sesión no disponible');
  setSyncStatus('saving');
  await col.doc(String(p.id)).set(p,{merge:false});
  await registrarAuditoria('pedido_guardado','pedidos',p.id,p.num||p.grupo||'');
  setSyncStatus('ok');
}

async function _doSavePedido(p) {
  const sinIntercambio = !!document.getElementById('f-sin-intercambio')?.checked;
  p.sinIntercambio = sinIntercambio;
  const tieneED = (parseInt((document.getElementById('f-ed')?.value||'').trim()))||0;
  if(tieneED || sinIntercambio){
    const albaranVal = (document.getElementById('f-albaran-pedido')?.value||'').trim();
    if(albaranVal) p.albaran = albaranVal;
  }
  closePedidoModal();
  try {
    await guardarPedidoYMovimientoAtomico(p);
    toast(editId ? '✏️ Pedido actualizado' : '✅ Pedido creado');
  } catch(e) {
    console.error('Guardado del pedido:',e);
    setSyncStatus('offline');
    const code=e?.code||'';
    const detail=code==='permission-denied'?'Permisos insuficientes. Publica las reglas actualizadas.':(code==='unavailable'?'Sin conexión: el cambio quedará pendiente si Firebase tiene caché activa.':(e?.message||'Error desconocido'));
    toast('❌ No se pudo guardar: '+detail,6500);
  }
}

function limpiarPedidoModal() {
  confirm2('🗑','¿Limpiar formulario?','Se borrarán todos los campos','Limpiar','',()=>{
    ['num','grupo','producto','ref','uds','cajas','cpp','totalcajas','udscaja','totalunidades','formato','pais','mat1','mat2','muelle','transportista','notas','ec','ed'].forEach(k=>{ const el=document.getElementById('f-'+k); if(el) el.value=''; });
    const avisoStockEl = document.getElementById('aviso-stock'); if(avisoStockEl) avisoStockEl.style.display='none';
    cargarProductosExtra([]);
    _setProdRefMain('');
    const sinInt = document.getElementById('f-sin-intercambio'); if(sinInt) sinInt.checked=false;
    const fAlb = document.getElementById('f-albaran-pedido'); if(fAlb) fAlb.value='';
    const blAlb = document.getElementById('bloque-albaran-pedido'); if(blAlb) blAlb.style.display='none';
    const fHora = document.getElementById('f-hora'); if(fHora) fHora.value='';
    const fHoraSalida = document.getElementById('f-hora-salida'); if(fHoraSalida) fHoraSalida.value='';
    document.getElementById('f-status').value='pendiente';
    document.getElementById('f-fecha').value=new Date().toISOString().slice(0,10);
  });
}

function openCargarModal(id) {
  cargarId=id;
  const p=pedidos.find(x=>String(x.id)===String(id));
  document.getElementById('mCargarInfo').textContent=[p.num?'#'+p.num:'',p.grupo||'',p.producto||'',p.ref].filter(Boolean).join(' · ');
  document.getElementById('c-hora').value=p.hora||new Date().toTimeString().slice(0,5);
  document.getElementById('c-muelle').value=p.muelle||'';
  document.getElementById('c-transportista').value=p.transportista||'';
  document.getElementById('c-mat1').value=p.mat1||'';
  document.getElementById('c-mat2').value=p.mat2||'';
  document.getElementById('c-notas').value='';
  document.getElementById('c-hora-salida').value=new Date().toTimeString().slice(0,5);
  renderCargaProductosLista(p);
  document.getElementById('mCargar').classList.add('open');
  setTimeout(()=>{ document.querySelector('#mCargar .modal-scroll').scrollTop=0; },50);
}
function closeCargarModal() { document.getElementById('mCargar').classList.remove('open'); cargarId=null; }

// Construye la lista de líneas a cargar: el producto principal ('main') + cada producto extra (0,1,2...)
function _cargaLineasDe(p) {
  const lineas = [{ idx:'main', producto:p.producto||'', formato:p.formato||'', prodRef:p.prodRef||'', total:parseInt(p.uds)||0, totalCaj:parseInt(p.cajas)||0, cargado:parseInt(p.udsCargados)||0, cargadoCaj:parseInt(p.cajasCargadas)||0 }];
  (p.productosExtra||[]).forEach((pe,i) => {
    lineas.push({ idx:String(i), producto:pe.producto||'', formato:pe.formato||'', prodRef:pe.prodRef||'', total:parseInt(pe.uds)||0, totalCaj:parseInt(pe.cajas)||0, cargado:parseInt(pe.udsCargados)||0, cargadoCaj:parseInt(pe.cajasCargados)||0 });
  });
  return lineas.filter(l => l.producto || l.total || l.totalCaj);
}

// Pinta un bloque de palets/cajas por cada línea de producto del pedido (multi-producto)
function renderCargaProductosLista(p) {
  const cont = document.getElementById('c-productos-lista');
  const lineas = _cargaLineasDe(p);
  cont.innerHTML = lineas.map(l => {
    const restantePal = l.total>0 ? Math.max(l.total-l.cargado,0) : 0;
    const restanteCaj = l.totalCaj>0 ? Math.max(l.totalCaj-l.cargadoCaj,0) : 0;
    const valPal = l.total>0 ? restantePal : '';
    const valCaj = l.totalCaj>0 ? restanteCaj : '';
    return `<div class="c-linea-carga" data-lineidx="${l.idx}" data-producto="${_esc(l.producto)}" data-formato="${_esc(l.formato)}" data-prodref="${_esc(l.prodRef)}" data-total="${l.total}" data-totalcaj="${l.totalCaj}" data-cargado="${l.cargado}" data-cargadocaj="${l.cargadoCaj}" style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px dashed var(--border2)">
      <div style="font-weight:700;font-size:12.5px;margin-bottom:4px">📦 ${l.producto||'(sin producto)'}</div>
      <div class="fgrid">
        <div class="fg"><label>🟧 Palets en esta carga</label><input class="c-linea-pal" type="number" min="0" inputmode="numeric" placeholder="0" value="${valPal}" oninput="actualizarRestanteCarga()"></div>
        <div class="fg"><label>📦 Cajas en esta carga</label><input class="c-linea-caj" type="number" min="0" inputmode="numeric" placeholder="0" value="${valCaj}" oninput="actualizarRestanteCarga()"></div>
      </div>
      <div class="c-linea-info" style="font-size:11px;color:var(--t3);margin-top:4px"></div>
    </div>`;
  }).join('');
  actualizarRestanteCarga();
}

function actualizarRestanteCarga() {
  document.querySelectorAll('#c-productos-lista .c-linea-carga').forEach(el => {
    const total = parseInt(el.dataset.total)||0;
    const totalCaj = parseInt(el.dataset.totalcaj)||0;
    const cargado = parseInt(el.dataset.cargado)||0;
    const cargadoCaj = parseInt(el.dataset.cargadocaj)||0;
    const info = el.querySelector('.c-linea-info');
    if (!info) return;
    if (!total && !totalCaj) { info.textContent = ''; return; }
    const estaPal = parseInt(el.querySelector('.c-linea-pal').value)||0;
    const estaCaj = parseInt(el.querySelector('.c-linea-caj').value)||0;
    const partes = [];
    if (total) {
      const restante = Math.max(total-cargado-estaPal, 0);
      partes.push(`Palets: <b>${total}</b> pedido · ${cargado} cargados · quedarán <b style="color:${restante>0?'var(--status-rev)':'var(--status-load)'}">${restante}</b>`);
    }
    if (totalCaj) {
      const restanteCaj = Math.max(totalCaj-cargadoCaj-estaCaj, 0);
      partes.push(`Cajas: <b>${totalCaj}</b> pedido · ${cargadoCaj} cargadas · quedarán <b style="color:${restanteCaj>0?'var(--status-rev)':'var(--status-load)'}">${restanteCaj}</b>`);
    }
    info.innerHTML = partes.join('<br>');
  });
}
window.actualizarRestanteCarga = actualizarRestanteCarga;

async function confirmarCarga() {
  const p=pedidos.find(x=>String(x.id)===String(cargarId)); if(!p) return;
  const ec = 0;
  const ed = 0;

  // Recorremos cada línea de producto del pedido (principal + extra), controlando su propio
  // restante y descontando su propio stock. El pedido se da por "completo" solo cuando TODAS
  // las líneas han llegado a su total.
  const bloques = [...document.querySelectorAll('#c-productos-lista .c-linea-carga')];
  let completoGlobal = true;
  let lotesConsumidosTotal = [];
  const consumos = [];
  const resumenPartes = [];
  const productosExtraActualizados = (p.productosExtra||[]).map(pe=>({...pe}));
  let mainUpdate = {};

  for (const el of bloques) {
    const idx = el.dataset.lineidx;
    const producto = el.dataset.producto;
    const total = parseInt(el.dataset.total)||0;
    const totalCaj = parseInt(el.dataset.totalcaj)||0;
    const cargado = parseInt(el.dataset.cargado)||0;
    const cargadoCaj = parseInt(el.dataset.cargadocaj)||0;
    const estaPal = parseInt(el.querySelector('.c-linea-pal').value)||0;
    const estaCaj = parseInt(el.querySelector('.c-linea-caj').value)||0;

    const nuevoTotal = total>0 ? Math.min(cargado+estaPal, total) : (cargado+estaPal);
    const nuevoTotalCaj = totalCaj>0 ? Math.min(cargadoCaj+estaCaj, totalCaj) : (cargadoCaj+estaCaj);
    const palOk = total>0 ? nuevoTotal >= total : true;
    const cajOk = totalCaj>0 ? nuevoTotalCaj >= totalCaj : true;
    if (!(palOk && cajOk)) completoGlobal = false;

    // Se acumulan todas las líneas; el stock se consume una sola vez más abajo.
    if (producto && (estaPal>0 || estaCaj>0)) {
      consumos.push({producto,palets:estaPal,cajas:estaCaj,formato:el.dataset.formato||'',prodRef:el.dataset.prodref||''});
    }
    if (estaPal>0 || estaCaj>0) {
      const txt = [estaPal?`${estaPal} pal.`:'', estaCaj?`${estaCaj} cajas`:''].filter(Boolean).join(' ');
      resumenPartes.push(`${producto}: ${txt}`);
    }

    if (idx === 'main') {
      mainUpdate = { udsCargados: nuevoTotal, cajasCargadas: nuevoTotalCaj };
    } else {
      const i = parseInt(idx);
      if (productosExtraActualizados[i]) {
        productosExtraActualizados[i] = { ...productosExtraActualizados[i], udsCargados: nuevoTotal, cajasCargados: nuevoTotalCaj };
      }
    }
  }

  const mat1Carga = document.getElementById('c-mat1').value.trim().toUpperCase();
  const mat2Carga = document.getElementById('c-mat2').value.trim().toUpperCase();

  const registroCarga = {
    fecha: new Date().toISOString().slice(0,10),
    detalle: resumenPartes.join(' · '),
    hora: document.getElementById('c-hora').value,
    hora_salida: document.getElementById('c-hora-salida').value,
    muelle: document.getElementById('c-muelle').value.trim(),
    transportista: document.getElementById('c-transportista').value.trim(),
    mat1: mat1Carga, mat2: mat2Carga,
    lotesConsumidos: lotesConsumidosTotal
  };
  // Compatibilidad con el historial anterior (una sola línea): guardamos también palets/cajas de la principal
  const lineaMain = bloques.find(el=>el.dataset.lineidx==='main');
  if (lineaMain) {
    registroCarga.palets = parseInt(lineaMain.querySelector('.c-linea-pal').value)||0;
    registroCarga.cajas = parseInt(lineaMain.querySelector('.c-linea-caj').value)||0;
  }

  const updated={...p,
    status: completoGlobal ? 'cargado' : p.status,
    ...mainUpdate,
    productosExtra: productosExtraActualizados,
    cargasHistorial: [...(p.cargasHistorial||[]), registroCarga],
    ...(completoGlobal ? {cargadoAt: new Date().toISOString().slice(0,10)} : {}),
    hora:document.getElementById('c-hora').value,
    hora_salida:document.getElementById('c-hora-salida').value,
    muelle:document.getElementById('c-muelle').value.trim(),
    transportista:document.getElementById('c-transportista').value.trim(),
    mat1: mat1Carga, mat2: mat2Carga,
    ec: ec, ed: ed
  };
  const n2=document.getElementById('c-notas').value.trim();
  if(n2) updated.notas=p.notas?p.notas+' | '+n2:n2;
  try {
    setSyncStatus('saving');
    const orderRef=col.doc(String(p.id));
    await db.runTransaction(async tx=>{
      // Esta lectura hace que Firestore detecte cualquier edición concurrente del pedido.
      const orderSnap=await tx.get(orderRef);
      if(!orderSnap.exists) throw new Error('El pedido ya no existe; vuelve a intentarlo');
      lotesConsumidosTotal=await consumirStockMulti(consumos,p.id,tx);
      lotesConsumidosTotal.forEach(u=>{u.producto=u.producto||'';});
      registroCarga.lotesConsumidos=lotesConsumidosTotal;
      const finalUpdated={...updated,cargasHistorial:[...(p.cargasHistorial||[]),registroCarga]};
      tx.set(orderRef,_cpAudit(finalUpdated,'pedido_cargado'));
    });
    setSyncStatus('ok');
  } catch(err) {
    console.error('Carga atómica:',err);
    setSyncStatus('offline');
    toast('❌ No se confirmó la carga: '+(err.message||err));
    return;
  }
  closeCargarModal();
  if (!completoGlobal) {
    toast(`🟡 Carga parcial: ${resumenPartes.join(' · ')||'registrada'}`);
  } else {
    toast(`🟢 Carga confirmada${ec||ed?` · EC:${ec} ED:${ed}`:''}`);
  }
}

function limpiarCargarModal() { ['c-hora','c-hora-salida','c-muelle','c-transportista','c-notas','c-ec','c-ed','c-mat1','c-mat2'].forEach(id=>{const el=document.getElementById(id); if(el) el.value='';}); const cont=document.getElementById('c-productos-lista'); if(cont) cont.innerHTML=''; }

function reabrir(id) {
  const p0=pedidos.find(x=>String(x.id)===String(id));
  const teniaCargas = p0 && (p0.udsCargados>0 || (p0.cargasHistorial||[]).length>0);
  const msg = teniaCargas
    ? 'Volverá al estado Confección. Se reiniciará el contador de palets cargados (' + (p0.udsCargados||0) + ') y el historial de cargas de este pedido.'
    : 'Volverá al estado Confección';
  confirm2('↩️','¿Reabrir pedido?',msg,'Reabrir','blue',async()=>{
    const p=pedidos.find(x=>String(x.id)===String(id)); if(!p) return;
    if ((p.cargasHistorial||[]).length) await revertirConsumoStock(p.cargasHistorial);
    if (typeof cpReabrirPedidoPalets==='function') await cpReabrirPedidoPalets(id,{eliminar:false});
    const productosExtraReset = (p.productosExtra||[]).map(pe => ({...pe, udsCargados:0, cajasCargados:0}));
    await fbSave({...p, status:'pendiente', udsCargados:0, cajasCargadas:0, productosExtra:productosExtraReset, cargasHistorial:[]});
    toast('↩️ Pedido reabierto' + (teniaCargas?' · Cargas y stock reiniciados':''));
  });
}

function terminarPedido(id) {
  const p=pedidos.find(x=>String(x.id)===String(id)); if(!p) return;
  fbSave({...p, status:'terminado'});
  toast('✅ Pedido marcado como Terminado');
}



function delPedido(id) {
  const p=pedidos.find(x=>String(x.id)===String(id));
  const teniaCargas = p && (p.cargasHistorial||[]).length>0;
  const msg = ((p?.grupo||'')+(p?.num?' #'+p.num:'')) + (teniaCargas?'\n\nSe devolverá al stock lo consumido por sus cargas.':'');
  confirm2('🗑','¿Eliminar pedido?',msg,'Eliminar','',async()=>{
    if (teniaCargas) await revertirConsumoStock(p.cargasHistorial);
    if (typeof cpReabrirPedidoPalets==='function') await cpReabrirPedidoPalets(id,{eliminar:true});
    await fbDelete(id);
    toast('🗑 Pedido eliminado' + (teniaCargas?' · Stock devuelto':''));
  });
}

function exportarCSV() {
  const headers=['#','Cliente','Producto','Referencia','Palets','País','Tractora','Remolque','Hora carga','Hora salida','Muelle','Transportista','Estado','Fecha','Notas'];
  const rows=pedidos.map(p=>[p.num,p.grupo,p.producto,p.ref,p.uds,p.pais,p.mat1,p.mat2,p.hora,p.hora_salida,p.muelle,p.transportista,p.status,p.fecha,p.notas].map(v=>`"${(v||'').replace(/"/g,'""')}"`).join(','));
  const csv=[headers.join(','),...rows].join('\n');
  const blob=new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='cargas_'+new Date().toISOString().slice(0,10)+'.csv'; a.click(); URL.revokeObjectURL(url);
  toast('📤 CSV exportado');
}

function _calcTotales(filtered) {
  let palets = 0;
  filtered.forEach(p => {
    palets += parseFloat((p.uds||'0').toString().replace(',','.')) || 0;
    (p.productosExtra||[]).forEach(pe => {
      palets += parseFloat((pe.uds||'0').toString().replace(',','.')) || 0;
    });
  });
  return { palets };
}

function _buildPrintHtml(tab, fecha, countTxt, tableHtml, totales) {
  // Strip action buttons column from the cloned table HTML
  const div = document.createElement('div');
  div.innerHTML = tableHtml;
  div.querySelectorAll('.tbl-actions-cell').forEach(el=>el.remove());
  div.querySelectorAll('th:last-child:empty').forEach(el=>el.remove());
  const cleanHtml = div.innerHTML;
  const totalesHtml = totales ? `
  <div style="margin:14px 0 0;padding:12px 16px;background:#F7F9FC;border:2px solid #4C93D6;border-radius:6px;display:flex;gap:32px;align-items:center">
    <div style="font-size:10px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-right:8px">TOTALES</div>
    <div><div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:.5px">Palets</div><div style="font-size:20px;font-weight:900;color:#1A1A1A;font-family:monospace">${totales.palets % 1 === 0 ? totales.palets : totales.palets.toFixed(1)}</div></div>
  </div>` : '';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Cargas Pro — ${tab}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;padding:18px;color:#1A1A1A;font-size:12px}
    .report-header{display:flex;align-items:center;gap:14px;border-bottom:3px solid #4C93D6;padding-bottom:10px;margin-bottom:6px}
    .report-logo{font-size:28px}
    .report-title{font-size:17px;font-weight:700;color:#333;letter-spacing:-.3px}
    .report-title span{color:#1a56c4}
    .report-meta{font-size:10px;color:#666;margin-top:2px;letter-spacing:.3px}
    .report-sub{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;font-size:10px;color:#888;border-bottom:1px solid #e0e0e0;padding-bottom:6px}
    .badge{background:#4C93D6;color:#333;font-weight:700;padding:2px 8px;border-radius:2px;font-size:10px;text-transform:uppercase;letter-spacing:.5px}
    .table-wrap{overflow:hidden;border-radius:4px;border:1px solid #ddd}
    table{width:100%;border-collapse:collapse;font-size:10px}
    th{background:#333;color:#fff;padding:7px 9px;text-align:left;font-size:8px;text-transform:uppercase;letter-spacing:1px;border-bottom:2px solid #4C93D6;white-space:nowrap}
    td{padding:7px 9px;border-bottom:1px solid #e8e8e8;white-space:nowrap}
    tr:nth-child(even) td{background:#f8f8f8}
    tr:last-child td{border-bottom:none}
    .report-footer{margin-top:10px;font-size:9px;color:#aaa;text-align:right}
    .lineas-row{display:table-row!important}
    .tbl-actions-cell,.tbl-btn{display:none!important}
    @media print{
      body{padding:8px}
      .no-print{display:none}
      @page{margin:10mm}
    }
  </style></head><body>
  <div class="report-header">
    <div class="report-logo">🚛</div>
    <div>
      <div class="report-title">Cargas<span>Pro</span> — ${tab}</div>
      <div class="report-meta">SAT GUADEX · Palma del Río · Generado el ${fecha}</div>
    </div>
  </div>
  <div class="report-sub">
    <span>${countTxt}</span>
    <span class="badge">${tab}</span>
  </div>
  <div class="table-wrap">${cleanHtml}</div>
  ${totalesHtml}
  <div class="report-footer">Cargas Pro © ${new Date().getFullYear()} · SAT GUADEX S.L.</div>
  </body></html>`;
}

function _getFilteredPedidos() {
  const q  = (document.getElementById('searchInput').value||'').toLowerCase();
  const gf = document.getElementById('fGrupo').value;
  const mf = document.getElementById('fMuelle').value;
  const pf = document.getElementById('fProducto').value;
  const fd = document.getElementById('fFechaDesde').value;
  const fh = document.getElementById('fFechaHasta').value;
  const hoy = new Date().toISOString().slice(0,10);
  const sm = {pendientes:'pendiente',terminado:'terminado',cargados:'cargado'};
  const ts = sm[activeTab];
  return pedidos.filter(p=>{
    const txt=[p.num,p.grupo,p.producto,p.ref,p.mat1,p.mat2,p.notas,p.pais,p.muelle,p.transportista].join(' ').toLowerCase();
    if(activeTab==='historico'){ const dc=cargDay(p); const fOk=(!fd||(dc&&dc>=fd))&&(!fh||(dc&&dc<=fh)); return p.status==='cargado' && dc && dc < hoy && (!q||txt.includes(q)) && (!gf||p.grupo===gf) && (!mf||p.muelle===mf) && (!pf||p.producto===pf) && fOk; }
    const fechaOk = (!fd||(p.fecha&&p.fecha>=fd))&&(!fh||(p.fecha&&p.fecha<=fh));
    let statusOk;
    if(activeTab==='todos') statusOk = !(p.status==='cargado' && cargDay(p) && cargDay(p) < hoy);
    else if(activeTab==='cargados') statusOk = p.status==='cargado' && (!cargDay(p) || cargDay(p) >= hoy);
    else statusOk = p.status===ts;
    return statusOk && (!q||txt.includes(q)) && (!gf||p.grupo===gf) && (!mf||p.muelle===mf) && (!pf||p.producto===pf) && fechaOk;
  });
}

function _showTotalesModal(onSi, onNo) {
  const bg = document.getElementById('totalesBg');
  bg.style.display = 'flex';
  document.getElementById('totalesSiBtn').onclick = () => { bg.style.display='none'; onSi(); };
  document.getElementById('totalesNoBtn').onclick = () => { bg.style.display='none'; onNo(); };
}

function imprimirTabla() {
  const fecha    = new Date().toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'});
  const tab      = {pendientes:'Confección',terminado:'Terminado',todos:'Todos',cargados:'Cargados',historico:'Histórico'}[activeTab]||'';
  const countTxt = document.getElementById('countLbl').textContent;
  const filtered = _getFilteredPedidos();

  if (activeView === 'cards') {
    // ── INFORME DE FICHAS (vista Tarjetas) ──
    function doImprimirFichas(conTotales) {
      const totales = conTotales ? _calcTotales(filtered) : null;
      const html = _buildCardsReportHtml(tab, fecha, countTxt, filtered, totales);
      const win = window.open('','_blank','width=960,height=700');
      win.document.write(html + `<script>window.onload=()=>{window.print();}<\/script>`);
      win.document.close();
    }
    _showTotalesModal(() => doImprimirFichas(true), () => doImprimirFichas(false));
  } else {
    // ── INFORME DE TABLA (vista Tabla) ──
    function doImprimir(conTotales) {
      const wasHidden = document.getElementById('tableArea').style.display==='none';
      if(wasHidden) document.getElementById('tableArea').style.display='';
      renderTable(filtered);
      const tableHtml = document.getElementById('tableArea').innerHTML;
      if(wasHidden) document.getElementById('tableArea').style.display='none';
      const totales = conTotales ? _calcTotales(filtered) : null;
      const html = _buildPrintHtml(tab, fecha, countTxt, tableHtml, totales);
      const win = window.open('','_blank','width=960,height=700');
      win.document.write(html + `<script>window.onload=()=>{window.print();}<\/script>`);
      win.document.close();
    }
    _showTotalesModal(() => doImprimir(true), () => doImprimir(false));
  }
}

function _buildCardsReportHtml(tab, fecha, countTxt, filtered, totales) {
  const statusColor = {pendiente:'#C07800',terminado:'#0066CC',revision:'#CC3D00',cargado:'#1A7A30'};
  const statusBg    = {pendiente:'#FFF8E6',terminado:'#E8F0FF',revision:'#FFF0E8',cargado:'#E8F7ED'};
  const statusBord  = {pendiente:'#1F6FB5',terminado:'#4A90D9',revision:'#D4520A',cargado:'#2DB650'};
  const statusLabel = {pendiente:'Confección',terminado:'Terminado',revision:'Revisión',cargado:'Cargado'};

  // Agrupar por cliente (mismo orden que la app)
  const groups = {};
  filtered.forEach(p => { const g = p.grupo||'—'; if(!groups[g]) groups[g]=[]; groups[g].push(p); });

  let cardsHtml = '';
  for (const [g, items] of Object.entries(groups)) {
    cardsHtml += `<div class="group-section">
      <div class="group-title">🏢 ${g} <span class="group-cnt">${items.length}</span></div>
      <div class="cards-grid">`;
    items.forEach(p => {
      const sc = statusColor[p.status]||'#888';
      const sb = statusBg[p.status]||'#fafafa';
      const sbo= statusBord[p.status]||'#ccc';
      const sl = statusLabel[p.status]||p.status;
      const fechaFmt = p.fecha ? new Date(p.fecha+'T00:00').toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit'}) : '';

      // Productos: principal + extras
      let productosHtml = '';
      const productosAll = [];
      if(p.producto || p.uds) productosAll.push({producto:p.producto,uds:p.uds,pais:p.pais});
      (p.productosExtra||[]).forEach(pe => productosAll.push(pe));
      if(productosAll.length) {
        productosHtml = productosAll.map(pr => {
          const parts = [];
          if(pr.producto) parts.push(`<strong>${pr.producto}</strong>`);
          if(pr.uds) parts.push(`${pr.uds} pal.`);
          if(pr.pais) parts.push(`${pr.pais}`);
          return `<div class="prod-line">${parts.join(' · ')}</div>`;
        }).join('');
      }

      cardsHtml += `
      <div class="ficha" style="border-top:4px solid ${sbo}">
        <div class="ficha-head">
          ${p.num ? `<span class="ficha-num">#${p.num}</span>` : ''}
          <span class="ficha-empresa">${p.grupo||'—'}</span>
          <span class="ficha-status" style="background:${sb};color:${sc};border:1px solid ${sbo}">${sl}</span>
        </div>
        ${fechaFmt || p.ref ? `<div class="ficha-sub">${fechaFmt?`<span class="ficha-fecha">📅 ${fechaFmt}</span>`:''}${p.ref?`<span class="ficha-ref">📋 ${p.ref}</span>`:''}</div>` : ''}
        ${productosHtml ? `<div class="ficha-productos">${productosHtml}</div>` : ''}
        <div class="ficha-data">
          ${p.mat1 ? `<div class="dato"><div class="dato-lbl">🚛 Tractora</div><div class="dato-val">${p.mat1}${p.mat2?' / '+p.mat2:''}</div></div>` : ''}
          ${p.transportista ? `<div class="dato"><div class="dato-lbl">🚚 Transportista</div><div class="dato-val">${p.transportista}</div></div>` : ''}
          ${p.muelle ? `<div class="dato"><div class="dato-lbl">🚪 Muelle</div><div class="dato-val">${p.muelle}</div></div>` : ''}
          ${p.hora ? `<div class="dato"><div class="dato-lbl">⏰ Hora</div><div class="dato-val">${p.hora}${p.hora_salida?' → '+p.hora_salida:''}</div></div>` : ''}
        </div>
        ${p.notas ? `<div class="ficha-notas">💬 ${p.notas}</div>` : ''}
      </div>`;
    });
    cardsHtml += `</div></div>`;
  }

  const totalesHtml = totales ? `
  <div class="totales-bar">
    <span class="tot-lbl">📊 TOTALES</span>
    <div class="tot-item"><div class="tot-label">Palets</div><div class="tot-val">${totales.palets%1===0?totales.palets:totales.palets.toFixed(1)}</div></div>
  </div>` : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Cargas Pro — ${tab} (Fichas)</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;padding:16px 18px;color:#1A1A1A;font-size:11px;background:#F5F2EC}
    /* ── CABECERA ── */
    .rpt-header{display:flex;align-items:center;gap:14px;background:#1B3A5C;color:#fff;padding:12px 16px;border-radius:8px;margin-bottom:4px}
    .rpt-logo{font-size:26px}
    .rpt-title{font-size:16px;font-weight:700;letter-spacing:-.2px}
    .rpt-title span{color:#2A6FB0}
    .rpt-meta{font-size:9px;color:rgba(255,255,255,0.5);margin-top:2px;letter-spacing:.3px}
    .rpt-sub{display:flex;justify-content:space-between;align-items:center;padding:7px 0 10px;font-size:10px;color:#666;border-bottom:1px solid #D0C8B8}
    .rpt-badge{background:#2A6FB0;color:#1B3A5C;font-weight:700;padding:2px 9px;border-radius:3px;font-size:9px;text-transform:uppercase;letter-spacing:.5px}
    /* ── GRUPOS ── */
    .group-section{margin-bottom:18px}
    .group-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#2A6FB0;background:#1B3A5C;padding:5px 12px;border-radius:5px;margin-bottom:10px;display:inline-flex;align-items:center;gap:8px}
    .group-cnt{background:#2A6FB0;color:#1B3A5C;border-radius:3px;padding:1px 7px;font-size:9px;font-weight:800}
    /* ── GRID DE FICHAS ── */
    .cards-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    /* ── FICHA ── */
    .ficha{background:#fff;border-radius:8px;border:1px solid #D8D0BC;padding:10px 12px 9px;break-inside:avoid;page-break-inside:avoid}
    .ficha-head{display:flex;align-items:center;gap:7px;margin-bottom:5px;flex-wrap:wrap}
    .ficha-num{font-family:monospace;font-size:10px;font-weight:700;background:#1B3A5C;color:#2A6FB0;padding:2px 8px;border-radius:3px;white-space:nowrap;flex-shrink:0}
    .ficha-empresa{font-size:12px;font-weight:800;flex:1;text-transform:uppercase;letter-spacing:-.1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ficha-status{font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;padding:2px 8px;border-radius:3px;white-space:nowrap;flex-shrink:0}
    .ficha-sub{display:flex;gap:10px;font-size:9px;color:#666;margin-bottom:6px;flex-wrap:wrap}
    .ficha-fecha{background:#F0EDE5;padding:1px 7px;border-radius:3px;font-family:monospace}
    .ficha-ref{background:#E8EEFF;color:#1A3A99;padding:3px 10px;border-radius:3px;font-family:monospace;font-weight:800;font-size:14px;letter-spacing:.5px}
    /* ── PRODUCTOS ── */
    .ficha-productos{background:#FFFBF2;border-left:3px solid #2A6FB0;padding:5px 9px;border-radius:0 5px 5px 0;margin-bottom:7px;font-size:10px}
    .prod-line{color:#5C4A00;font-weight:500;line-height:1.5}
    .prod-line strong{font-weight:800;color:#1A1A1A}
    /* ── DATOS ── */
    .ficha-data{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;margin-bottom:5px}
    .dato{}
    .dato-lbl{font-size:8px;color:#999;text-transform:uppercase;letter-spacing:.6px;font-weight:700}
    .dato-val{font-family:monospace;font-size:15px;font-weight:800;color:#1A1A1A;letter-spacing:.6px}
    .ficha-notas{font-size:9px;color:#555;border-top:1px dashed #DDD;padding-top:5px;margin-top:4px;font-style:italic}
    /* ── TOTALES ── */
    .totales-bar{display:flex;align-items:center;gap:24px;background:#F7F9FC;border:2px solid #2A6FB0;border-radius:7px;padding:10px 16px;margin-top:14px}
    .tot-lbl{font-size:9px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-right:8px}
    .tot-item{}
    .tot-label{font-size:8px;color:#999;text-transform:uppercase;letter-spacing:.5px}
    .tot-val{font-size:22px;font-weight:900;color:#1A1A1A;font-family:monospace;line-height:1.1}
    .tot-sep{width:1px;height:34px;background:#E0C060}
    .rpt-footer{margin-top:10px;font-size:8px;color:#BBB;text-align:right}
    @media print{
      body{background:#fff;padding:6px}
      .cards-grid{grid-template-columns:1fr 1fr}
      @page{margin:8mm;size:A4}
    }
  </style></head><body>
  <div class="rpt-header">
    <div class="rpt-logo">🚛</div>
    <div>
      <div class="rpt-title">Cargas<span>Pro</span> — ${tab}</div>
      <div class="rpt-meta">SAT GUADEX · Palma del Río · Generado el ${fecha} · Informe de fichas</div>
    </div>
  </div>
  <div class="rpt-sub">
    <span>${countTxt}</span>
    <span class="rpt-badge">📇 Fichas · ${tab}</span>
  </div>
  ${cardsHtml}
  ${totalesHtml}
  <div class="rpt-footer">Cargas Pro © ${new Date().getFullYear()} · SAT GUADEX S.L. · Informe de Fichas Operativas</div>
  </body></html>`;
}

async function compartirTabla() {
  const fecha    = new Date().toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'});
  const tab      = {pendientes:'Confección',terminado:'Terminado',todos:'Todos',cargados:'Cargados',historico:'Histórico'}[activeTab]||'';
  const countTxt = document.getElementById('countLbl').textContent;
  const filtered = _getFilteredPedidos();

  async function doCompartir(conTotales) {
  const statusEmoji={pendiente:'🟡',terminado:'🔵',revision:'🟠',cargado:'🟢'};
  const lines = [];
  lines.push(`🚛 *Cargas Pro — ${tab}*`);
  lines.push(`📅 ${fecha} · ${countTxt}`);
  lines.push('');

  filtered.forEach(p => {
    const emoji = statusEmoji[p.status]||'⚪';
    lines.push(`${emoji} *#${p.num||'—'} · ${p.grupo||'—'}*`);
    if(p.producto||p.ref) lines.push(`   📦 ${[p.producto,p.ref].filter(Boolean).join(' · ')}${p.uds?' · '+p.uds+' pal':''}`);
    if(p.mat1||p.mat2)    lines.push(`   🚛 ${[p.mat1,p.mat2].filter(Boolean).join(' / ')}`);
    if(p.transportista)   lines.push(`   🚚 ${p.transportista}`);
    const tiempos=[];
    if(p.hora)        tiempos.push(`⏰ ${p.hora}`);
    if(p.hora_salida) tiempos.push(`🕐 Salida: ${p.hora_salida}`);
    if(p.muelle)      tiempos.push(`🚪 Muelle ${p.muelle}`);
    if(tiempos.length) lines.push(`   ${tiempos.join(' · ')}`);
    if(p.notas)       lines.push(`   💬 ${p.notas}`);
    lines.push('');
  });
  if(conTotales) {
    const t = _calcTotales(filtered);
    lines.push(`——————————————`);
    lines.push(`📊 TOTALES`);
    lines.push(`   📦 Palets:      ${t.palets % 1 === 0 ? t.palets : t.palets.toFixed(1)}`);
  }
  lines.push(`——————————————`);
  lines.push(`SAT GUADEX · Palma del Río`);

  const texto = lines.join('\n');

  if (navigator.share) {
    try {
      await navigator.share({ title: `Cargas Pro — ${tab}`, text: texto });
      toast('📱 Compartido');
    } catch(e) {
      if (e.name !== 'AbortError') {
        await navigator.clipboard.writeText(texto);
        toast('📋 Copiado al portapapeles');
      }
    }
  } else {
    try {
      await navigator.clipboard.writeText(texto);
      toast('📋 Copiado al portapapeles');
    } catch(e) {
      toast('❌ No se pudo compartir');
    }
  }
  } // fin doCompartir

  _showTotalesModal(() => doCompartir(true), () => doCompartir(false));
}

async function exportarJSON() {
  if (!currentUser) { toast('⚠️ Inicia sesión para hacer una copia'); return; }
  toast('⏳ Preparando copia completa...', 2200);
  const refs={
    pedidos:col, produccion:colProd, materiales:colMat, recetas:colRecetas,
    movimientos_materiales:colMovMat, movimientos_produccion:colMovProd,
    palets:colPalets, salidas_palets:colSalidasPalets,
    movimientos_logistica:colMovLogistica, auditoria:colAuditoria
  };
  const colecciones={};
  for (const [nombre,ref] of Object.entries(refs)) {
    try { const snap=await ref.get(); colecciones[nombre]=snap.docs.map(d=>({id:d.id,...d.data()})); }
    catch(e) { colecciones[nombre]=[]; console.warn('Copia: no se pudo leer',nombre,e); }
  }
  const total=Object.values(colecciones).reduce((n,a)=>n+a.length,0);
  const fecha=new Date().toISOString();
  const payload={exportado:fecha,empresa:'SAT GUADEX S.L.',version:4,tipo:'cargas-pro-backup-completo',colecciones};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=`CargasPro_backup_${fecha.slice(0,10)}.json`; a.click(); URL.revokeObjectURL(url);
  await registrarAuditoria('backup_exportado','backup','local',`${total} documentos`);
  toast(`✅ Copia completa exportada · ${total} documentos`);
}
function importarJSON(event) {
  const file=event.target.files?.[0]; if(!file)return;
  const reader=new FileReader();
  reader.onload=async e=>{
    try {
      if(!_cpEsAdmin()){ toast('⛔ Solo un administrador puede restaurar copias'); return; }
      const data=JSON.parse(e.target.result);
      const colecciones=data.colecciones && typeof data.colecciones==='object' ? data.colecciones : {pedidos:Array.isArray(data)?data:(data.pedidos||[])};
      const permitidas=['pedidos','produccion','materiales','recetas','movimientos_materiales','movimientos_produccion','palets','salidas_palets','movimientos_logistica'];
      const entradas=permitidas.flatMap(nombre=>(Array.isArray(colecciones[nombre])?colecciones[nombre]:[]).map(x=>({nombre,x})));
      if(!entradas.length){ toast('⚠️ El archivo no contiene datos restaurables'); return; }
      confirm2('📥','Restaurar copia completa',`¿Restaurar ${entradas.length} documentos? Se reemplazarán los documentos con el mismo ID.`, 'Restaurar','', async()=>{
        setSyncStatus('saving'); let ok=0,err=0;
        for(let i=0;i<entradas.length;i+=400){
          const batch=db.batch();
          for(const {nombre,x} of entradas.slice(i,i+400)){
            try { const {id,...rest}=x; if(!id)throw new Error('sin id'); batch.set(db.collection(nombre).doc(String(id)),{...rest,_restaurado:new Date().toISOString()},{merge:false}); ok++; }
            catch(_){err++;}
          }
          try { await batch.commit(); } catch(_){ err+=Math.min(400,entradas.length-i); }
        }
        setSyncStatus('ok'); await registrarAuditoria('backup_importado','backup','local',`${ok} documentos; ${err} errores`);
        toast(`✅ Restauración terminada · ${ok} documentos${err?' · ❌ '+err+' errores':''}`,4000);
      });
    } catch(_) { toast('❌ Archivo JSON inválido'); }
  };
  reader.readAsText(file); event.target.value='';
}
window.render=render; window.exportarCSV=exportarCSV; window.exportarJSON=exportarJSON; window.importarJSON=importarJSON; window.imprimirTabla=imprimirTabla;
window.compartirTabla=compartirTabla; window.closeConfirm=closeConfirm; window.doConfirmOk=doConfirmOk;
window.setTab=setTab; window.setView=setView; window.toggleFilter=toggleFilter;
window.openPedidoModal=openPedidoModal; window.closePedidoModal=closePedidoModal; window.savePedido=savePedido; window.checkRefDuplicado=checkRefDuplicado;
window.limpiarPedidoModal=limpiarPedidoModal; window.openCargarModal=openCargarModal;
window.closeCargarModal=closeCargarModal; window.confirmarCarga=confirmarCarga;
window.limpiarCargarModal=limpiarCargarModal; window.reabrir=reabrir; window.delPedido=delPedido;

// ══════════ PRODUCCIÓN / STOCK ══════════
// ══════════ BRICKS: bandejas → etiquetado → encajado (Tetra Pak) ══════════
// Cajas resultantes de encajar `total` bricks a `bpc` bricks/caja y `cpp` cajas/palet
function _encajar(total, bpc, cpp) {
  if (!(total>0 && bpc>0 && cpp>0)) return null;
  const cajasTot = Math.floor(total/bpc);
  return { cajasTot, palets: Math.floor(cajasTot/cpp), cajas: cajasTot%cpp, sueltos: total-cajasTot*bpc };
}
const _fmtN = n => (n||0).toLocaleString('es-ES');
// Lee los datos de bandejas del formulario (respeta una merma ya corregida si no se tocan las bandejas)
function _bricksForm() {
  const v = id => parseFloat(document.getElementById(id).value)||0;
  const f = { bpb:v('pr-bpb'), bpp:v('pr-bpp'), pb:v('pr-pb'), bs:v('pr-bs'), bi:v('pr-bi'), bri:v('pr-bri') };
  f.total = f.bpb*(f.bpp*f.pb+f.bs) + f.bri;
  const prev = editLoteId ? producciones.find(x=>String(x.id)===String(editLoteId)) : null;
  if (prev && prev.tipo==='brik' && f.bpb==prev.bricksPorBandeja && f.bpp==prev.bandejasPorPalet && f.pb==prev.paletsBandejas && f.bs==(parseFloat(prev.bandejasSueltas)||0) && f.bi==(parseFloat(prev.bandejasIncompletas)||0) && f.bri==(parseFloat(prev.bricksIncompletos)||0))
    f.total = parseFloat(prev.totalBricks)||f.total;
  return f;
}
// Palabra de la unidad y del "por caja" según el tipo (brik → bricks, botella → botellas)
function _unidadTipo(tipo) { return tipo==='botella' ? 'botellas' : 'bricks'; }
function prBrikCalc() {
  const tipo = document.getElementById('pr-tipo').value;
  let total = 0;
  if (tipo==='brik') { const f = _bricksForm(); document.getElementById('pr-totbricks').value = f.total||''; total = f.total; }
  else if (tipo==='botella') { total = parseFloat(document.getElementById('pr-totbotellas').value)||0; }
  const u = _unidadTipo(tipo);
  const lblPorCaja = document.getElementById('pr-lbl-porcaja'); if (lblPorCaja) lblPorCaja.textContent = (tipo==='botella'?'🍾':'🧃')+' '+u.charAt(0).toUpperCase()+u.slice(1)+' por caja';
  const enc = document.getElementById('pr-fase')?.value==='encajado';
  const grpEnc = document.getElementById('pr-grp-enc'); if (grpEnc) grpEnc.style.display = enc ? '' : 'none';
  if (enc) {
    const e = _encajar(total, parseFloat(document.getElementById('pr-bpc').value)||0, parseFloat(document.getElementById('pr-cppb').value)||0);
    document.getElementById('pr-encprev').textContent = e ? '= '+_fmtN(e.cajasTot)+' cajas · '+e.palets+' palets + '+e.cajas+' cajas'+(e.sueltos?' · sobran '+e.sueltos+' '+u:'') : '';
  }
}
function prTipoChange() {
  const tipo = document.getElementById('pr-tipo').value;
  document.getElementById('pr-grp-normal').style.display = tipo==='normal' ? '' : 'none';
  document.getElementById('pr-grp-fases').style.display = tipo==='brik' ? '' : 'none';
  document.getElementById('pr-grp-brik').style.display = tipo==='brik' ? '' : 'none';
  if (tipo==='normal') prNormalCalc(); else prBrikCalc();
}
// Botella/otros: total botellas = (palets × cajas/palet + cajas sueltas) × botellas/caja
function prNormalCalc() {
  const v = id => parseFloat(document.getElementById(id).value)||0;
  const cajasTot = v('pr-palets')*v('pr-cpp') + v('pr-cajas');
  const bpu = v('pr-bpu');
  document.getElementById('pr-totbot').value = bpu>0 ? _fmtN(cajasTot*bpu) : '';
}
window.prBrikCalc = prBrikCalc; window.prTipoChange = prTipoChange; window.prNormalCalc = prNormalCalc;
// Recuerda, por artículo (+formato si se ha indicado), las últimas cajas/palet, bricks/caja y bricks/bandeja
// usadas en una producción anterior — solo rellena los campos que estén vacíos, sin pisar lo que ya se ha escrito.
function prRecordarPorArticulo() {
  const articulo = document.getElementById('pr-articulo').value.trim().toUpperCase();
  if (!articulo) return;
  const formato = document.getElementById('pr-formato').value.trim();
  const coincide = l => (l.articulo||'').trim().toUpperCase() === articulo && _fmtOk(l, formato);
  const masReciente = arr => arr.sort((a,b) => (b.createdAt||0)-(a.createdAt||0))[0];

  const cppEl = document.getElementById('pr-cpp');
  if (cppEl && !cppEl.value) {
    const ult = masReciente(producciones.filter(l => l.tipo==='normal' && coincide(l) && parseFloat(l.cajasPorPalet)>0));
    if (ult) cppEl.value = ult.cajasPorPalet;
  }
  const bpbEl = document.getElementById('pr-bpb');
  if (bpbEl && !bpbEl.value) {
    const ult = masReciente(producciones.filter(l => l.tipo==='brik' && coincide(l) && parseFloat(l.bricksPorBandeja)>0));
    if (ult) bpbEl.value = ult.bricksPorBandeja;
  }
  const bpcEl = document.getElementById('pr-bpc'), cppbEl = document.getElementById('pr-cppb');
  const tipoSel = document.getElementById('pr-tipo').value;
  const cPorCaja = _campoPorCaja(tipoSel);
  const ultEnc = masReciente(producciones.filter(l => l.tipo===tipoSel && l.fase==='encajado' && coincide(l) && parseFloat(l[cPorCaja])>0));
  if (ultEnc) {
    if (bpcEl && !bpcEl.value) bpcEl.value = ultEnc[cPorCaja];
    if (cppbEl && !cppbEl.value) cppbEl.value = ultEnc.cajasPorPalet;
  }
  prBrikCalc();
}
window.prRecordarPorArticulo = prRecordarPorArticulo;
// Bricks en cada fase (art = artículo en mayúsculas, o null para todos)
function _esFases(l) { return l.tipo==='brik' || l.tipo==='botella'; }
// Nombre de los campos que guardan el total y el "por caja", según el tipo de lote
function _campoTotal(tipo) { return tipo==='botella' ? 'totalBotellas' : 'totalBricks'; }
function _campoPorCaja(tipo) { return tipo==='botella' ? 'botellasPorCaja' : 'bricksPorCaja'; }
function _campoSueltos(tipo) { return tipo==='botella' ? 'botellasSueltas' : 'bricksSueltos'; }
function _bricksFase(art, tipo) {
  const r = { llenado:0, etiquetado:0, encajado:0, n:0 };
  producciones.forEach(l => {
    if (!_esFases(l) || (tipo && l.tipo!==tipo)) return;
    if (art && (l.articulo||'').trim().toUpperCase()!==art) return;
    r.n++;
    const cTot = _campoTotal(l.tipo), cPorCaja = _campoPorCaja(l.tipo), cSueltos = _campoSueltos(l.tipo);
    if (l.fase==='encajado') r.encajado += (_dispLote(l).total||0)*(parseFloat(l[cPorCaja])||0) + (parseFloat(l[cSueltos])||0);
    else r[l.fase||'llenado'] += parseFloat(l[cTot])||0;
  });
  return r;
}
function _brikResumenHtml(art, global) {
  const rb = _bricksFase(art,'brik'), ro = _bricksFase(art,'botella');
  if (!rb.n && !ro.n) return '';
  const bloque = (r,u,icono) => !r.n ? '' : `<div style="margin-top:${global?'4px':'0'}">${icono} <b>${u}</b> · Llenado <b>${_fmtN(r.llenado)}</b> · Etiquetado <b>${_fmtN(r.etiquetado)}</b> · Encajado <b>${_fmtN(r.encajado)}</b></div>`;
  const cuerpo = bloque(rb,'Bricks','🧃') + bloque(ro,'Botellas','🍾');
  if (!global) return `<div style="font-size:11.5px;color:var(--t2);margin:-2px 4px 4px">${cuerpo}</div>`;
  return `<div style="background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:9px 10px;font-size:12.5px"><b>En fábrica por fase</b>${cuerpo}</div>`;
}
function _brikInfoHtml(l) {
  const F = { llenado:'1 · Llenado', etiquetado:'2 · Etiquetado', encajado:'3 · Encajado' };
  const C = { llenado:'#2A6FB0', etiquetado:'#3B82F6', encajado:'#22A559' };
  const bot = l.tipo==='botella', icono = bot?'🍾':'🧃', u = bot?'botellas':'bricks';
  const cTot = _campoTotal(l.tipo), cPorCaja = _campoPorCaja(l.tipo);
  const det = l.fase==='encajado'
    ? (l[cPorCaja] ? l[cPorCaja]+' '+u+'/caja' : '')
    : (bot ? '' : `${l.paletsBandejas||0} palets × ${l.bandejasPorPalet||0} bandejas × ${l.bricksPorBandeja||0} bricks${l.bandejasSueltas?' + '+l.bandejasSueltas+' bandejas':''}${l.bricksIncompletos?' + '+(l.bandejasIncompletas?l.bandejasIncompletas+' incompletas con ':'')+l.bricksIncompletos+' bricks':''}`);
  const B = (d,t,bg,fg) => `<button onclick="avanzarFaseLote('${l.id}','${d}')" style="flex:1;min-height:46px;font-size:15px;font-weight:800;border:none;border-radius:12px;background:${bg};color:${fg};cursor:pointer">${t}</button>`;
  const btns = l.fase==='encajado' ? '' : `<div style="display:flex;gap:8px;margin-top:10px">${l.fase==='llenado' ? B('etiquetado','🏷️ Etiquetar','var(--brand-primary)','var(--dhl-dark)') : ''}${B('encajado','📦 Encajar','var(--dhl-dark)','#fff')}</div>`;
  return `<div style="margin-top:6px"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="background:${C[l.fase]||'#999'};color:#fff;padding:3px 10px;border-radius:999px;font-weight:800;font-size:11.5px">${F[l.fase]||'—'}</span><span style="font-size:16px;font-weight:800">${icono} ${_fmtN(parseFloat(l[cTot])||0)} ${u}</span></div>${det?`<div style="color:var(--t2);margin-top:3px">${det}</div>`:''}${btns}</div>`;
}
let _faseLote = null, _faseDest = '';
const _FASE_TXT = { llenado:'Llenado', etiquetado:'Etiquetado', encajado:'Encajado' };
const _bricksPalBand = l => (parseFloat(l.bricksPorBandeja)||0)*(parseFloat(l.bandejasPorPalet)||0);
// Reparte b bricks en palets de bandejas + bandejas sueltas + bricks de bandeja incompleta (solo brik; botella no tiene bandejas)
function _desglose(b, l) {
  if (l.tipo==='botella') return { pb:0, bs:0, bi:0, bri:0 };
  const bpb = parseFloat(l.bricksPorBandeja)||0, bp = _bricksPalBand(l);
  if (!(bpb>0 && bp>0)) return { pb:0, bs:0, bi:0, bri:0 };
  const pb = Math.floor(b/bp), r = b-pb*bp, bs = Math.floor(r/bpb), bri = r-bs*bpb;
  return { pb, bs, bi: bri>0?1:0, bri };
}
const _txtDesg = d => `${d.pb} palets de bandejas` + (d.bs?` + ${d.bs} bandejas`:'') + (d.bri?` + ${d.bri} bricks sueltos`:'');
function avanzarFaseLote(id, dest) {
  const l = producciones.find(x=>String(x.id)===String(id));
  if (!l || !_esFases(l) || l.fase==='encajado') return;
  _faseLote = l; _faseDest = dest || (l.fase==='llenado' ? 'etiquetado' : 'encajado');
  const enc = _faseDest==='encajado', bot = l.tipo==='botella', u = bot?'botellas':'bricks', icono = bot?'🍾':'🧃';
  const cTot = _campoTotal(l.tipo), cPorCaja = _campoPorCaja(l.tipo);
  document.getElementById('fb-title').textContent = enc ? '📦 Encajar' : '🏷️ Etiquetar';
  document.getElementById('fb-sub').textContent = l.articulo + (l.numProd?' · '+l.numProd:'') + (l.lote?' · Lote '+l.lote:'');
  const desgHtml = bot ? '' : `<div style="color:var(--t2);margin-top:2px">${_txtDesg(_desglose(parseFloat(l[cTot])||0, l))}</div>`;
  document.getElementById('fb-disp').innerHTML = `Ahora en <b>${_FASE_TXT[l.fase]}</b>: <b>${_fmtN(parseFloat(l[cTot])||0)} ${u}</b>${desgHtml}`;
  const ult = producciones.filter(x=>x.tipo===l.tipo && x.fase==='encajado' && (x.articulo||'').trim().toUpperCase()===(l.articulo||'').trim().toUpperCase() && _fmtOk(x,l.formato) && x[cPorCaja]>0)
                          .sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0];
  document.getElementById('fb-bpc').value = ult ? ult[cPorCaja] : '';
  document.getElementById('fb-cpp').value = ult ? (ult.cajasPorPalet||'') : '';
  document.getElementById('fb-lbl-total').textContent = icono+' '+u.charAt(0).toUpperCase()+u.slice(1);
  document.getElementById('fb-lbl-porcaja').textContent = icono+' '+u.charAt(0).toUpperCase()+u.slice(1)+' por caja';
  document.getElementById('fb-lbl-unidenc').textContent = icono+' '+u.charAt(0).toUpperCase()+u.slice(1)+' a encajar';
  document.getElementById('fb-grp-palbox').style.display = bot ? 'none' : '';
  document.getElementById('fb-enc').style.display = enc ? '' : 'none';
  document.getElementById('fb-grp-pal').style.display = enc ? 'none' : '';
  document.getElementById('fb-grp-solobricks').style.display = enc ? '' : 'none';
  document.getElementById('fb-bricksenc').value = '';
  document.getElementById('fb-cajasenc').value = '';
  document.getElementById('fb-ok').textContent = enc ? '📦 Encajar' : '🏷️ Etiquetar';
  fbTodo();
  document.getElementById('mFaseBrik').classList.add('open');
}
function fbTodo() {
  const l = _faseLote; if (!l) return;
  const cTot = _campoTotal(l.tipo);
  document.getElementById('fb-pal').value = l.paletsBandejas || 0;
  document.getElementById('fb-total').value = l[cTot] || '';
  if (_faseDest==='encajado') { document.getElementById('fb-bricksenc').value = l[cTot] || ''; fbBricksEncChange(); return; }
  fbCalc();
}
// Palets de bandejas → bricks (solo brik; en botella este campo está oculto)
function fbPalChange() {
  const l = _faseLote; if (!l) return;
  const pal = parseFloat(document.getElementById('fb-pal').value)||0, P = parseFloat(l.paletsBandejas)||0;
  document.getElementById('fb-total').value = pal>=P ? (l[_campoTotal(l.tipo)]||'') : (pal*_bricksPalBand(l)||'');
  fbCalc();
}
// Unidades (bricks/botellas) → palets de bandejas aprox. (solo aplica si hay bandejas, es decir, brik)
function fbBricksChange() {
  const l = _faseLote; if (!l) return;
  const cTot = _campoTotal(l.tipo);
  const b = parseFloat(document.getElementById('fb-total').value)||0, T = parseFloat(l[cTot])||0, bp = _bricksPalBand(l);
  if (l.tipo!=='botella') document.getElementById('fb-pal').value = b>=T ? (l.paletsBandejas||0) : (bp>0 ? Math.floor(b/bp) : 0);
  fbCalc();
}
// Cajas a encajar → unidades a encajar (exacto, según unidades/caja)
function fbCajasEncChange() {
  const bpc = parseFloat(document.getElementById('fb-bpc').value)||0, cajas = parseFloat(document.getElementById('fb-cajasenc').value)||0;
  document.getElementById('fb-bricksenc').value = bpc>0 ? cajas*bpc : '';
  fbCalc();
}
// Unidades a encajar → cajas a encajar (redondeando hacia abajo a cajas completas)
function fbBricksEncChange() {
  const bpc = parseFloat(document.getElementById('fb-bpc').value)||0, b = parseFloat(document.getElementById('fb-bricksenc').value)||0;
  document.getElementById('fb-cajasenc').value = bpc>0 ? (Math.floor(b/bpc)||'') : '';
  fbCalc();
}
function fbCalc() {
  const l = _faseLote; if (!l) return;
  const v = id => parseFloat(document.getElementById(id).value)||0;
  const bot = l.tipo==='botella', u = bot?'botellas':'bricks';
  const enc = _faseDest==='encajado', T = parseFloat(l[_campoTotal(l.tipo)])||0;
  let b = enc ? v('fb-bricksenc') : v('fb-total');
  let html = '';
  if (enc) {
    const bpc = v('fb-bpc'), k = v('fb-cpp');
    if (!(bpc>0 && k>0)) {
      html += `<div style="color:var(--t2)">Indica ${u} por caja y cajas por palet.</div>`;
    } else if (b<=0) {
      html += `<div style="color:var(--t2)">Indica cuántas ${u} vas a encajar.</div>`;
    } else if (b>T) {
      html += `<div style="color:#B02A37">⚠️ Solo hay ${_fmtN(T)} ${u} en este lote</div>`;
    } else {
      const e = _encajar(b, bpc, k);
      if (e.cajasTot<=0) {
        html += `<div style="color:#B02A37">⚠️ ${_fmtN(b)} ${u} no llegan a completar ni una caja (necesitas ${_fmtN(bpc)} por caja)</div>`;
      } else {
        html += `<div>✅ <b>Pasa a stock:</b> ${_fmtN(e.cajasTot)} cajas = <b>${e.palets} palet${e.palets!==1?'s':''}</b>${e.cajas?' + <b>'+e.cajas+' cajas</b>':''}${e.sueltos?' · sobran '+_fmtN(e.sueltos)+' '+u+' (menos de 1 caja, se quedan en Etiquetado)':''}</div>`;
      }
    }
  } else html += `<div>🏷️ <b>Se etiquetan:</b> ${_fmtN(b)} ${u}</div>`;
  if (!enc) { if (b>0 && b<T) html += `<div style="margin-top:4px">🟡 <b>Se quedan en ${_FASE_TXT[l.fase]}:</b> ${_fmtN(T-b)} ${u}${bot?'':'<div style="color:var(--t2)">'+_txtDesg(_desglose(T-b, l))+'</div>'}</div>`;
  if (b>T) html += `<div style="color:#B02A37;margin-top:4px">⚠️ Solo hay ${_fmtN(T)} ${u} en este lote</div>`; }
  else if (b>0 && b<T) html += `<div style="margin-top:4px">🟡 <b>Quedan en Etiquetado:</b> ${_fmtN(T-b)} ${u}</div>`;
  document.getElementById('fb-prev').innerHTML = html;
}
function cerrarFaseBrik() { document.getElementById('mFaseBrik').classList.remove('open'); _faseLote = null; }
async function confirmarFaseBrik() {
  const l = _faseLote; if (!l) return;
  const v = id => parseFloat(document.getElementById(id).value)||0;
  const dest = _faseDest, cTot = _campoTotal(l.tipo), cPorCaja = _campoPorCaja(l.tipo), cSueltos = _campoSueltos(l.tipo);
  const T = parseFloat(l[cTot])||0, u = l.tipo==='botella'?'botellas':'bricks';
  let b, adv;
  if (dest==='encajado') {
    const bpc = v('fb-bpc'), k = v('fb-cpp'), enc = v('fb-bricksenc');
    if (!(bpc>0 && k>0)) { toast('⚠️ Indica '+u+' por caja y cajas por palet'); return; }
    if (enc<=0) { toast('⚠️ Indica cuántas '+u+' vas a encajar'); return; }
    if (enc>T) { toast('⚠️ Solo hay '+_fmtN(T)+' '+u+' en este lote'); return; }
    const e = _encajar(enc, bpc, k);
    if (!e || e.cajasTot<=0) { toast('⚠️ No llega ni a una caja con esas '+u); return; }
    b = e.cajasTot*bpc; // unidades realmente usadas (se ignoran los sueltos de menos de 1 caja, se quedan en Etiquetado)
    adv = { ...l, fase:dest, [cTot]:b, [cPorCaja]:bpc, cajasPorPalet:k, palets:e.palets, cajas:e.cajas, [cSueltos]:0, paletsConsumidos:0, cajasConsumidos:0 };
  } else {
    b = v('fb-total');
    if (b<=0) { toast('⚠️ Indica cuántas '+u+' pasan'); return; }
    if (b>T) { toast('⚠️ Solo hay '+_fmtN(T)+' '+u); return; }
    adv = { ...l, fase:dest, [cTot]:b };
  }
  const parcial = b<T;
  if (parcial) {
    // El lote se divide: lo que pasa va a un registro nuevo (mismo nº de producción) y el resto se queda donde estaba
    const da = _desglose(b, l), dr = _desglose(T-b, l);
    adv = { ...adv, id:'lote_'+Date.now()+'_'+Math.random().toString(36).slice(2,7), createdAt:Date.now(), origenId:l.id,
            paletsBandejas:da.pb, bandejasSueltas:da.bs, bandejasIncompletas:da.bi, bricksIncompletos:da.bri };
    await fbSaveProduccion({ ...l, [cTot]:T-b, paletsBandejas:dr.pb, bandejasSueltas:dr.bs, bandejasIncompletas:dr.bi, bricksIncompletos:dr.bri });
  }
  await fbSaveProduccion(adv);
  if (dest==='encajado') await consumirMateriales(adv.articulo, adv.formato, _cajasEq(adv));
  await registrarMovProduccion(adv, dest, _descLote(adv));
  cerrarFaseBrik();
  toast(dest==='encajado' ? '📦 Encajado · ya está en stock' : '🏷️ Etiquetado');
  renderProduccionList();
  if (dest==='encajado') preguntarPedidosLote(adv);
}
window.avanzarFaseLote = avanzarFaseLote; window.fbCalc = fbCalc; window.fbPalChange = fbPalChange; window.fbBricksChange = fbBricksChange;
window.fbTodo = fbTodo; window.fbCajasEncChange = fbCajasEncChange; window.fbBricksEncChange = fbBricksEncChange; window.cerrarFaseBrik = cerrarFaseBrik; window.confirmarFaseBrik = confirmarFaseBrik;

function openProduccionModal(){
  ['pr-articulo','pr-marca','pr-formato','pr-palets','pr-cajas','pr-cpp','pr-bpu','pr-totbot','pr-bpb','pr-bpp','pr-pb','pr-bs','pr-bi','pr-bri','pr-bpc','pr-cppb','pr-totbricks','pr-totbotellas','pr-lote','pr-caducidad','pr-peso','pr-notas'].forEach(id=>{const el=document.getElementById(id); if(el) el.value='';});
  document.getElementById('pr-fecha').value = new Date().toISOString().slice(0,10);
  _setModoEdicion(null);
  _prView = 'stock'; _prArt = ''; _prBusca = ''; _prFiltro = 'todos';
  renderProduccionList();
  asignarNumerosProduccion().then(renderProduccionList);
  document.getElementById('mProduccion').classList.add('open');
}
// Menú "Más": copia de seguridad, importar, CSV y mantenimiento, fuera de la navegación principal
function abrirMenuMas() { document.getElementById('mMas').classList.add('open'); }
function cerrarMenuMas() { document.getElementById('mMas').classList.remove('open'); }
function menuMasIr(accion) { cerrarMenuMas(); accion(); }
window.abrirMenuMas = abrirMenuMas; window.cerrarMenuMas = cerrarMenuMas; window.menuMasIr = menuMasIr;
// ── Botón de acciones desplegable ──
function toggleDial(force) {
  const d = document.getElementById('fabDial'), sc = document.getElementById('fabScrim');
  if (!d) return;
  const abrir = typeof force==='boolean' ? force : !d.classList.contains('open');
  d.classList.toggle('open', abrir); sc.classList.toggle('open', abrir);
  d.querySelector('.fab-main').setAttribute('aria-expanded', abrir ? 'true' : 'false');
}
function dialGo(destino) {
  toggleDial(false);
  if (destino==='pedido') openPedidoModal(null);
  else if (destino==='produccion') openProduccionModal();
  else if (destino==='palets') abrirPalets();
  else if (destino==='materiales') abrirMaterialesDirecto();
}
window.toggleDial = toggleDial; window.dialGo = dialGo;
// Acciones simplificadas para el modo operario.
function operadorNuevoPedido(){ openPedidoModal(null); }
function operadorNuevoPalet(){ abrirPalets(); setTimeout(()=>window.cpNuevoPalet?.(),80); }
function operadorCargar(){
  const list=(typeof pedidos!=='undefined'?pedidos:[]).filter(p=>['terminado','pendiente','en_preparacion'].includes(String(p.estado||p.status||'').toLowerCase()));
  if(list.length===1){ window.cpNuevaSalida?.(); setTimeout(()=>{ const el=document.getElementById('cps-pedido'); if(el){el.value=String(list[0].id); el.dispatchEvent(new Event('change'));} },100); return; }
  setTab('terminado');
  toast(list.length ? 'Selecciona el pedido terminado que quieres cargar' : 'No hay pedidos preparados para cargar');
}
function operadorPicking(){ abrirOperaciones(); setTimeout(()=>document.getElementById('opsPicking')?.scrollIntoView({behavior:'smooth',block:'start'}),100); }
window.operadorNuevoPedido=operadorNuevoPedido; window.operadorNuevoPalet=operadorNuevoPalet; window.operadorCargar=operadorCargar; window.operadorPicking=operadorPicking;
function abrirMaterialesDirecto(){
  openProduccionModal();
  prIr('materiales');
}
window.abrirMaterialesDirecto = abrirMaterialesDirecto;
function closeProduccionModal(){
  document.getElementById('mProduccion').classList.remove('open');
}
window.openProduccionModal = openProduccionModal;
window.closeProduccionModal = closeProduccionModal;

async function guardarProduccion(){
  const articulo = document.getElementById('pr-articulo').value.trim().toUpperCase();
  if(!articulo){ toast('⚠️ Indica el artículo'); return; }
  const tipoSel = document.getElementById('pr-tipo').value; // 'normal' | 'brik' | 'botella'
  let palets = parseFloat(document.getElementById('pr-palets').value)||0;
  let cajas  = parseFloat(document.getElementById('pr-cajas').value)||0;
  let cpp    = parseFloat(document.getElementById('pr-cpp').value)||0;
  let extra  = { tipo:'normal' };
  if (tipoSel==='brik') {
    const f = _bricksForm(), fase = document.getElementById('pr-fase').value;
    if (f.total<=0) { toast('⚠️ Indica bricks por bandeja, bandejas por palet y palets'); return; }
    extra = { tipo:'brik', fase, bricksPorBandeja:f.bpb, bandejasPorPalet:f.bpp, paletsBandejas:f.pb, bandejasSueltas:f.bs, bandejasIncompletas:f.bi, bricksIncompletos:f.bri, totalBricks:f.total, bricksPorCaja:0, bricksSueltos:0 };
    palets = 0; cajas = 0; cpp = 0;
    if (fase==='encajado') {
      const bpc = parseFloat(document.getElementById('pr-bpc').value)||0, k = parseFloat(document.getElementById('pr-cppb').value)||0;
      const e = _encajar(f.total, bpc, k);
      if (!e) { toast('⚠️ Indica bricks por caja y cajas por palet'); return; }
      palets = e.palets; cajas = e.cajas; cpp = k; extra.bricksPorCaja = bpc; extra.bricksSueltos = e.sueltos;
    }
  } else if (tipoSel==='botella') {
    const total = parseFloat(document.getElementById('pr-totbotellas').value)||0, fase = document.getElementById('pr-fase').value;
    if (total<=0) { toast('⚠️ Indica las botellas fabricadas'); return; }
    extra = { tipo:'botella', fase, totalBotellas: total, botellasPorCaja:0, botellasSueltas:0 };
    palets = 0; cajas = 0; cpp = 0;
    if (fase==='encajado') {
      const bpc = parseFloat(document.getElementById('pr-bpc').value)||0, k = parseFloat(document.getElementById('pr-cppb').value)||0;
      const e = _encajar(total, bpc, k);
      if (!e) { toast('⚠️ Indica botellas por caja y cajas por palet'); return; }
      palets = e.palets; cajas = e.cajas; cpp = k; extra.botellasPorCaja = bpc; extra.botellasSueltas = e.sueltos;
    }
  } else {
    if(palets<=0 && cajas<=0){ toast('⚠️ Indica palets o cajas'); return; }
    if(palets>0 && cpp<=0){ toast('⚠️ Indica las cajas por palet'); return; }
    const bpu = parseFloat(document.getElementById('pr-bpu').value)||0;
    extra = { tipo:'normal', botellasPorCaja: bpu, totalBotellas: bpu>0 ? (palets*cpp+cajas)*bpu : 0 };
  }
  const prev = editLoteId ? producciones.find(x=>String(x.id)===String(editLoteId)) : null;
  if(prev && cpp>0){
    const consumido=(parseFloat(prev.paletsConsumidos)||0)*cpp+(parseFloat(prev.cajasConsumidos)||0);
    if(palets*cpp+cajas<consumido){ toast('⚠️ Ya se han consumido '+consumido+' cajas de este lote'); return; }
  }
  const lote = {
    id: prev ? prev.id : 'lote_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
    articulo, marca: document.getElementById('pr-marca').value.trim().toUpperCase(),
    formato: document.getElementById('pr-formato').value.trim().toUpperCase(),
    ...extra,
    numProd: (prev && prev.numProd) || _nuevoNumProd(document.getElementById('pr-fecha').value),
    palets, cajas, cajasPorPalet: cpp,
    paletsConsumidos: prev ? (prev.paletsConsumidos||0) : 0, cajasConsumidos: prev ? (prev.cajasConsumidos||0) : 0,
    lote: document.getElementById('pr-lote').value.trim().toUpperCase(),
    caducidad: document.getElementById('pr-caducidad').value,
    peso: document.getElementById('pr-peso').value.trim(),
    fecha: document.getElementById('pr-fecha').value || new Date().toISOString().slice(0,10),
    notas: document.getElementById('pr-notas').value.trim().toUpperCase(),
    createdAt: prev ? (prev.createdAt||Date.now()) : Date.now()
  };
  if (_guardandoProduccion) { toast('⏳ La producción ya se está guardando'); return; }
  _guardandoProduccion = true;
  try {
    const deltaCajasMat = _cajasEq(lote) - _cajasEq(prev);
    // La producción encajada y sus palets físicos se guardan/reconcilian juntos.
    // Al editar cantidades, el mismo flujo ajusta palets disponibles y anula los sobrantes.
    if (lote.fase==='encajado') await cpCrearPaletsDeProduccion(lote);
    else await fbSaveProduccion(lote);
    if (deltaCajasMat) await consumirMateriales(lote.articulo, lote.formato, deltaCajasMat);
    await registrarMovProduccion(lote, prev?'editado':'creado', _descLote(lote));
  ['pr-marca','pr-formato','pr-palets','pr-cajas','pr-cpp','pr-bpu','pr-totbot','pr-bpb','pr-bpp','pr-pb','pr-bs','pr-bi','pr-bri','pr-bpc','pr-cppb','pr-totbricks','pr-totbotellas','pr-lote','pr-caducidad','pr-peso','pr-notas'].forEach(id=>{const el=document.getElementById(id); if(el) el.value='';});
    toast(prev ? '💾 Lote actualizado' : '🏭 Producción '+lote.numProd+' registrada'); _setModoEdicion(null);
    if(!prev && !(_esFases(lote) && lote.fase!=='encajado')) preguntarPedidosLote(lote);
    _prArt = _keyArt(lote); prIr('detalle');
  } finally {
    _guardandoProduccion = false;
  }
}
window.guardarProduccion = guardarProduccion;

// ══════════════════════════════════════════════════════════════════
// MATERIALES: envases, tapones, cartón, bobinas... con su stock y,
// por artículo+formato, la receta (cuánto de cada material lleva
// UNA CAJA) para descontarlo solo al fabricar.
// ══════════════════════════════════════════════════════════════════
let _matId = '';
function _matUnidadTxt(u){ return {uds:'uds', kg:'kg', m:'m'}[u] || u || ''; }
function _matCardHtml(m) {
  const stock = parseFloat(m.stock)||0, min = parseFloat(m.stockMin)||0;
  const bajo = min>0 && stock<=min, agotado = stock<=0;
  const col = agotado ? '#DC3545' : (bajo ? '#2A6FB0' : '#22A559');
  return `<div onclick="matAbrir('${m.id}')" style="cursor:pointer;background:var(--surface);border:1px solid var(--border);border-left:6px solid ${col};border-radius:14px;padding:11px 12px;min-height:96px;display:flex;flex-direction:column">
    <div style="font-weight:800;font-size:13px;line-height:1.2">${_esc(m.nombre||'')}</div>
    <div style="margin-top:auto;padding-top:6px"><span style="font-size:28px;font-weight:900;line-height:1">${_fmtN(stock)}</span> <span style="font-size:12px;font-weight:700">${_matUnidadTxt(m.unidad)}</span></div>
    ${min>0 ? `<div style="font-size:11px;color:var(--t2);margin-top:2px">Mínimo: ${_fmtN(min)} ${_matUnidadTxt(m.unidad)}</div>` : ''}
  </div>`;
}
let _matBusca = '', _matFiltro = 'todos';
function _matPasaFiltro(m, f) {
  const stock = parseFloat(m.stock)||0, min = parseFloat(m.stockMin)||0;
  if (f==='bajo') return min>0 && stock<=min && stock>0;
  if (f==='agotado') return stock<=0;
  return true;
}
function _matGridHtml() {
  const q = _normTxt(_matBusca);
  const ms = materiales.filter(m => _matPasaFiltro(m,_matFiltro) && (!q || _normTxt(m.nombre).includes(q)));
  if (!ms.length) return '<div style="text-align:center;color:var(--t3);padding:20px 10px;font-size:13px">No hay materiales que coincidan.</div>';
  return `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">${ms.map(_matCardHtml).join('')}</div>`;
}
function _matListaHtml() {
  if (!materiales.length) return '<div style="text-align:center;color:var(--t3);padding:20px 10px;font-size:13px">Todavía no hay materiales. Pulsa "＋ Nueva" para dar de alta el primero (botellas, tapones, cartón, bobinas...).</div>' + _matRecetasHtml();
  const chips = [['todos','Todos'],['bajo','Bajo mínimo'],['agotado','Agotados']].map(([f,t]) =>
    `<button onclick="matFiltro('${f}')" style="flex:0 0 auto;padding:8px 12px;border-radius:999px;border:1px solid var(--border2);font-size:12.5px;font-weight:800;cursor:pointer;background:${_matFiltro===f?'var(--dhl-dark)':'var(--surface)'};color:${_matFiltro===f?'#fff':'var(--t1)'}">${t}</button>`).join('');
  const buscador = `<input id="mat-buscar" type="search" placeholder="🔎 Buscar material..." value="${_esc(_matBusca)}" oninput="matBuscar(this.value)" style="width:100%;padding:11px;font-size:14px;border:1px solid var(--border2);border-radius:12px;background:var(--surface);color:var(--t1)">
    <div style="display:flex;gap:6px;overflow-x:auto;margin:10px 0 12px;padding-bottom:2px">${chips}</div>`;
  const btnMovs = `<button type="button" onclick="matVerMovs('')" style="width:100%;margin-top:10px;padding:11px;border:1px dashed var(--border2);border-radius:12px;background:transparent;color:var(--t2);font-weight:700;cursor:pointer">📋 Ver movimientos de materiales</button>`;
  return buscador + `<div id="mat-grid">${_matGridHtml()}</div>` + btnMovs + _matRecetasHtml();
}
function matBuscar(v) { _matBusca = v; const g = document.getElementById('mat-grid'); if (g) g.innerHTML = _matGridHtml(); }
function matFiltro(f) { _matFiltro = f; renderProduccionList(); }
window.matBuscar = matBuscar; window.matFiltro = matFiltro;
let _recBusca = '';
function _recFilasHtml() {
  const q = _normTxt(_recBusca);
  const rs = recetas.filter(r => !q || _normTxt(r.articulo+' '+r.formato).includes(q));
  const filas = rs.map(r => `<div onclick="abrirRecetaDirecta('${r.id}')" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:9px 12px;margin-top:8px">
      <div><b style="font-size:13px">${_esc(r.articulo)}</b><div style="color:var(--t2);font-size:11.5px">${_esc(r.formato)} · ${(r.items||[]).length} material${(r.items||[]).length===1?'':'es'}</div></div>
      <span style="font-size:16px">›</span>
    </div>`).join('');
  return filas || `<div style="color:var(--t3);font-size:12.5px;padding:4px 2px">${recetas.length ? 'Ninguna receta coincide.' : 'Aún no has definido ninguna receta.'}</div>`;
}
function recBuscar(v) { _recBusca = v; const c = document.getElementById('rec-filas'); if (c) c.innerHTML = _recFilasHtml(); }
function _matRecetasHtml() {
  const buscador = recetas.length>5 ? `<input id="rec-buscar" type="search" placeholder="🔎 Buscar receta por artículo..." value="${_esc(_recBusca)}" oninput="recBuscar(this.value)" style="width:100%;padding:10px;font-size:13.5px;border:1px solid var(--border2);border-radius:12px;background:var(--surface);color:var(--t1);margin-top:8px">` : '';
  return `<div class="fsec" style="margin-top:16px">Recetas por artículo</div>
    ${buscador}
    <div id="rec-filas">${_recFilasHtml()}</div>
    <button type="button" onclick="matNuevaReceta()" style="width:100%;margin-top:8px;padding:9px;border:1px dashed var(--border2);border-radius:10px;background:transparent;color:var(--t2);font-weight:700;cursor:pointer">＋ Nueva receta (aunque el artículo aún no se haya fabricado)</button>`;
}
window.recBuscar = recBuscar;
function abrirRecetaDirecta(id) {
  const r = recetas.find(x=>String(x.id)===String(id)); if (!r) return;
  _recetaArticulo = r.articulo; _recetaFormato = r.formato; _prArt = '';
  prIr('receta');
}
function matNuevaReceta() { _recetaArticulo=''; _recetaFormato=''; _prArt=''; prIr('receta-nueva'); }
window.abrirRecetaDirecta = abrirRecetaDirecta; window.matNuevaReceta = matNuevaReceta;
function matAbrir(id) { _matId = id; prIr('mat-detalle'); }
function _matDetalleHtml() {
  const m = materiales.find(x=>String(x.id)===String(_matId)); if (!m) return '';
  const stock = parseFloat(m.stock)||0;
  return `<div style="margin-bottom:12px">
    <div style="font-size:18px;font-weight:900">${_esc(m.nombre||'')}</div>
    <div style="background:var(--surface2);border-radius:12px;padding:8px 14px;display:inline-block;margin-top:8px"><span style="font-size:26px;font-weight:900">${_fmtN(stock)}</span> ${_matUnidadTxt(m.unidad)}</div>
    ${m.stockMin ? `<div style="color:var(--t2);font-size:12px;margin-top:6px">Mínimo: ${_fmtN(m.stockMin)} ${_matUnidadTxt(m.unidad)}</div>` : ''}
  </div>
  <div class="fgrid full"><div class="fg"><label>➕ Registrar entrada (compra recibida)</label>
    <div style="display:flex;gap:8px"><input id="mat-entrada" type="number" step="any" placeholder="Cantidad recibida" style="flex:1"><button onclick="matEntrada()" style="padding:0 18px;border:none;border-radius:10px;background:var(--brand-primary);color:var(--dhl-dark);font-weight:800;cursor:pointer">Sumar</button></div>
  </div></div>
  <div class="fgrid full"><div class="fg"><label>Proveedor / albarán (opcional)</label><input id="mat-entrada-nota" placeholder="Ej: Envaguadex, albarán 1234"></div></div>
  <div style="display:flex;gap:8px;margin-top:14px">
    <button onclick="matEditar('${m.id}')" style="flex:1;padding:12px;border:1px solid var(--border2);border-radius:12px;background:var(--surface);color:var(--t1);font-weight:800;cursor:pointer">✏️ Editar</button>
    <button onclick="matBorrar('${m.id}')" style="flex:1;padding:12px;border:1px solid var(--border2);border-radius:12px;background:var(--surface);color:#DC3545;font-weight:800;cursor:pointer">🗑️ Eliminar</button>
  </div>
  <button type="button" onclick="matVerMovs('${m.id}')" style="width:100%;margin-top:8px;padding:11px;border:1px dashed var(--border2);border-radius:12px;background:transparent;color:var(--t2);font-weight:700;cursor:pointer">📋 Ver movimientos de este material</button>
  ${_matMovsMiniHtml(m.id)}`;
}
function _matMovsMiniHtml(materialId) {
  const movs = movimientosMat.filter(v=>String(v.materialId)===String(materialId)).slice(0,5);
  if (!movs.length) return '';
  return `<div class="fsec" style="margin-top:16px">Últimos movimientos</div>${movs.map(_movFilaHtml).join('')}`;
}
async function matEntrada() {
  const m = materiales.find(x=>String(x.id)===String(_matId)); if (!m) return;
  const c = parseFloat(document.getElementById('mat-entrada').value);
  if (!(c>0)) { toast('⚠️ Indica una cantidad'); return; }
  const notas = document.getElementById('mat-entrada-nota')?.value.trim();
  const nuevo = (parseFloat(m.stock)||0) + c;
  await fbSaveMaterial({ ...m, stock: nuevo });
  await registrarMovMaterial(m, c, nuevo, notas || 'Entrada manual', 'entrada');
  toast('✅ Entrada registrada: +'+_fmtN(c)+' '+_matUnidadTxt(m.unidad));
  document.getElementById('mat-entrada').value = '';
  if (document.getElementById('mat-entrada-nota')) document.getElementById('mat-entrada-nota').value = '';
  renderProduccionList();
}
function matNuevo() { _matId = ''; prIr('mat-form'); }
function matEditar(id) { _matId = id; prIr('mat-form'); }
function _matFormHtml() {
  const m = _matId ? materiales.find(x=>String(x.id)===String(_matId)) : null;
  return `<div class="fsec">${m ? 'Editar material' : 'Nuevo material'}</div>
  <div class="fgrid full"><div class="fg"><label>📦 Nombre</label><input id="mat-nombre" placeholder="Botella 1L, Tapón, Cartón caja 12ud, Bobina complejo 400ml..." value="${_esc(m?.nombre)}"></div></div>
  <div class="fgrid">
    <div class="fg"><label>📐 Unidad</label><select id="mat-unidad"><option value="uds" ${m?.unidad==='uds'?'selected':''}>Unidades</option><option value="kg" ${m?.unidad==='kg'?'selected':''}>Kg</option><option value="m" ${m?.unidad==='m'?'selected':''}>Metros</option></select></div>
    <div class="fg"><label>📊 Stock ${m?'actual':'inicial'}</label><input id="mat-stock" type="number" step="any" placeholder="0" value="${m?_esc(m.stock):''}"></div>
  </div>
  <div class="fgrid full"><div class="fg"><label>⚠️ Stock mínimo (avisa por debajo)</label><input id="mat-stockmin" type="number" step="any" placeholder="0" value="${_esc(m?.stockMin)}"></div></div>
  <button type="button" onclick="matGuardar()" style="width:100%;margin-top:10px;padding:12px;border:none;border-radius:12px;background:var(--brand-primary);color:var(--dhl-dark);font-weight:800;font-size:15px;cursor:pointer">💾 Guardar</button>`;
}
async function matGuardar() {
  const nombre = document.getElementById('mat-nombre').value.trim().toUpperCase();
  if (!nombre) { toast('⚠️ Indica el nombre del material'); return; }
  const prev = _matId ? materiales.find(x=>String(x.id)===String(_matId)) : null;
  const id = _matId || 'mat_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
  const nuevoStock = parseFloat(document.getElementById('mat-stock').value)||0;
  const material = { id, nombre, unidad: document.getElementById('mat-unidad').value,
    stock: nuevoStock, stockMin: parseFloat(document.getElementById('mat-stockmin').value)||0 };
  await fbSaveMaterial(material);
  const difStock = nuevoStock - (parseFloat(prev?.stock)||0);
  if (prev && difStock) await registrarMovMaterial(material, difStock, nuevoStock, 'Ajuste manual (edición)', 'ajuste');
  toast(_matId ? '💾 Material actualizado' : '✅ Material creado');
  _matId = id; prIr('mat-detalle');
}
function matBorrar(id) {
  confirm2('🗑','¿Eliminar material?','Esta acción no se puede deshacer','Eliminar','',async()=>{
    await fbDeleteMaterial(id);
    toast('🗑 Material eliminado');
    prIr('materiales');
  });
}
// ── Informe de movimientos de materiales (entradas, consumos, ajustes) ──
let _movMaterialId = '', _movBusca = '', _movTipo = 'todos', _movDesde = '', _movHasta = '';
function _movFilaHtml(v) {
  const pos = (parseFloat(v.cantidad)||0) >= 0;
  const icono = pos ? '➕' : '➖';
  const color = pos ? '#22A559' : '#DC3545';
  return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:9px 12px;margin-top:6px">
    <div style="min-width:0">
      <div style="font-size:12.5px;font-weight:700">${icono} ${_esc(v.materialNombre||'')}</div>
      <div style="color:var(--t2);font-size:11px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_fdate(v.fecha)} · ${_esc(v.motivo||'')}</div>
    </div>
    <div style="text-align:right;flex:0 0 auto">
      <div style="font-weight:800;color:${color};font-size:13px">${pos?'+':''}${_fmtN(v.cantidad)} ${_matUnidadTxt(v.unidad)}</div>
      <div style="color:var(--t2);font-size:10.5px">stock: ${_fmtN(v.stockResultante)}</div>
    </div>
  </div>`;
}
const _MOV_TIPO_TXT = { entrada:'Entrada', consumo:'Consumo', devolucion:'Devolución', ajuste:'Ajuste' };
function matVerMovs(materialId) {
  _movMaterialId = materialId||''; _movTipo='todos'; _movDesde=''; _movHasta=''; _movBusca='';
  prIr('mat-movs');
}
function _movFiltrados() {
  const q = _normTxt(_movBusca);
  return movimientosMat.filter(v =>
    (!_movMaterialId || String(v.materialId)===String(_movMaterialId)) &&
    (_movTipo==='todos' || v.tipo===_movTipo) &&
    (!_movDesde || v.fecha>=_movDesde) && (!_movHasta || v.fecha<=_movHasta) &&
    (!q || _normTxt(v.materialNombre+' '+v.motivo).includes(q)));
}
function _movResumenHtml(lista) {
  const entra = lista.filter(v=>v.cantidad>0).reduce((a,v)=>a+v.cantidad,0);
  const sale = lista.filter(v=>v.cantidad<0).reduce((a,v)=>a-v.cantidad,0);
  return `<div style="display:flex;gap:8px;margin:10px 0"><div style="flex:1;background:var(--surface2);border-radius:10px;padding:8px 10px"><div style="font-size:10.5px;color:var(--t2)">Entradas</div><div style="font-weight:800;color:#22A559">+${_fmtN(entra)}</div></div><div style="flex:1;background:var(--surface2);border-radius:10px;padding:8px 10px"><div style="font-size:10.5px;color:var(--t2)">Salidas</div><div style="font-weight:800;color:#DC3545">-${_fmtN(sale)}</div></div><div style="flex:1;background:var(--surface2);border-radius:10px;padding:8px 10px"><div style="font-size:10.5px;color:var(--t2)">Movimientos</div><div style="font-weight:800">${lista.length}</div></div></div>`;
}
function _matMovsHtml() {
  const lista = _movFiltrados();
  const opsMat = `<option value="">Todos los materiales</option>` + materiales.map(m=>`<option value="${m.id}" ${_movMaterialId===m.id?'selected':''}>${_esc(m.nombre)}</option>`).join('');
  const opsTipo = `<option value="todos">Todos los movimientos</option>` + Object.entries(_MOV_TIPO_TXT).map(([k,t])=>`<option value="${k}" ${_movTipo===k?'selected':''}>${t}</option>`).join('');
  const filtros = `<div class="fsec">Filtrar movimientos</div>
    <div class="fgrid full"><div class="fg"><label>Material</label><select id="mov-f-mat" onchange="movFiltroCambia()">${opsMat}</select></div></div>
    <div class="fgrid"><div class="fg"><label>Tipo</label><select id="mov-f-tipo" onchange="movFiltroCambia()">${opsTipo}</select></div>
      <div class="fg"><label>Buscar en motivo</label><input id="mov-buscar" type="search" placeholder="Artículo, albarán..." value="${_esc(_movBusca)}" oninput="movFiltroCambia()"></div></div>
    <div class="fgrid"><div class="fg"><label>Desde</label><input id="mov-f-desde" type="date" value="${_esc(_movDesde)}" onchange="movFiltroCambia()"></div>
      <div class="fg"><label>Hasta</label><input id="mov-f-hasta" type="date" value="${_esc(_movHasta)}" onchange="movFiltroCambia()"></div></div>`;
  const acciones = `<div style="display:flex;gap:8px;margin:12px 0 4px"><button onclick="imprimirMovsMateriales()" style="flex:1;padding:10px;border:1px solid var(--border2);border-radius:10px;background:var(--surface);color:var(--t1);font-weight:800;cursor:pointer">🖨️ Imprimir</button><button onclick="compartirMovsMateriales()" style="flex:1;padding:10px;border:1px solid var(--border2);border-radius:10px;background:var(--surface);color:var(--t1);font-weight:800;cursor:pointer">📤 Compartir</button></div>`;
  const cuerpo = lista.length ? _movResumenHtml(lista) + lista.slice(0,200).map(_movFilaHtml).join('') : '<div style="text-align:center;color:var(--t3);padding:20px 10px;font-size:13px">Sin movimientos con estos filtros.</div>';
  return filtros + acciones + `<div id="mov-lista">${cuerpo}</div>`;
}
function movFiltroCambia() {
  _movMaterialId = document.getElementById('mov-f-mat').value;
  _movTipo = document.getElementById('mov-f-tipo').value;
  _movDesde = document.getElementById('mov-f-desde').value;
  _movHasta = document.getElementById('mov-f-hasta').value;
  _movBusca = document.getElementById('mov-buscar').value;
  const c = document.getElementById('mov-lista'); if (c) c.innerHTML = _movFiltrados().length
    ? _movResumenHtml(_movFiltrados()) + _movFiltrados().slice(0,200).map(_movFilaHtml).join('')
    : '<div style="text-align:center;color:var(--t3);padding:20px 10px;font-size:13px">Sin movimientos con estos filtros.</div>';
}
function _movTitulo() {
  const m = _movMaterialId ? materiales.find(x=>String(x.id)===String(_movMaterialId)) : null;
  return 'Movimientos de materiales' + (m?' · '+m.nombre:'') + (_movTipo!=='todos'?' · '+_MOV_TIPO_TXT[_movTipo]:'');
}
function imprimirMovsMateriales() {
  const lista = _movFiltrados();
  const fecha = new Date().toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'});
  const filas = lista.map(v => `<tr><td>${_fdate(v.fecha)}</td><td>${_esc(v.materialNombre||'')}</td><td>${_MOV_TIPO_TXT[v.tipo]||v.tipo||''}</td><td style="text-align:right;color:${v.cantidad>=0?'#22A559':'#DC3545'}">${v.cantidad>=0?'+':''}${_fmtN(v.cantidad)} ${_matUnidadTxt(v.unidad)}</td><td style="text-align:right">${_fmtN(v.stockResultante)}</td><td>${_esc(v.motivo||'')}</td></tr>`).join('');
  const html = `<html><head><meta charset="utf-8"><title>${_movTitulo()}</title><style>
    body{font-family:Arial,sans-serif;padding:20px;color:#222}
    h1{font-size:18px;margin:0 0 2px}
    .sub{color:#666;font-size:12px;margin-bottom:14px}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}
    th{background:#f4f4f4}
  </style></head><body>
    <h1>${_movTitulo()}</h1>
    <div class="sub">${fecha} · SAT GUADEX · Palma del Río · ${lista.length} movimiento${lista.length===1?'':'s'}</div>
    <table><thead><tr><th>Fecha</th><th>Material</th><th>Tipo</th><th style="text-align:right">Cantidad</th><th style="text-align:right">Stock resultante</th><th>Motivo</th></tr></thead><tbody>${filas}</tbody></table>
  </body></html>`;
  const win = window.open('','_blank','width=960,height=700');
  win.document.write(html + `<script>window.onload=()=>{window.print();}<\/script>`);
  win.document.close();
}
async function compartirMovsMateriales() {
  const lista = _movFiltrados();
  const fecha = new Date().toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'});
  const lines = [`🧱 *${_movTitulo()}*`, `📅 ${fecha} · ${lista.length} movimiento${lista.length===1?'':'s'}`, ''];
  lista.slice(0,300).forEach(v => {
    lines.push(`${v.cantidad>=0?'➕':'➖'} *${v.materialNombre}*: ${v.cantidad>=0?'+':''}${_fmtN(v.cantidad)} ${_matUnidadTxt(v.unidad)} (${_MOV_TIPO_TXT[v.tipo]||v.tipo})`);
    lines.push(`   ${_fdate(v.fecha)} · ${v.motivo||''} · stock: ${_fmtN(v.stockResultante)}`);
  });
  lines.push('——————————————', 'SAT GUADEX · Palma del Río');
  const texto = lines.join('\n');
  if (navigator.share) {
    try { await navigator.share({ title: _movTitulo(), text: texto }); toast('📱 Compartido'); }
    catch(e) { if (e.name!=='AbortError') { await navigator.clipboard.writeText(texto); toast('📋 Copiado al portapapeles'); } }
  } else {
    try { await navigator.clipboard.writeText(texto); toast('📋 Copiado al portapapeles'); }
    catch(e) { toast('❌ No se pudo compartir'); }
  }
}
window.matVerMovs = matVerMovs; window.movFiltroCambia = movFiltroCambia;
window.imprimirMovsMateriales = imprimirMovsMateriales; window.compartirMovsMateriales = compartirMovsMateriales;

// Vuelve a aplicar la receta de materiales sobre un lote ya existente, como si acabara de entrar en stock.
// Útil cuando el lote se creó antes de tener la receta (o antes de que se actualizara) y no se descontó nada.
function recalcularConsumoLote(id) {
  const l = producciones.find(x=>String(x.id)===String(id)); if (!l) return;
  const cajasEq = _cajasEq(l);
  if (cajasEq<=0) { toast('⚠️ Este lote no tiene cajas en stock que descontar'); return; }
  const r = recetaPara(l.articulo, l.formato);
  if (!r || !(r.items||[]).length) { toast('⚠️ Este artículo y formato no tienen receta de materiales'); return; }
  const detalle = r.items.map(it => {
    const m = materiales.find(x=>String(x.id)===String(it.materialId));
    return m ? `${m.nombre}: -${_fmtN(cajasEq*(parseFloat(it.cantidad)||0))} ${_matUnidadTxt(m.unidad)}` : '';
  }).filter(Boolean).join('\n');
  confirm2('🔁','¿Recalcular consumo de este lote?', `Se descontará de nuevo, como si el lote entrara ahora en stock:\n${detalle}`, 'Descontar', '', async()=>{
    await consumirMateriales(l.articulo, l.formato, cajasEq);
    toast('✅ Consumo aplicado');
  });
}
window.recalcularConsumoLote = recalcularConsumoLote;

window.matAbrir = matAbrir; window.matEntrada = matEntrada; window.matNuevo = matNuevo;
window.matEditar = matEditar; window.matGuardar = matGuardar; window.matBorrar = matBorrar;

// ── Receta de un artículo+formato (desde su ficha de producto en Stock) ──
let _recetaArticulo = '', _recetaFormato = '';
function abrirReceta() {
  const g = _grupos().find(x=>x.key===_prArt);
  _recetaArticulo = g?.articulo||''; _recetaFormato = g?.formato||'';
  prIr('receta');
}
function _recetaFormHtml() {
  const r = recetaPara(_recetaArticulo, _recetaFormato);
  const items = (r?.items||[]).length ? r.items : [{materialId:'',cantidad:''}];
  return `<div style="margin-bottom:4px"><div style="font-size:16px;font-weight:900">${_esc(_recetaArticulo)}</div><div style="color:var(--t2);font-size:12.5px">${_esc(_recetaFormato)} · cantidades por CADA CAJA producida</div></div>
  <div id="receta-filas">${items.map(_recetaFilaHtml).join('')}</div>
  <button type="button" onclick="_recetaAddFila()" style="width:100%;margin-top:8px;padding:9px;border:1px dashed var(--border2);border-radius:10px;background:transparent;color:var(--t2);font-weight:700;cursor:pointer">＋ Añadir material</button>
  <button type="button" onclick="_recetaGuardar()" style="width:100%;margin-top:14px;padding:12px;border:none;border-radius:12px;background:var(--brand-primary);color:var(--dhl-dark);font-weight:800;font-size:15px;cursor:pointer">💾 Guardar receta</button>
  ${!materiales.length ? '<div style="color:var(--t2);font-size:12px;margin-top:10px">Todavía no tienes materiales dados de alta — hazlo primero en la pestaña 🧱 Materiales.</div>' : ''}`;
}
function _recetaFilaHtml(it) {
  return `<div class="fgrid">
    <div class="fg"><label>Material</label><select onchange="_recetaCambio()">
      <option value="">— Elegir —</option>${materiales.map(m=>`<option value="${m.id}" ${it.materialId===m.id?'selected':''}>${_esc(m.nombre)}</option>`).join('')}
    </select></div>
    <div class="fg"><label>Cantidad por caja</label><input type="number" step="any" placeholder="0" value="${_esc(it.cantidad)}" oninput="_recetaCambio()"></div>
  </div>`;
}
function _recetaAddFila() {
  document.getElementById('receta-filas').insertAdjacentHTML('beforeend', _recetaFilaHtml({materialId:'',cantidad:''}));
}
function _recetaCambio() {}
async function _recetaGuardar() {
  const articulo = (_prView==='receta-nueva' ? document.getElementById('rn-articulo').value : _recetaArticulo).trim().toUpperCase();
  const formato = (_prView==='receta-nueva' ? document.getElementById('rn-formato').value : _recetaFormato).trim().toUpperCase();
  if (!articulo) { toast('⚠️ Indica el artículo'); return; }
  const items = [...document.querySelectorAll('#receta-filas .fgrid')].map(row => ({
    materialId: row.querySelector('select').value,
    cantidad: parseFloat(row.querySelector('input').value)||0,
  })).filter(it => it.materialId && it.cantidad>0);
  const prev = recetaPara(articulo, formato);
  await fbSaveReceta({ id: prev?.id || ('receta_'+Date.now()+'_'+Math.random().toString(36).slice(2,7)), articulo, formato, items });
  toast('💾 Receta guardada');
  prIr('materiales');
}
window.abrirReceta = abrirReceta; window._recetaAddFila = _recetaAddFila; window._recetaCambio = _recetaCambio; window._recetaGuardar = _recetaGuardar;

// ══════════ PANTALLA DE STOCK: tarjetas por artículo + formato ══════════
let _prView = 'stock', _prArt = '', _prBusca = '', _prFiltro = 'todos';
const _keyArt = l => (l.articulo||'').trim().toUpperCase()+'|'+(l.formato||'').trim().toUpperCase();
const _normTxt = t => (t||'').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const _fdate = d => d ? d.split('-').reverse().join('/') : '';
function _diasCad(cad) { if (!cad) return null; const h = new Date(); h.setHours(0,0,0,0); return Math.ceil((new Date(cad+'T00:00:00')-h)/86400000); }
function _grupos() {
  const m = new Map();
  producciones.forEach(l => {
    if (!(l.articulo||'').trim()) return;
    const k = _keyArt(l);
    const g = m.get(k) || { key:k, articulo:(l.articulo||'').trim().toUpperCase(), formato:(l.formato||'').trim().toUpperCase(), lotes:[], pal:0, caj:0, bLl:0, bEt:0, cad:null };
    g.lotes.push(l);
    if (_esFases(l) && l.fase!=='encajado') { const b = parseFloat(l[_campoTotal(l.tipo)])||0; if (l.fase==='etiquetado') g.bEt += b; else g.bLl += b; }
    else { const d = _dispLote(l); g.pal += d.palets; g.caj += d.cajas; if ((d.palets>0||d.cajas>0) && l.caducidad && (!g.cad || l.caducidad<g.cad)) g.cad = l.caducidad; }
    m.set(k, g);
  });
  const arr = [...m.values()];
  arr.forEach(g => { g.stock = g.pal>0||g.caj>0; g.proc = g.bLl+g.bEt; g.dias = _diasCad(g.cad); g.porCad = g.stock && g.dias!==null && g.dias<=30; g.agot = !g.stock && g.proc<=0; });
  return arr.sort((a,b)=>a.articulo.localeCompare(b.articulo)||a.formato.localeCompare(b.formato));
}
const _pasa = (g,f) => f==='todos' || (f==='stock'&&g.stock) || (f==='agotado'&&g.agot) || (f==='caducar'&&g.porCad) || (f==='brik'&&g.proc>0);
function _prCardHtml(g) {
  const col = g.agot ? '#DC3545' : (!g.stock ? '#3B82F6' : (g.pal<=1 ? '#2A6FB0' : '#22A559'));
  const chip = (bg,fg,t) => `<span style="background:${bg};color:${fg};border-radius:999px;padding:2px 8px;font-size:10.5px;font-weight:800">${t}</span>`;
  return `<div onclick="prAbrirArt('${encodeURIComponent(g.key)}')" style="cursor:pointer;background:var(--surface);border:1px solid var(--border);border-left:6px solid ${col};border-radius:14px;padding:11px 12px;min-height:122px;display:flex;flex-direction:column">
    <div style="font-weight:800;font-size:13px;line-height:1.2">${_esc(g.articulo)}</div>
    <div style="font-size:11px;color:var(--t2);min-height:14px">${_esc(g.formato)}</div>
    <div style="margin-top:auto;padding-top:6px"><span style="font-size:32px;font-weight:900;line-height:1">${g.pal}</span> <span style="font-size:12px;font-weight:700">pal.</span>
      <div style="font-size:12px;color:var(--t2)">${g.caj>0 ? '+ '+g.caj+' cajas' : (g.agot ? 'agotado' : '&nbsp;')}</div></div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px">${g.proc>0 ? chip('rgba(59,130,246,.15)','#2563EB','🧃 '+_fmtN(g.proc)) : ''}${g.porCad ? chip('#DC3545','#fff','⏳ Cad. '+_fdate(g.cad)) : ''}</div>
  </div>`;
}
function _prGridHtml() {
  const q = _normTxt(_prBusca);
  const gs = _grupos().filter(g => _pasa(g,_prFiltro) && (!q || _normTxt([g.articulo,g.formato,...g.lotes.map(l=>[l.numProd,l.lote,l.marca].join(' '))].join(' ')).includes(q)));
  if (!gs.length) return '<div style="text-align:center;color:var(--t3);padding:30px 10px;font-size:13px">No hay artículos que coincidan.</div>';
  return `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">${gs.map(_prCardHtml).join('')}</div>`;
}
function _prStockHtml() {
  const gs = _grupos();
  const chips = [['todos','Todos'],['stock','Con stock'],['agotado','Agotados'],['caducar','Por caducar'],['brik','Brik en proceso']].map(([f,t]) =>
    `<button onclick="prFiltro('${f}')" style="flex:0 0 auto;padding:8px 12px;border-radius:999px;border:1px solid var(--border2);font-size:12.5px;font-weight:800;cursor:pointer;background:${_prFiltro===f?'var(--dhl-dark)':'var(--surface)'};color:${_prFiltro===f?'#fff':'var(--t1)'}">${t} ${gs.filter(g=>_pasa(g,f)).length}</button>`).join('');
  const sum = (k) => gs.reduce((a,g)=>a+g[k],0);
  const box = (v,t) => `<div style="flex:0 0 auto;background:var(--surface2);border-radius:12px;padding:8px 12px;min-width:92px"><div style="font-size:18px;font-weight:900">${_fmtN(v)}</div><div style="font-size:10.5px;color:var(--t2)">${t}</div></div>`;
  return `<input id="pr-buscar" type="search" placeholder="🔎 Buscar artículo, formato, lote..." value="${_esc(_prBusca)}" oninput="prBuscar(this.value)" style="width:100%;padding:12px;font-size:15px;border:1px solid var(--border2);border-radius:12px;background:var(--surface);color:var(--t1)">
    <div style="display:flex;gap:6px;overflow-x:auto;margin:10px 0 8px;padding-bottom:2px">${chips}</div>
    <div style="display:flex;gap:8px;overflow-x:auto;margin-bottom:12px">${box(sum('pal'),'palets en stock')}${box(gs.filter(g=>g.stock).length,'artículos con stock')}${box(sum('bLl'),'bricks en llenado')}${box(sum('bEt'),'bricks etiquetados')}</div>
    <div style="display:flex;gap:8px;margin-bottom:12px"><button onclick="imprimirStockActual()" style="flex:1;padding:10px;border:1px solid var(--border2);border-radius:10px;background:var(--surface);color:var(--t1);font-weight:800;cursor:pointer">🖨️ Imprimir stock</button><button onclick="compartirStockActual()" style="flex:1;padding:10px;border:1px solid var(--border2);border-radius:10px;background:var(--surface);color:var(--t1);font-weight:800;cursor:pointer">📤 Compartir stock</button></div>
    <div id="pr-grid">${_prGridHtml()}</div>`;
}
// Grupos que se ven ahora mismo en pantalla (respeta buscador y chip de filtro activos)
function _stockGruposVisibles() {
  const q = _normTxt(_prBusca);
  return _grupos().filter(g => _pasa(g,_prFiltro) && (!q || _normTxt([g.articulo,g.formato,...g.lotes.map(l=>[l.numProd,l.lote,l.marca].join(' '))].join(' ')).includes(q)));
}
function imprimirStockActual() {
  const gs = _stockGruposVisibles();
  const fecha = new Date().toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'});
  const filas = gs.map(g => `<tr><td>${_esc(g.articulo)}</td><td>${_esc(g.formato)}</td><td style="text-align:right">${g.pal}</td><td style="text-align:right">${g.caj}</td><td style="text-align:right">${g.proc>0?_fmtN(g.proc):''}</td><td>${g.cad?_fdate(g.cad):''}</td></tr>`).join('');
  const html = `<html><head><meta charset="utf-8"><title>Stock de producción</title><style>
    body{font-family:Arial,sans-serif;padding:20px;color:#222} h1{font-size:18px;margin:0 0 2px} .sub{color:#666;font-size:12px;margin-bottom:14px}
    table{width:100%;border-collapse:collapse;font-size:12px} th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left} th{background:#f4f4f4}
  </style></head><body><h1>Stock de producción</h1><div class="sub">${fecha} · SAT GUADEX · Palma del Río · ${gs.length} artículo${gs.length===1?'':'s'}</div>
  <table><thead><tr><th>Artículo</th><th>Formato</th><th style="text-align:right">Palets</th><th style="text-align:right">Cajas</th><th style="text-align:right">En proceso</th><th>Caduca</th></tr></thead><tbody>${filas}</tbody></table></body></html>`;
  const win = window.open('','_blank','width=960,height=700');
  win.document.write(html + `<script>window.onload=()=>{window.print();}<\/script>`);
  win.document.close();
}
async function compartirStockActual() {
  const gs = _stockGruposVisibles();
  const fecha = new Date().toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'});
  const lines = [`📦 *Stock de producción*`, `📅 ${fecha} · ${gs.length} artículo${gs.length===1?'':'s'}`, ''];
  gs.forEach(g => lines.push(`• *${g.articulo}*${g.formato?' ('+g.formato+')':''}: ${g.pal} pal.${g.caj?' + '+g.caj+' cajas':''}${g.proc>0?' · '+_fmtN(g.proc)+' en proceso':''}${g.cad?' · cad. '+_fdate(g.cad):''}`));
  lines.push('——————————————', 'SAT GUADEX · Palma del Río');
  const texto = lines.join('\n');
  if (navigator.share) {
    try { await navigator.share({ title:'Stock de producción', text: texto }); toast('📱 Compartido'); }
    catch(e) { if (e.name!=='AbortError') { await navigator.clipboard.writeText(texto); toast('📋 Copiado al portapapeles'); } }
  } else {
    try { await navigator.clipboard.writeText(texto); toast('📋 Copiado al portapapeles'); }
    catch(e) { toast('❌ No se pudo compartir'); }
  }
}
window.imprimirStockActual = imprimirStockActual; window.compartirStockActual = compartirStockActual;
function _stepper(l) {
  const F = ['llenado','etiquetado','encajado'], T = ['Llenado','Etiquetado','Encajado'], C = ['#2A6FB0','#3B82F6','#22A559'], i = F.indexOf(l.fase||'llenado');
  return `<div style="display:flex;align-items:center;gap:4px;margin:8px 0 2px;font-size:11px;flex-wrap:wrap">${F.map((x,j)=>`<span style="padding:3px 9px;border-radius:999px;font-weight:${j===i?800:600};background:${j<=i?C[j]:'var(--surface2)'};color:${j<=i?'#fff':'var(--t3)'}">${T[j]}</span>`).join('<span style="color:var(--t3)">›</span>')}</div>`;
}
function _prLoteCard(l, opts) {
  opts = opts || {};
  const d = _dispLote(l), enProc = _esFases(l) && l.fase!=='encajado', agot = !enProc && d.palets<=0 && d.cajas<=0;
  const info = [l.marca, l.lote?'Lote '+l.lote:'', l.caducidad?'Cad. '+_fdate(l.caducidad):'', l.cajasPorPalet?l.cajasPorPalet+' cajas/palet':'', (l.tipo==='normal' && l.botellasPorCaja)?l.botellasPorCaja+' botellas/caja · '+_fmtN(l.totalBotellas||0)+' botellas':''].filter(Boolean).join(' · ');
  return `<div style="background:${agot?'var(--surface2)':'var(--surface)'};opacity:${agot?0.6:1};border:1px solid var(--border);border-radius:14px;padding:12px;margin-bottom:10px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><b style="font-size:14px">${l.numProd||'Sin nº'}</b>${opts.badge||''}</span>
      <span style="display:flex;gap:6px">${_cajasEq(l)>0 ? `<button class="tbl-btn" onclick="recalcularConsumoLote('${l.id}')" title="Recalcular consumo de materiales" style="font-size:14px;padding:6px 10px">🔁</button>` : ''}<button class="tbl-btn" onclick="editarLoteProduccion('${l.id}')" title="Editar lote" style="font-size:14px;padding:6px 10px">✏️</button><button class="tbl-btn tbl-del" onclick="eliminarLoteProduccion('${l.id}')" title="Eliminar lote" style="font-size:14px;padding:6px 10px">🗑️</button></span></div>
    ${opts.art ? `<div style="font-weight:700;font-size:12.5px;margin-top:2px">${_esc((l.articulo||'').toUpperCase())}${l.formato?' · '+_esc((l.formato||'').toUpperCase()):''}</div>` : ''}
    ${info?`<div style="color:var(--t2);margin-top:3px;font-size:12px">${info}</div>`:''}
    ${_paraHtml(l)}
    ${_esFases(l) ? _stepper(l)+_brikInfoHtml(l) : ''}
    ${enProc ? '' : `<div style="margin-top:8px;font-size:15px">Restante: <b>${d.palets} pal.</b> + <b>${d.cajas} cajas</b>${agot?' · <span style="color:var(--status-load)">agotado</span>':''}</div>`}
  </div>`;
}
function _prDetalleHtml() {
  const g = _grupos().find(x=>x.key===_prArt); if (!g) return '';
  const lotes = [...g.lotes].sort((a,b)=>(a.numProd||'').localeCompare(b.numProd||'') || (a.caducidad||'9').localeCompare(b.caducidad||'9'));
  return `<div style="margin-bottom:12px"><div style="font-size:18px;font-weight:900">${_esc(g.articulo)}</div><div style="color:var(--t2);font-size:13px">${_esc(g.formato)}</div>
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><div style="background:var(--surface2);border-radius:12px;padding:8px 14px"><span style="font-size:26px;font-weight:900">${g.pal}</span> pal. <span style="color:var(--t2)">+ ${g.caj} cajas</span></div>${g.proc>0?`<div style="background:rgba(59,130,246,.15);color:#2563EB;border-radius:12px;padding:8px 14px;font-weight:800">🧃 ${_fmtN(g.proc)} bricks en proceso</div>`:''}<button onclick="abrirReceta()" style="border:none;background:var(--surface2);border-radius:12px;padding:8px 14px;font-weight:800;font-size:13px;cursor:pointer;color:var(--t1)">📋 Receta de materiales</button></div></div>${lotes.map(_prLoteCard).join('')}`;
}
// ── Líneas de producto de un pedido (principal + extras), para cruzar con stock ──
function _prLineasPedido(p) {
  const lineas = [{ articulo:p.producto||'', formato:p.formato||'', prod:p.prodRef||'', pal:parseFloat(p.uds)||0, caj:parseFloat(p.cajas)||0 }];
  (p.productosExtra||[]).forEach(pe => lineas.push({ articulo:pe.producto||'', formato:pe.formato||'', prod:pe.prodRef||'', pal:parseFloat(pe.uds)||0, caj:parseFloat(pe.cajas)||0 }));
  return lineas.filter(l => l.articulo);
}
// ── Vista: pedidos pendientes cuyo stock/producción no llega ──
function _prPedidosFaltantes() {
  return pedidos
    .filter(p => p.status !== 'cargado')
    .map(p => {
      const faltantes = _prLineasPedido(p)
        .filter(l => producciones.some(x => (x.articulo||'').trim().toUpperCase() === l.articulo.trim().toUpperCase()))
        .map(l => ({ ...l, pc: planConsumo(l.articulo, l.pal, l.caj, l.formato, p.id, l.prod, true) }))
        .filter(l => l.pc.faltaPal > 0 || l.pc.faltaCaj > 0);
      return { p, faltantes };
    })
    .filter(r => r.faltantes.length)
    .sort((a, b) => (a.p.fecha||'9999').localeCompare(b.p.fecha||'9999'));
}
function _prPedidosHtml() {
  const rows = _prPedidosFaltantes();
  if (!rows.length) return '<div style="text-align:center;color:var(--t3);padding:30px 10px;font-size:13px">✅ No hay pedidos pendientes con falta de stock.</div>';
  return `<div style="font-size:11.5px;color:var(--t3);margin-bottom:6px">${rows.length} pedido${rows.length!==1?'s':''} con falta de stock</div>` +
    rows.map(({ p, faltantes }) => `<div onclick="prVerPedido('${p.id}')" style="cursor:pointer;background:var(--surface);border:1px solid var(--border);border-left:6px solid var(--dhl-red);border-radius:14px;padding:12px;margin-bottom:10px">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b style="font-size:14px">${_esc(p.grupo||'—')}${p.num?' · #'+_esc(p.num):''}</b>${p.fecha?`<span style="color:var(--t2);font-size:12px;font-family:var(--font-mono)">${_fdate(p.fecha)}</span>`:''}</div>
    ${faltantes.map(l => `<div style="margin-top:5px;font-size:12.5px;color:#B02A37">⚠️ ${_esc(l.articulo)}${l.formato?' · '+_esc(l.formato):''}: faltan ${_fmtN(l.pc.faltaPal)} pal. / ${_fmtN(l.pc.faltaCaj)} cajas</div>`).join('')}
  </div>`).join('');
}
function prVerPedido(id) { closeProduccionModal(); openPedidoModal(id); }
window.prVerPedido = prVerPedido;

// ── Vista: listado plano de todos los lotes (sin agrupar por artículo) ──
let _prLotesBusca = '';
function _prLotesListHtml() {
  const q = _normTxt(_prLotesBusca);
  const lotes = [...producciones]
    .filter(l => !q || _normTxt([l.articulo,l.formato,l.numProd,l.lote,l.marca].join(' ')).includes(q))
    .sort((a,b) => (b.fecha||'').localeCompare(a.fecha||'') || (b.numProd||'').localeCompare(a.numProd||''));
  if (!lotes.length) return '<div style="text-align:center;color:var(--t3);padding:30px 10px;font-size:13px">No hay lotes que coincidan.</div>';
  return `<div style="font-size:11.5px;color:var(--t3);margin-bottom:6px">${lotes.length} lote${lotes.length!==1?'s':''}</div>` + lotes.map(l => _prLoteCard(l, {art:true})).join('');
}
function _prLotesHtml() {
  return `<button type="button" onclick="verHistoricoProduccion()" style="width:100%;margin-bottom:10px;padding:10px;border:1px dashed var(--border2);border-radius:12px;background:transparent;color:var(--t2);font-weight:700;cursor:pointer">📋 Ver histórico de movimientos (altas, fases, bajas)</button>
    <input id="pr-lotes-buscar" type="search" placeholder="🔎 Buscar artículo, lote, nº producción..." value="${_esc(_prLotesBusca)}" oninput="prLotesBuscar(this.value)" style="width:100%;padding:12px;font-size:15px;border:1px solid var(--border2);border-radius:12px;background:var(--surface);color:var(--t1);margin-bottom:10px">
    <div id="pr-lotes-list">${_prLotesListHtml()}</div>`;
}
function prLotesBuscar(v) { _prLotesBusca = v; const el = document.getElementById('pr-lotes-list'); if (el) el.innerHTML = _prLotesListHtml(); }
window.prLotesBuscar = prLotesBuscar;

// ── Histórico de movimientos de producción (creado, editado, etiquetado, encajado, eliminado) ──
let _movpArt = '', _movpTipo = 'todos', _movpDesde = '', _movpHasta = '', _movpBusca = '';
function verHistoricoProduccion() { _movpArt=''; _movpTipo='todos'; _movpDesde=''; _movpHasta=''; _movpBusca=''; prIr('prod-movs'); }
function _movpFiltrados() {
  const q = _normTxt(_movpBusca);
  return movimientosProd.filter(v =>
    (!_movpArt || _normTxt(v.articulo+'|'+v.formato)===_movpArt) &&
    (_movpTipo==='todos' || v.tipo===_movpTipo) &&
    (!_movpDesde || v.fecha>=_movpDesde) && (!_movpHasta || v.fecha<=_movpHasta) &&
    (!q || _normTxt(v.articulo+' '+v.formato+' '+v.detalle+' '+v.numProd).includes(q)));
}
function _movpFilaHtml(v) {
  const col = {creado:'#22A559', editado:'#3B82F6', etiquetado:'#2A6FB0', encajado:'#22A559', eliminado:'#DC3545'}[v.tipo] || '#999';
  return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:9px 12px;margin-top:6px">
    <div style="display:flex;justify-content:space-between;gap:8px"><b style="font-size:12.5px">${_esc(v.articulo)}</b><span style="background:${col};color:#fff;border-radius:999px;padding:2px 9px;font-size:10.5px;font-weight:800">${_MOVP_TIPO_TXT[v.tipo]||v.tipo}</span></div>
    <div style="color:var(--t2);font-size:11px;margin-top:2px">${_esc(v.formato)}${v.numProd?' · '+_esc(v.numProd):''} · ${_fdate(v.fecha)}</div>
    <div style="font-size:12px;margin-top:3px">${_esc(v.detalle||'')}</div>
  </div>`;
}
function _prodMovsHtml() {
  const arts = [...new Map(movimientosProd.map(v=>[_normTxt(v.articulo+'|'+v.formato), v.articulo+' · '+v.formato])).entries()];
  const opsArt = `<option value="">Todos los artículos</option>` + arts.map(([k,t])=>`<option value="${_esc(k)}" ${_movpArt===k?'selected':''}>${_esc(t)}</option>`).join('');
  const opsTipo = `<option value="todos">Todos los movimientos</option>` + Object.entries(_MOVP_TIPO_TXT).map(([k,t])=>`<option value="${k}" ${_movpTipo===k?'selected':''}>${t}</option>`).join('');
  const filtros = `<div class="fsec">Filtrar histórico</div>
    <div class="fgrid full"><div class="fg"><label>Artículo</label><select id="movp-f-art" onchange="movpFiltroCambia()">${opsArt}</select></div></div>
    <div class="fgrid"><div class="fg"><label>Tipo</label><select id="movp-f-tipo" onchange="movpFiltroCambia()">${opsTipo}</select></div>
      <div class="fg"><label>Buscar</label><input id="movp-buscar" type="search" placeholder="Nº producción, detalle..." value="${_esc(_movpBusca)}" oninput="movpFiltroCambia()"></div></div>
    <div class="fgrid"><div class="fg"><label>Desde</label><input id="movp-f-desde" type="date" value="${_esc(_movpDesde)}" onchange="movpFiltroCambia()"></div>
      <div class="fg"><label>Hasta</label><input id="movp-f-hasta" type="date" value="${_esc(_movpHasta)}" onchange="movpFiltroCambia()"></div></div>`;
  const acciones = `<div style="display:flex;gap:8px;margin:12px 0 4px"><button onclick="imprimirHistProduccion()" style="flex:1;padding:10px;border:1px solid var(--border2);border-radius:10px;background:var(--surface);color:var(--t1);font-weight:800;cursor:pointer">🖨️ Imprimir</button><button onclick="compartirHistProduccion()" style="flex:1;padding:10px;border:1px solid var(--border2);border-radius:10px;background:var(--surface);color:var(--t1);font-weight:800;cursor:pointer">📤 Compartir</button></div>`;
  const lista = _movpFiltrados();
  const cuerpo = lista.length ? `<div style="color:var(--t2);font-size:11.5px;margin:4px 2px">${lista.length} movimiento${lista.length===1?'':'s'}</div>` + lista.slice(0,200).map(_movpFilaHtml).join('')
    : '<div style="text-align:center;color:var(--t3);padding:20px 10px;font-size:13px">Sin movimientos con estos filtros.</div>';
  return filtros + acciones + `<div id="movp-lista">${cuerpo}</div>`;
}
function movpFiltroCambia() {
  _movpArt = document.getElementById('movp-f-art').value;
  _movpTipo = document.getElementById('movp-f-tipo').value;
  _movpDesde = document.getElementById('movp-f-desde').value;
  _movpHasta = document.getElementById('movp-f-hasta').value;
  _movpBusca = document.getElementById('movp-buscar').value;
  const lista = _movpFiltrados();
  document.getElementById('movp-lista').innerHTML = lista.length
    ? `<div style="color:var(--t2);font-size:11.5px;margin:4px 2px">${lista.length} movimiento${lista.length===1?'':'s'}</div>` + lista.slice(0,200).map(_movpFilaHtml).join('')
    : '<div style="text-align:center;color:var(--t3);padding:20px 10px;font-size:13px">Sin movimientos con estos filtros.</div>';
}
function imprimirHistProduccion() {
  const lista = _movpFiltrados();
  const fecha = new Date().toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'});
  const filas = lista.map(v => `<tr><td>${_fdate(v.fecha)}</td><td>${_esc(v.articulo)}</td><td>${_esc(v.formato)}</td><td>${_esc(v.numProd||'')}</td><td>${_MOVP_TIPO_TXT[v.tipo]||v.tipo}</td><td>${_esc(v.detalle||'')}</td></tr>`).join('');
  const html = `<html><head><meta charset="utf-8"><title>Histórico de producción</title><style>
    body{font-family:Arial,sans-serif;padding:20px;color:#222} h1{font-size:18px;margin:0 0 2px} .sub{color:#666;font-size:12px;margin-bottom:14px}
    table{width:100%;border-collapse:collapse;font-size:12px} th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left} th{background:#f4f4f4}
  </style></head><body><h1>Histórico de producción</h1><div class="sub">${fecha} · SAT GUADEX · Palma del Río · ${lista.length} movimiento${lista.length===1?'':'s'}</div>
  <table><thead><tr><th>Fecha</th><th>Artículo</th><th>Formato</th><th>Nº prod.</th><th>Tipo</th><th>Detalle</th></tr></thead><tbody>${filas}</tbody></table></body></html>`;
  const win = window.open('','_blank','width=960,height=700');
  win.document.write(html + `<script>window.onload=()=>{window.print();}<\/script>`);
  win.document.close();
}
async function compartirHistProduccion() {
  const lista = _movpFiltrados();
  const fecha = new Date().toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'});
  const lines = [`🏭 *Histórico de producción*`, `📅 ${fecha} · ${lista.length} movimiento${lista.length===1?'':'s'}`, ''];
  lista.slice(0,300).forEach(v => { lines.push(`${_MOVP_TIPO_TXT[v.tipo]||v.tipo} · *${v.articulo}* (${v.formato})`); lines.push(`   ${_fdate(v.fecha)} · ${v.detalle||''}`); });
  lines.push('——————————————', 'SAT GUADEX · Palma del Río');
  const texto = lines.join('\n');
  if (navigator.share) {
    try { await navigator.share({ title:'Histórico de producción', text: texto }); toast('📱 Compartido'); }
    catch(e) { if (e.name!=='AbortError') { await navigator.clipboard.writeText(texto); toast('📋 Copiado al portapapeles'); } }
  } else {
    try { await navigator.clipboard.writeText(texto); toast('📋 Copiado al portapapeles'); }
    catch(e) { toast('❌ No se pudo compartir'); }
  }
}
window.verHistoricoProduccion = verHistoricoProduccion; window.movpFiltroCambia = movpFiltroCambia;
window.imprimirHistProduccion = imprimirHistProduccion; window.compartirHistProduccion = compartirHistProduccion;

// ── Vista: lotes por caducar, ordenados por proximidad ──
function _prCaducarBadge(dias) {
  if (dias < 0) return `<span style="background:#DC3545;color:#fff;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:800">CADUCADO ${Math.abs(dias)}d</span>`;
  if (dias <= 7) return `<span style="background:#DC3545;color:#fff;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:800">⏳ ${dias}d</span>`;
  if (dias <= 30) return `<span style="background:#2A6FB0;color:#1B3A5C;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:800">⏳ ${dias}d</span>`;
  return `<span style="background:var(--surface2);color:var(--t2);border-radius:999px;padding:2px 9px;font-size:11px;font-weight:700">${dias}d</span>`;
}
function _prCaducarHtml() {
  const filas = producciones
    .filter(l => l.caducidad)
    .map(l => ({ l, d:_dispLote(l), dias:_diasCad(l.caducidad) }))
    .filter(x => x.d.palets > 0 || x.d.cajas > 0)
    .sort((a,b) => a.dias - b.dias);
  if (!filas.length) return '<div style="text-align:center;color:var(--t3);padding:30px 10px;font-size:13px">No hay lotes con caducidad y stock disponible.</div>';
  return `<div style="font-size:11.5px;color:var(--t3);margin-bottom:6px">${filas.length} lote${filas.length!==1?'s':''} con caducidad, de más próximo a más lejano</div>` +
    filas.map(({l,dias}) => _prLoteCard(l, {art:true, badge:_prCaducarBadge(dias)})).join('');
}

function _prProcesoHtml() {
  const cols = [['llenado','Llenado','#2A6FB0'],['etiquetado','Etiquetado','#3B82F6'],['encajado','Encajado','#22A559']];
  const fases = producciones.filter(l=>_esFases(l));
  return _brikResumenHtml(null,true) + '<div style="display:flex;gap:10px;overflow-x:auto;margin-top:10px;padding-bottom:6px;align-items:flex-start">' + cols.map(([f,t,c]) => {
    const ls = fases.filter(l=>(l.fase||'llenado')===f && (f!=='encajado' || (_dispLote(l).palets>0 || _dispLote(l).cajas>0)));
    const tot = ls.reduce((a,l)=>{ const cPorCaja=_campoPorCaja(l.tipo), cTot=_campoTotal(l.tipo); return a+(f==='encajado' ? (_dispLote(l).total||0)*(parseFloat(l[cPorCaja])||0) : (parseFloat(l[cTot])||0)); },0);
    const mini = l => { const d=_dispLote(l), cTot=_campoTotal(l.tipo), u=l.tipo==='botella'?'botellas':'bricks'; return `<div onclick="prAbrirArt('${encodeURIComponent(_keyArt(l))}')" style="cursor:pointer;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:9px 10px;margin-top:8px;font-size:12px"><b>${_esc((l.articulo||'').toUpperCase())}</b> <span style="color:var(--t2)">${_esc((l.formato||'').toUpperCase())}</span><div style="color:var(--t2);margin-top:2px">${l.numProd||''} · ${f==='encajado' ? d.palets+' pal. + '+d.cajas+' cajas' : _fmtN(parseFloat(l[cTot])||0)+' '+u}</div></div>`; };
    return `<div style="flex:1 0 220px;background:var(--surface2);border-radius:12px;padding:8px"><div style="background:${c};color:#fff;border-radius:8px;padding:7px 10px;font-weight:800;font-size:13px;display:flex;justify-content:space-between"><span>${t}</span><span>${_fmtN(tot)} bricks</span></div>${ls.length ? ls.map(mini).join('') : '<div style="font-size:12px;color:var(--t3);padding:12px 4px">Nada aquí</div>'}</div>`;
  }).join('') + '</div>';
}
const _PR_TABS = [['stock','📦 Stock'],['proceso','🧃 Proceso'],['pedidos','⚠️ Pedidos'],['lotes','📋 Lotes'],['caducar','⏳ Caducar'],['materiales','🧱 Materiales']];
function _prNavHtml() {
  if (_PR_TABS.some(([v]) => v === _prView)) {
    const nFalta = _prPedidosFaltantes().length;
    const T = (v,t) => {
      const badge = (v==='pedidos' && nFalta>0) ? `<span style="background:${_prView===v?'var(--dhl-dark)':'var(--dhl-red)'};color:#fff;border-radius:999px;padding:1px 6px;font-size:10px;margin-left:5px">${nFalta}</span>` : '';
      return `<button onclick="prIr('${v}')" style="flex:0 0 auto;padding:9px 13px;border:none;border-radius:10px;font-weight:800;font-size:12.5px;white-space:nowrap;cursor:pointer;background:${_prView===v?'var(--brand-primary)':'var(--surface2)'};color:${_prView===v?'var(--dhl-dark)':'var(--t2)'}">${t}${badge}</button>`;
    };
    return `<div style="display:flex;gap:6px;margin-top:10px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px">${_PR_TABS.map(([v,t])=>T(v,t)).join('')}</div>`;
  }
  const back = _prView==='form' ? (_prArt ? 'detalle' : 'stock')
    : _prView==='mat-form' ? (_matId ? 'mat-detalle' : 'materiales')
    : _prView==='receta' ? (_prArt ? 'detalle' : 'materiales')
    : _prView==='receta-nueva' ? 'materiales'
    : _prView==='mat-movs' ? (_movMaterialId ? 'mat-detalle' : 'materiales')
    : _prView==='prod-movs' ? 'lotes'
    : _prView==='mat-detalle' ? 'materiales'
    : 'stock';
  return `<div style="display:flex;align-items:center;gap:10px;margin-top:8px"><button id="pr-volver" onclick="prIr('${back}')" style="border:none;background:var(--surface2);border-radius:10px;padding:10px 14px;font-weight:800;font-size:13.5px;cursor:pointer">← Volver</button><b style="font-size:14px">${_prView==='form' ? (editLoteId?'Editar lote':'Nueva producción') : ''}</b></div>`;
}
function renderProduccionList() {
  const cont = document.getElementById('pr-content'); if (!cont) return;
  if (_prView==='detalle' && !_grupos().some(g=>g.key===_prArt)) { _prView = 'stock'; _prArt = ''; }
  const form = _prView==='form';
  document.getElementById('pr-view-form').style.display = form ? '' : 'none';
  cont.style.display = form ? 'none' : '';
  document.getElementById('pr-btn-nuevo').style.display = form ? 'none' : '';
  document.getElementById('pr-nav').innerHTML = _prNavHtml();
  if (_prView==='stock') cont.innerHTML = _prStockHtml();
  else if (_prView==='proceso') cont.innerHTML = _prProcesoHtml();
  else if (_prView==='pedidos') cont.innerHTML = _prPedidosHtml();
  else if (_prView==='lotes') cont.innerHTML = _prLotesHtml();
  else if (_prView==='prod-movs') cont.innerHTML = _prodMovsHtml();
  else if (_prView==='caducar') cont.innerHTML = _prCaducarHtml();
  else if (_prView==='detalle') cont.innerHTML = _prDetalleHtml();
  else if (_prView==='materiales') cont.innerHTML = _matListaHtml();
  else if (_prView==='mat-detalle') cont.innerHTML = _matDetalleHtml();
  else if (_prView==='mat-form') cont.innerHTML = _matFormHtml();
  else if (_prView==='mat-movs') cont.innerHTML = _matMovsHtml();
  else if (_prView==='receta') cont.innerHTML = _recetaFormHtml();
  else if (_prView==='receta-nueva') cont.innerHTML = _recetaNuevaHtml();
}
function _recetaNuevaHtml() {
  return `<div class="fsec">Nueva receta</div>
  <div class="fgrid full"><div class="fg"><label>📦 Artículo</label><input id="rn-articulo" placeholder="Gazpacho, Salsa brava..." list="dl-productos" oninput="_recetaCambio()"></div></div>
  <div class="fgrid full"><div class="fg"><label>🍶 Formato</label><input id="rn-formato" placeholder="Botella 1 lt, Brick 500..." list="dl-formatos" oninput="_recetaCambio()"></div></div>
  <div class="fsec" style="margin-top:14px">Materiales por caja</div>
  <div id="receta-filas">${_recetaFilaHtml({materialId:'',cantidad:''})}</div>
  <button type="button" onclick="_recetaAddFila()" style="width:100%;margin-top:8px;padding:9px;border:1px dashed var(--border2);border-radius:10px;background:transparent;color:var(--t2);font-weight:700;cursor:pointer">＋ Añadir material</button>
  <button type="button" onclick="_recetaGuardar()" style="width:100%;margin-top:14px;padding:12px;border:none;border-radius:12px;background:var(--brand-primary);color:var(--dhl-dark);font-weight:800;font-size:15px;cursor:pointer">💾 Guardar receta</button>
  ${!materiales.length ? '<div style="color:var(--t2);font-size:12px;margin-top:10px">Todavía no tienes materiales dados de alta — hazlo primero en la pestaña 🧱 Materiales.</div>' : ''}`;
}
function prIr(v) { _prView = v; if (_PR_TABS.some(([x])=>x===v)) _prArt = ''; renderProduccionList(); const sc = document.querySelector('#mProduccion .modal-scroll'); if (sc) sc.scrollTop = 0; }
function prAbrirArt(k) { _prArt = decodeURIComponent(k); prIr('detalle'); }
function prFiltro(f) { _prFiltro = f; renderProduccionList(); }
function prBuscar(v) { _prBusca = v; const g = document.getElementById('pr-grid'); if (g) g.innerHTML = _prGridHtml(); }
function prNuevo() {
  if (_prView==='materiales' || _prView==='mat-detalle') { matNuevo(); return; }
  ['pr-articulo','pr-marca','pr-formato','pr-palets','pr-cajas','pr-cpp','pr-bpu','pr-totbot','pr-bpb','pr-bpp','pr-pb','pr-bs','pr-bi','pr-bri','pr-bpc','pr-cppb','pr-totbricks','pr-totbotellas','pr-lote','pr-caducidad','pr-peso','pr-notas'].forEach(id=>{const el=document.getElementById(id); if(el) el.value='';});
  document.getElementById('pr-fecha').value = new Date().toISOString().slice(0,10);
  _setModoEdicion(null);
  const g = _prView==='detalle' ? _grupos().find(x=>x.key===_prArt) : null;
  if (g) { document.getElementById('pr-articulo').value = g.articulo; document.getElementById('pr-formato').value = g.formato; }
  prIr('form');
}
window.prIr = prIr; window.prAbrirArt = prAbrirArt; window.prFiltro = prFiltro; window.prBuscar = prBuscar; window.prNuevo = prNuevo;
window.renderProduccionList = renderProduccionList;

// ── Al fabricar: preguntar si hay pedidos pendientes de ese artículo/formato ──
let _asigLote = null, _asigMatch = [];
function pedidosPendientesPara(lote) {
  const key = (lote.articulo||'').trim().toUpperCase();
  return pedidos.filter(p => p.status !== 'cargado').map(p => {
    const lin = [{producto:p.producto, formato:p.formato, uds:p.uds, cajas:p.cajas}, ...(p.productosExtra||[])]
      .filter(x => (x.producto||'').trim().toUpperCase()===key && _fmtOk(lote, x.formato));
    return lin.length ? { p, lin } : null;
  }).filter(Boolean);
}
function preguntarPedidosLote(lote) {
  _asigMatch = pedidosPendientesPara(lote);
  if (!_asigMatch.length) return;
  _asigLote = lote;
  document.getElementById('asig-sub').textContent = 'Hay pedidos pendientes de ' + lote.articulo + (lote.formato?' · '+lote.formato:'') + '. Marca los que se sirven con esta producción.';
  document.getElementById('asig-lista').innerHTML = _asigMatch.map(({p,lin},i) =>
    `<label style="display:flex;gap:10px;align-items:center;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:9px 10px;font-size:12.5px;cursor:pointer">
      <input type="checkbox" class="asig-chk" value="${i}" style="width:18px;height:18px;accent-color:var(--accent)">
      <span><b>${_esc(p.grupo||'')}</b>${p.num?' #'+_esc(p.num):''} · ${lin.map(x=>[x.uds?x.uds+' pal.':'',x.cajas?x.cajas+' cajas':''].filter(Boolean).join(' ')).join(' + ')}</span>
    </label>`).join('');
  document.getElementById('mAsigPed').classList.add('open');
}
function cerrarAsigPedidos(){ document.getElementById('mAsigPed').classList.remove('open'); _asigLote=null; }
async function confirmarAsigPedidos() {
  const sel = [...document.querySelectorAll('#asig-lista .asig-chk:checked')].map(c => _asigMatch[parseInt(c.value)].p);
  if (_asigLote && sel.length) {
    await fbSaveProduccion({ ..._asigLote, pedidosRef: sel.map(p => ({ id:p.id, txt:(p.grupo||'')+(p.num?' #'+p.num:'') })) });
    toast('📋 Producción asignada a ' + sel.length + ' pedido' + (sel.length>1?'s':''));
  }
  cerrarAsigPedidos();
}
window.cerrarAsigPedidos = cerrarAsigPedidos;
window.confirmarAsigPedidos = confirmarAsigPedidos;

let editLoteId = null;
function _setModoEdicion(id){
  editLoteId = id;
  if(!id){ document.getElementById('pr-tipo').value='normal'; document.getElementById('pr-fase').value='llenado'; prTipoChange(); }
  const b=document.getElementById('pr-btn-guardar'), c=document.getElementById('pr-btn-cancelar');
  if(b) b.textContent = id ? '💾 Guardar cambios' : '＋ Registrar lote';
  if(c) c.style.display = id ? '' : 'none';
}
function editarLoteProduccion(id){
  const l=producciones.find(x=>String(x.id)===String(id)); if(!l) return;
  const set=(k,v)=>{const el=document.getElementById(k); if(el) el.value=(v??'');};
  set('pr-articulo',l.articulo); set('pr-marca',l.marca); set('pr-formato',l.formato); set('pr-palets',l.palets); set('pr-cajas',l.cajas);
  set('pr-cpp',l.cajasPorPalet); set('pr-lote',l.lote); set('pr-caducidad',l.caducidad); set('pr-peso',l.peso);
  set('pr-fecha',l.fecha); set('pr-notas',l.notas);
  _setModoEdicion(l.id);
  set('pr-tipo', l.tipo==='brik' ? 'brik' : 'normal');
  set('pr-bpu', l.botellasPorCaja||'');
  if (l.tipo==='brik') { set('pr-fase',l.fase||'llenado'); set('pr-bpb',l.bricksPorBandeja); set('pr-bpp',l.bandejasPorPalet); set('pr-pb',l.paletsBandejas); set('pr-bs',l.bandejasSueltas); set('pr-bi',l.bandejasIncompletas); set('pr-bri',l.bricksIncompletos); set('pr-bpc',l.bricksPorCaja||''); set('pr-cppb',l.cajasPorPalet||''); }
  prTipoChange();
  prIr('form');
  toast('✏️ Editando lote (cantidades fabricadas)');
}
function cancelarEdicionLote(){
  ['pr-articulo','pr-marca','pr-formato','pr-palets','pr-cajas','pr-cpp','pr-bpu','pr-totbot','pr-bpb','pr-bpp','pr-pb','pr-bs','pr-bi','pr-bri','pr-bpc','pr-cppb','pr-totbricks','pr-totbotellas','pr-lote','pr-caducidad','pr-peso','pr-notas'].forEach(id=>{const el=document.getElementById(id); if(el) el.value='';});
  _setModoEdicion(null);
  prIr(_prArt ? 'detalle' : 'stock');
}
window.editarLoteProduccion = editarLoteProduccion;
window.cancelarEdicionLote = cancelarEdicionLote;
function eliminarLoteProduccion(id){
  const l = producciones.find(x=>String(x.id)===String(id));
  const origen = l && l.origenId ? producciones.find(x=>String(x.id)===String(l.origenId)) : null;
  const cajasEq = l ? _cajasEq(l) : 0;
  const receta = l ? recetaPara(l.articulo, l.formato) : null;
  const conMateriales = cajasEq>0 && receta && (receta.items||[]).some(it => materiales.some(m=>String(m.id)===String(it.materialId)));
  const msgBase = origen ? 'Sus bricks volverán al registro anterior en '+_FASE_TXT[origen.fase]+'.' : 'Esta acción no se puede deshacer.';
  const ejecutar = async (devolver) => {
    if (devolver) await consumirMateriales(l.articulo, l.formato, -cajasEq);
    if (origen) {
      // Suma de nuevo lo que se había restado al dividir el lote
      await fbSaveProduccion({ ...origen,
        totalBricks: (parseFloat(origen.totalBricks)||0) + (parseFloat(l.totalBricks)||0),
        paletsBandejas: (parseFloat(origen.paletsBandejas)||0) + (parseFloat(l.paletsBandejas)||0),
        bandejasSueltas: (parseFloat(origen.bandejasSueltas)||0) + (parseFloat(l.bandejasSueltas)||0),
        bandejasIncompletas: (parseFloat(origen.bandejasIncompletas)||0) + (parseFloat(l.bandejasIncompletas)||0),
        bricksIncompletos: (parseFloat(origen.bricksIncompletos)||0) + (parseFloat(l.bricksIncompletos)||0) });
    }
    await fbDeleteProduccion(id);
    await registrarMovProduccion(l, 'eliminado', _descLote(l) + (origen ? ' · restaurado a '+_FASE_TXT[origen.fase] : '') + (devolver ? ' · materiales devueltos' : ''));
    renderProduccionList();
    toast((origen ? '🗑 Lote eliminado · bricks restaurados en '+_FASE_TXT[origen.fase] : '🗑 Lote eliminado') + (devolver ? ' · materiales devueltos' : ''));
  };
  if (!l) return;
  if (conMateriales) {
    // Este lote consumió materiales al crearse: preguntar qué hacer con ellos
    const detalle = receta.items.map(it => {
      const m = materiales.find(x=>String(x.id)===String(it.materialId));
      return m ? `${m.nombre}: +${_fmtN(cajasEq*(parseFloat(it.cantidad)||0))} ${_matUnidadTxt(m.unidad)}` : '';
    }).filter(Boolean).join('\n');
    confirm3('🗑','¿Qué hacemos con los materiales?', `${msgBase}\n\nEste lote consumió materiales. Si los devuelves al stock:\n${detalle}`,
      'Eliminar y devolver materiales','','Eliminar sin devolver materiales', () => ejecutar(true), () => ejecutar(false));
  } else {
    confirm2('🗑','¿Eliminar lote?', msgBase, 'Eliminar','', () => ejecutar(false));
  }
}
window.eliminarLoteProduccion = eliminarLoteProduccion;

document.querySelectorAll('.modal-scroll').forEach(el => {
  let isDown=false,startY=0,scrollTop=0;
  el.style.cursor='grab';
  el.addEventListener('mousedown',e=>{isDown=true;el.style.cursor='grabbing';startY=e.pageY-el.offsetTop;scrollTop=el.scrollTop;});
  el.addEventListener('mouseleave',()=>{isDown=false;el.style.cursor='grab';});
  el.addEventListener('mouseup',()=>{isDown=false;el.style.cursor='grab';});
  el.addEventListener('mousemove',e=>{if(!isDown)return;e.preventDefault();const y=e.pageY-el.offsetTop;const walk=(y-startY)*1.5;el.scrollTop=scrollTop-walk;});
});

['mPedido','mCargar'].forEach(modalId => {
  const modal=document.querySelector('#'+modalId+' .modal');
  let startY=0,isDragging=false;
  modal.addEventListener('touchstart',e=>{startY=e.touches[0].clientY;isDragging=true;},{passive:true});
  modal.addEventListener('touchmove',e=>{if(!isDragging)return;const dy=e.touches[0].clientY-startY;if(dy>0)modal.style.transform=`translateY(${dy}px)`;},{passive:true});
  modal.addEventListener('touchend',e=>{const dy=e.changedTouches[0].clientY-startY;modal.style.transform='';isDragging=false;if(dy>100){modalId==='mPedido'?closePedidoModal():closeCargarModal();}});
});

// Manifest e iconos servidos como archivos estáticos (manifest.json, icon-192.png, icon-512.png)

let deferredPrompt=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;if(!window.matchMedia('(display-mode: standalone)').matches)showInstallBanner();});

function showInstallBanner() {
  if(document.getElementById('pwa-banner')) return;
  const b=document.createElement('div'); b.id='pwa-banner';
  b.innerHTML=`<div class="pwa-icon">🚛</div><div class="pwa-txt"><div class="pwa-title">Instalar Cargas Pro</div><div class="pwa-sub">Acceso rápido · Funciona sin conexión</div></div><button class="pwa-install" id="pwa-install-btn">Instalar</button><button class="pwa-close" id="pwa-close-btn">✕</button>`;
  document.body.appendChild(b);
  document.getElementById('pwa-install-btn').onclick=async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();const{outcome}=await deferredPrompt.userChoice;deferredPrompt=null;b.remove();if(outcome==='accepted')toast('🎉 App instalada');};
  document.getElementById('pwa-close-btn').onclick=()=>b.remove();
}

const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)&&!window.MSStream;
const isStandalone=window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone;
if(isIOS&&!isStandalone){
  setTimeout(()=>{
    if(document.getElementById('pwa-banner')) return;
    const b=document.createElement('div'); b.id='pwa-banner';
    b.innerHTML=`<div class="pwa-icon">🍎</div><div class="pwa-txt"><div class="pwa-title">Instalar en iPhone</div><div class="pwa-sub">Pulsa <strong>Compartir</strong> → "Añadir a inicio"</div></div><button class="pwa-close" id="pwa-close-btn">✕</button>`;
    document.body.appendChild(b);
    document.getElementById('pwa-close-btn').onclick=()=>b.remove();
  },2500);
}
window.addEventListener('appinstalled',()=>{document.getElementById('pwa-banner')?.remove();toast('🎉 ¡App instalada!');});

// ══ SERVICE WORKER ══
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('🔄 Actualización disponible — recarga la app');
        }
      });
    });
  }).catch(err => console.warn('SW no registrado:', err));
}

// ══ REPARAR APP ══
function repararApp() {
  confirm2('🔧','Reparar aplicación',
    'Limpia la caché y recarga la app. Útil si algo no funciona bien.',
    'Reparar', '',
    async () => {
      toast('🔧 Limpiando caché...', 3000);
      try {
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) {
            const sw = reg.active || reg.waiting || reg.installing;
            if (sw) {
              sw.postMessage('CLEAR_CACHE');
              await new Promise(r => {
                navigator.serviceWorker.addEventListener('message', e => {
                  if (e.data === 'CACHE_CLEARED') r();
                }, {once:true});
                setTimeout(r, 2000);
              });
            }
          }
        }
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
      } catch(_) {}
      setTimeout(() => location.reload(true), 500);
    }
  );
}
// ══ VACIAR DATOS — inicio limpio de la aplicación ══
async function vaciarDatosApp() {
  if(!_cpEsAdmin()){ toast('⛔ Solo un administrador puede vaciar los datos'); return; }
  const total = pedidos.length + producciones.length + materiales.length + recetas.length + movimientosMat.length + movimientosProd.length + palets.length + salidasPalets.length;
  confirm2('⚠️','Vaciar datos de Cargas Pro',
    `Esta operación eliminará TODOS los datos de trabajo de la aplicación (${total} registros aprox.).\n\nSe borrarán pedidos, producción/lotes, materiales, recetas, palets, salidas y movimientos. El programa y su configuración técnica permanecerán intactos.\n\nAntes de continuar puedes usar «Guardar copia».`,
    'Continuar', 'danger', () => {
      const palabra = window.prompt('CONFIRMACIÓN FINAL\n\nEscribe exactamente BORRAR TODO para vaciar la aplicación:');
      if (palabra === null) return;
      if (palabra.trim().toUpperCase() !== 'BORRAR TODO') {
        toast('❌ Confirmación incorrecta. No se ha borrado nada.', 3500);
        return;
      }
      confirm2('🗑️','Confirmación definitiva',
        'Último aviso: se eliminarán los datos de trabajo de Cargas Pro de forma permanente.\n\n¿Quieres dejar la aplicación completamente vacía para empezar desde cero?',
        'Sí, vaciar datos', 'danger', ejecutarVaciadoDatosApp);
    });
}

async function ejecutarVaciadoDatosApp() {
  if(!_cpEsAdmin()){ toast('⛔ Solo un administrador puede vaciar los datos'); return; }
  const colecciones = [
    ['pedidos', col],
    ['movimientos_palets', colMov],
    ['produccion', colProd],
    ['materiales', colMat],
    ['recetas', colRecetas],
    ['movimientos_materiales', colMovMat],
    ['movimientos_produccion', colMovProd],
    ['palets', colPalets],
    ['salidas_palets', colSalidasPalets],
    ['movimientos_logistica', colMovLogistica]
  ];
  const totalEstimado = colecciones.length;
  let borrados = 0;
  try {
    setSyncStatus('saving');
    toast('🗑️ Vaciando datos…', 5000);
    for (const [nombre, ref] of colecciones) {
      const snap = await ref.get();
      const docs = snap.docs;
      for (let i=0; i<docs.length; i+=450) {
        const batch = db.batch();
        docs.slice(i, i+450).forEach(d => batch.delete(d.ref));
        await batch.commit();
        borrados += Math.min(450, docs.length-i);
      }
    }
    await db.collection('config').doc('palets_counter').set({next:1, updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
    pedidos=[]; producciones=[]; materiales=[]; recetas=[]; movimientosMat=[]; movimientosProd=[]; palets=[]; salidasPalets=[];
    toast(`✅ Aplicación vacía. ${borrados} registros eliminados.`, 4500);
    render();
    setTimeout(() => location.reload(), 900);
  } catch (err) {
    console.error('Error vaciando datos:', err);
    toast('❌ No se pudo completar el vaciado: ' + (err?.message || err), 6000);
  }
}

// ══ VISTA RÁPIDA — doble tap en card ══
(function(){
  let _vrLastTap = 0;
  let _vrLastId  = null;

  function abrirVistaRapida(id) {
    const p = pedidos.find(x => String(x.id) === String(id));
    if (!p) return;

    // Cabecera (grupo + ID interno)
    document.getElementById('vr-num').textContent   = p.num ? '#' + p.num : '';
    document.getElementById('vr-grupo').textContent = p.grupo || '';

    // Nº Pedido
    const pnEl = document.getElementById('vr-pedido-num');
    pnEl.textContent = p.num || '—';
    pnEl.className   = 'vr-info-val xl' + (p.num ? '' : ' empty');
    document.getElementById('vr-pedido-row').style.display = p.num ? '' : 'none';

    // Matrículas
    const m1 = document.getElementById('vr-mat1');
    m1.textContent = p.mat1 || '—';
    m1.className   = 'vr-mat-val' + (p.mat1 ? '' : ' empty');

    const m2 = document.getElementById('vr-mat2');
    m2.textContent = p.mat2 || '—';
    m2.className   = 'vr-mat-val' + (p.mat2 ? '' : ' empty');
    document.getElementById('vr-rem-block').style.display = '';

    // Info — transportista y muelle a tamaño normal
    const setInfo = (elId, val, small) => {
      const el = document.getElementById(elId);
      el.textContent = val || '—';
      el.className   = 'vr-info-val' + (small ? ' sm' : '') + (val ? '' : ' empty');
    };
    setInfo('vr-trans',  p.transportista, false);
    setInfo('vr-muelle', p.muelle,        false);
    // Hora y palets — elementos mini
    const setMini = (elId, val) => {
      const el = document.getElementById(elId);
      el.textContent = val || '—';
      el.className   = 'vr-mini-val';
    };
    setMini('vr-hora', p.hora);
    setMini('vr-uds',  p.uds ? p.uds + ' pal.' : '');


    // Referencia cliente (separada)
    const refEl  = document.getElementById('vr-ref');
    const refBlk = document.getElementById('vr-ref-block');
    refEl.textContent = p.ref || '';
    refBlk.classList.toggle('show', !!p.ref);

    // Producto (solo producto, sin ref)
    const pp = document.getElementById('vr-producto');
    pp.textContent   = p.producto || '';
    pp.style.display = p.producto ? '' : 'none';

    // Historial de cargas parciales
    const cargasBlk  = document.getElementById('vr-cargas-block');
    const cargasList = document.getElementById('vr-cargas-list');
    const historial  = p.cargasHistorial || [];
    if (historial.length) {
      cargasList.innerHTML = historial.map((c, i) => {
        const matTxt = [c.mat1, c.mat2].filter(Boolean).join(' · ');
        const detalle = [c.hora, c.muelle?'Muelle '+c.muelle:'', c.transportista, matTxt].filter(Boolean).join(' · ');
        const cantTxt = c.detalle || [c.palets?`${c.palets} pal.`:'', c.cajas?`${c.cajas} cajas`:''].filter(Boolean).join(' · ') || '—';
        const lotesTxt = (c.lotesConsumidos||[]).filter(l=>l.lote).map(l=>l.lote).join(', ');
        return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:7px 10px;font-size:12px">
          <div><b>${cantTxt}</b>${detalle?' · '+detalle:''}${lotesTxt?`<br><span style="color:var(--t3);font-size:10.5px">Lotes: ${lotesTxt}</span>`:''}</div>
          <div style="color:var(--t3);font-family:var(--font-mono);font-size:11px">${c.fecha||''}</div>
        </div>`;
      }).join('');
      cargasBlk.style.display = '';
    } else {
      cargasBlk.style.display = 'none';
    }

    document.getElementById('vr-bg').classList.add('open');
    if (navigator.vibrate) navigator.vibrate(40);
  }

  window.cerrarVistaRapida = function() {
    document.getElementById('vr-bg').classList.remove('open');
  };

  document.addEventListener('keydown', e => { if (e.key === 'Escape') window.cerrarVistaRapida(); });

  // Delegación en document → inmune a re-renders del listArea
  document.addEventListener('touchend', function(e) {
    // Ignorar si el popup ya está abierto
    if (document.getElementById('vr-bg').classList.contains('open')) return;
    // Ignorar toques en botones de acción
    if (e.target.closest('[data-action]')) return;

    const card = e.target.closest('.pedido-card');
    if (!card) { _vrLastTap = 0; _vrLastId = null; return; }

    const id  = card.querySelector('[data-action]')?.getAttribute('data-id');
    if (!id)  { _vrLastTap = 0; return; }

    const now = Date.now();
    if (id === _vrLastId && now - _vrLastTap < 350) {
      // Doble tap confirmado
      _vrLastTap = 0; _vrLastId = null;
      abrirVistaRapida(id);
    } else {
      _vrLastTap = now;
      _vrLastId  = id;
    }
  }, { passive: true });

})();

// ══ Confirmación al salir de la aplicación (botón/gesto atrás) ══
(function () {
  // Cierra el modal/panel abierto de mayor prioridad. Devuelve true si cerró algo.
  function cerrarModalAbierto() {
    const confirmBg = document.getElementById('confirmBg');
    if (confirmBg && confirmBg.classList.contains('open')) { closeConfirm(); return true; }
    const dial = document.getElementById('fabDial');
    if (dial && dial.classList.contains('open')) { toggleDial(false); return true; }
    const mMas = document.getElementById('mMas');
    if (mMas && mMas.classList.contains('open')) { cerrarMenuMas(); return true; }
    const mFase = document.getElementById('mFaseBrik');
    if (mFase && mFase.classList.contains('open')) { cerrarFaseBrik(); return true; }
    const mAsig = document.getElementById('mAsigPed');
    if (mAsig && mAsig.classList.contains('open')) { cerrarAsigPedidos(); return true; }
    const mProd = document.getElementById('mProduccion');
    if (mProd && mProd.classList.contains('open')) {
      const volver = document.getElementById('pr-volver'); // en una subpantalla: un paso atrás; en una pestaña: cerrar
      if (volver) volver.click(); else closeProduccionModal();
      return true;
    }
    const vr = document.getElementById('vr-bg');
    if (vr && vr.classList.contains('open')) { cerrarVistaRapida(); return true; }
    const mPedido = document.getElementById('mPedido');
    if (mPedido && mPedido.classList.contains('open')) { closePedidoModal(); return true; }
    const mCargar = document.getElementById('mCargar');
    if (mCargar && mCargar.classList.contains('open')) { closeCargarModal(); return true; }
    const mAlbaran = document.getElementById('mAlbaran');
    if (mAlbaran && mAlbaran.classList.contains('open')) { closeMAlbaran(); return true; }
    const filterPanel = document.getElementById('filterPanel');
    if (filterPanel && filterPanel.classList.contains('open')) { filterPanel.classList.remove('open'); return true; }
    return false;
  }

  let saliendo = false;
  history.pushState({cargasProApp:true}, '', location.href);
  window.addEventListener('popstate', function () {
    if (saliendo) return; // ya confirmado: dejar que el sistema cierre la app
    if (cerrarModalAbierto()) {
      history.pushState({cargasProApp:true}, '', location.href);
      return;
    }
    history.pushState({cargasProApp:true}, '', location.href);
    confirm2('🚪', '¿Salir de la aplicación?', 'Se cerrará CargasPro', 'Salir', '', function () {
      saliendo = true;
      salirDeLaApp();
    });
  });

  // Cierra de verdad la app. Un simple history.back() solo te deja en la primera pantalla de la app,
  // así que se prueban, por orden, varias formas de salir.
  function salirDeLaApp() {
    // 1) Cerrar la ventana (funciona en la app instalada / PWA)
    try { window.close(); } catch (_) {}
    setTimeout(function () {
      // 2) Si aún seguimos aquí (navegador normal con páginas previas): retroceder más allá de las entradas de la app
      if (history.length > 2) { try { history.go(-2); } catch (_) {} }
      setTimeout(function () {
        // 3) Último recurso: dejar la app en una pantalla de despedida. Una pulsación más de "atrás" la cierra.
        try { history.back(); } catch (_) {}
        document.body.innerHTML = '<div style="position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#1B3A5C;color:#fff;font-family:sans-serif;text-align:center;padding:24px"><div style="font-size:44px">👋</div><div style="font-size:18px;font-weight:800">CargasPro cerrado</div><div style="font-size:13px;opacity:.7">Ya puedes cerrar esta ventana.<br>Si no se cierra sola, pulsa "atrás" una vez más.</div></div>';
      }, 400);
    }, 250);
  }
})();

window.repararApp = repararApp;

// Refuerzo del menú móvil: abre el panel aunque exista CSS antiguo en caché.
(function(){
  const btn=document.querySelector('.hamb');
  const panel=document.getElementById('navPane');
  const scrim=document.querySelector('.np-scrim');
  if(!btn||!panel)return;
  btn.onclick=function(ev){
    ev.preventDefault();
    ev.stopPropagation();
    const open=!panel.classList.contains('open');
    panel.classList.toggle('open',open);
    panel.style.setProperty('display',open?'block':'none','important');
    panel.style.setProperty('transform',open?'translateX(0)':'translateX(-102%)','important');
    if(scrim)scrim.style.setProperty('display',open?'block':'none','important');
  };
})();


// Estado de conectividad visible para el operario. Firestore sincroniza la cola al volver la red.
window.addEventListener('offline',()=>{setSyncStatus('offline');toast('Sin conexión: los cambios quedarán pendientes de sincronizar',3200);});
window.addEventListener('online',()=>{setSyncStatus('saving');toast('Conexión recuperada: sincronizando…',2600);});
