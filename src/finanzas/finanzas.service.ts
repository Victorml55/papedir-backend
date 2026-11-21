import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { pagina, PaginaDto } from '../common/dtos';
import { conflicto } from '../common/errores';
import { folio, redondear } from '../common/util';
import { REGLAS } from '../config/reglas';
import { Movimiento, Pedido, TipoMovimiento, Tienda, Usuario } from '../database/entities';
import { ConfiguracionService } from '../nucleo/configuracion.service';

/** Comisión del plan de la tienda si está vigente (null = la general). */
export function comisionDelPlan(t: Tienda): number | null {
  if (t.plan === 'basico' || !t.planHasta || t.planHasta < new Date()) return null;
  return REGLAS.planes.find((x) => x.codigo === t.plan)?.comisionPct ?? null;
}

export const vistaMovimiento = (x: Movimiento) => ({
  id: x.id, tipo: x.tipo, monto: x.monto, descripcion: x.descripcion, pedidoId: x.pedidoId, tiendaId: x.tiendaId,
  liquidacionId: x.liquidacionId, creadoEn: x.creadoEn,
});

type Abono = { usuarioId: string; tipo: TipoMovimiento; monto: number; descripcion: string; pedidoId?: string | null; tiendaId?: string | null; liquidacionId?: string | null };

/**
 * Cartera de cada cuenta, como en DiDi: la suma de sus movimientos.
 *   saldo > 0 → dinero a su favor (PaPedir se lo paga o, al cliente, se le descuenta en su siguiente pedido).
 *   saldo < 0 → lo que debe a PaPedir.
 * - Tienda: debe la comisión de lo que cobró en efectivo; se le abona lo cobrado con tarjeta y las compensaciones.
 * - Repartidor: debe la comisión del envío y la deuda de clientes que cobró en efectivo; se le abona lo cobrado con
 *   tarjeta, los cupones de PaPedir y el saldo que usó el cliente en efectivo (él recibió menos).
 * - Cliente: saldo a favor por reembolsos; debe el cargo por cancelar tarde un pedido en efectivo.
 * Admin salda tiendas y repartidores con una liquidación; el cliente se salda solo en su siguiente pedido.
 */
@Injectable()
export class FinanzasService {
  constructor(
    private readonly config: ConfiguracionService,
    @InjectRepository(Movimiento) private readonly movimientos: Repository<Movimiento>,
  ) {}

  /** Inserta movimientos (monto con signo: + a favor, − debe). Ignora los de monto cero. */
  async abonar(m: EntityManager, filas: Abono[]) {
    const validas = filas.filter((f) => redondear(f.monto) !== 0).map((f) => ({ ...f, monto: redondear(f.monto) }));
    if (validas.length) await m.insert(Movimiento, validas);
  }

  /** Corre dentro de la transacción que marca el pedido como entregado. */
  async registrarEntrega(m: EntityManager, p: Pedido) {
    const tienda = await m.findOneByOrFail(Tienda, { id: p.tiendaId });
    const c = await this.config.get('comisiones');
    // Prioridad: comisión especial que puso admin → la del plan vigente → la general.
    const pct = tienda.comisionPct ?? comisionDelPlan(tienda) ?? c.tiendaPct;
    const comisionTienda = redondear((p.montoTienda * pct) / 100);
    const comisionEnvio = p.repartidorId ? redondear((p.costoEnvio * c.envioPct) / 100) : 0;
    await m.update(Pedido, p.id, { comisionTienda, comisionEnvio });

    const f = folio('R', p.folioNum);
    const filas: Abono[] = [
      { usuarioId: tienda.ownerId, tiendaId: tienda.id, pedidoId: p.id, tipo: 'comision_tienda', monto: -comisionTienda, descripcion: `Comisión ${pct}% del pedido ${f}` },
    ];
    if (p.repartidorId) {
      filas.push({ usuarioId: p.repartidorId, pedidoId: p.id, tipo: 'comision_envio', monto: -comisionEnvio, descripcion: `Comisión ${c.envioPct}% del envío ${f}` });
    }
    if (p.metodoPago === 'tarjeta') {
      // PaPedir cobró con tarjeta: le debe a la tienda su venta y al repartidor su envío y propina.
      filas.push({ usuarioId: tienda.ownerId, tiendaId: tienda.id, pedidoId: p.id, tipo: 'venta_tarjeta', monto: p.montoTienda, descripcion: `Venta con tarjeta ${f}` });
      if (p.repartidorId) {
        filas.push({ usuarioId: p.repartidorId, pedidoId: p.id, tipo: 'envio_tarjeta', monto: p.costoEnvio + p.propina, descripcion: `Envío y propina con tarjeta ${f}` });
      }
    } else if (p.repartidorId) {
      // En efectivo el repartidor cobra el total: con cupón de PaPedir o saldo del cliente recibió menos (se le abona);
      // con deuda del cliente recibió de más (la debe).
      if (p.descuento > 0 && p.descuentoAbsorbe === 'plataforma') {
        filas.push({ usuarioId: p.repartidorId, pedidoId: p.id, tipo: 'descuento_plataforma', monto: p.descuento, descripcion: `Cupón de PaPedir en el pedido ${f}` });
      }
      filas.push({ usuarioId: p.repartidorId, pedidoId: p.id, tipo: 'saldo_cliente', monto: p.saldoAplicado, descripcion: `Saldo de PaPedir que usó el cliente en ${f}` });
      filas.push({ usuarioId: p.repartidorId, pedidoId: p.id, tipo: 'deuda_cobrada', monto: -p.deudaCobrada, descripcion: `Adeudo del cliente que cobraste en ${f}` });
    }
    await this.abonar(m, filas);
  }

  /**
   * El pedido no se entregó: se deshace lo que reservó de la cartera al crearse. El saldo usado vuelve
   * a favor del cliente y el adeudo que se iba a cobrar vuelve a quedar pendiente.
   */
  async devolverSaldo(m: EntityManager, p: Pedido) {
    if (!p.clienteId || (!p.saldoAplicado && !p.deudaCobrada)) return;
    const f = folio('R', p.folioNum);
    await this.abonar(m, [{
      usuarioId: p.clienteId, pedidoId: p.id, tipo: 'reverso_saldo', monto: p.saldoAplicado - p.deudaCobrada,
      descripcion: p.saldoAplicado ? `Saldo devuelto: el pedido ${f} no se entregó` : `Adeudo pendiente otra vez: el pedido ${f} no se entregó`,
    }]);
  }

  async saldo(usuarioId: string, m?: EntityManager) {
    const [{ s }] = await (m ?? this.movimientos.manager).query(`SELECT coalesce(sum(monto), 0)::float8 AS s FROM movimientos WHERE usuario_id = $1`, [usuarioId]);
    return redondear(s);
  }

  async cargoCancelacion() {
    return (await this.config.get('cartera')).cargoCancelacion;
  }

  async limiteDeuda(rol: Usuario['rol']) {
    const c = await this.config.get('cartera');
    return rol === 'tienda' ? c.limiteDeudaTienda : rol === 'repartidor' ? c.limiteDeudaRepartidor : rol === 'cliente' ? c.limiteDeudaCliente : null;
  }

  /** Repartidor que se conecta o toma pedidos, tienda que abre o acepta: con demasiada deuda, no. */
  async exigirDeudaPermitida(u: Pick<Usuario, 'id' | 'rol'>, accion: string) {
    const limite = await this.limiteDeuda(u.rol);
    if (limite == null) return;
    const saldo = await this.saldo(u.id);
    if (saldo < -limite) {
      throw conflicto('DEUDA_EXCEDIDA', `Debes $${-saldo} a PaPedir y el límite es $${limite}. Liquida tu adeudo con soporte para ${accion}`);
    }
  }

  async estadoDeCuenta(usuarioId: string, rol: Usuario['rol'], q: PaginaDto) {
    const [filas, total] = await this.movimientos.findAndCount({
      where: { usuarioId }, order: { creadoEn: 'DESC' }, skip: (q.page - 1) * q.limit, take: q.limit,
    });
    const saldo = await this.saldo(usuarioId);
    const limite = await this.limiteDeuda(rol);
    return {
      saldo,
      // Para la app: "Tienes $X a favor" o "Debes $X".
      estado: saldo > 0 ? 'a_favor' : saldo < 0 ? 'debe' : 'en_cero',
      limiteDeuda: limite,
      bloqueado: limite != null && saldo < -limite,
      movimientos: pagina(filas.map(vistaMovimiento), total, q),
    };
  }
}
