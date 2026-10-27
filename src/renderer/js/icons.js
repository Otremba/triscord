/**
 * Icons
 *
 * Every glyph in the UI is a Lucide icon, written in markup as a placeholder
 * <i data-lucide="mic"></i> and swapped for an inline <svg> at render time.
 * Sizing and colour come from CSS (.lucide), so an icon inherits whatever the
 * button or label around it uses.
 *
 * Markup built at runtime has to ask for the swap once it is in the DOM:
 * renderIcons(container) — passing the smallest subtree that changed.
 */
function renderIcons(root = document) {
  if (!window.lucide) return;

  try {
    window.lucide.createIcons({ root });
  } catch (err) {
    console.warn('[Icons] Could not render icons:', err);
  }
}

/**
 * Swap the icon inside a container for another one — a button whose glyph
 * follows its state, like the mic turning into a struck-through mic.
 */
function setIcon(container, name) {
  const current = container.querySelector('[data-lucide]');
  if (!current || current.getAttribute('data-lucide') === name) return;

  // Replaced rather than re-attributed, so the old icon's classes go with it
  const placeholder = document.createElement('i');
  placeholder.setAttribute('data-lucide', name);
  current.replaceWith(placeholder);
  renderIcons(container);
}

window.renderIcons = renderIcons;
window.setIcon = setIcon;

// The static markup in index.html
document.addEventListener('DOMContentLoaded', () => renderIcons());
