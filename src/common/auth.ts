import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Rol } from '../config/reglas';
import { Usuario } from '../database/entities';
import { AppError, sinPermiso } from './errores';

/** Ruta sin token (login, registro, health). */
export const Publico = () => SetMetadata('publico', true);
/** Roles que pueden usar la ruta. Sin este decorador, cualquier usuario autenticado. */
export const Roles = (...roles: Rol[]) => SetMetadata('roles', roles);
/**
 * Sucursal elegida con el header `X-Tienda-Id` (rol tienda). Sin header = la primera sucursal del dueño.
 * Solo dice cuál pidió; el servicio revisa que sea suya.
 */
export const TiendaSel = createParamDecorator((_: unknown, ctx: ExecutionContext): string | undefined => {
  const v = ctx.switchToHttp().getRequest().headers['x-tienda-id'];
  if (v == null || v === '') return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v))) {
    throw new AppError(400, 'VALIDACION', 'X-Tienda-Id no es un UUID válido', [{ campo: 'X-Tienda-Id', mensaje: 'Debe ser un UUID' }]);
  }
  return String(v);
});
/** Usuario autenticado (entidad completa). */
export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): Usuario => ctx.switchToHttp().getRequest().usuario);

/**
 * Guard global: valida el JWT, carga al usuario en cada petición (así un baneo
 * surte efecto de inmediato) y revisa el rol.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @InjectRepository(Usuario) private readonly usuarios: Repository<Usuario>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const destinos = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('publico', destinos)) return true;

    const req = ctx.switchToHttp().getRequest();
    const [tipo, token] = (req.headers.authorization ?? '').split(' ');
    if (tipo !== 'Bearer' || !token) throw new AppError(401, 'NO_AUTENTICADO', 'Falta el token de acceso');

    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new AppError(401, 'NO_AUTENTICADO', 'Token inválido o expirado');
    }
    const usuario = await this.usuarios.findOneBy({ id: payload.sub });
    if (!usuario || usuario.estado === 'eliminado') throw new AppError(401, 'NO_AUTENTICADO', 'El usuario ya no existe');
    if (usuario.estado === 'baneado') throw sinPermiso('Tu cuenta fue suspendida', 'CUENTA_BANEADA');

    const roles = this.reflector.getAllAndOverride<Rol[]>('roles', destinos);
    if (roles?.length && !roles.includes(usuario.rol)) throw sinPermiso();

    req.usuario = usuario;
    return true;
  }
}
