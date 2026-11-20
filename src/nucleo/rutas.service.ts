import { Injectable, Logger } from '@nestjs/common';

type Punto = { lat: number; lng: number };
export type Ruta = { fuente: 'calles' | 'linea_recta'; puntos: Punto[]; metros: number | null; segundos: number | null };

/**
 * Trazo de una ruta por calles con OSRM (motor de rutas libre sobre OpenStreetMap), sin llaves ni costo.
 * Si OSRM no responde en 5 s, devuelve la línea recta entre los puntos para que la app siempre tenga qué dibujar.
 * Las rutas se guardan 2 minutos en memoria: el mapa del repartidor se refresca seguido y el servidor público
 * de OSRM pide un uso moderado.
 */
@Injectable()
export class RutasService {
  private readonly log = new Logger('Rutas');
  private readonly base = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/$/, '');
  private readonly cache = new Map<string, { hasta: number; ruta: Ruta }>();

  async trazar(puntos: Punto[]): Promise<Ruta> {
    const recta: Ruta = { fuente: 'linea_recta', puntos, metros: null, segundos: null };
    if (puntos.length < 2) return recta;

    // Redondeo a ~11 m: moverse un poco no invalida la ruta guardada.
    const clave = puntos.map((p) => `${p.lng.toFixed(4)},${p.lat.toFixed(4)}`).join(';');
    const guardada = this.cache.get(clave);
    if (guardada && guardada.hasta > Date.now()) return guardada.ruta;

    try {
      const r = await fetch(`${this.base}/route/v1/driving/${clave}?overview=full&geometries=geojson`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'PaPedir/1.0 (proyecto escolar TecNM Celaya)' },
      });
      const j = (await r.json()) as { code?: string; routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[] };
      const ruta0 = j.routes?.[0];
      if (!r.ok || j.code !== 'Ok' || !ruta0) throw new Error(j.code ?? `HTTP ${r.status}`);
      const ruta: Ruta = {
        fuente: 'calles',
        puntos: ruta0.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
        metros: Math.round(ruta0.distance),
        segundos: Math.round(ruta0.duration),
      };
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(clave, { hasta: Date.now() + 120_000, ruta });
      return ruta;
    } catch (e) {
      this.log.warn(`OSRM no respondió (${(e as Error).message}); se usa la línea recta`);
      return recta;
    }
  }
}
