
/** @type {import('tailwindcss').Config} */
export default {
  content: [
  './index.html',
  './src/**/*.{js,ts,jsx,tsx}'
],
  theme: {
    extend: {
      colors: {
        claude: {
          bg: '#F5F5F0',
          sidebar: '#F0F0EB', // Slightly darker than bg
          accent: '#D97757', // Warm orange
          text: '#2D2D2D',
          subtext: '#6B6B6B',
          border: '#E5E5E0',
          user: '#EAEAE5', // Subtle background for user messages
        }
      },
      fontFamily: {
        serif: ['"Crimson Pro"', 'serif'],
        sans: ['Inter', 'sans-serif'],
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        }
      }
    },
  },
  plugins: [],
}
