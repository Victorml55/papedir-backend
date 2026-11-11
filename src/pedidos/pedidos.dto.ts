import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Matches, Max,
  MaxLength, Min, ValidateNested,
} from 'class-validator';
import { CoordenadasDto, PaginaDto } from '../common/dtos';

export class ItemDto {
  @IsUUID() productoId: string;
  @IsInt() @Min(1) @Max(50) cantidad: number;
}

export class CotizarPedidoDto {
  @IsUUID() tiendaId: string;
  @IsUUID() direccionId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ItemDto) items: ItemDto[];
}

export class CrearPedidoDto extends CotizarPedidoDto {
  @IsOptional() @IsIn(['efectivo']) metodoPago?: 'efectivo';
  @IsOptional() @IsString() @MaxLength(300) notas?: string | null;
}

export class DestinoDto {
  @IsString() @IsNotEmpty() @MaxLength(80) nombre: string;
  @Matches(/^[0-9]{10}$/, { message: 'telefono debe tener 10 dígitos' }) telefono: string;
  @IsString() @IsNotEmpty() @MaxLength(200) direccion: string;
  @IsOptional() @IsString() @MaxLength(200) referencias?: string | null;
  @ValidateNested() @Type(() => CoordenadasDto) ubicacion: CoordenadasDto;
}

export class CotizarManualDto {
  @ValidateNested() @Type(() => CoordenadasDto) ubicacion: CoordenadasDto;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) montoACobrar: number;
}

export class PedidoManualDto {
  @ValidateNested() @Type(() => DestinoDto) destino: DestinoDto;
  @IsString() @IsNotEmpty() @MaxLength(300) descripcion: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) montoACobrar: number;
  @IsOptional() @IsString() @MaxLength(300) notas?: string | null;
}

export class ListarPedidosDto extends PaginaDto {
  /** Uno o varios estados separados por coma. */
  @IsOptional() @IsString() estado?: string;
}

export class CalificacionDto {
  @IsInt() @Min(1) @Max(5) tienda: number;
  @IsInt() @Min(1) @Max(5) repartidor: number;
  @IsOptional() @IsString() @MaxLength(300) comentario?: string | null;
}
