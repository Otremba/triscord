// Regions of out/reference/discord-nav-client.png (Discord 1.0.9261, theme-dark, client 1264x892, 96 DPI)
// compared with the same element of the triscord interface. `ours` anchors the crop on our element (plus
// dx/dy), because triscord omits rows Discord shows without a triscord function (Eventos, Impulsos,
// text channels), which shifts later elements. Notes record what is expected to differ.
export const REGIONS = [
  { name: 'titlebar-left', x: 0, y: 0, w: 560, h: 32, ours: '.tri-titlebar', note: 'Discord draws back/forward arrows (no triscord function)' },
  { name: 'titlebar-buttons', x: 1164, y: 0, w: 100, h: 32, ours: '.tri-titlebar', dx: 1164, note: 'minimise/maximise/close' },
  { name: 'add-server', x: 16, y: 232, w: 40, h: 40, ours: '.tri-rail__circle' },
  { name: 'server-header', x: 73, y: 33, w: 302, h: 49, ours: '.tri-server-header', note: 'Discord also draws a chevron after the name' },
  { name: 'voice-category', x: 73, y: 264, w: 302, h: 24, ours: '.tri-category__header', note: 'triscord shows only the voice category' },
  { name: 'voice-channel', x: 80, y: 290, w: 288, h: 32, ours: '.tri-channel__link' },
  { name: 'account-panel', x: 8, y: 826, w: 359, h: 58, ours: '.tri-panels', note: 'avatar image differs; Discord has mic/headphone chevrons' },
  { name: 'channel-header-left', x: 376, y: 33, w: 200, h: 49, ours: '.tri-channel-header', note: 'Discord: # text channel; triscord: voice channel' },
  { name: 'composer', x: 384, y: 826, w: 872, h: 58, ours: '.tri-composer__box', note: 'Discord has +, gift, GIF, stickers, emoji, apps (no triscord function)' },
];
