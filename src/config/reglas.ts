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
  tienda: {
    zonaHoraria: 'America/Mexico_City', // horarios, reportes y ganancias se calculan en hora de Celaya
    pausaMaxMin: 240, // una pausa ("no recibo pedidos por un rato") dura máximo 4 h
    maxSucursales: 10,
    maxFotosProducto: 5,
    maxGruposOpciones: 10,
    maxOpcionesPorGrupo: 20,
  },
  reportes: { maxDias: 92 },
  documentos: {
    tipos: {
      repartidor: ['ine', 'licencia', 'tarjeta_circulacion', 'comprobante_domicilio'],
      tienda: ['ine', 'comprobante_domicilio', 'constancia_fiscal'],
    },
    // Los que soporte debe ver aprobados antes de aprobar la cuenta (si exigirParaAprobar = true).
    requeridos: { repartidor: ['ine', 'licencia'], tienda: ['ine'] },
    exigirParaAprobar: false,
    mimes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    minutosEnlace: 10, // vigencia del enlace para que soporte vea un documento
  },
  cuenta: {
    maxIntentosLogin: 5, // contraseñas equivocadas seguidas antes de bloquear
    minutosBloqueo: 15,
    minutosCodigo: 15, // vigencia de los códigos de recuperación y verificación
    intentosPorCodigo: 5,
    codigosPorHora: 3, // máximo de correos con código por usuario y propósito
  },
  legal: {
    // Al cambiar el aviso de privacidad o los términos, sube esta versión:
    // la API marcará terminosPendientes = true hasta que cada usuario acepte la nueva.
    versionTerminos: '2026-11',
  },
  upload: { maxBytes: 5 * 1024 * 1024, mimes: ['image/jpeg', 'image/png', 'image/webp'] },
} as const;

export type Rol = 'cliente' | 'tienda' | 'repartidor' | 'soporte' | 'admin';
export type EstadoCuenta = 'pendiente_aprobacion' | 'activo' | 'baneado' | 'eliminado';
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
