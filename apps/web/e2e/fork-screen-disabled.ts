// Fork: the page's CSP has frame-src 'none', so the computer screen (and the teach overlay drawn
// on it) is a placeholder and never embedded. Specs of the embedded screen are skipped with this
// reason rather than deleted, so an upstream merge still shows them. See
// docs/fork-browser-controls.md.
export const SCREEN_EMBED_DISABLED =
  "Fork: embedded screen is off under frame-src 'none' (docs/fork-browser-controls.md)";
