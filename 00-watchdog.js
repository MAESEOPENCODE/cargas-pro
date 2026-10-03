// Watchdog de arranque: si la app no arranca, muestra el motivo en vez de quedarse en el logo
(function(){
  var err=null;
  window.addEventListener('error',function(e){ if(!err) err=(e.message||'Error')+(e.lineno?' (línea '+e.lineno+')':''); });
  setTimeout(function(){
    var ls=document.getElementById('loadingScreen');
    if(!ls||ls.classList.contains('hide')) return;
    var t=ls.querySelector('.loading-txt'), sp=ls.querySelector('.loading-spinner');
    if(sp) sp.style.display='none';
    if(t) t.textContent=(typeof firebase==='undefined'?'No se cargó Firebase · ':'')+(err?'Error: '+err+' · ':'')+'Toca para reintentar';
    ls.style.cursor='pointer'; ls.onclick=function(){location.reload();};
  },12000);
})();
