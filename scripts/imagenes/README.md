# Imágenes de productos y tiendas

Ilustraciones (ícono sobre degradado, 800 × 800 JPG) para que los productos y las tiendas
no se vean vacíos en las apps y en el panel.

| Archivo | Para qué |
| --- | --- |
| `imagenes/` | 74 imágenes: una por tipo de producto (`taco.jpg`, `refresco.jpg`, `arroz.jpg`, `shampoo.jpg`, `martillo.jpg`…), genéricas por giro (`gen_comida.jpg`…) y portadas de tienda (`tienda_farmacia.jpg`…) |
| `subir-imagenes.mjs` | Entra como admin y le pone imagen a cada producto y tienda que no tiene |
| `generar.py` | Vuelve a generar las imágenes (Python 3 + Pillow + fuente Noto Color Emoji) |

## Subirlas a una API

Requiere Node 18 o más nuevo.

```bash
cd scripts/imagenes
node subir-imagenes.mjs                                   # producción (pide correo y contraseña de admin)
API_URL=http://localhost:3000/api/v1 node subir-imagenes.mjs   # backend local
node subir-imagenes.mjs --todos                           # también reemplaza las que ya existen
```

La imagen se elige por el nombre del producto (lista `REGLAS` en el script; la palabra debe
estar al inicio de una palabra del nombre). Si no reconoce el nombre usa la genérica del giro
de la tienda. Las imágenes repetidas se suben una sola vez.

Antes de usarlo en producción, confirma que Render tenga `SUPABASE_URL` y `SUPABASE_SERVICE_KEY`:
sin ellas los archivos se guardan en el disco del servidor y se pierden en cada despliegue.

## Agregar un tipo de producto

1. Agrega la clave en el diccionario `C` de `generar.py` (emoji y dos colores) y córrelo: `python3 generar.py`.
2. Agrega la palabra en `REGLAS` de `subir-imagenes.mjs`.
