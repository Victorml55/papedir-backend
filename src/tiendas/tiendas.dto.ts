import { EsCategoria } from '../config/catalogos';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUrl, IsUUID,
  Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { CATEGORIAS_TIENDA } from '../auth/auth.dto';
import { CoordenadasDto, PaginaDto } from '../common/dtos';
import { REGLAS } from '../config/reglas';

const T = REGLAS.tienda;

export class BuscarTiendasDto extends PaginaDto {
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-90) @Max(90) lat?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-180) @Max(180) lng?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.1) @Max(50) radioKm: number = 5;
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @EsCategoria() categoria?: string;
}

export class TiendaUpdateDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) nombre?: string;
  @IsOptional() @EsCategoria() categoria?: string;
  @IsOptional() @IsString() @MaxLength(300) descripcion?: string;
  @IsOptional() @IsString() @MaxLength(500) imagenUrl?: string;
  @IsOptional() @Matches(/^[0-9]{10}$/, { message: 'telefono debe tener 10 dígitos' }) telefono?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) direccion?: string;
  @IsOptional() @ValidateNested() @Type(() => CoordenadasDto) ubicacion?: CoordenadasDto;
  @IsOptional() @IsBoolean() abierta?: boolean;
  @IsOptional() @IsInt() @Min(5) @Max(120) tiempoPreparacionMin?: number;
}

export class SucursalDto {
  @IsString() @IsNotEmpty() @MaxLength(80) nombre: string;
  @EsCategoria() categoria: string;
  @IsOptional() @IsString() @MaxLength(300) descripcion?: string;
  @IsOptional() @Matches(/^[0-9]{10}$/, { message: 'telefono debe tener 10 dígitos' }) telefono?: string;
  @IsString() @IsNotEmpty() @MaxLength(200) direccion: string;
  @ValidateNested() @Type(() => CoordenadasDto) ubicacion: CoordenadasDto;
  @IsOptional() @IsInt() @Min(5) @Max(120) tiempoPreparacionMin?: number;
  @IsOptional() @IsString() @MaxLength(500) imagenUrl?: string;
  /** Copia categorías, productos y opciones de otra sucursal propia. */
  @IsOptional() @IsUUID() copiarMenuDe?: string;
}

export class ListaSolicitudesDto {
  @IsOptional() @IsIn(['pendiente', 'aprobada', 'rechazada', 'cancelada']) estado?: 'pendiente' | 'aprobada' | 'rechazada' | 'cancelada';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}

export class RechazarSolicitudDto {
  @IsString() @IsNotEmpty() @MaxLength(500) motivo: string;
}

export class TurnoDto {
  /** 0 = domingo … 6 = sábado */
  @IsInt() @Min(0) @Max(6) dia: number;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'abre debe tener formato HH:MM' }) abre: string;
  /** "24:00" = hasta la medianoche. Si es menor que `abre`, el turno termina al día siguiente. */
  @Matches(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, { message: 'cierra debe tener formato HH:MM' }) cierra: string;
}

export class HorarioDto {
  @IsBoolean() usarHorario: boolean;
  @IsArray() @ArrayMaxSize(28) @ValidateNested({ each: true }) @Type(() => TurnoDto) turnos: TurnoDto[];
}

export class PausaDto {
  @IsInt() @Min(5) @Max(T.pausaMaxMin) minutos: number;
}

export class CategoriaDto {
  @IsString() @IsNotEmpty() @MaxLength(40) nombre: string;
  @IsOptional() @IsInt() @Min(0) orden?: number;
}
export class CategoriaUpdateDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) nombre?: string;
  @IsOptional() @IsInt() @Min(0) orden?: number;
}

const URL_OPC = { require_tld: false, require_protocol: true };

export class ProductoDto {
  @IsUUID() categoriaId: string;
  @IsString() @IsNotEmpty() @MaxLength(80) nombre: string;
  @IsOptional() @IsString() @MaxLength(300) descripcion?: string | null;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99999) precio: number;
  /** Foto principal. Si mandas `imagenes`, se toma la primera. */
  @IsOptional() @IsString() @MaxLength(500) imagenUrl?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(T.maxFotosProducto) @IsUrl(URL_OPC, { each: true }) imagenes?: string[];
  @IsOptional() @IsBoolean() disponible?: boolean;
  /** Existencias. null u omitido = sin control de inventario. */
  @IsOptional() @IsInt() @Min(0) @Max(100000) stock?: number | null;
}
/** En PATCH todos los campos son opcionales (por ejemplo, solo `disponible` para marcar agotado). */
export class ProductoUpdateDto {
  @IsOptional() @IsUUID() categoriaId?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) nombre?: string;
  @IsOptional() @IsString() @MaxLength(300) descripcion?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99999) precio?: number;
  @IsOptional() @IsString() @MaxLength(500) imagenUrl?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(T.maxFotosProducto) @IsUrl(URL_OPC, { each: true }) imagenes?: string[];
  @IsOptional() @IsBoolean() disponible?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100000) stock?: number | null;
}

export class OpcionDto {
  @IsString() @IsNotEmpty() @MaxLength(60) nombre: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9999) precioExtra?: number;
  @IsOptional() @IsBoolean() disponible?: boolean;
}

export class GrupoOpcionesDto {
  @IsString() @IsNotEmpty() @MaxLength(40) nombre: string;
  /** 0 = opcional; 1 o más = obligatorio elegir al menos esa cantidad. */
  @IsInt() @Min(0) @Max(T.maxOpcionesPorGrupo) minimo: number;
  @IsInt() @Min(1) @Max(T.maxOpcionesPorGrupo) maximo: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(T.maxOpcionesPorGrupo) @ValidateNested({ each: true }) @Type(() => OpcionDto)
  opciones: OpcionDto[];
}

export class OpcionesProductoDto {
  @IsArray() @ArrayMaxSize(T.maxGruposOpciones) @ValidateNested({ each: true }) @Type(() => GrupoOpcionesDto)
  grupos: GrupoOpcionesDto[];
}
