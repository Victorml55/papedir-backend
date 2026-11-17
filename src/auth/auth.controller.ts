import { Body, Controller, Delete, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Actor, Publico } from '../common/auth';
import { Usuario } from '../database/entities';
import {
  CambiarPasswordDto, CodigoDto, ConfirmarPasswordDto, DispositivoDto, LoginDto, PerfilDto, RecuperarDto, RefreshDto, RegistroDto,
  RestablecerDto, TerminosDto,
} from './auth.dto';
import { AuthService, vistaUsuario } from './auth.service';

const ESTRICTO = { default: { limit: 10, ttl: 60000 } };

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Publico() @Throttle(ESTRICTO)
  @Post('auth/register')
  registrar(@Body() dto: RegistroDto) {
    return this.auth.registrar(dto);
  }

  @Publico() @Throttle(ESTRICTO)
  @Post('auth/login') @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Publico()
  @Post('auth/refresh') @HttpCode(200)
  refrescar(@Body() dto: RefreshDto) {
    return this.auth.refrescar(dto.refreshToken);
  }

  @Post('auth/logout') @HttpCode(204)
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @Post('auth/logout-todos') @HttpCode(204)
  logoutTodos(@Actor() u: Usuario) {
    return this.auth.cerrarSesiones(u.id);
  }

  @Publico() @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('auth/recuperar') @HttpCode(204)
  recuperar(@Body() dto: RecuperarDto) {
    return this.auth.solicitarRecuperacion(dto.email);
  }

  @Publico() @Throttle(ESTRICTO)
  @Post('auth/restablecer') @HttpCode(204)
  restablecer(@Body() dto: RestablecerDto) {
    return this.auth.restablecer(dto.email, dto.codigo, dto.password);
  }

  @Throttle(ESTRICTO)
  @Post('auth/verificar-correo') @HttpCode(200)
  verificarCorreo(@Actor() u: Usuario, @Body() dto: CodigoDto) {
    return this.auth.verificarCorreo(u, dto.codigo);
  }

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('auth/verificar-correo/reenviar') @HttpCode(204)
  reenviar(@Actor() u: Usuario) {
    return this.auth.reenviarVerificacion(u);
  }

  @Get('auth/me')
  yo(@Actor() u: Usuario) {
    return vistaUsuario(u);
  }

  @Publico()
  @Get('legal')
  legal() {
    return this.auth.legal();
  }

  @Patch('usuarios/me')
  actualizar(@Actor() u: Usuario, @Body() dto: PerfilDto) {
    return this.auth.actualizarPerfil(u, dto);
  }

  @Throttle(ESTRICTO)
  @Put('usuarios/me/password')
  cambiarPassword(@Actor() u: Usuario, @Body() dto: CambiarPasswordDto) {
    return this.auth.cambiarPassword(u, dto.actual, dto.nueva);
  }

  @Post('usuarios/me/terminos') @HttpCode(200)
  aceptarTerminos(@Actor() u: Usuario, @Body() dto: TerminosDto) {
    return this.auth.aceptarTerminos(u, dto.version);
  }

  @Throttle(ESTRICTO)
  @Delete('usuarios/me') @HttpCode(204)
  eliminar(@Actor() u: Usuario, @Body() dto: ConfirmarPasswordDto) {
    return this.auth.eliminarCuenta(u, dto.password);
  }

  @Put('usuarios/me/dispositivo') @HttpCode(204)
  dispositivo(@Actor() u: Usuario, @Body() dto: DispositivoDto) {
    return this.auth.registrarDispositivo(u, dto);
  }
}
