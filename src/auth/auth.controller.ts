import { Body, Controller, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Actor, Publico } from '../common/auth';
import { Usuario } from '../database/entities';
import { DispositivoDto, LoginDto, PerfilDto, RefreshDto, RegistroDto } from './auth.dto';
import { AuthService, vistaUsuario } from './auth.service';

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Publico() @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('auth/register')
  registrar(@Body() dto: RegistroDto) {
    return this.auth.registrar(dto);
  }

  @Publico() @Throttle({ default: { limit: 10, ttl: 60000 } })
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

  @Get('auth/me')
  yo(@Actor() u: Usuario) {
    return vistaUsuario(u);
  }

  @Patch('usuarios/me')
  actualizar(@Actor() u: Usuario, @Body() dto: PerfilDto) {
    return this.auth.actualizarPerfil(u, dto);
  }

  @Put('usuarios/me/dispositivo') @HttpCode(204)
  dispositivo(@Actor() u: Usuario, @Body() dto: DispositivoDto) {
    return this.auth.registrarDispositivo(u, dto);
  }
}
