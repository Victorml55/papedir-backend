import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Matches, Max,
  MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';
import { CoordenadasDto, PaginaDto } from '../common/dtos';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class ZonaDto {
  @IsString() @IsNotEmpty() @MaxLength(60) nombre: string;
  @IsOptional() @IsBoolean() activa?: boolean;
  /** Se suma al envío de los destinos dentro de la zona. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(200) recargo?: number;
  /** Vértices del polígono en orden (sin repetir el primero al final). */
  @IsArray() @ArrayMinSize(3) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => CoordenadasDto) puntos: CoordenadasDto[];
}

export class ZonaUpdateDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) nombre?: string;
  @IsOptional() @IsBoolean() activa?: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(200) recargo?: number;
  @IsOptional() @IsArray() @ArrayMinSize(3) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => CoordenadasDto) puntos?: CoordenadasDto[];
}

export class ComisionesDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(50) tiendaPct: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(50) envioPct: number;
}

export class CarteraConfigDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100000) limiteDeudaTienda: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100000) limiteDeudaRepartidor: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100000) limiteDeudaCliente: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1000) cargoCancelacion: number;
}

export class ComisionTiendaDto {
  /** null = usar la comisión general. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(50) comisionPct: number | null;
}

class RecargoNocturnoDto {
  @IsBoolean() activo: boolean;
  @Matches(HHMM, { message: 'desde debe tener formato HH:MM' }) desde: string;
  @Matches(HHMM, { message: 'hasta debe tener formato HH:MM' }) hasta: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(200) monto: number;
}
class RecargoLluviaDto {
  @IsBoolean() activo: boolean;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(200) monto: number;
}
class RecargoDemandaDto {
  @IsBoolean() activo: boolean;
  @IsInt() @Min(1) @Max(100) pedidosEsperando: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(200) monto: number;
}
export class RecargosDto {
  @ValidateNested() @Type(() => RecargoNocturnoDto) nocturno: RecargoNocturnoDto;
  @ValidateNested() @Type(() => RecargoLluviaDto) lluvia: RecargoLluviaDto;
  @ValidateNested() @Type(() => RecargoDemandaDto) demanda: RecargoDemandaDto;
}

export class CuponDto {
  @Matches(/^[A-Za-z0-9]{4,20}$/, { message: 'codigo debe tener de 4 a 20 letras o números' }) codigo: string;
  @IsOptional() @IsString() @MaxLength(200) descripcion?: string;
  @IsIn(['porcentaje', 'monto', 'envio_gratis']) tipo: 'porcentaje' | 'monto' | 'envio_gratis';
  /** % si tipo = porcentaje (1 a 100), pesos si tipo = monto. Se ignora en envío gratis. */
  @ValidateIf((o) => o.tipo !== 'envio_gratis') @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(5000) valor?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) maximoDescuento?: number | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) minimoCompra?: number;
  /** Solo admin: cupón de una tienda (lo paga la tienda). Sin tiendaId, lo paga PaPedir. */
  @IsOptional() @IsUUID() tiendaId?: string | null;
  @IsOptional() @IsISO8601() inicio?: string | null;
  @IsOptional() @IsISO8601() fin?: string | null;
  @IsOptional() @IsInt() @Min(1) usosMaximos?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(100) usosPorCliente?: number;
  @IsOptional() @IsBoolean() soloPrimerPedido?: boolean;
  @IsOptional() @IsBoolean() activo?: boolean;
}

export class CuponUpdateDto {
  @IsOptional() @IsString() @MaxLength(200) descripcion?: string;
  @IsOptional() @IsISO8601() fin?: string | null;
  @IsOptional() @IsInt() @Min(1) usosMaximos?: number | null;
  @IsOptional() @IsBoolean() activo?: boolean;
}

export class LiquidacionDto {
  @IsUUID() usuarioId: string;
  /** cobro = el usuario le entrega dinero a PaPedir; pago = PaPedir le paga al usuario. */
  @IsIn(['cobro', 'pago']) sentido: 'cobro' | 'pago';
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(1000000) monto: number;
  @IsIn(['efectivo', 'transferencia']) metodo: 'efectivo' | 'transferencia';
  @IsOptional() @IsString() @MaxLength(80) referencia?: string;
  @IsOptional() @IsString() @MaxLength(300) nota?: string;
}

export class SaldosDto {
  @IsOptional() @IsIn(['cliente', 'tienda', 'repartidor']) rol?: 'cliente' | 'tienda' | 'repartidor';
}

export class ListarLiquidacionesDto extends PaginaDto {
  @IsOptional() @IsUUID() usuarioId?: string;
}
