/** @type {import('tailwindcss').Config} */
module.exports = {
  content: { relative: true, files: ['./src/**/*.{tsx,ts,html}'] },
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        space: {
          950: '#1e2021',
          900: '#232526',
          850: '#232526',
          800: '#292c2d',
          700: '#2d3031',
          600: '#3b3e3f',
          500: '#494d4e',
        },
        neon: {
          violet: '#a4b8e6',
          cyan: '#a4b8e6',
          emerald: '#8fc6a9',
          blue: '#a4b8e6',
          pink: '#e7a0a8',
        },
      },
      boxShadow: { 'glow-cyan': 'none', 'glow-violet': 'none', 'glow-emerald': 'none', 'glow-aurora': 'none', glass: 'none' },
      fontFamily: {
        sans: ['Segoe UI Variable Text', 'Segoe UI', 'system-ui', 'sans-serif'],
      },

    },
  },
  plugins: [],
};
