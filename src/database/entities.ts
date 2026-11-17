import {
  Column, CreateDateColumn, Entity, Generated, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';
import { EstadoCuenta, EstadoPedido, Rol } from '../config/reglas';

// PostgreSQL devuelve numeric como texto; lo convertimos a number.
const dinero = { type: 'numeric' as const, precision: 10, scale: 2, transformer: { to: (v: any) => v, from: (v: any) => (v == null ? null : Number(v)) } };
const fecha = { type: 'timestamptz' as const };

// Nota: las columnas `ubicacion` (geography) las genera la base de datos a partir de lat/lng
// (ver la migración inicial). Aquí solo se mapean lat y lng.

@Entity('usuarios')
export class Usuario {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() nombre: string;
  @Column({ unique: true }) email: string;
  @Column() passwordHash: string;
  @Column({ nullable: true }) telefono: string | null;
  @Column({ type: 'text' }) rol: Rol;
  @Column({ type: 'text', default: 'activo' }) estado: EstadoCuenta;
  @Column({ nullable: true }) motivoBaneo: string | null;
  /** Solo repartidores: conectado para recibir pedidos. */
  @Column({ default: false }) disponible: boolean;
  @Column({ type: 'double precision', nullable: true }) lat: number | null;
  @Column({ type: 'double precision', nullable: true }) lng: number | null;
  @Column({ ...fecha, nullable: true }) ubicacionEn: Date | null;
  @Column({ type: 'text', nullable: true }) fotoUrl: string | null;
  @Column({ ...fecha, nullable: true }) emailVerificadoEn: Date | null;
  @Column({ type: 'text', nullable: true }) terminosVersion: string | null;
  @Column({ ...fecha, nullable: true }) terminosAceptadosEn: Date | null;
  @Column({ type: 'int', default: 0 }) intentosFallidos: number;
  @Column({ ...fecha, nullable: true }) bloqueadoHasta: Date | null;
  @Column({ ...fecha, nullable: true }) eliminadoEn: Date | null;
  /** Solo repartidores: promedio de las calificaciones de los clientes. */
  @Column({ type: 'numeric', precision: 3, scale: 2, nullable: true, transformer: dinero.transformer }) calificacion: number | null;
  @CreateDateColumn(fecha) creadoEn: Date;
}

@Entity('vehiculos')
export class Vehiculo {
  @PrimaryColumn('uuid') repartidorId: string;
  @Column({ type: 'text' }) tipo: 'moto' | 'bicicleta' | 'auto';
  @Column({ type: 'text', nullable: true }) marca: string | null;
  @Column({ type: 'text', nullable: true }) modelo: string | null;
  @Column() color: string;
  @Column({ type: 'text', nullable: true }) placa: string | null;
  @UpdateDateColumn(fecha) actualizadoEn: Date;
}

/** Documentos privados (INE, licencia...). El archivo vive en un bucket privado; aquí solo su ruta. */
@Entity('documentos')
export class Documento {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') usuarioId: string;
  @Column() tipo: string;
  @Column() ruta: string;
  @Column() mime: string;
  @Column({ type: 'text', default: 'pendiente' }) estado: 'pendiente' | 'aprobado' | 'rechazado';
  @Column({ type: 'text', nullable: true }) motivo: string | null;
  @Column({ type: 'uuid', nullable: true }) revisadoPor: string | null;
  @Column({ ...fecha, nullable: true }) revisadoEn: Date | null;
  @CreateDateColumn(fecha) creadoEn: Date;
}

/** Códigos de 6 dígitos enviados por correo (recuperar contraseña, verificar correo). Solo se guarda el hash. */
@Entity('codigos_verificacion')
export class CodigoVerificacion {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') usuarioId: string;
  @Column({ type: 'text' }) proposito: 'recuperar_password' | 'verificar_email';
  @Column() codigoHash: string;
  @Column(fecha) expiraEn: Date;
  @Column({ type: 'int', default: 0 }) intentos: number;
  @Column({ ...fecha, nullable: true }) usadoEn: Date | null;
  @CreateDateColumn(fecha) creadoEn: Date;
}

/** Bitácora de cuentas: registro, aprobación, baneo, cambios de contraseña, eliminación... */
@Entity('eventos_cuenta')
export class EventoCuenta {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') usuarioId: string;
  @Column() tipo: string;
  @Column({ type: 'uuid', nullable: true }) actorId: string | null;
  @Column({ type: 'text', nullable: true }) actorRol: Rol | null;
  @Column({ type: 'text', nullable: true }) detalle: string | null;
  @CreateDateColumn(fecha) creadoEn: Date;
}

@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') usuarioId: string;
  @Column({ unique: true }) tokenHash: string;
  @Column(fecha) expiraEn: Date;
  @CreateDateColumn(fecha) creadoEn: Date;
}

@Entity('dispositivos')
export class Dispositivo {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') usuarioId: string;
  @Column({ unique: true }) fcmToken: string;
  @Column() app: string;
  @UpdateDateColumn(fecha) actualizadoEn: Date;
}

@Entity('direcciones')
export class Direccion {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') clienteId: string;
  @Column() alias: string;
  @Column() texto: string;
  @Column({ nullable: true }) referencias: string | null;
  @Column('double precision') lat: number;
  @Column('double precision') lng: number;
  @CreateDateColumn(fecha) creadoEn: Date;
}

@Entity('tiendas')
export class Tienda {
  @PrimaryGeneratedColumn('uuid') id: string;
  /** Un dueño puede tener varias sucursales. */
  @Column('uuid') ownerId: string;
  @Column() nombre: string;
  @Column() categoria: string;
  @Column({ nullable: true }) descripcion: string | null;
  @Column({ nullable: true }) imagenUrl: string | null;
  @Column({ nullable: true }) telefono: string | null;
  @Column() direccion: string;
  @Column('double precision') lat: number;
  @Column('double precision') lng: number;
  @Column({ default: false }) abierta: boolean;
  @Column({ type: 'int', default: 20 }) tiempoPreparacionMin: number;
  /** true = además de `abierta`, solo recibe pedidos dentro de su horario semanal. */
  @Column({ default: false }) usarHorario: boolean;
  /** Pausa temporal: no recibe pedidos hasta esta hora. */
  @Column({ ...fecha, nullable: true }) pausadaHasta: Date | null;
  /** Comisión especial para esta tienda; null = la general de /admin/configuracion. */
  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true, transformer: dinero.transformer }) comisionPct: number | null;
  @Column({ type: 'numeric', precision: 3, scale: 2, nullable: true, transformer: dinero.transformer }) calificacion: number | null;
  @CreateDateColumn(fecha) creadoEn: Date;
}

@Entity('horarios_tienda')
export class HorarioTienda {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') tiendaId: string;
  /** 0 = domingo … 6 = sábado */
  @Column('smallint') dia: number;
  /** 'HH:MM:SS' en hora de Celaya */
  @Column('time') abre: string;
  @Column('time') cierra: string;
}

@Entity('categorias_producto')
export class CategoriaProducto {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') tiendaId: string;
  @Column() nombre: string;
  @Column({ type: 'int', default: 0 }) orden: number;
}

@Entity('productos')
export class Producto {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') tiendaId: string;
  @Column({ type: 'uuid', nullable: true }) categoriaId: string | null;
  @Column() nombre: string;
  @Column({ nullable: true }) descripcion: string | null;
  @Column(dinero) precio: number;
  @Column({ nullable: true }) imagenUrl: string | null;
  /** false = agotado (se muestra pero no se puede pedir). */
  @Column({ default: true }) disponible: boolean;
  /** Borrado lógico: los pedidos pasados siguen apuntando al producto. */
  @Column({ default: false }) eliminado: boolean;
  /** Inventario: null = sin control de existencias. Baja al crear pedidos y regresa si se cancelan. */
  @Column({ type: 'int', nullable: true }) stock: number | null;
  @Column({ type: 'jsonb', default: () => "'[]'" }) imagenes: string[];
  @CreateDateColumn(fecha) creadoEn: Date;
}

/** Grupo de opciones de un producto (ej. "Tamaño": elegir 1; "Extras": hasta 3). */
@Entity('grupos_opciones')
export class GrupoOpciones {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') productoId: string;
  @Column() nombre: string;
  @Column({ type: 'int', default: 0 }) minimo: number;
  @Column({ type: 'int', default: 1 }) maximo: number;
  @Column({ type: 'int', default: 0 }) orden: number;
}

@Entity('opciones')
export class Opcion {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') grupoId: string;
  @Column() nombre: string;
  @Column(dinero) precioExtra: number;
  @Column({ default: true }) disponible: boolean;
  @Column({ type: 'int', default: 0 }) orden: number;
}

export type OpcionElegida = { grupo: string; nombre: string; precioExtra: number };

@Entity('viajes')
export class Viaje {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') repartidorId: string;
  @Column({ type: 'text', default: 'activo' }) estado: 'activo' | 'finalizado';
  @CreateDateColumn(fecha) creadoEn: Date;
  @Column({ ...fecha, nullable: true }) finalizadoEn: Date | null;
}

@Entity('pedidos')
export class Pedido {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'int', insert: false, update: false }) @Generated('increment') folioNum: number;
  @Column({ type: 'text', default: 'creado' }) estado: EstadoPedido;
  @Column({ type: 'text' }) origen: 'app' | 'manual';
  @Column('uuid') tiendaId: string;
  @Column({ type: 'uuid', nullable: true }) clienteId: string | null;
  // El destino se copia al pedido: no cambia aunque el cliente edite o borre su dirección.
  @Column() destinoNombre: string;
  @Column() destinoTelefono: string;
  @Column() destinoDireccion: string;
  @Column({ nullable: true }) destinoReferencias: string | null;
  @Column('double precision') destinoLat: number;
  @Column('double precision') destinoLng: number;
  @Column({ nullable: true }) descripcion: string | null;
  @Column(dinero) subtotal: number;
  @Column(dinero) costoEnvio: number;
  @Column(dinero) total: number;
  @Column({ ...dinero, precision: 6 }) distanciaKm: number;
  @Column({ type: 'text', default: 'efectivo' }) metodoPago: 'efectivo';
  @Column({ nullable: true }) codigoEntrega: string | null;
  @Column({ nullable: true }) notas: string | null;
  @Column({ type: 'uuid', nullable: true }) repartidorId: string | null;
  @Column({ type: 'uuid', nullable: true }) viajeId: string | null;
  @Column({ nullable: true }) evidenciaUrl: string | null;
  @Column({ ...fecha, nullable: true }) listoEn: Date | null;
  @Column({ ...fecha, nullable: true }) entregadoEn: Date | null;
  @Column({ default: false }) soporteAvisado: boolean;
  @Column({ ...dinero, default: 0 }) propina: number;
  @Column({ ...dinero, default: 0 }) descuento: number;
  @Column({ type: 'uuid', nullable: true }) cuponId: string | null;
  /** Quién paga el descuento del cupón: la tienda (cobra menos) o la plataforma (se lo reembolsa al repartidor). */
  @Column({ type: 'text', nullable: true }) descuentoAbsorbe: 'plataforma' | 'tienda' | null;
  /** Lo que el repartidor le paga a la tienda: subtotal menos el descuento si lo absorbe la tienda. */
  @Column(dinero) montoTienda: number;
  @Column({ type: 'jsonb', default: () => "'[]'" }) recargos: Recargo[];
  /** Pedidos de varias tiendas hechos en un mismo carrito. */
  @Column({ type: 'uuid', nullable: true }) grupoId: string | null;
  /** Hora de entrega deseada de un pedido programado. */
  @Column({ ...fecha, nullable: true }) programadoPara: Date | null;
  @Column({ ...fecha, nullable: true }) enviadoATiendaEn: Date | null;
  @Column({ type: 'text', nullable: true }) motivoCodigo: string | null;
  @Column({ ...dinero, nullable: true }) comisionTienda: number | null;
  @Column({ ...dinero, nullable: true }) comisionEnvio: number | null;
  @CreateDateColumn(fecha) creadoEn: Date;
  @UpdateDateColumn(fecha) actualizadoEn: Date;
}

export type Recargo = { concepto: string; monto: number };

@Entity('pedido_items')
export class PedidoItem {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') pedidoId: string;
  @Column('uuid') productoId: string;
  /** Nombre y precio se copian al crear el pedido. */
  @Column() nombre: string;
  @Column('int') cantidad: number;
  /** Precio del producto + extras de las opciones elegidas. */
  @Column(dinero) precioUnitario: number;
  @Column({ type: 'jsonb', default: () => "'[]'" }) opciones: OpcionElegida[];
}

@Entity('eventos_pedido')
export class EventoPedido {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') pedidoId: string;
  @Column() tipo: string;
  @Column({ type: 'uuid', nullable: true }) usuarioId: string | null;
  @Column({ type: 'text', nullable: true }) rol: Rol | null;
  @Column({ nullable: true }) detalle: string | null;
  @Column({ type: 'double precision', nullable: true }) lat: number | null;
  @Column({ type: 'double precision', nullable: true }) lng: number | null;
  @CreateDateColumn(fecha) creadoEn: Date;
}

@Entity('calificaciones')
export class Calificacion {
  @PrimaryColumn('uuid') pedidoId: string;
  @Column('uuid') tiendaId: string;
  @Column({ type: 'uuid', nullable: true }) repartidorId: string | null;
  @Column('int') tienda: number;
  @Column('int') repartidor: number;
  @Column({ nullable: true }) comentario: string | null;
  /** Respuesta pública de la tienda a la reseña. */
  @Column({ type: 'text', nullable: true }) respuesta: string | null;
  @Column({ ...fecha, nullable: true }) respondidoEn: Date | null;
  @CreateDateColumn(fecha) creadoEn: Date;
}

@Entity('favoritos')
export class Favorito {
  @PrimaryColumn('uuid') clienteId: string;
  @PrimaryColumn('uuid') tiendaId: string;
  @CreateDateColumn(fecha) creadoEn: Date;
}

@Entity('cupones')
export class Cupon {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ unique: true }) codigo: string;
  @Column({ type: 'text', nullable: true }) descripcion: string | null;
  @Column({ type: 'text' }) tipo: 'porcentaje' | 'monto' | 'envio_gratis';
  @Column(dinero) valor: number;
  @Column({ ...dinero, nullable: true }) maximoDescuento: number | null;
  @Column({ ...dinero, default: 0 }) minimoCompra: number;
  /** null = cupón de la plataforma (válido en todas las tiendas, lo paga PaPedir). */
  @Column({ type: 'uuid', nullable: true }) tiendaId: string | null;
  @Column({ ...fecha, nullable: true }) inicio: Date | null;
  @Column({ ...fecha, nullable: true }) fin: Date | null;
  @Column({ type: 'int', nullable: true }) usosMaximos: number | null;
  @Column({ type: 'int', default: 1 }) usosPorCliente: number;
  @Column({ default: false }) soloPrimerPedido: boolean;
  @Column({ default: true }) activo: boolean;
  @Column({ type: 'uuid', nullable: true }) creadoPor: string | null;
  @CreateDateColumn(fecha) creadoEn: Date;
}

@Entity('notificaciones')
export class Notificacion {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') usuarioId: string;
  @Column() titulo: string;
  @Column() cuerpo: string;
  @Column({ type: 'jsonb', default: () => "'{}'" }) datos: Record<string, string>;
  @Column({ ...fecha, nullable: true }) leidaEn: Date | null;
  @CreateDateColumn(fecha) creadoEn: Date;
}

/** Chat entre el cliente y el repartidor de un pedido en curso. */
@Entity('mensajes_pedido')
export class MensajePedido {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') pedidoId: string;
  @Column('uuid') autorId: string;
  @Column({ type: 'text' }) autorRol: Rol;
  @Column() texto: string;
  @CreateDateColumn(fecha) creadoEn: Date;
}

/** Zona de cobertura. El polígono (geography) se lee y escribe con SQL; aquí no se mapea. */
@Entity('zonas')
export class Zona {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() nombre: string;
  @Column({ default: true }) activa: boolean;
  @Column({ ...dinero, default: 0 }) recargo: number;
  @CreateDateColumn(fecha) creadoEn: Date;
}

@Entity('configuracion')
export class Configuracion {
  @PrimaryColumn() clave: string;
  @Column({ type: 'jsonb' }) valor: any;
  @Column({ type: 'uuid', nullable: true }) actualizadoPor: string | null;
  @UpdateDateColumn(fecha) actualizadoEn: Date;
}

@Entity('liquidaciones')
export class Liquidacion {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') usuarioId: string;
  /** cobro = PaPedir recibe dinero del usuario; pago = PaPedir le paga. */
  @Column({ type: 'text' }) sentido: 'cobro' | 'pago';
  @Column(dinero) monto: number;
  @Column({ type: 'text' }) metodo: 'efectivo' | 'transferencia';
  @Column({ type: 'text', nullable: true }) referencia: string | null;
  @Column({ type: 'text', nullable: true }) nota: string | null;
  @Column('uuid') registradoPor: string;
  @CreateDateColumn(fecha) creadoEn: Date;
}

/** Cuenta corriente con PaPedir. monto > 0 = el usuario le debe a la plataforma; < 0 = la plataforma le debe. */
@Entity('movimientos')
export class Movimiento {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') usuarioId: string;
  @Column({ type: 'uuid', nullable: true }) tiendaId: string | null;
  @Column({ type: 'uuid', nullable: true }) pedidoId: string | null;
  @Column({ type: 'uuid', nullable: true }) liquidacionId: string | null;
  @Column({ type: 'text' }) tipo: 'comision_tienda' | 'comision_envio' | 'descuento_plataforma' | 'liquidacion';
  @Column(dinero) monto: number;
  @Column() descripcion: string;
  @CreateDateColumn(fecha) creadoEn: Date;
}

@Entity('tickets')
export class Ticket {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'int', insert: false, update: false }) @Generated('increment') folioNum: number;
  @Column() asunto: string;
  @Column() descripcion: string;
  @Column({ type: 'text', default: 'abierto' }) estado: 'abierto' | 'en_atencion' | 'resuelto' | 'cerrado';
  @Column({ type: 'uuid', nullable: true }) pedidoId: string | null;
  @Column('uuid') creadoPor: string;
  @Column({ type: 'uuid', nullable: true }) atendidoPor: string | null;
  @Column({ ...fecha, nullable: true }) resueltoEn: Date | null;
  @CreateDateColumn(fecha) creadoEn: Date;
  @UpdateDateColumn(fecha) actualizadoEn: Date;
}

@Entity('mensajes')
export class Mensaje {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') ticketId: string;
  @Column('uuid') autorId: string;
  @Column({ type: 'text' }) autorRol: Rol;
  @Column() texto: string;
  @CreateDateColumn(fecha) creadoEn: Date;
}

export const ENTIDADES = [
  Usuario, CodigoVerificacion, EventoCuenta, RefreshToken, Dispositivo, Direccion, Tienda, CategoriaProducto, Producto, Viaje, Pedido, PedidoItem,
  EventoPedido, Calificacion, Ticket, Mensaje, Vehiculo, Documento, HorarioTienda, GrupoOpciones, Opcion, Favorito, Cupon,
  Notificacion, MensajePedido, Zona, Configuracion, Liquidacion, Movimiento,
];
