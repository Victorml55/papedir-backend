/**
 * Historia de demostración para el seed: pedidos de los últimos 30 días, pagos con tarjeta, cupones,
 * zonas, planes, tickets, reseñas, documentos y liquidaciones.
 *
 * Todo pasa por la API real (HTTP local dentro del mismo proceso), así los saldos, movimientos,
 * comisiones y bitácoras salen igual que en producción. Stripe se simula: no se crean cobros.
 * Al final las fechas se recorren hacia atrás para que métricas y finanzas tengan historia.
 */
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PagosService } from '../nucleo/pagos.service';

type Punto = { lat: number; lng: number };
type Cuenta = { email: string; token?: string };
type Peticion = { metodo: string; ruta: string; quien?: Cuenta | string; cuerpo?: unknown; app?: string };

const PASSWORD = 'PaPedir123!';

/** Generador pseudoaleatorio con semilla fija: el seed siempre produce los mismos datos. */
function azar(semilla = 20261119) {
  let s = semilla;
  const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  return {
    r,
    entero: (min: number, max: number) => min + Math.floor(r() * (max - min + 1)),
    uno: <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)],
  };
}

export async function sembrarDemo(app: INestApplication, ds: DataSource) {
  const servidor = app.getHttpServer();
  const base = `http://127.0.0.1:${servidor.address().port}/api/v1`;
  const rnd = azar();
  const tokens = new Map<string, string>();

  simularStripe(app);

  const APPS: Record<string, string> = { cliente: 'cliente', tienda: 'tienda', repartidor: 'repartidor', soporte: 'web', admin: 'web' };
  async function token(email: string) {
    if (tokens.has(email)) return tokens.get(email)!;
    const [{ rol }] = await ds.query('SELECT rol FROM usuarios WHERE email = $1', [email]);
    const r = await llamar({ metodo: 'POST', ruta: '/auth/login', cuerpo: { email, password: PASSWORD, app: APPS[rol] } });
    tokens.set(email, r.accessToken);
    return r.accessToken as string;
  }

  async function llamar({ metodo, ruta, quien, cuerpo }: Peticion, opcional = false): Promise<any> {
    const email = typeof quien === 'string' ? quien : quien?.email;
    const t = email ? await token(email) : undefined;
    const res = await fetch(base + ruta, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const error = `${metodo} ${ruta} → ${res.status} ${json?.error ?? ''} ${json?.message ?? ''}`;
      if (opcional) {
        if (!/CUPON/.test(error)) console.warn(`  (omitido) ${error}`);
        return null;
      }
      throw new Error(error);
    }
    return json;
  }
  const get = (ruta: string, quien: string) => llamar({ metodo: 'GET', ruta, quien });
  const post = (ruta: string, quien: string, cuerpo: unknown = {}, opcional = false) => llamar({ metodo: 'POST', ruta, quien, cuerpo }, opcional);

  const ADMIN = 'admin@papedir.test';
  const SOPORTE = 'soporte@papedir.test';
  const REPS = ['repartidor@papedir.test', 'repartidor2@papedir.test'];

  // ───────────── Ajustes del negocio
  await post('/admin/zonas', ADMIN, {
    nombre: 'Celaya', recargo: 0, activa: true,
    puntos: [{ lat: 20.575, lng: -100.875 }, { lat: 20.575, lng: -100.755 }, { lat: 20.47, lng: -100.755 }, { lat: 20.47, lng: -100.875 }],
  });
  await post('/admin/zonas', ADMIN, {
    nombre: 'Rincón de Tamayo', recargo: 15, activa: false,
    puntos: [{ lat: 20.445, lng: -100.775 }, { lat: 20.445, lng: -100.735 }, { lat: 20.415, lng: -100.735 }, { lat: 20.415, lng: -100.775 }],
  });
  const cupon = (c: Record<string, unknown>) => ({ minimoCompra: 0, usosPorCliente: 1, soloPrimerPedido: false, activo: true, ...c });
  await post('/admin/cupones', ADMIN, cupon({ codigo: 'BIENVENIDA', tipo: 'monto', valor: 30, minimoCompra: 100, soloPrimerPedido: true, descripcion: '$30 de regalo en tu primer pedido' }));
  await post('/admin/cupones', ADMIN, cupon({ codigo: 'ENVIOGRATIS', tipo: 'envio_gratis', valor: 0, minimoCompra: 150, usosPorCliente: 3, descripcion: 'Envío gratis en compras desde $150' }));
  await post('/admin/cupones', ADMIN, cupon({ codigo: 'BUENFIN', tipo: 'porcentaje', valor: 15, maximoDescuento: 60, usosPorCliente: 2, activo: false, descripcion: 'Buen Fin: 15% de descuento' }));
  await post('/tiendas/mia/cupones', 'tienda@papedir.test', cupon({ codigo: 'TACOS10', tipo: 'porcentaje', valor: 10, maximoDescuento: 40, usosPorCliente: 5, descripcion: '10% en Tacos Don Pepe' }));

  // Planes: Tacos Don Pepe en Premium y Abarrotes en Pro (pago simulado).
  for (const [email, plan] of [['tienda@papedir.test', 'premium'], ['abarrotes@papedir.test', 'pro']] as const) {
    const r = await post('/tiendas/mia/plan', email, { plan });
    pagos.marcarPagado(r.paymentIntentId);
    await post('/tiendas/mia/plan/confirmar', email, { paymentIntentId: r.paymentIntentId });
  }

  // ───────────── Catálogo que usan los pedidos
  const clientes: { email: string; direcciones: { id: string; ubicacion: Punto }[] }[] = [];
  for (const { email } of await ds.query(`SELECT email FROM usuarios WHERE rol = 'cliente' AND estado = 'activo' ORDER BY creado_en`)) {
    const direcciones = (await get('/direcciones', email)).map((d: any) => ({ id: d.id, ubicacion: d.ubicacion }));
    if (direcciones.length) clientes.push({ email, direcciones });
  }
  const tiendasDb: { id: string; email: string; lat: number; lng: number; nombre: string }[] = await ds.query(
    `SELECT t.id, u.email, t.lat, t.lng, t.nombre FROM tiendas t JOIN usuarios u ON u.id = t.owner_id WHERE u.estado = 'activo' ORDER BY t.creado_en`,
  );
  const menus = new Map<string, { id: string; precio: number; opciones?: string[] }[]>();
  for (const t of tiendasDb) {
    const menu = await get(`/tiendas/${t.id}/menu`, clientes[0].email);
    const productos = (menu.categorias ?? menu).flatMap((c: any) => c.productos);
    menus.set(
      t.id,
      productos
        .filter((p: any) => !p.agotado)
        .map((p: any) => {
          const obligatorios = (p.grupos ?? []).filter((g: any) => g.minimo > 0);
          return { id: p.id, precio: p.precio, opciones: obligatorios.length ? obligatorios.map((g: any) => g.opciones[0].id) : undefined };
        }),
    );
  }
  const carrito = (tiendaId: string) => {
    const menu = menus.get(tiendaId)!;
    const n = rnd.entero(1, 3);
    const elegidos = new Map<string, { productoId: string; cantidad: number; opciones?: string[] }>();
    for (let i = 0; i < n; i++) {
      const p = rnd.uno(menu);
      elegidos.set(p.id, { productoId: p.id, cantidad: rnd.entero(1, 3), ...(p.opciones ? { opciones: p.opciones } : {}) });
    }
    // Arriba del pedido mínimo, con algo de margen.
    while ([...elegidos.values()].reduce((t, i) => t + menu.find((p) => p.id === i.productoId)!.precio * i.cantidad, 0) < 90) {
      const p = rnd.uno(menu);
      const actual = elegidos.get(p.id);
      elegidos.set(p.id, { productoId: p.id, cantidad: (actual?.cantidad ?? 0) + 1, ...(p.opciones ? { opciones: p.opciones } : {}) });
    }
    return [...elegidos.values()];
  };

  // ───────────── Flujos
  const tiendaDe = (id: string) => tiendasDb.find((t) => t.id === id)!;
  const historial: { id: string; diasAtras: number; hora: number }[] = [];

  async function crearPedido(o: { cliente: (typeof clientes)[number]; tiendaId: string; tarjeta?: boolean; cupon?: string; propina?: number; notas?: string; programadoPara?: string }) {
    const direccion = rnd.uno(o.cliente.direcciones);
    const cuerpo: any = {
      tiendaId: o.tiendaId, direccionId: direccion.id, items: carrito(o.tiendaId),
      ...(o.cupon ? { cupon: o.cupon } : {}), ...(o.propina ? { propina: o.propina } : {}), ...(o.notas ? { notas: o.notas } : {}),
      ...(o.programadoPara ? { programadoPara: o.programadoPara } : {}),
    };
    if (o.tarjeta) {
      const intento = await post('/pagos/intento', o.cliente.email, cuerpo, !!o.cupon);
      if (!intento) return crearPedido({ ...o, cupon: undefined });
      pagos.marcarPagado(intento.paymentIntentId);
      Object.assign(cuerpo, { metodoPago: 'tarjeta', paymentIntentId: intento.paymentIntentId });
    }
    const p = await post('/pedidos', o.cliente.email, cuerpo, !!o.cupon);
    // Si el cupón ya no aplica (p. ej. ya no es su primer pedido), se pide sin cupón.
    if (!p && o.cupon) return crearPedido({ ...o, cupon: undefined });
    return { ...p, destinoUbicacion: direccion.ubicacion };
  }

  const prepararTienda = async (p: any) => {
    const t = tiendaDe(p.tienda.id);
    await post(`/pedidos/${p.id}/aceptar`, t.email);
    await post(`/pedidos/${p.id}/listo`, t.email);
  };

  async function repartir(p: any, rep: string, hasta: 'asignado' | 'en_camino' | 'entregado' = 'entregado') {
    const t = tiendaDe(p.tienda.id);
    const tienda = { lat: Number(t.lat), lng: Number(t.lng) };
    await llamar({ metodo: 'PUT', ruta: '/repartidor/ubicacion', quien: rep, cuerpo: tienda });
    await llamar({ metodo: 'PATCH', ruta: '/repartidor/disponibilidad', quien: rep, cuerpo: { disponible: true } });
    await post(`/repartidor/pedidos/${p.id}/tomar`, rep);
    if (hasta === 'asignado') return;
    await post(`/repartidor/pedidos/${p.id}/llegada-tienda`, rep, { ubicacion: tienda });
    await post(`/repartidor/pedidos/${p.id}/salida-tienda`, rep, { ubicacion: tienda });
    if (hasta === 'en_camino') return;
    await post(`/repartidor/pedidos/${p.id}/llegada-cliente`, rep, { ubicacion: p.destinoUbicacion });
    await post(`/repartidor/pedidos/${p.id}/entregado`, rep, { ubicacion: p.destinoUbicacion, codigoEntrega: p.codigoEntrega });
  }

  const COMENTARIOS = [
    'Llegó caliente y rápido', 'Muy amable el repartidor', 'Todo completo, gracias', 'Tardó un poco pero bien',
    'Excelente servicio', null, null, 'El empaque venía un poco golpeado', 'Súper recomendable',
  ];

  // Pedidos entregados en los últimos 30 días.
  for (let i = 0; i < 34; i++) {
    const cliente = clientes[i % clientes.length];
    const t = rnd.entero(0, tiendasDb.length - 1);
    const tienda = tiendasDb[t];
    // Tarjeta solo en farmacia y ferretería, y la entrega Carlos: así Finanzas muestra cuentas
    // que le deben a PaPedir (efectivo) y cuentas a las que PaPedir les debe (tarjeta).
    const tarjeta = t >= 2 && rnd.r() < 0.6;
    const p = await crearPedido({
      cliente, tiendaId: tienda.id,
      tarjeta,
      cupon: i < clientes.length ? 'BIENVENIDA' : tienda.email === 'tienda@papedir.test' && rnd.r() < 0.4 ? 'TACOS10' : rnd.r() < 0.12 ? 'ENVIOGRATIS' : undefined,
      propina: rnd.r() < 0.45 ? rnd.uno([10, 15, 20, 30]) : undefined,
    });
    await prepararTienda(p);
    await repartir(p, tarjeta ? REPS[0] : REPS[i % 2]);
    if (rnd.r() < 0.75) {
      const estrellas = rnd.r() < 0.8 ? 5 : rnd.entero(3, 4);
      const comentario = rnd.uno(COMENTARIOS);
      await post(`/pedidos/${p.id}/calificar`, cliente.email, { tienda: estrellas, repartidor: rnd.r() < 0.85 ? 5 : 4, ...(comentario ? { comentario } : {}) });
      if (comentario && rnd.r() < 0.4) await post(`/pedidos/${p.id}/calificacion/respuesta`, tienda.email, { texto: '¡Gracias por tu preferencia! Te esperamos pronto.' }, true);
    }
    historial.push({ id: p.id, diasAtras: 29 - Math.floor((i * 29) / 34), hora: rnd.entero(12, 21) });
  }

  // Cancelados y rechazados, con motivo del catálogo.
  const cancelados: [string, string, string?][] = [
    ['cliente', 'cambio_de_opinion'], ['cliente', 'tarda_demasiado'], ['cliente', 'direccion_incorrecta'],
    ['tienda', 'sin_ingredientes'], ['tienda', 'muy_ocupado'], ['tienda', 'cerrando'],
    ['soporte', 'cliente_no_localizable', 'Nadie abre y el teléfono manda a buzón'], ['soporte', 'incidente_en_ruta', 'Se ponchó la llanta de la moto'],
  ];
  for (const [j, [quien, codigo, motivo]] of cancelados.entries()) {
    const cliente = clientes[(j + 2) % clientes.length];
    const tienda = tiendasDb[j % tiendasDb.length];
    const p = await crearPedido({ cliente, tiendaId: tienda.id, tarjeta: j === 1 || j === 4 });
    if (quien === 'cliente') await post(`/pedidos/${p.id}/cancelar`, cliente.email, { codigo });
    else if (quien === 'tienda') await post(`/pedidos/${p.id}/rechazar`, tienda.email, { codigo });
    else {
      await prepararTienda(p);
      await repartir(p, REPS[j % 2], 'en_camino');
      await post(`/soporte/pedidos/${p.id}/cancelar`, SOPORTE, { codigo, motivo });
    }
    historial.push({ id: p.id, diasAtras: rnd.entero(1, 27), hora: rnd.entero(12, 22) });
  }

  // Pedido de dos tiendas en un solo carrito, ya entregado.
  const [ana, ...otros] = clientes;
  const grupo = await post('/pedidos/grupo', otros[0].email, {
    direccionId: otros[0].direcciones[0].id,
    pedidos: [
      { tiendaId: tiendasDb[1].id, items: carrito(tiendasDb[1].id) },
      { tiendaId: tiendasDb[2].id, items: carrito(tiendasDb[2].id) },
    ],
  });
  for (const g of grupo.pedidos ?? grupo) {
    const p = { ...g, destinoUbicacion: otros[0].direcciones[0].ubicacion };
    await prepararTienda(p);
    await repartir(p, REPS[0]);
    historial.push({ id: p.id, diasAtras: 3, hora: 14 });
  }

  // Tickets de soporte en distintos estados.
  const entregados = historial.slice(0, 34);
  const ticket = async (pedidoId: string, cliente: string, asunto: string, descripcion: string, respuesta?: string, estado?: string) => {
    const t = await post('/tickets', cliente, { pedidoId, asunto, descripcion });
    if (respuesta) {
      await llamar({ metodo: 'PATCH', ruta: `/soporte/tickets/${t.id}`, quien: SOPORTE, cuerpo: { estado: 'en_atencion' } });
      await post(`/tickets/${t.id}/mensajes`, SOPORTE, { texto: respuesta });
    }
    if (estado) await llamar({ metodo: 'PATCH', ruta: `/soporte/tickets/${t.id}`, quien: SOPORTE, cuerpo: { estado } });
  };
  const duenoDe = async (pedidoId: string) => (await ds.query('SELECT u.email FROM pedidos p JOIN usuarios u ON u.id = p.cliente_id WHERE p.id = $1', [pedidoId]))[0].email;
  await ticket(entregados[30].id, await duenoDe(entregados[30].id), 'Me faltó un refresco', 'Pedí dos refrescos y solo llegó uno.');
  await ticket(entregados[31].id, await duenoDe(entregados[31].id), 'El repartidor no traía cambio', 'Pagué con billete de $500 y no tenía cambio; esperé 10 minutos.',
    'Hola, una disculpa. Ya hablamos con el repartidor para que siempre lleve cambio.');
  await ticket(entregados[20].id, await duenoDe(entregados[20].id), 'Comida fría', 'Los tacos llegaron fríos.',
    'Lamentamos lo ocurrido. Le pasamos el comentario a la tienda y te dejamos un cupón de envío gratis (ENVIOGRATIS).', 'resuelto');
  await ticket(entregados[10].id, await duenoDe(entregados[10].id), '¿Puedo cambiar la dirección?', 'Me equivoqué de número de casa.',
    'Listo, ya quedó corregida. ¡Gracias!', 'cerrado');

  // Saldos: PaPedir ya cobró una parte de la comisión a dos cuentas.
  const saldos = (await get('/admin/saldos', ADMIN)).usuarios ?? [];
  // Un cobro (alguien que le debía a PaPedir) y un pago (alguien a quien PaPedir le debía).
  const elegidas = [saldos.find((x: any) => x.saldo > 0), saldos.find((x: any) => x.saldo < 0)].filter(Boolean);
  for (const s of elegidas) {
    const monto = Math.round(Math.abs(s.saldo) * 0.6 * 100) / 100;
    if (monto > 0) {
      await post('/admin/liquidaciones', ADMIN, {
        usuarioId: s.id, sentido: s.saldo > 0 ? 'cobro' : 'pago', monto,
        metodo: 'transferencia', referencia: `SPEI ${rnd.entero(100000, 999999)}`, nota: 'Corte semanal',
      }, true);
    }
  }

  // Favoritos.
  for (const [k, c] of clientes.entries()) {
    await llamar({ metodo: 'PUT', ruta: `/favoritos/${tiendasDb[k % tiendasDb.length].id}`, quien: c.email });
    await llamar({ metodo: 'PUT', ruta: `/favoritos/${tiendasDb[0].id}`, quien: c.email }, true);
  }

  // Documentos: los dos repartidores con INE y licencia aprobadas, y un repartidor nuevo esperando revisión.
  const subir = async (email: string, tipo: string) => {
    const form = new FormData();
    form.append('tipo', tipo);
    form.append('archivo', new Blob([IMAGEN], { type: 'image/png' }), `${tipo}.png`);
    const res = await fetch(`${base}/documentos`, { method: 'POST', headers: { authorization: `Bearer ${await token(email)}` }, body: form });
    if (!res.ok) {
      console.warn(`  (omitido) documento ${tipo} de ${email}: ${res.status} ${(await res.text()).slice(0, 120)}`);
      return null;
    }
    return res.json();
  };
  for (const rep of REPS) {
    for (const tipo of ['ine', 'licencia']) {
      const d = await subir(rep, tipo);
      if (d) await post(`/soporte/documentos/${d.id}/revisar`, SOPORTE, { aprobado: true });
    }
  }
  for (const tipo of ['ine', 'licencia', 'tarjeta_circulacion']) await subir('repartidor.nuevo@papedir.test', tipo);
  await subir('tienda.pendiente@papedir.test', 'ine');

  // Una cuenta baneada (y su historial).
  await post(`/soporte/usuarios/${(await ds.query(`SELECT id FROM usuarios WHERE email = 'cliente.baneado@papedir.test'`))[0].id}/banear`, SOPORTE, {
    motivo: 'Tres pedidos seguidos con dirección falsa',
  });

  // ───────────── Fechas: se recorren hacia atrás para que haya historia.
  for (const h of historial) {
    const desfase = `${h.diasAtras} days`;
    const [{ creado_en }] = await ds.query('SELECT creado_en FROM pedidos WHERE id = $1', [h.id]);
    // Se fija la hora del día además del día, para que no queden todos a la hora en que corrió el seed.
    const ajuste = `${desfase} ${new Date(creado_en).getHours() - h.hora} hours`;
    await ds.query(
      `UPDATE pedidos SET creado_en = creado_en - $2::interval, actualizado_en = actualizado_en - $2::interval,
         listo_en = listo_en - $2::interval, entregado_en = entregado_en - $2::interval, enviado_a_tienda_en = enviado_a_tienda_en - $2::interval
       WHERE id = $1`, [h.id, ajuste]);
    for (const tabla of ['eventos_pedido', 'mensajes_pedido', 'movimientos', 'calificaciones']) {
      await ds.query(`UPDATE ${tabla} SET creado_en = creado_en - $2::interval WHERE pedido_id = $1`, [h.id, ajuste]);
    }
    await ds.query(`UPDATE calificaciones SET respondido_en = respondido_en - $2::interval WHERE pedido_id = $1`, [h.id, ajuste]);
    await ds.query(`UPDATE viajes SET creado_en = creado_en - $2::interval, finalizado_en = finalizado_en - $2::interval
      WHERE id = (SELECT viaje_id FROM pedidos WHERE id = $1)`, [h.id, ajuste]);
    await ds.query(`UPDATE mensajes SET creado_en = creado_en - $2::interval WHERE ticket_id IN (SELECT id FROM tickets WHERE pedido_id = $1)`, [h.id, ajuste]);
    await ds.query(`UPDATE tickets SET creado_en = creado_en - $2::interval, actualizado_en = actualizado_en - $2::interval WHERE pedido_id = $1`, [h.id, ajuste]).catch(() =>
      ds.query(`UPDATE tickets SET creado_en = creado_en - $2::interval WHERE pedido_id = $1`, [h.id, ajuste]));
  }
  await ds.query(`UPDATE usuarios SET creado_en = creado_en - interval '45 days' WHERE rol <> 'repartidor' OR email IN ('repartidor@papedir.test', 'repartidor2@papedir.test')`);
  await ds.query(`UPDATE tiendas SET creado_en = creado_en - interval '45 days'`);
  await ds.query(`UPDATE usuarios SET creado_en = now() - interval '1 day' WHERE estado = 'pendiente_aprobacion'`);

  // ───────────── Pedidos en curso para la demo en vivo (con la fecha de hoy).
  for (const rep of REPS) await llamar({ metodo: 'PATCH', ruta: '/repartidor/disponibilidad', quien: rep, cuerpo: { disponible: false } }, true);

  const nuevo = await crearPedido({ cliente: ana, tiendaId: tiendasDb[0].id, propina: 20, notas: 'Sin cebolla, por favor' });
  void nuevo; // queda "pendiente": la tienda debe aceptarlo

  const enCocina = await crearPedido({ cliente: otros[1], tiendaId: tiendasDb[1].id });
  await post(`/pedidos/${enCocina.id}/aceptar`, tiendaDe(enCocina.tienda.id).email);

  const enCamino = await crearPedido({ cliente: ana, tiendaId: tiendasDb[0].id, tarjeta: true, propina: 15, notas: 'Tocar en el portón negro' });
  await prepararTienda(enCamino);
  await repartir(enCamino, REPS[0], 'en_camino');
  await post(`/pedidos/${enCamino.id}/mensajes`, ana.email, { texto: '¿Ya vienes? Toca en el portón negro por favor' });
  await post(`/pedidos/${enCamino.id}/mensajes`, REPS[0], { texto: 'Sí, ya salí de la tienda. Llego en unos 10 minutos.' });

  const manana = new Date(Date.now() + 26 * 3600 * 1000);
  manana.setMinutes(0, 0, 0);
  await crearPedido({ cliente: otros[2], tiendaId: tiendasDb[1].id, programadoPara: manana.toISOString(), notas: 'Para la comida de mañana' });

  // Tickets recientes sin atender (llegan a la bandeja de soporte).
  await ticket(enCamino.id, ana.email, 'Cobro con tarjeta', 'Me llegó la notificación del banco dos veces, ¿se cobró doble?');
}

// ───────────── Stripe simulado
const intentos = new Map<string, any>();
const pagos = {
  marcarPagado(id: string) {
    const i = intentos.get(id);
    if (i) i.estado = i.metadata?.plan ? 'succeeded' : 'requires_capture';
  },
};
let consecutivo = 0;

function simularStripe(app: INestApplication) {
  const p = app.get(PagosService) as any;
  Object.defineProperty(p, 'publicable', { get: () => 'pk_test_semilla' });
  p.crearIntento = async (pesos: number, _d: string, metadata: Record<string, string>) => {
    const id = `pi_semilla_${Date.now()}_${++consecutivo}`;
    const i = { id, estado: 'requires_payment_method', centavos: Math.round(pesos * 100), moneda: 'mxn', metadata, clientSecret: `${id}_secret_semilla` };
    intentos.set(id, i);
    return i;
  };
  p.obtener = async (id: string) => {
    if (!intentos.has(id)) throw Object.assign(new Error('Intento no encontrado'), { getStatus: () => 400 });
    return intentos.get(id);
  };
  p.capturar = async (id: string) => Object.assign(intentos.get(id), { estado: 'succeeded' });
  p.liberar = async (id: string) => void Object.assign(intentos.get(id) ?? {}, { estado: 'canceled' });
  p.reembolsar = async () => true;
}

/** PNG de 1×1 para los documentos de ejemplo. */
const IMAGEN = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
