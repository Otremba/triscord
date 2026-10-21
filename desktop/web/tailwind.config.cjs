/** @type {import('tailwindcss').Config} */
module.exports = {
  content: { relative: true, files: ['./src/**/*.{tsx,ts,html}'] },
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        space: {
          950: '#090a0f',
          900: '#0e111a',
          850: '#121622',
          800: '#141824',
          700: '#1a2030',
          600: '#222b40',
          500: '#323d57',
        },
        neon: {
          violet: '#7928ca',
          cyan: '#00dfd8',
          emerald: '#00f5a0',
          blue: '#0070f3',
          pink: '#ff0080',
        },
      },
      backgroundImage: {
        'gradient-aurora': 'linear-gradient(135deg, #7928ca 0%, #00dfd8 50%, #00f5a0 100%)',
        'gradient-aurora-h': 'linear-gradient(90deg, #7928ca 0%, #00dfd8 50%, #00f5a0 100%)',
        'gradient-glass': 'linear-gradient(180deg, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0.02) 100%)',
      },
      boxShadow: {
        'glow-cyan': '0 0 25px -4px rgba(0, 223, 216, 0.45)',
        'glow-violet': '0 0 25px -4px rgba(121, 40, 202, 0.45)',
        'glow-emerald': '0 0 20px -3px rgba(0, 245, 160, 0.4)',
        'glow-aurora': '0 0 35px -8px rgba(0, 223, 216, 0.35)',
        'glass': '0 8px 32px 0 rgba(0, 0, 0, 0.37), inset 0 1px 0 0 rgba(255, 255, 255, 0.12)',
      },
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      animation: {
        'shimmer': 'tri-shimmer-sweep 2.8s infinite',
        'beam': 'tri-beam-rotate 4s linear infinite',
        'ripple': 'tri-ripple-pulse 1.8s cubic-bezier(0, 0.2, 0.8, 1) infinite',
        'equalizer': 'tri-equalizer-bounce 1.2s ease-in-out infinite alternate',
      },
    },
  },
  plugins: [],
};
