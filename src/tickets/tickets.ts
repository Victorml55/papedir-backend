import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { In, Repository } from 'typeorm';
import { Actor, Roles } from '../common/auth';
import { pagina, PaginaDto } from '../common/dtos';
import { conflicto, noEncontrado, sinPermiso } from '../common/errores';
import { folio, UuidPipe } from '../common/util';
import { Mensaje, Ticket, Usuario } from '../database/entities';
import { PushService } from '../nucleo/push.service';
import { RealtimeService } from '../nucleo/realtime.service';
import { PedidosModule } from '../pedidos/pedidos.module';
import { PedidosService } from '../pedidos/pedidos.service';

export const ESTADOS_TICKET = ['abierto', 'en_atencion', 'resuelto', 'cerrado'];
const esSoporte = (u: Usuario) => u.rol === 'soporte' || u.rol === 'admin';

export class TicketDto {
  @IsOptional() @IsUUID() pedidoId?: string | null;
  @IsString() @IsNotEmpty() @MaxLength(120) asunto: string;
  @IsString() @IsNotEmpty() @MaxLength(1000) descripcion: string;
}
export class ListarTicketsDto extends PaginaDto {
  @IsOptional() @IsIn(ESTADOS_TICKET) estado?: string;
}
export class MensajeDto {
  @IsString() @IsNotEmpty() @MaxLength(1000) texto: string;
}

export const vistaMensaje = (m: Mensaje) => ({
  id: m.id, ticketId: m.ticketId, autorId: m.autorId, autorRol: m.autorRol, texto: m.texto, creadoEn: m.creadoEn,
});

@Injectable()
export class TicketsService {
  constructor(
    private readonly pedidos: PedidosService,
    private readonly rt: RealtimeService,
    private readonly push: PushService,
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(Mensaje) private readonly mensajes: Repository<Mensaje>,
    @InjectRepository(Usuario) private readonly usuarios: Repository<Usuario>,
  ) {}

  async vistas(lista: Ticket[]) {
    const ids = [...new Set(lista.flatMap((t) => [t.creadoPor, t.atendidoPor]).filter(Boolean))];
    const gente = ids.length ? await this.usuarios.findBy({ id: In(ids) }) : [];
    const de = (id: string) => gente.find((u) => u.id === id);
    return lista.map((t) => ({
      id: t.id,
      folio: folio('T', t.folioNum),
      asunto: t.asunto,
      descripcion: t.descripcion,
      estado: t.estado,
      pedidoId: t.pedidoId,
      creadoPor: { id: t.creadoPor, nombre: de(t.creadoPor)?.nombre, rol: de(t.creadoPor)?.rol },
      atendidoPor: t.atendidoPor ? { id: t.atendidoPor, nombre: de(t.atendidoPor)?.nombre } : null,
      creadoEn: t.creadoEn,
      actualizadoEn: t.actualizadoEn,
    }));
  }

  async vista(t: Ticket) {
    return (await this.vistas([t]))[0];
  }

  /** Soporte ve todos; los demás solo los suyos. */
  async listar(u: Usuario, q: ListarTicketsDto) {
    const where: any = {};
    if (!esSoporte(u)) where.creadoPor = u.id;
    if (q.estado) where.estado = q.estado;
    const [filas, total] = await this.tickets.findAndCount({
      where, order: { actualizadoEn: 'DESC' }, skip: (q.page - 1) * q.limit, take: q.limit,
    });
    return pagina(await this.vistas(filas), total, q);
  }

  async accesible(id: string, u: Usuario) {
    const t = await this.tickets.findOneBy({ id });
    if (!t) throw noEncontrado('Ticket no encontrado');
    if (!esSoporte(u) && t.creadoPor !== u.id) throw sinPermiso('El ticket no es tuyo');
    return t;
  }

  async crear(u: Usuario, dto: TicketDto) {
    if (dto.pedidoId) {
      await this.pedidos.accesible(dto.pedidoId, u); // debe participar en el pedido
      const abierto = await this.tickets.existsBy({ pedidoId: dto.pedidoId, creadoPor: u.id, estado: In(['abierto', 'en_atencion']) });
      if (abierto) throw conflicto('TICKET_DUPLICADO', 'Ya tienes un ticket abierto para este pedido');
    }
    const guardado = await this.tickets.save(
      this.tickets.create({ asunto: dto.asunto, descripcion: dto.descripcion, pedidoId: dto.pedidoId ?? null, creadoPor: u.id }),
    );
    const vista = await this.vista(await this.tickets.findOneByOrFail({ id: guardado.id }));
    this.rt.emitir(['soporte'], 'ticket:nuevo', vista);
    void this.push.aRoles(['soporte', 'admin'], `Ticket nuevo ${vista.folio}`, dto.asunto, { ticketId: vista.id });
    return vista;
  }

  async historial(id: string, u: Usuario) {
    const t = await this.accesible(id, u);
    return (await this.mensajes.find({ where: { ticketId: t.id }, order: { creadoEn: 'ASC' } })).map(vistaMensaje);
  }

  async enviarMensaje(id: string, u: Usuario, texto: string) {
    const t = await this.accesible(id, u);
    if (t.estado === 'cerrado') throw conflicto('TICKET_CERRADO', 'El ticket está cerrado; abre uno nuevo');
    const mensaje = vistaMensaje(await this.mensajes.save(this.mensajes.create({ ticketId: t.id, autorId: u.id, autorRol: u.rol, texto })));

    // Si el usuario responde a un ticket resuelto, se reabre.
    const reabrir = !esSoporte(u) && t.estado === 'resuelto';
    await this.tickets.update(t.id, reabrir ? { estado: 'en_atencion', resueltoEn: null } : { actualizadoEn: new Date() });
    if (reabrir) this.avisarCambio({ ...t, estado: 'en_atencion' } as Ticket);

    this.rt.emitir([`ticket:${t.id}`, `usuario:${t.creadoPor}`, 'soporte'], 'ticket:mensaje', mensaje);
    const f = folio('T', t.folioNum);
    if (esSoporte(u)) void this.push.aUsuarios([t.creadoPor], `Soporte respondió (${f})`, texto.slice(0, 120), { ticketId: t.id });
    else if (t.atendidoPor) void this.push.aUsuarios([t.atendidoPor], `Respuesta en ${f}`, texto.slice(0, 120), { ticketId: t.id });
    return mensaje;
  }

  avisarCambio(t: Ticket) {
    this.rt.emitir([`ticket:${t.id}`, `usuario:${t.creadoPor}`, 'soporte'], 'ticket:actualizado', { ticketId: t.id, estado: t.estado });
  }

  /** Soporte: tomar el ticket y/o cambiar su estado. */
  async atender(id: string, agente: Usuario, cambios: { estado?: string; asignarmelo?: boolean }) {
    const t = await this.tickets.findOneBy({ id });
    if (!t) throw noEncontrado('Ticket no encontrado');
    if (cambios.asignarmelo) {
      t.atendidoPor = agente.id;
      if (t.estado === 'abierto') t.estado = 'en_atencion';
    }
    if (cambios.estado) {
      t.estado = cambios.estado as Ticket['estado'];
      t.resueltoEn = cambios.estado === 'resuelto' ? new Date() : null;
      if (!t.atendidoPor && cambios.estado !== 'abierto') t.atendidoPor = agente.id;
    }
    const guardado = await this.tickets.save(t);
    this.avisarCambio(guardado);
    if (cambios.estado === 'resuelto') {
      void this.push.aUsuarios([t.creadoPor], `Ticket ${folio('T', t.folioNum)} resuelto`, 'Si el problema sigue, responde en el chat', { ticketId: t.id });
    }
    return this.vista(guardado);
  }
}

@Controller('tickets')
export class TicketsController {
  constructor(private readonly svc: TicketsService) {}

  @Get() listar(@Actor() u: Usuario, @Query() q: ListarTicketsDto) { return this.svc.listar(u, q); }

  @Roles('cliente', 'tienda', 'repartidor') @Post()
  crear(@Actor() u: Usuario, @Body() dto: TicketDto) { return this.svc.crear(u, dto); }

  @Get(':id')
  async detalle(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.vista(await this.svc.accesible(id, u)); }

  @Get(':id/mensajes')
  mensajes(@Actor() u: Usuario, @Param('id', UuidPipe) id: string) { return this.svc.historial(id, u); }

  @Post(':id/mensajes')
  enviar(@Actor() u: Usuario, @Param('id', UuidPipe) id: string, @Body() dto: MensajeDto) { return this.svc.enviarMensaje(id, u, dto.texto); }
}

@Module({ imports: [PedidosModule], controllers: [TicketsController], providers: [TicketsService], exports: [TicketsService] })
export class TicketsModule {}
