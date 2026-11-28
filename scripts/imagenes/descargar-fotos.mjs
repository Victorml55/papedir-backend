// Descarga fotos reales de dominio público (CC0 / Public Domain) desde Openverse
// y reemplaza las ilustraciones de imagenes/. Si no encuentra foto, deja la ilustración.
// Uso:  node descargar-fotos.mjs              (solo las claves que aún no tienen foto)
//       node descargar-fotos.mjs --todas      (vuelve a buscar todas)
//       node descargar-fotos.mjs taco refresco (solo esas claves)
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'imagenes');
const CREDITOS = path.join(path.dirname(DIR), 'CREDITOS.json');
const MAX_BYTES = 4.5 * 1024 * 1024; // la API acepta hasta 5 MB

// clave → búsqueda en inglés (Openverse encuentra más con términos en inglés)
const BUSQUEDAS = {
  taco: 'tacos al pastor', gringa: 'quesadilla flour tortilla', quesadilla: 'quesadilla', burrito: 'burrito', volcan: 'tostada mexican food',
  torta: 'mexican torta sandwich', hamburguesa: 'hamburger', hotdog: 'hot dog', pizza: 'pizza', pollo: 'fried chicken', sushi: 'sushi',
  ramen: 'ramen', ensalada: 'salad bowl', sopa: 'soup bowl', papas: 'potato chips', pan: 'bread loaf', cafe: 'coffee cup',
  refresco: 'soda bottle', agua: 'agua fresca', horchata: 'horchata', jugo: 'orange juice glass', cerveza: 'beer glass', te: 'cup of tea',
  flan: 'flan dessert', pastel: 'cake slice', helado: 'ice cream', galleta: 'chocolate chip cookies', dona: 'donut', chocolate: 'chocolate bar', dulce: 'candy',
  arroz: 'white rice', frijol: 'black beans', aceite: 'cooking oil bottle', huevo: 'eggs carton', leche: 'milk bottle', queso: 'fresh cheese',
  fruta: 'fresh fruit', verdura: 'vegetables', carne: 'raw beef', tortilla: 'corn tortillas', azucar: 'sugar', cereal: 'cereal bowl',
  shampoo: 'shampoo bottle', pasta_dental: 'toothpaste', jabon: 'bar of soap', papel: 'toilet paper', alcohol: 'rubbing alcohol bottle',
  curitas: 'adhesive bandage', suero: 'electrolyte drink', medicina: 'medicine pills', vitamina: 'vitamin pills', cubrebocas: 'face mask surgical',
  termometro: 'digital thermometer', martillo: 'claw hammer', desarmador: 'screwdriver set', cinta_metrica: 'tape measure', foco: 'led light bulb',
  cinta_aislar: 'electrical tape', extension: 'extension cord', pintura: 'paint brush', tornillo: 'screws', llave: 'wrench', pegamento: 'glue',
  bateria: 'aa batteries',
  gen_comida: 'mexican food plate', gen_abarrotes: 'grocery products', gen_farmacia: 'pharmacy products', gen_materiales: 'hardware tools', gen_otros: 'shopping bags',
  tienda_comida: 'taqueria mexican restaurant', tienda_abarrotes: 'grocery store shelves', tienda_farmacia: 'pharmacy store', tienda_materiales: 'hardware store', tienda_otros: 'shop storefront',
};

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const todas = process.argv.includes('--todas');
const creditos = existsSync(CREDITOS) ? JSON.parse(await readFile(CREDITOS, 'utf8')) : {};

async function buscar(q) {
  const u = new URL('https://api.openverse.org/v1/images/');
  Object.entries({ q, license: 'cc0,pdm', category: 'photograph', mature: 'false', page_size: '20' }).forEach(([k, v]) => u.searchParams.set(k, v));
  for (let intento = 0; intento < 3; intento++) {
    const r = await fetch(u, { headers: { 'user-agent': 'PaPedir-escolar/1.0' } });
    if (r.status === 429) { await espera(15000); continue; }
    if (!r.ok) throw new Error(`Openverse respondió ${r.status}`);
    return (await r.json()).results || [];
  }
  throw new Error('Openverse limitó las peticiones; vuelve a correrlo en unos minutos');
}

async function descargar(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'PaPedir-escolar/1.0' }, redirect: 'follow' });
  if (!r.ok) return null;
  const tipo = (r.headers.get('content-type') || '').split(';')[0];
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[tipo];
  if (!ext) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES || buf.length < 15000) return null; // muy pesada o miniatura rota
  return { buf, ext };
}

const claves = args.length ? args : Object.keys(BUSQUEDAS);
let ok = 0, sin = 0;
for (const clave of claves) {
  if (!BUSQUEDAS[clave]) { console.log(`? ${clave}: no existe esa clave`); continue; }
  if (!todas && !args.length && creditos[clave]) continue; // ya tiene foto
  try {
    const resultados = (await buscar(BUSQUEDAS[clave]))
      .filter((x) => (x.width || 0) >= 500 && (x.height || 0) >= 400)
      .sort((a, b) => Math.abs(1 - a.width / a.height) - Math.abs(1 - b.width / b.height)); // las más cuadradas primero
    let hecho = false;
    for (const x of resultados.slice(0, 6)) {
      const img = (await descargar(x.url)) || (await descargar(x.thumbnail));
      if (!img) continue;
      for (const e of ['jpg', 'png', 'webp']) { const f = path.join(DIR, `${clave}.${e}`); if (existsSync(f)) await unlink(f); }
      await writeFile(path.join(DIR, `${clave}.${img.ext}`), img.buf);
      creditos[clave] = { titulo: x.title, autor: x.creator || null, licencia: `${x.license} ${x.license_version || ''}`.trim(), fuente: x.foreign_landing_url };
      console.log(`✓ ${clave.padEnd(16)} ${x.title?.slice(0, 60) || ''}`);
      ok++; hecho = true; break;
    }
    if (!hecho) { console.log(`- ${clave.padEnd(16)} sin foto libre; se queda la ilustración`); sin++; }
  } catch (e) { console.log(`! ${clave}: ${e.message}`); sin++; }
  await writeFile(CREDITOS, JSON.stringify(creditos, null, 2));
  await espera(1500); // no saturar Openverse
}
console.log(`\nListo: ${ok} fotos descargadas, ${sin} sin foto. Revisa las imágenes en ${DIR} antes de subirlas.`);
