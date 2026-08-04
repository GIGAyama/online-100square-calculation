import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { registerServiceWorker } from './pwa'

// Service Worker の登録は React の外側で行う。
// useEffect の中に置くと、effect は描画のあとに走るため load はもう終わっており、
// リスナーが二度と呼ばれず登録されないまま気づけない（§3-6）。
//
// 新しい版が待機したら、画面側（App）に伝えて児童にも分かる言葉で促す。
// ⚠️ 押されるまで切り替えない。計算の途中で入れ替わると、
//    打ちかけの答えと計測中のタイムが消える。
registerServiceWorker((accept) => {
    window.__pwaAcceptUpdate = accept
    window.dispatchEvent(new Event('pwa-update-ready'))
})

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
)
