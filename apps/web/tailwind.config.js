/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        agua: { 50: '#ecfeff', 100: '#cffafe', 500: '#0891b2', 600: '#0e7490', 700: '#155e75' },
      },
    },
  },
  plugins: [],
};
