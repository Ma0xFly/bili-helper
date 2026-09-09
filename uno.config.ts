import { defineConfig, presetUno } from 'unocss'

// 注入 UI 的样式装配起点：核心语义色取自 DESIGN.md（primary/accent-pink/text-primary；
// bg 取 surface-page 占位底）。暗色以 -dark 后缀成对登记，供 Shadow DOM 内跟随 B 站夜间模式切换。
export default defineConfig({
  presets: [presetUno()],
  theme: {
    colors: {
      primary: {
        DEFAULT: '#7C5CFC',
        dark: '#9C85FF',
      },
      accent: {
        DEFAULT: '#FF8FB1',
        dark: '#FFA0BD',
      },
      bg: {
        DEFAULT: '#F7F5FB',
        dark: '#141120',
      },
      text: {
        DEFAULT: '#2E2A3B',
        dark: '#ECE8F5',
      },
    },
  },
})