// Static palette/cascade checks only: no browser, DOM, account or device access.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postcss from 'postcss';

const base = postcss.parse(await readFile(new URL('../src/styles/workspace.css', import.meta.url), 'utf8'));
const variants = postcss.parse(await readFile(new URL('../src/styles/workspace-themes.css', import.meta.url), 'utf8'));
function declarations(tree, selector) {
  const result = {};
  tree.walkRules(rule => {
    if (rule.selector === selector) rule.walkDecls(decl => { result[decl.prop] = decl.value; });
  });
  return result;
}
function resolve(tokens, name, ancestors = []) {
  assert.ok(!ancestors.includes(name), `cyclic token ${name}`);
  assert.ok(tokens[name], `missing token ${name}`);
  return tokens[name].replace(/var\((--[\w-]+)\)/g, (_, next) => resolve(tokens, next, [...ancestors, name]));
}
function luminance(color) {
  assert.match(color, /^#[a-f\d]{6}$/i);
  const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return rgb.reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
}
const defaults = declarations(base, ':root[data-design="workspace"]');
const canvases = new Set();
for (const theme of ['darker', 'dark', 'midnight', 'light', 'cotton-candy']) {
  const tokens = { ...defaults, ...declarations(variants, `:root[data-design="workspace"][data-theme="${theme}"]`) };
  canvases.add(resolve(tokens, '--ui-canvas'));
  for (const [foreground, background] of [
    ...['canvas', 'sidebar', 'panel', 'field', 'hover'].flatMap(surface => [['text', surface], ['muted', surface]]),
    ['subtle', 'panel'], ['selected-text', 'selected'], ['primary-text', 'primary'],
    ['primary-text', 'primary-hover'], ['critical', 'critical-bg'], ['critical-text', 'critical-button'],
    ['accent', 'panel'], ['warning', 'panel'],
  ]) {
    const [low, high] = [foreground, background].map(name => luminance(resolve(tokens, `--ui-${name}`))).sort((a, b) => a - b);
    const contrast = (high + .05) / (low + .05);
    assert.ok(contrast >= 4.5, `${theme}: ${foreground}/${background} ${contrast.toFixed(2)}:1`);
  }
  // Existing component aliases must follow the chosen palette, not the default dark literals.
  assert.equal(resolve(tokens, '--text-default'), resolve(tokens, '--ui-text'));
  assert.equal(resolve(tokens, '--background-surface-high'), resolve(tokens, '--ui-panel'));
  assert.equal(resolve(tokens, '--control-primary-background-hover'), resolve(tokens, '--ui-primary-hover'));
}
assert.equal(canvases.size, 5, 'every saved theme must visibly change the canvas');
console.log('Workspace palettes: five preferences, token aliases and specified text contrast pairs passed (no rendered-layout audit)');
