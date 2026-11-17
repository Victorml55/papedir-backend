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
    propinaMax: 500,
    // Pedidos programados: la hora es la de entrega deseada.
    programadoMinMinutos: 45,
    programadoMaxDias: 7,
    margenProgramadoMin: 10, // se manda a la tienda con preparación + traslado + este margen de anticipación
    maxTiendasPorGrupo: 3, // un carrito puede juntar pedidos de hasta 3 tiendas
  },
  // Valores por defecto; admin los cambia en /admin/configuracion sin redesplegar.
  comisiones: {
    tiendaPct: 10, // % sobre lo que la tienda cobra por productos
    envioPct: 10, // % sobre el costo de envío (incluye recargos)
  },
  // Tarifas dinámicas: se suman al envío y se las queda el repartidor. Apagadas hasta que admin las active.
  recargos: {
    nocturno: { activo: false, desde: '22:00', hasta: '06:00', monto: 10 },
    lluvia: { activo: false, monto: 15 },
    demanda: { activo: false, pedidosEsperando: 5, monto: 10 }, // pedidos listos con más de 5 min sin repartidor
  },
  notificaciones: { diasConservar: 60 },
  chat: { maxTexto: 500 },
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
  | 'programado'
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

/** Catálogo de motivos de cancelación y rechazo (para que las apps muestren opciones y para las métricas). */
export const MOTIVOS = {
  cliente: [
    ['cambio_de_opinion', 'Cambié de opinión'],
    ['tarda_demasiado', 'Tarda demasiado'],
    ['direccion_incorrecta', 'Me equivoqué de dirección'],
    ['pedido_incorrecto', 'Me equivoqué en el pedido'],
    ['otro', 'Otro motivo'],
  ],
  tienda: [
    ['sin_ingredientes', 'Se acabó algún producto'],
    ['muy_ocupado', 'Tenemos demasiados pedidos'],
    ['cerrando', 'Estamos por cerrar'],
    ['problema_tecnico', 'Problema en la tienda'],
    ['otro', 'Otro motivo'],
  ],
  soporte: [
    ['cliente_no_localizable', 'No se localizó al cliente'],
    ['repartidor_sin_disponibilidad', 'No hubo repartidor'],
    ['incidente_en_ruta', 'Incidente en la ruta'],
    ['fraude', 'Sospecha de fraude'],
    ['solicitud_cliente', 'El cliente lo pidió a soporte'],
    ['otro', 'Otro motivo'],
  ],
  sistema: [
    ['tienda_no_respondio', 'La tienda no respondió a tiempo'],
    ['tienda_cerrada', 'La tienda no abrió para el pedido programado'],
  ],
} as const;
export const ESTADOS_CON_REPARTIDOR: EstadoPedido[] = ['asignado', 'en_tienda', 'en_camino', 'en_domicilio'];
