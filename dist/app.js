/* Filtering. Everything is already in the page - this only decides what stays
   visible, so it works with the network off and needs no state beyond the DOM. */

(function () {
  'use strict';

  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var months = Array.prototype.slice.call(document.querySelectorAll('.month'));
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
  var query = document.getElementById('q');
  var loose = document.getElementById('loose');
  var noresults = document.getElementById('noresults');

  var state = { month: 'all', kinds: [], q: '', loose: true };

  /* Search runs over the whole card, distributor badges included, so typing
     "dogwoof" or a director's name both work without a separate index. */
  cards.forEach(function (card) {
    card._haystack = card.textContent.toLowerCase();
  });

  function matches(card) {
    if (!state.loose && card.dataset.loose === '1') return false;

    if (state.kinds.length) {
      var kinds = card.dataset.kinds ? card.dataset.kinds.split(' ') : [];
      var hit = state.kinds.some(function (k) { return kinds.indexOf(k) !== -1; });
      if (!hit) return false;
    }

    if (state.q && card._haystack.indexOf(state.q) === -1) return false;

    return true;
  }

  function apply() {
    var shown = 0;

    months.forEach(function (section) {
      var wanted = state.month === 'all' || section.dataset.month === state.month;
      var visibleHere = 0;

      Array.prototype.forEach.call(section.querySelectorAll('.card'), function (card) {
        var ok = wanted && matches(card);
        card.hidden = !ok;
        if (ok) visibleHere++;
      });

      /* Hide a month entirely when the filters empty it, but keep an empty month
         visible when it is the one the reader explicitly asked for - "nothing in
         November" is an answer worth showing. */
      var keep = wanted && (visibleHere > 0 || (!state.q && !state.kinds.length));
      section.hidden = !keep;

      var count = section.querySelector('.month__count');
      if (count) count.textContent = visibleHere;

      shown += visibleHere;
    });

    noresults.hidden = shown > 0;
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      state.month = tab.dataset.month;
      tabs.forEach(function (t) { t.setAttribute('aria-pressed', String(t === tab)); });
      apply();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      var kind = chip.dataset.kind;
      var i = state.kinds.indexOf(kind);
      if (i === -1) state.kinds.push(kind);
      else state.kinds.splice(i, 1);
      chip.setAttribute('aria-pressed', String(i === -1));
      apply();
    });
  });

  var debounce;
  query.addEventListener('input', function () {
    clearTimeout(debounce);
    debounce = setTimeout(function () {
      state.q = query.value.trim().toLowerCase();
      apply();
    }, 120);
  });

  loose.addEventListener('change', function () {
    state.loose = loose.checked;
    apply();
  });

  /* "/" focuses the search box, Escape clears it. */
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== query) {
      e.preventDefault();
      query.focus();
    } else if (e.key === 'Escape' && document.activeElement === query) {
      query.value = '';
      state.q = '';
      apply();
      query.blur();
    }
  });

  apply();
})();
