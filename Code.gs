/**
 * PLATINA · Recordatorios de Google Tasks → Firebase
 *
 * Se ejecuta solo, cada noche (11 pm) y cada madrugada (5 am), con TU cuenta de Google.
 * Lee las tareas pendientes de tu lista de Tasks y las deja en Firebase para que la app
 * las muestre y las lea en voz alta en el primer viaje del día.
 *
 * Instalación: ver LEEME_RECORDATORIOS.md
 */
const CONFIG = {
  // Debe ser IDÉNTICA a REMINDERS_URL en js/app.js
  FIREBASE_URL: 'https://platina-dashboard-f92a6-default-rtdb.firebaseio.com/platina_reminders_BUTx3xqiFLs.json',
  LIST_NAME: 'Coche',        // nombre de tu lista en Google Tasks. Déjalo '' para leer TODAS las listas
  INCLUDE_NO_DATE: true,     // true = incluir también tareas sin fecha
  MAX_ITEMS: 20,
  TIMEZONE: 'America/Mexico_City'
};

function sincronizarRecordatorios() {
  const tz = CONFIG.TIMEZONE, now = new Date();
  // De noche se preparan las tareas de MAÑANA; de madrugada, las de HOY.
  const hour = Number(Utilities.formatDate(now, tz, 'H'));
  const target = new Date(now.getTime() + (hour >= 12 ? 24 * 3600 * 1000 : 0));
  const targetDay = Utilities.formatDate(target, tz, 'yyyy-MM-dd');

  const lists = Tasks.Tasklists.list({ maxResults: 100 }).items || [];
  const wanted = CONFIG.LIST_NAME ? lists.filter(l => l.title === CONFIG.LIST_NAME) : lists;
  if (CONFIG.LIST_NAME && !wanted.length) {
    throw new Error('No existe la lista "' + CONFIG.LIST_NAME + '" en Google Tasks. Créala o cambia CONFIG.LIST_NAME.');
  }

  const items = [];
  wanted.forEach(list => {
    let pageToken;
    do {
      const res = Tasks.Tasks.list(list.id, { showCompleted: false, showHidden: false, maxResults: 100, pageToken: pageToken });
      (res.items || []).forEach(t => {
        const title = (t.title || '').trim();
        if (!title) return;
        const due = t.due ? t.due.substring(0, 10) : null;     // Tasks guarda solo la fecha
        const include = due ? due <= targetDay : CONFIG.INCLUDE_NO_DATE;
        if (include) items.push({ id: t.id, title: title, notes: (t.notes || '').trim().substring(0, 200), due: due, list: list.title });
      });
      pageToken = res.nextPageToken;
    } while (pageToken);
  });

  items.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  const payload = { updated: now.getTime(), forDate: targetDay, items: items.slice(0, CONFIG.MAX_ITEMS) };
  UrlFetchApp.fetch(CONFIG.FIREBASE_URL, { method: 'put', contentType: 'application/json', payload: JSON.stringify(payload) });
  Logger.log('Enviados ' + payload.items.length + ' recordatorio(s) para ' + targetDay);
}

/** Ejecuta esta función UNA vez: crea los dos disparadores automáticos. */
function instalar() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'sincronizarRecordatorios') ScriptApp.deleteTrigger(t); });
  [23, 5].forEach(h => ScriptApp.newTrigger('sincronizarRecordatorios').timeBased().atHour(h).everyDays(1).inTimezone(CONFIG.TIMEZONE).create());
  sincronizarRecordatorios();   // primera descarga inmediata
}
