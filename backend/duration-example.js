import crypto from 'node:crypto';

export function durationExample({ minutes, phone, sentAt = new Date() }) {
  if (![60, 75].includes(minutes)) throw new Error('Durée non prise en charge.');
  const start = new Date(sentAt);
  if (!Number.isFinite(start.getTime())) throw new Error('Heure invalide.');
  const end = new Date(start.getTime() + minutes * 60000);
  const time = date => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  const date = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: '2-digit' }).format(start).replaceAll('/', '.');
  const endDate = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: '2-digit' }).format(end).replaceAll('/', '.');
  const reference = Array.from({ length: 6 }, () => String(crypto.randomInt(100)).padStart(2, '0')).join("'");
  const duration = minutes === 75 ? '1h15' : '1h';
  return {
    minutes, sentAt: start.toISOString(), endsAt: end.toISOString(), reference,
    text: `EXEMPLE / NON VALIDE\n\nDurée : ${duration}\nDe ${time(start)} à ${time(end)}${date !== endDate ? ' le ' + endDate : ''}\nDate : ${date}\nTéléphone : ${phone || 'Non renseigné dans le compte'}\n\nRéférence fictive : ${reference}\nCode de démonstration : DEMO-${crypto.randomBytes(2).toString('hex').toUpperCase()}\n\nEXEMPLE / NON VALIDE — aucune valeur de transport.`
  };
}
