import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor, Roles } from '../common/auth';
import { UuidPipe } from '../common/util';
import { Usuario } from '../database/entities';
import { BuscarTiendasDto, CategoriaDto, CategoriaUpdateDto, ProductoDto, ProductoUpdateDto, TiendaUpdateDto } from './tiendas.dto';
import { TiendasService, vistaTienda } from './tiendas.service';

@Controller()
export class TiendasController {
  constructor(private readonly svc: TiendasService) {}

  // Las rutas /tiendas/mia van antes de /tiendas/:id para que "mia" no se tome como un id.

  @Roles('tienda') @Get('tiendas/mia')
  async mia(@Actor() u: Usuario) { return vistaTienda(await this.svc.deUsuario(u.id)); }

  @Roles('tienda') @Patch('tiendas/mia')
  actualizarMia(@Actor() u: Usuario, @Body() dto: TiendaUpdateDto) { return this.svc.actualizarMia(u, dto); }

  @Roles('tienda') @Get('tiendas/mia/productos')
  misProductos(@Actor() u: Usuario) { return this.svc.misProductos(u.id); }

  @Roles('tienda') @Get('tiendas/mia/categorias')
  misCategorias(@Actor() u: Usuario) { return this.svc.misCategorias(u.id); }

  @Roles('tienda') @Post('tiendas/mia/categorias')
  crearCategoria(@Actor() u: Usuario, @Body() dto: CategoriaDto) { return this.svc.crearCategoria(u.id, dto); }

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

  @Roles('tienda') @Delete('productos/:id') @HttpCode(204)
  eliminarProducto(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.eliminarProducto(id, u.id); }

  @Get('tiendas')
  buscar(@Query() q: BuscarTiendasDto) { return this.svc.buscar(q); }

  @Get('tiendas/:id')
  async detalle(@Param('id', UuidPipe) id: string) { return vistaTienda(await this.svc.porId(id)); }

  @Get('tiendas/:id/menu')
  menu(@Param('id', UuidPipe) id: string) { return this.svc.menu(id); }
}
