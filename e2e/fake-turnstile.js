// Served by Playwright in place of https://challenges.cloudflare.com/turnstile/v0/api.js: renders a box and hands the
// page a token at once. Same names Turnstile.tsx calls: render, reset, remove. The token reaches the real worker, which
// checks it against the fake siteverify (fake-siteverify.mjs), so a token this file never issued is still refused.
;(() => {
  let n = 0
  const widgets = new Map()
  const issue = (id) => {
    const w = widgets.get(id)
    if (w) setTimeout(() => w.callback(`e2e-turnstile-token-${id}-${Date.now()}`), 30)
  }
  window.turnstile = {
    render(el, options) {
      const id = `widget-${++n}`
      el.textContent = 'Safety check passed (e2e)'
      widgets.set(id, options)
      issue(id)
      return id
    },
    reset(id) {
      issue(id)
    },
    remove(id) {
      widgets.delete(id)
    },
  }
})()
