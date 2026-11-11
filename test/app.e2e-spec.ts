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
      nombre: `Usuario ${alias}`, email: `${alias}@prueba.test`, password: PASS, telefono: '4610000000', rol, ...extra,
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
      api('post', '/auth/register', undefined, { nombre: 'X', email: 'x@prueba.test', password: PASS, telefono: '4610000000', rol: 'tienda' }).expect(400));

    it('rechaza correos repetidos y contraseñas incorrectas', async () => {
      const r = await api('post', '/auth/register', undefined, { nombre: 'Otro', email: 'CLIENTE@prueba.test', password: PASS, telefono: '4610000000', rol: 'cliente' }).expect(409);
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
