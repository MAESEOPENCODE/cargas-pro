# Cargas Pro

Aplicación web para gestionar pedidos, producción, palets y cargas de camión en una fábrica de salsas, gazpachos y salmorejo.

## Qué hace

- **Pedidos:** varias líneas por pedido (producto, formato y palets). El estado se calcula solo: Pendiente, Parcial o Cargado.
- **Producción:** al registrar un lote (con caducidad) se crean sus palets, cada uno con un código SSCC único.
- **Palets:** stock disponible, aviso de caducidad a 30 días o menos e impresión de la etiqueta con código de barras.
- **Packing List:** se elige un pedido y la app propone los palets con la caducidad más próxima (FEFO). Al confirmar pasan a Cargado. Se puede imprimir o anular.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `index.html` | Toda la aplicación (código y estilos) |
| `manifest.json` | Permite instalarla en el móvil o la tablet |
| `icon-192.png`, `icon-512.png` | Iconos de la app |

Todo va en la raíz del repositorio. No hay que compilar nada.

## Publicación

La web se publica con GitHub Pages desde la rama principal. Para actualizarla, sustituye `index.html` y haz commit: en uno o dos minutos está en línea.

## Datos y acceso

- Usa Firebase: Authentication (correo y contraseña) y Firestore.
- Las colecciones son `orders`, `lots`, `pallets`, `loads` y `meta`. Las reglas de Firestore deben permitir leer y escribir a usuarios con sesión iniciada.
- Los usuarios se crean y se dan de baja desde la consola de Firebase, en Authentication.

## Ajustes habituales

Al principio del script de `index.html`:

- `CFG.empresa`: nombre que sale en el packing list impreso.
- `CFG.prefijo`: prefijo de empresa GS1 (7 dígitos) que forma parte de todos los SSCC. Cámbialo antes de imprimir etiquetas reales.
- `PRODUCTOS` y `FORMATOS`: listas del catálogo.

## Notas

- Necesita conexión a internet para entrar y para guardar. No tiene modo sin conexión.
- Las etiquetas usan Code128 con el SSCC de 18 dígitos. Una etiqueta GS1-128 completa, con identificador de aplicación y FNC1, está pendiente.
- Los números SSCC no se reutilizan: salen de un contador en `meta/sscc`. No lo borres ni lo reinicies.
