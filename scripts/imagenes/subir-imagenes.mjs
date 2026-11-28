// Sube una imagen a cada producto (y a cada tienda) que todavía no tiene.
// Uso:  node subir-imagenes.mjs                (pide correo y contraseña de admin)
//       API_URL=http://localhost:3000/api/v1 node subir-imagenes.mjs
//       node subir-imagenes.mjs --todos        (también reemplaza los que ya tienen imagen)
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const API = (process.env.API_URL || 'https://papedir-api.onrender.com/api/v1').replace(/\/$/, '');
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'imagenes');
const TODOS = process.argv.includes('--todos');

// Palabra en el nombre del producto → imagen. Se revisan en orden; gana la primera que aparezca.
const REGLAS = [
  ['volcan', 'volcan'], ['gringa', 'gringa'], ['quesadilla', 'quesadilla'], ['burrito', 'burrito'], ['taco', 'taco'], ['pastor', 'taco'], ['bistec', 'taco'],
  ['torta', 'torta'], ['sandwich', 'torta'], ['hamburguesa', 'hamburguesa'], ['hot dog', 'hotdog'], ['hotdog', 'hotdog'], ['pizza', 'pizza'],
  ['pollo', 'pollo'], ['alita', 'pollo'], ['sushi', 'sushi'], ['ramen', 'ramen'], ['ensalada', 'ensalada'], ['sopa', 'sopa'], ['caldo', 'sopa'], ['pozole', 'sopa'],
  ['papas', 'papas'], ['botana', 'papas'], ['frituras', 'papas'], ['pan ', 'pan'], ['bolillo', 'pan'], ['concha', 'pan'],
  ['horchata', 'horchata'], ['jamaica', 'agua'], ['agua', 'agua'], ['refresco', 'refresco'], ['soda', 'refresco'], ['coca', 'refresco'], ['jugo', 'jugo'], ['licuado', 'horchata'],
  ['cafe', 'cafe'], ['capuchino', 'cafe'], ['latte', 'cafe'], ['te ', 'te'], ['cerveza', 'cerveza'],
  ['flan', 'flan'], ['pastel', 'pastel'], ['pay', 'pastel'], ['cheesecake', 'pastel'], ['helado', 'helado'], ['nieve', 'helado'], ['galleta', 'galleta'],
  ['dona', 'dona'], ['chocolate', 'chocolate'], ['dulce', 'dulce'], ['gomita', 'dulce'], ['postre', 'pastel'],
  ['arroz', 'arroz'], ['frijol', 'frijol'], ['aceite', 'aceite'], ['huevo', 'huevo'], ['leche', 'leche'], ['yogur', 'leche'], ['queso', 'queso'], ['crema', 'leche'],
  ['manzana', 'fruta'], ['platano', 'fruta'], ['fruta', 'fruta'], ['naranja', 'fruta'], ['jitomate', 'verdura'], ['verdura', 'verdura'], ['zanahoria', 'verdura'],
  ['carne', 'carne'], ['tortilla', 'tortilla'], ['azucar', 'azucar'], ['sal ', 'azucar'], ['cereal', 'cereal'], ['avena', 'cereal'],
  ['shampoo', 'shampoo'], ['champu', 'shampoo'], ['acondicionador', 'shampoo'], ['pasta dental', 'pasta_dental'], ['cepillo', 'pasta_dental'], ['jabon', 'jabon'],
  ['papel', 'papel'], ['alcohol', 'alcohol'], ['curita', 'curitas'], ['venda', 'curitas'], ['suero', 'suero'], ['electrolit', 'suero'],
  ['vitamina', 'vitamina'], ['cubrebocas', 'cubrebocas'], ['termometro', 'termometro'],
  ['paracetamol', 'medicina'], ['ibuprofeno', 'medicina'], ['tabletas', 'medicina'], ['pastilla', 'medicina'], ['jarabe', 'medicina'], ['medicamento', 'medicina'],
  ['martillo', 'martillo'], ['desarmador', 'desarmador'], ['destornillador', 'desarmador'], ['cinta metrica', 'cinta_metrica'], ['flexometro', 'cinta_metrica'],
  ['foco', 'foco'], ['lampara', 'foco'], ['cinta de aislar', 'cinta_aislar'], ['cable', 'extension'], ['extension', 'extension'], ['contacto', 'extension'],
  ['pintura', 'pintura'], ['brocha', 'pintura'], ['tornillo', 'tornillo'], ['clavo', 'tornillo'], ['taquete', 'tornillo'], ['llave', 'llave'], ['pinza', 'llave'],
  ['pegamento', 'pegamento'], ['silicon', 'pegamento'], ['pila', 'bateria'], ['bateria', 'bateria'],
];
const GENERICO = { comida: 'gen_comida', abarrotes: 'gen_abarrotes', farmacia: 'gen_farmacia', materiales: 'gen_materiales' };
const normal = (s) => ` ${s} `.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function imagenPara(nombre, categoriaTienda) {
  const n = normal(nombre);
  for (const [palabra, img] of REGLAS) if (n.includes(' ' + palabra)) return img; // al inicio de una palabra
  return GENERICO[categoriaTienda] || 'gen_otros';
}

let token;
async function api(metodo, ruta, cuerpo) {
  const esForm = cuerpo instanceof FormData;
  const r = await fetch(API + ruta, {
    method: metodo,
    headers: { authorization: token ? `Bearer ${token}` : '', ...(cuerpo && !esForm ? { 'content-type': 'application/json' } : {}) },
    body: cuerpo ? (esForm ? cuerpo : JSON.stringify(cuerpo)) : undefined,
  });
  const datos = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${metodo} ${ruta} → ${r.status} ${datos?.error || ''} ${datos?.message || ''}`);
  return datos;
}

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
async function subir(clave, tipo) {
  // Usa la foto descargada (jpg, png o webp) o, si no hay, la ilustración.
  const ext = Object.keys(MIME).find((e) => existsSync(path.join(DIR, `${clave}.${e}`)));
  if (!ext) throw new Error(`no existe imagenes/${clave}.*`);
  const f = new FormData();
  f.append('archivo', new Blob([await readFile(path.join(DIR, `${clave}.${ext}`))], { type: MIME[ext] }), `${clave}.${ext}`);
  f.append('tipo', tipo);
  return (await api('POST', '/uploads', f)).url;
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const email = process.env.ADMIN_EMAIL || (await rl.question('Correo de admin: '));
  const password = process.env.ADMIN_PASSWORD || (await rl.question('Contraseña: '));
  rl.close();
  console.log(`\nAPI: ${API} (si Render estaba dormido, la primera respuesta tarda ~1 min)`);
  token = (await api('POST', '/auth/login', { email, password, app: 'web' })).accessToken;

  const tiendas = [];
  for (let page = 1; ; page++) {
    const r = await api('GET', `/soporte/tiendas?page=${page}&limit=100`);
    tiendas.push(...r.data);
    if (tiendas.length >= r.meta.total || !r.data.length) break;
  }
  const cache = new Map(); // misma imagen → se sube una sola vez
  const url = async (clave, tipo) => {
    const k = `${tipo}:${clave}`;
    if (!cache.has(k)) cache.set(k, await subir(clave, tipo));
    return cache.get(k);
  };

  let productos = 0, saltados = 0, tiendasConImagen = 0;
  for (const t of tiendas) {
    const cat = t.categoria;
    if (TODOS || !t.imagenUrl) {
      try {
        await api('PATCH', `/admin/tiendas/${t.id}`, { imagenUrl: await url(`tienda_${GENERICO[cat] ? cat : 'otros'}`, 'tienda') });
        tiendasConImagen++;
      } catch (e) { console.log(`  ! portada de ${t.nombre}: ${e.message}`); }
    }
    const lista = await api('GET', `/soporte/tiendas/${t.id}/productos`);
    console.log(`\n${t.nombre} (${lista.length} productos)`);
    for (const p of lista) {
      if (!TODOS && (p.imagenes?.length || p.imagenUrl)) { saltados++; continue; }
      const clave = imagenPara(p.nombre, cat);
      try {
        await api('PATCH', `/soporte/productos/${p.id}`, { imagenes: [await url(clave, 'producto')] });
        productos++;
        console.log(`  ✓ ${p.nombre}  →  ${clave}`);
      } catch (e) { console.log(`  ! ${p.nombre}: ${e.message}`); }
    }
  }
  console.log(`\nListo: ${productos} productos y ${tiendasConImagen} tiendas con imagen nueva; ${saltados} productos ya tenían imagen.`);
}
main().catch((e) => { console.error('\nError:', e.message); process.exit(1); });
