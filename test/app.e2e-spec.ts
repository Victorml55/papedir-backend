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

    it('la tienda acepta y marca listo; el cliente ya no puede cancelar', async () => {
      await api('post', `/pedidos/${id.pedido}/listo`, 'tienda').expect(409); // todavía no lo acepta
      await api('post', `/pedidos/${id.pedido}/aceptar`, 'tienda').expect(200);
      expect((await api('post', `/pedidos/${id.pedido}/cancelar`, 'cliente', { motivo: 'Ya no' }).expect(409)).body.error).toBe('TRANSICION_INVALIDA');
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
      await api('post', '/tickets', 'rep2', { pedidoId: id.pedido, asunto: 'No es mío', descripcion: '...' }).expect(403);
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
      await ds.query(`UPDATE pedidos SET creado_en = now() - interval '6 minutes' WHERE id = $1`, [viejo]);

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

    it('sucursales: crea una copiando el menú y trabaja con X-Tienda-Id', async () => {
      const conSucursal = (metodo: any, ruta: string, tiendaId: string, cuerpo?: any) => api(metodo, ruta, 'tienda', cuerpo).set('X-Tienda-Id', tiendaId);
      const s = (await api('post', '/tiendas/mias', 'tienda', {
        nombre: 'Tacos Don Pepe Norte', categoria: 'comida', direccion: 'Av. Tecnológico 900', ubicacion: mover(TIENDA, 0.01), copiarMenuDe: id.tiendaId,
      }).expect(201)).body;
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

  describe('Imágenes', () => {
    it('acepta PNG y rechaza otros formatos', async () => {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      const subir = (nombre: string, tipo: string) =>
        request(http).post('/api/v1/uploads').set('Authorization', `Bearer ${tok.tienda}`).field('tipo', 'producto').attach('archivo', png, { filename: nombre, contentType: tipo });
      expect((await subir('foto.png', 'image/png').expect(201)).body.url).toMatch(/\/uploads\/productos\/.+\.png$/);
      await subir('doc.pdf', 'application/pdf').expect(400);
    });
  });
});
