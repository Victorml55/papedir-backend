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

/** Convierte los errores de class-validator al formato del contrato. */
export function errorDeValidacion(errores: ValidationError[]) {
  const detalles: { campo: string; mensaje: string }[] = [];
  const recorrer = (lista: ValidationError[], prefijo = '') => {
    for (const e of lista) {
      const campo = prefijo ? `${prefijo}.${e.property}` : e.property;
      for (const mensaje of Object.values(e.constraints ?? {})) detalles.push({ campo, mensaje });
      if (e.children?.length) recorrer(e.children, campo);
    }
  };
  recorrer(errores);
  return new AppError(400, 'VALIDACION', 'Datos inválidos', detalles);
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
