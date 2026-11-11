import { Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
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
