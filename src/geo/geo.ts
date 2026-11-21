import { Controller, Get, Injectable, Logger, Module, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsLatitude, IsLongitude, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AppError } from '../common/errores';

type Punto = { lat: number; lng: number };
export type Sugerencia = { texto: string; detalle: string | null; ubicacion: Punto; tipo: string | null };

/** Centro de Celaya: las búsquedas se inclinan hacia aquí si la app no manda su posición. */
const CELAYA: Punto = { lat: 20.5222, lng: -100.8123 };
const ESTADOS: Record<string, string> = { Guanajuato: 'Gto.', Querétaro: 'Qro.', Michoacán: 'Mich.', Jalisco: 'Jal.' };

type Feature = {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined> & { countrycode?: string; osm_value?: string; type?: string };
};

export class SugerenciasDto {
  @IsString() @IsNotEmpty() @MinLength(3, { message: 'Escribe al menos 3 letras' }) @MaxLength(150) q: string;
  @IsOptional() @Type(() => Number) @IsLatitude() lat?: number;
  @IsOptional() @Type(() => Number) @IsLongitude() lng?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10) limit = 6;
}

export class PuntoDto {
  @Type(() => Number) @IsLatitude() lat: number;
  @Type(() => Number) @IsLongitude() lng: number;
}

/**
 * Direcciones con Photon (buscador libre sobre OpenStreetMap, sin llave). A diferencia de Nominatim,
 * Photon sí permite autocompletar mientras se escribe. Todas las apps y la web usan estas dos rutas,
 * así el proveedor se puede cambiar (por ejemplo a Google Places) sin tocar los clientes.
 * Las respuestas se guardan 10 minutos en memoria.
 */
@Injectable()
export class GeoService {
  private readonly log = new Logger('Geo');
  private readonly base = (process.env.PHOTON_URL || 'https://photon.komoot.io').replace(/\/$/, '');
  private readonly cache = new Map<string, { hasta: number; valor: unknown }>();

  /** Texto legible: "Calle 123, Colonia, Ciudad, Gto." */
  static formatear(p: Feature['properties']): { texto: string; detalle: string | null } {
    const calle = p.street ? (p.housenumber ? `${p.street} ${p.housenumber}` : p.street) : null;
    const lugar = p.name && p.name !== p.street ? p.name : null;
    const zona = p.district ?? p.locality ?? p.suburb ?? null;
    const ciudad = p.city ?? p.town ?? p.village ?? p.county ?? null;
    const estado = p.state ? (ESTADOS[p.state] ?? p.state) : null;
    const partes = [lugar, calle].filter(Boolean) as string[];
    const principal = partes.join(', ') || zona || ciudad || p.name || 'Ubicación';
    const resto = [partes.length ? zona : null, ciudad, estado].filter((x) => x && x !== principal && !partes.includes(x));
    return { texto: principal, detalle: resto.length ? resto.join(', ') : null };
  }

  /** Abierta para pruebas: el e2e la reemplaza para no salir a internet. */
  async pedir(ruta: string): Promise<Feature[]> {
    const guardada = this.cache.get(ruta);
    if (guardada && guardada.hasta > Date.now()) return guardada.valor as Feature[];
    try {
      const r = await fetch(`${this.base}${ruta}`, {
        signal: AbortSignal.timeout(4000),
        headers: { 'User-Agent': 'PaPedir/1.0 (proyecto escolar TecNM Celaya)', Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { features?: Feature[] };
      const valor = j.features ?? [];
      if (this.cache.size > 1000) this.cache.clear();
      this.cache.set(ruta, { hasta: Date.now() + 600_000, valor });
      return valor;
    } catch (e) {
      this.log.warn(`Photon no respondió (${(e as Error).message})`);
      throw new AppError(503, 'GEO_NO_DISPONIBLE', 'El buscador de direcciones no responde; marca el punto en el mapa');
    }
  }

  private vista = (f: Feature): Sugerencia => ({
    ...GeoService.formatear(f.properties),
    ubicacion: { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] },
    tipo: f.properties.osm_value ?? f.properties.type ?? null,
  });

  async sugerencias(dto: SugerenciasDto): Promise<Sugerencia[]> {
    const cerca = dto.lat != null && dto.lng != null ? { lat: dto.lat, lng: dto.lng } : CELAYA;
    const q = encodeURIComponent(dto.q.trim());
    // Pide de más para filtrar lo que no es de México y repetidos.
    const features = await this.pedir(`/api/?q=${q}&lat=${cerca.lat.toFixed(4)}&lon=${cerca.lng.toFixed(4)}&limit=${dto.limit * 2}&location_bias_scale=0.4`);
    const vistos = new Set<string>();
    return features
      .filter((f) => !f.properties.countrycode || f.properties.countrycode === 'MX')
      .map(this.vista)
      .filter((s) => {
        const k = `${s.texto}|${s.detalle}`;
        if (vistos.has(k)) return false;
        vistos.add(k);
        return true;
      })
      .slice(0, dto.limit);
  }

  async direccion(p: PuntoDto): Promise<Sugerencia | null> {
    const features = await this.pedir(`/reverse?lat=${p.lat.toFixed(6)}&lon=${p.lng.toFixed(6)}&limit=1`);
    const f = features[0];
    return f ? { ...this.vista(f), ubicacion: { lat: p.lat, lng: p.lng } } : null;
  }
}

/** Cualquier usuario con sesión (las apps al capturar una dirección y la web). */
@Controller('geo')
export class GeoController {
  constructor(private readonly svc: GeoService) {}

  @Get('sugerencias') sugerencias(@Query() q: SugerenciasDto) { return this.svc.sugerencias(q); }

  @Get('direccion') async direccion(@Query() q: PuntoDto) { return { resultado: await this.svc.direccion(q) }; }
}

@Module({ controllers: [GeoController], providers: [GeoService], exports: [GeoService] })
export class GeoModule {}
