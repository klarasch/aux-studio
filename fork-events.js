/* AUX: events without a date yet (fork-owned; see FORK.md).
   A template marks the place a date goes when the event has none: <span data-aux-nodate data-if-not="event.date">.
   The engine keeps the empty element; this fills it with the brand's string ("Termín brzy") before the board is measured,
   so the chip and the big date read as intended instead of dropping out. */
(function () {
  const text = () => window.STUDIO_FORK?.brand?.strings?.noDate || 'Termín brzy';
  Studio.boards.onSettle(node => {
    for (const el of node.querySelectorAll('[data-aux-nodate]')) if (el.textContent !== text()) el.textContent = text();
  }, { when: 'before' });
})();
