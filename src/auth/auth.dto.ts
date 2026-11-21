import { EsCategoria } from '../config/catalogos';
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
  @EsCategoria() categoria: string;
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

/** Para eliminar la cuenta: la contraseña, o un ID token reciente de Firebase si la cuenta entra con Firebase. */
export class ConfirmarPasswordDto {
  @ValidateIf((o) => !o.idToken) @IsString() @IsNotEmpty() password?: string;
  @IsOptional() @IsString() @IsNotEmpty() idToken?: string;
}

/** Datos que pide la app la primera vez que alguien entra con Firebase (Google no da teléfono ni rol). */
export class RegistroFirebaseDto {
  /** Si se omite, se usa el nombre de la cuenta de Google o GitHub. */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) nombre?: string;
  @Matches(TELEFONO, { message: 'telefono debe tener 10 dígitos' }) telefono: string;
  @Equals(true, { message: 'Debes aceptar el aviso de privacidad y los términos para crear tu cuenta' }) aceptoTerminos: boolean;
  /** Obligatorio en la app tienda. */
  @IsOptional() @ValidateNested() @Type(() => TiendaRegistroDto) tienda?: TiendaRegistroDto;
}

export class LoginFirebaseDto {
  /** ID token de Firebase Authentication (user.getIdToken()). */
  @IsString() @IsNotEmpty() idToken: string;
  @IsIn(['cliente', 'tienda', 'repartidor']) app: 'cliente' | 'tienda' | 'repartidor';
  /** Solo la primera vez (cuando la API respondió 404 REGISTRO_REQUERIDO). */
  @IsOptional() @ValidateNested() @Type(() => RegistroFirebaseDto) registro?: RegistroFirebaseDto;
}

export class TerminosDto {
  @IsString() @IsNotEmpty() version: string;
}

export class DispositivoDto {
  @IsString() @IsNotEmpty() fcmToken: string;
  @IsIn(APPS) app: string;
}
