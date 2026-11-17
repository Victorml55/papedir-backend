import { Type } from 'class-transformer';
import {
  Equals, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { CoordenadasDto } from '../common/dtos';

export const CATEGORIAS_TIENDA = ['comida', 'abarrotes', 'farmacia', 'materiales', 'otros'];
export const APPS = ['cliente', 'tienda', 'repartidor', 'web'];
const TELEFONO = /^[0-9]{10}$/;

export class TiendaRegistroDto {
  @IsString() @IsNotEmpty() @MaxLength(80) nombre: string;
  @IsIn(CATEGORIAS_TIENDA) categoria: string;
  @IsString() @IsNotEmpty() @MaxLength(200) direccion: string;
  @ValidateNested() @Type(() => CoordenadasDto) ubicacion: CoordenadasDto;
}

export class RegistroDto {
  @IsString() @IsNotEmpty() @MaxLength(80) nombre: string;
  @IsEmail() email: string;
  @IsString() @MinLength(8) @MaxLength(72) password: string;
  @Matches(TELEFONO, { message: 'telefono debe tener 10 dígitos' }) telefono: string;
  @IsIn(['cliente', 'tienda', 'repartidor']) rol: 'cliente' | 'tienda' | 'repartidor';
  /** El usuario aceptó el aviso de privacidad y los términos vigentes (GET /legal). */
  @Equals(true, { message: 'Debes aceptar el aviso de privacidad y los términos para crear tu cuenta' }) aceptoTerminos: boolean;
  @ValidateIf((o) => o.rol === 'tienda')
  @IsNotEmpty({ message: 'tienda es obligatorio cuando rol = tienda' })
  @ValidateNested() @Type(() => TiendaRegistroDto) tienda?: TiendaRegistroDto;
}

export class LoginDto {
  @IsEmail() email: string;
  @IsString() @IsNotEmpty() password: string;
  @IsIn(APPS) app: string;
}

export class RefreshDto {
  @IsString() @IsNotEmpty() refreshToken: string;
}

export class PerfilDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) nombre?: string;
  @IsOptional() @Matches(TELEFONO, { message: 'telefono debe tener 10 dígitos' }) telefono?: string;
  /** URL devuelta por POST /uploads (tipo perfil); null quita la foto. */
  @IsOptional() @IsString() @MaxLength(500) fotoUrl?: string | null;
}

const CODIGO = /^[0-9]{6}$/;

export class RecuperarDto {
  @IsEmail() email: string;
}

export class RestablecerDto {
  @IsEmail() email: string;
  @Matches(CODIGO, { message: 'codigo debe tener 6 dígitos' }) codigo: string;
  @IsString() @MinLength(8) @MaxLength(72) password: string;
}

export class CodigoDto {
  @Matches(CODIGO, { message: 'codigo debe tener 6 dígitos' }) codigo: string;
}

export class CambiarPasswordDto {
  @IsString() @IsNotEmpty() actual: string;
  @IsString() @MinLength(8) @MaxLength(72) nueva: string;
}

export class ConfirmarPasswordDto {
  @IsString() @IsNotEmpty() password: string;
}

export class TerminosDto {
  @IsString() @IsNotEmpty() version: string;
}

export class DispositivoDto {
  @IsString() @IsNotEmpty() fcmToken: string;
  @IsIn(APPS) app: string;
}
