const LOG_TIME_ZONE = 'America/Sao_Paulo';

export function buildLogMeta(date = new Date()) {
  const timestampUtc = date.toISOString();
  // Using Intl to format with the correct timezone, returning in ISO-like format
  // We use sv-SE locale because it yields a format closer to ISO (YYYY-MM-DD HH:mm:ss)
  const timestampBr = new Intl.DateTimeFormat('sv-SE', {
    timeZone: LOG_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date).replace(' ', 'T');

  // Add back the milliseconds part since Intl.DateTimeFormat's fractionalSecondDigits: 3 is node 14+ / browser dependant
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  
  return {
    timestampUtc,
    timestampBr: `${timestampBr}.${ms}`,
    timeZone: LOG_TIME_ZONE,
  };
}
