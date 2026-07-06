import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // 主色 #0FC6C2（鲸天设计语言主色），与 V2 的圆角卡片/清爽蓝绿调保持视觉延续
        brand: {
          DEFAULT: "#0FC6C2",
          50: "#EAFBFA",
          100: "#D2F5F4",
          200: "#A6ECEA",
          300: "#6FDEDB",
          400: "#3ACFCB",
          500: "#0FC6C2",
          600: "#0AA6A3",
          700: "#0A8583",
          800: "#0C6968",
          900: "#0D5453",
          950: "#053231",
        },
      },
      boxShadow: {
        card: "0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.06)",
        "card-hover": "0 4px 12px -2px rgb(15 198 194 / 0.18)",
      },
      borderRadius: {
        xl: "0.875rem",
      },
    },
  },
  plugins: [],
};

export default config;
