import { ParseUUIDPipe } from '@nestjs/common';
import { invalido } from './errores';

export const UuidPipe = new ParseUUIDPipe({ exceptionFactory: () => invalido('El id no es un UUID válido', 'id') });

export const redondear = (n: number, decimales = 2) => Math.round(n * 10 ** decimales) / 10 ** decimales;
export const folio = (prefijo: 'R' | 'T', n: number) => `${prefijo}-${String(n).padStart(6, '0')}`;
export const coords = (lat: number | null, lng: number | null) => (lat == null || lng == null ? null : { lat, lng });

/** Distancia en metros entre dos puntos (haversine). Para ordenar paradas; las reglas usan PostGIS. */
export function metrosEntre(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Fecha y hora legibles en la zona de Celaya, p. ej. "sáb 22 nov, 12:00 a.m.". Para textos de bitácora y avisos. */
export const fechaLegible = (d: Date) =>
  d.toLocaleString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Mexico_City' });
