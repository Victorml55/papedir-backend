import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { AppError, conflicto, sinPermiso } from '../common/errores';
import { Rol } from '../config/reglas';
import { Dispositivo, RefreshToken, Tienda, Usuario } from '../database/entities';
import { DispositivoDto, LoginDto, PerfilDto, RegistroDto } from './auth.dto';

/** Qué roles pueden entrar a cada app. */
const ROLES_POR_APP: Record<string, Rol[]> = {
  cliente: ['cliente'],
  tienda: ['tienda'],
  repartidor: ['repartidor'],
  web: ['soporte', 'admin'],
};

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

export const vistaUsuario = (u: Usuario) => ({
  id: u.id,
  nombre: u.nombre,
  email: u.email,
  telefono: u.telefono,
  rol: u.rol,
  estado: u.estado,
  creadoEn: u.creadoEn,
});

@Injectable()
export class AuthService {
  constructor(
    private readonly ds: DataSource,
    private readonly jwt: JwtService,
    @InjectRepository(Usuario) private readonly usuarios: Repository<Usuario>,
    @InjectRepository(RefreshToken) private readonly refresh: Repository<RefreshToken>,
    @InjectRepository(Dispositivo) private readonly dispositivos: Repository<Dispositivo>,
  ) {}

  async registrar(dto: RegistroDto) {
    const email = dto.email.toLowerCase().trim();
    if (await this.usuarios.existsBy({ email })) throw conflicto('EMAIL_REGISTRADO', 'Ese correo ya está registrado');

    const usuario = await this.ds.transaction(async (m) => {
      const u = await m.save(
        m.create(Usuario, {
          nombre: dto.nombre.trim(),
          email,
          telefono: dto.telefono,
          rol: dto.rol,
          passwordHash: await bcrypt.hash(dto.password, 10),
          // Tiendas y repartidores esperan la aprobación de soporte.
          estado: dto.rol === 'cliente' ? 'activo' : 'pendiente_aprobacion',
        }),
      );
      if (dto.rol === 'tienda') {
        await m.save(
          m.create(Tienda, {
            ownerId: u.id,
            nombre: dto.tienda.nombre.trim(),
            categoria: dto.tienda.categoria,
            direccion: dto.tienda.direccion,
            telefono: dto.telefono,
            lat: dto.tienda.ubicacion.lat,
            lng: dto.tienda.ubicacion.lng,
          }),
        );
      }
      return u;
    });
    return this.sesion(usuario);
  }

  async login(dto: LoginDto) {
    const usuario = await this.usuarios.findOneBy({ email: dto.email.toLowerCase().trim() });
    if (!usuario || !(await bcrypt.compare(dto.password, usuario.passwordHash))) {
      throw new AppError(401, 'NO_AUTENTICADO', 'Correo o contraseña incorrectos');
    }
    if (usuario.estado === 'baneado') throw sinPermiso('Tu cuenta fue suspendida', 'CUENTA_BANEADA');
    if (!ROLES_POR_APP[dto.app].includes(usuario.rol)) {
      throw sinPermiso('Esta cuenta no corresponde a esta aplicación', 'APP_INCORRECTA');
    }
    return this.sesion(usuario);
  }

  /** Rotación: cada refresh token sirve una sola vez. */
  async refrescar(token: string) {
    const fila = await this.refresh.findOneBy({ tokenHash: sha256(token) });
    if (fila) await this.refresh.delete(fila.id);
    if (!fila || fila.expiraEn < new Date()) throw new AppError(401, 'NO_AUTENTICADO', 'Sesión expirada, inicia sesión de nuevo');
    const usuario = await this.usuarios.findOneBy({ id: fila.usuarioId });
    if (!usuario || usuario.estado === 'baneado') throw new AppError(401, 'NO_AUTENTICADO', 'Sesión inválida');
    return this.tokens(usuario);
  }

  async logout(token: string) {
    await this.refresh.delete({ tokenHash: sha256(token) });
  }

  async cerrarSesiones(usuarioId: string) {
    await this.refresh.delete({ usuarioId });
    await this.dispositivos.delete({ usuarioId });
  }

  async actualizarPerfil(usuario: Usuario, dto: PerfilDto) {
    if (dto.nombre !== undefined) usuario.nombre = dto.nombre.trim();
    if (dto.telefono !== undefined) usuario.telefono = dto.telefono;
    return vistaUsuario(await this.usuarios.save(usuario));
  }

  /** Un token de FCM pertenece a un solo usuario: si cambia de cuenta en el mismo teléfono, se reasigna. */
  async registrarDispositivo(usuario: Usuario, dto: DispositivoDto) {
    await this.dispositivos.upsert({ usuarioId: usuario.id, fcmToken: dto.fcmToken, app: dto.app }, ['fcmToken']);
  }

  private async sesion(usuario: Usuario) {
    return { ...(await this.tokens(usuario)), usuario: vistaUsuario(usuario) };
  }

  private async tokens(usuario: Usuario) {
    const refreshToken = randomBytes(48).toString('hex');
    const dias = Number(process.env.REFRESH_DIAS ?? 7);
    await this.refresh.insert({
      usuarioId: usuario.id,
      tokenHash: sha256(refreshToken), // en la BD solo se guarda el hash
      expiraEn: new Date(Date.now() + dias * 86400000),
    });
    return { accessToken: await this.jwt.signAsync({ sub: usuario.id, rol: usuario.rol }), refreshToken };
  }
}
