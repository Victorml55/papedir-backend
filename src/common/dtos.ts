import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { REGLAS } from '../config/reglas';
import { invalido } from './errores';

export class CoordenadasDto {
  @IsNumber() @Min(-90) @Max(90) lat: number;
  @IsNumber() @Min(-180) @Max(180) lng: number;
}

export class PaginaDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
}

export class MotivoDto {
  @IsString() @IsNotEmpty() @MaxLength(500) motivo: string;
}

export const pagina = <T>(data: T[], total: number, q: PaginaDto) => ({
  data,
  meta: { page: q.page, limit: q.limit, total },
});

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export class RangoFechasDto {
  /** YYYY-MM-DD en hora de Celaya. Por defecto, los últimos 7 días. */
  @IsOptional() @Matches(FECHA, { message: 'desde debe tener formato YYYY-MM-DD' }) desde?: string;
  @IsOptional() @Matches(FECHA, { message: 'hasta debe tener formato YYYY-MM-DD' }) hasta?: string;
}

/** Valida desde/hasta (fechas locales de Celaya). Por defecto, los últimos 7 días hasta hoy. */
export function rangoFechas(q: RangoFechasDto) {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: REGLAS.tienda.zonaHoraria }).format(new Date());
  const hasta = q.hasta ?? hoy;
  const desde = q.desde ?? new Date(Date.parse(`${hasta}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
  const dias = (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86400000;
  if (Number.isNaN(dias)) throw invalido('Fecha inválida', 'desde');
  if (dias < 0) throw invalido('desde no puede ser posterior a hasta', 'desde');
  if (dias >= REGLAS.reportes.maxDias) throw invalido(`El rango máximo es de ${REGLAS.reportes.maxDias} días`, 'desde');
  return { desde, hasta };
}
