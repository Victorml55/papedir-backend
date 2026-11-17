import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { CoordenadasDto } from '../common/dtos';

export class DisponibilidadDto {
  @IsBoolean() disponible: boolean;
}

export class DisponiblesDto {
  @Type(() => Number) @IsNumber() @Min(-90) @Max(90) lat: number;
  @Type(() => Number) @IsNumber() @Min(-180) @Max(180) lng: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.1) radioKm?: number;
}

export class MarcaDto {
  @ValidateNested() @Type(() => CoordenadasDto) ubicacion: CoordenadasDto;
}

export class EntregaDto extends MarcaDto {
  @IsOptional() @Matches(/^[0-9]{4}$/, { message: 'codigoEntrega debe tener 4 dígitos' }) codigoEntrega?: string;
  @IsOptional() @IsString() @MaxLength(500) evidenciaUrl?: string | null;
}

export class VehiculoDto {
  @IsIn(['moto', 'bicicleta', 'auto']) tipo: 'moto' | 'bicicleta' | 'auto';
  @IsOptional() @IsString() @MaxLength(40) marca?: string | null;
  @IsOptional() @IsString() @MaxLength(40) modelo?: string | null;
  @IsString() @IsNotEmpty() @MaxLength(30) color: string;
  /** Obligatoria para moto y auto. */
  @ValidateIf((o) => o.tipo !== 'bicicleta') @IsString() @Matches(/^[A-Z0-9-]{5,10}$/i, { message: 'placa debe tener de 5 a 10 letras o números' })
  placa?: string | null;
}
