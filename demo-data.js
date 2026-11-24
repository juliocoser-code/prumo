// Dados fictícios — sempre relativos ao momento atual, para o app parecer "vivo" no teste.
import { tzParts, zoned } from './shared/scheduler.js';

export const CONTEXTS = {
  familia: { label: 'Família', color: '#B5477A' },
  pessoal: { label: 'Pessoal', color: '#6B6760' },
  'nc-steak': { label: 'NC Steak', color: '#9A4B2C' },
  emporio: { label: 'Empório', color: '#5E7A34' },
  distribuidora: { label: 'Distribuidora', color: '#6E52A3' },
  rede: { label: 'Rede Nossa Casa', color: '#2C6E69' },
};

export function demoItems(now = new Date(), tz = 'America/Sao_Paulo') {
  const p = tzParts(now, tz);
  const h = (dh, min = 0) => new Date(now.getTime() + dh * 3600e3 + min * 60e3).toISOString();
  const day = (dd, hh, mm = 0) => zoned(p.y, p.m, p.d + dd, hh, mm, tz).toISOString();
  const nextHalf = new Date(Math.ceil((now.getTime() + 35 * 60e3) / (30 * 60e3)) * 30 * 60e3).toISOString();
  return [
    { id: 'c1', kind: 'compromisso', title: 'Reunião com o Frigorífico Serrano', detail: 'Renegociar o preço da costela e do entrecô para dezembro.', place: 'NC Steak · escritório', context: 'nc-steak', channel: 'agenda', dueAt: nextHalf, status: 'open', importance: 'alta' },
    { id: 'p1', kind: 'responder', title: 'Tabela nova de vinhos', person: 'Marcos · Distribuidora Vale', detail: 'Julio, consegue me mandar a tabela de vinhos nova até amanhã? Tenho 3 clientes esperando.', context: 'distribuidora', channel: 'whatsapp', conversationId: 'wa-marcos', receivedAt: h(-50), status: 'open', importance: 'alta' },
    { id: 'p2', kind: 'responder', title: 'Fechamento de outubro', person: 'Escritório contábil', detail: 'Faltam as notas de entrada do Empório para fecharmos outubro. Pode enviar até sexta?', context: 'rede', channel: 'email', conversationId: 'em-contab', receivedAt: h(-27), status: 'open', importance: 'alta' },
    { id: 'p3', kind: 'prazo', title: 'Enviar escala do fim de semana para a equipe', detail: 'Sábado e domingo, incluir o garçom novo.', context: 'nc-steak', channel: 'manual', dueAt: day(0, 18), status: 'open', importance: 'normal' },
    { id: 'p4', kind: 'responder', title: 'Pedido de reposição do Empório', person: 'Grupo da loja', detail: 'Acabou o azeite e o queijo. Faço o pedido?', context: 'emporio', channel: 'whatsapp', conversationId: 'wa-emporio', receivedAt: h(-3), status: 'open', importance: 'normal' },
    { id: 'w1', kind: 'retorno', title: 'Orçamento da câmara fria', person: 'Refrigeração Missões', detail: 'Ficaram de mandar o orçamento do compressor novo.', context: 'nc-steak', channel: 'whatsapp', conversationId: 'wa-refri', waitingSince: h(-74), status: 'open', importance: 'normal', reminderAt: day(1, 9) },
    { id: 'w2', kind: 'retorno', title: 'Confirmação do buffet de sábado', person: 'Ana Paula (cliente)', detail: 'Aniversário de 15 anos, 120 pessoas. Esperando confirmar o cardápio.', context: 'rede', channel: 'email', conversationId: 'em-anapaula', waitingSince: h(-30), status: 'open', importance: 'normal' },
    { id: 'c2', kind: 'compromisso', title: 'Ligar para a unidade nova sobre o cardápio', place: 'Telefone', context: 'rede', channel: 'agenda', dueAt: day(0, 17, 30), status: 'open', importance: 'normal' },
    { id: 'f1', kind: 'nota', title: 'Reservar mesa para o aniversário da mãe', detail: 'Domingo, almoço, 8 pessoas.', context: 'familia', channel: 'manual', dueAt: day(0, 20), status: 'open', importance: 'normal' },
    { id: 'c3', kind: 'compromisso', title: 'Visita à unidade do interior', place: 'Interior', context: 'rede', channel: 'agenda', dueAt: day(1, 10), status: 'open', importance: 'normal' },
    { id: 'c4', kind: 'compromisso', title: 'Degustação do cardápio novo', place: 'NC Steak', context: 'nc-steak', channel: 'agenda', dueAt: day(2, 15), status: 'open', importance: 'normal' },
    { id: 'c5', kind: 'compromisso', title: 'Reunião com o banco — capital de giro', place: 'Agência', context: 'rede', channel: 'agenda', dueAt: day(3, 9, 30), status: 'open', importance: 'normal' },
    { id: 'd1', kind: 'responder', title: 'Pagamento dos fornecedores conferido', person: 'Financeiro', context: 'rede', channel: 'email', receivedAt: h(-6), status: 'done', completedAt: h(-1), importance: 'normal' },
    { id: 'd2', kind: 'nota', title: 'Conferir estoque de carvão', context: 'nc-steak', channel: 'manual', dueAt: h(-2), status: 'done', completedAt: h(-2), importance: 'normal' },
  ];
}

export function demoIncoming(now = new Date(), n = 1) {
  const msgs = ['Julio, e a tabela? O cliente novo quer fechar hoje.', 'Se puder me liga, é sobre o pedido grande de espumantes.', 'Manda nem que seja a dos tintos.'];
  return { id: `p1-${now.getTime()}`, kind: 'responder', title: 'Tabela nova de vinhos', person: 'Marcos · Distribuidora Vale', detail: msgs[(n - 1) % msgs.length], context: 'distribuidora', channel: 'whatsapp', conversationId: 'wa-marcos', receivedAt: now.toISOString(), status: 'open', importance: 'alta' };
}
