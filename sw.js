/**
 * Service worker застосунку «Облік миючих засобів».
 *
 * Навмисно ВИБІРКОВИЙ. Файл лежить у корені репозиторію, тож його область дії
 * охоплює всі сторінки QC. Але перехоплює він лише свій власний перелік адрес —
 * решта сторінок (чек-лист, мийки, варка соусу, вхідний контроль) працюють так,
 * ніби воркера немає взагалі. Це свідоме обмеження: кешувати сторінки, які ми
 * не перевіряли, означало б ризикувати чужими даними заради чужої швидкості.
 *
 * Стратегії:
 *   HTML     — спершу мережа, кеш як запасний варіант. Інакше на планшеті
 *              назавжди лишилася б стара версія застосунку.
 *   Іконки,
 *   маніфест — спершу кеш: вони не змінюються.
 *   Apps Script — не чіпаємо взагалі (інший домен, і відповідь має бути свіжою).
 */
const CACHE = 'qc-detergents-v1';

const SHELL = [
  './Detergents_and_disinfectants.html',
  './manifest-detergents.json',
  './icon-192.png',
  './icon-512.png'
];

// Що саме воркер обслуговує. Усе інше проходить повз нього.
const OWNED = SHELL.map(path => new URL(path, self.registration.scope).href);
const PAGE = new URL('./Detergents_and_disinfectants.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Один недоступний файл не має валити всю установку
      .then(cache => Promise.allSettled(SHELL.map(path => cache.add(path))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = request.url.split('#')[0];
  const isOwned = OWNED.indexOf(url) !== -1;
  // Перехід на сторінку застосунку: адреса може мати ?query, тому порівнюємо шлях
  const isPage = request.mode === 'navigate' && url.split('?')[0] === PAGE;

  if (!isOwned && !isPage) return;   // чужа сторінка — воркер не втручається

  if (isPage || url === PAGE) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(PAGE, copy));
          return response;
        })
        .catch(() => caches.match(PAGE).then(hit => hit || Response.error()))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(hit => hit || fetch(request).then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(request, copy));
      return response;
    }))
  );
});
