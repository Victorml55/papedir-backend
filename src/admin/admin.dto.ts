import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { CATEGORIAS_TIENDA } from '../auth/auth.dto';
import { CoordenadasDto, PaginaDto } from '../common/dtos';
import { TiendaUpdateDto } from '../tiendas/tiendas.dto';

const SI_NO = ['si', 'no'] as const;

export class ListaTiendasDto extends PaginaDto {
  /** Nombre de la tienda, del dueño o su correo. */
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @IsIn(['pendiente_aprobacion', 'activo', 'baneado', 'eliminado']) estado?: string;
  @IsOptional() @IsIn(['basico', 'pro', 'premium']) plan?: string;
  /** Si recibe pedidos en este momento. */
  @IsOptional() @IsIn(SI_NO) abierta?: (typeof SI_NO)[number];
  /** si = solo las dadas de baja; por omisión no aparecen. */
  @IsOptional() @IsIn(SI_NO) eliminadas?: (typeof SI_NO)[number];
}

/** Cuenta de dueño que se crea junto con la tienda. */
export class NuevoDuenoDto {
  @IsString() @IsNotEmpty() @MaxLength(80) nombre: string;
  @IsEmail() @MaxLength(120) email: string;
  @Matches(/^[0-9]{10}$/, { message: 'telefono debe tener 10 dígitos' }) telefono: string;
  @IsString() @MinLength(8) @MaxLength(72) password: string;
}

export class CrearTiendaAdminDto {
  /** Dueño existente (cuenta con rol tienda). Si no se envía, va `dueno` para crear la cuenta. */
  @ValidateIf((o) => !o.dueno) @IsUUID() duenoId?: string;
  @ValidateIf((o) => !o.duenoId) @ValidateNested() @Type(() => NuevoDuenoDto) dueno?: NuevoDuenoDto;
  @IsString() @IsNotEmpty() @MaxLength(80) nombre: string;
  @IsIn(CATEGORIAS_TIENDA) categoria: string;
  @IsOptional() @IsString() @MaxLength(300) descripcion?: string;
  @IsOptional() @IsString() @MaxLength(500) imagenUrl?: string;
  @IsOptional() @Matches(/^[0-9]{10}$/, { message: 'telefono debe tener 10 dígitos' }) telefono?: string;
  @IsString() @IsNotEmpty() @MaxLength(200) direccion: string;
  @ValidateNested() @Type(() => CoordenadasDto) ubicacion: CoordenadasDto;
  @IsOptional() @IsInt() @Min(5) @Max(120) tiempoPreparacionMin?: number;
}

export class EditarTiendaAdminDto extends TiendaUpdateDto {}

export class EliminarTiendaDto {
  @IsString() @IsNotEmpty() @MaxLength(300) motivo: string;
}

export class PausaTiendaDto {
  /** Minutos de pausa; 0 quita la pausa. Máximo 3 días. */
  @Type(() => Number) @IsInt() @Min(0) @Max(4320) minutos: number;
  @IsString() @IsNotEmpty() @MaxLength(300) motivo: string;
}

export class ListaRepartidoresDto extends PaginaDto {
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @IsIn(['pendiente_aprobacion', 'activo', 'baneado', 'eliminado']) estado?: string;
  /** Conectado: disponible y con ubicación de los últimos 5 minutos. */
  @IsOptional() @IsIn(SI_NO) conectado?: (typeof SI_NO)[number];
}

export class ListaResenasDto extends PaginaDto {
  /** Texto del comentario, tienda o cliente. */
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) estrellas?: number;
  @IsOptional() @IsIn(SI_NO) ocultas?: (typeof SI_NO)[number];
  @IsOptional() @IsUUID() tiendaId?: string;
}

export class ModerarResenaDto {
  @IsBoolean() oculta: boolean;
  @ValidateIf((o) => o.oculta) @IsString() @IsNotEmpty() @MaxLength(300) motivo?: string;
}

export class EditarUsuarioDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) nombre?: string;
  @IsOptional() @Matches(/^[0-9]{10}$/, { message: 'telefono debe tener 10 dígitos' }) telefono?: string;
  @IsOptional() @IsEmail() @MaxLength(120) email?: string;
  /** Solo para cuentas internas. */
  @IsOptional() @IsIn(['soporte', 'admin']) rol?: 'soporte' | 'admin';
}

export class PasswordAdminDto {
  @IsString() @MinLength(8) @MaxLength(72) password: string;
}

export class EliminarUsuarioDto {
  @IsString() @IsNotEmpty() @MaxLength(300) motivo: string;
}

export const TEMAS = ['novedades', 'promociones', 'tiendas', 'repartidores'] as const;

export class NotificacionDto {
  /** tema: FCM topic (llega a quien esté suscrito); rol: a todas las cuentas activas de ese rol, también a su bandeja. */
  @IsIn(['tema', 'rol']) destino: 'tema' | 'rol';
  @ValidateIf((o) => o.destino === 'tema') @IsIn(TEMAS) tema?: (typeof TEMAS)[number];
  @ValidateIf((o) => o.destino === 'rol') @IsIn(['cliente', 'tienda', 'repartidor']) rol?: 'cliente' | 'tienda' | 'repartidor';
  @IsString() @IsNotEmpty() @MaxLength(65) titulo: string;
  @IsString() @IsNotEmpty() @MaxLength(240) cuerpo: string;
}

export class BitacoraDto extends PaginaDto {
  @IsOptional() @IsUUID() actorId?: string;
  /** Texto de la acción o de la ruta. */
  @IsOptional() @IsString() @MaxLength(60) q?: string;
}
