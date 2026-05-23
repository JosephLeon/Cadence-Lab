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
        // Each level bumped one step brighter than before for stronger
        // contrast on the dark background. Was slate-200/400/500;
        // now slate-100/300/400.
        text: {
          primary: "#F1F5F9",
          secondary: "#CBD5E1",
          muted: "#94A3B8",
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
