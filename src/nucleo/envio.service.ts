import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { conflicto } from '../common/errores';
import { redondear } from '../common/util';
import { REGLAS } from '../config/reglas';

type Punto = { lat: number; lng: number };

@Injectable()
export class EnvioService {
  constructor(private readonly ds: DataSource) {}

  /** Metros en línea recta entre dos puntos, calculados con PostGIS. */
  async metros(a: Punto, b: Punto): Promise<number> {
    const [fila] = await this.ds.query(
      `SELECT ST_Distance(ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                          ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography) AS m`,
      [a.lng, a.lat, b.lng, b.lat],
    );
    return Number(fila.m);
  }

  /**
   * Costo de envío por distancia tienda → destino.
   * distancia = línea recta × 1.3 · $25 hasta 2 km + $7 por km adicional o fracción · máximo 8 km.
   */
  async cotizar(tienda: Punto, destino: Punto) {
    const r = REGLAS.envio;
    const distanciaKm = redondear(((await this.metros(tienda, destino)) / 1000) * r.factorCalles);
    if (distanciaKm > r.maxKm) {
      throw conflicto('FUERA_DE_COBERTURA', `El destino está a ${distanciaKm} km de la tienda; el máximo es ${r.maxKm} km`);
    }
    const kmExtra = Math.ceil(Math.max(0, distanciaKm - r.kmIncluidos));
    return { distanciaKm, costoEnvio: r.tarifaBase + kmExtra * r.porKmExtra };
  }

  minutosDeTraslado(distanciaKm: number) {
    return Math.ceil(distanciaKm * REGLAS.envio.minPorKm) + 5;
  }
}
