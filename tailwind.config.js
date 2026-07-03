/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: {
          base: "#15171b",
          raised: "#1c1f25",
          line: "#303540",
          soft: "#242832"
        },
        accent: {
          cyan: "#4cc9f0",
          green: "#7bd88f",
          yellow: "#f2c94c",
          red: "#ff6b6b"
        }
      },
      fontFamily: {
        ui: [
          "Inter",
          "Segoe UI",
          "Microsoft YaHei UI",
          "Microsoft YaHei",
          "sans-serif"
        ]
      }
    }
  },
  plugins: []
};
