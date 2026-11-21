/**
 * Pruebas de punta a punta contra una base PostgreSQL + PostGIS real.
 *   TEST_DATABASE_URL=postgresql://papedir:papedir@localhost:5432/papedir_test npm run test:e2e
 * OJO: borra y recrea el esquema de esa base. Usa una base solo para pruebas.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://papedir:papedir@localhost:5432/papedir_test';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET = 'secreto-de-pruebas';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configurar } from '../src/main';
import { CorreoService } from '../src/nucleo/correo.service';
import { FirebaseService, IdentidadFirebase } from '../src/nucleo/firebase.service';
import { Intento, PagosService } from '../src/nucleo/pagos.service';
import { RutasService } from '../src/nucleo/rutas.service';
import { TareasService } from '../src/pedidos/tareas.service';

const PASS = 'PaPedir123!';
const TIENDA = { lat: 20.5222, lng: -100.8123 };
const CERCA_DE_TIENDA = { lat: 20.5223, lng: -100.8124 }; // ~15 m
const CASA = { lat: 20.5522, lng: -100.8123 }; // ~3.3 km al norte → 4.3 km con el factor de calles
const mover = (p: { lat: number; lng: number }, dLat: number, dLng = 0) => ({ lat: p.lat + dLat, lng: p.lng + dLng });

describe('PaPedir API', () => {
  let app: INestApplication;
  let http: any;
  let ds: DataSource;
  let url: string;
  const tok: Record<string, string> = {};
  const id: Record<string, string> = {};

  const api = (metodo: 'get' | 'post' | 'patch' | 'put' | 'delete', ruta: string, quien?: string, cuerpo?: any) => {
    const r = request(http)[metodo](`/api/v1${ruta}`);
    if (quien) r.set('Authorization', `Bearer ${tok[quien]}`);
    return cuerpo ? r.send(cuerpo) : r;
  };
  const registrar = async (alias: string, rol: string, extra: any = {}) => {
    const r = await api('post', '/auth/register', undefined, {
      nombre: `Usuario ${alias}`, email: `${alias}@prueba.test`, password: PASS, telefono: '4610000000', rol, aceptoTerminos: true, ...extra,
    }).expect(201);
    tok[alias] = r.body.accessToken;
    id[alias] = r.body.usuario.id;
    return r.body;
  };
  const manual = async (destino: { lat: number; lng: number }, monto = 100) =>
    (await api('post', '/pedidos/manual', 'tienda', {
      destino: { nombre: 'Destinatario', telefono: '4619876543', direccion: 'Calle Falsa 123', ubicacion: destino },
      descripcion: 'Paquete', montoACobrar: monto,
    }).expect(201)).body;

  beforeAll(async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pg.end();

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configurar(app);
    await app.listen(0);
    http = app.getHttpServer();
    url = `http://localhost:${http.address().port}`;
    ds = app.get(DataSource);

    // Soporte y admin no se registran por la API: se crean directo.
    const hash = await bcrypt.hash(PASS, 4);
    for (const rol of ['soporte', 'admin']) {
      await ds.query(`INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES ($1, $2, $3, $4)`, [rol, `${rol}@prueba.test`, hash, rol]);
      const r = await api('post', '/auth/login', undefined, { email: `${rol}@prueba.test`, password: PASS, app: 'web' }).expect(200);
      tok[rol] = r.body.accessToken;
      id[rol] = r.body.usuario.id;
    }
  });

  afterAll(async () => app.close());

  describe('Auth y cuentas', () => {
    it('health responde sin token', () => api('get', '/health').expect(200, { status: 'ok' }));

    it('registra un cliente activo y una tienda pendiente de aprobación', async () => {
      expect((await registrar('cliente', 'cliente')).usuario.estado).toBe('activo');
      const t = await registrar('tienda', 'tienda', {
        tienda: { nombre: 'Tacos Don Pepe', categoria: 'comida', direccion: 'Hidalgo 120', ubicacion: TIENDA },
      });
      expect(t.usuario.estado).toBe('pendiente_aprobacion');
      expect(t.usuario.passwordHash).toBeUndefined();
    });

    it('devuelve los errores de validación con el formato del contrato', async () => {
      const r = await api('post', '/auth/register', undefined, { nombre: '', email: 'no-es-correo', password: '123', rol: 'admin' }).expect(400);
      expect(r.body.error).toBe('VALIDACION');
      expect(r.body.detalles.map((d) => d.campo)).toEqual(expect.arrayContaining(['email', 'password', 'rol']));
    });

    it('exige los datos de la tienda cuando rol = tienda', () =>
      api('post', '/auth/register', undefined, { nombre: 'X', email: 'x@prueba.test', password: PASS, telefono: '4610000000', rol: 'tienda', aceptoTerminos: true }).expect(400));

    it('rechaza correos repetidos y contraseñas incorrectas', async () => {
      const r = await api('post', '/auth/register', undefined, { nombre: 'Otro', email: 'CLIENTE@prueba.test', password: PASS, telefono: '4610000000', rol: 'cliente', aceptoTerminos: true }).expect(409);
      expect(r.body.error).toBe('EMAIL_REGISTRADO');
      await api('post', '/auth/login', undefined, { email: 'cliente@prueba.test', password: 'incorrecta', app: 'cliente' }).expect(401);
    });

    it('no deja entrar a una app que no corresponde al rol', async () => {
      const r = await api('post', '/auth/login', undefined, { email: 'cliente@prueba.test', password: PASS, app: 'repartidor' }).expect(403);
      expect(r.body.error).toBe('APP_INCORRECTA');
    });

    it('rota el refresh token: cada uno sirve una sola vez', async () => {
      const login = await api('post', '/auth/login', undefined, { email: 'cliente@prueba.test', password: PASS, app: 'cliente' }).expect(200);
      const nuevo = await api('post', '/auth/refresh', undefined, { refreshToken: login.body.refreshToken }).expect(200);
      expect(nuevo.body.accessToken).toBeDefined();
      await api('post', '/auth/refresh', undefined, { refreshToken: login.body.refreshToken }).expect(401);
    });

    it('protege las rutas por token y por rol', async () => {
      await api('get', '/auth/me').expect(401);
      await api('get', '/direcciones', 'tienda').expect(403);
      await api('get', '/soporte/usuarios', 'cliente').expect(403);
      await api('get', '/admin/metricas', 'soporte').expect(403);
    });
  });

  describe('Tienda y catálogo', () => {
    it('una tienda sin aprobar no puede abrir ni crear pedidos manuales', async () => {
      expect((await api('patch', '/tiendas/mia', 'tienda', { abierta: true }).expect(409)).body.error).toBe('CUENTA_PENDIENTE');
      await api('post', '/pedidos/cotizar-manual', 'tienda', { ubicacion: CASA, montoACobrar: 10 }).expect(409);
    });

    it('soporte la aprueba y entonces abre', async () => {
      const pendientes = await api('get', '/soporte/usuarios?estado=pendiente_aprobacion&rol=tienda', 'soporte').expect(200);
      expect(pendientes.body.data).toHaveLength(1);
      await api('post', `/soporte/usuarios/${id.tienda}/aprobar`, 'soporte').expect(200);
      await api('post', `/soporte/usuarios/${id.tienda}/aprobar`, 'soporte').expect(409);
      const r = await api('patch', '/tiendas/mia', 'tienda', { abierta: true, tiempoPreparacionMin: 15 }).expect(200);
      expect(r.body).toMatchObject({ abierta: true, tiempoPreparacionMin: 15, ubicacion: TIENDA });
      id.tiendaId = r.body.id;
    });

    it('administra categorías y productos', async () => {
      id.cat = (await api('post', '/tiendas/mia/categorias', 'tienda', { nombre: 'Tacos', orden: 1 }).expect(201)).body.id;
      const vacia = (await api('post', '/tiendas/mia/categorias', 'tienda', { nombre: 'Vacía' }).expect(201)).body.id;
      id.pastor = (await api('post', '/productos', 'tienda', { categoriaId: id.cat, nombre: 'Orden de pastor', precio: 85 }).expect(201)).body.id;
      id.barato = (await api('post', '/productos', 'tienda', { categoriaId: id.cat, nombre: 'Salsa extra', precio: 10 }).expect(201)).body.id;
      id.agotado = (await api('post', '/productos', 'tienda', { categoriaId: id.cat, nombre: 'Gringa', precio: 65 }).expect(201)).body.id;
      await api('patch', `/productos/${id.agotado}`, 'tienda', { disponible: false }).expect(200);
      await api('post', '/productos', 'tienda', { categoriaId: vacia, nombre: 'Sin precio' }).expect(400);

      expect((await api('delete', `/categorias/${id.cat}`, 'tienda').expect(409)).body.error).toBe('CATEGORIA_CON_PRODUCTOS');
      await api('delete', `/categorias/${vacia}`, 'tienda').expect(204);
      expect((await api('get', '/tiendas/mia/categorias', 'tienda')).body).toHaveLength(1);
    });

    it('el cliente la encuentra por cercanía y ve el menú por categorías', async () => {
      const cerca = await api('get', `/tiendas?lat=${CASA.lat}&lng=${CASA.lng}&radioKm=5`, 'cliente').expect(200);
      expect(cerca.body.data[0]).toMatchObject({ nombre: 'Tacos Don Pepe' });
      expect(cerca.body.data[0].distanciaKm).toBeCloseTo(3.32, 1);
      expect((await api('get', `/tiendas?lat=${CASA.lat}&lng=${CASA.lng}&radioKm=1`, 'cliente')).body.data).toHaveLength(0);

      const menu = (await api('get', `/tiendas/${id.tiendaId}/menu`, 'cliente').expect(200)).body;
      expect(menu).toHaveLength(1);
      expect(menu[0].categoria.nombre).toBe('Tacos');
      expect(menu[0].productos).toHaveLength(3);
    });
  });

  describe('Pedido de la app: del carrito a la entrega', () => {
    const carrito = (items: any[]) => ({ tiendaId: id.tiendaId, direccionId: id.casa, items });
    let socketTienda: Socket;
    const recibidos: any[] = [];

    beforeAll(async () => {
      id.casa = (await api('post', '/direcciones', 'cliente', { alias: 'Casa', texto: 'Av. Tecnológico 1500', ubicacion: CASA }).expect(201)).body.id;
      id.lejos = (await api('post', '/direcciones', 'cliente', { alias: 'Lejos', texto: 'Otra ciudad', ubicacion: mover(TIENDA, 0.08) }).expect(201)).body.id;
      socketTienda = io(`${url}/realtime`, { transports: ['websocket'], auth: { token: tok.tienda } });
      socketTienda.onAny((evento, datos) => recibidos.push({ evento, datos }));
      await new Promise<void>((ok) => socketTienda.on('connect', () => ok()));
      await new Promise((ok) => setTimeout(ok, 200)); // el servidor une al socket a sus salas
    });
    afterAll(() => void socketTienda?.close());

    it('cotiza el envío por distancia: $25 hasta 2 km + $7 por km extra', async () => {
      const r = await api('post', '/pedidos/cotizar', 'cliente', carrito([{ productoId: id.pastor, cantidad: 2 }])).expect(200);
      expect(r.body).toMatchObject({ subtotal: 170, costoEnvio: 46, total: 216, metodoPago: 'efectivo' });
      expect(r.body.distanciaKm).toBeCloseTo(4.32, 1);
    });

    it('aplica mínimo, máximo en efectivo, cobertura y productos agotados', async () => {
      const error = async (cuerpo: any) => (await api('post', '/pedidos/cotizar', 'cliente', cuerpo).expect(409)).body.error;
      expect(await error(carrito([{ productoId: id.barato, cantidad: 2 }]))).toBe('PEDIDO_MINIMO');
      expect(await error(carrito([{ productoId: id.pastor, cantidad: 20 }]))).toBe('PEDIDO_MAXIMO_EFECTIVO');
      expect(await error(carrito([{ productoId: id.agotado, cantidad: 1 }]))).toBe('PRODUCTO_AGOTADO');
      expect(await error({ ...carrito([{ productoId: id.pastor, cantidad: 2 }]), direccionId: id.lejos })).toBe('FUERA_DE_COBERTURA');
    });

    it('crea el pedido; la tienda lo recibe en tiempo real y no ve el código de entrega', async () => {
      const r = await api('post', '/pedidos', 'cliente', { ...carrito([{ productoId: id.pastor, cantidad: 2 }]), notas: 'Sin cebolla' }).expect(201);
      expect(r.body).toMatchObject({ estado: 'creado', origen: 'app', subtotal: 170, costoEnvio: 46, total: 216, montoAPagarTienda: 170 });
      expect(r.body.folio).toMatch(/^R-\d{6}$/);
      expect(r.body.codigoEntrega).toMatch(/^\d{4}$/);
      expect(r.body.items[0]).toMatchObject({ nombre: 'Orden de pastor', cantidad: 2, precioUnitario: 85, importe: 170 });
      id.pedido = r.body.id;
      id.codigo = r.body.codigoEntrega;

      await new Promise((ok) => setTimeout(ok, 300));
      const nuevo = recibidos.find((x) => x.evento === 'pedido:nuevo');
      expect(nuevo.datos).toMatchObject({ id: id.pedido, codigoEntrega: null });
      expect((await api('get', `/pedidos/${id.pedido}`, 'tienda').expect(200)).body.codigoEntrega).toBeNull();
    });

    it('el precio queda fijo aunque la tienda lo cambie después', async () => {
      await api('patch', `/productos/${id.pastor}`, 'tienda', { precio: 120 }).expect(200);
      expect((await api('get', `/pedidos/${id.pedido}`, 'cliente')).body.total).toBe(216);
      await api('patch', `/productos/${id.pastor}`, 'tienda', { precio: 85 }).expect(200);
    });

    it('la tienda acepta y marca listo; el cliente sabe cuánto le costaría cancelar', async () => {
      await api('post', `/pedidos/${id.pedido}/listo`, 'tienda').expect(409); // todavía no lo acepta
      await api('post', `/pedidos/${id.pedido}/aceptar`, 'tienda').expect(200);
      // Ya aceptado y en efectivo: podría cancelar, pero pagando la tarifa (la prueba la hace la sección de cartera).
      expect((await api('get', `/pedidos/${id.pedido}`, 'cliente')).body.cancelacion).toEqual({ permitida: true, cargo: 25 });
      expect((await api('post', `/pedidos/${id.pedido}/listo`, 'tienda').expect(200)).body.estado).toBe('listo_para_recoger');
    });

    it('un repartidor sin aprobar no puede conectarse', async () => {
      await registrar('rep1', 'repartidor');
      await registrar('rep2', 'repartidor');
      expect((await api('patch', '/repartidor/disponibilidad', 'rep1', { disponible: true }).expect(409)).body.error).toBe('CUENTA_PENDIENTE');
      for (const r of ['rep1', 'rep2']) {
        await api('post', `/soporte/usuarios/${id[r]}/aprobar`, 'soporte').expect(200);
        await api('put', '/repartidor/ubicacion', r, CERCA_DE_TIENDA).expect(204);
      }
      expect((await api('post', `/repartidor/pedidos/${id.pedido}/tomar`, 'rep1').expect(409)).body.error).toBe('REPARTIDOR_DESCONECTADO');
      for (const r of ['rep1', 'rep2']) await api('patch', '/repartidor/disponibilidad', r, { disponible: true }).expect(200);
    });

    it('ve el pedido en el mapa, sin datos personales del cliente', async () => {
      const r = await api('get', `/repartidor/pedidos-disponibles?lat=${CERCA_DE_TIENDA.lat}&lng=${CERCA_DE_TIENDA.lng}`, 'rep1').expect(200);
      expect(r.body).toHaveLength(1);
      expect(r.body[0]).toMatchObject({ id: id.pedido, costoEnvio: 46, montoAPagarTienda: 170, totalACobrar: 216 });
      expect(JSON.stringify(r.body[0])).not.toContain('4610000000');
      const lejos = await api('get', `/repartidor/pedidos-disponibles?lat=${CASA.lat + 0.05}&lng=${CASA.lng}`, 'rep1').expect(200);
      expect(lejos.body).toHaveLength(0);
    });

    it('si dos repartidores lo toman a la vez, solo uno se lo queda', async () => {
      const [a, b] = await Promise.all(['rep1', 'rep2'].map((r) => api('post', `/repartidor/pedidos/${id.pedido}/tomar`, r)));
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const perdedor = a.status === 409 ? a : b;
      expect(perdedor.body.error).toBe('PEDIDO_YA_TOMADO');
      id.ganador = a.status === 200 ? 'rep1' : 'rep2';
      id.otro = a.status === 200 ? 'rep2' : 'rep1';
      const viaje = (a.status === 200 ? a : b).body;
      expect(viaje).toMatchObject({ estado: 'activo', maxPedidos: 4, efectivoAPagarTiendas: 170, efectivoACobrar: 216, gananciaEnvio: 46 });
      expect(viaje.paradas.map((p) => p.tipo)).toEqual(['tienda', 'domicilio']);
    });

    it('con el pedido asignado la tienda ya no puede cancelar y el otro repartidor no puede marcarlo', async () => {
      await api('post', `/pedidos/${id.pedido}/cancelar`, 'tienda', { motivo: 'x' }).expect(409);
      expect((await api('post', `/pedidos/${id.pedido}/cancelar`, 'cliente', { motivo: 'Ya no' }).expect(409)).body.error).toBe('TRANSICION_INVALIDA');
      expect((await api('get', `/pedidos/${id.pedido}`, 'cliente')).body.cancelacion.permitida).toBe(false);
      await api('post', `/repartidor/pedidos/${id.pedido}/llegada-tienda`, id.otro, { ubicacion: CERCA_DE_TIENDA }).expect(403);
      await api('patch', '/repartidor/disponibilidad', id.ganador, { disponible: false }).expect(409); // viaje activo
    });

    it('el cliente sigue al repartidor en vivo por Socket.IO', async () => {
      const conectar = async (quien: string) => {
        const s = io(`${url}/realtime`, { transports: ['websocket'], auth: { token: tok[quien] } });
        await new Promise<void>((ok) => s.on('connect', () => ok()));
        return s;
      };
      const [sCliente, sRep, sAjeno] = [await conectar('cliente'), await conectar(id.ganador), await conectar(id.otro)];
      expect(await sCliente.emitWithAck('pedido:seguir', { pedidoId: id.pedido })).toEqual({ ok: true });
      expect(await sAjeno.emitWithAck('pedido:seguir', { pedidoId: id.pedido })).toMatchObject({ ok: false });
      expect(await sCliente.emitWithAck('repartidor:ubicacion', CASA)).toMatchObject({ ok: false }); // no es repartidor

      const llegada = new Promise<any>((ok) => sCliente.on('repartidor:ubicacion', ok));
      expect(await sRep.emitWithAck('repartidor:ubicacion', CERCA_DE_TIENDA)).toEqual({ ok: true });
      expect(await llegada).toMatchObject({ pedidoId: id.pedido, ...CERCA_DE_TIENDA });
      expect((await api('get', `/pedidos/${id.pedido}`, 'cliente')).body.repartidor.ubicacion).toEqual(CERCA_DE_TIENDA);

      const sinToken = io(`${url}/realtime`, { transports: ['websocket'], auth: { token: 'falso' } });
      await new Promise<void>((ok) => sinToken.on('disconnect', () => ok()));
      for (const s of [sCliente, sRep, sAjeno, sinToken]) s.close();
    });

    it('la geocerca de 150 m aplica en tienda y domicilio', async () => {
      const marca = (paso: string, ubicacion: any, extra: any = {}) =>
        api('post', `/repartidor/pedidos/${id.pedido}/${paso}`, id.ganador, { ubicacion, ...extra });
      // Sin "ubicacion" (por ejemplo { lat, lng } sueltos) responde 400 con el detalle, no 500.
      const suelta = await api('post', `/repartidor/pedidos/${id.pedido}/llegada-tienda`, id.ganador, CERCA_DE_TIENDA).expect(400);
      expect(suelta.body.error).toBe('VALIDACION');
      expect(JSON.stringify(suelta.body.detalles)).toContain('ubicacion es obligatoria');
      expect((await marca('llegada-tienda', mover(TIENDA, 0.003)).expect(409)).body.error).toBe('FUERA_DE_RANGO');
      await marca('llegada-tienda', CERCA_DE_TIENDA).expect(200);
      await marca('llegada-cliente', CASA).expect(409); // falta salir de la tienda
      await marca('salida-tienda', CERCA_DE_TIENDA).expect(200);
      expect((await marca('llegada-cliente', TIENDA).expect(409)).body.error).toBe('FUERA_DE_RANGO');
      expect((await marca('llegada-cliente', CASA).expect(200)).body.estado).toBe('en_domicilio');
    });

    it('se entrega solo con el código correcto y el viaje se cierra', async () => {
      const entregar = (codigoEntrega?: string) =>
        api('post', `/repartidor/pedidos/${id.pedido}/entregado`, id.ganador, { ubicacion: CASA, codigoEntrega });
      const mal = id.codigo === '0000' ? '1111' : '0000';
      expect((await entregar(mal).expect(409)).body.error).toBe('CODIGO_INCORRECTO');
      expect((await entregar().expect(409)).body.error).toBe('CODIGO_INCORRECTO');
      expect((await entregar(id.codigo).expect(200)).body.estado).toBe('entregado');
      await api('get', '/repartidor/viaje-actual', id.ganador).expect(204);
      expect((await api('get', '/repartidor/historial', id.ganador)).body.meta.total).toBe(1);
    });

    it('la bitácora registra cada paso con quién lo hizo', async () => {
      const eventos = (await api('get', `/pedidos/${id.pedido}/eventos`, 'cliente').expect(200)).body;
      expect(eventos.map((e) => e.tipo)).toEqual(['creado', 'aceptado_tienda', 'listo_para_recoger', 'asignado', 'llegada_tienda', 'salida_tienda', 'llegada_cliente', 'entregado']);
      expect(eventos.at(-1)).toMatchObject({ rol: 'repartidor', ubicacion: CASA });
    });

    it('el cliente califica una sola vez y la tienda actualiza su promedio', async () => {
      await api('post', `/pedidos/${id.pedido}/calificar`, 'cliente', { tienda: 5, repartidor: 4, comentario: 'Rápido' }).expect(201);
      expect((await api('post', `/pedidos/${id.pedido}/calificar`, 'cliente', { tienda: 1, repartidor: 1 }).expect(409)).body.error).toBe('CALIFICACION_INVALIDA');
      expect((await api('get', `/tiendas/${id.tiendaId}`, 'cliente')).body.calificacion).toBe(5);
      expect((await api('get', `/pedidos/${id.pedido}`, 'cliente')).body.calificacion).toMatchObject({ tienda: 5, repartidor: 4 });
    });

    it('la tienda recibió por socket cada cambio de estado', () => {
      const estados = recibidos.filter((x) => x.evento === 'pedido:actualizado' && x.datos.pedidoId === id.pedido).map((x) => x.datos.estado);
      expect(estados).toEqual(['aceptado_tienda', 'listo_para_recoger', 'asignado', 'en_tienda', 'en_camino', 'en_domicilio', 'entregado']);
    });
  });

  describe('Viajes: encadenar hasta 4 pedidos', () => {
    const tomar = (pedido: string) => api('post', `/repartidor/pedidos/${pedido}/tomar`, 'rep1');
    const cerca = [0.004, 0.005, 0.006, 0.007, 0.008].map((d) => mover(TIENDA, d)); // destinos a 450–900 m de la tienda

    it('el pedido manual nace listo, sin código y cobra monto + envío', async () => {
      const p = await manual(cerca[0], 350);
      expect(p).toMatchObject({ estado: 'listo_para_recoger', origen: 'manual', subtotal: 350, costoEnvio: 25, total: 375, codigoEntrega: null });
      id.m1 = p.id;
    });

    it('solo deja encadenar pedidos cercanos a la ruta y nunca más de 4', async () => {
      await tomar(id.m1).expect(200);
      const lejano = await manual(mover(TIENDA, 0.045)); // destino a 5 km de los demás
      expect((await tomar(lejano.id).expect(409)).body.error).toBe('NO_ENCADENABLE');
      const visibles = await api('get', `/repartidor/pedidos-disponibles?lat=${TIENDA.lat}&lng=${TIENDA.lng}`, 'rep1');
      expect(visibles.body.map((p) => p.id)).not.toContain(lejano.id);

      for (const destino of cerca.slice(1, 4)) await tomar((await manual(destino)).id).expect(200);
      const quinto = await manual(cerca[4]);
      expect((await tomar(quinto.id).expect(409)).body.error).toBe('VIAJE_LLENO');
      expect((await api('get', `/repartidor/pedidos-disponibles?lat=${TIENDA.lat}&lng=${TIENDA.lng}`, 'rep1')).body).toHaveLength(0);

      const viaje = (await api('get', '/repartidor/viaje-actual', 'rep1').expect(200)).body;
      expect(viaje.pedidos).toHaveLength(4);
      expect(viaje.paradas).toHaveLength(8);
      // Siempre se recoge un pedido antes de entregarlo.
      for (const p of viaje.pedidos) {
        const orden = (tipo: string) => viaje.paradas.findIndex((x) => x.pedidoId === p.id && x.tipo === tipo);
        expect(orden('tienda')).toBeLessThan(orden('domicilio'));
      }
      id.lejano = lejano.id;
      id.quinto = quinto.id;
    });

    it('un pedido manual se entrega sin código', async () => {
      const marca = (paso: string, ubicacion: any) => api('post', `/repartidor/pedidos/${id.m1}/${paso}`, 'rep1', { ubicacion }).expect(200);
      await marca('llegada-tienda', TIENDA);
      await marca('salida-tienda', TIENDA);
      await marca('llegada-cliente', cerca[0]);
      await marca('entregado', cerca[0]);
      const viaje = (await api('get', '/repartidor/viaje-actual', 'rep1').expect(200)).body;
      expect(viaje.paradas.filter((p) => p.completada)).toHaveLength(2);
      expect(viaje.efectivoACobrar).toBe(375); // quedan 3 pedidos de $100 + $25
    });
  });

  describe('Soporte', () => {
    it('busca pedidos por folio o nombre del destinatario', async () => {
      const todos = await api('get', '/soporte/pedidos?q=Destinatario&limit=50', 'soporte').expect(200);
      expect(todos.body.meta.total).toBe(6);
      const uno = await api('get', `/soporte/pedidos?q=${todos.body.data[0].folio}`, 'soporte').expect(200);
      expect(uno.body.data).toHaveLength(1);
    });

    it('libera un pedido asignado para que otro repartidor lo tome', async () => {
      const viaje = (await api('get', '/repartidor/viaje-actual', 'rep1')).body;
      const asignado = viaje.pedidos.find((p) => p.estado === 'asignado');
      await api('post', `/soporte/pedidos/${asignado.id}/liberar`, 'soporte', {}).expect(400); // el motivo es obligatorio
      await api('post', `/soporte/pedidos/${asignado.id}/liberar`, 'rep1', { motivo: 'x' }).expect(403);
      const r = await api('post', `/soporte/pedidos/${asignado.id}/liberar`, 'soporte', { motivo: 'Moto descompuesta' }).expect(200);
      expect(r.body).toMatchObject({ estado: 'listo_para_recoger', repartidor: null, viajeId: null });
      expect((await api('get', '/repartidor/viaje-actual', 'rep1')).body.pedidos).toHaveLength(3);
      await api('post', `/repartidor/pedidos/${asignado.id}/tomar`, 'rep2').expect(200);
    });

    it('cancela y completa pedidos en curso; al terminar todos, el viaje se cierra', async () => {
      const [a, b] = (await api('get', '/repartidor/viaje-actual', 'rep1')).body.pedidos.filter((p) => p.estado === 'asignado');
      expect((await api('post', `/soporte/pedidos/${a.id}/cancelar`, 'soporte', { motivo: 'Cliente no localizable' }).expect(200)).body.estado).toBe('cancelado');
      expect((await api('post', `/soporte/pedidos/${b.id}/completar`, 'soporte', { motivo: 'Se entregó en otra dirección' }).expect(200)).body.estado).toBe('entregado');
      await api('post', `/soporte/pedidos/${b.id}/cancelar`, 'soporte', { motivo: 'x' }).expect(409); // ya es final
      await api('get', '/repartidor/viaje-actual', 'rep1').expect(204);
      await api('patch', '/repartidor/disponibilidad', 'rep1', { disponible: false }).expect(200);
    });

    it('corrige la ubicación de destino y queda en la bitácora', async () => {
      const r = await api('patch', `/soporte/pedidos/${id.quinto}/ubicacion`, 'soporte', {
        direccion: 'Calle Correcta 9', ubicacion: mover(TIENDA, 0.002), motivo: 'El cliente dio mal el número',
      }).expect(200);
      expect(r.body.destino.direccion).toBe('Calle Correcta 9');
      const eventos = (await api('get', `/pedidos/${id.quinto}/eventos`, 'soporte')).body;
      expect(eventos.at(-1)).toMatchObject({ tipo: 'ubicacion_corregida', rol: 'soporte' });
    });

    it('tickets: uno abierto por pedido, chat y cierre', async () => {
      const t = (await api('post', '/tickets', 'cliente', { pedidoId: id.pedido, asunto: 'Faltó un taco', descripcion: 'Llegaron 9' }).expect(201)).body;
      expect(t.folio).toMatch(/^T-\d{6}$/);
      expect((await api('post', '/tickets', 'cliente', { pedidoId: id.pedido, asunto: 'Otra vez', descripcion: '...' }).expect(409)).body.error).toBe('TICKET_DUPLICADO');
      await api('post', '/tickets', id.otro, { pedidoId: id.pedido, asunto: 'No es mío', descripcion: '...' }).expect(403); // el repartidor que no ganó el pedido
      await api('get', `/tickets/${t.id}`, 'tienda').expect(403);

      expect((await api('patch', `/soporte/tickets/${t.id}`, 'soporte', { asignarmelo: true }).expect(200)).body.estado).toBe('en_atencion');
      await api('post', `/tickets/${t.id}/mensajes`, 'soporte', { texto: '¿Nos compartes una foto?' }).expect(201);
      await api('post', `/tickets/${t.id}/mensajes`, 'cliente', { texto: 'Claro' }).expect(201);
      expect((await api('get', `/tickets/${t.id}/mensajes`, 'cliente')).body.map((m) => m.autorRol)).toEqual(['soporte', 'cliente']);

      await api('patch', `/soporte/tickets/${t.id}`, 'soporte', { estado: 'cerrado' }).expect(200);
      expect((await api('post', `/tickets/${t.id}/mensajes`, 'cliente', { texto: 'Hola' }).expect(409)).body.error).toBe('TICKET_CERRADO');
      expect((await api('get', '/tickets', 'cliente')).body.meta.total).toBe(1);
      expect((await api('get', '/tickets', 'tienda')).body.meta.total).toBe(0);
    });

    it('banear cierra el acceso de inmediato', async () => {
      await api('post', `/soporte/usuarios/${id.rep2}/banear`, 'soporte', { motivo: 'Fraude' }).expect(200);
      expect((await api('get', '/auth/me', 'rep2').expect(403)).body.error).toBe('CUENTA_BANEADA');
      expect((await api('post', '/auth/login', undefined, { email: 'rep2@prueba.test', password: PASS, app: 'repartidor' }).expect(403)).body.error).toBe('CUENTA_BANEADA');
      await api('post', `/soporte/usuarios/${id.rep2}/desbanear`, 'soporte').expect(200);
      await api('get', '/auth/me', 'rep2').expect(200);
    });

    it('admin crea cuentas internas y consulta métricas', async () => {
      await api('post', '/admin/usuarios', 'admin', { nombre: 'Agente 2', email: 'agente2@prueba.test', password: PASS, rol: 'soporte' }).expect(201);
      await api('post', '/auth/login', undefined, { email: 'agente2@prueba.test', password: PASS, app: 'web' }).expect(200);
      const m = (await api('get', '/admin/metricas', 'admin').expect(200)).body;
      expect(m).toMatchObject({ pedidosTotales: 7, pedidosEntregados: 3, pedidosCancelados: 1, tiendasActivas: 1, repartidoresActivos: 2, ticketsAbiertos: 0 });
      expect(m.ventasTotales).toBe(216 + 375 + 125);
    });
  });

  describe('Reglas por tiempo', () => {
    it('cancela solo el pedido que la tienda no respondió en 5 minutos', async () => {
      const cuerpo = { tiendaId: id.tiendaId, direccionId: id.casa, items: [{ productoId: id.pastor, cantidad: 1 }] };
      const viejo = (await api('post', '/pedidos', 'cliente', cuerpo).expect(201)).body.id;
      const reciente = (await api('post', '/pedidos', 'cliente', cuerpo).expect(201)).body.id;
      await ds.query(`UPDATE pedidos SET creado_en = now() - interval '6 minutes', enviado_a_tienda_en = now() - interval '6 minutes' WHERE id = $1`, [viejo]);

      expect(await app.get(TareasService).cancelarSinRespuesta()).toBe(1);
      expect((await api('get', `/pedidos/${viejo}`, 'cliente')).body.estado).toBe('cancelado');
      expect((await api('get', `/pedidos/${reciente}`, 'cliente')).body.estado).toBe('creado');
      expect((await api('get', `/pedidos/${viejo}/eventos`, 'cliente')).body.at(-1)).toMatchObject({ tipo: 'cancelado_automatico', usuarioId: null });
      await api('post', `/pedidos/${reciente}/cancelar`, 'cliente', { motivo: 'Me equivoqué' }).expect(200);
    });

    it('amplía el radio a 6 km y avisa a soporte cuando un pedido lleva mucho sin repartidor', async () => {
      const a4km = mover(TIENDA, 0.036);
      const ver = async () => (await api('get', `/repartidor/pedidos-disponibles?lat=${a4km.lat}&lng=${a4km.lng}`, 'rep2')).body.map((p) => p.id);
      await api('put', '/repartidor/ubicacion', 'rep2', a4km).expect(204);
      await api('patch', '/repartidor/disponibilidad', 'rep2', { disponible: true }).expect(200);
      expect(await ver()).not.toContain(id.quinto);

      await ds.query(`UPDATE pedidos SET listo_en = now() - interval '16 minutes' WHERE id = $1`, [id.quinto]);
      expect(await ver()).toContain(id.quinto);
      expect(await app.get(TareasService).avisarSinRepartidor()).toBe(1);
      expect(await app.get(TareasService).avisarSinRepartidor()).toBe(0); // solo avisa una vez
    });
  });

  describe('Fase 1: cuentas y seguridad', () => {
    const correos = () => app.get(CorreoService).enviados;
    const ultimoCodigo = (email: string) => {
      const c = [...correos()].reverse().find((x) => x.para === email);
      return c?.texto.match(/^\d{6}$/m)?.[0];
    };
    const login = (email: string, password = PASS, app = 'cliente') => api('post', '/auth/login', undefined, { email, password, app });

    it('exige aceptar los términos al registrarse y publica la versión vigente', async () => {
      const r = await api('post', '/auth/register', undefined, { nombre: 'Sin términos', email: 'st@prueba.test', password: PASS, telefono: '4610000000', rol: 'cliente' }).expect(400);
      expect(r.body.detalles.map((d) => d.campo)).toContain('aceptoTerminos');
      const legal = (await api('get', '/legal').expect(200)).body;
      expect(legal).toMatchObject({ version: expect.any(String), avisoPrivacidadUrl: expect.stringContaining('/privacidad') });
    });

    it('verifica el correo con el código que llega al registrarse', async () => {
      const u = await registrar('nuevo', 'cliente');
      expect(u.usuario).toMatchObject({ emailVerificado: false, terminosPendientes: false, fotoUrl: null });
      const codigo = ultimoCodigo('nuevo@prueba.test');
      expect(codigo).toMatch(/^\d{6}$/);
      const otro = codigo === '000000' ? '111111' : '000000';
      expect((await api('post', '/auth/verificar-correo', 'nuevo', { codigo: otro }).expect(400)).body.error).toBe('CODIGO_INVALIDO');
      expect((await api('post', '/auth/verificar-correo', 'nuevo', { codigo }).expect(200)).body.emailVerificado).toBe(true);
      expect((await api('post', '/auth/verificar-correo/reenviar', 'nuevo').expect(409)).body.error).toBe('CORREO_YA_VERIFICADO');
    });

    it('recupera la contraseña con un código y cierra las sesiones abiertas', async () => {
      const antes = correos().length;
      await api('post', '/auth/recuperar', undefined, { email: 'noexiste@prueba.test' }).expect(204);
      expect(correos().length).toBe(antes); // no revela si el correo existe

      const sesion = (await login('nuevo@prueba.test').expect(200)).body;
      await api('post', '/auth/recuperar', undefined, { email: 'NUEVO@prueba.test' }).expect(204);
      const codigo = ultimoCodigo('nuevo@prueba.test');
      await api('post', '/auth/restablecer', undefined, { email: 'nuevo@prueba.test', codigo: codigo === '000000' ? '111111' : '000000', password: 'NuevaClave2026' }).expect(400);
      await api('post', '/auth/restablecer', undefined, { email: 'nuevo@prueba.test', codigo, password: 'NuevaClave2026' }).expect(204);
      await api('post', '/auth/restablecer', undefined, { email: 'nuevo@prueba.test', codigo, password: 'OtraClave2026' }).expect(400); // un solo uso

      await api('post', '/auth/refresh', undefined, { refreshToken: sesion.refreshToken }).expect(401);
      await login('nuevo@prueba.test').expect(401);
      tok.nuevo = (await login('nuevo@prueba.test', 'NuevaClave2026').expect(200)).body.accessToken;
    });

    it('un código deja de servir tras 5 intentos equivocados', async () => {
      await api('post', '/auth/recuperar', undefined, { email: 'nuevo@prueba.test' }).expect(204);
      const codigo = ultimoCodigo('nuevo@prueba.test');
      const malo = codigo === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) await api('post', '/auth/restablecer', undefined, { email: 'nuevo@prueba.test', codigo: malo, password: 'NoImporta2026' }).expect(400);
      await api('post', '/auth/restablecer', undefined, { email: 'nuevo@prueba.test', codigo, password: 'NoImporta2026' }).expect(400);
    });

    it('bloquea la cuenta tras 5 contraseñas equivocadas y soporte la desbloquea', async () => {
      for (let i = 0; i < 4; i++) await login('nuevo@prueba.test', 'equivocada').expect(401);
      expect((await login('nuevo@prueba.test', 'equivocada').expect(403)).body.error).toBe('CUENTA_BLOQUEADA');
      expect((await login('nuevo@prueba.test', 'NuevaClave2026').expect(403)).body.error).toBe('CUENTA_BLOQUEADA');

      const ficha = (await api('get', `/soporte/usuarios/${id.nuevo}`, 'soporte').expect(200)).body;
      expect(ficha.bloqueadoHasta).toBeTruthy();
      await api('post', `/soporte/usuarios/${id.nuevo}/desbloquear`, 'soporte').expect(200);
      await login('nuevo@prueba.test', 'NuevaClave2026').expect(200);

      const eventos = (await api('get', `/soporte/usuarios/${id.nuevo}/eventos`, 'soporte').expect(200)).body.map((e) => e.tipo);
      expect(eventos).toEqual(expect.arrayContaining(['registrada', 'correo_verificado', 'password_restablecida', 'bloqueada', 'desbloqueada']));
      await api('get', `/soporte/usuarios/${id.nuevo}/eventos`, 'nuevo').expect(403);
    });

    it('cambia la contraseña, devuelve tokens nuevos y cierra las otras sesiones', async () => {
      const otra = (await login('nuevo@prueba.test', 'NuevaClave2026').expect(200)).body;
      expect((await api('put', '/usuarios/me/password', 'nuevo', { actual: 'mal', nueva: 'Cambio2026x' }).expect(403)).body.error).toBe('PASSWORD_INCORRECTA');
      await api('put', '/usuarios/me/password', 'nuevo', { actual: 'NuevaClave2026', nueva: 'NuevaClave2026' }).expect(400);
      const r = await api('put', '/usuarios/me/password', 'nuevo', { actual: 'NuevaClave2026', nueva: 'Cambio2026x' }).expect(200);
      expect(r.body.refreshToken).toBeDefined();
      await api('post', '/auth/refresh', undefined, { refreshToken: otra.refreshToken }).expect(401);
      await api('post', '/auth/refresh', undefined, { refreshToken: r.body.refreshToken }).expect(200);
    });

    it('cerrar sesión en todos lados invalida los refresh tokens', async () => {
      const a = (await login('nuevo@prueba.test', 'Cambio2026x').expect(200)).body;
      tok.nuevo = a.accessToken;
      await api('post', '/auth/logout-todos', 'nuevo').expect(204);
      await api('post', '/auth/refresh', undefined, { refreshToken: a.refreshToken }).expect(401);
    });

    it('pide aceptar los términos cuando cambia la versión', async () => {
      await ds.query(`UPDATE usuarios SET terminos_version = '2020-01' WHERE id = $1`, [id.nuevo]);
      expect((await api('get', '/auth/me', 'nuevo').expect(200)).body.terminosPendientes).toBe(true);
      expect((await api('post', '/usuarios/me/terminos', 'nuevo', { version: '2020-01' }).expect(409)).body.error).toBe('VERSION_TERMINOS');
      const { version } = (await api('get', '/legal')).body;
      expect((await api('post', '/usuarios/me/terminos', 'nuevo', { version }).expect(200)).body.terminosPendientes).toBe(false);
    });

    it('guarda la foto de perfil', async () => {
      const r = await api('patch', '/usuarios/me', 'nuevo', { fotoUrl: 'https://ejemplo.test/yo.webp' }).expect(200);
      expect(r.body.fotoUrl).toBe('https://ejemplo.test/yo.webp');
      expect((await api('patch', '/usuarios/me', 'nuevo', { fotoUrl: null }).expect(200)).body.fotoUrl).toBeNull();
    });

    it('no deja eliminar la cuenta con pedidos en curso ni a la única cuenta de admin', async () => {
      const cuerpo = { tiendaId: id.tiendaId, direccionId: id.casa, items: [{ productoId: id.pastor, cantidad: 1 }] };
      const p = (await api('post', '/pedidos', 'cliente', cuerpo).expect(201)).body;
      expect((await api('delete', '/usuarios/me', 'cliente', { password: PASS }).expect(409)).body.error).toBe('TIENE_PEDIDOS_ACTIVOS');
      await api('post', `/pedidos/${p.id}/cancelar`, 'cliente', { motivo: 'Prueba' }).expect(200);
      expect((await api('delete', '/usuarios/me', 'admin', { password: PASS }).expect(409)).body.error).toBe('ULTIMO_ADMIN');
    });

    it('elimina la cuenta: borra sus datos personales y conserva los pedidos sin ellos', async () => {
      await registrar('borrar', 'cliente');
      await api('post', '/direcciones', 'borrar', { alias: 'Casa', texto: 'Calle 1', ubicacion: CASA }).expect(201);
      expect((await api('delete', '/usuarios/me', 'borrar', { password: 'mal' }).expect(403)).body.error).toBe('PASSWORD_INCORRECTA');
      await api('delete', '/usuarios/me', 'borrar', { password: PASS }).expect(204);

      await api('get', '/auth/me', 'borrar').expect(401);
      await login('borrar@prueba.test').expect(401);
      const lista = (await api('get', '/soporte/usuarios?q=borrar', 'soporte').expect(200)).body;
      expect(lista.meta.total).toBe(0);
      const ficha = (await api('get', `/soporte/usuarios/${id.borrar}`, 'soporte').expect(200)).body;
      expect(ficha).toMatchObject({ estado: 'eliminado', nombre: 'Usuario eliminado', telefono: null });
      expect(ficha.email).not.toContain('borrar@');
      const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM direcciones WHERE cliente_id = $1`, [id.borrar]);
      expect(n).toBe(0);
      // El correo queda libre para registrarse de nuevo.
      await registrar('borrar', 'cliente');
    });
  });

  describe('Fase 2: repartidor', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const subirDoc = (quien: string, tipo: string, contentType = 'image/png') =>
      request(http).post('/api/v1/documentos').set('Authorization', `Bearer ${tok[quien]}`).field('tipo', tipo)
        .attach('archivo', png, { filename: 'doc', contentType });

    it('registra su vehículo; la placa es obligatoria salvo en bicicleta', async () => {
      await api('get', '/repartidor/vehiculo', id.ganador).expect(204);
      await api('put', '/repartidor/vehiculo', id.ganador, { tipo: 'moto', color: 'Rojo' }).expect(400);
      expect((await api('put', '/repartidor/vehiculo', id.otro, { tipo: 'bicicleta', color: 'Azul' }).expect(200)).body.placa).toBeNull();
      const v = await api('put', '/repartidor/vehiculo', id.ganador, { tipo: 'moto', marca: 'Italika', color: 'Rojo', placa: 'gto-123' }).expect(200);
      expect(v.body).toEqual({ tipo: 'moto', marca: 'Italika', modelo: null, color: 'Rojo', placa: 'GTO-123' });
      await api('get', '/repartidor/vehiculo', 'cliente').expect(403);
    });

    it('el cliente ve vehículo, foto y calificación de su repartidor', async () => {
      const p = (await api('get', `/pedidos/${id.pedido}`, 'cliente').expect(200)).body;
      expect(p.repartidor).toMatchObject({ calificacion: 4, vehiculo: { tipo: 'moto', placa: 'GTO-123' } });
      expect(p.etaMin).toBeNull(); // ya se entregó
      expect((await api('get', '/auth/me', id.ganador)).body.calificacion).toBe(4);
    });

    it('sube documentos privados y soporte los revisa', async () => {
      await subirDoc(id.ganador, 'constancia_fiscal').expect(400); // no aplica a repartidores
      await subirDoc(id.ganador, 'ine', 'text/plain').expect(400);
      await subirDoc('cliente', 'ine').expect(403);
      const ine = (await subirDoc(id.ganador, 'ine').expect(201)).body;
      expect(ine).toMatchObject({ tipo: 'ine', nombre: 'INE', estado: 'pendiente' });

      const mios = (await api('get', '/documentos', id.ganador).expect(200)).body;
      expect(mios.find((d) => d.tipo === 'licencia')).toMatchObject({ requerido: true, documento: null });
      expect(mios.find((d) => d.tipo === 'ine').documento.estado).toBe('pendiente');

      await api('get', `/soporte/usuarios/${id[id.ganador]}/documentos`, id.ganador).expect(403);
      expect((await api('get', `/soporte/usuarios/${id[id.ganador]}/documentos`, 'soporte').expect(200)).body).toHaveLength(1);
      const archivo = (await api('get', `/soporte/documentos/${ine.id}/archivo`, 'soporte').expect(200)).body;
      expect(archivo.url).toMatch(/^data:image\/png;base64,/);
      expect(new Date(archivo.expiraEn).getTime()).toBeGreaterThan(Date.now());

      await api('post', `/soporte/documentos/${ine.id}/revisar`, 'soporte', { aprobado: false }).expect(400); // falta el motivo
      const rechazado = (await api('post', `/soporte/documentos/${ine.id}/revisar`, 'soporte', { aprobado: false, motivo: 'Foto borrosa' }).expect(200)).body;
      expect(rechazado).toMatchObject({ estado: 'rechazado', motivo: 'Foto borrosa' });
      expect((await subirDoc(id.ganador, 'ine').expect(201)).body).toMatchObject({ id: ine.id, estado: 'pendiente', motivo: null });
      await api('post', `/soporte/documentos/${ine.id}/revisar`, 'soporte', { aprobado: true }).expect(200);
      expect((await subirDoc(id.ganador, 'ine').expect(409)).body.error).toBe('DOCUMENTO_APROBADO');

      const ficha = (await api('get', `/soporte/usuarios/${id[id.ganador]}`, 'soporte')).body;
      expect(ficha).toMatchObject({ documentosCompletos: false, vehiculo: { placa: 'GTO-123' } }); // falta la licencia
      const eventos = (await api('get', `/soporte/usuarios/${id[id.ganador]}/eventos`, 'soporte')).body.map((e) => e.tipo);
      expect(eventos).toEqual(expect.arrayContaining(['documento_rechazado', 'documento_aprobado']));
    });

    it('ganancias y corte: envío, efectivo cobrado y pagado a tiendas por día', async () => {
      const g = (await api('get', '/repartidor/ganancias', id.ganador).expect(200)).body;
      const [esperado] = await ds.query(
        `SELECT count(*)::int AS n, sum(costo_envio)::float8 AS envio, sum(total)::float8 AS cobrado, sum(subtotal)::float8 AS pagado
         FROM pedidos WHERE repartidor_id = $1 AND estado = 'entregado'`, [id[id.ganador]],
      );
      expect(g.resumen).toMatchObject({
        pedidos: esperado.n, gananciaEnvio: esperado.envio, efectivoCobrado: esperado.cobrado, pagadoATiendas: esperado.pagado,
        calificacion: 4, calificaciones: 1,
      });
      expect(g.porDia).toHaveLength(1);
      expect(g.porDia[0].fecha).toBe(g.hasta);
      expect((await api('get', '/repartidor/ganancias?desde=2026-01-10&hasta=2026-01-01', id.ganador).expect(400)).body.detalles[0].campo).toBe('desde');
      await api('get', '/repartidor/ganancias?desde=2026-01-01&hasta=2026-12-31', id.ganador).expect(400); // más de 92 días
      expect((await api('get', '/repartidor/ganancias?desde=2020-01-01&hasta=2020-01-07', id.ganador)).body.resumen.pedidos).toBe(0);
    });

    it('la ruta del viaje trae el tiempo estimado de cada parada pendiente', async () => {
      const viaje = (await api('get', '/repartidor/viaje-actual', 'rep2').expect(200)).body;
      const pendientes = viaje.paradas.filter((p) => !p.completada);
      expect(pendientes.length).toBeGreaterThan(0);
      pendientes.forEach((p, i) => {
        expect(p.etaMin).toEqual(expect.any(Number));
        if (i) expect(p.etaMin).toBeGreaterThanOrEqual(pendientes[i - 1].etaMin);
      });
      expect(viaje.pedidos[0].etaMin).toEqual(expect.any(Number));
    });

    it('la ruta por calles sale de OSRM y, si no responde, se dibuja en línea recta', async () => {
      const rutas = app.get(RutasService) as any;
      const fetchOriginal = global.fetch;
      const viaje = (await api('get', '/repartidor/viaje-actual', 'rep2').expect(200)).body;
      const pendientes = viaje.paradas.filter((p) => !p.completada).map((p) => p.ubicacion);
      try {
        // OSRM caído: línea recta desde la última ubicación del repartidor por las paradas pendientes.
        global.fetch = (async () => {
          throw new Error('sin red');
        }) as any;
        const recta = (await api('get', '/repartidor/viaje-actual/ruta', 'rep2').expect(200)).body;
        expect(recta).toMatchObject({ fuente: 'linea_recta', metros: null, segundos: null });
        expect(recta.puntos.slice(-pendientes.length)).toEqual(pendientes);

        // OSRM responde: se devuelven sus puntos ({lng,lat} → {lat,lng}) con distancia y tiempo.
        rutas.cache.clear();
        let pedida = '';
        global.fetch = (async (url: string) => {
          pedida = url;
          return { ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [{ distance: 3420.4, duration: 539.6, geometry: { coordinates: [[-100.81, 20.52], [-100.812, 20.521]] } }] }) };
        }) as any;
        const calles = (await api('get', '/repartidor/viaje-actual/ruta', 'rep2').expect(200)).body;
        expect(calles).toEqual({ fuente: 'calles', puntos: [{ lat: 20.52, lng: -100.81 }, { lat: 20.521, lng: -100.812 }], metros: 3420, segundos: 540 });
        expect(pedida).toContain('/route/v1/driving/');
      } finally {
        global.fetch = fetchOriginal;
        rutas.cache.clear();
      }
    });
  });

  describe('Fase 2: tienda', () => {
    const carrito = (items: any[]) => ({ tiendaId: id.tiendaId, direccionId: id.casa, items });
    const cotizar = (items: any[]) => api('post', '/pedidos/cotizar', 'cliente', carrito(items));
    let salsa: any;
    let extras: any;

    it('define opciones de producto: grupos con mínimo, máximo y precio extra', async () => {
      const grupos = [
        { nombre: 'Salsa', minimo: 1, maximo: 1, opciones: [{ nombre: 'Verde' }, { nombre: 'Roja' }] },
        { nombre: 'Extras', minimo: 0, maximo: 2, opciones: [{ nombre: 'Queso', precioExtra: 15 }, { nombre: 'Doble carne', precioExtra: 30 }, { nombre: 'Piña', precioExtra: 5, disponible: false }] },
      ];
      await api('put', `/productos/${id.pastor}/opciones`, 'tienda', { grupos: [{ ...grupos[0], maximo: 3 }] }).expect(400);
      await api('put', `/productos/${id.pastor}/opciones`, 'tienda', { grupos: [{ ...grupos[0], minimo: 2, maximo: 1 }] }).expect(400);
      await api('put', `/productos/${id.pastor}/opciones`, 'cliente', { grupos }).expect(403);
      const p = (await api('put', `/productos/${id.pastor}/opciones`, 'tienda', { grupos }).expect(200)).body;
      expect(p.grupos.map((g) => g.nombre)).toEqual(['Salsa', 'Extras']);
      [salsa, extras] = p.grupos;
      const menu = (await api('get', `/tiendas/${id.tiendaId}/menu`, 'cliente')).body;
      expect(menu[0].productos.find((x) => x.id === id.pastor).grupos[1].opciones).toHaveLength(3);
    });

    it('el carrito respeta las opciones y suma sus precios', async () => {
      const verde = salsa.opciones[0].id;
      const roja = salsa.opciones[1].id;
      const [queso, doble, pina] = extras.opciones.map((o) => o.id);
      const err = async (items: any[], status = 400) => (await cotizar(items).expect(status)).body;

      expect((await err([{ productoId: id.pastor, cantidad: 1 }])).message).toContain('Salsa');
      expect((await err([{ productoId: id.pastor, cantidad: 1, opciones: [verde, roja] }])).error).toBe('VALIDACION');
      expect((await err([{ productoId: id.pastor, cantidad: 1, opciones: [verde, queso, doble, pina] }], 409)).error).toBe('PRODUCTO_AGOTADO');
      expect((await err([{ productoId: id.pastor, cantidad: 1, opciones: [verde, '00000000-0000-4000-8000-000000000000'] }])).error).toBe('VALIDACION');

      // 2 con verde + queso ($100 c/u) y 1 con roja + doble carne ($115): líneas separadas.
      const items = [
        { productoId: id.pastor, cantidad: 1, opciones: [verde, queso] },
        { productoId: id.pastor, cantidad: 1, opciones: [roja, doble] },
        { productoId: id.pastor, cantidad: 1, opciones: [queso, verde] },
      ];
      expect((await cotizar(items).expect(200)).body.subtotal).toBe(315);
      const pedido = (await api('post', '/pedidos', 'cliente', carrito(items)).expect(201)).body;
      expect(pedido.items).toHaveLength(2);
      expect(pedido.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ cantidad: 2, precioUnitario: 100, importe: 200, opciones: [{ grupo: 'Salsa', nombre: 'Verde', precioExtra: 0 }, { grupo: 'Extras', nombre: 'Queso', precioExtra: 15 }] }),
        expect.objectContaining({ cantidad: 1, precioUnitario: 115 }),
      ]));
      expect(pedido.etaMin).toBeGreaterThan(15); // preparación + traslado
      await api('post', `/pedidos/${pedido.id}/cancelar`, 'cliente', { motivo: 'Prueba' }).expect(200);
      id.verde = verde;
    });

    it('inventario: baja al pedir, regresa al cancelar y agota en cero', async () => {
      id.refresco = (await api('post', '/productos', 'tienda', { categoriaId: id.cat, nombre: 'Refresco', precio: 30, stock: 3 }).expect(201)).body.id;
      const conTaco = (n: number) => [{ productoId: id.pastor, cantidad: 1, opciones: [id.verde] }, { productoId: id.refresco, cantidad: n }];
      const stock = async () => (await api('get', '/tiendas/mia/productos', 'tienda')).body.find((x) => x.id === id.refresco);

      expect((await cotizar(conTaco(4)).expect(409)).body.message).toContain('Solo quedan 3');
      const a = (await api('post', '/pedidos', 'cliente', carrito(conTaco(2))).expect(201)).body;
      expect((await stock()).stock).toBe(1);
      await api('post', `/pedidos/${a.id}/cancelar`, 'cliente', { motivo: 'Prueba' }).expect(200);
      expect((await stock()).stock).toBe(3);

      const b = (await api('post', '/pedidos', 'cliente', carrito(conTaco(3))).expect(201)).body;
      expect(await stock()).toMatchObject({ stock: 0, disponible: true, agotado: true });
      expect((await cotizar(conTaco(1)).expect(409)).body.error).toBe('PRODUCTO_AGOTADO');
      await api('post', `/pedidos/${b.id}/rechazar`, 'tienda', { motivo: 'Sin gas' }).expect(200);
      expect((await stock()).stock).toBe(3);

      await api('patch', `/productos/${id.refresco}`, 'tienda', { stock: null }).expect(200);
      expect((await stock()).stock).toBeNull();
    });

    it('guarda varias fotos por producto; la primera es la principal', async () => {
      const fotos = ['https://img.test/1.webp', 'https://img.test/2.webp'];
      const p = (await api('patch', `/productos/${id.refresco}`, 'tienda', { imagenes: fotos }).expect(200)).body;
      expect(p).toMatchObject({ imagenUrl: fotos[0], imagenes: fotos });
      await api('patch', `/productos/${id.refresco}`, 'tienda', { imagenes: Array(6).fill(fotos[0]) }).expect(400);
      await api('patch', `/productos/${id.refresco}`, 'tienda', { imagenes: ['no-es-url'] }).expect(400);
      expect((await api('patch', `/productos/${id.refresco}`, 'tienda', { imagenUrl: null }).expect(200)).body.imagenes).toEqual([]);
    });

    it('horario semanal: fuera de turno no recibe pedidos', async () => {
      const [{ hoy }] = await ds.query(`SELECT extract(dow FROM now() AT TIME ZONE 'America/Mexico_City')::int AS hoy`);
      const otroDia = (hoy + 3) % 7;
      const items = [{ productoId: id.pastor, cantidad: 1, opciones: [id.verde] }];
      expect((await api('get', '/tiendas/mia/horario', 'tienda').expect(200)).body).toMatchObject({ usarHorario: false, turnos: [], abiertaAhora: true });
      await api('put', '/tiendas/mia/horario', 'tienda', { usarHorario: true, turnos: [] }).expect(400);
      await api('put', '/tiendas/mia/horario', 'tienda', { usarHorario: true, turnos: [{ dia: 1, abre: '9:00', cierra: '18:00' }] }).expect(400);
      await api('put', '/tiendas/mia/horario', 'tienda', { usarHorario: true, turnos: [{ dia: 1, abre: '09:00', cierra: '09:00' }] }).expect(400);

      const cerrado = (await api('put', '/tiendas/mia/horario', 'tienda', { usarHorario: true, turnos: [{ dia: otroDia, abre: '09:00', cierra: '18:00' }] }).expect(200)).body;
      expect(cerrado).toMatchObject({ usarHorario: true, abiertaAhora: false, turnos: [{ dia: otroDia, abre: '09:00', cierra: '18:00' }] });
      expect((await cotizar(items).expect(409)).body.error).toBe('TIENDA_CERRADA');
      expect((await api('get', `/tiendas?lat=${CASA.lat}&lng=${CASA.lng}`, 'cliente')).body.meta.total).toBe(0);
      const detalle = (await api('get', `/tiendas/${id.tiendaId}`, 'cliente').expect(200)).body;
      expect(detalle).toMatchObject({ abierta: true, abiertaAhora: false, horario: [{ dia: otroDia }] });

      const todoElDia = [0, 1, 2, 3, 4, 5, 6].map((dia) => ({ dia, abre: '00:00', cierra: '24:00' }));
      expect((await api('put', '/tiendas/mia/horario', 'tienda', { usarHorario: true, turnos: todoElDia }).expect(200)).body.abiertaAhora).toBe(true);
      await cotizar(items).expect(200);
    });

    it('un turno que cruza la medianoche cuenta para el día en que abre', async () => {
      await api('put', '/tiendas/mia/horario', 'tienda', { usarHorario: true, turnos: [{ dia: 5, abre: '20:00', cierra: '02:00' }] }).expect(200);
      // 2026-11-20 es viernes (dia 5); Celaya está en UTC-6.
      const abierta = async (local: string) =>
        (await ds.query(`SELECT tienda_abierta_ahora($1, $2::timestamptz) AS a`, [id.tiendaId, `${local}-06:00`]))[0].a;
      expect(await abierta('2026-11-20T19:59:00')).toBe(false);
      expect(await abierta('2026-11-20T21:00:00')).toBe(true);
      expect(await abierta('2026-11-21T01:30:00')).toBe(true); // sábado de madrugada, turno del viernes
      expect(await abierta('2026-11-21T02:00:00')).toBe(false);
      expect(await abierta('2026-11-21T21:00:00')).toBe(false); // el sábado no abre
      await api('put', '/tiendas/mia/horario', 'tienda', { usarHorario: false, turnos: [] }).expect(200);
    });

    it('pausa temporal: no recibe pedidos hasta que la quite o se cumpla el tiempo', async () => {
      const items = [{ productoId: id.pastor, cantidad: 1, opciones: [id.verde] }];
      await api('post', '/tiendas/mia/pausa', 'tienda', { minutos: 500 }).expect(400);
      const t = (await api('post', '/tiendas/mia/pausa', 'tienda', { minutos: 30 }).expect(200)).body;
      expect(t).toMatchObject({ abierta: true, abiertaAhora: false });
      expect(new Date(t.pausadaHasta).getTime()).toBeGreaterThan(Date.now() + 29 * 60000);
      expect((await cotizar(items).expect(409)).body.message).toContain('no está recibiendo pedidos');
      await ds.query(`UPDATE tiendas SET pausada_hasta = now() - interval '1 minute' WHERE id = $1`, [id.tiendaId]);
      await cotizar(items).expect(200); // la pausa venció sola
      await api('post', '/tiendas/mia/pausa', 'tienda', { minutos: 15 }).expect(200);
      expect((await api('delete', '/tiendas/mia/pausa', 'tienda').expect(200)).body).toMatchObject({ abiertaAhora: true, pausadaHasta: null });
    });

    it('reporte de ventas con resumen, días, horas y productos más vendidos', async () => {
      const r = (await api('get', '/tiendas/mia/reporte', 'tienda').expect(200)).body;
      const [esperado] = await ds.query(
        `SELECT count(*) FILTER (WHERE estado = 'entregado')::int AS entregados, coalesce(sum(subtotal) FILTER (WHERE estado = 'entregado'), 0)::float8 AS ventas,
                count(*) FILTER (WHERE estado = 'rechazado')::int AS rechazados
         FROM pedidos WHERE tienda_id = $1`, [id.tiendaId],
      );
      expect(r.resumen).toMatchObject({ pedidosEntregados: esperado.entregados, ventas: esperado.ventas, rechazados: esperado.rechazados, calificacionPromedio: 5 });
      expect(r.resumen.ticketPromedio).toBeCloseTo(esperado.ventas / esperado.entregados, 2);
      expect(r.porDia).toHaveLength(1);
      expect(r.porHora.reduce((s, h) => s + h.pedidos, 0)).toBe(esperado.entregados);
      expect(r.productosMasVendidos[0]).toMatchObject({ nombre: 'Orden de pastor', cantidad: 2 });
      await api('get', '/tiendas/mia/reporte', 'cliente').expect(403);
    });

    it('sucursales: la pide la app, soporte la aprueba copiando el menú y trabaja con X-Tienda-Id', async () => {
      const conSucursal = (metodo: any, ruta: string, tiendaId: string, cuerpo?: any) => api(metodo, ruta, 'tienda', cuerpo).set('X-Tienda-Id', tiendaId);
      const pedida = { nombre: 'Tacos Don Pepe Norte', categoria: 'comida', direccion: 'Av. Tecnológico 900', ubicacion: mover(TIENDA, 0.01), copiarMenuDe: id.tiendaId };
      // Una que el dueño cancela y otra que soporte rechaza.
      const cancelada = (await api('post', '/tiendas/solicitudes', 'tienda', { ...pedida, nombre: 'Me arrepentí' }).expect(202)).body;
      expect((await api('delete', `/tiendas/solicitudes/${cancelada.id}`, 'tienda').expect(200)).body.estado).toBe('cancelada');
      const rechazada = (await api('post', '/tiendas/mias', 'tienda', { ...pedida, nombre: 'Sin permiso de uso de suelo' }).expect(202)).body;
      await api('post', `/soporte/solicitudes-tienda/${rechazada.id}/rechazar`, 'soporte', {}).expect(400);
      expect((await api('post', `/soporte/solicitudes-tienda/${rechazada.id}/rechazar`, 'soporte', { motivo: 'Falta el permiso' }).expect(200)).body).toMatchObject({ estado: 'rechazada', motivo: 'Falta el permiso' });
      await api('post', `/soporte/solicitudes-tienda/${rechazada.id}/aprobar`, 'soporte').expect(409);

      const sol = (await api('post', '/tiendas/solicitudes', 'tienda', pedida).expect(202)).body;
      expect(sol).toMatchObject({ estado: 'pendiente', tiendaId: null, datos: { nombre: 'Tacos Don Pepe Norte' } });
      expect((await api('get', '/tiendas/mias', 'tienda')).body).toHaveLength(1); // todavía no existe
      await api('get', '/soporte/solicitudes-tienda', 'tienda').expect(403);
      const pendientes = (await api('get', '/soporte/solicitudes-tienda?estado=pendiente', 'soporte').expect(200)).body;
      expect(pendientes.data).toEqual([expect.objectContaining({ id: sol.id, dueno: expect.objectContaining({ id: id.tienda }) })]);
      const aprobada = (await api('post', `/soporte/solicitudes-tienda/${sol.id}/aprobar`, 'admin').expect(200)).body;
      expect(aprobada).toMatchObject({ estado: 'aprobada', tiendaId: expect.any(String) });
      expect((await api('get', '/tiendas/solicitudes', 'tienda')).body.map((x) => x.estado)).toEqual(['aprobada', 'rechazada', 'cancelada']);
      const s = (await conSucursal('get', '/tiendas/mia', aprobada.tiendaId).expect(200)).body;
      expect(s).toMatchObject({ abierta: false, abiertaAhora: false });
      id.sucursal = s.id;
      expect((await api('get', '/tiendas/mias', 'tienda')).body.map((t) => t.id)).toEqual([id.tiendaId, s.id]);

      // Sin header sigue trabajando con la primera (las apps que no manejan sucursales no cambian).
      expect((await api('get', '/tiendas/mia', 'tienda')).body.id).toBe(id.tiendaId);
      expect((await conSucursal('get', '/tiendas/mia', s.id)).body.id).toBe(s.id);
      const copia = (await conSucursal('get', '/tiendas/mia/productos', s.id).expect(200)).body;
      expect(copia.map((p) => p.nombre).sort()).toEqual((await api('get', '/tiendas/mia/productos', 'tienda')).body.map((p) => p.nombre).sort());
      expect(copia.find((p) => p.nombre === 'Orden de pastor').grupos).toHaveLength(2);
      expect(copia.every((p) => p.stock === null)).toBe(true);

      await conSucursal('get', '/tiendas/mia', 'no-es-uuid').expect(400);
      await conSucursal('get', '/tiendas/mia', id.pedido).expect(404); // no es una sucursal suya
      expect((await conSucursal('patch', '/tiendas/mia', s.id, { abierta: true }).expect(200)).body.abierta).toBe(true);
      expect((await api('get', '/tiendas/mia', 'tienda')).body.abierta).toBe(true);

      const manual = (await conSucursal('post', '/pedidos/manual', s.id, {
        destino: { nombre: 'Norte', telefono: '4619876543', direccion: 'Calle 1', ubicacion: mover(TIENDA, 0.012) }, descripcion: 'Paquete', montoACobrar: 50,
      }).expect(201)).body;
      expect(manual.tienda.id).toBe(s.id);
      const soloNorte = (await conSucursal('get', '/pedidos', s.id)).body;
      expect(soloNorte.data.map((p) => p.id)).toEqual([manual.id]);
      const todas = (await api('get', '/pedidos?limit=100', 'tienda')).body;
      expect(todas.meta.total).toBeGreaterThan(1);
      expect(todas.data.some((p) => p.tienda.id === id.tiendaId)).toBe(true);
      await api('post', `/pedidos/${manual.id}/cancelar`, 'tienda', { motivo: 'Prueba' }).expect(200);

      await registrar('tiendaNueva', 'tienda', { tienda: { nombre: 'Nueva', categoria: 'comida', direccion: 'X', ubicacion: TIENDA } });
      expect((await api('post', '/tiendas/mias', 'tiendaNueva', { nombre: 'Otra', categoria: 'comida', direccion: 'Y', ubicacion: TIENDA }).expect(409)).body.error).toBe('CUENTA_PENDIENTE');
      const ficha = (await api('get', `/soporte/usuarios/${id.tienda}`, 'soporte')).body;
      expect(ficha.tiendas).toHaveLength(2);
    });
  });

  describe('Fase 3: cliente y negocio', () => {
    const carrito = (extra: any = {}, items: any[] = [{ productoId: id.pastor, cantidad: 2, opciones: [id.verde] }]) =>
      ({ tiendaId: id.tiendaId, direccionId: id.casa, items, ...extra });
    const cotizar = (extra: any = {}, items?: any[]) => api('post', '/pedidos/cotizar', 'cliente', carrito(extra, items));
    const crear = async (extra: any = {}, items?: any[]) => (await api('post', '/pedidos', 'cliente', carrito(extra, items)).expect(201)).body;
    const cancelar = (pedidoId: string) => api('post', `/pedidos/${pedidoId}/cancelar`, 'cliente', { codigo: 'cambio_de_opinion' }).expect(200);
    const sql = async (q: string, params: any[] = []) => (await ds.query(q, params))[0];

    it('catálogo de motivos: cancelar con código o texto queda registrado', async () => {
      const cat = (await api('get', '/catalogos/motivos-cancelacion').expect(200)).body;
      expect(cat.cliente.map((m) => m.codigo)).toContain('cambio_de_opinion');
      expect(cat.tienda.map((m) => m.codigo)).toContain('sin_ingredientes');

      const p = await crear();
      await api('post', `/pedidos/${p.id}/cancelar`, 'cliente', {}).expect(400);
      await api('post', `/pedidos/${p.id}/cancelar`, 'cliente', { codigo: 'sin_ingredientes' }).expect(400); // es de tienda
      expect((await cancelar(p.id)).body.motivoCancelacion).toBe('cambio_de_opinion');
      const ultimo = (await api('get', `/pedidos/${p.id}/eventos`, 'cliente')).body.at(-1);
      expect(ultimo).toMatchObject({ tipo: 'cancelado', detalle: 'Cambié de opinión' });

      const r = await crear();
      await api('post', `/pedidos/${r.id}/rechazar`, 'tienda', { codigo: 'sin_ingredientes', motivo: 'Sin piña' }).expect(200);
      expect((await api('get', `/pedidos/${r.id}/eventos`, 'tienda')).body.at(-1).detalle).toBe('Sin piña');
      const c = (await api('get', '/admin/cancelaciones', 'soporte').expect(200)).body;
      expect(c.motivos).toEqual(expect.arrayContaining([
        expect.objectContaining({ codigo: 'cambio_de_opinion', texto: 'Cambié de opinión' }),
        expect.objectContaining({ codigo: 'sin_ingredientes', rechazados: 1 }),
      ]));
    });

    it('cupones de PaPedir y de tienda, con propina', async () => {
      await api('post', '/admin/cupones', 'tienda', { codigo: 'NOPE1', tipo: 'monto', valor: 10 }).expect(403);
      const plataforma = (await api('post', '/admin/cupones', 'admin', { codigo: 'bienvenida', tipo: 'monto', valor: 30, minimoCompra: 100, descripcion: '$30 de regalo' }).expect(201)).body;
      expect(plataforma).toMatchObject({ codigo: 'BIENVENIDA', tiendaId: null, usos: 0 });
      expect((await api('post', '/admin/cupones', 'admin', { codigo: 'BIENVENIDA', tipo: 'envio_gratis' }).expect(409)).body.error).toBe('CUPON_DUPLICADO');
      await api('post', '/admin/cupones', 'admin', { codigo: 'MUCHO', tipo: 'porcentaje', valor: 150 }).expect(400);

      const q = (await cotizar({ cupon: 'bienvenida', propina: 20 }).expect(200)).body;
      expect(q).toMatchObject({ subtotal: 170, costoEnvio: 46, descuento: 30, propina: 20, total: 206, cupon: { codigo: 'BIENVENIDA', descripcion: '$30 de regalo' } });
      expect((await cotizar({ cupon: 'NOEXISTE' }).expect(409)).body.error).toBe('CUPON_INVALIDO');
      expect((await cotizar({ cupon: 'BIENVENIDA' }, [{ productoId: id.pastor, cantidad: 1, opciones: [id.verde] }]).expect(409)).body.message).toContain('compra mínima');
      await cotizar({ propina: 600 }).expect(400);

      await api('post', '/tiendas/mia/cupones', 'tienda', { codigo: 'GRATIS', tipo: 'envio_gratis' }).expect(400);
      const propio = (await api('post', '/tiendas/mia/cupones', 'tienda', { codigo: 'TACO10', tipo: 'porcentaje', valor: 10, usosPorCliente: 5 }).expect(201)).body;
      expect(propio.tiendaId).toBe(id.tiendaId);
      expect((await cotizar({ cupon: 'TACO10' }).expect(200)).body.descuento).toBe(17);
      expect((await api('get', '/tiendas/mia/cupones', 'tienda')).body.map((c) => c.codigo)).toEqual(['TACO10']);

      const p = await crear({ cupon: 'BIENVENIDA' });
      expect(p).toMatchObject({ descuento: 30, total: 186, montoAPagarTienda: 170 });
      expect((await cotizar({ cupon: 'BIENVENIDA' }).expect(409)).body.message).toBe('Ya usaste este cupón');
      await cancelar(p.id);
      await cotizar({ cupon: 'BIENVENIDA' }).expect(200); // al cancelar se libera
      id.cuponPlataforma = plataforma.id;
    });

    it('chat con el repartidor, comisiones y saldos al entregar', async () => {
      const p = await crear({ cupon: 'TACO10', propina: 20 });
      expect(p).toMatchObject({ subtotal: 170, descuento: 17, propina: 20, total: 219, montoAPagarTienda: 153, comisionTienda: null });
      await api('post', `/pedidos/${p.id}/aceptar`, 'tienda').expect(200);
      await api('post', `/pedidos/${p.id}/listo`, 'tienda').expect(200);
      await api('put', '/repartidor/ubicacion', 'rep1', CERCA_DE_TIENDA).expect(204);
      await api('patch', '/repartidor/disponibilidad', 'rep1', { disponible: true }).expect(200);
      const viaje = (await api('post', `/repartidor/pedidos/${p.id}/tomar`, 'rep1').expect(200)).body;
      expect(viaje).toMatchObject({ efectivoAPagarTiendas: 153, efectivoACobrar: 219, propinas: 20 });

      // Chat
      expect((await api('post', `/pedidos/${p.id}/mensajes`, 'cliente', { texto: 'Toca el timbre azul' }).expect(201)).body.autorRol).toBe('cliente');
      await api('post', `/pedidos/${p.id}/mensajes`, 'rep1', { texto: 'Voy en camino' }).expect(201);
      await api('get', `/pedidos/${p.id}/mensajes`, 'rep2').expect(403);
      await api('get', `/pedidos/${p.id}/mensajes`, 'tienda').expect(403);
      expect((await api('get', `/pedidos/${p.id}/mensajes`, 'soporte').expect(200)).body.map((m) => m.texto)).toEqual(['Toca el timbre azul', 'Voy en camino']);

      const marca = (accion: string, ubicacion: any) => api('post', `/repartidor/pedidos/${p.id}/${accion}`, 'rep1', { ubicacion });
      await marca('llegada-tienda', CERCA_DE_TIENDA).expect(200);
      await marca('salida-tienda', CERCA_DE_TIENDA).expect(200);
      await marca('llegada-cliente', CASA).expect(200);
      await api('post', `/repartidor/pedidos/${p.id}/entregado`, 'rep1', { ubicacion: CASA, codigoEntrega: p.codigoEntrega }).expect(200);
      expect((await api('post', `/pedidos/${p.id}/mensajes`, 'cliente', { texto: 'Gracias' }).expect(409)).body.error).toBe('CHAT_CERRADO');
      id.entregadoF3 = p.id;

      // Comisiones: 10 % de lo que cobra la tienda (153) y 10 % del envío (46).
      expect((await api('get', `/pedidos/${p.id}`, 'tienda')).body.comisionTienda).toBe(15.3);
      expect((await api('get', `/pedidos/${p.id}`, 'cliente')).body.comisionTienda).toBeNull();
      const tiendaSaldo = (await api('get', '/cartera', 'tienda').expect(200)).body;
      const esperadoTienda = await sql(`SELECT sum(comision_tienda)::float8 AS s FROM pedidos p JOIN tiendas t ON t.id = p.tienda_id WHERE t.owner_id = $1`, [id.tienda]);
      expect(tiendaSaldo).toMatchObject({ saldo: -esperadoTienda.s, estado: 'debe', bloqueado: false, limiteDeuda: 1500 });
      expect(tiendaSaldo.movimientos.data[0]).toMatchObject({ tipo: 'comision_tienda', monto: -15.3, pedidoId: p.id });
      expect((await api('get', '/saldo', 'cliente').expect(200)).body).toMatchObject({ saldo: 0, estado: 'en_cero' });
      await api('get', '/cartera', 'soporte').expect(403);

      // Cupón de PaPedir: el repartidor cobra de menos y la plataforma se lo abona.
      const conCupon = await crear({ cupon: 'BIENVENIDA' });
      await api('post', `/pedidos/${conCupon.id}/aceptar`, 'tienda').expect(200);
      await api('post', `/pedidos/${conCupon.id}/listo`, 'tienda').expect(200);
      await api('post', `/repartidor/pedidos/${conCupon.id}/tomar`, 'rep1').expect(200);
      await api('post', `/soporte/pedidos/${conCupon.id}/completar`, 'soporte', { motivo: 'Entregado sin marcar' }).expect(200);
      const rep = (await api('get', '/saldo', 'rep1')).body;
      expect(rep.movimientos.data.find((x) => x.pedidoId === conCupon.id && x.tipo === 'descuento_plataforma').monto).toBe(30);
      const esperadoRep = await sql(
        `SELECT coalesce(sum(comision_envio), 0) - coalesce(sum(descuento) FILTER (WHERE descuento_absorbe = 'plataforma'), 0) AS s FROM pedidos WHERE repartidor_id = $1 AND estado = 'entregado'`,
        [id.rep1],
      );
      expect(rep.saldo).toBeCloseTo(-Number(esperadoRep.s), 2);

      const g = (await api('get', '/repartidor/ganancias', 'rep1')).body.resumen;
      expect(g.propinas).toBeGreaterThanOrEqual(20);
      expect(g.reembolsoCupones).toBe(30);
      expect(g.gananciaNeta).toBeCloseTo(g.gananciaEnvio + g.propinas - g.comisionPlataforma + g.reembolsoCupones, 2);
      const r = (await api('get', '/tiendas/mia/reporte', 'tienda')).body.resumen;
      expect(r.descuentosCupones).toBe(17);
      expect(r.ventasNetas).toBeCloseTo(r.ventas - r.comisionPlataforma, 2);
    });

    it('admin ve saldos y registra liquidaciones', async () => {
      const antes = (await api('get', '/admin/saldos', 'admin').expect(200)).body;
      const tienda = antes.usuarios.find((u) => u.id === id.tienda);
      expect(tienda.saldo).toBeLessThan(0);
      expect(antes.totalPorCobrar).toBeGreaterThanOrEqual(-tienda.saldo);
      await api('get', '/admin/saldos', 'soporte').expect(403);
      await api('post', '/admin/liquidaciones', 'admin', { usuarioId: id.soporte, sentido: 'cobro', monto: 10, metodo: 'efectivo' }).expect(400);

      const l = (await api('post', '/admin/liquidaciones', 'admin', { usuarioId: id.tienda, sentido: 'cobro', monto: -tienda.saldo, metodo: 'transferencia', referencia: 'SPEI 123' }).expect(201)).body;
      expect(l).toMatchObject({ sentido: 'cobro', saldo: 0 });
      expect((await api('get', '/saldo', 'tienda')).body).toMatchObject({ saldo: 0, estado: 'en_cero' });
      expect((await api('get', `/admin/liquidaciones?usuarioId=${id.tienda}`, 'admin')).body.data[0].referencia).toBe('SPEI 123');
      expect((await api('get', '/admin/saldos?rol=tienda', 'admin')).body.usuarios.find((u) => u.id === id.tienda)).toBeUndefined();
    });

    it('configuración: comisiones y tarifas dinámicas sin redesplegar', async () => {
      const c = (await api('get', '/admin/configuracion', 'admin').expect(200)).body;
      expect(c).toMatchObject({ comisiones: { tiendaPct: 10, envioPct: 10 }, recargos: { lluvia: { activo: false } } });
      await api('put', '/admin/configuracion/comisiones', 'soporte', { tiendaPct: 5, envioPct: 5 }).expect(403);
      await api('put', '/admin/configuracion/comisiones', 'admin', { tiendaPct: 80, envioPct: 5 }).expect(400);
      expect((await api('put', '/admin/configuracion/comisiones', 'admin', { tiendaPct: 12, envioPct: 8 }).expect(200)).body).toEqual({ tiendaPct: 12, envioPct: 8 });
      expect((await api('put', `/admin/tiendas/${id.tiendaId}/comision`, 'admin', { comisionPct: 5 }).expect(200)).body).toMatchObject({ comisionPct: 5, general: 12 });

      const recargos = (extra: any) => ({
        nocturno: { activo: false, desde: '22:00', hasta: '06:00', monto: 10 }, lluvia: { activo: false, monto: 15 },
        demanda: { activo: false, pedidosEsperando: 5, monto: 10 }, ...extra,
      });
      await api('put', '/admin/configuracion/recargos', 'admin', recargos({ nocturno: { activo: true, desde: '25:00', hasta: '06:00', monto: 10 } })).expect(400);
      await api('put', '/admin/configuracion/recargos', 'admin', recargos({ lluvia: { activo: true, monto: 15 }, nocturno: { activo: true, desde: '00:00', hasta: '00:00', monto: 0 } })).expect(200);
      let q = (await cotizar().expect(200)).body;
      expect(q).toMatchObject({ costoEnvio: 61, recargos: [{ concepto: 'Lluvia', monto: 15 }] });
      // Nocturno "todo el día" (desde 00:00 hasta 23:59) para probarlo a cualquier hora.
      await api('put', '/admin/configuracion/recargos', 'admin', recargos({ nocturno: { activo: true, desde: '00:00', hasta: '23:59', monto: 10 } })).expect(200);
      q = (await cotizar().expect(200)).body;
      expect(q.recargos).toEqual([{ concepto: 'Horario nocturno', monto: 10 }]);
      expect(q.costoEnvio).toBe(56);
      await api('put', '/admin/configuracion/recargos', 'admin', recargos({})).expect(200);
      expect((await cotizar().expect(200)).body.costoEnvio).toBe(46);
    });

    it('zonas de cobertura: fuera de las zonas activas no se entrega', async () => {
      const cuadro = (c: any, d: number) => [mover(c, -d, -d), mover(c, -d, d), mover(c, d, d), mover(c, d, -d)];
      await api('post', '/admin/zonas', 'admin', { nombre: 'Moño', puntos: [mover(CASA, -0.01, -0.01), mover(CASA, 0.01, 0.01), mover(CASA, -0.01, 0.01), mover(CASA, 0.01, -0.01)] }).expect(400);
      const z = (await api('post', '/admin/zonas', 'admin', { nombre: 'Norte', recargo: 7, puntos: cuadro(CASA, 0.01) }).expect(201)).body;
      expect(z.puntos).toHaveLength(4);
      expect((await api('get', '/zonas', 'cliente').expect(200)).body.map((x) => x.nombre)).toEqual(['Norte']);

      expect((await cotizar().expect(200)).body).toMatchObject({ costoEnvio: 53, recargos: [{ concepto: 'Zona Norte', monto: 7 }] });
      const fuera = (await api('post', '/direcciones', 'cliente', { alias: 'Centro', texto: 'Centro', ubicacion: mover(TIENDA, 0.005) }).expect(201)).body.id;
      const r = await api('post', '/pedidos/cotizar', 'cliente', { ...carrito(), direccionId: fuera }).expect(409);
      expect(r.body).toMatchObject({ error: 'FUERA_DE_COBERTURA', message: 'Todavía no llegamos a esa zona' });

      await api('patch', `/admin/zonas/${z.id}`, 'admin', { activa: false }).expect(200);
      await api('post', '/pedidos/cotizar', 'cliente', { ...carrito(), direccionId: fuera }).expect(200); // sin zonas activas, todo el radio
      await api('delete', `/admin/zonas/${z.id}`, 'admin').expect(204);
      await api('delete', `/direcciones/${fuera}`, 'cliente').expect(204);
    });

    it('pedidos programados: llegan a la tienda con anticipación', async () => {
      const en = (min: number) => new Date(Date.now() + min * 60000).toISOString();
      expect((await cotizar({ programadoPara: en(10) }).expect(400)).body.detalles[0].campo).toBe('programadoPara');
      await cotizar({ programadoPara: en(8 * 1440) }).expect(400);

      const p = await crear({ programadoPara: en(120) });
      expect(p.estado).toBe('programado');
      expect(p.etaMin).toBeGreaterThanOrEqual(119);
      await api('post', `/pedidos/${p.id}/aceptar`, 'tienda').expect(409);
      expect((await api('get', '/pedidos?estado=programado', 'tienda')).body.data.map((x) => x.id)).toContain(p.id);

      const tareas = app.get(TareasService);
      expect(await tareas.liberarProgramados()).toBe(0); // todavía falta
      await ds.query(`UPDATE pedidos SET programado_para = now() + interval '20 minutes' WHERE id = $1`, [p.id]);
      expect(await tareas.liberarProgramados()).toBe(1);
      const liberado = (await api('get', `/pedidos/${p.id}`, 'cliente')).body;
      expect(liberado.estado).toBe('creado');
      expect((await api('get', `/pedidos/${p.id}/eventos`, 'cliente')).body.at(-1)).toMatchObject({ tipo: 'enviado_a_tienda', usuarioId: null });
      expect(await tareas.cancelarSinRespuesta()).toBe(0); // los 5 minutos cuentan desde que llegó a la tienda
      await cancelar(p.id);

      // Si la tienda no abrió para el programado, se cancela solo.
      const q = await crear({ programadoPara: en(120) });
      await api('patch', '/tiendas/mia', 'tienda', { abierta: false }).expect(200);
      await ds.query(`UPDATE pedidos SET programado_para = now() + interval '20 minutes' WHERE id = $1`, [q.id]);
      await tareas.liberarProgramados();
      expect((await api('get', `/pedidos/${q.id}`, 'cliente')).body).toMatchObject({ estado: 'cancelado', motivoCancelacion: 'tienda_cerrada' });
      await api('patch', '/tiendas/mia', 'tienda', { abierta: true }).expect(200);
    });

    it('un carrito de dos tiendas crea dos pedidos juntos (o ninguno)', async () => {
      const menu = (await api('get', `/tiendas/${id.sucursal}/menu`, 'cliente').expect(200)).body;
      const pastorNorte = menu.flatMap((c) => c.productos).find((x) => x.nombre === 'Orden de pastor');
      const verdeNorte = pastorNorte.grupos[0].opciones[0].id;
      const pedidoNorte = { tiendaId: id.sucursal, items: [{ productoId: pastorNorte.id, cantidad: 1, opciones: [verdeNorte] }] };
      const pedidoCentro = { tiendaId: id.tiendaId, items: [{ productoId: id.pastor, cantidad: 1, opciones: [id.verde] }], propina: 10 };

      await api('post', '/pedidos/grupo', 'cliente', { direccionId: id.casa, pedidos: [pedidoCentro, pedidoCentro] }).expect(400);
      const antes = (await sql(`SELECT count(*)::int AS n FROM pedidos`)).n;
      await api('post', '/pedidos/grupo', 'cliente', { direccionId: id.casa, pedidos: [pedidoCentro, { ...pedidoNorte, items: [{ productoId: pastorNorte.id, cantidad: 1 }] }] }).expect(400);
      expect((await sql(`SELECT count(*)::int AS n FROM pedidos`)).n).toBe(antes);

      const g = (await api('post', '/pedidos/grupo', 'cliente', { direccionId: id.casa, pedidos: [pedidoCentro, pedidoNorte], notas: 'Juntos' }).expect(201)).body;
      expect(g.pedidos).toHaveLength(2);
      expect(new Set(g.pedidos.map((x) => x.grupoId))).toEqual(new Set([g.grupoId]));
      expect(g.total).toBeCloseTo(g.pedidos[0].total + g.pedidos[1].total, 2);
      expect(g.pedidos.map((x) => x.tienda.id).sort()).toEqual([id.tiendaId, id.sucursal].sort());
      for (const x of g.pedidos) await cancelar(x.id);
    });

    it('repetir un pedido arma el carrito con el menú de hoy', async () => {
      const r = (await api('post', `/pedidos/${id.entregadoF3}/repetir`, 'cliente').expect(200)).body;
      expect(r).toMatchObject({ tienda: { id: id.tiendaId, abiertaAhora: true }, omitidos: [] });
      expect(r.items).toEqual([expect.objectContaining({ productoId: id.pastor, cantidad: 2, opciones: [id.verde], precioUnitario: 85 })]);
      await api('post', `/pedidos/${id.entregadoF3}/repetir`, 'tiendaNueva').expect(403);

      const temporal = (await api('post', '/productos', 'tienda', { categoriaId: id.cat, nombre: 'Temporada', precio: 60 }).expect(201)).body.id;
      const p = await crear({}, [{ productoId: temporal, cantidad: 1 }]);
      await cancelar(p.id);
      await api('delete', `/productos/${temporal}`, 'tienda').expect(204);
      expect((await api('post', `/pedidos/${p.id}/repetir`, 'cliente').expect(200)).body).toMatchObject({
        items: [], omitidos: [{ nombre: 'Temporada', motivo: 'Ya no está en el menú' }],
      });
    });

    it('tiendas favoritas', async () => {
      await api('put', `/favoritos/${id.tiendaId}`, 'cliente').expect(204);
      await api('put', `/favoritos/${id.tiendaId}`, 'cliente').expect(204); // repetir no falla
      await api('put', `/favoritos/${id.pedido}`, 'cliente').expect(404);
      await api('put', `/favoritos/${id.tiendaId}`, 'tienda').expect(403);
      expect((await api('get', '/favoritos', 'cliente').expect(200)).body).toEqual([expect.objectContaining({ id: id.tiendaId, abiertaAhora: true })]);
      await api('delete', `/favoritos/${id.tiendaId}`, 'cliente').expect(204);
      expect((await api('get', '/favoritos', 'cliente')).body).toEqual([]);
    });

    it('busca productos en las tiendas abiertas cercanas', async () => {
      await api('get', '/productos/buscar?q=a', 'cliente').expect(400);
      const r = (await api('get', `/productos/buscar?q=PASTOR&lat=${CASA.lat}&lng=${CASA.lng}`, 'cliente').expect(200)).body;
      expect(r.data.map((x) => x.tienda.id).sort()).toEqual([id.tiendaId, id.sucursal].sort());
      expect(r.data[0].tienda.distanciaKm).toBeLessThan(r.data[1].tienda.distanciaKm);
      expect(r.data[0].producto).toMatchObject({ nombre: 'Orden de pastor', agotado: false });
      await api('post', '/tiendas/mia/pausa', 'tienda', { minutos: 30 }).expect(200);
      expect((await api('get', '/productos/buscar?q=pastor', 'cliente')).body.data.map((x) => x.tienda.id)).toEqual([id.sucursal]);
      await api('delete', '/tiendas/mia/pausa', 'tienda').expect(200);
    });

    it('reseñas: la tienda responde y el cliente recibe la notificación', async () => {
      const lista = (await api('get', `/tiendas/${id.tiendaId}/resenas`, 'cliente').expect(200)).body;
      expect(lista.resumen).toMatchObject({ promedio: 5, total: 1, porEstrellas: { 5: 1, 1: 0 } });
      expect(lista.data[0]).toMatchObject({ pedidoId: id.pedido, calificacion: 5, comentario: 'Rápido', cliente: 'Usuario c.', respuesta: null });

      await api('post', `/pedidos/${id.pedido}/calificacion/respuesta`, 'tiendaNueva', { texto: 'x' }).expect(403);
      await api('post', `/pedidos/${id.entregadoF3}/calificacion/respuesta`, 'tienda', { texto: 'x' }).expect(404); // sin reseña
      await api('post', `/pedidos/${id.pedido}/calificacion/respuesta`, 'tienda', { texto: '¡Gracias por tu pedido!' }).expect(200);
      expect((await api('get', `/tiendas/${id.tiendaId}/resenas`, 'cliente')).body.data[0].respuesta).toBe('¡Gracias por tu pedido!');
    });

    it('bandeja de notificaciones: no leídas, marcar una y todas', async () => {
      const b = (await api('get', '/notificaciones', 'cliente').expect(200)).body;
      expect(b.noLeidas).toBeGreaterThan(0);
      const respuesta = b.data.find((n) => n.titulo === 'La tienda respondió tu reseña');
      expect(respuesta).toMatchObject({ leida: false, datos: { pedidoId: id.pedido } });

      await api('post', `/notificaciones/${respuesta.id}/leer`, 'tienda').expect(404); // no es suya
      await api('post', `/notificaciones/${respuesta.id}/leer`, 'cliente').expect(204);
      const despues = (await api('get', '/notificaciones?soloNoLeidas=true', 'cliente')).body;
      expect(despues.noLeidas).toBe(b.noLeidas - 1);
      expect(despues.data.map((n) => n.id)).not.toContain(respuesta.id);
      await api('post', '/notificaciones/leer-todas', 'cliente').expect(204);
      expect((await api('get', '/notificaciones', 'cliente')).body.noLeidas).toBe(0);
    });
  });

  describe('Login con Firebase (apps móviles)', () => {
    // Tokens simulados: en producción Firebase firma el token y firebase-admin lo valida.
    const cuentas: Record<string, IdentidadFirebase> = {
      google: { uid: 'g-1', email: 'ana.google@gmail.com', emailVerificado: true, nombre: 'Ana Google', foto: 'https://lh3.test/ana.jpg', proveedor: 'google.com' },
      github: { uid: 'gh-1', email: 'tienda.github@prueba.test', emailVerificado: true, nombre: 'Tienda GH', foto: 'https://avatars.test/t.png', proveedor: 'github.com' },
      sinVerificar: { uid: 'p-1', email: 'nuevo.correo@prueba.test', emailVerificado: false, nombre: null, foto: null, proveedor: 'password' },
      correo: { uid: 'p-2', email: 'ligar@prueba.test', emailVerificado: true, nombre: null, foto: null, proveedor: 'password' },
      intruso: { uid: 'gh-2', email: 'cliente@prueba.test', emailVerificado: false, nombre: 'X', foto: null, proveedor: 'github.com' },
    };
    const entrar = (token: string, app = 'cliente', registro?: any) => api('post', '/auth/firebase', undefined, { idToken: token, app, registro });
    const registro = { telefono: '4611234567', aceptoTerminos: true };

    it('sin Firebase configurado responde 503', async () => {
      expect((await entrar('google').expect(503)).body.error).toBe('FIREBASE_NO_CONFIGURADO');
      const fb = app.get(FirebaseService);
      fb.verificar = async (t: string) => {
        if (!cuentas[t]) throw Object.assign(new Error(), { getStatus: () => 401 });
        return cuentas[t];
      };
    });

    it('rechaza tokens inválidos y correos sin verificar', async () => {
      await entrar('basura').expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
      expect((await entrar('sinVerificar').expect(403)).body.error).toBe('CORREO_NO_VERIFICADO');
      await entrar('google', 'web').expect(400);
    });

    it('la primera vez pide completar el registro y luego entra directo', async () => {
      expect((await entrar('google').expect(404)).body.error).toBe('REGISTRO_REQUERIDO');
      await entrar('google', 'cliente', { telefono: '4611234567' }).expect(400); // falta aceptar términos
      const r = (await entrar('google', 'cliente', registro).expect(200)).body;
      expect(r.usuario).toMatchObject({
        nombre: 'Ana Google', email: 'ana.google@gmail.com', rol: 'cliente', estado: 'activo', proveedor: 'google.com',
        fotoUrl: 'https://lh3.test/ana.jpg', emailVerificado: true, terminosPendientes: false, puedeCambiarFoto: false,
      });
      tok.google = r.accessToken;
      id.google = r.usuario.id;
      const otra = (await entrar('google').expect(200)).body;
      expect(otra.usuario.id).toBe(id.google);
      expect((await api('get', '/auth/me', 'google').expect(200)).body.email).toBe('ana.google@gmail.com');
      expect((await entrar('google', 'repartidor').expect(403)).body.error).toBe('APP_INCORRECTA');
    });

    it('la foto viene del proveedor y solo las cuentas de correo la pueden cambiar', async () => {
      expect((await api('patch', '/usuarios/me', 'google', { fotoUrl: 'https://x.test/y.jpg' }).expect(403)).body.error).toBe('FOTO_DEL_PROVEEDOR');
      await api('patch', '/usuarios/me', 'google', { nombre: 'Ana G.' }).expect(200); // lo demás sí
      cuentas.google.foto = 'https://lh3.test/ana-nueva.jpg';
      expect((await entrar('google').expect(200)).body.usuario.fotoUrl).toBe('https://lh3.test/ana-nueva.jpg');
    });

    it('una tienda se registra con GitHub y queda en revisión', async () => {
      await entrar('github', 'tienda', registro).expect(400); // faltan los datos de la tienda
      const r = (await entrar('github', 'tienda', { ...registro, tienda: { nombre: 'Tienda GH', categoria: 'otros', direccion: 'Calle 2', ubicacion: TIENDA } }).expect(200)).body;
      expect(r.usuario).toMatchObject({ rol: 'tienda', estado: 'pendiente_aprobacion', proveedor: 'github.com' });
      tok.github = r.accessToken;
      expect((await api('get', '/tiendas/mia', 'github').expect(200)).body.nombre).toBe('Tienda GH');
    });

    it('liga una cuenta existente solo si el correo está verificado', async () => {
      await registrar('ligar', 'cliente');
      const r = (await entrar('correo').expect(200)).body;
      expect(r.usuario).toMatchObject({ id: id.ligar, proveedor: 'password', puedeCambiarFoto: true });
      tok.ligar = r.accessToken;
      await api('patch', '/usuarios/me', 'ligar', { fotoUrl: 'https://x.test/mia.jpg' }).expect(200);
      expect((await entrar('intruso').expect(409)).body.error).toBe('EMAIL_REGISTRADO'); // GitHub sin correo verificado
      const eventos = (await api('get', `/soporte/usuarios/${id.ligar}/eventos`, 'soporte')).body.map((e) => e.tipo);
      expect(eventos).toContain('ligada_firebase');
    });

    it('las cuentas de Firebase manejan contraseña y correo en Firebase', async () => {
      expect((await api('put', '/usuarios/me/password', 'google', { actual: 'x', nueva: 'OtraClave2026' }).expect(409)).body.error).toBe('CUENTA_FIREBASE');
      expect((await api('post', '/auth/verificar-correo/reenviar', 'ligar').expect(409)).body.error).toBe('CUENTA_FIREBASE');
      const antes = app.get(CorreoService).enviados.length;
      await api('post', '/auth/recuperar', undefined, { email: 'ana.google@gmail.com' }).expect(204);
      expect(app.get(CorreoService).enviados.length).toBe(antes);
    });

    it('elimina la cuenta confirmando con su token de Firebase', async () => {
      await api('delete', '/usuarios/me', 'google', { idToken: 'github' }).expect(403); // token de otra cuenta
      await api('delete', '/usuarios/me', 'google', {}).expect(400);
      await api('delete', '/usuarios/me', 'google', { idToken: 'google' }).expect(204);
      await api('get', '/auth/me', 'google').expect(401);
      expect((await entrar('google').expect(404)).body.error).toBe('REGISTRO_REQUERIDO'); // empieza de cero
    });
  });

  describe('Pagos con tarjeta y planes (Stripe)', () => {
    // Stripe simulado: la app confirmaría la tarjeta con flutter_stripe; aquí se marca a mano.
    const intentos = new Map<string, Intento>();
    const reembolsos: string[] = [];
    let fallarReembolso = false;
    let n = 0;
    const pagar = (piId: string) => {
      const i = intentos.get(piId);
      i.estado = i.metadata.plan ? 'succeeded' : 'requires_capture';
    };
    const carrito = (extra: any = {}) => ({ tiendaId: id.tiendaId, direccionId: id.casa, items: [{ productoId: id.pastor, cantidad: 2, opciones: [id.verde] }], ...extra });

    it('sin Stripe configurado responde 503', async () => {
      expect((await api('post', '/pagos/intento', 'cliente', carrito()).expect(503)).body.error).toBe('PAGOS_NO_CONFIGURADO');
      const p = app.get(PagosService) as any;
      p.crearIntento = async (pesos: number, _d: string, metadata: Record<string, string>) => {
        const i: Intento = { id: `pi_prueba_${++n}`, estado: 'requires_payment_method', centavos: Math.round(pesos * 100), moneda: 'mxn', metadata, clientSecret: `pi_prueba_${n}_secret` };
        intentos.set(i.id, i);
        return i;
      };
      p.obtener = async (pid: string) => {
        if (!intentos.has(pid)) throw Object.assign(new Error('no'), { getStatus: () => 400 });
        return intentos.get(pid);
      };
      p.capturar = async (pid: string) => Object.assign(intentos.get(pid), { estado: 'succeeded' });
      p.liberar = async (pid: string) => void Object.assign(intentos.get(pid), { estado: 'canceled' });
      p.reembolsar = async (pid: string) => (fallarReembolso ? false : (reembolsos.push(pid), true));
      expect((await api('get', '/pagos/config', 'cliente').expect(200)).body).toMatchObject({ moneda: 'mxn', maximoTarjeta: 10000 });
    });

    it('paga un pedido con tarjeta: autoriza, cobra al crear y el repartidor no maneja efectivo', async () => {
      const r = (await api('post', '/pagos/intento', 'cliente', carrito({ propina: 15 })).expect(200)).body;
      expect(r).toMatchObject({ paymentIntentId: expect.stringMatching(/^pi_/), clientSecret: expect.any(String), cotizacion: { metodoPago: 'tarjeta', total: 231 } });
      expect(intentos.get(r.paymentIntentId).centavos).toBe(23100);

      await api('post', '/pedidos', 'cliente', carrito({ propina: 15, metodoPago: 'tarjeta' })).expect(400); // falta paymentIntentId
      expect((await api('post', '/pedidos', 'cliente', carrito({ propina: 15, metodoPago: 'tarjeta', paymentIntentId: r.paymentIntentId })).expect(402)).body.error).toBe('PAGO_PENDIENTE');
      pagar(r.paymentIntentId);
      const p = (await api('post', '/pedidos', 'cliente', carrito({ propina: 15, metodoPago: 'tarjeta', paymentIntentId: r.paymentIntentId })).expect(201)).body;
      expect(p).toMatchObject({ metodoPago: 'tarjeta', pagoEstado: 'pagado', total: 231, montoAPagarTienda: 0 });
      expect(intentos.get(r.paymentIntentId).estado).toBe('succeeded');
      expect((await api('post', '/pedidos', 'cliente', carrito({ propina: 15, metodoPago: 'tarjeta', paymentIntentId: r.paymentIntentId })).expect(409)).body.error).toBe('PAGO_USADO');
      await api('post', '/pedidos', 'ligar', { ...carrito({ metodoPago: 'tarjeta', paymentIntentId: r.paymentIntentId }), direccionId: undefined }).expect(400);

      await api('post', `/pedidos/${p.id}/aceptar`, 'tienda').expect(200);
      await api('post', `/pedidos/${p.id}/listo`, 'tienda').expect(200);
      const disponible = (await api('get', `/repartidor/pedidos-disponibles?lat=${CERCA_DE_TIENDA.lat}&lng=${CERCA_DE_TIENDA.lng}`, 'rep1').expect(200)).body.find((x) => x.id === p.id);
      expect(disponible).toMatchObject({ metodoPago: 'tarjeta', montoAPagarTienda: 0, totalACobrar: 0, propina: 15 });
      const viaje = (await api('post', `/repartidor/pedidos/${p.id}/tomar`, 'rep1').expect(200)).body;
      expect(viaje).toMatchObject({ efectivoAPagarTiendas: 0, efectivoACobrar: 0 });
      await api('post', `/soporte/pedidos/${p.id}/completar`, 'soporte', { motivo: 'Prueba de tarjeta' }).expect(200);

      // PaPedir cobró: le debe la venta a la tienda y el envío + propina al repartidor.
      const tienda = (await api('get', '/saldo', 'tienda')).body.movimientos.data.filter((x) => x.pedidoId === p.id);
      expect(tienda).toEqual(expect.arrayContaining([expect.objectContaining({ tipo: 'venta_tarjeta', monto: 170 })]));
      const rep = (await api('get', '/saldo', 'rep1')).body.movimientos.data.filter((x) => x.pedidoId === p.id);
      expect(rep).toEqual(expect.arrayContaining([expect.objectContaining({ tipo: 'envio_tarjeta', monto: 61 })]));
    });

    it('si el total cambió, no cobra y libera la tarjeta', async () => {
      const r = (await api('post', '/pagos/intento', 'cliente', carrito()).expect(200)).body;
      pagar(r.paymentIntentId);
      expect((await api('post', '/pedidos', 'cliente', carrito({ propina: 50, metodoPago: 'tarjeta', paymentIntentId: r.paymentIntentId })).expect(409)).body.error).toBe('PAGO_NO_COINCIDE');
      expect(intentos.get(r.paymentIntentId).estado).toBe('canceled');
    });

    it('cancelar o rechazar un pedido pagado lo reembolsa; si Stripe falla, avisa a soporte', async () => {
      const crearPagado = async () => {
        const r = (await api('post', '/pagos/intento', 'cliente', carrito()).expect(200)).body;
        pagar(r.paymentIntentId);
        return (await api('post', '/pedidos', 'cliente', carrito({ metodoPago: 'tarjeta', paymentIntentId: r.paymentIntentId })).expect(201)).body;
      };
      const a = await crearPagado();
      const r = (await api('post', `/pedidos/${a.id}/rechazar`, 'tienda', { codigo: 'muy_ocupado' }).expect(200)).body;
      expect(r.pagoEstado).toBe('reembolsado');
      expect(reembolsos).toContain(a.paymentIntentId ?? reembolsos.at(-1));
      expect((await api('get', `/pedidos/${a.id}/eventos`, 'cliente')).body.map((e) => e.tipo)).toContain('reembolsado');

      fallarReembolso = true;
      const b = await crearPagado();
      expect((await api('post', `/pedidos/${b.id}/cancelar`, 'cliente', { codigo: 'cambio_de_opinion' }).expect(200)).body.pagoEstado).toBe('reembolso_fallido');
      fallarReembolso = false;
    });

    it('planes de tienda: pagar, renovar, volver a básico y vencer', async () => {
      const con = (metodo: any, ruta: string, cuerpo?: any) => api(metodo, ruta, 'tienda', cuerpo).set('X-Tienda-Id', id.sucursal);
      const planes = (await api('get', '/planes', 'tienda').expect(200)).body;
      expect(planes.map((x) => [x.codigo, x.precioMensual, x.comisionPct])).toEqual([['basico', 0, 12], ['pro', 199, 7], ['premium', 399, 4]]);
      expect((await con('get', '/tiendas/mia/plan').expect(200)).body).toMatchObject({ plan: 'basico', planHasta: null, comisionPct: 12 });

      const e = (await con('post', '/tiendas/mia/plan', { plan: 'pro' }).expect(200)).body;
      expect(e).toMatchObject({ requierePago: true, monto: 199, paymentIntentId: expect.stringMatching(/^pi_/) });
      expect((await con('post', '/tiendas/mia/plan/confirmar', { paymentIntentId: e.paymentIntentId }).expect(402)).body.error).toBe('PAGO_PENDIENTE');
      pagar(e.paymentIntentId);
      await api('post', '/tiendas/mia/plan/confirmar', 'tienda', { paymentIntentId: e.paymentIntentId }).expect(400); // es de la otra sucursal
      const pro = (await con('post', '/tiendas/mia/plan/confirmar', { paymentIntentId: e.paymentIntentId }).expect(200)).body;
      const dias = (f: string) => Math.round((new Date(f).getTime() - Date.now()) / 86400000);
      expect(pro).toMatchObject({ plan: 'pro', comisionPct: 7 });
      expect(dias(pro.planHasta)).toBe(30);
      expect((await con('post', '/tiendas/mia/plan/confirmar', { paymentIntentId: e.paymentIntentId }).expect(409)).body.error).toBe('PAGO_USADO');
      expect((await api('get', `/tiendas/${id.sucursal}`, 'cliente')).body.plan).toBe('pro');

      const renovar = (await con('post', '/tiendas/mia/plan', { plan: 'pro' }).expect(200)).body;
      pagar(renovar.paymentIntentId);
      const renovado = (await con('post', '/tiendas/mia/plan/confirmar', { paymentIntentId: renovar.paymentIntentId }).expect(200)).body;
      expect(dias(renovado.planHasta)).toBe(60); // los días se suman
      expect(renovado.pagos).toHaveLength(2);

      expect((await con('post', '/tiendas/mia/plan', { plan: 'basico' }).expect(200)).body).toMatchObject({ plan: 'basico', requierePago: false, comisionPct: 12 });

      await ds.query(`UPDATE tiendas SET plan = 'premium', plan_hasta = now() - interval '1 hour' WHERE id = $1`, [id.sucursal]);
      expect(await app.get(TareasService).vencerPlanes()).toBe(1);
      expect((await con('get', '/tiendas/mia/plan')).body.plan).toBe('basico');
      await api('post', '/tiendas/mia/plan', 'tiendaNueva', { plan: 'pro' }).expect(409); // cuenta en revisión
    });
  });

  describe('Imágenes', () => {
    it('acepta PNG y rechaza otros formatos', async () => {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      const subir = (nombre: string, tipo: string) =>
        request(http).post('/api/v1/uploads').set('Authorization', `Bearer ${tok.tienda}`).field('tipo', 'producto').attach('archivo', png, { filename: nombre, contentType: tipo });
      expect((await subir('foto.png', 'image/png').expect(201)).body.url).toMatch(/\/uploads\/productos\/.+\.png$/);
      await subir('doc.pdf', 'application/pdf').expect(400);
    });
  });

  describe('Panel de administración', () => {
    it('el tablero resume el momento y lista las alertas', async () => {
      const t = (await api('get', '/soporte/tablero', 'soporte').expect(200)).body;
      expect(t).toMatchObject({ pedidosEnCurso: expect.any(Number), ventasHoy: expect.any(Number), cuentasPorAprobar: expect.any(Number) });
      expect(Array.isArray(t.alertas)).toBe(true);
      // Un pedido listo hace 20 min sin repartidor aparece como alerta.
      const p = await manual(mover(TIENDA, 0.002));
      await ds.query(`UPDATE pedidos SET listo_en = now() - interval '20 minutes' WHERE id = $1`, [p.id]);
      const alertas = (await api('get', '/soporte/tablero', 'soporte')).body.alertas;
      expect(alertas).toContainEqual(expect.objectContaining({ tipo: 'sin_repartidor', pedidoId: p.id, folio: p.folio }));
      await api('get', '/soporte/tablero', 'cliente').expect(403);
    });

    it('lista tiendas con su dueño y abre la ficha; soporte puede pausarla y reanudarla', async () => {
      const lista = (await api('get', '/soporte/tiendas?q=Usuario%20tienda', 'soporte').expect(200)).body;
      const fila = lista.data.find((t) => t.id === id.tiendaId);
      expect(fila).toMatchObject({ dueno: { email: 'tienda@prueba.test' }, plan: expect.any(String), pedidos30d: expect.any(Number) });

      const ficha = (await api('get', `/soporte/tiendas/${id.tiendaId}`, 'soporte').expect(200)).body;
      expect(ficha).toMatchObject({ id: id.tiendaId, dueno: { email: 'tienda@prueba.test' }, comision: { aplicada: expect.any(Number) } });
      expect(ficha.menu.length).toBeGreaterThan(0);

      const abiertaAntes = ficha.abiertaAhora;
      const pausada = (await api('put', `/soporte/tiendas/${id.tiendaId}/pausa`, 'soporte', { minutos: 60, motivo: 'Quejas por pedidos incompletos' }).expect(200)).body;
      expect(pausada.pausadaHasta).toEqual(expect.any(String));
      expect(pausada.abiertaAhora).toBe(false);
      await api('put', `/soporte/tiendas/${id.tiendaId}/pausa`, 'soporte', { minutos: 60 }).expect(400); // sin motivo
      const reanudada = (await api('put', `/soporte/tiendas/${id.tiendaId}/pausa`, 'soporte', { minutos: 0, motivo: 'Ya se resolvió' }).expect(200)).body;
      expect(reanudada).toMatchObject({ pausadaHasta: null, abiertaAhora: abiertaAntes });
      const historial = (await api('get', `/soporte/usuarios/${reanudada.dueno.id}/eventos`, 'soporte')).body;
      expect(JSON.stringify(historial)).toContain('tienda_pausada');
    });

    it('admin da de alta, edita, da de baja y restaura una tienda', async () => {
      const nueva = {
        dueno: { nombre: 'Doña Lupe', email: 'lupe@prueba.test', telefono: '4611234567', password: 'Temporal123' },
        nombre: 'Gorditas Lupe', categoria: 'comida', direccion: 'Av. Tecnológico 100, Celaya', ubicacion: mover(TIENDA, 0.003),
      };
      await api('post', '/admin/tiendas', 'soporte', nueva).expect(403);
      await api('post', '/admin/tiendas', 'admin', { ...nueva, dueno: undefined }).expect(400);
      const ficha = (await api('post', '/admin/tiendas', 'admin', nueva).expect(201)).body;
      expect(ficha).toMatchObject({ nombre: 'Gorditas Lupe', abierta: false, eliminadaEn: null, dueno: { email: 'lupe@prueba.test', rol: 'tienda', estado: 'activo' } });
      await api('post', '/admin/tiendas', 'admin', nueva).expect(409); // el correo ya existe
      // El dueño entra con la contraseña temporal y ve su tienda.
      const sesion = (await api('post', '/auth/login', undefined, { email: 'lupe@prueba.test', password: 'Temporal123', app: 'tienda' }).expect(200)).body;
      const mia = await request(app.getHttpServer()).get('/api/v1/tiendas/mia').set('Authorization', `Bearer ${sesion.accessToken}`).expect(200);
      expect(mia.body.id).toBe(ficha.id);

      // Sucursal para un dueño existente.
      const sucursal = (await api('post', '/admin/tiendas', 'admin', { ...nueva, dueno: undefined, duenoId: ficha.dueno.id, nombre: 'Gorditas Lupe Norte' }).expect(201)).body;
      expect(sucursal.dueno.id).toBe(ficha.dueno.id);
      await api('post', '/admin/tiendas', 'admin', { ...nueva, dueno: undefined, duenoId: id.cliente }).expect(400); // no es cuenta de tienda

      const editada = (await api('patch', `/admin/tiendas/${ficha.id}`, 'admin', { nombre: 'Gorditas Doña Lupe', tiempoPreparacionMin: 15, abierta: true }).expect(200)).body;
      expect(editada).toMatchObject({ nombre: 'Gorditas Doña Lupe', tiempoPreparacionMin: 15, abierta: true });
      expect((await api('get', `/tiendas/${ficha.id}`, 'cliente').expect(200)).body.nombre).toBe('Gorditas Doña Lupe');

      await api('delete', `/admin/tiendas/${ficha.id}`, 'admin', {}).expect(400); // sin motivo
      await api('delete', `/admin/tiendas/${ficha.id}`, 'admin', { motivo: 'Cerró el negocio' }).expect(204);
      await api('get', `/tiendas/${ficha.id}`, 'cliente').expect(404);
      await api('patch', `/admin/tiendas/${ficha.id}`, 'admin', { nombre: 'X' }).expect(409);
      const activas = (await api('get', '/soporte/tiendas?q=Gorditas', 'soporte')).body.data.map((t) => t.id);
      expect(activas).toEqual([sucursal.id]);
      const bajas = (await api('get', '/soporte/tiendas?q=Gorditas&eliminadas=si', 'soporte')).body.data;
      expect(bajas).toEqual([expect.objectContaining({ id: ficha.id, eliminadaMotivo: 'Cerró el negocio' })]);
      expect((await api('get', `/soporte/tiendas/${ficha.id}`, 'soporte').expect(200)).body.eliminadaEn).toEqual(expect.any(String));

      const restaurada = (await api('post', `/admin/tiendas/${ficha.id}/restaurar`, 'admin').expect(200)).body;
      expect(restaurada).toMatchObject({ eliminadaEn: null, abierta: false });
      await api('get', `/tiendas/${ficha.id}`, 'cliente').expect(200);
      await api('post', `/admin/tiendas/${ficha.id}/restaurar`, 'admin').expect(409);
    });

    it('no da de baja una tienda con pedidos en curso', async () => {
      const p = await manual(mover(TIENDA, 0.002));
      const r = await api('delete', `/admin/tiendas/${id.tiendaId}`, 'admin', { motivo: 'Prueba' }).expect(409);
      expect(r.body.error).toBe('TIENE_PEDIDOS_ACTIVOS');
      expect(p.id).toBeDefined();
    });

    it('lista repartidores con conexión y vehículo, y arma el mapa de despacho', async () => {
      await api('put', '/repartidor/ubicacion', 'rep1', CERCA_DE_TIENDA).expect(204);
      await api('patch', '/repartidor/disponibilidad', 'rep1', { disponible: true }).expect(200);
      const conectados = (await api('get', '/soporte/repartidores?conectado=si', 'soporte').expect(200)).body.data;
      expect(conectados.find((r) => r.id === id.rep1)).toMatchObject({ conectado: true, ubicacion: CERCA_DE_TIENDA, entregasTotales: expect.any(Number) });
      const desconectados = (await api('get', '/soporte/repartidores?conectado=no', 'soporte')).body.data;
      expect(desconectados.some((r) => r.id === id.rep1)).toBe(false);

      const mapa = (await api('get', '/soporte/mapa', 'soporte').expect(200)).body;
      expect(mapa.repartidores.find((r) => r.id === id.rep1)).toMatchObject({ ubicacion: CERCA_DE_TIENDA });
      expect(mapa.pedidos.length).toBeGreaterThan(0);
      expect(mapa.pedidos[0]).toMatchObject({ folio: expect.stringMatching(/^R-/), tienda: { ubicacion: expect.any(Object) }, destino: expect.any(Object) });
    });

    it('oculta el texto de una reseña al público sin cambiar sus estrellas', async () => {
      const lista = (await api('get', `/soporte/resenas?tiendaId=${id.tiendaId}`, 'soporte').expect(200)).body.data;
      const r = lista.find((x) => x.comentario);
      expect(r).toBeDefined();
      await api('patch', `/soporte/resenas/${r.pedidoId}`, 'soporte', { oculta: true }).expect(400); // falta el motivo
      const oculta = (await api('patch', `/soporte/resenas/${r.pedidoId}`, 'soporte', { oculta: true, motivo: 'Lenguaje ofensivo' }).expect(200)).body;
      expect(oculta).toMatchObject({ oculta: true, ocultaMotivo: 'Lenguaje ofensivo', ocultaPor: 'soporte', comentario: r.comentario });

      const publica = (await api('get', `/tiendas/${id.tiendaId}/resenas`, 'cliente')).body;
      expect(publica.data.find((x) => x.pedidoId === r.pedidoId)).toMatchObject({ oculta: true, comentario: null, calificacion: r.estrellas });
      expect((await api('get', '/soporte/resenas?ocultas=si', 'soporte')).body.data.map((x) => x.pedidoId)).toContain(r.pedidoId);

      await api('patch', `/soporte/resenas/${r.pedidoId}`, 'soporte', { oculta: false }).expect(200);
      expect((await api('get', `/tiendas/${id.tiendaId}/resenas`, 'cliente')).body.data.find((x) => x.pedidoId === r.pedidoId).comentario).toBe(r.comentario);
    });

    it('admin corrige datos, pone una contraseña temporal y elimina cuentas; soporte no puede', async () => {
      await registrar('editable', 'cliente');
      await api('patch', `/admin/usuarios/${id.editable}`, 'soporte', { nombre: 'X' }).expect(403);
      const editado = (await api('patch', `/admin/usuarios/${id.editable}`, 'admin', { nombre: 'Laura Méndez', telefono: '4611234567' }).expect(200)).body;
      expect(editado).toMatchObject({ nombre: 'Laura Méndez', telefono: '4611234567' });
      expect((await api('patch', `/admin/usuarios/${id.editable}`, 'admin', { email: 'cliente@prueba.test' }).expect(409)).body.error).toBe('EMAIL_EN_USO');
      await api('patch', `/admin/usuarios/${id.editable}`, 'admin', { rol: 'admin' }).expect(400); // un cliente no cambia de rol

      await api('put', `/admin/usuarios/${id.editable}/password`, 'admin', { password: 'Temporal2026' }).expect(204);
      await api('post', '/auth/login', undefined, { email: 'editable@prueba.test', password: PASS, app: 'cliente' }).expect(401);
      await api('post', '/auth/login', undefined, { email: 'editable@prueba.test', password: 'Temporal2026', app: 'cliente' }).expect(200);

      await api('delete', `/admin/usuarios/${id.editable}`, 'admin', {}).expect(400); // sin motivo
      await api('delete', `/admin/usuarios/${id.editable}`, 'admin', { motivo: 'Pidió su baja por teléfono' }).expect(204);
      const eliminada = (await api('get', `/soporte/usuarios/${id.editable}`, 'soporte')).body;
      expect(eliminada).toMatchObject({ estado: 'eliminado', nombre: 'Usuario eliminado' });
      await api('post', '/auth/login', undefined, { email: 'editable@prueba.test', password: 'Temporal2026', app: 'cliente' }).expect(401);

      const yo = (await api('get', '/auth/me', 'admin')).body;
      expect((await api('delete', `/admin/usuarios/${yo.id}`, 'admin', { motivo: 'x' }).expect(403)).body.error).toBe('SIN_PERMISO');
    });

    it('series de métricas por día y por hora, con los mejores', async () => {
      const s = (await api('get', '/admin/metricas/series', 'admin').expect(200)).body;
      expect(s.porHora).toHaveLength(24);
      expect(s.porDia.length).toBeGreaterThan(0);
      expect(s.porDia[0]).toMatchObject({ dia: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), pedidos: expect.any(Number), ventas: expect.any(Number) });
      expect(s.topTiendas[0]).toMatchObject({ nombre: expect.any(String), ventas: expect.any(Number) });
      expect(s.tiempos).toHaveProperty('entregaMin');
      await api('get', '/admin/metricas/series', 'soporte').expect(403);
    });

    it('envía notificaciones generales a un tema o a todo un rol', async () => {
      const tema = (await api('post', '/admin/notificaciones', 'admin', { destino: 'tema', tema: 'promociones', titulo: 'Hoy envío gratis', cuerpo: 'Usa ENVIOGRATIS' }).expect(200)).body;
      expect(tema).toMatchObject({ destino: 'tema', tema: 'promociones', modo: 'simulada' });
      await api('post', '/admin/notificaciones', 'admin', { destino: 'tema', tema: 'todos', titulo: 'x', cuerpo: 'y' }).expect(400);
      const rol = (await api('post', '/admin/notificaciones', 'admin', { destino: 'rol', rol: 'repartidor', titulo: 'Llueve', cuerpo: 'Hay recargo de lluvia' }).expect(200)).body;
      expect(rol.destinatarios).toBeGreaterThan(0);
      const bandeja = (await api('get', '/notificaciones', 'rep1')).body;
      expect(JSON.stringify(bandeja)).toContain('Hay recargo de lluvia');
    });

    it('los tickets se pueden pasar a otra persona del equipo', async () => {
      const t = (await api('post', '/tickets', 'cliente', { asunto: 'Duda con mi cuenta', descripcion: 'No me llega el correo' }).expect(201)).body;
      const yo = (await api('get', '/auth/me', 'admin')).body;
      const pasado = (await api('patch', `/soporte/tickets/${t.id}`, 'soporte', { atendidoPor: yo.id }).expect(200)).body;
      expect(pasado).toMatchObject({ estado: 'en_atencion' });
      expect(JSON.stringify(pasado)).toContain(yo.id);
      await api('patch', `/soporte/tickets/${t.id}`, 'soporte', { atendidoPor: id.rep1 }).expect(400); // no es del equipo
    });

    it('la bitácora guarda lo que hace el equipo, sin contraseñas', async () => {
      const b = (await api('get', '/admin/bitacora', 'admin').expect(200)).body.data;
      const pausa = b.find((a) => a.accion === 'Pausó o reanudó una tienda');
      expect(pausa).toMatchObject({ actor: { nombre: 'soporte', rol: 'soporte' }, recursoId: id.tiendaId, detalle: { motivo: expect.any(String) } });
      const password = b.find((a) => a.accion === 'Puso una contraseña temporal');
      expect(password.detalle).toBeNull();
      expect(JSON.stringify(b)).not.toContain('Temporal2026');
      expect(b.some((a) => a.metodo === 'GET')).toBe(false);
      const filtrada = (await api('get', '/admin/bitacora?q=reseña', 'admin')).body.data;
      expect(filtrada.length).toBeGreaterThan(0);
      expect(filtrada.every((a) => a.accion === 'Moderó una reseña')).toBe(true);
      await api('get', '/admin/bitacora', 'soporte').expect(403);
    });
  });

  describe('Cartera, solicitudes de cuenta y límites de deuda', () => {
    const cartera = async (quien: string) => (await api('get', '/cartera', quien).expect(200)).body;
    const pedido = (extra: any = {}) => ({ tiendaId: id.tiendaId, direccionId: id.casaC, items: [{ productoId: id.pastor, cantidad: 2, opciones: [id.verde] }], ...extra });
    const crear = async (extra: any = {}) => (await api('post', '/pedidos', 'clienteC', pedido(extra)).expect(201)).body;
    const entregarConRep1 = async (pid: string) => {
      await api('post', `/pedidos/${pid}/aceptar`, 'tienda').expect(200);
      await api('post', `/pedidos/${pid}/listo`, 'tienda').expect(200);
      await api('post', `/repartidor/pedidos/${pid}/tomar`, 'rep1').expect(200);
      await api('post', `/soporte/pedidos/${pid}/completar`, 'soporte', { motivo: 'Prueba de cartera' }).expect(200);
    };
    const movsDe = async (quien: string, pid: string) => (await api('get', '/cartera?limit=100', quien)).body.movimientos.data.filter((x) => x.pedidoId === pid);

    beforeAll(async () => {
      await ds.query(`UPDATE tiendas SET abierta = true, pausada_hasta = NULL, usar_horario = false, eliminada_en = NULL WHERE id = $1`, [id.tiendaId]);
      await ds.query(`UPDATE productos SET stock = NULL, disponible = true WHERE id = $1`, [id.pastor]);
      await registrar('clienteC', 'cliente');
      id.casaC = (await api('post', '/direcciones', 'clienteC', { alias: 'Casa', texto: 'Av. Tecnológico 1500', ubicacion: CASA }).expect(201)).body.id;
    });

    it('cancelar tarde en efectivo cuesta la tarifa; la deuda se suma sola al siguiente pedido', async () => {
      const p = await crear();
      expect(p.cancelacion).toEqual({ permitida: true, cargo: 0 }); // la tienda aún no lo acepta
      await api('post', `/pedidos/${p.id}/aceptar`, 'tienda').expect(200);
      expect((await api('get', `/pedidos/${p.id}`, 'clienteC')).body.cancelacion).toEqual({ permitida: true, cargo: 25 });
      expect((await api('get', `/pedidos/${p.id}`, 'tienda')).body.cancelacion).toBeNull();
      await api('post', `/pedidos/${p.id}/cancelar`, 'clienteC', { codigo: 'cambio_de_opinion' }).expect(200);
      expect(await cartera('clienteC')).toMatchObject({ saldo: -25, estado: 'debe', limiteDeuda: 150, bloqueado: false });
      expect(await movsDe('tienda', p.id)).toEqual([expect.objectContaining({ tipo: 'compensacion_cancelacion', monto: 25 })]);

      const base = (await api('post', '/pedidos/cotizar', 'cliente', { ...pedido(), direccionId: id.casa }).expect(200)).body.total;
      const c = (await api('post', '/pedidos/cotizar', 'clienteC', pedido()).expect(200)).body;
      expect(c).toMatchObject({ deudaCobrada: 25, saldoAplicado: 0, total: base + 25 });

      // El adeudo se reserva al crear el pedido; si la tienda lo rechaza, vuelve a quedar pendiente.
      const r = await crear();
      expect(r).toMatchObject({ deudaCobrada: 25, total: base + 25 });
      expect((await cartera('clienteC')).saldo).toBe(0);
      await api('post', `/pedidos/${r.id}/rechazar`, 'tienda', { motivo: 'Sin gas' }).expect(200);
      expect((await cartera('clienteC')).saldo).toBe(-25);

      // Con límite más bajo que su adeudo, solo puede pagar con tarjeta.
      const conf = (await api('get', '/admin/configuracion', 'admin')).body.cartera;
      await api('put', '/admin/configuracion/cartera', 'soporte', conf).expect(403);
      await api('put', '/admin/configuracion/cartera', 'admin', { ...conf, limiteDeudaCliente: 20 }).expect(200);
      expect((await api('post', '/pedidos/cotizar', 'clienteC', pedido()).expect(409)).body.error).toBe('DEUDA_EXCEDIDA');
      await api('put', '/admin/configuracion/cartera', 'admin', conf).expect(200);

      // Se entrega: el repartidor cobró el adeudo en efectivo y ahora él se lo debe a PaPedir.
      const e = await crear();
      await entregarConRep1(e.id);
      expect((await cartera('clienteC')).saldo).toBe(0);
      expect(await movsDe('rep1', e.id)).toEqual(expect.arrayContaining([expect.objectContaining({ tipo: 'deuda_cobrada', monto: -25 })]));
      id.entregadoC = e.id;
    });

    it('soporte reembolsa a la cartera y el saldo se descuenta solo', async () => {
      await api('post', `/soporte/pedidos/${id.entregadoC}/reembolso`, 'soporte', { monto: 30 }).expect(400);
      await api('post', `/soporte/pedidos/${id.entregadoC}/reembolso`, 'soporte', { monto: 30, motivo: 'Faltó una bebida' }).expect(200);
      await api('post', `/soporte/pedidos/${id.entregadoC}/reembolso`, 'soporte', { monto: 10, motivo: 'Llegó frío' }).expect(200);
      expect((await api('post', `/soporte/pedidos/${id.entregadoC}/reembolso`, 'soporte', { monto: 5000, motivo: 'Todo' }).expect(409)).body.error).toBe('REEMBOLSO_EXCEDIDO');
      expect(await cartera('clienteC')).toMatchObject({ saldo: 40, estado: 'a_favor' });

      const base = (await api('post', '/pedidos/cotizar', 'cliente', { ...pedido(), direccionId: id.casa })).body.total;
      const p = await crear();
      expect(p).toMatchObject({ saldoAplicado: 40, total: base - 40 });
      expect((await cartera('clienteC')).saldo).toBe(0);
      // Si soporte lo cancela, el saldo regresa.
      await api('post', `/soporte/pedidos/${p.id}/cancelar`, 'soporte', { motivo: 'Prueba' }).expect(200);
      expect((await cartera('clienteC')).saldo).toBe(40);
      await api('post', `/soporte/pedidos/${p.id}/reembolso`, 'soporte', { monto: 5, motivo: 'X' }).expect(409); // no entregado

      // Entregado en efectivo: el repartidor cobró 40 de menos y PaPedir se los abona.
      const e = await crear();
      expect(e.saldoAplicado).toBe(40);
      await entregarConRep1(e.id);
      expect(await movsDe('rep1', e.id)).toEqual(expect.arrayContaining([expect.objectContaining({ tipo: 'saldo_cliente', monto: 40 })]));
      expect((await cartera('clienteC')).movimientos.data.map((x) => x.tipo)).toEqual(expect.arrayContaining(['pago_con_saldo', 'reverso_saldo', 'reembolso', 'cargo_cancelacion', 'pago_deuda']));
    });

    it('soporte cancela con cargo; con tarjeta puede reembolsar a la cartera', async () => {
      const p = await crear();
      await api('post', `/pedidos/${p.id}/aceptar`, 'tienda').expect(200);
      await api('post', `/soporte/pedidos/${p.id}/cancelar`, 'soporte', { motivo: 'El cliente ya no lo quiso', cobrarCargo: true }).expect(200);
      expect((await cartera('clienteC')).saldo).toBe(-25);
      await ds.query(`INSERT INTO movimientos (usuario_id, tipo, monto, descripcion) VALUES ($1, 'ajuste', 25, 'Prueba')`, [id.clienteC]);
      expect((await cartera('clienteC')).saldo).toBe(0);
    });

    it('con demasiada deuda, el repartidor no se conecta ni toma pedidos', async () => {
      const antes = (await cartera('rep1')).saldo;
      const conf = (await api('get', '/admin/configuracion', 'admin')).body.cartera;
      // Que deba 10 más de lo que tiene a favor, con un límite de 5.
      await api('post', '/admin/liquidaciones', 'admin', { usuarioId: id.rep1, sentido: 'pago', monto: Math.max(antes, 0) + 10, metodo: 'efectivo' }).expect(201);
      expect((await cartera('rep1')).saldo).toBeLessThan(0);
      await api('put', '/admin/configuracion/cartera', 'admin', { ...conf, limiteDeudaRepartidor: 5 }).expect(200);
      expect(await cartera('rep1')).toMatchObject({ estado: 'debe', bloqueado: true });
      const r = await api('patch', '/repartidor/disponibilidad', 'rep1', { disponible: true }).expect(409);
      expect(r.body.error).toBe('DEUDA_EXCEDIDA');
      await api('put', '/admin/configuracion/cartera', 'admin', conf).expect(200);
      expect((await cartera('rep1')).bloqueado).toBe(false);
    });

    it('soporte regresa una solicitud de cuenta con motivo y al aprobarla se limpia', async () => {
      await registrar('repNuevo', 'repartidor');
      await api('post', `/soporte/usuarios/${id.repNuevo}/rechazar`, 'soporte', {}).expect(400);
      await api('post', `/soporte/usuarios/${id.repNuevo}/rechazar`, 'cliente', { motivo: 'X' }).expect(403);
      const u = (await api('post', `/soporte/usuarios/${id.repNuevo}/rechazar`, 'soporte', { motivo: 'La licencia está borrosa' }).expect(200)).body;
      expect(u).toMatchObject({ estado: 'pendiente_aprobacion', motivoRechazo: 'La licencia está borrosa', rechazadaEn: expect.any(String) });
      expect((await api('get', '/auth/me', 'repNuevo')).body.motivoRechazo).toBe('La licencia está borrosa');
      expect((await api('patch', '/repartidor/disponibilidad', 'repNuevo', { disponible: true }).expect(409)).body.error).toBe('CUENTA_PENDIENTE');
      const ok = (await api('post', `/soporte/usuarios/${id.repNuevo}/aprobar`, 'admin').expect(200)).body;
      expect(ok).toMatchObject({ estado: 'activo', motivoRechazo: null });
      await api('post', `/soporte/usuarios/${id.repNuevo}/rechazar`, 'soporte', { motivo: 'Ya no' }).expect(409);
    });
  });
});
