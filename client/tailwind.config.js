/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Design tokens: one ink, one paper, and a colour per decision.
        paper: "#F6F7F9",
        sheet: "#FFFFFF",
        ink: { DEFAULT: "#1B2433", soft: "#4A5568", faint: "#7A8597" },
        line: "#DDE2E9",
        brand: { DEFAULT: "#0F4C5C", dark: "#0A3742", tint: "#E3EEF0" },
        done: { DEFAULT: "#1F7A4D", tint: "#E4F2EA" },
        waiting: { DEFAULT: "#B26A00", tint: "#FDF1DC" },
        refused: { DEFAULT: "#B42318", tint: "#FBE6E4" },
        undone: { DEFAULT: "#5B4FB3", tint: "#ECEAF8" },
      },
      fontFamily: {
        sans: ['"Instrument Sans"', "system-ui", "sans-serif"],
        serif: ['"Source Serif 4"', "Georgia", "serif"],
      },
      fontSize: {
        // Modular scale (1.2) around a 15px body, for readable data screens.
        xs: ["12px", "16px"],
        sm: ["13.5px", "20px"],
        base: ["15px", "24px"],
        lg: ["18px", "27px"],
        xl: ["21.5px", "30px"],
        "2xl": ["26px", "34px"],
        "3xl": ["31px", "38px"],
      },
    },
  },
  plugins: [],
};
