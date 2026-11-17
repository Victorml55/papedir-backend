import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { conflicto } from '../common/errores';
import { metrosEntre, redondear } from '../common/util';
import { REGLAS } from '../config/reglas';
import { Recargo } from '../database/entities';
import { ConfiguracionService } from './configuracion.service';

type Punto = { lat: number; lng: number };

/** ¿La hora local (HH:MM) está dentro del rango? Admite rangos que cruzan la medianoche (22:00–06:00). */
export function dentroDeHorario(hhmm: string, desde: string, hasta: string) {
  return desde <= hasta ? hhmm >= desde && hhmm < hasta : hhmm >= desde || hhmm < hasta;
}

@Injectable()
export class EnvioService {
  constructor(
    private readonly ds: DataSource,
    private readonly config: ConfiguracionService,
  ) {}

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
   * Costo de envío por distancia tienda → destino, más recargos.
   * distancia = línea recta × 1.3 · $25 hasta 2 km + $7 por km adicional o fracción · máximo 8 km.
   * Si hay zonas de cobertura activas, el destino debe estar dentro de una (y se suma su recargo).
   * `cuando` permite cotizar un pedido programado con los recargos de esa hora.
   */
  async cotizar(tienda: Punto, destino: Punto, cuando = new Date()) {
    const r = REGLAS.envio;
    const distanciaKm = redondear(((await this.metros(tienda, destino)) / 1000) * r.factorCalles);
    if (distanciaKm > r.maxKm) {
      throw conflicto('FUERA_DE_COBERTURA', `El destino está a ${distanciaKm} km de la tienda; el máximo es ${r.maxKm} km`);
    }
    const kmExtra = Math.ceil(Math.max(0, distanciaKm - r.kmIncluidos));
    const base = r.tarifaBase + kmExtra * r.porKmExtra;
    const recargos = [...(await this.recargoDeZona(destino)), ...(await this.recargosDinamicos(cuando))];
    return { distanciaKm, costoEnvio: redondear(base + recargos.reduce((s, x) => s + x.monto, 0)), recargos };
  }

  /** Zonas de cobertura: sin zonas activas se atiende todo el radio de 8 km. */
  private async recargoDeZona(destino: Punto): Promise<Recargo[]> {
    const [{ activas, zona, recargo }] = await this.ds.query(
      `SELECT (SELECT count(*) FROM zonas WHERE activa)::int AS activas, z.nombre AS zona, z.recargo::float8 AS recargo
       FROM (SELECT 1) x LEFT JOIN LATERAL (
         SELECT nombre, recargo FROM zonas
         WHERE activa AND ST_Covers(poligono, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)
         ORDER BY recargo LIMIT 1) z ON true`,
      [destino.lng, destino.lat],
    );
    if (activas && !zona) throw conflicto('FUERA_DE_COBERTURA', 'Todavía no llegamos a esa zona');
    return zona && recargo > 0 ? [{ concepto: `Zona ${zona}`, monto: recargo }] : [];
  }

  /** Recargos por horario nocturno, lluvia y alta demanda (configurables en /admin/configuracion). */
  private async recargosDinamicos(cuando: Date): Promise<Recargo[]> {
    const c = await this.config.get('recargos');
    const res: Recargo[] = [];
    const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: REGLAS.tienda.zonaHoraria, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(cuando);
    if (c.nocturno.activo && c.nocturno.monto > 0 && dentroDeHorario(hhmm, c.nocturno.desde, c.nocturno.hasta)) {
      res.push({ concepto: 'Horario nocturno', monto: c.nocturno.monto });
    }
    if (c.lluvia.activo && c.lluvia.monto > 0) res.push({ concepto: 'Lluvia', monto: c.lluvia.monto });
    if (c.demanda.activo && c.demanda.monto > 0) {
      const [{ n }] = await this.ds.query(
        `SELECT count(*)::int AS n FROM pedidos WHERE estado = 'listo_para_recoger' AND listo_en < now() - interval '5 minutes'`,
      );
      if (n >= c.demanda.pedidosEsperando) res.push({ concepto: 'Alta demanda', monto: c.demanda.monto });
    }
    return res;
  }

  minutosDeTraslado(distanciaKm: number) {
    return Math.ceil(distanciaKm * REGLAS.envio.minPorKm) + 5;
  }

  /** Minutos aproximados de trayecto entre dos puntos (línea recta × factor de calles). Sin consultar la base. */
  minutosEntre(a: Punto, b: Punto) {
    return Math.ceil((metrosEntre(a, b) / 1000) * REGLAS.envio.factorCalles * REGLAS.envio.minPorKm);
  }
}
