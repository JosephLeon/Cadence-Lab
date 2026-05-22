/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0B1220",
          panel: "#111827",
          elevated: "#1F2937",
        },
        border: {
          DEFAULT: "#1F2937",
          subtle: "#1E293B",
        },
        accent: {
          DEFAULT: "#3B82F6",
          hover: "#2563EB",
        },
        text: {
          primary: "#E2E8F0",
          secondary: "#94A3B8",
          muted: "#64748B",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
