import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { REGLAS } from '../config/reglas';
import { Configuracion } from '../database/entities';

export type Comisiones = { tiendaPct: number; envioPct: number };
export type Recargos = {
  nocturno: { activo: boolean; desde: string; hasta: string; monto: number };
  lluvia: { activo: boolean; monto: number };
  demanda: { activo: boolean; pedidosEsperando: number; monto: number };
};
export type Cartera = { limiteDeudaTienda: number; limiteDeudaRepartidor: number; limiteDeudaCliente: number; cargoCancelacion: number };
type Valores = { comisiones: Comisiones; recargos: Recargos; cartera: Cartera };

const DEFAULTS: Valores = {
  comisiones: { ...REGLAS.comisiones },
  recargos: JSON.parse(JSON.stringify(REGLAS.recargos)),
  cartera: { ...REGLAS.cartera },
};

/**
 * Reglas que admin cambia sin redesplegar (tabla configuracion). Si una clave no está guardada
 * se usan los valores de src/config/reglas.ts. Se cachean 30 s para no consultar la base en cada cotización.
 */
@Injectable()
export class ConfiguracionService {
  private cache: { valores: Valores; hasta: number } | null = null;

  constructor(@InjectRepository(Configuracion) private readonly repo: Repository<Configuracion>) {}

  async todo(): Promise<Valores> {
    if (this.cache && this.cache.hasta > Date.now()) return this.cache.valores;
    const filas = await this.repo.find();
    const valores = structuredClone(DEFAULTS);
    for (const f of filas) if (f.clave in valores) Object.assign(valores[f.clave], f.valor);
    this.cache = { valores, hasta: Date.now() + 30000 };
    return valores;
  }

  async get<K extends keyof Valores>(clave: K): Promise<Valores[K]> {
    return (await this.todo())[clave];
  }

  async guardar<K extends keyof Valores>(clave: K, valor: Valores[K], actorId: string) {
    await this.repo.save({ clave, valor, actualizadoPor: actorId });
    this.cache = null;
    return this.get(clave);
  }
}
