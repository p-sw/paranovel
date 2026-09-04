import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      screens: {
        xs: '380px',
      },
      colors: {
        ink: '#20201d',
        paper: '#f7f3ea',
        surface: '#fffdf8',
        line: '#ded8cb',
        muted: '#706e67',
        plum: {
          50: '#f7f1f5',
          100: '#eee2e9',
          500: '#80566e',
          600: '#6c465d',
          700: '#543447',
        },
        sage: {
          50: '#eef3ee',
          500: '#5d7865',
          700: '#3f5948',
        },
      },
      boxShadow: {
        soft: '0 12px 36px rgba(50, 44, 37, 0.08)',
        lift: '0 18px 54px rgba(50, 44, 37, 0.14)',
      },
      fontFamily: {
        sans: ['Pretendard Variable', 'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', 'sans-serif'],
        story: ['Iropke Batang', 'KoPub Batang', 'Noto Serif KR', 'serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
