# Subida de CargasPro

CargasPro es una PWA React/Vite instalable. Sube todos los archivos y carpetas de este paquete directamente a la raíz del repositorio `maeseopencode/cargas-pro`, rama `main`.

La aplicación se publica en `https://maeseopencode.github.io/cargas-pro/`, usa el logo oficial de Arteoliva y reutiliza Firebase `cargas-pro` con las colecciones `orders`, `lots`, `pallets`, `loads` y `meta`.

En producción no se muestran datos demo: comienza vacía hasta iniciar sesión y crear datos. Tras iniciar sesión, el botón **Borrar datos** permite vaciar de forma protegida `orders`, `lots`, `pallets` y `loads`. Escribe `BORRAR DATOS` para confirmar. `meta/sscc` se conserva para no reutilizar códigos de palet.
