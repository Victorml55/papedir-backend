import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { CoordenadasDto, PaginaDto } from '../common/dtos';
import { ESTADOS_TICKET } from '../tickets/tickets';
import { MotivoCancelacionDto } from '../pedidos/pedidos.dto';
import { IsNumber, Max, Min } from 'class-validator';

export class CancelarSoporteDto extends MotivoCancelacionDto {
  /** Pedido pagado con tarjeta: devolver el dinero a la tarjeta (por omisión) o a la cartera del cliente. */
  @IsOptional() @IsIn(['tarjeta', 'cartera']) reembolsoA?: 'tarjeta' | 'cartera';
  /** Pedido en efectivo que la tienda ya preparaba: cargar al cliente la tarifa de cancelación. */
  @IsOptional() @IsBoolean() cobrarCargo?: boolean;
}

/** Reembolso parcial o total a la cartera del cliente, por ejemplo si faltó un producto. */
export class ReembolsoCarteraDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(100000) monto: number;
  @IsString() @IsNotEmpty() @MaxLength(300) motivo: string;
}

export class RechazarCuentaDto {
  @IsString() @IsNotEmpty() @MaxLength(500) motivo: string;
}

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
  /** Pasar el ticket a otra persona del equipo (soporte o admin). */
  @IsOptional() @IsUUID() atendidoPor?: string;
}

export class BuscarUsuariosDto extends PaginaDto {
  @IsOptional() @IsIn(['cliente', 'tienda', 'repartidor', 'soporte', 'admin']) rol?: string;
  @IsOptional() @IsIn(['pendiente_aprobacion', 'activo', 'baneado', 'eliminado']) estado?: string;
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
