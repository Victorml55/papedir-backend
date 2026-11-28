# Imágenes de productos y tiendas

Ilustraciones (ícono sobre degradado, 800 × 800 JPG) para que los productos y las tiendas
no se vean vacíos en las apps y en el panel.

| Archivo | Para qué |
| --- | --- |
| `imagenes/` | 74 imágenes: una por tipo de producto (`taco.jpg`, `refresco.jpg`, `arroz.jpg`, `shampoo.jpg`, `martillo.jpg`…), genéricas por giro (`gen_comida.jpg`…) y portadas de tienda (`tienda_farmacia.jpg`…) |
| `descargar-fotos.mjs` | Cambia las ilustraciones por fotos reales de dominio público (CC0) desde Openverse |
| `ilustraciones.json` | Huella (sha1) de cada ilustración original, para reconocerlas cuando ya están subidas |
| `CREDITOS.json` | Título, autor, licencia y página de origen de cada foto descargada (lo crea el script anterior) |
| `subir-imagenes.mjs` | Entra como admin y le pone imagen a cada producto y tienda que no tiene |
| `generar.py` | Vuelve a generar las imágenes (Python 3 + Pillow + fuente Noto Color Emoji) |

## Fotos reales

```bash
cd scripts/imagenes
node descargar-fotos.mjs              # busca foto para cada clave que aún no tiene
node descargar-fotos.mjs taco pizza   # solo esas claves (por ejemplo, si una no te gustó)
```

Solo descarga fotos con licencia CC0 o de dominio público, que se pueden usar sin pedir permiso
ni dar crédito; aun así guarda la fuente en `CREDITOS.json`. Reemplaza `imagenes/<clave>.jpg`
(puede quedar `.png` o `.webp`) y, si no encuentra una foto libre, deja la ilustración.
Revisa las fotos antes de subirlas: la búsqueda es automática y alguna puede no ser la ideal.

## Subirlas a una API

Requiere Node 18 o más nuevo.

```bash
cd scripts/imagenes
node subir-imagenes.mjs                                   # producción (pide correo y contraseña de admin)
API_URL=http://localhost:3000/api/v1 node subir-imagenes.mjs   # backend local
node subir-imagenes.mjs --cambiar-ilustraciones          # cambia las ilustraciones ya subidas por las fotos descargadas
node subir-imagenes.mjs --todos                           # reemplaza todas, incluso fotos puestas a mano
```

`--cambiar-ilustraciones` descarga la imagen actual de cada producto y la compara con
`ilustraciones.json`: solo la reemplaza si es una de nuestras ilustraciones y ya hay foto para
esa clave. Las fotos que alguien subió a mano no se tocan.

La imagen se elige por el nombre del producto (lista `REGLAS` en el script; la palabra debe
estar al inicio de una palabra del nombre). Si no reconoce el nombre usa la genérica del giro
de la tienda. Las imágenes repetidas se suben una sola vez.

Antes de usarlo en producción, confirma que Render tenga `SUPABASE_URL` y `SUPABASE_SERVICE_KEY`:
sin ellas los archivos se guardan en el disco del servidor y se pierden en cada despliegue.

## Agregar un tipo de producto

1. Agrega la clave en el diccionario `C` de `generar.py` (emoji y dos colores) y córrelo: `python3 generar.py`.
2. Agrega la palabra en `REGLAS` de `subir-imagenes.mjs`.
