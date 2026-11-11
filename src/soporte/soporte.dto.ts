import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsISO8601, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { CoordenadasDto, PaginaDto } from '../common/dtos';
import { ESTADOS_TICKET } from '../tickets/tickets';

export class BuscarPedidosDto extends PaginaDto {
  @IsOptional() @IsString() estado?: string;
  /** Folio, nombre o teléfono. */
  @IsOptional() @IsString() @MaxLength(60) q?: string;
}

export class CorregirUbicacionDto {
  @IsString() @IsNotEmpty() @MaxLength(200) direccion: string;
  @ValidateNested() @Type(() => CoordenadasDto) ubicacion: CoordenadasDto;
  @IsString() @IsNotEmpty() @MaxLength(500) motivo: string;
}

export class AtenderTicketDto {
  @IsOptional() @IsIn(ESTADOS_TICKET) estado?: string;
  @IsOptional() @IsBoolean() asignarmelo?: boolean;
}

export class BuscarUsuariosDto extends PaginaDto {
  @IsOptional() @IsIn(['cliente', 'tienda', 'repartidor', 'soporte', 'admin']) rol?: string;
  @IsOptional() @IsIn(['pendiente_aprobacion', 'activo', 'baneado']) estado?: string;
  @IsOptional() @IsString() @MaxLength(60) q?: string;
}

export class UsuarioInternoDto {
  @IsString() @IsNotEmpty() @MaxLength(80) nombre: string;
  @IsEmail() email: string;
  @IsString() @MinLength(8) @MaxLength(72) password: string;
  @IsIn(['soporte', 'admin']) rol: 'soporte' | 'admin';
}

export class MetricasDto {
  @IsOptional() @IsISO8601({ strict: true }) desde?: string;
  @IsOptional() @IsISO8601({ strict: true }) hasta?: string;
}
