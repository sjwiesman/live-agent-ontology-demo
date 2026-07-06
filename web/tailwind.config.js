/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // UPS brand-adjacent palette
        'ups-brown': '#351C15',
        'ups-gold': '#FFB500',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
