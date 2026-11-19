import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsISO8601, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Matches, Max,
  MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';
import { CoordenadasDto, PaginaDto } from '../common/dtos';
import { REGLAS } from '../config/reglas';

export class ItemDto {
  @IsUUID() productoId: string;
  @IsInt() @Min(1) @Max(50) cantidad: number;
  /** Ids de las opciones elegidas (tamaño, extras...), de los grupos de ese producto. */
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsUUID('all', { each: true }) opciones?: string[];
}

/** Lo de un pedido que depende de la tienda (en un carrito de varias tiendas, uno por tienda). */
export class PedidoTiendaDto {
  @IsUUID() tiendaId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ItemDto) items: ItemDto[];
  @IsOptional() @IsString() @MaxLength(30) cupon?: string;
  /** Para el repartidor; se cobra en efectivo junto con el total. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(REGLAS.pedido.propinaMax) propina?: number;
}

export class CotizarPedidoDto extends PedidoTiendaDto {
  @IsUUID() direccionId: string;
  /** efectivo (al recibir) o tarjeta (Stripe, se paga antes de crear el pedido). */
  @IsOptional() @IsIn(['efectivo', 'tarjeta']) metodoPago?: 'efectivo' | 'tarjeta';
  /** Pedido programado: hora de entrega deseada (ISO 8601), de 45 minutos a 7 días a partir de ahora. */
  @IsOptional() @IsISO8601({ strict: true }) programadoPara?: string;
}

export class CrearPedidoDto extends CotizarPedidoDto {
  @IsOptional() @IsString() @MaxLength(300) notas?: string | null;
  /** Con tarjeta: el id del PaymentIntent de POST /pagos/intento, ya confirmado en la app. */
  @ValidateIf((o) => o.metodoPago === 'tarjeta') @IsString() @Matches(/^pi_[A-Za-z0-9_]+$/, { message: 'paymentIntentId no es válido' })
  paymentIntentId?: string;
}

/** Un carrito con productos de 2 o 3 tiendas: se crean pedidos separados (cada uno con su envío y su repartidor). */
export class GrupoPedidosDto {
  @IsUUID() direccionId: string;
  @IsOptional() @IsISO8601({ strict: true }) programadoPara?: string;
  @IsOptional() @IsString() @MaxLength(300) notas?: string | null;
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(REGLAS.pedido.maxTiendasPorGrupo) @ValidateNested({ each: true }) @Type(() => PedidoTiendaDto)
  pedidos: PedidoTiendaDto[];
}

/** Cancelar o rechazar: un código del catálogo (GET /catalogos/motivos-cancelacion), un texto libre, o ambos. */
export class MotivoCancelacionDto {
  @IsOptional() @IsString() @MaxLength(40) codigo?: string;
  @ValidateIf((o) => !o.codigo) @IsString() @IsNotEmpty() @MaxLength(500) motivo?: string;
}

export class MensajePedidoDto {
  @IsString() @IsNotEmpty() @MaxLength(REGLAS.chat.maxTexto) texto: string;
}

export class RespuestaResenaDto {
  @IsString() @IsNotEmpty() @MaxLength(500) texto: string;
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
