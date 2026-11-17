import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Actor, Roles, TiendaSel } from '../common/auth';
import { RangoFechasDto } from '../common/dtos';
import { UuidPipe } from '../common/util';
import { Usuario } from '../database/entities';
import {
  BuscarTiendasDto, CategoriaDto, CategoriaUpdateDto, HorarioDto, OpcionesProductoDto, PausaDto, ProductoDto, ProductoUpdateDto,
  SucursalDto, TiendaUpdateDto,
} from './tiendas.dto';
import { TiendasService } from './tiendas.service';

/**
 * Las rutas /tiendas/mia trabajan con la sucursal del header `X-Tienda-Id`
 * (sin header, la primera sucursal del dueño). Van antes de /tiendas/:id para que "mia" no se tome como un id.
 */
@Controller()
export class TiendasController {
  constructor(private readonly svc: TiendasService) {}

  @Roles('tienda') @Get('tiendas/mias')
  sucursales(@Actor() u: Usuario) { return this.svc.misSucursales(u.id); }

  @Roles('tienda') @Post('tiendas/mias')
  crearSucursal(@Actor() u: Usuario, @Body() dto: SucursalDto) { return this.svc.crearSucursal(u, dto); }

  @Roles('tienda') @Get('tiendas/mia')
  async mia(@Actor() u: Usuario, @TiendaSel() t?: string) { return this.svc.vista(await this.svc.deUsuario(u.id, t)); }

  @Roles('tienda') @Patch('tiendas/mia')
  actualizarMia(@Actor() u: Usuario, @Body() dto: TiendaUpdateDto, @TiendaSel() t?: string) { return this.svc.actualizarMia(u, dto, t); }

  @Roles('tienda') @Get('tiendas/mia/horario')
  horario(@Actor() u: Usuario, @TiendaSel() t?: string) { return this.svc.horario(u.id, t); }

  @Roles('tienda') @Put('tiendas/mia/horario')
  guardarHorario(@Actor() u: Usuario, @Body() dto: HorarioDto, @TiendaSel() t?: string) { return this.svc.guardarHorario(u.id, dto, t); }

  @Roles('tienda') @Post('tiendas/mia/pausa') @HttpCode(200)
  pausar(@Actor() u: Usuario, @Body() dto: PausaDto, @TiendaSel() t?: string) { return this.svc.pausar(u.id, dto.minutos, t); }

  @Roles('tienda') @Delete('tiendas/mia/pausa')
  quitarPausa(@Actor() u: Usuario, @TiendaSel() t?: string) { return this.svc.quitarPausa(u.id, t); }

  @Roles('tienda') @Get('tiendas/mia/reporte')
  reporte(@Actor() u: Usuario, @Query() q: RangoFechasDto, @TiendaSel() t?: string) { return this.svc.reporte(u.id, q, t); }

  @Roles('tienda') @Get('tiendas/mia/productos')
  misProductos(@Actor() u: Usuario, @TiendaSel() t?: string) { return this.svc.misProductos(u.id, t); }

  @Roles('tienda') @Get('tiendas/mia/categorias')
  misCategorias(@Actor() u: Usuario, @TiendaSel() t?: string) { return this.svc.misCategorias(u.id, t); }

  @Roles('tienda') @Post('tiendas/mia/categorias')
  crearCategoria(@Actor() u: Usuario, @Body() dto: CategoriaDto, @TiendaSel() t?: string) { return this.svc.crearCategoria(u.id, dto, t); }

  @Roles('tienda') @Patch('categorias/:id')
  actualizarCategoria(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: CategoriaUpdateDto) {
    return this.svc.actualizarCategoria(id, u.id, dto);
  }

  @Roles('tienda') @Delete('categorias/:id') @HttpCode(204)
  eliminarCategoria(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.eliminarCategoria(id, u.id); }

  @Roles('tienda') @Post('productos')
  crearProducto(@Actor() u: Usuario, @Body() dto: ProductoDto) { return this.svc.crearProducto(u.id, dto); }

  @Roles('tienda') @Patch('productos/:id')
  actualizarProducto(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: ProductoUpdateDto) {
    return this.svc.actualizarProducto(id, u.id, dto);
  }

  @Roles('tienda') @Put('productos/:id/opciones')
  guardarOpciones(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: OpcionesProductoDto) {
    return this.svc.guardarOpciones(id, u.id, dto);
  }

  @Roles('tienda') @Delete('productos/:id') @HttpCode(204)
  eliminarProducto(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.eliminarProducto(id, u.id); }

  @Get('tiendas')
  buscar(@Query() q: BuscarTiendasDto) { return this.svc.buscar(q); }

  @Get('tiendas/:id')
  detalle(@Param('id', UuidPipe) id: string) { return this.svc.detalle(id); }

  @Get('tiendas/:id/menu')
  menu(@Param('id', UuidPipe) id: string) { return this.svc.menu(id); }
}
