/**
 * Datos de prueba para desarrollo:  npm run seed            (no hace nada si ya hay datos)
 *                                   npm run seed -- --reset (borra TODO y vuelve a sembrar)
 * Contraseña de todos los usuarios: PaPedir123!
 */
import { NestFactory } from '@nestjs/core';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { PedidosService } from '../pedidos/pedidos.service';
import { CategoriaProducto, Direccion, Producto, Tienda, Usuario } from './entities';

const PASSWORD = 'PaPedir123!';

const TIENDAS = [
  {
    email: 'tienda@papedir.test', dueno: 'José Pérez', nombre: 'Tacos Don Pepe', categoria: 'comida', telefono: '4615550001',
    direccion: 'Calle Hidalgo 120, Centro, Celaya', lat: 20.5222, lng: -100.8123, prep: 20, descripcion: 'Tacos al pastor y de bistec desde 1998',
    menu: {
      Tacos: [['Orden de pastor', '5 tacos con piña', 85], ['Orden de bistec', '5 tacos', 95], ['Gringa', 'Pastor con queso en tortilla de harina', 65], ['Volcán de pastor', null, 35]],
      Bebidas: [['Agua de horchata 1 L', null, 35], ['Refresco 600 ml', null, 25]],
      Postres: [['Flan napolitano', null, 40]],
    },
  },
  {
    email: 'abarrotes@papedir.test', dueno: 'Laura Ramírez', nombre: 'Abarrotes La Esquina', categoria: 'abarrotes', telefono: '4615550002',
    direccion: 'Av. Insurgentes 45, Celaya', lat: 20.5281, lng: -100.819, prep: 10, descripcion: 'Todo para tu despensa',
    menu: {
      Despensa: [['Arroz 1 kg', null, 32], ['Frijol negro 1 kg', null, 38], ['Aceite 1 L', null, 45], ['Huevo 12 pzas', null, 42]],
      Lácteos: [['Leche entera 1 L', null, 28], ['Queso panela 400 g', null, 72]],
      Botanas: [['Papas fritas 170 g', null, 48]],
    },
  },
  {
    email: 'farmacia@papedir.test', dueno: 'Ricardo Soto', nombre: 'Farmacia San Rafael', categoria: 'farmacia', telefono: '4615550003',
    direccion: 'Blvd. Adolfo López Mateos 310, Celaya', lat: 20.519, lng: -100.808, prep: 10, descripcion: 'Medicamentos y cuidado personal',
    menu: {
      'Cuidado personal': [['Shampoo 400 ml', null, 78], ['Pasta dental 100 ml', null, 42], ['Jabón de tocador', null, 18]],
      Botiquín: [['Alcohol 250 ml', null, 30], ['Curitas 20 pzas', null, 25], ['Suero oral 500 ml', null, 28]],
    },
  },
  {
    email: 'ferreteria@papedir.test', dueno: 'Miguel Ángel Torres', nombre: 'Ferretería El Tornillo', categoria: 'materiales', telefono: '4615550004',
    direccion: 'Av. Irrigación 210, Celaya', lat: 20.5305, lng: -100.805, prep: 15, descripcion: 'Herramienta y material eléctrico',
    menu: {
      Herramienta: [['Martillo de uña', null, 145], ['Juego de desarmadores', '6 piezas', 189], ['Cinta métrica 5 m', null, 89]],
      Eléctrico: [['Foco LED 9 W', null, 35], ['Cinta de aislar', null, 22], ['Extensión 3 m', null, 110]],
    },
  },
] as const;

/** Pedidos manuales listos para recoger: [índice de tienda, destinatario, dirección, lat, lng, monto a cobrar]. */
const PEDIDOS = [
  [0, 'Luis Hernández', 'Av. Tecnológico 510, Celaya', 20.5318, -100.8139, 180],
  [0, 'María Fernanda Ruiz', 'Calle Allende 88, Centro, Celaya', 20.5255, -100.8172, 95],
  [1, 'Carlos Méndez', 'Calle Morelos 230, Celaya', 20.5332, -100.8155, 250],
  [1, 'Sofía Aguilar', 'Priv. Los Olivos 14, Celaya', 20.5236, -100.8241, 0],
  [2, 'Jorge Castillo', 'Av. 12 de Octubre 402, Celaya', 20.5148, -100.8131, 320],
  [3, 'Daniela Ortiz', 'Calle Guadalupe 77, Celaya', 20.5268, -100.8009, 410],
] as const;

async function main() {
  const reset = process.argv.includes('--reset');
  if (process.env.NODE_ENV === 'production' && !process.argv.includes('--force')) {
    throw new Error('El seed no corre en producción. Usa --force solo si de verdad quieres datos de prueba ahí.');
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const ds = app.get(DataSource);

  if (reset) {
    await ds.query(`TRUNCATE mensajes, tickets, calificaciones, eventos_pedido, pedido_items, pedidos, viajes, productos,
      categorias_producto, tiendas, direcciones, dispositivos, refresh_tokens, usuarios RESTART IDENTITY CASCADE`);
  } else if (await ds.getRepository(Usuario).count()) {
    console.log('La base ya tiene datos; no se sembró nada. Usa "npm run seed -- --reset" para empezar de cero.');
    return app.close();
  }

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const usuarios = ds.getRepository(Usuario);
  const crear = (u: Partial<Usuario>) => usuarios.save(usuarios.create({ passwordHash, estado: 'activo', ...u }));

  const cliente = await crear({ nombre: 'Ana López', email: 'cliente@papedir.test', telefono: '4611234567', rol: 'cliente' });
  await crear({ nombre: 'Carlos Ruiz', email: 'repartidor@papedir.test', telefono: '4611112233', rol: 'repartidor', lat: 20.524, lng: -100.814, ubicacionEn: new Date() });
  await crear({ nombre: 'Paola Vega', email: 'repartidor2@papedir.test', telefono: '4611112244', rol: 'repartidor', lat: 20.527, lng: -100.817, ubicacionEn: new Date() });
  await crear({ nombre: 'Soporte PaPedir', email: 'soporte@papedir.test', rol: 'soporte' });
  await crear({ nombre: 'Admin PaPedir', email: 'admin@papedir.test', rol: 'admin' });

  await ds.getRepository(Direccion).save([
    { clienteId: cliente.id, alias: 'Casa', texto: 'Av. Tecnológico 1500, Celaya, Gto.', referencias: 'Portón negro', lat: 20.533, lng: -100.814 },
    { clienteId: cliente.id, alias: 'Trabajo', texto: 'Blvd. Adolfo López Mateos 800, Celaya, Gto.', referencias: null, lat: 20.521, lng: -100.8195 },
  ]);

  const duenos: Usuario[] = [];
  for (const t of TIENDAS) {
    const dueno = await crear({ nombre: t.dueno, email: t.email, telefono: t.telefono, rol: 'tienda' });
    duenos.push(dueno);
    const tienda = await ds.getRepository(Tienda).save({
      ownerId: dueno.id, nombre: t.nombre, categoria: t.categoria, descripcion: t.descripcion, telefono: t.telefono,
      direccion: t.direccion, lat: t.lat, lng: t.lng, abierta: true, tiempoPreparacionMin: t.prep,
    });
    let orden = 1;
    for (const [categoria, productos] of Object.entries(t.menu)) {
      const c = await ds.getRepository(CategoriaProducto).save({ tiendaId: tienda.id, nombre: categoria, orden: orden++ });
      await ds.getRepository(Producto).save(
        (productos as readonly (readonly [string, string | null, number])[]).map(([nombre, descripcion, precio]) => ({
          tiendaId: tienda.id, categoriaId: c.id, nombre, descripcion, precio,
        })),
      );
    }
  }

  // Tienda sin aprobar, para probar la pantalla de "cuenta en revisión".
  const pendiente = await crear({ nombre: 'Rosa Jiménez', email: 'tienda.pendiente@papedir.test', telefono: '4615550009', rol: 'tienda', estado: 'pendiente_aprobacion' });
  await ds.getRepository(Tienda).save({
    ownerId: pendiente.id, nombre: 'Postres Doña Rosa', categoria: 'comida', telefono: '4615550009',
    direccion: 'Calle Juárez 15, Celaya', lat: 20.5244, lng: -100.8101,
  });

  // Pedidos listos para que la App Repartidor tenga qué tomar (se crean con las mismas reglas que la API).
  const pedidos = app.get(PedidosService);
  for (const [i, nombre, direccion, lat, lng, montoACobrar] of PEDIDOS) {
    await pedidos.crearManual(duenos[i], {
      destino: { nombre, telefono: '4619876543', direccion, ubicacion: { lat, lng } },
      descripcion: `Pedido de ${TIENDAS[i].nombre}`,
      montoACobrar,
    });
  }

  console.log(`Listo: ${await usuarios.count()} usuarios, ${TIENDAS.length + 1} tiendas, ${PEDIDOS.length} pedidos listos para recoger.`);
  console.log(`Contraseña de todos: ${PASSWORD}`);
  await app.close();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
