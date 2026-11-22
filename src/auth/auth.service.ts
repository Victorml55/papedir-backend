import { versionTerminos } from '../config/catalogos';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { DataSource, EntityManager, In, IsNull, MoreThan, Not, Repository } from 'typeorm';
import { AppError, conflicto, invalido, sinPermiso } from '../common/errores';
import { ESTADOS_FINALES, REGLAS, Rol } from '../config/reglas';
import { CodigoVerificacion, Direccion, Dispositivo, Documento, Pedido, RefreshToken, Tienda, Usuario, Vehiculo, Viaje } from '../database/entities';
import { AlmacenService } from '../nucleo/almacen.service';
import { FirebaseService } from '../nucleo/firebase.service';
import { BitacoraCuentasService } from '../nucleo/bitacora-cuentas.service';
import { CorreoService } from '../nucleo/correo.service';
import { RealtimeService } from '../nucleo/realtime.service';
import { DispositivoDto, LoginDto, LoginFirebaseDto, PerfilDto, RegistroDto, TiendaRegistroDto } from './auth.dto';

/** Qué roles pueden entrar a cada app. */
const ROLES_POR_APP: Record<string, Rol[]> = {
  cliente: ['cliente'],
  tienda: ['tienda'],
  repartidor: ['repartidor'],
  web: ['soporte', 'admin'],
};

type Proposito = CodigoVerificacion['proposito'];
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
const hashCodigo = (usuarioId: string, codigo: string) => sha256(`${usuarioId}:${codigo}`);
const R = REGLAS.cuenta;

export const vistaUsuario = (u: Usuario) => ({
  id: u.id,
  nombre: u.nombre,
  email: u.email,
  telefono: u.telefono,
  rol: u.rol,
  estado: u.estado,
  fotoUrl: u.fotoUrl ?? null,
  emailVerificado: !!u.emailVerificadoEn,
  terminosPendientes: u.terminosVersion !== versionTerminos(),
  calificacion: u.calificacion ?? null,
  /** local (correo de PaPedir), password (correo de Firebase), google.com, github.com... */
  proveedor: u.proveedor ?? 'local',
  /** Solo las cuentas de correo pueden cambiar su foto; las de Google o GitHub usan la del proveedor. */
  puedeCambiarFoto: fotoEditable(u),
  /** Solicitud de cuenta (tienda o repartidor) que soporte regresó: qué debe corregir. Se limpia al aprobarla. */
  motivoRechazo: u.motivoRechazo ?? null,
  rechazadaEn: u.rechazadaEn ?? null,
  creadoEn: u.creadoEn,
});

const fotoEditable = (u: Usuario) => !u.proveedor || u.proveedor === 'local' || u.proveedor === 'password';

/** Las cuentas que entran con Firebase manejan su contraseña y su correo en Firebase, no aquí. */
const exigirCuentaLocal = (u: Usuario) => {
  if (u.firebaseUid) {
    throw conflicto('CUENTA_FIREBASE', 'Tu cuenta usa el inicio de sesión de la app; cámbialo desde ahí (Firebase)');
  }
};

@Injectable()
export class AuthService {
  constructor(
    private readonly ds: DataSource,
    private readonly jwt: JwtService,
    private readonly correo: CorreoService,
    private readonly bitacora: BitacoraCuentasService,
    private readonly rt: RealtimeService,
    private readonly almacen: AlmacenService,
    private readonly firebase: FirebaseService,
    @InjectRepository(Usuario) private readonly usuarios: Repository<Usuario>,
    @InjectRepository(RefreshToken) private readonly refresh: Repository<RefreshToken>,
    @InjectRepository(Dispositivo) private readonly dispositivos: Repository<Dispositivo>,
    @InjectRepository(CodigoVerificacion) private readonly codigos: Repository<CodigoVerificacion>,
  ) {}

  // ─────────────────────────── registro y sesión

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
          terminosVersion: versionTerminos(),
          terminosAceptadosEn: new Date(),
        }),
      );
      if (dto.rol === 'tienda') await this.crearTienda(m, u, dto.tienda, dto.telefono);
      await this.bitacora.registrar(u.id, 'registrada', u, `Aceptó términos ${versionTerminos()}`, m);
      return u;
    });
    // Si el correo falla, la cuenta se crea igual: puede pedir otro código después.
    await this.enviarCodigo(usuario, 'verificar_email').catch(() => false);
    return this.sesion(usuario);
  }

  private crearTienda(m: EntityManager, u: Usuario, t: TiendaRegistroDto, telefono: string) {
    return m.save(
      m.create(Tienda, {
        ownerId: u.id, nombre: t.nombre.trim(), categoria: t.categoria, direccion: t.direccion, telefono,
        lat: t.ubicacion.lat, lng: t.ubicacion.lng,
      }),
    );
  }

  /**
   * Inicio de sesión de las apps con Firebase Authentication (Google, GitHub o correo y contraseña).
   * Firebase se encarga de la contraseña, la verificación del correo y la recuperación; aquí se valida
   * el token y se entrega la sesión de PaPedir de siempre (accessToken + refreshToken).
   * 1. Cuenta ya ligada (firebaseUid) → entra.
   * 2. Existe una cuenta con ese correo verificado → se liga a Firebase y entra.
   * 3. No existe → 404 REGISTRO_REQUERIDO; la app pide teléfono, términos (y datos de la tienda) y vuelve a llamar con `registro`.
   */
  async loginFirebase(dto: LoginFirebaseDto) {
    const f = await this.firebase.verificar(dto.idToken);
    if (!f.email) throw invalido('Tu cuenta de Firebase no tiene correo; usa otro método para entrar', 'idToken');
    // Requisito: las cuentas de correo deben verificarlo antes de entrar.
    if (f.proveedor === 'password' && !f.emailVerificado) {
      throw sinPermiso('Verifica tu correo con el enlace que te enviamos antes de entrar', 'CORREO_NO_VERIFICADO');
    }

    let u = await this.usuarios.findOneBy({ firebaseUid: f.uid });
    if (!u) {
      const mismoCorreo = await this.usuarios.findOneBy({ email: f.email });
      if (mismoCorreo) {
        // Solo se liga si Firebase garantiza que el correo es suyo; si no, alguien podría tomar una cuenta ajena.
        if (mismoCorreo.firebaseUid || !f.emailVerificado) {
          throw conflicto('EMAIL_REGISTRADO', 'Ese correo ya tiene una cuenta; entra con tu correo y contraseña');
        }
        u = mismoCorreo;
        u.firebaseUid = f.uid;
        u.proveedor = f.proveedor;
        await this.usuarios.update(u.id, { firebaseUid: f.uid, proveedor: f.proveedor });
        await this.bitacora.registrar(u.id, 'ligada_firebase', u, f.proveedor);
      }
    }

    if (!u) {
      if (!dto.registro) {
        throw new AppError(404, 'REGISTRO_REQUERIDO', 'Completa tu registro para continuar', [
          { campo: 'registro', mensaje: 'Primera vez: manda teléfono y aceptoTerminos (y tienda en la app de tiendas)' },
        ]);
      }
      if (dto.app === 'tienda' && !dto.registro.tienda) throw invalido('tienda es obligatorio en la app de tiendas', 'registro.tienda');
      const r = dto.registro;
      u = await this.ds.transaction(async (m) => {
        const nuevo = await m.save(
          m.create(Usuario, {
            nombre: (r.nombre ?? f.nombre ?? f.email.split('@')[0]).trim().slice(0, 80),
            email: f.email,
            telefono: r.telefono,
            rol: dto.app,
            // Nunca se usa: la contraseña la maneja Firebase.
            passwordHash: await bcrypt.hash(randomBytes(32).toString('hex'), 4),
            estado: dto.app === 'cliente' ? 'activo' : 'pendiente_aprobacion',
            terminosVersion: versionTerminos(),
            terminosAceptadosEn: new Date(),
            emailVerificadoEn: f.emailVerificado ? new Date() : null,
            fotoUrl: f.foto,
            firebaseUid: f.uid,
            proveedor: f.proveedor,
          }),
        );
        if (dto.app === 'tienda') await this.crearTienda(m, nuevo, r.tienda, r.telefono);
        await this.bitacora.registrar(nuevo.id, 'registrada', nuevo, `Con Firebase (${f.proveedor}); aceptó términos ${versionTerminos()}`, m);
        return nuevo;
      });
      return this.sesion(u);
    }

    if (u.estado === 'eliminado') throw new AppError(401, 'NO_AUTENTICADO', 'Esta cuenta fue eliminada');
    if (u.estado === 'baneado') throw sinPermiso('Tu cuenta fue suspendida', 'CUENTA_BANEADA');
    if (!ROLES_POR_APP[dto.app].includes(u.rol)) throw sinPermiso('Esta cuenta no corresponde a esta aplicación', 'APP_INCORRECTA');

    // La foto se sincroniza con la del proveedor (Google, GitHub); las cuentas de correo conservan la suya.
    const cambios: Partial<Usuario> = {};
    if (!fotoEditable(u) && f.foto && f.foto !== u.fotoUrl) cambios.fotoUrl = f.foto;
    if (f.emailVerificado && !u.emailVerificadoEn) cambios.emailVerificadoEn = new Date();
    if (Object.keys(cambios).length) {
      await this.usuarios.update(u.id, cambios);
      Object.assign(u, cambios);
    }
    return this.sesion(u);
  }

  async login(dto: LoginDto) {
    const usuario = await this.usuarios.findOneBy({ email: dto.email.toLowerCase().trim() });
    if (!usuario || usuario.estado === 'eliminado') throw new AppError(401, 'NO_AUTENTICADO', 'Correo o contraseña incorrectos');
    this.exigirNoBloqueado(usuario);

    if (!(await bcrypt.compare(dto.password, usuario.passwordHash))) {
      await this.registrarFallo(usuario);
      throw new AppError(401, 'NO_AUTENTICADO', 'Correo o contraseña incorrectos');
    }
    if (usuario.intentosFallidos) await this.usuarios.update(usuario.id, { intentosFallidos: 0 });
    if (usuario.estado === 'baneado') throw sinPermiso('Tu cuenta fue suspendida', 'CUENTA_BANEADA');
    if (!ROLES_POR_APP[dto.app].includes(usuario.rol)) {
      throw sinPermiso('Esta cuenta no corresponde a esta aplicación', 'APP_INCORRECTA');
    }
    return this.sesion(usuario);
  }

  private exigirNoBloqueado(u: Usuario) {
    if (u.bloqueadoHasta && u.bloqueadoHasta > new Date()) {
      const min = Math.ceil((u.bloqueadoHasta.getTime() - Date.now()) / 60000);
      throw sinPermiso(`Demasiados intentos fallidos. Intenta de nuevo en ${min} min o recupera tu contraseña.`, 'CUENTA_BLOQUEADA');
    }
  }

  /** Cuenta los intentos fallidos de forma atómica; al llegar al máximo bloquea la cuenta unos minutos. */
  private async registrarFallo(u: Usuario) {
    const [fila] = await this.ds.query(
      `UPDATE usuarios SET intentos_fallidos = intentos_fallidos + 1 WHERE id = $1 RETURNING intentos_fallidos`,
      [u.id],
    );
    const intentos = Array.isArray(fila) ? fila[0]?.intentos_fallidos : fila?.intentos_fallidos;
    if (intentos >= R.maxIntentosLogin) {
      const hasta = new Date(Date.now() + R.minutosBloqueo * 60000);
      await this.usuarios.update(u.id, { intentosFallidos: 0, bloqueadoHasta: hasta });
      await this.bitacora.registrar(u.id, 'bloqueada', null, `${R.maxIntentosLogin} contraseñas incorrectas seguidas`);
      throw sinPermiso(`Demasiados intentos fallidos. Tu cuenta quedó bloqueada ${R.minutosBloqueo} min; puedes recuperar tu contraseña.`, 'CUENTA_BLOQUEADA');
    }
  }

  /** Rotación: cada refresh token sirve una sola vez. */
  async refrescar(token: string) {
    const fila = await this.refresh.findOneBy({ tokenHash: sha256(token) });
    if (fila) await this.refresh.delete(fila.id);
    if (!fila || fila.expiraEn < new Date()) throw new AppError(401, 'NO_AUTENTICADO', 'Sesión expirada, inicia sesión de nuevo');
    const usuario = await this.usuarios.findOneBy({ id: fila.usuarioId });
    if (!usuario || usuario.estado === 'baneado' || usuario.estado === 'eliminado') throw new AppError(401, 'NO_AUTENTICADO', 'Sesión inválida');
    return this.tokens(usuario);
  }

  async logout(token: string) {
    await this.refresh.delete({ tokenHash: sha256(token) });
  }

  /** Cierra la sesión en todos los dispositivos y deja de mandarles push. */
  async cerrarSesiones(usuarioId: string) {
    await this.refresh.delete({ usuarioId });
    await this.dispositivos.delete({ usuarioId });
  }

  // ─────────────────────────── códigos por correo

  /** Crea un código de 6 dígitos y lo manda por correo. Respeta un máximo por hora para no spamear. */
  private async enviarCodigo(u: Usuario, proposito: Proposito) {
    const recientes = await this.codigos.countBy({ usuarioId: u.id, proposito, creadoEn: MoreThan(new Date(Date.now() - 3600000)) });
    if (recientes >= R.codigosPorHora) return false;
    const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
    // Un código nuevo invalida los anteriores del mismo propósito.
    await this.codigos.update({ usuarioId: u.id, proposito, usadoEn: IsNull() }, { usadoEn: new Date() });
    await this.codigos.insert({
      usuarioId: u.id,
      proposito,
      codigoHash: hashCodigo(u.id, codigo),
      expiraEn: new Date(Date.now() + R.minutosCodigo * 60000),
    });
    await this.correo.codigo(u.email, u.nombre, proposito, codigo, R.minutosCodigo);
    return true;
  }

  /** Valida y consume un código. Cada intento equivocado cuenta; al quinto el código deja de servir. */
  private async consumirCodigo(u: Usuario, proposito: Proposito, codigo: string) {
    const fila = await this.codigos.findOne({
      where: { usuarioId: u.id, proposito, usadoEn: IsNull(), expiraEn: MoreThan(new Date()) },
      order: { creadoEn: 'DESC' },
    });
    const malo = () => new AppError(400, 'CODIGO_INVALIDO', 'El código es incorrecto o ya venció; pide uno nuevo');
    if (!fila || fila.intentos >= R.intentosPorCodigo) throw malo();
    const esperado = Buffer.from(fila.codigoHash, 'hex');
    const recibido = Buffer.from(hashCodigo(u.id, codigo), 'hex');
    if (!timingSafeEqual(esperado, recibido)) {
      await this.codigos.increment({ id: fila.id }, 'intentos', 1);
      throw malo();
    }
    await this.codigos.update(fila.id, { usadoEn: new Date() });
  }

  /** Siempre responde igual, exista o no el correo, para no revelar qué cuentas existen. */
  async solicitarRecuperacion(email: string) {
    const u = await this.usuarios.findOneBy({ email: email.toLowerCase().trim() });
    // Las cuentas de Firebase recuperan su contraseña con Firebase (sendPasswordResetEmail).
    if (u && !u.firebaseUid && u.estado !== 'eliminado' && u.estado !== 'baneado') await this.enviarCodigo(u, 'recuperar_password');
  }

  async restablecer(email: string, codigo: string, password: string) {
    const u = await this.usuarios.findOneBy({ email: email.toLowerCase().trim() });
    if (!u || u.estado === 'eliminado' || u.estado === 'baneado') {
      throw new AppError(400, 'CODIGO_INVALIDO', 'El código es incorrecto o ya venció; pide uno nuevo');
    }
    await this.consumirCodigo(u, 'recuperar_password', codigo);
    await this.usuarios.update(u.id, {
      passwordHash: await bcrypt.hash(password, 10),
      intentosFallidos: 0,
      bloqueadoHasta: null,
      // Recibir el código prueba que el correo es suyo.
      emailVerificadoEn: u.emailVerificadoEn ?? new Date(),
    });
    await this.cerrarSesiones(u.id);
    await this.bitacora.registrar(u.id, 'password_restablecida', u, 'Con código enviado por correo');
  }

  async verificarCorreo(u: Usuario, codigo: string) {
    if (u.emailVerificadoEn) return vistaUsuario(u);
    await this.consumirCodigo(u, 'verificar_email', codigo);
    u.emailVerificadoEn = new Date();
    await this.usuarios.update(u.id, { emailVerificadoEn: u.emailVerificadoEn });
    await this.bitacora.registrar(u.id, 'correo_verificado', u);
    return vistaUsuario(u);
  }

  async reenviarVerificacion(u: Usuario) {
    exigirCuentaLocal(u);
    if (u.emailVerificadoEn) throw conflicto('CORREO_YA_VERIFICADO', 'Tu correo ya está verificado');
    if (!(await this.enviarCodigo(u, 'verificar_email'))) {
      throw new AppError(429, 'DEMASIADAS_PETICIONES', 'Ya te enviamos varios códigos; espera una hora o revisa tu bandeja de spam');
    }
  }

  // ─────────────────────────── perfil

  async actualizarPerfil(usuario: Usuario, dto: PerfilDto) {
    if (dto.nombre !== undefined) usuario.nombre = dto.nombre.trim();
    if (dto.telefono !== undefined) usuario.telefono = dto.telefono;
    if (dto.fotoUrl !== undefined) {
      if (!fotoEditable(usuario)) {
        throw sinPermiso('Tu foto es la de tu cuenta de Google o GitHub; cámbiala ahí', 'FOTO_DEL_PROVEEDOR');
      }
      usuario.fotoUrl = dto.fotoUrl || null;
    }
    return vistaUsuario(await this.usuarios.save(usuario));
  }

  /** Cambia la contraseña, cierra las demás sesiones y devuelve tokens nuevos para este dispositivo. */
  async cambiarPassword(u: Usuario, actual: string, nueva: string) {
    exigirCuentaLocal(u);
    if (!(await bcrypt.compare(actual, u.passwordHash))) throw sinPermiso('La contraseña actual no es correcta', 'PASSWORD_INCORRECTA');
    if (actual === nueva) throw invalido('La contraseña nueva debe ser distinta de la actual', 'nueva');
    await this.usuarios.update(u.id, { passwordHash: await bcrypt.hash(nueva, 10) });
    await this.refresh.delete({ usuarioId: u.id });
    await this.bitacora.registrar(u.id, 'password_cambiada', u);
    return this.tokens(u);
  }

  async aceptarTerminos(u: Usuario, version: string) {
    if (version !== versionTerminos()) {
      throw conflicto('VERSION_TERMINOS', `La versión vigente es ${versionTerminos()}; vuelve a cargar los términos`);
    }
    Object.assign(u, { terminosVersion: version, terminosAceptadosEn: new Date() });
    await this.usuarios.update(u.id, { terminosVersion: version, terminosAceptadosEn: u.terminosAceptadosEn });
    await this.bitacora.registrar(u.id, 'terminos_aceptados', u, version);
    return vistaUsuario(u);
  }

  legal() {
    const web = (process.env.LEGAL_URL_BASE ?? 'https://papedir-frontend.vercel.app').replace(/\/+$/, '');
    return {
      version: versionTerminos(),
      avisoPrivacidadUrl: `${web}/privacidad`,
      terminosUrl: `${web}/terminos`,
    };
  }

  /**
   * Elimina la cuenta: borra sus datos personales y la deja anónima. Los pedidos y tickets
   * se conservan (sin datos personales) para la contabilidad y para soporte.
   */
  /** Confirma con la contraseña de PaPedir o, en cuentas de Firebase, con un ID token de esa misma cuenta. */
  async eliminarCuenta(u: Usuario, confirmacion: { password?: string; idToken?: string }) {
    if (confirmacion.idToken) {
      const f = await this.firebase.verificar(confirmacion.idToken);
      if (f.uid !== u.firebaseUid) throw sinPermiso('Ese inicio de sesión no corresponde a tu cuenta', 'PASSWORD_INCORRECTA');
    } else if (!(await bcrypt.compare(confirmacion.password ?? '', u.passwordHash))) {
      throw sinPermiso('La contraseña no es correcta', 'PASSWORD_INCORRECTA');
    }
    const activos = { estado: Not(In(ESTADOS_FINALES)) };
    const tiendas = u.rol === 'tienda' ? await this.ds.getRepository(Tienda).findBy({ ownerId: u.id }) : [];
    const pendientes =
      (u.rol === 'cliente' && (await this.ds.getRepository(Pedido).existsBy({ clienteId: u.id, ...activos }))) ||
      (u.rol === 'repartidor' && (await this.ds.getRepository(Viaje).existsBy({ repartidorId: u.id, estado: 'activo' }))) ||
      (tiendas.length > 0 && (await this.ds.getRepository(Pedido).existsBy({ tiendaId: In(tiendas.map((t) => t.id)), ...activos })));
    if (pendientes) throw conflicto('TIENE_PEDIDOS_ACTIVOS', 'Termina o cancela tus pedidos en curso antes de eliminar tu cuenta');
    if (u.rol === 'admin' && (await this.usuarios.countBy({ rol: 'admin', estado: 'activo' })) <= 1) {
      throw conflicto('ULTIMO_ADMIN', 'No puedes eliminar la única cuenta de admin activa');
    }

    await this.anonimizar(u, u, 'A petición del usuario');
  }

  /**
   * Borra los datos personales de una cuenta y la deja en estado "eliminado". Sus pedidos, pagos y
   * movimientos se conservan sin nombre ni teléfono. La usan el propio usuario y un admin.
   */
  async anonimizar(u: Usuario, actor: Pick<Usuario, 'id' | 'rol'>, motivo: string) {
    const tiendas = u.rol === 'tienda' ? await this.ds.getRepository(Tienda).findBy({ ownerId: u.id }) : [];
    const documentos = await this.ds.getRepository(Documento).findBy({ usuarioId: u.id });
    await this.ds.transaction(async (m) => {
      await m.update(Usuario, u.id, {
        nombre: 'Usuario eliminado',
        email: `eliminado+${u.id}@papedir.invalid`,
        telefono: null,
        fotoUrl: null,
        passwordHash: await bcrypt.hash(randomBytes(32).toString('hex'), 4),
        estado: 'eliminado',
        eliminadoEn: new Date(),
        disponible: false,
        lat: null,
        lng: null,
        motivoBaneo: null,
        firebaseUid: null,
      });
      if (tiendas.length) await m.update(Tienda, { ownerId: u.id }, { abierta: false, telefono: null });
      // Sus pedidos anteriores se conservan, pero sin su nombre ni su teléfono.
      if (u.rol === 'cliente') {
        await m.update(Pedido, { clienteId: u.id }, { destinoNombre: 'Cliente eliminado', destinoTelefono: '', destinoReferencias: null });
      }
      await m.delete(Direccion, { clienteId: u.id });
      await m.delete(RefreshToken, { usuarioId: u.id });
      await m.delete(Dispositivo, { usuarioId: u.id });
      await m.delete(CodigoVerificacion, { usuarioId: u.id });
      await m.delete(Documento, { usuarioId: u.id });
      await m.delete(Vehiculo, { repartidorId: u.id });
      await this.bitacora.registrar(u.id, 'eliminada', actor, motivo, m);
    });
    // INE, licencia...: también se borran los archivos.
    void this.almacen.borrarPrivados(documentos.map((d) => d.ruta));
    if (u.firebaseUid) void this.firebase.borrarUsuario(u.firebaseUid);
    this.rt.desconectar(u.id);
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
