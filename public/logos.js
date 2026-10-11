// Logos: puts the real mark beside every place a maker is named.
// Most places already say which maker they are (data-provider, data-preset, data-connect="arcade"),
// and app.css draws the mark from that. A few only have the name as text; this file reads the name
// there and adds data-logo, so the same CSS rule applies. It changes no behaviour.
(function () {
  'use strict';
  const MAKERS = [
    ['openai', /\bopenai\b|\bgpt\b/i], ['anthropic', /\banthropic\b|\bclaude\b/i], ['gemini', /\bgemini\b/i],
    ['openrouter', /\bopenrouter\b/i], ['groq', /\bgroq\b/i], ['ollama', /\bollama\b/i], ['arcade', /^\s*arcade\b/i],
  ];
  const named = (text) => (MAKERS.find(([, re]) => re.test(text)) || [])[0] || null;
  const set = (el, id) => { if (id) { if (el.dataset.logo !== id) el.dataset.logo = id; } else if (el.dataset.logo) delete el.dataset.logo; };

  let failed = false; // the wordmark file did not load: leave the words alone
  function mark() {
    // The model chip in the bench bar: "OpenAI: your key".
    document.querySelectorAll('button.key[data-connect="ai"]').forEach((el) => set(el, named(el.textContent)));
    // Connections on the Models and keys page: the maker is the bold name.
    document.querySelectorAll('.conn > b').forEach((el) => set(el, named(el.textContent)));
    // "Add a model" chips that carry no data-preset.
    document.querySelectorAll('.page .chip:not([data-preset]):not([data-filter]):not([data-tab])').forEach((el) => set(el, named(el.textContent)));
    // API watch rows name what they check: "Claude models", "Arcade API".
    document.querySelectorAll('.page .run-row b').forEach((el) => set(el, named(el.textContent)));
    // The wordmark line reads "for the [Arcade] API", with Arcade's own wordmark in place of the word.
    const tag = document.querySelector('.nav .brand span');
    if (tag && !failed && !tag.querySelector('.mark-arcade') && /Arcade/.test(tag.textContent)) {
      const [before, after] = tag.textContent.split('Arcade');
      const img = new Image();
      img.className = 'mark-arcade'; img.alt = 'Arcade'; img.src = 'logos/arcade.svg';
      img.onerror = () => { failed = true; tag.textContent = `${before}Arcade${after}`; };
      tag.textContent = '';
      tag.append(before, img, after);
    }
  }

  let queued = false;
  // A timer, not an animation frame: frames stop while the tab is in the background.
  const later = () => { if (queued) return; queued = true; setTimeout(() => { queued = false; mark(); }, 60); };
  new MutationObserver(later).observe(document.body, { childList: true, subtree: true, characterData: true });
  mark();
})();
