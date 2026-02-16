
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
      typography: {
        DEFAULT: {
          css: {
            // Override default prose colors to match claude theme
            // Default prose assumes dark code bg (#1f2937) with light code text (#e5e7eb)
            // We use light backgrounds, so all text must be dark
            '--tw-prose-body': '#2D2D2D',
            '--tw-prose-headings': '#2D2D2D',
            '--tw-prose-lead': '#6B6B6B',
            '--tw-prose-links': '#2D2D2D',
            '--tw-prose-bold': '#2D2D2D',
            '--tw-prose-counters': '#6B6B6B',
            '--tw-prose-bullets': '#6B6B6B',
            '--tw-prose-hr': '#E5E5E0',
            '--tw-prose-quotes': '#2D2D2D',
            '--tw-prose-quote-borders': '#E5E5E0',
            '--tw-prose-captions': '#6B6B6B',
            '--tw-prose-code': '#2D2D2D',
            '--tw-prose-pre-code': '#2D2D2D',
            '--tw-prose-pre-bg': '#F5F5F0',
            '--tw-prose-th-borders': '#E5E5E0',
            '--tw-prose-td-borders': '#E5E5E0',
          },
        },
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
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
