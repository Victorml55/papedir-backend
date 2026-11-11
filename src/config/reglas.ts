/**
 * Reglas de negocio de PaPedir (ver "PaPedir — Definición del proyecto").
 * Son el único lugar donde viven estos valores: cambiar uno aquí cambia el comportamiento de toda la API.
 */
export const REGLAS = {
  envio: {
    tarifaBase: 25, // MXN, cubre hasta kmIncluidos
    kmIncluidos: 2,
    porKmExtra: 7, // MXN por km adicional o fracción
    maxKm: 8, // cobertura máxima
    factorCalles: 1.3, // línea recta × 1.3 para aproximar calles
    minPorKm: 3, // para el tiempo estimado
  },
  pedido: {
    minimoProductos: 50,
    maximoEfectivo: 1500,
    minutosParaAceptar: 5,
    horasParaCalificar: 24,
  },
  repartidor: {
    radioKm: 3,
    radioAmpliadoKm: 6, // pedidos con más de minutosAmpliar sin repartidor
    minutosAmpliar: 5,
    minutosAvisoSoporte: 15,
    maxPedidosPorViaje: 4,
    encadenarTiendaM: 1500,
    encadenarDestinoM: 3000,
    geocercaM: 150,
  },
  ticket: { horasCierreAutomatico: 48 },
  upload: { maxBytes: 5 * 1024 * 1024, mimes: ['image/jpeg', 'image/png', 'image/webp'] },
} as const;

export type Rol = 'cliente' | 'tienda' | 'repartidor' | 'soporte' | 'admin';
export type EstadoCuenta = 'pendiente_aprobacion' | 'activo' | 'baneado';
export type EstadoPedido =
  | 'creado'
  | 'aceptado_tienda'
  | 'listo_para_recoger'
  | 'asignado'
  | 'en_tienda'
  | 'en_camino'
  | 'en_domicilio'
  | 'entregado'
  | 'cancelado'
  | 'rechazado';

export const ESTADOS_FINALES: EstadoPedido[] = ['entregado', 'cancelado', 'rechazado'];
export const ESTADOS_CON_REPARTIDOR: EstadoPedido[] = ['asignado', 'en_tienda', 'en_camino', 'en_domicilio'];
