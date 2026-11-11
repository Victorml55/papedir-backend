import { Type } from 'class-transformer';
import {
  IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { CATEGORIAS_TIENDA } from '../auth/auth.dto';
import { CoordenadasDto, PaginaDto } from '../common/dtos';

export class BuscarTiendasDto extends PaginaDto {
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-90) @Max(90) lat?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-180) @Max(180) lng?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.1) @Max(50) radioKm: number = 5;
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @IsIn(CATEGORIAS_TIENDA) categoria?: string;
}

export class TiendaUpdateDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) nombre?: string;
  @IsOptional() @IsIn(CATEGORIAS_TIENDA) categoria?: string;
  @IsOptional() @IsString() @MaxLength(300) descripcion?: string;
  @IsOptional() @IsString() @MaxLength(500) imagenUrl?: string;
  @IsOptional() @Matches(/^[0-9]{10}$/, { message: 'telefono debe tener 10 dígitos' }) telefono?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) direccion?: string;
  @IsOptional() @ValidateNested() @Type(() => CoordenadasDto) ubicacion?: CoordenadasDto;
  @IsOptional() @IsBoolean() abierta?: boolean;
  @IsOptional() @IsInt() @Min(5) @Max(120) tiempoPreparacionMin?: number;
}

export class CategoriaDto {
  @IsString() @IsNotEmpty() @MaxLength(40) nombre: string;
  @IsOptional() @IsInt() @Min(0) orden?: number;
}
export class CategoriaUpdateDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) nombre?: string;
  @IsOptional() @IsInt() @Min(0) orden?: number;
}

export class ProductoDto {
  @IsUUID() categoriaId: string;
  @IsString() @IsNotEmpty() @MaxLength(80) nombre: string;
  @IsOptional() @IsString() @MaxLength(300) descripcion?: string | null;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99999) precio: number;
  @IsOptional() @IsString() @MaxLength(500) imagenUrl?: string | null;
  @IsOptional() @IsBoolean() disponible?: boolean;
}
/** En PATCH todos los campos son opcionales (por ejemplo, solo `disponible` para marcar agotado). */
export class ProductoUpdateDto {
  @IsOptional() @IsUUID() categoriaId?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) nombre?: string;
  @IsOptional() @IsString() @MaxLength(300) descripcion?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99999) precio?: number;
  @IsOptional() @IsString() @MaxLength(500) imagenUrl?: string | null;
  @IsOptional() @IsBoolean() disponible?: boolean;
}
