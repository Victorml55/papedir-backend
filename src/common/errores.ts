import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ValidationError } from 'class-validator';

/** Error con el formato del contrato: { statusCode, error, message, detalles? } */
export class AppError extends HttpException {
  constructor(
    status: number,
    public readonly codigo: string,
    message: string,
    public readonly detalles?: { campo: string; mensaje: string }[],
  ) {
    super(message, status);
  }
}

export const noEncontrado = (msg = 'Recurso no encontrado') => new AppError(404, 'NO_ENCONTRADO', msg);
export const sinPermiso = (msg = 'No tienes permiso para esta acción', codigo = 'SIN_PERMISO') =>
  new AppError(403, codigo, msg);
export const conflicto = (codigo: string, msg: string) => new AppError(409, codigo, msg);
export const invalido = (msg: string, campo?: string) =>
  new AppError(400, 'VALIDACION', msg, campo ? [{ campo, mensaje: msg }] : undefined);

/**
 * Traduce un mensaje por defecto de class-validator (en inglés) a español.
 * Los mensajes propios (ya en español) se dejan igual.
 */
export function traducirRestriccion(clave: string, mensaje: string, campo: string): string {
  const n = mensaje.match(/(-?\d+(?:\.\d+)?)/)?.[1];
  const textos: Record<string, string> = {
    isNotEmpty: 'es obligatorio',
    isDefined: 'es obligatorio',
    isString: 'debe ser texto',
    isInt: 'debe ser un número entero',
    isNumber: 'debe ser un número',
    isBoolean: 'debe ser verdadero o falso',
    isArray: 'debe ser una lista',
    isEmail: 'no es un correo válido',
    isUUID: 'no es un identificador válido',
    isUrl: 'no es una URL válida',
    isLatitude: 'no es una latitud válida',
    isLongitude: 'no es una longitud válida',
    isIn: 'no es una opción válida',
    isEnum: 'no es una opción válida',
    isDateString: 'no es una fecha válida',
    isISO8601: 'no es una fecha válida',
    matches: 'no tiene el formato correcto',
    equals: 'no tiene el valor esperado',
    whitelistValidation: 'no se permite',
    nestedValidation: 'tiene un formato incorrecto',
    maxLength: `debe tener como máximo ${n} caracteres`,
    minLength: `debe tener al menos ${n} caracteres`,
    min: `debe ser al menos ${n}`,
    max: `debe ser como máximo ${n}`,
    arrayMinSize: `debe tener al menos ${n} elemento${n === '1' ? '' : 's'}`,
    arrayMaxSize: `debe tener como máximo ${n} elementos`,
    arrayNotEmpty: 'no puede estar vacía',
  };
  // Mensaje propio: no empieza con el nombre del campo seguido de la frase en inglés.
  const enIngles = /\b(must|should|has failed|is not allowed|each value)\b/.test(mensaje);
  if (!enIngles) return mensaje;
  return `${campo} ${textos[clave] ?? 'no es válido'}`;
}

/** Convierte los errores de class-validator al formato del contrato. */
export function errorDeValidacion(errores: ValidationError[]) {
  const detalles: { campo: string; mensaje: string }[] = [];
  const recorrer = (lista: ValidationError[], prefijo = '') => {
    for (const e of lista) {
      const campo = prefijo ? `${prefijo}.${e.property}` : e.property;
      for (const [clave, mensaje] of Object.entries(e.constraints ?? {})) {
        detalles.push({ campo, mensaje: traducirRestriccion(clave, mensaje, e.property) });
      }
      if (e.children?.length) recorrer(e.children, campo);
    }
  };
  recorrer(errores);
  // El primer detalle va también en message para que cualquier cliente que solo muestre
  // message diga qué corregir (antes solo decía "Datos inválidos").
  const primero = detalles[0]?.mensaje;
  return new AppError(400, 'VALIDACION', primero ? `Datos inválidos: ${primero}` : 'Datos inválidos', detalles);
}

const CODIGOS: Record<number, string> = {
  400: 'VALIDACION',
  401: 'NO_AUTENTICADO',
  403: 'SIN_PERMISO',
  404: 'NO_ENCONTRADO',
  429: 'DEMASIADAS_PETICIONES',
};

@Catch()
export class FiltroErrores implements ExceptionFilter {
  private readonly log = new Logger('Error');

  catch(ex: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (ex instanceof AppError) {
      return res.status(ex.getStatus()).json({
        statusCode: ex.getStatus(),
        error: ex.codigo,
        message: ex.message,
        ...(ex.detalles ? { detalles: ex.detalles } : {}),
      });
    }
    if (ex instanceof HttpException) {
      // 413 = archivo demasiado grande; el contrato lo reporta como 400.
      const status = ex.getStatus() === 413 ? 400 : ex.getStatus();
      const cuerpo: any = ex.getResponse();
      const message = ex.getStatus() === 413
        ? 'El archivo supera el máximo de 5 MB'
        : typeof cuerpo === 'string' ? cuerpo : [].concat(cuerpo?.message ?? ex.message).join('; ');
      return res.status(status).json({ statusCode: status, error: CODIGOS[status] ?? 'ERROR', message });
    }
    this.log.error(ex?.stack ?? ex);
    return res.status(500).json({ statusCode: 500, error: 'ERROR_INTERNO', message: 'Error interno del servidor' });
  }
}
