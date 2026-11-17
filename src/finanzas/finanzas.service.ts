import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { pagina, PaginaDto } from '../common/dtos';
import { folio, redondear } from '../common/util';
import { Movimiento, Pedido, Tienda } from '../database/entities';
import { ConfiguracionService } from '../nucleo/configuracion.service';

export const vistaMovimiento = (x: Movimiento) => ({
  id: x.id, tipo: x.tipo, monto: x.monto, descripcion: x.descripcion, pedidoId: x.pedidoId, tiendaId: x.tiendaId,
  liquidacionId: x.liquidacionId, creadoEn: x.creadoEn,
});

/**
 * Comisiones y cuenta corriente con PaPedir. Todo se paga en efectivo, así que el dinero lo tienen
 * la tienda y el repartidor; la plataforma les lleva la cuenta:
 * - Tienda: debe la comisión sobre lo que cobró por productos.
 * - Repartidor: debe la comisión sobre el envío; PaPedir le debe los descuentos de cupones de la plataforma.
 * Saldo > 0 = el usuario debe a PaPedir; < 0 = PaPedir le debe. Admin lo salda con una liquidación.
 */
@Injectable()
export class FinanzasService {
  constructor(
    private readonly config: ConfiguracionService,
    @InjectRepository(Movimiento) private readonly movimientos: Repository<Movimiento>,
  ) {}

  /** Corre dentro de la transacción que marca el pedido como entregado. */
  async registrarEntrega(m: EntityManager, p: Pedido) {
    const tienda = await m.findOneByOrFail(Tienda, { id: p.tiendaId });
    const c = await this.config.get('comisiones');
    const pct = tienda.comisionPct ?? c.tiendaPct;
    const comisionTienda = redondear((p.montoTienda * pct) / 100);
    const comisionEnvio = p.repartidorId ? redondear((p.costoEnvio * c.envioPct) / 100) : 0;
    await m.update(Pedido, p.id, { comisionTienda, comisionEnvio });

    const f = folio('R', p.folioNum);
    const filas: Partial<Movimiento>[] = [];
    if (comisionTienda > 0) {
      filas.push({ usuarioId: tienda.ownerId, tiendaId: tienda.id, pedidoId: p.id, tipo: 'comision_tienda', monto: comisionTienda, descripcion: `Comisión ${pct}% del pedido ${f}` });
    }
    if (p.repartidorId && comisionEnvio > 0) {
      filas.push({ usuarioId: p.repartidorId, pedidoId: p.id, tipo: 'comision_envio', monto: comisionEnvio, descripcion: `Comisión ${c.envioPct}% del envío ${f}` });
    }
    if (p.repartidorId && p.descuento > 0 && p.descuentoAbsorbe === 'plataforma') {
      filas.push({ usuarioId: p.repartidorId, pedidoId: p.id, tipo: 'descuento_plataforma', monto: -p.descuento, descripcion: `Cupón de PaPedir en el pedido ${f}` });
    }
    if (filas.length) await m.insert(Movimiento, filas);
  }

  async saldo(usuarioId: string) {
    const [{ s }] = await this.movimientos.query(`SELECT coalesce(sum(monto), 0)::float8 AS s FROM movimientos WHERE usuario_id = $1`, [usuarioId]);
    return redondear(s);
  }

  async estadoDeCuenta(usuarioId: string, q: PaginaDto) {
    const [filas, total] = await this.movimientos.findAndCount({
      where: { usuarioId }, order: { creadoEn: 'DESC' }, skip: (q.page - 1) * q.limit, take: q.limit,
    });
    const saldo = await this.saldo(usuarioId);
    return {
      saldo,
      // Para mostrar en la app: "Debes $X a PaPedir" o "PaPedir te debe $X".
      aFavorDe: saldo > 0 ? 'plataforma' : saldo < 0 ? 'usuario' : null,
      movimientos: pagina(filas.map(vistaMovimiento), total, q),
    };
  }
}
