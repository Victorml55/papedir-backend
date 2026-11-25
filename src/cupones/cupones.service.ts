import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, IsNull, Repository } from 'typeorm';
import { conflicto } from '../common/errores';
import { redondear } from '../common/util';
import { Cupon, Pedido, Tienda } from '../database/entities';

const NO_CUENTAN = ['cancelado', 'rechazado'];

export const vistaCupon = (c: Cupon) => ({
  id: c.id, codigo: c.codigo, descripcion: c.descripcion, tipo: c.tipo, valor: c.valor, maximoDescuento: c.maximoDescuento,
  minimoCompra: c.minimoCompra, tiendaId: c.tiendaId, inicio: c.inicio, fin: c.fin, usosMaximos: c.usosMaximos,
  usosPorCliente: c.usosPorCliente, soloPrimerPedido: c.soloPrimerPedido, activo: c.activo, creadoEn: c.creadoEn,
});

/**
 * Validación y cálculo de cupones.
 * - Cupón de tienda (tiendaId): el descuento lo absorbe la tienda (el repartidor le paga menos).
 * - Cupón de plataforma (sin tiendaId): lo absorbe PaPedir y se le abona al repartidor en su saldo.
 */
@Injectable()
export class CuponesService {
  constructor(@InjectRepository(Cupon) private readonly cupones: Repository<Cupon>) {}

  /**
   * Devuelve el descuento que aplica. Con `m` (dentro de la transacción que crea el pedido)
   * bloquea el cupón para que dos pedidos simultáneos no rebasen sus usos.
   */
  async aplicar(codigo: string, clienteId: string, tienda: Tienda, subtotal: number, costoEnvio: number, m?: EntityManager) {
    const repo = m ? m.getRepository(Cupon) : this.cupones;
    const limpio = codigo.trim().toUpperCase();
    const c = m
      ? await repo.findOne({ where: { codigo: limpio }, lock: { mode: 'pessimistic_write' } })
      : await repo.findOneBy({ codigo: limpio });
    const no = (msg: string) => conflicto('CUPON_INVALIDO', msg);
    const ahora = new Date();
    if (!c || !c.activo) throw no('Ese cupón no existe o ya no está activo');
    if (c.inicio && c.inicio > ahora) throw no('Ese cupón todavía no está vigente');
    if (c.fin && c.fin < ahora) throw no('Ese cupón ya venció');
    if (c.tiendaId && c.tiendaId !== tienda.id) throw no('Ese cupón es de otra tienda');
    if (subtotal < c.minimoCompra) throw no(`Ese cupón requiere una compra mínima de $${c.minimoCompra}`);

    const pedidos = (m ?? this.cupones.manager).getRepository(Pedido);
    const vigentes = { cuponId: c.id };
    if (c.usosMaximos != null) {
      const usados = await pedidos.createQueryBuilder('p').where({ ...vigentes }).andWhere('p.estado NOT IN (:...no)', { no: NO_CUENTAN }).getCount();
      if (usados >= c.usosMaximos) throw no('Ese cupón ya se agotó');
    }
    const mios = await pedidos.createQueryBuilder('p').where({ ...vigentes, clienteId: clienteId }).andWhere('p.estado NOT IN (:...no)', { no: NO_CUENTAN }).getCount();
    if (mios >= c.usosPorCliente) throw no('Ya usaste este cupón');
    if (c.soloPrimerPedido && (await pedidos.existsBy({ clienteId, estado: In(['entregado']) }))) {
      throw no('Ese cupón es solo para tu primer pedido');
    }

    let descuento = 0;
    if (c.tipo === 'porcentaje') descuento = (subtotal * c.valor) / 100;
    if (c.tipo === 'monto') descuento = c.valor;
    if (c.tipo === 'envio_gratis') descuento = costoEnvio;
    if (c.maximoDescuento != null) descuento = Math.min(descuento, c.maximoDescuento);
    // Nunca más que lo que cubre: productos (o envío, si es envío gratis).
    descuento = redondear(Math.min(descuento, c.tipo === 'envio_gratis' ? costoEnvio : subtotal));
    return { cupon: c, descuento, absorbe: (c.tiendaId ? 'tienda' : 'plataforma') as 'tienda' | 'plataforma' };
  }

  /**
   * Cupones que un cliente puede ver en una tienda (GET /tiendas/{id}/cupones):
   * los activos y vigentes de esa tienda y los de la plataforma, sin los agotados.
   * No revela usos ni datos internos; la validación final sigue en `aplicar`.
   */
  async disponibles(tiendaId: string) {
    const ahora = new Date();
    const lista = await this.cupones.find({
      where: [
        { tiendaId, activo: true },
        { tiendaId: IsNull(), activo: true },
      ],
      order: { creadoEn: 'DESC' },
    });
    const pedidos = this.cupones.manager.getRepository(Pedido);
    const vigentes: Cupon[] = [];
    for (const c of lista) {
      if (c.inicio && c.inicio > ahora) continue;
      if (c.fin && c.fin < ahora) continue;
      if (c.usosMaximos != null) {
        const usados = await pedidos
          .createQueryBuilder('p')
          .where({ cuponId: c.id })
          .andWhere('p.estado NOT IN (:...no)', { no: NO_CUENTAN })
          .getCount();
        if (usados >= c.usosMaximos) continue;
      }
      vigentes.push(c);
    }
    return vigentes.map((c) => ({
      codigo: c.codigo, descripcion: c.descripcion, tipo: c.tipo, valor: c.valor, maximoDescuento: c.maximoDescuento,
      minimoCompra: c.minimoCompra, fin: c.fin, soloPrimerPedido: c.soloPrimerPedido, deLaTienda: c.tiendaId != null,
    }));
  }
}
