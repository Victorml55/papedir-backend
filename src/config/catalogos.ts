import { ValidateBy, ValidationOptions } from 'class-validator';
import { MOTIVOS, REGLAS } from './reglas';

/**
 * Catálogos que admin edita desde el panel sin redesplegar: motivos de cancelación, categorías de tienda,
 * documentos por rol y la versión de los términos. Se guardan en la tabla configuracion (clave "catalogos")
 * y aquí vive la copia vigente en memoria, para que los validadores y las vistas la lean sin consultar la base.
 */
export type Motivo = { codigo: string; texto: string; activo: boolean };
export type ListaMotivos = 'cliente' | 'tienda' | 'soporte' | 'sistema';
export type CategoriaCatalogo = { codigo: string; nombre: string; activa: boolean };
export type DocumentoCatalogo = { tipo: string; nombre: string; obligatorio: boolean };
export type Catalogos = {
  motivos: Record<ListaMotivos, Motivo[]>;
  categorias: CategoriaCatalogo[];
  documentos: { repartidor: DocumentoCatalogo[]; tienda: DocumentoCatalogo[]; exigirParaAprobar: boolean };
  legal: { versionTerminos: string };
};

const NOMBRES_DOC: Record<string, string> = {
  ine: 'INE', licencia: 'Licencia de manejo', tarjeta_circulacion: 'Tarjeta de circulación',
  comprobante_domicilio: 'Comprobante de domicilio', constancia_fiscal: 'Constancia de situación fiscal',
};
const docs = (rol: 'repartidor' | 'tienda'): DocumentoCatalogo[] =>
  REGLAS.documentos.tipos[rol].map((tipo) => ({ tipo, nombre: NOMBRES_DOC[tipo] ?? tipo, obligatorio: (REGLAS.documentos.requeridos[rol] as readonly string[]).includes(tipo) }));

export const CATALOGO_BASE: Catalogos = {
  motivos: Object.fromEntries(
    Object.entries(MOTIVOS).map(([lista, filas]) => [lista, filas.map(([codigo, texto]) => ({ codigo, texto, activo: true }))]),
  ) as Catalogos['motivos'],
  categorias: [
    { codigo: 'comida', nombre: 'Comida', activa: true },
    { codigo: 'abarrotes', nombre: 'Abarrotes', activa: true },
    { codigo: 'farmacia', nombre: 'Farmacia', activa: true },
    { codigo: 'materiales', nombre: 'Materiales', activa: true },
    { codigo: 'otros', nombre: 'Otros', activa: true },
  ],
  documentos: { repartidor: docs('repartidor'), tienda: docs('tienda'), exigirParaAprobar: REGLAS.documentos.exigirParaAprobar },
  legal: { versionTerminos: REGLAS.legal.versionTerminos },
};

/** Copia vigente (la reemplaza CatalogosService al arrancar y al guardar). */
export const CATALOGO: Catalogos = structuredClone(CATALOGO_BASE);

export function aplicarCatalogo(c: Catalogos) {
  Object.assign(CATALOGO, structuredClone(c));
}

export const versionTerminos = () => CATALOGO.legal.versionTerminos;
export const categoriasActivas = () => CATALOGO.categorias.filter((c) => c.activa).map((c) => c.codigo);
export const motivosActivos = (lista: ListaMotivos) => CATALOGO.motivos[lista].filter((m) => m.activo);
export const textoMotivo = (codigo: string) => Object.values(CATALOGO.motivos).flat().find((m) => m.codigo === codigo)?.texto ?? codigo;
export const documentosDe = (rol: string): DocumentoCatalogo[] => (rol === 'repartidor' || rol === 'tienda' ? CATALOGO.documentos[rol] : []);
export const tiposDocumento = () => [...new Set([...CATALOGO.documentos.repartidor, ...CATALOGO.documentos.tienda].map((d) => d.tipo))];
export const nombreDocumento = (tipo: string) =>
  [...CATALOGO.documentos.repartidor, ...CATALOGO.documentos.tienda].find((d) => d.tipo === tipo)?.nombre ?? NOMBRES_DOC[tipo] ?? tipo;

/** Valida contra las categorías activas del catálogo (admin puede agregar más). */
export function EsCategoria(opciones?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'esCategoria',
      validator: {
        validate: (v) => typeof v === 'string' && categoriasActivas().includes(v),
        defaultMessage: () => `categoria debe ser una de: ${categoriasActivas().join(', ')}`,
      },
    },
    opciones,
  );
}

/** Valida contra los tipos de documento del catálogo. */
export function EsTipoDocumento(opciones?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'esTipoDocumento',
      validator: {
        validate: (v) => typeof v === 'string' && tiposDocumento().includes(v),
        defaultMessage: () => `tipo debe ser uno de: ${tiposDocumento().join(', ')}`,
      },
    },
    opciones,
  );
}
