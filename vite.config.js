import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 自前の sw.js（src/sw.js）を使う。
      // 児童が計算している最中に勝手に新しい版へ入れ替わらないこと、
      // 他アプリのキャッシュを巻き添えにしないこと、TensorFlow.js を
      // 先読みに入れないこと——を自分で保証する必要があるため
      // （GIGA Standard v5 §3-3・§6）。
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      // 登録処理は src/pwa.js が readyState を見て自分で行う（§3-6）。
      // プラグインに差し込ませると登録の位置と更新の案内を制御できない
      injectRegister: null,
      includeAssets: ['favicon.png', 'apple-touch-icon.png', 'install-hook.js', 'offline.html'],
      manifest: {
        // ⚠️ id / scope / start_url は必ずリポジトリ名の絶対パスにする。
        //    gigayama.github.io は数十個のアプリが同一オリジンを共有しており、
        //    ここが曖昧だと「開いたら違うアプリが立ち上がる」事故が起きる。
        id: './',
        name: '100マス計算 | GIGA山',
        short_name: '100マス計算',
        description: '小学生向けの無料オンライン100マス計算。たし算・引き算・かけ算をタイム計測つきで練習できます。手書き入力にも対応。',
        lang: 'ja',
        dir: 'ltr',
        start_url: './',
        scope: './',
        display: 'standalone',
        display_override: ['standalone', 'fullscreen', 'minimal-ui'],
        launch_handler: { client_mode: ['navigate-existing', 'auto'] },
        orientation: 'any',
        theme_color: '#334155',
        background_color: '#f1f5f9',
        categories: ['education', 'kids'],
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-maskable-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        // 手書き認識モデル(model.json / *.bin)も先読みしてオフラインで使えるようにする
        globPatterns: ['**/*.{js,css,html,png,json,bin,woff2}'],
        // ⚠️ TensorFlow.js（約1MB）は先読みに入れない。
        //    先読みが1MBを超えると、校内 Wi-Fi で40人が同時に開いたときに
        //    初回表示が止まる（§6・§8）。手書きを実際に使った端末だけが
        //    sw.js の CacheFirst で取り込む。
        globIgnores: ['**/node_modules/**/*', '**/assets/tfjs-*.js'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // TensorFlow.js を名前の決まった別チャンクに切り出す。
        // 名前が決まっていないと、上の globIgnores で先読みから外せない
        manualChunks(id) {
          if (id.includes('node_modules/@tensorflow/')) return 'tfjs';
        },
      },
    },
  },
  base: './',
})
