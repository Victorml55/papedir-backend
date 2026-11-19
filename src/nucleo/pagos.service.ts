import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { AppError } from '../common/errores';
import { REGLAS } from '../config/reglas';

/** Lo que nos importa de un PaymentIntent de Stripe. */
export type Intento = {
  id: string;
  estado: string; // requires_payment_method, requires_capture, succeeded, canceled...
  centavos: number;
  moneda: string;
  metadata: Record<string, string>;
  clientSecret: string | null;
};

const centavos = (pesos: number) => Math.round(pesos * 100);

/**
 * Pagos con tarjeta con Stripe (modo prueba: STRIPE_SECRET_KEY = sk_test_...).
 * La app captura la tarjeta con flutter_stripe y confirma el PaymentIntent; el backend solo
 * crea el intento, verifica el monto, cobra y reembolsa. Nunca ve los datos de la tarjeta.
 */
@Injectable()
export class PagosService {
  private readonly log = new Logger('Pagos');
  private readonly stripe: Stripe | null = null;

  constructor() {
    const llave = process.env.STRIPE_SECRET_KEY;
    if (!llave) return;
    this.stripe = new Stripe(llave);
    if (!llave.startsWith('sk_test_')) this.log.warn('STRIPE_SECRET_KEY no es de prueba: se harán cobros reales');
  }

  get publicable() {
    return process.env.STRIPE_PUBLISHABLE_KEY ?? null;
  }

  private get s() {
    if (!this.stripe) throw new AppError(503, 'PAGOS_NO_CONFIGURADO', 'El pago con tarjeta no está disponible por ahora; paga en efectivo');
    return this.stripe;
  }

  private vista(pi: Stripe.PaymentIntent): Intento {
    return { id: pi.id, estado: pi.status, centavos: pi.amount, moneda: pi.currency, metadata: pi.metadata ?? {}, clientSecret: pi.client_secret };
  }

  /**
   * Crea el intento de pago. Con `retener` la tarjeta solo se autoriza (capture_method manual)
   * y se cobra cuando el pedido se crea bien; si algo falla, se libera sin cobrar.
   */
  async crearIntento(pesos: number, descripcion: string, metadata: Record<string, string>, retener: boolean): Promise<Intento> {
    const pi = await this.s.paymentIntents.create({
      amount: centavos(pesos),
      currency: REGLAS.pagos.moneda,
      description: descripcion,
      metadata,
      capture_method: retener ? 'manual' : 'automatic',
      payment_method_types: ['card'],
    });
    return this.vista(pi);
  }

  async obtener(id: string): Promise<Intento> {
    try {
      return this.vista(await this.s.paymentIntents.retrieve(id));
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(400, 'PAGO_INVALIDO', 'No encontramos ese pago; vuelve a intentarlo');
    }
  }

  async capturar(id: string) {
    try {
      return this.vista(await this.s.paymentIntents.capture(id));
    } catch (e) {
      this.log.warn(`No se pudo cobrar ${id}: ${e.message}`);
      throw new AppError(402, 'PAGO_RECHAZADO', 'El banco rechazó el cobro; intenta con otra tarjeta o paga en efectivo');
    }
  }

  /** Libera una autorización que no se cobró. Nunca lanza errores. */
  async liberar(id: string) {
    await this.s.paymentIntents.cancel(id).catch((e) => this.log.warn(`No se pudo liberar ${id}: ${e.message}`));
  }

  /** Devuelve el total de un cobro. Regresa false si Stripe lo rechazó. */
  async reembolsar(id: string): Promise<boolean> {
    try {
      await this.s.refunds.create({ payment_intent: id });
      return true;
    } catch (e) {
      this.log.error(`Reembolso fallido de ${id}: ${e.message}`);
      return false;
    }
  }

  /** El intento coincide con lo que se va a cobrar. */
  static coincide(i: Intento, pesos: number) {
    return i.centavos === centavos(pesos) && i.moneda === REGLAS.pagos.moneda;
  }
}
