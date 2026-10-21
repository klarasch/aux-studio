/* AUX Studio: the fork manifest. The one file studio/index.html reads (see FORK.md). */
window.STUDIO_FORK = {
  name: 'AUX Studio',
  brand: {
    id: 'asociace-ux',
    name: 'Asociace UX',
    url: 'asociaceux.cz',
    series: ['UXMonday', 'UX Camp', 'UX Fest', 'Asociace UX'],
    css: '../brand/asociace-ux.css',
    grounds: { mint: { label: 'Mint' }, lime: { label: 'Lime' } },
    stockGrounds: ['bg'], groundLabels: { bg: 'Dark' },   // the stock Surface, Accent, Inverse and Art grounds have no tokens for the AUX graphics
    strings: {
      days: ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'],
      speaksMany: 'Mluví na', speaksOne: 'Přednáší na',
      saveTheDate: 'Save the date', agenda: 'Program', swipe: 'Listuj →',
      thanks: s => `Díky za ${s}!`, speakers: 'Speakeři', join: 'Přijď',
    },
  },
  css: ['../custom.css'],
  js: ['../custom.js'],
  shared: ['fork/shared/event.json'],
  templates: ['fork/templates/post.html',   // the generic post first, then the templates that read the shared event
              'fork/templates/number.html', 'fork/templates/quote.html', 'fork/templates/list.html', 'fork/templates/photo.html',
              'fork/templates/event.html', 'fork/templates/save-the-date.html', 'fork/templates/spotlight.html', 'fork/templates/event-carousel.html', 'fork/templates/agenda.html', 'fork/templates/recap.html'],
  stock: false,                // every template is the fork's own
  example: 'fork/examples/uxmonday.js',
};
