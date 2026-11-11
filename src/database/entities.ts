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
  @Column({ type: 'uuid', unique: true }) ownerId: string;
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
  @Column({ type: 'numeric', precision: 3, scale: 2, nullable: true, transformer: dinero.transformer }) calificacion: number | null;
  @CreateDateColumn(fecha) creadoEn: Date;
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
  @CreateDateColumn(fecha) creadoEn: Date;
}

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
  @CreateDateColumn(fecha) creadoEn: Date;
  @UpdateDateColumn(fecha) actualizadoEn: Date;
}

@Entity('pedido_items')
export class PedidoItem {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') pedidoId: string;
  @Column('uuid') productoId: string;
  /** Nombre y precio se copian al crear el pedido. */
  @Column() nombre: string;
  @Column('int') cantidad: number;
  @Column(dinero) precioUnitario: number;
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
  Usuario, RefreshToken, Dispositivo, Direccion, Tienda, CategoriaProducto, Producto, Viaje, Pedido, PedidoItem,
  EventoPedido, Calificacion, Ticket, Mensaje,
];
