import { Injectable, Logger } from '@nestjs/common';

export type Correo = { para: string; asunto: string; texto: string; html?: string };

/**
 * Envía correos con Resend (https://resend.com). Sin RESEND_API_KEY no envía nada:
 * en desarrollo escribe el correo en el log (para poder copiar el código) y lo guarda en `enviados`.
 * Nunca lanza errores: un correo fallido no debe tumbar la operación.
 */
@Injectable()
export class CorreoService {
  private readonly log = new Logger('Correo');
  /** Últimos correos "enviados" sin proveedor (solo desarrollo y pruebas). */
  readonly enviados: Correo[] = [];

  get configurado() {
    return !!process.env.RESEND_API_KEY;
  }

  async enviar(c: Correo) {
    if (!this.configurado) {
      this.enviados.push(c);
      if (this.enviados.length > 50) this.enviados.shift();
      if (process.env.NODE_ENV === 'production') this.log.warn(`RESEND_API_KEY no configurada; no se envió "${c.asunto}" a ${c.para}`);
      else if (process.env.NODE_ENV !== 'test') this.log.log(`[simulado] Para ${c.para} · ${c.asunto}\n${c.texto}`);
      return;
    }
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.CORREO_REMITENTE || 'PaPedir <onboarding@resend.dev>',
          to: [c.para],
          subject: c.asunto,
          text: c.texto,
          html: c.html ?? plantilla(c.asunto, c.texto),
        }),
      });
      if (!r.ok) this.log.warn(`Resend respondió ${r.status}: ${await r.text().catch(() => '')}`);
    } catch (e) {
      this.log.warn(`No se pudo enviar el correo: ${e.message}`);
    }
  }

  codigo(para: string, nombre: string, proposito: 'recuperar_password' | 'verificar_email', codigo: string, minutos: number) {
    const recuperar = proposito === 'recuperar_password';
    const asunto = recuperar ? `Tu código para recuperar tu contraseña: ${codigo}` : `Confirma tu correo en PaPedir: ${codigo}`;
    const texto = [
      `Hola ${nombre.split(' ')[0]}:`,
      '',
      recuperar ? 'Para crear una contraseña nueva, escribe este código en la app:' : 'Para confirmar tu correo, escribe este código en la app:',
      '',
      codigo,
      '',
      `Vence en ${minutos} minutos.`,
      recuperar ? 'Si tú no lo pediste, ignora este correo: tu contraseña no cambia.' : 'Si no creaste una cuenta en PaPedir, ignora este correo.',
    ].join('\n');
    return this.enviar({ para, asunto, texto });
  }
}

const escapar = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function plantilla(asunto: string, texto: string) {
  const parrafos = texto
    .split('\n\n')
    .map((p) =>
      /^\d{6}$/.test(p.trim())
        ? `<p style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0057C2;margin:24px 0">${p.trim()}</p>`
        : `<p style="margin:0 0 12px">${escapar(p).replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
  return `<!doctype html><html lang="es"><body style="margin:0;background:#F5F7FA;font-family:Inter,Arial,sans-serif;color:#1C2430">
<div style="max-width:480px;margin:32px auto;background:#fff;border:1px solid #E3E8EF;border-radius:12px;padding:28px">
<p style="font-size:18px;font-weight:700;color:#0A7CFF;margin:0 0 20px">PaPedir</p>${parrafos}</div>
<p style="text-align:center;font-size:12px;color:#5B6675">${escapar(asunto)}</p></body></html>`;
}
